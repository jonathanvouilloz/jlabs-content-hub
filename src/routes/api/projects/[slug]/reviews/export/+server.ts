import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { projects, projectGmbLocations } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { fetchLocationReviews, refreshAccountToken } from '$lib/server/gmb.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import type { RequestHandler } from './$types';

/**
 * One-shot export: returns top 20 reviews (rating >= 4, with comment) per location.
 * GET /api/projects/{slug}/reviews/export
 * Auth: API key or admin session
 *
 * TO DELETE AFTER USE.
 */
export const GET: RequestHandler = async (event) => {
	const { params, locals } = event;
	if (!locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const locations = await db
		.select()
		.from(projectGmbLocations)
		.where(eq(projectGmbLocations.projectId, project.id));

	if (!locations.length) {
		return json({ error: 'No GMB locations configured for this project' }, { status: 404 });
	}

	const tokens = await refreshAccountToken();
	const result: Record<string, object[]> = {};

	for (const loc of locations) {
		const reviews = await fetchLocationReviews(loc.gmbLocationId, tokens);

		const filtered = reviews
			.filter((r) => r.rating >= 4 && r.comment && r.comment.trim().length > 0)
			.sort((a, b) => {
				// 5 stars first, then most recent
				if (b.rating !== a.rating) return b.rating - a.rating;
				return new Date(b.createTime).getTime() - new Date(a.createTime).getTime();
			})
			.slice(0, 20)
			.map((r) => ({
				reviewId: r.reviewId,
				authorName: r.authorName,
				rating: r.rating,
				comment: r.comment,
				createTime: r.createTime
			}));

		result[loc.label] = filtered;
	}

	return json({
		project: project.slug,
		locations: Object.keys(result).length,
		data: result
	});
};
