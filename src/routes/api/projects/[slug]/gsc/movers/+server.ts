import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { computePositionMovers, getSnapshot, latestCompleteWeekStart } from '$lib/server/gsc-analytics.js';
import type { RequestHandler } from './$types';

/**
 * GET ?week=…&limit=10 — plus gros mouvements de position (gains/pertes) vs N-1.
 * Auto-découverte pour la watchlist. Distinct de rising/falling (clics).
 */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const week = event.url.searchParams.get('week') ?? latestCompleteWeekStart();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) {
		return json({ error: 'Param "week" attendu YYYY-MM-DD' }, { status: 400 });
	}
	const limit = Math.min(Math.max(parseInt(event.url.searchParams.get('limit') ?? '10', 10) || 10, 1), 50);

	const snapshot = await getSnapshot(project.id, week);
	if (!snapshot) {
		return json({ week, gains: [], losses: [] });
	}

	const movers = await computePositionMovers({ projectId: project.id, weekStart: week, limit });
	return json({ week, ...movers });
};
