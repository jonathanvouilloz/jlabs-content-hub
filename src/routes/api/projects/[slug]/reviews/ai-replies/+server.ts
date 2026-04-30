import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews, projectGmbLocations, projectContexts } from '$lib/server/db/schema.js';
import { eq, isNull, and } from 'drizzle-orm';
import { generateAiReplies } from '$lib/server/ai/review-replies.js';
import type { ProjectContext } from '$lib/types/project-context.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const force = url.searchParams.get('force') === '1';

	// Fetch pending reviews (not yet replied)
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

	// Fetch business context
	const ctxRow = await db.query.projectContexts.findFirst({
		where: eq(projectContexts.projectId, project.id)
	});
	let context: ProjectContext | null = null;
	if (ctxRow?.context) {
		try {
			context = JSON.parse(ctxRow.context) as ProjectContext;
		} catch {
			// ignore parse error, continue with null context
		}
	}
	if (!context) {
		return json({ error: 'Contexte business non configuré pour ce projet. Renseignez-le dans les paramètres.' }, { status: 422 });
	}

	// Check if multi-location
	const locations = await db
		.select()
		.from(projectGmbLocations)
		.where(eq(projectGmbLocations.projectId, project.id));
	const isMultiLocation = locations.length > 1;

	// Generate replies via LLM
	const reviews = toGenerate.map((r) => ({
		reviewId: r.reviewId,
		authorName: r.authorName,
		rating: r.rating,
		comment: r.comment,
		locationLabel: r.locationLabel,
		createTime: r.createTime
	}));

	let replies: { reviewId: string; reply: string }[];
	try {
		replies = await generateAiReplies(reviews, context, isMultiLocation);
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Erreur inconnue';
		return json({ error: `Génération IA échouée : ${msg}` }, { status: 500 });
	}

	// Save drafts to DB
	let generated = 0;
	for (const { reviewId, reply } of replies) {
		if (!reviewId || !reply?.trim()) continue;
		const result = await db
			.update(gmbReviews)
			.set({ draftReply: reply.trim() })
			.where(eq(gmbReviews.reviewId, reviewId));
		if (result.rowsAffected > 0) generated++;
	}

	return json({ generated, skipped });
};
