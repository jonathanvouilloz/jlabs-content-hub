import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { batchSubmit, type IndexingType } from '$lib/server/indexing.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({ where: eq(projects.slug, event.params.slug) });
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const body = await event.request.json();
	const urls: unknown = body.urls ?? (body.url ? [body.url] : null);
	const type = (body.type as IndexingType) || 'URL_UPDATED';

	if (!Array.isArray(urls) || urls.length === 0) {
		return json({ error: 'urls (array) or url is required' }, { status: 400 });
	}
	if (type !== 'URL_UPDATED' && type !== 'URL_DELETED') {
		return json({ error: 'type must be URL_UPDATED or URL_DELETED' }, { status: 400 });
	}

	const cleanUrls = urls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0);
	// IDX-008 : soumission générique manuelle → garde (flag + éligibilité). Sans type
	// éligible, la garde refuse+audite ; on renvoie le résultat `blocked` tel quel.
	const result = await batchSubmit({
		projectId: project.id,
		urls: cleanUrls,
		type,
		source: 'manual',
		flagCtx: { project: event.params.slug }
	});

	return json(
		result.blocked
			? {
					...result,
					message:
						'Soumission générique refusée (IDX-008) : l\'Indexing API est réservée à JobPosting/BroadcastEvent. Voie normale : sitemap + maillage interne + inspection.'
				}
			: result
	);
};
