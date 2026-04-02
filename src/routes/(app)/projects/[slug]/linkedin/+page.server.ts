import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents } from '$lib/server/db/schema.js';
import { eq, and, asc, sql } from 'drizzle-orm';

export const load: PageServerLoad = async ({ parent }) => {
	const { project } = await parent();

	const items = await db
		.select()
		.from(contents)
		.where(and(eq(contents.projectId, project.id), eq(contents.type, 'linkedin')))
		.orderBy(sql`CASE WHEN ${contents.plannedDate} IS NULL THEN 1 ELSE 0 END`, asc(contents.plannedDate));

	return { contents: items };
};
