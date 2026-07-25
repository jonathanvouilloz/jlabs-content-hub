import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { loadProjectCockpit } from '$lib/server/project-cockpit.js';
import { normalizeWindowDays } from '$lib/server/home-state.js';

/**
 * DASH-003 — `/projects/[slug]` EST le cockpit projet (SPEC §13.2, onglet « Vue d'ensemble »).
 *
 * La page répond à « que se passe-t-il sur ce projet, et à quel point puis-je y croire » : la
 * santé aux DEUX axes (la même que l'accueil, jamais recalculée ici), un panneau par domaine
 * portant sa période / sa fraîcheur / sa source, et la timeline où les décisions passées se
 * relisent.
 *
 * Le calendrier de contenus qui occupait cette route vit désormais en `[slug]/content` —
 * déplacé tel quel, aucune route supprimée, comme DASH-002 l'a fait sur `/`.
 *
 * Tout le jugement vit dans `project-cockpit-state.ts` (pur, testé) et toute la lecture dans
 * `project-cockpit.ts` (client injecté) : ce loader ne fait que passer la fenêtre.
 */
export const load: PageServerLoad = async ({ params, url }) => {
	const windowDays = normalizeWindowDays(url.searchParams.get('days'));
	const cockpit = await loadProjectCockpit({ db, projectSlug: params.slug, windowDays });
	if (!cockpit) throw error(404, 'Projet introuvable');
	return { cockpit };
};
