import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, projects, comments } from '$lib/server/db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { validateClientToken } from '$lib/server/api-auth.js';

export const load: PageServerLoad = async ({ params, url }) => {
	const token = url.searchParams.get('token');
	if (!token) throw error(404, 'Not found');

	const client = await validateClientToken(token);
	if (!client || client.projectSlug !== params.project_slug) throw error(404, 'Not found');

	const content = await db.query.contents.findFirst({
		where: eq(contents.id, params.content_id)
	});
	if (!content || content.projectId !== client.projectId) throw error(404, 'Not found');
	if (content.status === 'draft') throw error(404, 'Not found');

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, client.projectId)
	});

	const contentComments = await db
		.select()
		.from(comments)
		.where(eq(comments.contentId, params.content_id))
		.orderBy(desc(comments.createdAt));

	return {
		content,
		project: { name: project!.name, slug: project!.slug, color: project!.color },
		comments: contentComments,
		token
	};
};
