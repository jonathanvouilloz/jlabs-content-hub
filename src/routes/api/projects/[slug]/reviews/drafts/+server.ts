import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { validateApiKey } from '$lib/server/api-auth.js';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async (event) => {
	const { params, locals, request } = event;
	if (!locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const { drafts } = await request.json();
	if (!Array.isArray(drafts) || drafts.length === 0) {
		return json({ error: 'drafts array is required' }, { status: 400 });
	}

	let updated = 0;
	for (const { reviewId, draftReply } of drafts) {
		if (!reviewId || !draftReply) continue;
		const result = await db
			.update(gmbReviews)
			.set({ draftReply })
			.where(eq(gmbReviews.reviewId, reviewId));
		if (result.rowsAffected > 0) updated++;
	}

	return json({ updated });
};
