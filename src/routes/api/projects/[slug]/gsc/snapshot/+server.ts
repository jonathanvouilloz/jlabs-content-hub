import { json } from '@sveltejs/kit';
import { waitUntil } from '@vercel/functions';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { createJob, updateJob } from '$lib/server/ai/jobs.js';
import {
	computeWeeklyDiff,
	latestCompleteWeekStart,
	pullWeeklySnapshot
} from '$lib/server/gsc-analytics.js';
import type { RequestHandler } from './$types';

function isValidWeekStart(s: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const d = new Date(`${s}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return false;
	return d.getUTCDay() === 1; // Must be Monday
}

export const POST: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	let body: { weekStart?: string; force?: boolean } = {};
	try {
		body = (await event.request.json()) as typeof body;
	} catch {
		// allow empty body
	}

	const weekStart = body.weekStart ?? latestCompleteWeekStart();
	if (!isValidWeekStart(weekStart)) {
		return json({ error: 'weekStart must be a Monday in YYYY-MM-DD format' }, { status: 400 });
	}

	const force = !!body.force;
	const projectId = project.id;

	// API key path → synchronous so the skill CLI can poll a single response
	if (!event.locals.user) {
		try {
			const snap = await pullWeeklySnapshot({ projectId, weekStart, forceRefresh: force });
			await computeWeeklyDiff({ projectId, weekStart });
			return json({ ok: true, weekStart, ...snap });
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Erreur inconnue';
			return json({ error: msg }, { status: 500 });
		}
	}

	// Admin path → background job
	const job = await createJob(projectId, 'gsc-snapshot');
	async function run() {
		try {
			await updateJob(job.id, { status: 'running' });
			const snap = await pullWeeklySnapshot({ projectId, weekStart, forceRefresh: force });
			await computeWeeklyDiff({ projectId, weekStart });
			await updateJob(job.id, {
				status: 'done',
				result: { weekStart, snapshotId: snap.snapshotId, rowCount: snap.rowCount, reused: snap.reused }
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Erreur inconnue';
			await updateJob(job.id, { status: 'error', error: msg });
		}
	}
	waitUntil(run());
	return json({ jobId: job.id });
};
