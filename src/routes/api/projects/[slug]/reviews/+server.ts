import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews } from '$lib/server/db/schema.js';
import { eq, desc, and } from 'drizzle-orm';
import { pendingReviewFilter } from '$lib/server/reviews/pending-filter.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const reviews = await db
		.select()
		.from(gmbReviews)
		.where(and(eq(gmbReviews.projectId, project.id), pendingReviewFilter()))
		.orderBy(desc(gmbReviews.createTime));

	return json({ reviews });
};
