import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { gmbReviews } from '$lib/server/db/schema.js';
import { eq, desc } from 'drizzle-orm';

export const load: PageServerLoad = async ({ parent }) => {
	const { project } = await parent();

	const reviews = await db
		.select()
		.from(gmbReviews)
		.where(eq(gmbReviews.projectId, project.id))
		.orderBy(desc(gmbReviews.createTime));

	return { reviews };
};
