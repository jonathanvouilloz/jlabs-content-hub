import { json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects, trackedKeywords } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { createId } from '$lib/server/utils.js';
import { getKeywordHistory, computeKeywordTrend } from '$lib/server/gsc-analytics.js';
import type { RequestHandler } from './$types';

const HISTORY_WEEKS = 12;

/** GET — watchlist du projet + position courante, tendance et série sparkline par mot-clé. */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const rows = await db
		.select()
		.from(trackedKeywords)
		.where(and(eq(trackedKeywords.projectId, project.id), eq(trackedKeywords.archived, false)));

	const keywords = await Promise.all(
		rows.map(async (kw) => {
			const series = await getKeywordHistory(project.id, kw.keyword, HISTORY_WEEKS);
			const trend = computeKeywordTrend(series, kw.targetPosition);
			const latest = [...series].reverse().find((p) => p.position !== null) ?? null;
			return {
				id: kw.id,
				keyword: kw.keyword,
				targetUrl: kw.targetUrl,
				targetPosition: kw.targetPosition,
				createdAt: kw.createdAt,
				currentPosition: trend.currentPosition,
				topPage: latest?.topPage ?? null,
				trend,
				sparkline: series.map((p) => ({ weekStart: p.weekStart, position: p.position }))
			};
		})
	);

	return json({ keywords });
};

/** POST — ajoute (ou ré-active) un mot-clé suivi. Idempotent sur (project, keyword). */
export const POST: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	let body: { keyword?: string; targetUrl?: string | null; targetPosition?: number | null };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: 'JSON invalide' }, { status: 400 });
	}

	const keyword = (body.keyword ?? '').trim();
	if (!keyword) return json({ error: 'Champ "keyword" requis' }, { status: 400 });

	const targetUrl = body.targetUrl?.trim() || null;
	const targetPosition =
		body.targetPosition == null || Number.isNaN(Number(body.targetPosition))
			? null
			: Number(body.targetPosition);

	await db
		.insert(trackedKeywords)
		.values({
			id: createId(),
			projectId: project.id,
			keyword,
			targetUrl,
			targetPosition,
			archived: false
		})
		.onConflictDoUpdate({
			target: [trackedKeywords.projectId, trackedKeywords.keyword],
			set: { targetUrl, targetPosition, archived: false }
		});

	const saved = await db.query.trackedKeywords.findFirst({
		where: and(eq(trackedKeywords.projectId, project.id), eq(trackedKeywords.keyword, keyword))
	});
	return json({ ok: true, keyword: saved }, { status: 201 });
};
