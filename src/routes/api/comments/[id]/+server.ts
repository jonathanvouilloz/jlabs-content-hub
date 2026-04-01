import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { comments } from '$lib/server/db/schema.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { eq } from 'drizzle-orm';

export const DELETE: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const comment = await db.query.comments.findFirst({
		where: eq(comments.id, event.params.id)
	});
	if (!comment) return errorResponse('Comment not found', 404);

	await db.delete(comments).where(eq(comments.id, event.params.id));
	return jsonResponse({ deleted: true });
};
