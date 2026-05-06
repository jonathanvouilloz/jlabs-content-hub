import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { computeActions, getSnapshot, latestCompleteWeekStart } from '$lib/server/gsc-analytics.js';
import type { RequestHandler } from './$types';

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

	const limit = Math.min(Math.max(parseInt(event.url.searchParams.get('limit') ?? '5', 10) || 5, 1), 20);

	const snapshot = await getSnapshot(project.id, week);
	if (!snapshot) {
		return json({ snapshot: null, opportunities: [], quickWins: [] });
	}

	const actions = await computeActions({ projectId: project.id, weekStart: week, limit });
	return json({
		snapshot: { weekStart: snapshot.weekStart, status: snapshot.status, totalClicks: snapshot.totalClicks, totalImpressions: snapshot.totalImpressions },
		...actions
	});
};
