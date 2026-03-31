import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, contents } from '$lib/server/db/schema.js';
import { eq, and, desc } from 'drizzle-orm';

export const load: PageServerLoad = async ({ params, url }) => {
	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});

	if (!project) throw error(404, 'Projet introuvable');

	const typeFilter = url.searchParams.get('type');
	const statusFilter = url.searchParams.get('status');

	const conditions = [eq(contents.projectId, project.id)];
	if (typeFilter) conditions.push(eq(contents.type, typeFilter));
	if (statusFilter) conditions.push(eq(contents.status, statusFilter));

	const projectContents = await db
		.select()
		.from(contents)
		.where(and(...conditions))
		.orderBy(desc(contents.createdAt));

	return {
		project,
		contents: projectContents,
		filters: { type: typeFilter, status: statusFilter }
	};
};
