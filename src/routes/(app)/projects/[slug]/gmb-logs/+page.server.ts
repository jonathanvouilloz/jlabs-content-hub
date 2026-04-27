import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { publishLogs, contents, projectGmbLocations } from '$lib/server/db/schema.js';
import { eq, and, gte, lte, desc, sql, type SQL } from 'drizzle-orm';

const PAGE_SIZE = 100;

export const load: PageServerLoad = async ({ parent, url }) => {
	const { project } = await parent();

	const successFilter = url.searchParams.get('success') ?? 'all';
	const locationFilter = url.searchParams.get('locationId') ?? '';
	const contentFilter = url.searchParams.get('contentId') ?? '';
	const fromIso = url.searchParams.get('from') ?? '';
	const toIso = url.searchParams.get('to') ?? '';
	const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0') || 0);

	const conditions: SQL[] = [eq(publishLogs.projectId, project.id)];

	if (successFilter === 'true') conditions.push(eq(publishLogs.success, true));
	else if (successFilter === 'false') conditions.push(eq(publishLogs.success, false));

	if (locationFilter) conditions.push(eq(publishLogs.locationId, locationFilter));
	if (contentFilter) conditions.push(eq(publishLogs.contentId, contentFilter));
	if (fromIso) conditions.push(gte(publishLogs.attemptedAt, fromIso));
	if (toIso) conditions.push(lte(publishLogs.attemptedAt, toIso));

	const where = and(...conditions);

	const [logs, totalRow, locations] = await Promise.all([
		db
			.select({
				id: publishLogs.id,
				contentId: publishLogs.contentId,
				channel: publishLogs.channel,
				locationId: publishLogs.locationId,
				locationLabel: publishLogs.locationLabel,
				success: publishLogs.success,
				gmbPostId: publishLogs.gmbPostId,
				errorMessage: publishLogs.errorMessage,
				attemptedAt: publishLogs.attemptedAt,
				durationMs: publishLogs.durationMs,
				source: publishLogs.source,
				contentTitle: contents.title
			})
			.from(publishLogs)
			.leftJoin(contents, eq(publishLogs.contentId, contents.id))
			.where(where)
			.orderBy(desc(publishLogs.attemptedAt))
			.limit(PAGE_SIZE)
			.offset(offset),
		db
			.select({ n: sql<number>`count(*)` })
			.from(publishLogs)
			.where(where)
			.get(),
		db
			.select()
			.from(projectGmbLocations)
			.where(eq(projectGmbLocations.projectId, project.id))
	]);

	return {
		logs,
		total: totalRow?.n ?? 0,
		offset,
		pageSize: PAGE_SIZE,
		filters: {
			success: successFilter,
			locationId: locationFilter,
			contentId: contentFilter,
			from: fromIso,
			to: toIso
		},
		locations
	};
};
