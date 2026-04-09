import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { projects, gmbReviews, projectContexts } from '$lib/server/db/schema.js';
import { eq, desc, isNull, and } from 'drizzle-orm';
import { validateApiKey } from '$lib/server/api-auth.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const allProjects = await db
		.select({ id: projects.id, name: projects.name, slug: projects.slug })
		.from(projects)
		.where(eq(projects.archived, false));

	const result = [];

	for (const project of allProjects) {
		const reviews = await db
			.select()
			.from(gmbReviews)
			.where(and(eq(gmbReviews.projectId, project.id), isNull(gmbReviews.repliedAt)))
			.orderBy(desc(gmbReviews.createTime));

		if (reviews.length === 0) continue;

		const ctxRow = await db
			.select()
			.from(projectContexts)
			.where(eq(projectContexts.projectId, project.id))
			.get();

		result.push({
			project: { id: project.id, name: project.name, slug: project.slug },
			context: ctxRow ? JSON.parse(ctxRow.context) : null,
			reviews
		});
	}

	return json({ projects: result });
};
