import { json } from '@sveltejs/kit';
import { listLocations } from '$lib/server/gmb.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const locations = await listLocations();
		return json({ locations });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ error: message }, { status: 500 });
	}
};
