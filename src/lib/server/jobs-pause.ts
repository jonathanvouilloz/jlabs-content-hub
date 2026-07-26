/**
 * DASH-006 lot 2 — Pauses : l'EXÉCUTION sur la file.
 *
 * Le jugement est dans `pause-state.ts` (pur) ; la planification, elle, s'arrête d'
 * elle-même (`planDueJobs` n'ouvre plus d'occurrence). Reste ce que ni l'un ni l'autre
 * ne peut faire : **conclure les jobs DÉJÀ EN FILE** au moment où la pause est posée.
 *
 * Pourquoi les conclure plutôt que les laisser dormir. Trois options existaient :
 *
 *   1. les laisser partir — « en pause » à l'écran ne voudrait alors rien dire en
 *      réalité, et un `collect:gsc_query_page` taperait l'API d'un provider qu'on vient
 *      de déclarer coupé ;
 *   2. les rendre non réclamables sans rien d'autre — ils resteraient `queued` À VIE,
 *      et leurs dépendants OBLIGATOIRES attendraient pour toujours un prérequis que
 *      personne ne prendra. C'est exactement le trou que JOB-004 a fermé ;
 *   3. les conclure en `skipped` avec trace — ce que fait cette passe.
 *
 * Le `skipped` n'est pas un choix esthétique : il est le statut que
 * `classifyDependencyGate` lit comme « prérequis mort ». La propagation aux dépendants
 * est donc GRATUITE et déjà prouvée — un prérequis obligatoire sauté fait sauter son
 * dépendant (run `partial`), un optionnel ne bloque personne. C'est littéralement
 * l'acceptation BACKLOG « la désactivation d'un provider n'annule pas les autres steps ».
 *
 * Modelée sur `settleBlockedJobs` (JOB-004), elle-même modelée sur le reaper : bornée,
 * rejouable, non bloquante, appelée au démarrage du worker puis à chaque tour à vide.
 *
 * Aucun état nouveau : ce qui est suspendu se DÉRIVE du journal, jamais d'une colonne
 * posée sur les jobs.
 */
import { sql } from 'drizzle-orm';
import { jobAttempts } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { log } from './log.js';
import { concludeJobStep } from './monitoring.js';
import { PAUSE_SKIP_ACTOR, PAUSE_SKIP_CODE, resolveJobPause, type PauseStates } from './pause-state.js';
import { loadPauseStates } from './pauses.js';
import { toDbTimestamp } from './timestamps.js';
import { createId } from './utils.js';

const logger = log('jobs-pause');

export { PAUSE_SKIP_ACTOR, PAUSE_SKIP_CODE };

/** Un job en file, avec la cadence du run qui l'a produit (null s'il n'en a pas). */
export interface PausableJobRow {
	id: string;
	projectId: string;
	type: string;
	runId: string | null;
	runType: string | null;
	attempts: number;
}

/**
 * Les jobs `queued`, joints au `run_type` de leur run.
 *
 * ⚠️ `LEFT JOIN` — un job SANS run (`post_publish:check`, relance manuelle) doit
 * ressortir avec `run_type = null` et non disparaître : il reste soumis aux pauses de
 * provider et de projet. Un `INNER JOIN` l'exempterait des trois d'un coup, et une pause
 * provider laisserait passer précisément les jobs les plus faciles à oublier.
 */
export async function listPausableJobs(input: {
	db: AppDb;
	limit?: number;
}): Promise<PausableJobRow[]> {
	const limit = Math.max(1, Math.floor(input.limit ?? 50));
	const res = await input.db.execute(sql`
		SELECT j.id, j.project_id, j.type, j.run_id, j.attempts, r.run_type
		  FROM "seostats"."jobs" j
		  LEFT JOIN "seostats"."monitoring_runs" r ON r.id = j.run_id
		 WHERE j.status = 'queued'
		 ORDER BY j.priority DESC, j.available_at ASC
		 LIMIT ${limit}
	`);

	return ((res.rows ?? []) as unknown as Array<{
		id: string;
		project_id: string;
		type: string;
		run_id: string | null;
		attempts: number;
		run_type: string | null;
	}>).map((r) => ({
		id: r.id,
		projectId: r.project_id,
		type: r.type,
		runId: r.run_id,
		runType: r.run_type,
		attempts: Number(r.attempts)
	}));
}

export interface PausedJob {
	jobId: string;
	type: string;
	reason: string;
	scope: string;
}

export interface SettlePausedResult {
	/** Jobs terminés en `skipped` par cette passe. */
	skipped: PausedJob[];
	/** Jobs examinés qu'aucune pause ne couvre. */
	untouched: number;
}

/**
 * Conclut les jobs en file couverts par une pause active.
 *
 * Chaque skip est écrit dans UNE transaction : le job passe `skipped` ET le journal
 * porte la décision, ou rien — même exigence que `skipOne` (JOB-004) et la ligne
 * `requeued` de JOB-003. Un job terminé sans trace serait un trou dans l'audit, et
 * l'auditabilité est précisément ce que ce lot promet.
 *
 * La garde `status = 'queued'` de l'UPDATE est le point sensible : entre la lecture et
 * l'écriture, un worker a pu réclamer le job. Course perdue = **no-op**, jamais
 * l'écrasement d'un job qui tourne — un job déjà parti finira son travail, et la pause
 * ne prendra effet qu'au suivant. C'est le bon sens de la borne : une pause arrête ce
 * qui n'a pas commencé, elle n'interrompt pas ce qui court.
 *
 * Rejouable : au second passage, le job n'est plus `queued` et rien n'est réécrit.
 */
export async function settlePausedJobs(input: {
	db: AppDb;
	limit?: number;
	now?: Date | string;
	/** États injectables (preuves), sinon lus en base — même porte que `planDueJobs`. */
	states?: PauseStates;
}): Promise<SettlePausedResult> {
	const now = input.now ?? new Date();
	const states = input.states ?? (await loadPauseStates(input.db, now));
	const result: SettlePausedResult = { skipped: [], untouched: 0 };

	// Rien de suspendu : on ne lit même pas la file. Le cas courant doit coûter zéro
	// requête, sinon la passe taxerait chaque tour à vide de tous les workers.
	if (states.size === 0) return result;

	const jobs = await listPausableJobs({ db: input.db, limit: input.limit });
	const nowDb = toDbTimestamp(typeof now === 'string' ? new Date(now) : now);

	for (const job of jobs) {
		const verdict = resolveJobPause({
			states,
			projectId: job.projectId,
			jobType: job.type,
			runType: job.runType
		});
		if (!verdict.paused || !verdict.reason) {
			result.untouched += 1;
			continue;
		}

		const applied = await skipOne({ db: input.db, job, reason: verdict.reason, nowDb });
		if (!applied) continue; // course perdue : le job a bougé, on ne le réécrit pas.

		result.skipped.push({
			jobId: job.id,
			type: job.type,
			reason: verdict.reason,
			scope: verdict.by?.target.scope ?? 'unknown'
		});

		// Le step est écrit HORS transaction, et volontairement : c'est la comptabilité
		// du run, elle ne doit pas pouvoir annuler le fait — le job, lui, est sauté.
		try {
			await concludeJobStep({
				db: input.db,
				runId: job.runId,
				stepType: job.type,
				attempt: job.attempts,
				status: 'skipped',
				errorCode: PAUSE_SKIP_CODE,
				errorMessage: verdict.reason
			});
		} catch (err) {
			logger.warn('conclusion du run échouée (le job, lui, est sauté)', {
				jobId: job.id,
				runId: job.runId,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	if (result.skipped.length > 0) {
		logger.warn('jobs sautés pour cause de pause', {
			skipped: result.skipped.length,
			types: result.skipped.map((s) => s.type)
		});
	}
	return result;
}

/** Le skip d'un job : statut terminal + ligne de journal, tout ou rien. */
async function skipOne(input: {
	db: AppDb;
	job: PausableJobRow;
	reason: string;
	nowDb: string;
}): Promise<boolean> {
	let applied = false;
	await input.db.transaction(async (tx) => {
		const res = await tx.execute(sql`
			UPDATE "seostats"."jobs"
			   SET status = 'skipped',
			       last_error_code = ${PAUSE_SKIP_CODE},
			       last_error_message = ${input.reason},
			       lease_owner = NULL,
			       lease_until = NULL,
			       finished_at = ${input.nowDb},
			       updated_at = ${input.nowDb}
			 WHERE id = ${input.job.id} AND status = 'queued'
			 RETURNING id
		`);
		if ((res.rows?.length ?? 0) === 0) return; // course perdue : rien fait, rien tracé.

		await tx.insert(jobAttempts).values({
			id: createId(),
			jobId: input.job.id,
			projectId: input.job.projectId,
			// Le compteur du job, INCHANGÉ : une pause ne consomme pas de tentative. Le job
			// n'a rien raté — on lui a retiré l'autorisation de partir. L'incrémenter le
			// rapprocherait de la dead-letter pour une décision humaine.
			attemptNo: input.job.attempts,
			workerId: PAUSE_SKIP_ACTOR,
			outcome: 'skipped',
			errorCode: PAUSE_SKIP_CODE,
			errorMessage: input.reason,
			metadataJson: JSON.stringify({ reason: input.reason, runType: input.job.runType }),
			startedAt: input.nowDb,
			finishedAt: input.nowDb
		});
		applied = true;
	});
	return applied;
}
