import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db/index.js';
import { projectGmbLocations } from '$lib/server/db/schema.js';
import { syncProjectReviews } from '$lib/server/gmb.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('authorization');
	if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Get all project IDs that have GMB locations
	const rows = await db
		.selectDistinct({ projectId: projectGmbLocations.projectId })
		.from(projectGmbLocations);

	let totalSynced = 0;
	let errors = 0;

	for (const { projectId } of rows) {
		try {
			const synced = await syncProjectReviews(projectId);
			totalSynced += synced;
		} catch {
			errors++;
		}
	}

	return json({ synced: totalSynced, errors, projects: rows.length });
};
