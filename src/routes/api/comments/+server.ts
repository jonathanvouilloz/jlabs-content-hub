import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { comments, contents } from '$lib/server/db/schema.js';
import { createId } from '$lib/server/utils.js';
import { validateClientToken, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { eq } from 'drizzle-orm';

export const POST: RequestHandler = async (event) => {
	const token = event.url.searchParams.get('token');
	if (!token) return errorResponse('Missing token', 401);

	const client = await validateClientToken(token);
	if (!client) return errorResponse('Invalid token', 401);

	const body = await event.request.json();
	const { content_id, author_name, author_email, body: commentBody } = body;

	if (!content_id || !author_name || !author_email || !commentBody) {
		return errorResponse('Missing required fields: content_id, author_name, author_email, body', 400);
	}

	const content = await db.query.contents.findFirst({
		where: eq(contents.id, content_id)
	});
	if (!content) return errorResponse('Content not found', 404);
	if (content.projectId !== client.projectId) return errorResponse('Forbidden', 403);

	const id = createId();
	await db.insert(comments).values({
		id,
		contentId: content_id,
		authorName: author_name,
		authorEmail: author_email,
		body: commentBody
	});

	return jsonResponse({ id }, 201);
};
