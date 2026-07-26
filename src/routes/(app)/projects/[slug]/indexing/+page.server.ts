import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { loadProjectIndexing } from '$lib/server/project-indexing.js';
import { normalizeIndexClass } from '$lib/server/project-indexing-state.js';

/**
 * DASH-003 lot 2 chantier 2 — `/projects/[slug]/indexing` (SPEC §13.2, onglet « Indexation »).
 *
 * L'écran qui manquait à quatre tickets E04 livrés : `IDX-001` (inventaire sitemap), `IDX-002`
 * (collecteur URL Inspection), `IDX-004` (sélection et quotas) et `IDX-005` (transitions)
 * écrivaient sans que personne ne lise. `loadInspectionFreshness` n'avait aucun appelant, et
 * `index_selection` n'était lu que par le collecteur qui l'écrit.
 *
 * Comme au lot 1, ce loader ne fait que **passer les paramètres d'URL** : tout le jugement vit
 * dans `project-indexing-state.ts` (pur, testé) et toute la lecture dans `project-indexing.ts`
 * (client injecté). Une valeur de `?class=` hors vocabulaire est ÉCARTÉE ici, jamais transmise à
 * une requête — même discipline que `normalizeProposalFilters` sur l'inbox.
 */
export const load: PageServerLoad = async ({ params, url }) => {
	const indexing = await loadProjectIndexing({
		db,
		projectSlug: params.slug,
		activeClass: normalizeIndexClass(url.searchParams.get('class')),
		focusUrl: url.searchParams.get('url')
	});
	if (!indexing) throw error(404, 'Projet introuvable');
	return { indexing };
};
