import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { createId } from '$lib/server/utils.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { slugify } from '$lib/utils/slugify.js';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

export const POST: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const body = await event.request.json();
	const { name, slug: bodySlug, description, color, image } = body;

	if (!name) return errorResponse('Missing required field: name', 400);

	const slug = bodySlug || slugify(name);

	const existing = await db.query.projects.findFirst({
		where: eq(projects.slug, slug)
	});
	if (existing) return errorResponse(`Project with slug "${slug}" already exists`, 409);

	const id = createId();
	const accessToken = randomBytes(24).toString('hex');

	await db.insert(projects).values({
		id,
		name,
		slug,
		description: description ?? null,
		color: color ?? '#00D9A3',
		image: image ?? null,
		accessToken
	});

	return jsonResponse({ id, slug, access_token: accessToken }, 201);
};

export const GET: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const allProjects = await db.select().from(projects);
	return jsonResponse(allProjects);
};
