import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import {
	computeCannibalization,
	getSnapshot,
	latestCompleteWeekStart
} from '$lib/server/gsc-analytics.js';
import type { RequestHandler } from './$types';

/**
 * GET ?week=…&minImpressions=&limit=15 — requêtes cannibalisées (≥2 URLs pour une même query
 * sur la semaine). Le seuil est relatif au volume du kw par défaut ; `minImpressions` (optionnel)
 * surcharge le plancher absolu. Distinct de rising/falling (clics) et de movers (position).
 * Auth admin ou clé API.
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
	// Optionnel : surcharge le plancher absolu. Absent → seuil relatif au volume (défaut fonction).
	const minImpressionsRaw = event.url.searchParams.get('minImpressions');
	const minImpressions =
		minImpressionsRaw !== null ? Math.max(parseInt(minImpressionsRaw, 10) || 1, 1) : undefined;
	const limit = Math.min(
		Math.max(parseInt(event.url.searchParams.get('limit') ?? '15', 10) || 15, 1),
		50
	);

	const snapshot = await getSnapshot(project.id, week);
	if (!snapshot) {
		return json({ weekStart: week, entries: [] });
	}

	const entries = await computeCannibalization({
		projectId: project.id,
		weekStart: week,
		minImpressions,
		limit
	});
	return json({ weekStart: week, entries });
};
