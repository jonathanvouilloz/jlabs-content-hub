import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db/index.js';
import { contents, statusHistory } from '$lib/server/db/schema.js';
import { eq, and, lte } from 'drizzle-orm';
import { publishPost } from '$lib/server/linkedin.js';
import { createId } from '$lib/server/utils.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('authorization');
	if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const now = new Date().toISOString();

	const dueContents = await db
		.select()
		.from(contents)
		.where(
			and(
				eq(contents.type, 'linkedin'),
				eq(contents.status, 'approved'),
				lte(contents.plannedDate, now)
			)
		);

	let published = 0;
	let errors = 0;

	for (const content of dueContents) {
		const result = await publishPost(content.body);

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
				fromStatus: 'approved',
				toStatus: 'published',
				changedBy: 'cron'
			});

			published++;
		} else {
			errors++;
		}
	}

	return json({ published, errors, total: dueContents.length });
};
