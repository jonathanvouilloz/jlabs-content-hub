import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { indexingCredentials, projects } from '$lib/server/db/schema.js';
import { validateClientToken } from '$lib/server/api-auth.js';
import { getWatchlistWithSeries, latestCompleteWeekStart } from '$lib/server/gsc-analytics.js';
import type { PageServerLoad } from './$types.js';

const HISTORY_WEEKS = 12;

/** Vue client publique des positions suivies — lecture seule, brandée, via ?token=. */
export const load: PageServerLoad = async ({ params, url }) => {
	const token = url.searchParams.get('token');
	if (!token) throw error(404, 'Not found');

	const client = await validateClientToken(token);
	if (!client || client.projectSlug !== params.slug) throw error(404, 'Not found');

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, params.slug)
	});
	if (!project) throw error(404, 'Not found');

	const cred = await db.query.indexingCredentials.findFirst({
		where: eq(indexingCredentials.projectId, project.id)
	});
	const hasGsc = !!cred?.siteUrl;

	const keywords = hasGsc ? await getWatchlistWithSeries(project.id, HISTORY_WEEKS) : [];

	return {
		project: { name: project.name, slug: project.slug, color: project.color },
		hasGsc,
		weekStart: latestCompleteWeekStart(),
		keywords,
		token
	};
};
