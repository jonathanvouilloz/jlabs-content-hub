import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { getKeywordHistory, computeKeywordTrend } from '$lib/server/gsc-analytics.js';
import type { RequestHandler } from './$types';

/**
 * GET ?query=…&weeks=12 — série de position sur N semaines pour un mot-clé exact.
 * Renvoie un payload prêt pour TimeChart (labels + series, gaps reportés pour la continuité du tracé)
 * + la série brute (avec trous = position null) pour le tableau / annotations « pas de données ».
 */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const query = (event.url.searchParams.get('query') ?? '').trim();
	if (!query) return json({ error: 'Param "query" requis' }, { status: 400 });

	const weeks = Math.min(Math.max(parseInt(event.url.searchParams.get('weeks') ?? '12', 10) || 12, 2), 52);

	const points = await getKeywordHistory(project.id, query, weeks);
	const trend = computeKeywordTrend(points);

	// Carry-forward des trous pour un tracé continu (TimeChart n'accepte pas de null).
	// Le détail « pas de données » reste dans `points` (position === null).
	const firstKnown = points.find((p) => p.position !== null)?.position ?? null;
	let last = firstKnown;
	const linePoints = points.map((p) => {
		if (p.position !== null) last = p.position;
		return last ?? 0;
	});

	return json({
		query,
		weeks,
		labels: points.map((p) => p.weekStart),
		series: [{ label: query, color: '#4f46e5', points: linePoints }],
		points,
		trend,
		hasData: firstKnown !== null
	});
};
