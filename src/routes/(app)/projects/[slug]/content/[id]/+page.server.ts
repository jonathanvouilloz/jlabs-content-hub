import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, comments, statusHistory, cmsConnections, linkedinSettings, projectGmbLocations } from '$lib/server/db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { parseFrontmatter } from '$lib/utils/content.js';
import { countLogsForContent } from '$lib/server/publish-logs.js';

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

	const strippedBody = content.type !== 'gmb'
		? parseFrontmatter(content.body).content
		: content.body;

	const cmsConnection = content.type === 'article'
		? await db.select().from(cmsConnections).where(eq(cmsConnections.projectId, content.projectId)).get()
		: null;

	const linkedinConnected = content.type === 'linkedin'
		? !!(await db.select().from(linkedinSettings).where(eq(linkedinSettings.key, 'account_tokens')).get())
		: false;

	const gmbLocations = content.type === 'gmb'
		? await db.select().from(projectGmbLocations).where(eq(projectGmbLocations.projectId, content.projectId))
		: [];

	const publishLogsCount = content.type === 'gmb' ? await countLogsForContent(params.id) : 0;

	return {
		content: { ...content, body: strippedBody },
		project,
		comments: contentComments,
		history,
		cmsConnection: cmsConnection
			? { cmsType: cmsConnection.cmsType, config: JSON.parse(cmsConnection.config) }
			: null,
		linkedinConnected,
		gmbLocations,
		publishLogsCount
	};
};
