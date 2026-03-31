import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, projects, statusHistory } from '$lib/server/db/schema.js';
import { createId } from '$lib/server/utils.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { buildGitHubPath, pushFileToGitHub } from '$lib/server/github.js';
import { slugify } from '$lib/utils/slugify.js';
import { eq, and, like } from 'drizzle-orm';

export const POST: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const body = await event.request.json();
	const { project_slug, type, title, slug: bodySlug, body: content, planned_date, tags, meta } = body;

	if (!project_slug || !type || !title || !content) {
		return errorResponse('Missing required fields: project_slug, type, title, body', 400);
	}

	const validTypes = ['article', 'linkedin', 'gmb', 'newsletter', 'other'];
	if (!validTypes.includes(type)) {
		return errorResponse(`Invalid content type: ${type}`, 400);
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, project_slug)
	});
	if (!project) {
		return errorResponse('Project not found', 404);
	}

	const slug = bodySlug || slugify(title);
	const upsert = event.url.searchParams.get('upsert') === 'true';

	const existing = await db.query.contents.findFirst({
		where: and(
			eq(contents.projectId, project.id),
			eq(contents.type, type),
			eq(contents.slug, slug)
		)
	});

	if (existing && !upsert) {
		return errorResponse('Content with this slug already exists. Use ?upsert=true to overwrite.', 409);
	}

	const id = existing?.id ?? createId();
	const githubPath = buildGitHubPath(project_slug, type, slug, planned_date);

	if (existing) {
		await db.update(contents).set({
			title,
			body: content,
			plannedDate: planned_date ?? null,
			tags: tags ? JSON.stringify(tags) : null,
			meta: meta ? JSON.stringify(meta) : null,
			githubPath,
			updatedAt: new Date().toISOString()
		}).where(eq(contents.id, id));
	} else {
		await db.insert(contents).values({
			id,
			projectId: project.id,
			type,
			title,
			slug,
			body: content,
			status: 'draft',
			plannedDate: planned_date ?? null,
			tags: tags ? JSON.stringify(tags) : null,
			meta: meta ? JSON.stringify(meta) : null,
			githubSynced: false,
			githubPath
		});

		await db.insert(statusHistory).values({
			id: createId(),
			contentId: id,
			fromStatus: null,
			toStatus: 'draft',
			changedBy: 'api'
		});
	}

	// GitHub sync in background
	pushFileToGitHub(githubPath, content, `[${project_slug}] add: ${slug}`).then(async (synced) => {
		await db.update(contents).set({ githubSynced: synced }).where(eq(contents.id, id));
	});

	return jsonResponse({ id, slug, github_path: githubPath }, existing ? 200 : 201);
};

export const GET: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const projectSlug = event.url.searchParams.get('project');
	const type = event.url.searchParams.get('type');
	const status = event.url.searchParams.get('status');

	let query = db.select().from(contents);
	const conditions = [];

	if (projectSlug) {
		const project = await db.query.projects.findFirst({
			where: eq(projects.slug, projectSlug)
		});
		if (project) {
			conditions.push(eq(contents.projectId, project.id));
		}
	}
	if (type) conditions.push(eq(contents.type, type));
	if (status) conditions.push(eq(contents.status, status));

	const results = conditions.length > 0
		? await query.where(and(...conditions))
		: await query;

	return jsonResponse(results);
};
