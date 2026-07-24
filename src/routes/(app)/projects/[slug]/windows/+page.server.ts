import { db } from '$lib/server/db/index.js';
import { loadGscWindows } from '$lib/server/gsc-windows.js';
import type { PageServerLoad } from './$types.js';

/**
 * GSC-004 — Panneau des fenêtres de comparaison (7/28/90 j) d'un projet.
 *
 * Le calcul (découpe, delta gardé par comparabilité, complétude dérivée) vit
 * entièrement côté serveur dans `loadGscWindows` ; la page ne fait que rendre.
 */
export const load: PageServerLoad = async ({ parent }) => {
	const { project } = await parent();
	const report = await loadGscWindows({ db, projectId: project.id });
	return { report };
};
