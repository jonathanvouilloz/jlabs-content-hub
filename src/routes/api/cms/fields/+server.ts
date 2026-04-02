import { json } from '@sveltejs/kit';
import { getAdapter } from '$lib/server/cms/index.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const cmsType = url.searchParams.get('cmsType');
	const apiToken = url.searchParams.get('apiToken');
	const collectionId = url.searchParams.get('collectionId');

	if (!cmsType || !apiToken || !collectionId) {
		return json({ error: 'Missing cmsType, apiToken, or collectionId' }, { status: 400 });
	}

	try {
		const adapter = getAdapter(cmsType);
		const fields = await adapter.getCollectionFields(apiToken, collectionId);
		return json({ ok: true, data: fields });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 502 });
	}
};
