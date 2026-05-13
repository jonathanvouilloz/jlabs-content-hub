import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import {
	projects,
	gmbReviews,
	projectGmbLocations,
	projectContexts,
	employeeMentions
} from '$lib/server/db/schema.js';
import { eq, and, gte, lt, isNull } from 'drizzle-orm';
import { runMentionsExtractionJob } from '$lib/server/reviews/mentions-runner.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import type { ProjectContext } from '$lib/types/project-context.js';
import type { RequestHandler } from './$types';

/**
 * Backfill l'extraction des mentions employes pour les avis d'un mois donne.
 *
 * Body : { year: number, month: number }
 * Query : ?reset=true pour purger d'abord l'agregat + reset le JSON column
 *   sur TOUS les avis du mois (gere les agregats orphelins suite a un
 *   re-backfill / suppression manuelle d'avis).
 *
 * Comportement par defaut (sans reset) : ne touche que les avis ou
 * mentioned_employees IS NULL et incremente l'agregat existant.
 *
 * Auth : session admin OU API key.
 */
export const POST: RequestHandler = async (event) => {
	const { params, request, locals, url } = event;
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

	const reset = url.searchParams.get('reset') === 'true';

	const periodStart = `${year}-${String(month).padStart(2, '0')}-01T00:00:00`;
	const periodEnd = month === 12
		? `${year + 1}-01-01T00:00:00`
		: `${year}-${String(month + 1).padStart(2, '0')}-01T00:00:00`;

	// Reset : purger l'agregat + nuller le JSON column sur tous les avis du mois
	if (reset) {
		await db.delete(employeeMentions).where(and(
			eq(employeeMentions.projectId, project.id),
			eq(employeeMentions.year, year),
			eq(employeeMentions.month, month)
		));
		await db.update(gmbReviews)
			.set({ mentionedEmployees: null })
			.where(and(
				eq(gmbReviews.projectId, project.id),
				gte(gmbReviews.createTime, periodStart),
				lt(gmbReviews.createTime, periodEnd)
			));
	}

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
		return json({ scheduled: 0, reset, message: 'Aucun avis a rattraper sur la periode.' });
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

	const job = await runMentionsExtractionJob({
		projectId: project.id,
		reviews,
		context,
		isMultiLocation,
		force: false
	});

	return json({ jobId: job.id, scheduled: reviews.length, reset });
};
