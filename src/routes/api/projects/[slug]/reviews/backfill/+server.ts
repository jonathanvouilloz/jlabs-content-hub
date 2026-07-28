import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import {
	projects,
	gmbReviews,
	projectGmbLocations,
	projectContexts
} from '$lib/server/db/schema.js';
import { eq, and, gte, lt, isNull } from 'drizzle-orm';
import { fetchProjectReviews, refreshAccountToken } from '$lib/server/gmb.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { createId } from '$lib/server/utils.js';
import { toDbTimestamp } from '$lib/server/timestamps.js';
import { normalizeReviewKey } from '$lib/server/collectors/gmb-reviews-state.js';
import { runMentionsExtractionJob } from '$lib/server/reviews/mentions-runner.js';
import type { ProjectContext } from '$lib/types/project-context.js';
import type { RequestHandler } from './$types';

/**
 * Re-import all reviews (including already replied) for a given month from
 * Google. Stores the Google reply in remoteReplyText/remoteReplyAt (GMB-002 —
 * it used to write draftReply/repliedAt, which are LOCAL columns, making the
 * hub↔Google divergence undetectable). After
 * inserts, kicks off a background mentions extraction job for any reviews
 * of the month that still have mentioned_employees IS NULL (the backfill
 * itself does not extract — and the ai-replies pipeline filters out replied
 * reviews — so without this auto-chain the mentions would stay NULL).
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

			// GMB-002 — cette route écrivait la réponse de GOOGLE dans `draft_reply` (notre
			// proposition) et son `replyTime` dans `replied_at` (notre marqueur d'envoi). Les
			// deux colonnes locales portaient donc des faits distants, ce qui rendait la
			// divergence GMB-007 indétectable : on ne peut pas comparer le hub à Google si le
			// hub recopie Google. Désormais chaque fait va dans sa colonne.
			//
			// ⚠️ Les lignes écrites AVANT ce lot restent contaminées et ne sont PAS réparées
			// ici : deviner rétroactivement « qui a répondu à ce client » serait exactement le
			// genre de supposition que ce canon refuse. On corrige l'écrivain, pas l'histoire.
			const result = await db
				.insert(gmbReviews)
				.values({
					id: createId(),
					projectId: project.id,
					locationId: r.locationId,
					locationLabel: loc.label,
					reviewId: normalizeReviewKey(r.reviewId),
					authorName: r.authorName,
					rating: r.rating,
					comment: r.comment,
					createTime: r.createTime,
					remoteReplyText: r.reply,
					remoteReplyAt: r.replyTime ? toDbTimestamp(r.replyTime) : null,
					lastSeenAt: toDbTimestamp()
				})
				.onConflictDoNothing();

			if ((result.rowCount ?? 0) > 0) {
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

	// Auto-chain mentions extraction for the month (covers freshly inserted
	// rows + any pre-existing rows still missing mentions).
	let mentionsJobId: string | null = null;
	let mentionsSkippedReason: string | null = null;

	const periodStart = `${year}-${String(month).padStart(2, '0')}-01T00:00:00`;
	const periodEnd = month === 12
		? `${year + 1}-01-01T00:00:00`
		: `${year}-${String(month + 1).padStart(2, '0')}-01T00:00:00`;

	const pending = await db
		.select()
		.from(gmbReviews)
		.where(and(
			eq(gmbReviews.projectId, project.id),
			gte(gmbReviews.createTime, periodStart),
			lt(gmbReviews.createTime, periodEnd),
			isNull(gmbReviews.mentionedEmployees)
		));

	if (pending.length === 0) {
		mentionsSkippedReason = 'no pending reviews';
	} else {
		const ctxRow = await db.query.projectContexts.findFirst({
			where: eq(projectContexts.projectId, project.id)
		});
		let context: ProjectContext | null = null;
		if (ctxRow?.context) {
			try { context = JSON.parse(ctxRow.context) as ProjectContext; }
			catch { /* ignore */ }
		}
		const hasTeam = !!context && Array.isArray(context.teamMembers) && context.teamMembers.length > 0;

		if (!context) {
			mentionsSkippedReason = 'no project context';
		} else if (!hasTeam) {
			mentionsSkippedReason = 'project context has no teamMembers';
		} else {
			const isMultiLocation = locations.length > 1;
			const reviewInputs = pending.map((r) => ({
				reviewId: r.reviewId,
				authorName: r.authorName,
				rating: r.rating,
				comment: r.comment,
				locationLabel: r.locationLabel,
				createTime: r.createTime
			}));
			const job = await runMentionsExtractionJob({
				projectId: project.id,
				reviews: reviewInputs,
				context,
				isMultiLocation,
				force: false
			});
			mentionsJobId = job.id;
		}
	}

	return json({
		ok: true,
		inserted,
		skipped,
		total: allReviews.length,
		reviews: allReviews,
		mentionsJobId,
		mentionsScheduled: pending.length,
		mentionsSkippedReason
	});
};
