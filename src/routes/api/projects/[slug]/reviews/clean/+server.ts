import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews } from '$lib/server/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { answeredReviewFilter } from '$lib/server/reviews/pending-filter.js';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	// GMB-002 — `answeredReviewFilter()` est le complément EXACT de « en attente », donc les
	// deux partitionnent la table sans trou ni recouvrement. Sur `replied_at` seul, cette
	// purge épargnait les avis répondus directement dans Google (jamais nettoyés) tout en
	// les laissant compter comme arriéré ailleurs : les deux écrans se contredisaient.
	const result = await db
		.delete(gmbReviews)
		.where(and(eq(gmbReviews.projectId, project.id), answeredReviewFilter()));

	return json({ ok: true, deleted: result.rowCount ?? 0 });
};
