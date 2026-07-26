import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { loadAutomations } from '$lib/server/automations.js';
import { normalizeAutomationFilters } from '$lib/server/automations-state.js';
import { eq } from 'drizzle-orm';
import { projects } from '$lib/server/db/schema.js';

/**
 * DASH-006 — Vue automatisations (SPEC §13.4).
 *
 * Cross-projet, comme `/jobs` : quand une automatisation s'est arrêtée, on ne
 * sait pas encore laquelle — c'est ce qu'on vient chercher. Le filtre projet
 * permet de redescendre ensuite.
 *
 * Tout ce qui vient de l'URL passe par `normalizeAutomationFilters` AVANT
 * d'atteindre une requête : un statut inventé est écarté, jamais transmis.
 */
export const load: PageServerLoad = async ({ url }) => {
	const filters = normalizeAutomationFilters({
		project: url.searchParams.get('project'),
		status: url.searchParams.get('status'),
		since: url.searchParams.get('since'),
		cadence: url.searchParams.get('cadence'),
		limit: url.searchParams.get('limit'),
		offset: url.searchParams.get('offset')
	});

	const [view, projectList] = await Promise.all([
		loadAutomations({ db, filters }),
		db
			.select({ slug: projects.slug, name: projects.name })
			.from(projects)
			.where(eq(projects.archived, false))
			.orderBy(projects.slug)
	]);

	return { ...view, filters, projectList };
};
