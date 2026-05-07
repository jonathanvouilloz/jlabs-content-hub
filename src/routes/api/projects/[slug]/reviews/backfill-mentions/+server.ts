import { json } from '@sveltejs/kit';
import { waitUntil } from '@vercel/functions';
import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews, projectGmbLocations, projectContexts } from '$lib/server/db/schema.js';
import { eq, and, gte, lt, isNull } from 'drizzle-orm';
import { streamAiReplies, type PerReviewError } from '$lib/server/ai/review-replies.js';
import { createJob, updateJob } from '$lib/server/ai/jobs.js';
import { persistMentionsForReview } from '$lib/server/reviews/mentions.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import type { ProjectContext } from '$lib/types/project-context.js';
import type { RequestHandler } from './$types';

interface JobProgress { current: number; total: number; errors: number }
interface JobResult {
	progress: JobProgress;
	mentionsExtracted: number;
	perReviewErrors: PerReviewError[];
	requested?: number;
}

/**
 * Backfill l'extraction des mentions employes pour les avis d'un mois donne
 * dont gmb_reviews.mentioned_employees IS NULL. Ne touche PAS draftReply ni
 * repliedAt — utile pour rattraper les avis traites avant l'integration des
 * mentions au pipeline /reviews/ai-replies.
 *
 * Body : { year: number, month: number }
 * Auth : session admin OU API key.
 */
export const POST: RequestHandler = async (event) => {
	const { params, request, locals } = event;
	const isApi = validateApiKey(event);
	const isSession = !!locals.user;
	if (!isApi && !isSession) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({ where: eq(projects.slug, params.slug) });
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	let body: { year?: number; month?: number };
	try { body = await request.json(); }
	catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }

	const year = Number(body.year);
	const month = Number(body.month);
	if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
		return json({ error: 'Invalid year/month' }, { status: 400 });
	}

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
		return json({ scheduled: 0, message: 'Aucun avis a rattraper sur la periode.' });
	}

	const ctxRow = await db.query.projectContexts.findFirst({
		where: eq(projectContexts.projectId, project.id)
	});
	let context: ProjectContext | null = null;
	if (ctxRow?.context) {
		try { context = JSON.parse(ctxRow.context) as ProjectContext; }
		catch { /* ignore */ }
	}
	if (!context) {
		return json({ error: 'Contexte business non configure pour ce projet.' }, { status: 422 });
	}

	const locations = await db
		.select()
		.from(projectGmbLocations)
		.where(eq(projectGmbLocations.projectId, project.id));
	const isMultiLocation = locations.length > 1;

	const reviews = pending.map((r) => ({
		reviewId: r.reviewId,
		authorName: r.authorName,
		rating: r.rating,
		comment: r.comment,
		locationLabel: r.locationLabel,
		createTime: r.createTime
	}));

	const job = await createJob(project.id, 'review-replies');

	const result: JobResult = {
		progress: { current: 0, total: reviews.length, errors: 0 },
		mentionsExtracted: 0,
		perReviewErrors: []
	};

	async function run() {
		try {
			await updateJob(job.id, { status: 'running', result });

			await streamAiReplies(reviews, context!, isMultiLocation, async (event) => {
				if (event.kind === 'success') {
					try {
						await persistMentionsForReview(
							project!.id,
							event.review.reviewId,
							event.mentions,
							{ force: false }
						);
						result.progress.current++;
						result.mentionsExtracted += event.mentions.length;
					} catch (err) {
						result.progress.current++;
						result.progress.errors++;
						result.perReviewErrors.push({
							reviewId: event.review.reviewId,
							authorName: event.review.authorName,
							error: err instanceof Error ? err.message : String(err)
						});
					}
				} else {
					result.progress.current++;
					result.progress.errors++;
					result.perReviewErrors.push({
						reviewId: event.review.reviewId,
						authorName: event.review.authorName,
						error: event.error
					});
				}
				await updateJob(job.id, { status: 'running', result });
			});

			result.requested = reviews.length;
			await updateJob(job.id, { status: 'done', result });
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Erreur inconnue';
			await updateJob(job.id, { status: 'error', error: msg, result });
		}
	}

	waitUntil(run());

	return json({ jobId: job.id, scheduled: reviews.length });
};
