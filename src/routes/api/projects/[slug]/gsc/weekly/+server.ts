import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { getDiff, getSnapshot } from '$lib/server/gsc-analytics.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const week = event.url.searchParams.get('week');
	if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
		return json({ error: 'Param "week" attendu au format YYYY-MM-DD' }, { status: 400 });
	}

	const [snapshot, diff] = await Promise.all([
		getSnapshot(project.id, week),
		getDiff(project.id, week)
	]);

	if (!snapshot) {
		return json({ snapshot: null, diff: null }, { status: 200 });
	}

	return json({ snapshot, diff });
};
