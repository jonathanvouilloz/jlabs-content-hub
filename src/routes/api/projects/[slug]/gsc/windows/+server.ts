import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/index.js';
import { projects } from '$lib/server/db/schema.js';
import { validateApiKey } from '$lib/server/api-auth.js';
import { loadGscWindows } from '$lib/server/gsc-windows.js';
import type { RequestHandler } from './$types';

/**
 * GSC-004 — Fenêtres de comparaison 7/28/90 j (+ gate année N-1) d'un projet.
 *
 * Lit le CANON observations (même source que le détecteur). Chaque delta est déjà
 * gardé par la comparabilité côté serveur : une fenêtre trop courte rend
 * `delta.available=false`, jamais un chiffre trompeur. Auth identique aux autres
 * routes `gsc/*` : session admin OU clé API.
 */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user && !validateApiKey(event)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const project = await db.query.projects.findFirst({
		where: eq(projects.slug, event.params.slug)
	});
	if (!project) return json({ error: 'Project not found' }, { status: 404 });

	const report = await loadGscWindows({ db, projectId: project.id });
	return json(report);
};
