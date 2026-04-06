import { json } from '@sveltejs/kit';
import { migrateGmbLocations } from '$lib/server/db/seed.js';
import type { RequestHandler } from './$types';

/** One-shot migration endpoint — delete after use */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const migrated = await migrateGmbLocations();
	return json({ ok: true, migrated });
};
