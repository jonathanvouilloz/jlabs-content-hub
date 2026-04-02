import { json } from '@sveltejs/kit';
import { getAdapter } from '$lib/server/cms/index.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const cmsType = url.searchParams.get('cmsType');
	const apiToken = url.searchParams.get('apiToken');
	const siteId = url.searchParams.get('siteId');

	if (!cmsType || !apiToken || !siteId) {
		return json({ error: 'Missing cmsType, apiToken, or siteId' }, { status: 400 });
	}

	try {
		const adapter = getAdapter(cmsType);
		const collections = await adapter.listCollections(apiToken, siteId);
		return json({ ok: true, data: collections });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 502 });
	}
};
