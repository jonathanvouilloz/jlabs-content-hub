import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db/index.js';
import { contents, projects, statusHistory, publishLogs } from '$lib/server/db/schema.js';
import { eq, and, lte, gte } from 'drizzle-orm';
import { resolveTargetLocations, publishToLocations, buildGmbPostIdMap } from '$lib/server/gmb.js';
import { recordPublishLog, consecutiveFailuresForLocation } from '$lib/server/publish-logs.js';
import { sendAdminDailyDigest, sendCriticalError, buildAdminDigestData } from '$lib/server/notifications.js';
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
		// Idempotence: re-check status in case of retry after timeout
		const fresh = await db
			.select({ status: contents.status })
			.from(contents)
			.where(eq(contents.id, content.id))
			.get();
		if (fresh?.status === 'published') continue;

		let gmbBody: GmbBody;
		try {
			gmbBody = JSON.parse(content.body);
		} catch (e) {
			await recordPublishLog({
				contentId: content.id,
				projectId: project.id,
				locationId: null,
				locationLabel: null,
				success: false,
				errorMessage: `Invalid GMB JSON body: ${(e as Error).message}`,
				source: 'cron'
			});
			errors++;
			continue;
		}

		const meta = content.meta ? JSON.parse(content.meta) : null;
		const locations = await resolveTargetLocations(project.id, meta);

		if (locations.length === 0) {
			await recordPublishLog({
				contentId: content.id,
				projectId: project.id,
				locationId: null,
				locationLabel: null,
				success: false,
				errorMessage: 'No GMB locations resolved for project',
				source: 'cron'
			});
			errors++;
			continue;
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

		const { results } = await publishToLocations(post, locations);

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
				source: 'cron'
			});
		}

		const hasAnySuccess = results.some((r) => r.success);

		if (hasAnySuccess) {
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
				fromStatus: 'approved',
				toStatus: 'published',
				changedBy: 'cron'
			});

			published++;
		} else {
			errors++;
		}

		// Detect consecutive failures per location for critical alert
		const failedLocs = new Set(results.filter((r) => !r.success).map((r) => r.locationId));
		for (const locId of failedLocs) {
			const fails = await consecutiveFailuresForLocation(locId, 3);
			if (fails >= 3) {
				const errMsg = results.find((r) => r.locationId === locId)?.error ?? 'Unknown';
				await sendCriticalError(
					`Location ${locId} a échoué 3x de suite`,
					`Projet : ${project.name} (${project.slug})\nDernière erreur : ${errMsg}`
				).catch(() => { /* never block cron on email */ });
			}
		}
	}

	// Daily admin digest (idempotent via gmb_settings.last_daily_digest_date)
	try {
		const startOfDayIso = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
		const todayLogs = await db
			.select({
				contentId: publishLogs.contentId,
				success: publishLogs.success,
				locationLabel: publishLogs.locationLabel,
				errorMessage: publishLogs.errorMessage,
				contentTitle: contents.title,
				projectName: projects.name,
				projectSlug: projects.slug
			})
			.from(publishLogs)
			.innerJoin(contents, eq(publishLogs.contentId, contents.id))
			.innerJoin(projects, eq(publishLogs.projectId, projects.id))
			.where(gte(publishLogs.attemptedAt, startOfDayIso));

		const digestData = buildAdminDigestData({
			date: startOfDayIso.slice(0, 10),
			logs: todayLogs.map((l) => ({
				contentId: l.contentId,
				success: l.success,
				locationLabel: l.locationLabel,
				errorMessage: l.errorMessage,
				project: { name: l.projectName, slug: l.projectSlug },
				contentTitle: l.contentTitle
			}))
		});
		await sendAdminDailyDigest(digestData);
	} catch (e) {
		console.error('Admin digest send failed:', e);
	}

	return json({ published, errors, total: dueContents.length });
};
