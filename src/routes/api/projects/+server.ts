import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { authorizeMachine, machineAuthError, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { slugify } from '$lib/utils/slugify.js';
import { createProjectProjection } from '$lib/server/project-creation.js';
import { projectCreationDependencies } from '$lib/server/project-creation-db.js';

export const POST: RequestHandler = async (event) => {
	const auth = authorizeMachine(event, 'projects:write');
	if (!auth.ok) return machineAuthError(auth);

	const body = await event.request.json().catch(() => null) as Record<string, unknown> | null;
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	if (!name) return errorResponse('Missing required field: name', 400);
	const slug = typeof body?.slug === 'string' && body.slug.trim() ? slugify(body.slug) : slugify(name);
	if (!slug) return errorResponse('Invalid project slug', 400);

	try {
		const result = await createProjectProjection({
			name,
			slug,
			description: typeof body?.description === 'string' ? body.description : null,
			color: typeof body?.color === 'string' ? body.color : null,
			image: typeof body?.image === 'string' ? body.image : null
		}, projectCreationDependencies);
		return jsonResponse({
			id: result.id,
			slug: result.slug,
			reused: result.reused,
			...(result.reused ? {} : {
				access_token: result.accessToken,
				access_token_expires_at: result.accessTokenExpiresAt
			})
		}, result.reused ? 200 : 201);
	} catch (error) {
		return errorResponse(error instanceof Error ? error.message : 'Project creation failed', 503);
	}
};

export const GET: RequestHandler = async (event) => {
	const auth = authorizeMachine(event, 'projects:read');
	if (!auth.ok) return machineAuthError(auth);
	const allProjects = await db.select().from(projects);
	return jsonResponse(allProjects.map(({ accessToken: _secret, ...project }) => project));
};
