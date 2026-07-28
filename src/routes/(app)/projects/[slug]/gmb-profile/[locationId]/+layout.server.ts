import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import {
	projects,
	projectGmbLocations,
	gmbLocationProfiles,
	gmbReviews
} from '$lib/server/db/schema.js';
import { syncLocationProfile } from '$lib/server/gmb.js';
import { and, eq } from 'drizzle-orm';
import {
	answeredReviewFilter,
	pendingReviewFilter
} from '$lib/server/reviews/pending-filter.js';

const STALE_AFTER_MS = 60 * 60 * 1000;

function normalizeLocationId(raw: string): string {
	return raw.startsWith('locations/') ? raw : `locations/${raw}`;
}

export const load: LayoutServerLoad = async ({ params }) => {
	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) throw error(404, 'Projet introuvable');

	const fullLocId = normalizeLocationId(params.locationId);

	const link = await db
		.select()
		.from(projectGmbLocations)
		.where(
			and(
				eq(projectGmbLocations.projectId, project.id),
				eq(projectGmbLocations.gmbLocationId, fullLocId)
			)
		)
		.then((r) => r[0]);
	if (!link) throw error(404, 'Location non assignée à ce projet');

	let profile = await db
		.select()
		.from(gmbLocationProfiles)
		.where(
			and(
				eq(gmbLocationProfiles.projectId, project.id),
				eq(gmbLocationProfiles.gmbLocationId, fullLocId)
			)
		)
		.then((r) => r[0]);

	const stale = profile ? Date.now() - new Date(profile.syncedAt).getTime() > STALE_AFTER_MS : true;
	let syncError: string | null = null;
	if (!profile || stale) {
		try {
			profile = await syncLocationProfile(project.id, fullLocId);
		} catch (err) {
			syncError = err instanceof Error ? err.message : 'Sync failed';
		}
	}

	// Compteurs avis par location
	const reviewsTotal = await db
		.select({ id: gmbReviews.id })
		.from(gmbReviews)
		.where(
			and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.locationId, fullLocId))
		)
		;
	const reviewsReplied = await db
		.select({ id: gmbReviews.id })
		.from(gmbReviews)
		.where(
			and(
				eq(gmbReviews.projectId, project.id),
				eq(gmbReviews.locationId, fullLocId),
				answeredReviewFilter()
			)
		)
		;
	const reviewsUnreplied = await db
		.select({ id: gmbReviews.id })
		.from(gmbReviews)
		.where(
			and(
				eq(gmbReviews.projectId, project.id),
				eq(gmbReviews.locationId, fullLocId),
				pendingReviewFilter()
			)
		)
		;

	return {
		link,
		profile,
		syncError,
		locationIdParam: params.locationId,
		reviewsStats: {
			total: reviewsTotal.length,
			replied: reviewsReplied.length,
			unreplied: reviewsUnreplied.length
		}
	};
};
