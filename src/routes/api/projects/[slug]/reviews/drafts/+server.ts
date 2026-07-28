import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews } from '$lib/server/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { validateApiKey } from '$lib/server/api-auth.js';
import { normalizeReviewKey } from '$lib/server/collectors/gmb-reviews-state.js';
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
		// GMB-002 — le filtre `project_id` manquait. L'unique sur `review_id` est GLOBAL : un
		// identifiant fourni dans le corps pouvait donc écrire un brouillon sur l'avis d'un
		// autre client, alors que le projet du slug venait d'être résolu deux lignes plus haut.
		const result = await db
			.update(gmbReviews)
			.set({ draftReply })
			.where(
				and(
					eq(gmbReviews.projectId, project.id),
					eq(gmbReviews.reviewId, normalizeReviewKey(String(reviewId)))
				)
			);
		if ((result.rowCount ?? 0) > 0) updated++;
	}

	return json({ updated });
};
