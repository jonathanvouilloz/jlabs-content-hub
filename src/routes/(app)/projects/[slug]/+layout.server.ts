import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { projects, cmsConnections } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

export const load: LayoutServerLoad = async ({ params }) => {
	const project = await db.query.projects.findFirst({
		columns: {
			id: true, name: true, slug: true, entityId: true, description: true,
			color: true, image: true, archived: true,
			clientEmail: true, weeklyDigestEnabled: true, createdAt: true, updatedAt: true
		},
		where: eq(projects.slug, params.slug)
	});

	if (!project) throw error(404, 'Projet introuvable');

	// Check CMS connection
	const cmsConnection = await db
		.select()
		.from(cmsConnections)
		.where(eq(cmsConnections.projectId, project.id))
		.then((r) => r[0]);

	return {
		project: { ...project },
		connections: {
			cms: !!cmsConnection,
			cmsType: cmsConnection?.cmsType ?? null
		}
	};
};
