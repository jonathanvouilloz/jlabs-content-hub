import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { eq } from 'drizzle-orm';

export const PUT: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return errorResponse('Project not found', 404);

	const body = await event.request.json();
	const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };

	if (body.name !== undefined) updates.name = body.name;
	if (body.description !== undefined) updates.description = body.description;
	if (body.color !== undefined) updates.color = body.color;
	if (body.archived !== undefined) updates.archived = body.archived;

	await db.update(projects).set(updates).where(eq(projects.id, project.id));
	return jsonResponse({ slug: event.params.slug });
};
