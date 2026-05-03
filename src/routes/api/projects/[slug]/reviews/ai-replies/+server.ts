import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews, projectGmbLocations, projectContexts } from '$lib/server/db/schema.js';
import { eq, isNull, and } from 'drizzle-orm';
import { generateAiReplies } from '$lib/server/ai/review-replies.js';
import { createJob, updateJob } from '$lib/server/ai/jobs.js';
import type { ProjectContext } from '$lib/types/project-context.js';
import type { RequestHandler } from './$types';

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

	const requestedReviewIds = new Set(reviews.map((r) => r.reviewId));

	async function run() {
		try {
			await updateJob(job.id, { status: 'running' });
			const { replies, batchErrors, batches } = await generateAiReplies(
				reviews,
				context!,
				isMultiLocation
			);

			const attempted = replies.length;
			const emptyReplies: string[] = [];
			const unmatchedReviewIds: string[] = [];
			let generated = 0;

			for (const { reviewId, reply } of replies) {
				if (!reviewId || !reply?.trim()) {
					emptyReplies.push(reviewId || '(missing)');
					continue;
				}
				if (!requestedReviewIds.has(reviewId)) {
					unmatchedReviewIds.push(reviewId);
					continue;
				}
				const result = await db
					.update(gmbReviews)
					.set({ draftReply: reply.trim() })
					.where(eq(gmbReviews.reviewId, reviewId));
				if (result.rowsAffected > 0) {
					generated++;
				} else {
					unmatchedReviewIds.push(reviewId);
				}
			}

			const failedBatchReviewCount = batchErrors.reduce((sum, b) => sum + b.batchSize, 0);

			await updateJob(job.id, {
				status: 'done',
				result: {
					generated,
					skipped,
					attempted,
					requested: reviews.length,
					batches,
					batchErrors,
					emptyReplies,
					unmatchedReviewIds,
					failedBatchReviewCount
				}
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Erreur inconnue';
			await updateJob(job.id, { status: 'error', error: msg });
		}
	}

	const p = run();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(event.platform as any)?.context?.waitUntil(p);

	return json({ jobId: job.id });
};
