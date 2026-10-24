import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, comments, statusHistory, cmsConnections } from '$lib/server/db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { parseFrontmatter } from '$lib/utils/content.js';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { project } = await parent();

	const content = await db.query.contents.findFirst({
		where: eq(contents.id, params.id)
	});

	if (!content) throw error(404, 'Contenu introuvable');

	const contentComments = await db
		.select()
		.from(comments)
		.where(eq(comments.contentId, params.id))
		.orderBy(desc(comments.createdAt));

	const history = await db
		.select()
		.from(statusHistory)
		.where(eq(statusHistory.contentId, params.id))
		.orderBy(desc(statusHistory.changedAt));

	const strippedBody = parseFrontmatter(content.body).content;

	const cmsConnection = content.type === 'article'
		? await db.select().from(cmsConnections).where(eq(cmsConnections.projectId, content.projectId)).then((r) => r[0])
		: null;

	return {
		content: { ...content, body: strippedBody },
		project,
		comments: contentComments,
		history,
		cmsConnection: cmsConnection
			? { cmsType: cmsConnection.cmsType, config: JSON.parse(cmsConnection.config) }
			: null
	};
};
