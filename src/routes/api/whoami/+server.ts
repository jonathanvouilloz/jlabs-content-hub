import type { RequestHandler } from './$types.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

export const GET: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const activeProjects = await db
		.select({ slug: projects.slug, name: projects.name })
		.from(projects)
		.where(eq(projects.archived, false));

	return jsonResponse({
		env: process.env.VERCEL_ENV ?? 'local',
		version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev',
		project_count: activeProjects.length,
		projects: activeProjects.map((p) => p.slug)
	});
};
