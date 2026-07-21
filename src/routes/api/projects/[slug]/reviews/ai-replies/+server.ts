import { json } from '@sveltejs/kit';
import { waitUntil } from '@vercel/functions';
import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews, projectGmbLocations, projectContexts } from '$lib/server/db/schema.js';
import { eq, isNull, and } from 'drizzle-orm';
import { streamAiReplies, type PerReviewError } from '$lib/server/ai/review-replies.js';
import { createJob, updateJob } from '$lib/server/ai/jobs.js';
import { persistMentionsForReview } from '$lib/server/reviews/mentions.js';
import type { ProjectContext } from '$lib/types/project-context.js';
import type { RequestHandler } from './$types';

interface JobProgress {
	current: number;
	total: number;
	errors: number;
}

interface JobResult {
	progress: JobProgress;
	skipped: number;
	perReviewErrors: PerReviewError[];
	generated?: number;
	requested?: number;
}

export const POST: RequestHandler = async (event) => {
	const { locals, params, url } = event;

	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const force = url.searchParams.get('force') === '1';

	const allPending = await db
		.select()
		.from(gmbReviews)
		.where(and(eq(gmbReviews.projectId, project.id), isNull(gmbReviews.repliedAt)));

	const toGenerate = force
		? allPending
		: allPending.filter((r) => !r.draftReply?.trim());

	const skipped = allPending.length - toGenerate.length;

	if (toGenerate.length === 0) {
		return json({ generated: 0, skipped });
	}

	const ctxRow = await db.query.projectContexts.findFirst({
		where: eq(projectContexts.projectId, project.id)
	});
	let context: ProjectContext | null = null;
	if (ctxRow?.context) {
		try {
			context = JSON.parse(ctxRow.context) as ProjectContext;
		} catch {
			// ignore parse error
		}
	}
	if (!context) {
		return json({ error: 'Contexte business non configuré pour ce projet. Renseignez-le dans les paramètres.' }, { status: 422 });
	}

	const locations = await db
		.select()
		.from(projectGmbLocations)
		.where(eq(projectGmbLocations.projectId, project.id));
	const isMultiLocation = locations.length > 1;

	const reviews = toGenerate.map((r) => ({
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
		skipped,
		perReviewErrors: []
	};

	async function run() {
		try {
			await updateJob(job.id, { status: 'running', result });

			await streamAiReplies(reviews, context!, isMultiLocation, async (event) => {
				if (event.kind === 'success') {
					const upd = await db
						.update(gmbReviews)
						.set({ draftReply: event.reply })
						.where(eq(gmbReviews.reviewId, event.review.reviewId));

					if ((upd.rowCount ?? 0) > 0) {
						result.progress.current++;
						// Persiste les mentions employés (idempotent : skip si déjà analysé sauf force)
						try {
							await persistMentionsForReview(
								project!.id,
								event.review.reviewId,
								event.mentions,
								{ force }
							);
						} catch (err) {
							// On ne bloque pas le brouillon si l'agrégat échoue, mais on logue
							console.error('[ai-replies] persist mentions failed for', event.review.reviewId, err);
						}
					} else {
						result.progress.current++;
						result.progress.errors++;
						result.perReviewErrors.push({
							reviewId: event.review.reviewId,
							authorName: event.review.authorName,
							error: 'Row introuvable lors de l\'UPDATE (avis supprimé entre-temps ?)'
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

			result.generated = result.progress.current - result.progress.errors;
			result.requested = reviews.length;
			await updateJob(job.id, { status: 'done', result });
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Erreur inconnue';
			await updateJob(job.id, { status: 'error', error: msg, result });
		}
	}

	waitUntil(run());

	return json({ jobId: job.id });
};
