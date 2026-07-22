import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { countJobs, countJobsByStatus, listJobs } from '$lib/server/jobs-claim.js';
import { normalizeJobFilters } from '$lib/server/job-console.js';
import { toDbTimestamp } from '$lib/server/timestamps.js';
import { sql } from 'drizzle-orm';

/**
 * JOB-007 — La file, vue d'exploitation (cross-projet).
 *
 * Cross-projet et non par projet : quand la file est malade, on ne sait pas encore
 * quel projet est en cause — c'est justement ce qu'on vient chercher. Le filtre
 * projet reste disponible pour redescendre ensuite.
 *
 * Tout ce qui vient de l'URL passe par `normalizeJobFilters` AVANT d'atteindre une
 * requête : un statut inventé est écarté, jamais transmis.
 */
export const load: PageServerLoad = async ({ url }) => {
	const filters = normalizeJobFilters({
		status: url.searchParams.get('status'),
		class: url.searchParams.get('class'),
		project: url.searchParams.get('project'),
		type: url.searchParams.get('type'),
		limit: url.searchParams.get('limit'),
		offset: url.searchParams.get('offset')
	});

	const query = {
		db,
		statuses: filters.statuses,
		errorClasses: filters.errorClasses,
		projectSlug: filters.projectSlug,
		type: filters.type
	};

	const [jobs, total, byStatus, types] = await Promise.all([
		listJobs({ ...query, limit: filters.limit, offset: filters.offset }),
		countJobs(query),
		// Les compteurs d'en-tête ignorent les filtres de statut/classe (ils SONT le
		// filtre) mais respectent le projet : sinon cliquer « dead » afficherait
		// « 0 queued » et laisserait croire que la file est vide.
		countJobsByStatus({ db, projectSlug: filters.projectSlug }),
		db
			.execute(
				sql`SELECT DISTINCT type FROM "seostats"."jobs" ORDER BY type`
			)
			.then((r) => ((r.rows ?? []) as unknown as { type: string }[]).map((x) => x.type))
	]);

	return {
		jobs,
		total,
		byStatus,
		types,
		filters,
		// L'heure du serveur au format DB : les écarts (« disponible dans 4 min ») se
		// calculent contre elle, jamais contre l'horloge du navigateur.
		now: toDbTimestamp(new Date())
	};
};
