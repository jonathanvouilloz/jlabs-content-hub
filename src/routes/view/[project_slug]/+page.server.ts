import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, projects } from '$lib/server/db/schema.js';
import { eq, and, ne, asc, sql } from 'drizzle-orm';
import { validateClientToken } from '$lib/server/api-auth.js';
import { parseFrontmatter, renderMarkdown } from '$lib/utils/content.js';

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
		.orderBy(sql`CASE WHEN ${contents.plannedDate} IS NULL THEN 1 ELSE 0 END`, asc(contents.plannedDate));

	// Pre-render bodies server-side (gray-matter needs Node.js Buffer)
	const contentsWithRendered = projectContents.map((c) => {
		if (c.type === 'gmb') {
			try {
				const gmb = JSON.parse(c.body);
				return { ...c, renderedBody: null, gmbData: gmb };
			} catch {
				return { ...c, renderedBody: null, gmbData: null };
			}
		}
		const { content } = parseFrontmatter(c.body);
		return { ...c, renderedBody: renderMarkdown(content), gmbData: null };
	});

	return {
		project: { name: project.name, slug: project.slug, color: project.color },
		contents: contentsWithRendered,
		token
	};
};
