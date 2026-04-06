import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, projectGmbLocations } from '$lib/server/db/schema.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { eq } from 'drizzle-orm';
import { createId } from '$lib/server/utils.js';

export const GET: RequestHandler = async (event) => {
	if (!validateApiKey(event) && !event.locals.user) {
		return errorResponse('Unauthorized', 401);
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return errorResponse('Project not found', 404);

	const locations = await db
		.select()
		.from(projectGmbLocations)
		.where(eq(projectGmbLocations.projectId, project.id));

	return jsonResponse(locations);
};

export const POST: RequestHandler = async (event) => {
	if (!validateApiKey(event) && !event.locals.user) {
		return errorResponse('Unauthorized', 401);
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return errorResponse('Project not found', 404);

	const body = await event.request.json();
	const { gmbLocationId, label, address } = body;

	if (!gmbLocationId || !label) {
		return errorResponse('gmbLocationId and label are required', 400);
	}

	const id = createId();
	await db
		.insert(projectGmbLocations)
		.values({ id, projectId: project.id, gmbLocationId, label, address: address ?? null })
		.onConflictDoNothing();

	return jsonResponse({ id, gmbLocationId, label, address }, 201);
};
