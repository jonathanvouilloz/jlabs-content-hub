import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { gmbReviews, projectGmbLocations } from '$lib/server/db/schema.js';
import { eq, desc, and } from 'drizzle-orm';
import { pendingReviewFilter } from '$lib/server/reviews/pending-filter.js';

export const load: PageServerLoad = async ({ parent }) => {
	const { project } = await parent();

	const [reviews, locations] = await Promise.all([
		db
			.select()
			.from(gmbReviews)
			.where(and(eq(gmbReviews.projectId, project.id), pendingReviewFilter()))
			.orderBy(desc(gmbReviews.createTime)),
		db
			.select()
			.from(projectGmbLocations)
			.where(eq(projectGmbLocations.projectId, project.id))
	]);

	return { reviews, locations };
};
