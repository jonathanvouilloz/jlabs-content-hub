import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, projects } from '$lib/server/db/schema.js';
import { eq, and, ne, desc } from 'drizzle-orm';
import { validateClientToken } from '$lib/server/api-auth.js';

export const load: PageServerLoad = async ({ params, url }) => {
	const token = url.searchParams.get('token');
	if (!token) throw error(404, 'Not found');

	const client = await validateClientToken(token);
	if (!client || client.projectSlug !== params.project_slug) throw error(404, 'Not found');

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.project_slug)
	});
	if (!project) throw error(404, 'Not found');

	const projectContents = await db
		.select()
		.from(contents)
		.where(and(eq(contents.projectId, client.projectId), ne(contents.status, 'draft')))
		.orderBy(desc(contents.plannedDate));

	return {
		project: { name: project.name, slug: project.slug, color: project.color },
		contents: projectContents,
		token
	};
};
