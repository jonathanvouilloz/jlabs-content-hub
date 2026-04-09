import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { replyToReview, markReviewAsReplied } from '$lib/server/gmb.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const body = await request.json();
	const { reviewId, locationId, reply } = body;

	if (!reviewId || !locationId || !reply) {
		return json({ error: 'reviewId, locationId and reply are required' }, { status: 400 });
	}

	const result = await replyToReview(locationId, reviewId, reply);

	if (result.success) {
		await markReviewAsReplied(reviewId);
	}

	return json(result, { status: result.success ? 200 : 500 });
};
