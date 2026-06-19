import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { indexingCredentials, trackedKeywords } from '$lib/server/db/schema.js';
import {
	computeKeywordTrend,
	computePositionMovers,
	getKeywordHistory,
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

	const tracked = await db
		.select()
		.from(trackedKeywords)
		.where(and(eq(trackedKeywords.projectId, project.id), eq(trackedKeywords.archived, false)));

	const keywords = await Promise.all(
		tracked.map(async (kw) => {
			const series = await getKeywordHistory(project.id, kw.keyword, HISTORY_WEEKS);
			const trend = computeKeywordTrend(series, kw.targetPosition);
			const latest = [...series].reverse().find((p) => p.position !== null) ?? null;
			return {
				id: kw.id,
				keyword: kw.keyword,
				targetUrl: kw.targetUrl,
				targetPosition: kw.targetPosition,
				currentPosition: trend.currentPosition,
				topPage: latest?.topPage ?? null,
				trend,
				series
			};
		})
	);

	const movers = await computePositionMovers({ projectId: project.id, weekStart, limit: 8 });

	// Mots-clés déjà suivis → exclus de l'auto-découverte
	const trackedSet = new Set(tracked.map((k) => k.keyword));
	movers.gains = movers.gains.filter((m) => !trackedSet.has(m.query));
	movers.losses = movers.losses.filter((m) => !trackedSet.has(m.query));

	return { hasGsc, weekStart, keywords, movers };
};
