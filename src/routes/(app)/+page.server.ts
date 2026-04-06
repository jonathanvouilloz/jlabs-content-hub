import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, projects, gmbReviews } from '$lib/server/db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';

export const load: PageServerLoad = async () => {
	const [statusCounts, projectCount, recentContents, pendingReviews, reviewContents] = await Promise.all([
		db
			.select({
				draft: sql<number>`sum(case when ${contents.status} = 'draft' then 1 else 0 end)`,
				review: sql<number>`sum(case when ${contents.status} = 'review' then 1 else 0 end)`,
				approved: sql<number>`sum(case when ${contents.status} = 'approved' then 1 else 0 end)`,
				published: sql<number>`sum(case when ${contents.status} = 'published' then 1 else 0 end)`,
				total: sql<number>`count(*)`
			})
			.from(contents)
			.then(r => r[0]),
		db
			.select({ count: sql<number>`count(*)` })
			.from(projects)
			.where(eq(projects.archived, false)),
		db
			.select({
				id: contents.id,
				title: contents.title,
				type: contents.type,
				status: contents.status,
				plannedDate: contents.plannedDate,
				createdAt: contents.createdAt,
				projectId: contents.projectId,
				projectName: projects.name,
				projectColor: projects.color,
				projectSlug: projects.slug
			})
			.from(contents)
			.leftJoin(projects, eq(contents.projectId, projects.id))
			.orderBy(desc(contents.createdAt))
			.limit(10),
		// Count pending reviews grouped by project
		db
			.select({
				projectId: gmbReviews.projectId,
				projectName: projects.name,
				projectSlug: projects.slug,
				projectColor: projects.color,
				count: sql<number>`count(*)`
			})
			.from(gmbReviews)
			.leftJoin(projects, eq(gmbReviews.projectId, projects.id))
			.groupBy(gmbReviews.projectId),
		// Count contents in review
		db
			.select({
				projectId: contents.projectId,
				projectName: projects.name,
				projectSlug: projects.slug,
				projectColor: projects.color,
				count: sql<number>`count(*)`
			})
			.from(contents)
			.leftJoin(projects, eq(contents.projectId, projects.id))
			.where(eq(contents.status, 'review'))
			.groupBy(contents.projectId)
	]);

	return {
		stats: {
			projects: projectCount[0]?.count ?? 0,
			draft: statusCounts?.draft ?? 0,
			review: statusCounts?.review ?? 0,
			approved: statusCounts?.approved ?? 0,
			published: statusCounts?.published ?? 0,
			total: statusCounts?.total ?? 0
		},
		recentContents,
		pendingReviews,
		reviewContents
	};
};
