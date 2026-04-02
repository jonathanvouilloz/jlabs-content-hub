import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, contents, gmbSettings, cmsConnections } from '$lib/server/db/schema.js';
import { eq, and, asc, sql } from 'drizzle-orm';

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
		.orderBy(sql`CASE WHEN ${contents.plannedDate} IS NULL THEN 1 ELSE 0 END`, asc(contents.plannedDate));

	// Count contents per type (unfiltered)
	const allContents = await db
		.select({ type: contents.type })
		.from(contents)
		.where(eq(contents.projectId, project.id));

	const typeCounts = {
		all: allContents.length,
		article: allContents.filter((c) => c.type === 'article').length,
		linkedin: allContents.filter((c) => c.type === 'linkedin').length,
		gmb: allContents.filter((c) => c.type === 'gmb').length
	};

	// Check if Google account is connected
	const accountTokens = await db
		.select()
		.from(gmbSettings)
		.where(eq(gmbSettings.key, 'account_tokens'))
		.get();

	// Load CMS connection
	const cmsConnection = await db
		.select()
		.from(cmsConnections)
		.where(eq(cmsConnections.projectId, project.id))
		.get();

	return {
		project,
		contents: projectContents,
		filters: { type: typeFilter, status: statusFilter },
		typeCounts,
		gmbConnected: !!accountTokens,
		cmsConnection: cmsConnection
			? { id: cmsConnection.id, cmsType: cmsConnection.cmsType, config: JSON.parse(cmsConnection.config) }
			: null
	};
};
