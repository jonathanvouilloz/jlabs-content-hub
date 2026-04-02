import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { cmsConnections, gmbSettings, linkedinSettings } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

export const load: PageServerLoad = async ({ parent }) => {
	const { project } = await parent();

	const cmsConnection = await db.select().from(cmsConnections).where(eq(cmsConnections.projectId, project.id)).get();

	const gmbTokens = await db.select().from(gmbSettings).where(eq(gmbSettings.key, 'account_tokens')).get();

	const linkedinTokens = await db.select().from(linkedinSettings).where(eq(linkedinSettings.key, 'account_tokens')).get();
	const linkedinName = await db.select().from(linkedinSettings).where(eq(linkedinSettings.key, 'person_name')).get();

	return {
		cmsConnection: cmsConnection ? { id: cmsConnection.id, cmsType: cmsConnection.cmsType, config: JSON.parse(cmsConnection.config) } : null,
		gmbConnected: !!gmbTokens,
		linkedinConnected: !!linkedinTokens,
		linkedinPersonName: linkedinName?.value ?? null
	};
};
