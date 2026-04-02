import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db/index.js';
import { contents, projects, statusHistory } from '$lib/server/db/schema.js';
import { eq, and, lte } from 'drizzle-orm';
import { publishPost } from '$lib/server/gmb.js';
import { createId } from '$lib/server/utils.js';
import type { RequestHandler } from './$types';

interface GmbBody {
	content: string;
	type?: string;
	cta?: { action: string; url: string };
	image_url?: string;
	event_start_date?: string;
	event_end_date?: string;
}

export const GET: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('authorization');
	if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const now = new Date().toISOString();

	// Fetch approved GMB contents whose planned_date is due
	const dueContents = await db
		.select({ content: contents, project: projects })
		.from(contents)
		.innerJoin(projects, eq(contents.projectId, projects.id))
		.where(
			and(
				eq(contents.type, 'gmb'),
				eq(contents.status, 'approved'),
				lte(contents.plannedDate, now)
			)
		);

	let published = 0;
	let errors = 0;

	for (const { content, project } of dueContents) {
		if (!project.gmbLocationId) {
			errors++;
			continue;
		}

		let gmbBody: GmbBody;
		try {
			gmbBody = JSON.parse(content.body);
		} catch {
			errors++;
			continue;
		}

		const result = await publishPost(
			{ id: project.id, gmbLocationId: project.gmbLocationId },
			{
				id: content.id,
				title: content.title,
				body: gmbBody.content,
				type: gmbBody.type || 'whats_new',
				ctaAction: gmbBody.cta?.action ?? null,
				ctaUrl: gmbBody.cta?.url ?? null,
				imageUrl: gmbBody.image_url ?? null,
				eventStartDate: gmbBody.event_start_date ?? null,
				eventEndDate: gmbBody.event_end_date ?? null
			}
		);

		if (result.success) {
			await db
				.update(contents)
				.set({ status: 'published', publishedAt: now, gmbPostId: result.gmb_post_id, updatedAt: now })
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
