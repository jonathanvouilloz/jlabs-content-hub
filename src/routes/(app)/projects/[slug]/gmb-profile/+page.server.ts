import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import {
	projects,
	projectGmbLocations,
	gmbLocationProfiles,
	gmbInsightsDaily,
	gmbReviews
} from '$lib/server/db/schema.js';
import { and, eq, gte, lte, isNotNull, isNull } from 'drizzle-orm';

const IMPRESSION_METRICS = [
	'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
	'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
	'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
	'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'
];

export const load: PageServerLoad = async ({ params }) => {
	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) throw error(404, 'Projet introuvable');

	const locations = await db
		.select()
		.from(projectGmbLocations)
		.where(eq(projectGmbLocations.projectId, project.id));

	// Fenêtre 30 jours (jusqu'à J-3)
	const today = new Date();
	const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 3));
	const start = new Date(end);
	start.setUTCDate(start.getUTCDate() - 29);
	const startIso = start.toISOString().slice(0, 10);
	const endIso = end.toISOString().slice(0, 10);

	const enriched = await Promise.all(
		locations.map(async (loc) => {
			const profile = await db
				.select()
				.from(gmbLocationProfiles)
				.where(
					and(
						eq(gmbLocationProfiles.projectId, project.id),
						eq(gmbLocationProfiles.gmbLocationId, loc.gmbLocationId)
					)
				)
				.then((r) => r[0]);

			const insightsRows = await db
				.select()
				.from(gmbInsightsDaily)
				.where(
					and(
						eq(gmbInsightsDaily.gmbLocationId, loc.gmbLocationId),
						gte(gmbInsightsDaily.date, startIso),
						lte(gmbInsightsDaily.date, endIso)
					)
				)
				;

			const totals = { impressions: 0, websiteClicks: 0, callClicks: 0, directionRequests: 0 };
			for (const r of insightsRows) {
				if (IMPRESSION_METRICS.includes(r.metric)) totals.impressions += r.value;
				else if (r.metric === 'WEBSITE_CLICKS') totals.websiteClicks += r.value;
				else if (r.metric === 'CALL_CLICKS') totals.callClicks += r.value;
				else if (r.metric === 'BUSINESS_DIRECTION_REQUESTS') totals.directionRequests += r.value;
			}

			const reviewsTotal = await db
				.select({ id: gmbReviews.id })
				.from(gmbReviews)
				.where(
					and(
						eq(gmbReviews.projectId, project.id),
						eq(gmbReviews.locationId, loc.gmbLocationId)
					)
				)
				;
			const reviewsReplied = await db
				.select({ id: gmbReviews.id })
				.from(gmbReviews)
				.where(
					and(
						eq(gmbReviews.projectId, project.id),
						eq(gmbReviews.locationId, loc.gmbLocationId),
						isNotNull(gmbReviews.repliedAt)
					)
				)
				;
			const reviewsUnreplied = await db
				.select({ id: gmbReviews.id })
				.from(gmbReviews)
				.where(
					and(
						eq(gmbReviews.projectId, project.id),
						eq(gmbReviews.locationId, loc.gmbLocationId),
						isNull(gmbReviews.repliedAt)
					)
				)
				;

			return {
				link: loc,
				profile,
				totals,
				hasInsights: insightsRows.length > 0,
				reviews: {
					total: reviewsTotal.length,
					replied: reviewsReplied.length,
					unreplied: reviewsUnreplied.length
				}
			};
		})
	);

	return {
		locations: enriched,
		range: { start: startIso, end: endIso }
	};
};
