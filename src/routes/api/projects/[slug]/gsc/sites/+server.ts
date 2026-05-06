import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { listAccessibleSites } from '$lib/server/gsc-analytics.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	try {
		const sites = await listAccessibleSites(project.id);
		return json({ sites });
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Erreur inconnue';
		return json({ error: msg }, { status: 500 });
	}
};
