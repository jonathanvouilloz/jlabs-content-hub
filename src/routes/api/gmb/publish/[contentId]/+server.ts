import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { contents, projects, statusHistory } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { resolveTargetLocations, publishToLocations, buildGmbPostIdMap } from '$lib/server/gmb.js';
import { recordPublishLog } from '$lib/server/publish-logs.js';
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

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const content = await db
		.select()
		.from(contents)
		.where(eq(contents.id, params.contentId))
		.then((r) => r[0]);

	if (!content || content.type !== 'gmb') {
		return json({ error: 'GMB content not found' }, { status: 404 });
	}

	const project = await db
		.select()
		.from(projects)
		.where(eq(projects.id, content.projectId))
		.then((r) => r[0]);

	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	let gmbBody: GmbBody;
	try {
		gmbBody = JSON.parse(content.body);
	} catch {
		return json({ error: 'Invalid GMB JSON body' }, { status: 400 });
	}

	const meta = content.meta ? JSON.parse(content.meta) : null;
	const locations = await resolveTargetLocations(project.id, meta);

	if (locations.length === 0) {
		return json({ error: 'No GMB locations assigned to this project' }, { status: 400 });
	}

	const post = {
		id: content.id,
		title: content.title,
		body: gmbBody.content,
		type: gmbBody.type || 'whats_new',
		ctaAction: gmbBody.cta?.action ?? null,
		ctaUrl: gmbBody.cta?.url ?? null,
		imageUrl: gmbBody.image_url ?? null,
		eventStartDate: gmbBody.event_start_date ?? null,
		eventEndDate: gmbBody.event_end_date ?? null
	};

	const { results, allSuccess } = await publishToLocations(post, locations);

	for (const r of results) {
		await recordPublishLog({
			contentId: content.id,
			projectId: project.id,
			locationId: r.locationId,
			locationLabel: r.label,
			success: r.success,
			gmbPostId: r.gmb_post_id,
			errorMessage: r.error,
			durationMs: r.durationMs,
			source: 'manual'
		});
	}

	const hasAnySuccess = results.some((r) => r.success);

	if (hasAnySuccess) {
		const now = new Date().toISOString();
		const previousStatus = content.status;

		await db
			.update(contents)
			.set({
				status: 'published',
				publishedAt: now,
				gmbPostId: buildGmbPostIdMap(results),
				updatedAt: now
			})
			.where(eq(contents.id, content.id));

		await db.insert(statusHistory).values({
			id: createId(),
			contentId: content.id,
			fromStatus: previousStatus,
			toStatus: 'published',
			changedBy: 'gmb-publish'
		});
	}

	return json({ results, allSuccess });
};
