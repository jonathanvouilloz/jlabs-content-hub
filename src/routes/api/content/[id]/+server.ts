import type { RequestHandler } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents } from '$lib/server/db/schema.js';
import { validateApiKey, errorResponse, jsonResponse } from '$lib/server/api-auth.js';
import { pushFileToGitHub, deleteFileFromGitHub } from '$lib/server/github.js';
import { eq } from 'drizzle-orm';

export const GET: RequestHandler = async (event) => {
	if (!validateApiKey(event) && !event.locals.user) {
		return errorResponse('Unauthorized', 401);
	}

	const content = await db.query.contents.findFirst({
		where: eq(contents.id, event.params.id)
	});

	if (!content) return errorResponse('Content not found', 404);
	return jsonResponse(content);
};

export const PUT: RequestHandler = async (event) => {
	if (!validateApiKey(event) && !event.locals.user) {
		return errorResponse('Unauthorized', 401);
	}

	const content = await db.query.contents.findFirst({
		where: eq(contents.id, event.params.id)
	});
	if (!content) return errorResponse('Content not found', 404);

	const body = await event.request.json();
	const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };

	if (body.title !== undefined) updates.title = body.title;
	if (body.body !== undefined) updates.body = body.body;
	if (body.planned_date !== undefined) updates.plannedDate = body.planned_date;
	if (body.tags !== undefined) updates.tags = JSON.stringify(body.tags);
	if (body.meta !== undefined) updates.meta = JSON.stringify(body.meta);

	await db.update(contents).set(updates).where(eq(contents.id, event.params.id));

	if (body.body && content.githubPath) {
		pushFileToGitHub(content.githubPath, body.body, `update: ${content.slug}`).then(async (synced) => {
			await db.update(contents).set({ githubSynced: synced }).where(eq(contents.id, event.params.id));
		});
	}

	return jsonResponse({ id: event.params.id });
};

export const DELETE: RequestHandler = async (event) => {
	if (!validateApiKey(event)) {
		return errorResponse('Unauthorized', 401);
	}

	const content = await db.query.contents.findFirst({
		where: eq(contents.id, event.params.id)
	});
	if (!content) return errorResponse('Content not found', 404);

	await db.delete(contents).where(eq(contents.id, event.params.id));

	if (content.githubPath) {
		deleteFileFromGitHub(content.githubPath, `delete: ${content.slug}`);
	}

	return jsonResponse({ deleted: true });
};
