import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { contents, projects, comments, statusHistory } from '$lib/server/db/schema.js';
import { eq, desc } from 'drizzle-orm';

export const load: PageServerLoad = async ({ params }) => {
	const content = await db.query.contents.findFirst({
		where: eq(contents.id, params.id)
	});

	if (!content) throw error(404, 'Contenu introuvable');

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, content.projectId)
	});

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

	return {
		content,
		project,
		comments: contentComments,
		history
	};
};
