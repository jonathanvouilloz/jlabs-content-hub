import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import {
	batchSubmit,
	fetchSitemapUrls,
	getCredentials,
	parseExcludePatterns,
	partitionByPatterns
} from '$lib/server/indexing.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({ where: eq(projects.slug, event.params.slug) });
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const body = await event.request.json().catch(() => ({}));
	const dryRun = !!body.dryRun;
	const mode: 'index' | 'deindex-excluded' = body.mode === 'deindex-excluded' ? 'deindex-excluded' : 'index';

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

	const patterns = parseExcludePatterns(creds?.excludePatterns);
	const { kept, excluded } = partitionByPatterns(urls, patterns);

	const targetUrls = mode === 'deindex-excluded' ? excluded : kept;
	const submitType = mode === 'deindex-excluded' ? 'URL_DELETED' : 'URL_UPDATED';
	const source = mode === 'deindex-excluded' ? 'sitemap-deindex' : 'sitemap';

	if (dryRun) {
		return json({
			sitemapUrl,
			total: urls.length,
			kept: kept.length,
			excluded: excluded.length,
			targetCount: targetUrls.length,
			urls: targetUrls,
			mode
		});
	}

	const result = await batchSubmit({
		projectId: project.id,
		urls: targetUrls,
		type: submitType,
		source
	});

	return json({
		sitemapUrl,
		sitemapTotal: urls.length,
		kept: kept.length,
		excluded: excluded.length,
		mode,
		...result
	});
};
