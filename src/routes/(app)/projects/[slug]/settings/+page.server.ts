import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { cmsConnections, gmbSettings, linkedinSettings, projectGmbLocations, projectContexts, indexingCredentials, indexingSubmissions } from '$lib/server/db/schema.js';
import { parseExcludePatterns } from '$lib/server/indexing.js';
import { desc, eq, sql } from 'drizzle-orm';

export const load: PageServerLoad = async ({ parent }) => {
	const { project } = await parent();

	const cmsConnection = await db.select().from(cmsConnections).where(eq(cmsConnections.projectId, project.id)).get();

	const gmbTokens = await db.select().from(gmbSettings).where(eq(gmbSettings.key, 'account_tokens')).get();

	const assignedLocations = await db
		.select()
		.from(projectGmbLocations)
		.where(eq(projectGmbLocations.projectId, project.id));

	const linkedinTokens = await db.select().from(linkedinSettings).where(eq(linkedinSettings.key, 'account_tokens')).get();
	const linkedinName = await db.select().from(linkedinSettings).where(eq(linkedinSettings.key, 'person_name')).get();

	const projectContext = await db.select().from(projectContexts).where(eq(projectContexts.projectId, project.id)).get();

	const indexingCred = await db.select().from(indexingCredentials).where(eq(indexingCredentials.projectId, project.id)).get();

	const indexingSubs = await db
		.select()
		.from(indexingSubmissions)
		.where(eq(indexingSubmissions.projectId, project.id))
		.orderBy(desc(indexingSubmissions.submittedAt))
		.limit(20);

	const indexingCountRow = await db
		.select({ count: sql<number>`count(*)` })
		.from(indexingSubmissions)
		.where(eq(indexingSubmissions.projectId, project.id))
		.get();
	const indexingTotal = Number(indexingCountRow?.count ?? 0);

	return {
		cmsConnection: cmsConnection ? { id: cmsConnection.id, cmsType: cmsConnection.cmsType, config: JSON.parse(cmsConnection.config) } : null,
		gmbConnected: !!gmbTokens,
		assignedGmbLocations: assignedLocations,
		linkedinConnected: !!linkedinTokens,
		linkedinPersonName: linkedinName?.value ?? null,
		projectContext: projectContext ? JSON.parse(projectContext.context) : null,
		indexingCredentials: indexingCred
			? {
					serviceAccountEmail: indexingCred.serviceAccountEmail,
					siteUrl: indexingCred.siteUrl,
					sitemapUrl: indexingCred.sitemapUrl,
					publicUrlTemplate: indexingCred.publicUrlTemplate,
					autoSubmitOnPublish: indexingCred.autoSubmitOnPublish,
					excludePatterns: parseExcludePatterns(indexingCred.excludePatterns),
					updatedAt: indexingCred.updatedAt
				}
			: null,
		indexingSubmissions: indexingSubs,
		indexingSubmissionsTotal: indexingTotal
	};
};
