import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import {
	batchInspect,
	batchSubmit,
	fetchSitemapUrls,
	getCredentials,
	parseExcludePatterns,
	partitionByPatterns
} from '$lib/server/indexing.js';
import type { RequestHandler } from './$types';

type Mode = 'index' | 'index-not-indexed' | 'deindex-excluded';

export const POST: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({ where: eq(projects.slug, event.params.slug) });
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const body = await event.request.json().catch(() => ({}));
	const dryRun = !!body.dryRun;
	const mode: Mode =
		body.mode === 'deindex-excluded'
			? 'deindex-excluded'
			: body.mode === 'index-not-indexed'
				? 'index-not-indexed'
				: 'index';

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

	if (mode === 'deindex-excluded') {
		if (dryRun) {
			return json({
				sitemapUrl,
				sitemapTotal: urls.length,
				kept: kept.length,
				excluded: excluded.length,
				targetCount: excluded.length,
				urls: excluded,
				mode
			});
		}
		const result = await batchSubmit({
			projectId: project.id,
			urls: excluded,
			type: 'URL_DELETED',
			source: 'sitemap-deindex'
		});
		return json({
			sitemapUrl,
			sitemapTotal: urls.length,
			kept: kept.length,
			excluded: excluded.length,
			mode,
			...result
		});
	}

	if (mode === 'index-not-indexed') {
		if (!creds?.siteUrl) {
			return json({ error: 'siteUrl not configured (required for URL Inspection)' }, { status: 400 });
		}
		if (dryRun) {
			// Dry-run for smart mode just returns kept count; the inspection happens at submit time
			// (otherwise we'd burn 2× the inspection quota)
			return json({
				sitemapUrl,
				sitemapTotal: urls.length,
				kept: kept.length,
				excluded: excluded.length,
				targetCount: kept.length,
				urls: kept,
				mode,
				note: 'L\'inspection effective et la soumission ont lieu au lancement réel.'
			});
		}

		const inspection = await batchInspect({
			projectId: project.id,
			urls: kept,
			siteUrl: creds.siteUrl
		});

		const submitResult = await batchSubmit({
			projectId: project.id,
			urls: inspection.notIndexed,
			type: 'URL_UPDATED',
			source: 'sitemap-smart'
		});

		return json({
			sitemapUrl,
			sitemapTotal: urls.length,
			kept: kept.length,
			excluded: excluded.length,
			mode,
			alreadyIndexed: inspection.indexed.length,
			notIndexed: inspection.notIndexed.length,
			inspectionUnknown: inspection.unknown.length,
			inspectionErrors: inspection.errors.length,
			inspectionStoppedOnQuota: inspection.stoppedOnQuota,
			...submitResult
		});
	}

	// Default mode: 'index' (legacy — submit all kept URLs)
	if (dryRun) {
		return json({
			sitemapUrl,
			sitemapTotal: urls.length,
			kept: kept.length,
			excluded: excluded.length,
			targetCount: kept.length,
			urls: kept,
			mode
		});
	}
	const result = await batchSubmit({
		projectId: project.id,
		urls: kept,
		type: 'URL_UPDATED',
		source: 'sitemap'
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
