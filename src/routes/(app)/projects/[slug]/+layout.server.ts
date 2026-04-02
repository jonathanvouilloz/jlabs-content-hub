import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, cmsConnections, gmbSettings, linkedinSettings } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

export const load: LayoutServerLoad = async ({ params }) => {
	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});

	if (!project) throw error(404, 'Projet introuvable');

	// Check CMS connection
	const cmsConnection = await db
		.select()
		.from(cmsConnections)
		.where(eq(cmsConnections.projectId, project.id))
		.get();

	// Check GMB connection (global account tokens)
	const gmbTokens = await db
		.select()
		.from(gmbSettings)
		.where(eq(gmbSettings.key, 'account_tokens'))
		.get();

	// Check LinkedIn connection (global account tokens)
	const linkedinTokens = await db
		.select()
		.from(linkedinSettings)
		.where(eq(linkedinSettings.key, 'account_tokens'))
		.get();

	return {
		project,
		connections: {
			cms: !!cmsConnection,
			cmsType: cmsConnection?.cmsType ?? null,
			gmb: !!gmbTokens,
			gmbLocation: !!project.gmbLocationId,
			linkedin: !!linkedinTokens
		}
	};
};
