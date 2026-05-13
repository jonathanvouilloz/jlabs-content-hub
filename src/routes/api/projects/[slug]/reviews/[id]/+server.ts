import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews } from '$lib/server/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { decrementMentionsForReviewRow } from '$lib/server/reviews/mentions.js';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const row = await db.query.gmbReviews.findFirst({
		where: and(eq(gmbReviews.id, params.id), eq(gmbReviews.projectId, project.id))
	});
	if (!row) return json({ error: 'Review not found' }, { status: 404 });

	// Decremente l'agregat employee_mentions avant de supprimer la row pour
	// eviter des compteurs orphelins.
	await decrementMentionsForReviewRow(project.id, row);

	const result = await db
		.delete(gmbReviews)
		.where(and(eq(gmbReviews.id, params.id), eq(gmbReviews.projectId, project.id)));

	if (result.rowsAffected === 0) {
		return json({ error: 'Review not found' }, { status: 404 });
	}

	return json({ ok: true });
};
