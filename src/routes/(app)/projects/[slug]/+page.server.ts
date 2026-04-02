import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents } from '$lib/server/db/schema.js';
import { eq, and, asc, gt, sql } from 'drizzle-orm';

export const load: PageServerLoad = async ({ parent, url }) => {
	const { project } = await parent();

	const statusFilter = url.searchParams.get('status');

	const conditions = [eq(contents.projectId, project.id)];
	if (statusFilter) conditions.push(eq(contents.status, statusFilter));

	const projectContents = await db
		.select()
		.from(contents)
		.where(and(...conditions))
		.orderBy(sql`CASE WHEN ${contents.plannedDate} IS NULL THEN 1 ELSE 0 END`, asc(contents.plannedDate));

	// Count contents per type (unfiltered)
	const allContents = await db
		.select({ type: contents.type })
		.from(contents)
		.where(eq(contents.projectId, project.id));

	const typeCounts = {
		all: allContents.length,
		article: allContents.filter((c) => c.type === 'article').length,
		linkedin: allContents.filter((c) => c.type === 'linkedin').length,
		gmb: allContents.filter((c) => c.type === 'gmb').length
	};

	// Next 3 upcoming contents
	const now = new Date().toISOString();
	const upcoming = await db
		.select()
		.from(contents)
		.where(
			and(
				eq(contents.projectId, project.id),
				gt(contents.plannedDate, now)
			)
		)
		.orderBy(asc(contents.plannedDate))
		.limit(3);

	return {
		contents: projectContents,
		filters: { status: statusFilter },
		typeCounts,
		upcoming
	};
};
