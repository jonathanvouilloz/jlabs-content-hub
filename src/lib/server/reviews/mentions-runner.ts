import { waitUntil } from '@vercel/functions';
import { streamAiReplies, type ReviewInput, type PerReviewError } from '$lib/server/ai/review-replies.js';
import { createJob, updateJob, type AiJob } from '$lib/server/ai/jobs.js';
import { persistMentionsForReview } from './mentions.js';
import type { ProjectContext } from '$lib/types/project-context.js';

export interface MentionsJobProgress { current: number; total: number; errors: number }
export interface MentionsJobResult {
	progress: MentionsJobProgress;
	mentionsExtracted: number;
	perReviewErrors: PerReviewError[];
	requested: number;
}

/**
 * Lance un job IA d'extraction de mentions employes pour une liste d'avis.
 * Cree une row ai_jobs, kick le streaming en background via waitUntil, et
 * retourne immediatement le jobId. Le draftReply genere par le LLM est ignore
 * (les appelants veulent uniquement les mentions — ai-replies a son propre
 * pipeline qui ecrit le draft).
 *
 * Reutilise par /reviews/backfill-mentions et /reviews/backfill (auto-chain).
 */
export async function runMentionsExtractionJob(params: {
	projectId: string;
	reviews: ReviewInput[];
	context: ProjectContext;
	isMultiLocation: boolean;
	force?: boolean;
}): Promise<AiJob> {
	const { projectId, reviews, context, isMultiLocation, force = false } = params;

	const job = await createJob(projectId, 'review-replies');

	const result: MentionsJobResult = {
		progress: { current: 0, total: reviews.length, errors: 0 },
		mentionsExtracted: 0,
		perReviewErrors: [],
		requested: reviews.length
	};

	async function run() {
		try {
			await updateJob(job.id, { status: 'running', result });

			await streamAiReplies(reviews, context, isMultiLocation, async (event) => {
				if (event.kind === 'success') {
					try {
						await persistMentionsForReview(
							projectId,
							event.review.reviewId,
							event.mentions,
							{ force }
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

			await updateJob(job.id, { status: 'done', result });
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Erreur inconnue';
			await updateJob(job.id, { status: 'error', error: msg, result });
		}
	}

	waitUntil(run());

	return job;
}
