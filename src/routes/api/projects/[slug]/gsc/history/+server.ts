import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { listSnapshots } from '$lib/server/gsc-analytics.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const limit = Math.min(Math.max(parseInt(event.url.searchParams.get('limit') ?? '52', 10) || 52, 1), 200);
	const snapshots = await listSnapshots(project.id, limit);
	return json({ snapshots, total: snapshots.length });
};
