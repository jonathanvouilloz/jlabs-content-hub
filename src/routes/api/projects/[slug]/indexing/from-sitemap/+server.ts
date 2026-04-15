import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { batchSubmit, fetchSitemapUrls, getCredentials } from '$lib/server/indexing.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({ where: eq(projects.slug, event.params.slug) });
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const body = await event.request.json().catch(() => ({}));
	const dryRun = !!body.dryRun;

	const creds = await getCredentials(project.id);
	const sitemapUrl: string | null = body.sitemapUrl ?? creds?.sitemapUrl ?? null;
	if (!sitemapUrl) {
		return json({ error: 'No sitemap URL provided or stored' }, { status: 400 });
	}

	let urls: string[];
	try {
		urls = await fetchSitemapUrls(sitemapUrl);
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Sitemap fetch failed';
		return json({ error: msg }, { status: 400 });
	}

	if (dryRun) {
		return json({ sitemapUrl, count: urls.length, urls });
	}

	const result = await batchSubmit({
		projectId: project.id,
		urls,
		type: 'URL_UPDATED',
		source: 'sitemap'
	});

	return json({ sitemapUrl, ...result });
};
