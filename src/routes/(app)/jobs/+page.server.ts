import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { countJobs, countJobsByStatus, listJobs } from '$lib/server/jobs-claim.js';
import { describeDependencies, normalizeJobFilters } from '$lib/server/job-console.js';
import { parseDependencies } from '$lib/server/job-graph.js';
import { loadDependencyStatuses } from '$lib/server/jobs-graph.js';
import { listNextOccurrences } from '$lib/server/scheduler.js';
import { loadCapacitySnapshot } from '$lib/server/jobs-limits.js';
import { BUSINESS_TIMEZONE } from '$lib/server/schedule-state.js';
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

	const now = new Date();

	const [jobs, total, byStatus, types, schedule, capacity] = await Promise.all([
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
			.then((r) => ((r.rows ?? []) as unknown as { type: string }[]).map((x) => x.type)),
		// JOB-005 — la planification est CALCULÉE, pas stockée : cette liste ne peut
		// donc pas se désynchroniser de ce que le tick fera réellement.
		listNextOccurrences({ db, now }),
		// JOB-006 — la capacité est DÉRIVÉE (concurrence réelle + journal des quotas),
		// jamais lue dans un état persisté : elle ne peut donc pas se désynchroniser de
		// ce que la réclamation appliquera réellement. Le tour d'équité, lui, n'existe
		// que pendant un drain et n'a rien à montrer ici.
		loadCapacitySnapshot({ db, now })
	]);

	// JOB-004 — l'attente d'un job est DÉRIVÉE (arêtes + statut des prérequis), jamais
	// stockée. Sans ce calcul, un job que la garde de réclamation retient s'afficherait
	// « en file » comme les autres et ressemblerait à un job coincé : l'opérateur
	// relancerait le mauvais. Une seule requête, sur les seuls prérequis référencés.
	const depsByJob = new Map(jobs.map((j) => [j.id, parseDependencies(j.dependsOn)]));
	const prereqIds = [...new Set([...depsByJob.values()].flatMap((d) => d.map((x) => x.jobId)))];
	const prereqStatuses = await loadDependencyStatuses({ db, jobIds: prereqIds });
	const dependencies: Record<string, string | null> = {};
	for (const job of jobs) {
		dependencies[job.id] = describeDependencies({
			deps: depsByJob.get(job.id) ?? [],
			statuses: prereqStatuses,
			status: job.status
		}).label;
	}

	return {
		jobs,
		total,
		byStatus,
		types,
		filters,
		dependencies,
		capacity: {
			...capacity,
			// Même règle que la planification : redescendre sur un projet ne doit pas
			// laisser les six autres à l'écran.
			projects: filters.projectSlug
				? capacity.projects.filter((p) => p.projectSlug === filters.projectSlug)
				: capacity.projects
		},
		schedule: {
			timeZone: BUSINESS_TIMEZONE,
			// Le filtre projet de la page vaut aussi pour la planification : redescendre
			// sur un projet ne doit pas laisser les six autres à l'écran.
			rows: filters.projectSlug
				? schedule.filter((r) => r.projectSlug === filters.projectSlug)
				: schedule
		},
		// L'heure du serveur au format DB : les écarts (« disponible dans 4 min ») se
		// calculent contre elle, jamais contre l'horloge du navigateur.
		now: toDbTimestamp(now)
	};
};
