import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db/index.js';
import { projects, contents, publishLogs } from '$lib/server/db/schema.js';
import { eq, and, gte } from 'drizzle-orm';
import { sendClientWeeklyDigest } from '$lib/server/notifications.js';
import { getWatchlistWithSeries } from '$lib/server/gsc-analytics.js';
import type { RequestHandler } from './$types';

const APP_URL = env.PUBLIC_APP_URL ?? 'https://hub.jonlabs.ch';

export const GET: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('authorization');
	if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const sevenDaysAgo = new Date();
	sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
	const periodStart = sevenDaysAgo.toISOString();
	const periodEnd = new Date().toISOString();

	const enabledProjects = await db
		.select()
		.from(projects)
		.where(and(eq(projects.weeklyDigestEnabled, true), eq(projects.archived, false)));

	const results: Array<{ project: string; sent: boolean; reason?: string; postsCount: number }> = [];

	for (const project of enabledProjects) {
		// Aggregate successful publications per content for the last 7 days
		const successLogs = await db
			.select({
				contentId: publishLogs.contentId,
				locationLabel: publishLogs.locationLabel,
				attemptedAt: publishLogs.attemptedAt,
				contentTitle: contents.title,
				publishedAt: contents.publishedAt
			})
			.from(publishLogs)
			.innerJoin(contents, eq(publishLogs.contentId, contents.id))
			.where(
				and(
					eq(publishLogs.projectId, project.id),
					eq(publishLogs.success, true),
					gte(publishLogs.attemptedAt, periodStart)
				)
			);

		// Group by contentId
		const byContent = new Map<string, { title: string; locations: Set<string>; publishedAt: string }>();
		for (const l of successLogs) {
			if (!byContent.has(l.contentId)) {
				byContent.set(l.contentId, {
					title: l.contentTitle,
					locations: new Set(),
					publishedAt: l.publishedAt ?? l.attemptedAt
				});
			}
			if (l.locationLabel) byContent.get(l.contentId)!.locations.add(l.locationLabel);
		}

		const posts = [...byContent.values()].map((p) => ({
			title: p.title,
			locations: [...p.locations],
			publishedAt: p.publishedAt
		}));

		// Bloc « vos positions » (mots-clés suivis) — vide si aucun kw suivi / pas de GSC.
		const watchlist = await getWatchlistWithSeries(project.id);
		const positions = watchlist.map((w) => ({
			keyword: w.keyword,
			currentPosition: w.currentPosition,
			targetPosition: w.targetPosition,
			verdict: w.trend.verdict
		}));

		const result = await sendClientWeeklyDigest(project, {
			periodStart,
			periodEnd,
			posts,
			positions,
			positionsUrl: `${APP_URL}/positions/${project.slug}?token=${project.accessToken}`
		});

		results.push({ project: project.slug, sent: result.sent, reason: result.reason, postsCount: posts.length });
	}

	return json({
		processedProjects: enabledProjects.length,
		sent: results.filter((r) => r.sent).length,
		results
	});
};
