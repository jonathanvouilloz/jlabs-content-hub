import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

export const POST: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return errorResponse('Project not found', 404);

	const newToken = randomBytes(24).toString('hex');
	await db.update(projects).set({
		accessToken: newToken,
		updatedAt: new Date().toISOString()
	}).where(eq(projects.id, project.id));

	return jsonResponse({ access_token: newToken });
};
