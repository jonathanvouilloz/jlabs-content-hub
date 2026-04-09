import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { fetchProjectReviews, refreshAccountToken } from '$lib/server/gmb.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { createId } from '$lib/server/utils.js';
import type { RequestHandler } from './$types';

/**
 * Temporary endpoint: fetch ALL reviews (including replied) for a given month
 * and insert them in DB with repliedAt set for those that have replies.
 *
 * GET /api/projects/{slug}/reviews/backfill?year=2026&month=4
 */
export const GET: RequestHandler = async (event) => {
	const { params, url, locals } = event;
	if (!locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const year = parseInt(url.searchParams.get('year') || '2026');
	const month = parseInt(url.searchParams.get('month') || '4');

	const monthStart = new Date(Date.UTC(year, month - 1, 1));
	const monthEnd = new Date(Date.UTC(year, month, 1));

	// Fetch ALL reviews (no reply filter) using the raw fetch
	const { fetchLocationReviews } = await import('$lib/server/gmb.js');
	const tokens = await refreshAccountToken();

	// Get project locations
	const { projectGmbLocations } = await import('$lib/server/db/schema.js');
	const locations = await db
		.select()
		.from(projectGmbLocations)
		.where(eq(projectGmbLocations.projectId, project.id));

	let inserted = 0;
	let skipped = 0;
	const allReviews = [];

	for (const loc of locations) {
		const reviews = await fetchLocationReviews(loc.gmbLocationId, tokens);

		for (const r of reviews) {
			const createDate = new Date(r.createTime);
			// Filter to target month only
			if (createDate < monthStart || createDate >= monthEnd) continue;
			// Only reviews with a comment AND a reply
			if (!r.comment || !r.reply) continue;

			const result = await db
				.insert(gmbReviews)
				.values({
					id: createId(),
					projectId: project.id,
					locationId: r.locationId,
					locationLabel: loc.label,
					reviewId: r.reviewId,
					authorName: r.authorName,
					rating: r.rating,
					comment: r.comment,
					createTime: r.createTime,
					draftReply: r.reply,
					repliedAt: r.replyTime || new Date().toISOString()
				})
				.onConflictDoNothing();

			if (result.rowsAffected > 0) {
				inserted++;
			} else {
				skipped++;
			}

			allReviews.push({
				reviewId: r.reviewId,
				authorName: r.authorName,
				rating: r.rating,
				comment: r.comment.substring(0, 80),
				reply: r.reply?.substring(0, 80),
				location: loc.label
			});
		}
	}

	return json({ ok: true, inserted, skipped, total: allReviews.length, reviews: allReviews });
};
