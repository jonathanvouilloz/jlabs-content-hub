import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, projectGmbLocations } from '$lib/server/db/schema.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { eq, and } from 'drizzle-orm';

export const DELETE: RequestHandler = async (event) => {
	if (!validateApiKey(event) && !event.locals.user) {
		return errorResponse('Unauthorized', 401);
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return errorResponse('Project not found', 404);

	const deleted = await db
		.delete(projectGmbLocations)
		.where(
			and(
				eq(projectGmbLocations.id, event.params.locationId),
				eq(projectGmbLocations.projectId, project.id)
			)
		)
		.returning();

	if (deleted.length === 0) return errorResponse('Location not found', 404);

	return jsonResponse({ deleted: true });
};
