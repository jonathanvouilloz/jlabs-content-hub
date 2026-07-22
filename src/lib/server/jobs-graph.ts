/**
 * JOB-004 — Dépendances entre jobs : l'EXÉCUTION.
 *
 * Le jugement est dans `job-graph.ts` (pur) ; la garde à la porte est dans la
 * réclamation elle-même (`DEPENDENCY_GATE`, `jobs-claim.ts`). Reste ce que ni l'un ni
 * l'autre ne peut faire : **conclure** les jobs qu'aucun prérequis ne débloquera
 * jamais. Sans cette passe, un dépendant dont le prérequis est mort resterait `queued`
 * à vie — invisible, non réclamable, et son run éternellement inachevé.
 *
 * Modelée sur le REAPER (`reclaimExpiredLeases`) : bornée, rejouable, et appelée par
 * le worker au démarrage puis à chaque tour à vide. La file se répare donc elle-même,
 * sans infrastructure nouvelle — sur Vercel, c'est le tick horaire qui la porte.
 *
 * Aucun état nouveau n'est persisté : l'attente d'un job est DÉRIVÉE de `depends_on`
 * et du statut de ses prérequis, jamais stockée. Même raison qu'au « zéro table de
 * planification » de JOB-005 : deux états qui peuvent diverger valent moins qu'un seul
 * qui se recalcule.
 */
import { sql } from 'drizzle-orm';
import { jobAttempts } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { log } from './log.js';
import {
	classifyDependencyGate,
	parseDependencies,
	type DependencyStatuses,
	type JobDependency
} from './job-graph.js';
import { concludeJobStep } from './monitoring.js';
import { toDbTimestamp } from './timestamps.js';
import { createId } from './utils.js';

const logger = log('jobs-graph');

/** Auteur des lignes de journal écrites par la passe. Jamais un humain, jamais anonyme. */
export const DEPENDENCY_ACTOR = 'system:dependency';

/** Cause portée par `jobs.last_error_code` d'un job sauté (filtrable dans la console). */
export const DEPENDENCY_SKIP_CODE = 'DependencySkipped';

/** Un job en file qui déclare au moins une arête. */
export interface BlockedJobRow {
	id: string;
	projectId: string;
	type: string;
	runId: string | null;
	attempts: number;
	deps: JobDependency[];
}

/**
 * Les jobs `queued` porteurs d'arêtes, et le statut de chacun de leurs prérequis.
 *
 * Deux requêtes plutôt qu'une jointure sur `jsonb_array_elements` : la file réelle
 * tient en quelques dizaines de lignes, et le JSON se lit ici avec la tolérance de
 * `parseDependencies` (qui ne lève jamais) plutôt qu'avec un cast SQL qui, lui, ferait
 * échouer toute la requête sur une seule valeur malformée.
 */
export async function listBlockedJobs(input: {
	db: AppDb;
	limit?: number;
}): Promise<{ jobs: BlockedJobRow[]; statuses: DependencyStatuses }> {
	const limit = Math.max(1, Math.floor(input.limit ?? 50));
	const res = await input.db.execute(sql`
		SELECT id, project_id, type, run_id, attempts, depends_on
		  FROM "seostats"."jobs"
		 WHERE status = 'queued' AND depends_on IS NOT NULL
		 ORDER BY priority DESC, available_at ASC
		 LIMIT ${limit}
	`);

	const jobs: BlockedJobRow[] = ((res.rows ?? []) as unknown as Array<{
		id: string;
		project_id: string;
		type: string;
		run_id: string | null;
		attempts: number;
		depends_on: string | null;
	}>).map((r) => ({
		id: r.id,
		projectId: r.project_id,
		type: r.type,
		runId: r.run_id,
		attempts: Number(r.attempts),
		deps: parseDependencies(r.depends_on)
	}));

	const prereqIds = [...new Set(jobs.flatMap((j) => j.deps.map((d) => d.jobId)))];
	return { jobs, statuses: await loadDependencyStatuses({ db: input.db, jobIds: prereqIds }) };
}

/**
 * Statut de chaque prérequis, par id. Une clé ABSENTE du résultat signifie « ligne
 * introuvable », et `classifyDependencyGate` la traite comme terminale non aboutie :
 * un prérequis purgé ne reviendra jamais, l'attendre serait attendre pour toujours.
 */
export async function loadDependencyStatuses(input: {
	db: AppDb;
	jobIds: string[];
}): Promise<DependencyStatuses> {
	if (input.jobIds.length === 0) return {};
	const res = await input.db.execute(sql`
		SELECT id, status
		  FROM "seostats"."jobs"
		 WHERE id IN (${sql.join(
				input.jobIds.map((id) => sql`${id}`),
				sql`, `
			)})
	`);
	const out: DependencyStatuses = {};
	for (const row of (res.rows ?? []) as unknown as Array<{ id: string; status: string }>) {
		out[row.id] = row.status;
	}
	return out;
}

export interface SkippedJob {
	jobId: string;
	type: string;
	reason: string;
	failedRequired: string[];
}

export interface SettleResult {
	/** Jobs terminés en `skipped` par cette passe. */
	skipped: SkippedJob[];
	/** Jobs qui attendent encore un prérequis vivant (ils repasseront). */
	waiting: number;
	/** Jobs dont les prérequis sont satisfaits : la garde de réclamation les laisse passer. */
	ready: number;
}

/**
 * Termine les jobs qu'aucun prérequis ne débloquera plus.
 *
 * Chaque skip est écrit dans UNE transaction : le job passe `skipped` ET le journal
 * porte la décision, ou rien. Un job terminé sans trace serait un trou dans l'audit —
 * même exigence que la ligne `requeued` de JOB-003 et l'annulation de JOB-007.
 *
 * La garde `status = 'queued'` de l'UPDATE est le point sensible : entre la lecture et
 * l'écriture, un worker a pu réclamer le job (la garde SQL de `claimJob` ne bloque que
 * les prérequis OBLIGATOIRES non aboutis, mais un jugement peut avoir changé entre les
 * deux). Course perdue = **no-op**, jamais l'écrasement d'un job qui tourne.
 *
 * Rejouable : au second passage, le job n'est plus `queued`, la garde ne matche plus,
 * et ni ligne de journal ni step ne sont réécrits.
 */
export async function settleBlockedJobs(input: {
	db: AppDb;
	limit?: number;
	now?: Date | string;
}): Promise<SettleResult> {
	const { jobs, statuses } = await listBlockedJobs({ db: input.db, limit: input.limit });
	const result: SettleResult = { skipped: [], waiting: 0, ready: 0 };
	const nowDb = toDbTimestamp(input.now ?? new Date());

	for (const job of jobs) {
		const gate = classifyDependencyGate({ deps: job.deps, statuses });
		if (gate.action === 'wait') {
			result.waiting += 1;
			continue;
		}
		if (gate.action === 'ready') {
			result.ready += 1;
			continue;
		}

		const reason = gate.reason ?? 'Prérequis obligatoire non abouti.';
		const applied = await skipOne({ db: input.db, job, reason, nowDb });
		if (!applied) continue; // course perdue : le job a bougé, on ne le réécrit pas.

		result.skipped.push({
			jobId: job.id,
			type: job.type,
			reason,
			failedRequired: gate.failedRequired
		});

		// Le step est écrit HORS transaction, et volontairement : c'est la comptabilité
		// du run, elle ne doit pas pouvoir annuler le fait — le job, lui, est sauté.
		// Un `attempt` de 0 : rien n'a été tenté (cf. `concludeJobStep`).
		try {
			await concludeJobStep({
				db: input.db,
				runId: job.runId,
				stepType: job.type,
				attempt: job.attempts,
				status: 'skipped',
				errorCode: DEPENDENCY_SKIP_CODE,
				errorMessage: reason
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
		logger.warn('jobs sautés faute de prérequis', {
			skipped: result.skipped.length,
			waiting: result.waiting,
			types: result.skipped.map((s) => s.type)
		});
	}
	return result;
}

/** Le skip d'un job : statut terminal + ligne de journal, tout ou rien. */
async function skipOne(input: {
	db: AppDb;
	job: BlockedJobRow;
	reason: string;
	nowDb: string;
}): Promise<boolean> {
	let applied = false;
	await input.db.transaction(async (tx) => {
		const res = await tx.execute(sql`
			UPDATE "seostats"."jobs"
			   SET status = 'skipped',
			       last_error_code = ${DEPENDENCY_SKIP_CODE},
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
			// Le compteur du job, INCHANGÉ : un skip ne consomme pas de tentative,
			// puisqu'il n'y en a pas eu. Vaut 0 dans le cas courant.
			attemptNo: input.job.attempts,
			workerId: DEPENDENCY_ACTOR,
			outcome: 'skipped',
			errorCode: DEPENDENCY_SKIP_CODE,
			errorMessage: input.reason,
			metadataJson: JSON.stringify({
				reason: input.reason,
				dependsOn: input.job.deps.map((d) => ({
					jobId: d.jobId,
					jobType: d.jobType,
					required: d.required
				}))
			}),
			startedAt: input.nowDb,
			finishedAt: input.nowDb
		});
		applied = true;
	});
	return applied;
}
