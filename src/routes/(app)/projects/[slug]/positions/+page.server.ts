import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { indexingCredentials } from '$lib/server/db/schema.js';
import {
	computePositionMovers,
	getWatchlistWithSeries,
	latestCompleteWeekStart
} from '$lib/server/gsc-analytics.js';
import type { PageServerLoad } from './$types.js';

const HISTORY_WEEKS = 12;

export const load: PageServerLoad = async ({ parent }) => {
	const { project } = await parent();

	const cred = await db.query.indexingCredentials.findFirst({
		where: eq(indexingCredentials.projectId, project.id)
	});
	const hasGsc = !!cred?.siteUrl;

	if (!hasGsc) {
		return { hasGsc, weekStart: latestCompleteWeekStart(), keywords: [], movers: { gains: [], losses: [] } };
	}

	const weekStart = latestCompleteWeekStart();
	const keywords = await getWatchlistWithSeries(project.id, HISTORY_WEEKS);
	const movers = await computePositionMovers({ projectId: project.id, weekStart, limit: 8 });

	// Mots-clés déjà suivis → exclus de l'auto-découverte
	const trackedSet = new Set(keywords.map((k) => k.keyword));
	movers.gains = movers.gains.filter((m) => !trackedSet.has(m.query));
	movers.losses = movers.losses.filter((m) => !trackedSet.has(m.query));

	return { hasGsc, weekStart, keywords, movers };
};
