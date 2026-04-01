import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, contents } from '$lib/server/db/schema.js';
import { eq, sql } from 'drizzle-orm';

export const load: PageServerLoad = async () => {
	const allProjects = await db
		.select({
			id: projects.id,
			name: projects.name,
			slug: projects.slug,
			description: projects.description,
			color: projects.color,
			archived: projects.archived,
			createdAt: projects.createdAt,
			total: sql<number>`count(${contents.id})`,
			drafts: sql<number>`sum(case when ${contents.status} = 'draft' then 1 else 0 end)`,
			published: sql<number>`sum(case when ${contents.status} = 'published' then 1 else 0 end)`
		})
		.from(projects)
		.leftJoin(contents, eq(projects.id, contents.projectId))
		.where(eq(projects.archived, false))
		.groupBy(projects.id)
		.orderBy(projects.name);

	return { projects: allProjects };
};
