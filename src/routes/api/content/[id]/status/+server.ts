import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, statusHistory } from '$lib/server/db/schema.js';
import { createId } from '$lib/server/utils.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { eq } from 'drizzle-orm';

const VALID_STATUSES = ['draft', 'review', 'approved', 'published'];

export const PATCH: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const body = await event.request.json();
	const { status } = body;

	if (!status || !VALID_STATUSES.includes(status)) {
		return errorResponse(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`, 400);
	}

	const content = await db.query.contents.findFirst({
		where: eq(contents.id, event.params.id)
	});
	if (!content) return errorResponse('Content not found', 404);

	const updates: Record<string, unknown> = {
		status,
		updatedAt: new Date().toISOString()
	};

	if (status === 'published' && !content.publishedAt) {
		updates.publishedAt = new Date().toISOString();
	}
	if (status === 'published' && !content.plannedDate) {
		updates.plannedDate = new Date().toISOString().slice(0, 10);
	}

	await db.update(contents).set(updates).where(eq(contents.id, event.params.id));

	await db.insert(statusHistory).values({
		id: createId(),
		contentId: event.params.id,
		fromStatus: content.status,
		toStatus: status,
		changedBy: 'admin'
	});

	return jsonResponse({ id: event.params.id, status });
};
