import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { contents, statusHistory } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { publishPost } from '$lib/server/linkedin.js';
import { createId } from '$lib/server/utils.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const content = await db
		.select()
		.from(contents)
		.where(eq(contents.id, params.contentId))
		.then((r) => r[0]);

	if (!content || content.type !== 'linkedin') {
		return json({ error: 'LinkedIn content not found' }, { status: 404 });
	}

	const result = await publishPost(content.body);

	const now = new Date().toISOString();
	const previousStatus = content.status;

	if (result.success) {
		await db
			.update(contents)
			.set({
				status: 'published',
				publishedAt: now,
				meta: result.post_id ? JSON.stringify({ linkedin_post_id: result.post_id }) : content.meta,
				updatedAt: now
			})
			.where(eq(contents.id, content.id));

		await db.insert(statusHistory).values({
			id: createId(),
			contentId: content.id,
			fromStatus: previousStatus,
			toStatus: 'published',
			changedBy: 'linkedin-publish'
		});
	}

	return json(result);
};
