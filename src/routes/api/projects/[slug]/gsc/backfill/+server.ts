import { json } from '@sveltejs/kit';
import { waitUntil } from '@vercel/functions';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { createJob, updateJob } from '$lib/server/ai/jobs.js';
import { backfillProject } from '$lib/server/gsc-analytics.js';
import type { RequestHandler } from './$types';

const MAX_WEEKS = 52;
const DEFAULT_WEEKS = 4;

export const POST: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	let body: { weeks?: number; force?: boolean } = {};
	try {
		body = (await event.request.json()) as typeof body;
	} catch {
		// allow empty body
	}
	const weeks = Math.min(Math.max(body.weeks ?? DEFAULT_WEEKS, 1), MAX_WEEKS);
	const force = !!body.force;
	const projectId = project.id;

	// API key path → synchronous so skill CLI gets a final report
	if (!event.locals.user) {
		try {
			const result = await backfillProject({ projectId, weeks, forceRefresh: force });
			return json({ ok: true, weeks, ...result });
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Erreur inconnue';
			return json({ error: msg }, { status: 500 });
		}
	}

	// Admin path → background job
	const job = await createJob(projectId, 'gsc-backfill');
	async function run() {
		try {
			await updateJob(job.id, { status: 'running' });
			const result = await backfillProject({ projectId, weeks, forceRefresh: force });
			await updateJob(job.id, { status: 'done', result: { weeks, ...result } });
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Erreur inconnue';
			await updateJob(job.id, { status: 'error', error: msg });
		}
	}
	waitUntil(run());
	return json({ jobId: job.id });
};
