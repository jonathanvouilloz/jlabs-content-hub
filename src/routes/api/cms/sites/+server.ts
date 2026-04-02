import { json } from '@sveltejs/kit';
import { getAdapter } from '$lib/server/cms/index.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const cmsType = url.searchParams.get('cmsType');
	const apiToken = url.searchParams.get('apiToken');

	if (!cmsType || !apiToken) {
		return json({ error: 'Missing cmsType or apiToken' }, { status: 400 });
	}

	try {
		const adapter = getAdapter(cmsType);
		const sites = await adapter.listSites(apiToken);
		return json({ ok: true, data: sites });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 502 });
	}
};
