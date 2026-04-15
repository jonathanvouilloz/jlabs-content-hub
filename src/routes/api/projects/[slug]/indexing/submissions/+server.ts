import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { countSubmissions, listSubmissions } from '$lib/server/indexing.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({ where: eq(projects.slug, event.params.slug) });
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const limit = Math.min(Math.max(parseInt(event.url.searchParams.get('limit') || '20', 10) || 20, 1), 200);
	const offset = Math.max(parseInt(event.url.searchParams.get('offset') || '0', 10) || 0, 0);

	const [rows, total] = await Promise.all([
		listSubmissions(project.id, limit, offset),
		countSubmissions(project.id)
	]);

	return json({ submissions: rows, total, limit, offset });
};
