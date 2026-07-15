import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { seoReports, projects, contents } from '$lib/server/db/schema.js';
import { createId } from '$lib/server/utils.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { eq, and, desc } from 'drizzle-orm';

const VALID_TYPES = ['competitor', 'backlink', 'ai_visibility', 'cannibalization'];

// POST /api/seo-reports
// Body: { project_slug, report_type, article_slug?, target?, payload, score? }
// Insère une ligne datée (l'historique est conservé pour le suivi dans le temps).
export const POST: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const body = await event.request.json();
	const {
		project_slug,
		report_type,
		article_slug,
		target,
		payload,
		score
	} = body;

	if (!project_slug || !report_type || payload === undefined || payload === null) {
		return errorResponse('Missing required fields: project_slug, report_type, payload', 400);
	}
	if (!VALID_TYPES.includes(report_type)) {
		return errorResponse(`Invalid report_type: ${report_type}. Expected one of ${VALID_TYPES.join(', ')}`, 400);
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, project_slug)
	});
	if (!project) {
		return errorResponse('Project not found', 404);
	}

	// article_slug optionnel : si fourni, on lie le rapport à l'article ; sinon niveau marque/projet.
	let contentId: string | null = null;
	if (article_slug) {
		const article = await db.query.contents.findFirst({
			where: and(
				eq(contents.projectId, project.id),
				eq(contents.type, 'article'),
				eq(contents.slug, article_slug)
			)
		});
		if (!article) {
			return errorResponse(`Article not found for slug: ${article_slug}`, 404);
		}
		contentId = article.id;
	}

	const id = createId();
	await db.insert(seoReports).values({
		id,
		projectId: project.id,
		contentId,
		reportType: report_type,
		target: target ?? null,
		payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
		score: typeof score === 'number' ? score : null
	});

	return jsonResponse({ id }, 201);
};

// GET /api/seo-reports?project=&type=&article=
// Retourne les rapports filtrés, les plus récents d'abord.
export const GET: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const projectSlug = event.url.searchParams.get('project');
	const type = event.url.searchParams.get('type');
	const articleSlug = event.url.searchParams.get('article');

	const conditions = [];

	if (projectSlug) {
		const project = await db.query.projects.findFirst({
			where: eq(projects.slug, projectSlug)
		});
		if (!project) return jsonResponse([]);
		conditions.push(eq(seoReports.projectId, project.id));

		if (articleSlug) {
			const article = await db.query.contents.findFirst({
				where: and(
					eq(contents.projectId, project.id),
					eq(contents.type, 'article'),
					eq(contents.slug, articleSlug)
				)
			});
			if (!article) return jsonResponse([]);
			conditions.push(eq(seoReports.contentId, article.id));
		}
	}
	if (type) conditions.push(eq(seoReports.reportType, type));

	const results = conditions.length > 0
		? await db.select().from(seoReports).where(and(...conditions)).orderBy(desc(seoReports.createdAt))
		: await db.select().from(seoReports).orderBy(desc(seoReports.createdAt));

	return jsonResponse(results);
};
