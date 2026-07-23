import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db/index.js';
import { planDueJobs } from '$lib/server/scheduler.js';
import { runWorker } from '$lib/server/job-runner.js';
import { deriveWorkerId } from '$lib/server/job-state.js';
import { log } from '$lib/server/log.js';
import type { RequestHandler } from './$types';

/**
 * JOB-005 — Le battement du cockpit : planifier, puis drainer.
 *
 * Cron horaire (`0 * * * *`, UTC). Deux gestes dans la même invocation, et dans cet
 * ordre : (1) mettre en file les occurrences dues en heure métier `Europe/Zurich`,
 * (2) exécuter ce qui est réclamable — y compris ce qu'un humain a relancé depuis
 * `/jobs`, ce qu'un backoff a reporté, et ce qu'un worker mort a laissé en plan.
 *
 * Pourquoi les deux ensemble : sur Vercel aucun processus ne survit à une requête.
 * Un scheduler seul remplirait une file que personne ne viendrait vider — c'est
 * exactement la situation d'avant JOB-005, avec en plus l'illusion que ça tourne.
 *
 * Pourquoi un tick horaire plutôt qu'un cron calé sur 09:00 : les crons Vercel sont
 * en UTC et sans notion de fuseau. Un créneau métier fixe demanderait deux entrées
 * saisonnières à permuter deux fois l'an à la main. Ici le cron n'a plus de sémantique
 * métier — il bat, et c'est `schedule-state.ts` qui sait quelle heure il est à Zurich.
 *
 * Deux invocations concurrentes sont inoffensives : la planification est idempotente
 * (clé du créneau LOCAL) et la réclamation est atomique (`FOR UPDATE SKIP LOCKED`).
 */

/** Plafond de la fonction Vercel. Le worker s'arrête AVANT, de lui-même. */
export const config = { maxDuration: 300 };

/**
 * Budget du drain : la marge sous `maxDuration` couvre la planification, la
 * sérialisation de la réponse et le job en cours au moment de l'ordre d'arrêt.
 * Dépasser ferait tuer la fonction en plein vol — et un `SIGKILL` de plateforme ne
 * repasse par aucun `finally` : le job resterait `running` jusqu'au reaper.
 */
const DRAIN_BUDGET_MS = 240_000;

/** Jobs traités au plus par tick. Le reste attend le tick suivant, dans l'ordre de priorité. */
const MAX_JOBS_PER_TICK = 25;

const logger = log('cron:tick');

export const GET: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('authorization');
	if (!env.CRON_SECRET || authHeader !== `Bearer ${env.CRON_SECRET}`) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const startedAt = Date.now();
	const now = new Date(startedAt);

	// 1. Planifier. Une erreur ici ne doit pas empêcher le drain : la file peut
	// contenir des jobs relancés à la main qui n'attendent rien du scheduler.
	let plan;
	let planError: string | null = null;
	try {
		plan = await planDueJobs({ db, now });
	} catch (err) {
		planError = err instanceof Error ? err.message : String(err);
		logger.error('planification échouée (le drain continue)', { error: planError });
	}

	// 2. Drainer. `once` s'arrête au premier tour à vide ; l'`AbortController` rend
	// la main avant le plafond de la fonction, via l'arrêt gracieux de JOB-001 (le
	// job en cours va à son terme, aucun `running` orphelin n'est laissé derrière).
	const controller = new AbortController();
	const budget = setTimeout(() => controller.abort(), DRAIN_BUDGET_MS);

	let stats;
	let drainError: string | null = null;
	try {
		stats = await runWorker({
			db,
			workerId: deriveWorkerId({
				host: `vercel-${env.VERCEL_REGION ?? 'local'}`,
				pid: process.pid,
				nonce: startedAt.toString(36).slice(-6)
			}),
			once: true,
			maxJobs: MAX_JOBS_PER_TICK,
			signal: controller.signal
		});
	} catch (err) {
		drainError = err instanceof Error ? err.message : String(err);
		logger.error('drain échoué', { error: drainError });
	} finally {
		clearTimeout(budget);
	}

	const body = {
		ok: !planError && !drainError,
		durationMs: Date.now() - startedAt,
		schedule: plan
			? {
					timeZone: plan.timeZone,
					window: { since: plan.sinceDb, until: plan.nowDb },
					projects: plan.projects,
					...plan.counters,
					cadencesWithoutJob: plan.cadencesWithoutJob,
					planned: plan.occurrences.map((o) => ({
						project: o.projectSlug,
						cadence: o.cadence,
						slot: o.localSlot,
						jobs: o.jobs.map((j) => `${j.jobType}${j.created ? '' : ' (déjà en file)'}`),
						...(o.adjusted ? { adjusted: true } : {}),
						...(o.ambiguous ? { ambiguous: true } : {})
					})),
					failures: plan.failures
				}
			: { error: planError },
		drain: stats
			? {
					claimed: stats.claimed,
					succeeded: stats.succeeded,
					failed: stats.failed,
					deferred: stats.deferred,
					// JOB-004 — jobs conclus sans avoir tourné, faute d'un prérequis
					// obligatoire. Ni des échecs, ni des réussites : leur propre colonne.
					skipped: stats.skipped,
					deadLettered: stats.deadLettered,
					released: stats.released,
					reclaimed: stats.reclaimed,
					stoppedGracefully: stats.stoppedGracefully,
					failedByClass: stats.failedByClass,
					// JOB-006 — ce que la capacité a retenu. `throttledTicks` est la seule
					// chose qui distingue « la file était vide » de « on n'avait pas le
					// droit de prendre » : sans lui, un tick bridé se lit comme un tick
					// tranquille, et personne ne va voir les plafonds.
					throttledTicks: stats.throttledTicks,
					heldByReason: stats.heldByReason,
					quotaPushed: stats.quotaPushed,
					laps: stats.laps
				}
			: { error: drainError }
	};

	logger.info('tick terminé', {
		durationMs: body.durationMs,
		throttledTicks: stats?.throttledTicks ?? 0,
		quotaPushed: stats?.quotaPushed ?? 0,
		occurrences: plan?.counters.occurrences ?? 0,
		jobsCreated: plan?.counters.jobsCreated ?? 0,
		claimed: stats?.claimed ?? 0,
		succeeded: stats?.succeeded ?? 0
	});

	// 500 si l'une des deux moitiés est tombée : un cron qui répond 200 en toute
	// circonstance ne remonte jamais dans les alertes de la plateforme.
	return json(body, { status: body.ok ? 200 : 500 });
};
