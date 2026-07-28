/**
 * GMB-002 — Rattrapage MANUEL de la synchronisation des avis.
 *
 * ⚠️ CETTE ROUTE N'EST PLUS PLANIFIÉE. Elle a été retirée de `vercel.json` : la collecte
 * nominale passe par le job `collect:gmb_reviews`, au catalogue quotidien, drainé par le
 * tick. Précédent exact : `/api/cron/gsc-snapshot`, dépubliée pour la même raison — deux
 * chemins de collecte sur un même compte consommeraient deux fois le quota pour la même
 * donnée. Ici s'y ajoute pire : le hub n'a qu'UNE ligne de credential Google
 * (`gmb_settings.account_tokens`) et `refreshAccountToken` la réécrit sans verrou, donc deux
 * chemins concurrents font une course en écriture dont le perdant garde un jeton invalidé.
 *
 * **Ne pas la replanifier.** Elle sert au rattrapage à la main, quand on veut forcer une
 * synchro sans attendre le créneau quotidien.
 *
 * Ce qu'elle n'est plus : un compteur d'erreurs anonyme. L'ancien `catch {}` sans binding
 * ne loggait rien, n'écrivait rien et ne notifiait rien — un projet pouvait échouer soixante
 * jours d'affilée sans laisser de trace (mesuré : `physiopommier` sans écriture depuis avril,
 * `bisrepetita` depuis mai, sans qu'on puisse distinguer le calme de la panne). La réponse
 * porte maintenant le détail PAR ÉTABLISSEMENT, et l'issue de chacun est écrite dans
 * `project_gmb_locations.last_sync_*`.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db/index.js';
import { projectGmbLocations, projects } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { collectGmbReviews } from '$lib/server/collectors/gmb-reviews.js';
import { gmbReviewDeps } from '$lib/server/gmb-auth.js';
import { formatSyncError } from '$lib/server/collectors/gmb-reviews-state.js';
import type { AppDb } from '$lib/server/db/types.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('authorization');
	if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Les projets ARCHIVÉS sont exclus — l'ancien `selectDistinct` ne filtrait rien et
	// dépensait du quota Google pour des clients partis.
	const rows = await db
		.selectDistinct({ projectId: projectGmbLocations.projectId, slug: projects.slug })
		.from(projectGmbLocations)
		.innerJoin(projects, eq(projects.id, projectGmbLocations.projectId))
		.where(eq(projects.archived, false));

	// UN SEUL collecteur, appelé par les deux chemins. Deux implémentations de la collecte
	// divergeraient exactement là où ça coûte cher — c'est le reproche fait au doublon
	// `gsc-snapshot`, et il vaut aussi entre une route et un handler de job.
	const deps = gmbReviewDeps(db as unknown as AppDb);
	const results: Array<Record<string, unknown>> = [];
	let totalSynced = 0;
	let failedProjects = 0;

	for (const { projectId, slug } of rows) {
		try {
			const res = await collectGmbReviews({
				projectId,
				deps,
				client: db as unknown as AppDb
			});
			totalSynced += res.summary.inserted;
			results.push({
				project: slug,
				skippedReason: res.skippedReason,
				locations: res.locations.map((l) => ({
					locationId: l.locationId,
					label: l.locationLabel,
					status: l.status,
					seen: l.seen,
					inserted: l.inserted,
					updated: l.updated,
					unchanged: l.unchanged,
					unreadable: l.unreadable,
					truncated: l.truncated,
					error: l.error
				})),
				draftsInvalidated: res.draftsInvalidated
			});
		} catch (err) {
			// Un projet en panne totale ne fait plus qu'incrémenter un compteur muet : il dit
			// QUI a échoué et POURQUOI. Les autres projets continuent — l'isolation par projet
			// de SPEC §9.6 vaut aussi à cet étage.
			failedProjects += 1;
			results.push({ project: slug, error: formatSyncError(err) });
		}
	}

	return json({
		projects: rows.length,
		synced: totalSynced,
		failedProjects,
		results,
		note: 'route de rattrapage manuel — la collecte nominale passe par collect:gmb_reviews (tick)'
	});
};
