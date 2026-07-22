/**
 * JOB-001 — Réclamation atomique des jobs (SPEC §6.2).
 *
 * La table `jobs` et son index de réclamation `idx_jobs_claim` datent de DATA-003 ;
 * ici on pose la mécanique qui les consomme :
 *
 *   UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *
 *
 * C'est UNE seule instruction : la sélection, le verrou et la prise de bail sont
 * atomiques. `SKIP LOCKED` garantit les trois acceptations :
 *   1. deux workers ne peuvent jamais posséder le même job (le second saute la
 *      ligne verrouillée au lieu d'attendre) ;
 *   2. un arrêt gracieux relâche le job sans consommer de tentative (pas de fantôme) ;
 *   3. un job verrouillé ou non disponible NE BLOQUE PAS la file (les suivants
 *      restent réclamables).
 *
 * Le renouvellement de bail et la récupération des workers morts sont JOB-002.
 * Ici : claim, complete, fail, release — et, depuis JOB-003, les trois issues que
 * la classification de l'erreur rend possibles : `deferJob` (quota : la tentative
 * est rendue), la dead-letter (statut `dead`) et sa reprise `requeueDeadJob`.
 *
 * Comparaison temporelle : les colonnes sont des `text` de formats potentiellement
 * mixtes (cf. `timestamps.ts`) → tout prédicat CAST en `timestamp`, jamais de
 * comparaison lexicale sur `available_at`.
 */
import { sql } from 'drizzle-orm';
import { jobAttempts } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { computeLeaseUntil, DEFAULT_LEASE_MS } from './job-state.js';
import { decideRetry, type DeadReason, type ErrorClass, type RetryAction } from './job-retry.js';
import { createId } from './utils.js';
import { toDbTimestamp, toDbTimestampPlus } from './timestamps.js';

/** Le job tel que la réclamation le renvoie (colonnes utiles au worker). */
export interface ClaimedJob {
	id: string;
	projectId: string;
	runId: string | null;
	type: string;
	payloadJson: string | null;
	attempts: number;
	maxAttempts: number;
	/** JOB-003 — reports quota déjà subis (borne la boucle sur un provider saturé). */
	deferrals: number;
	idempotencyKey: string;
	leaseOwner: string;
	leaseUntil: string;
}

interface RawJobRow {
	id: string;
	project_id: string;
	run_id: string | null;
	type: string;
	payload_json: string | null;
	attempts: number;
	max_attempts: number;
	deferrals: number | null;
	idempotency_key: string;
	lease_owner: string;
	lease_until: string;
}

function toClaimedJob(r: RawJobRow): ClaimedJob {
	return {
		id: r.id,
		projectId: r.project_id,
		runId: r.run_id,
		type: r.type,
		payloadJson: r.payload_json,
		attempts: Number(r.attempts),
		maxAttempts: Number(r.max_attempts),
		deferrals: Number(r.deferrals ?? 0),
		idempotencyKey: r.idempotency_key,
		leaseOwner: r.lease_owner,
		leaseUntil: r.lease_until
	};
}

export interface ClaimJobInput {
	db: AppDb;
	/** Types que ce worker sait traiter ; vide = tous. */
	types?: string[];
	workerId: string;
	leaseMs?: number;
	/** Date de référence (tests/rejeu) ; par défaut l'horloge du serveur DB. */
	now?: Date | string;
}

/**
 * Réclame AU PLUS un job disponible, atomiquement. Renvoie `null` si la file n'a
 * rien de réclamable (aucun job `queued` disponible, ou tous déjà verrouillés).
 *
 * Ordre de service : priorité décroissante, puis ancienneté de disponibilité —
 * exactement l'ordre couvert par `idx_jobs_claim(status, available_at, priority)`.
 * `attempts` est incrémenté À LA RÉCLAMATION : une tentative commencée compte,
 * même si le worker meurt avant de la conclure.
 */
export async function claimJob(input: ClaimJobInput): Promise<ClaimedJob | null> {
	const now = toDbTimestamp(input.now ?? new Date());
	const leaseUntil = computeLeaseUntil({
		now: input.now ?? new Date(),
		leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS
	});
	const types = input.types ?? [];
	// Filtre de type PARAMÉTRÉ : un placeholder lié par valeur (`IN ($1, $2…)`),
	// jamais une concaténation de littéraux SQL. (Un `= ANY($n)` avec un tableau
	// lié ne convient pas : le driver sérialise le tableau élément par élément.)
	const typeFilter =
		types.length > 0
			? sql`AND c.type IN (${sql.join(
					types.map((t) => sql`${t}`),
					sql`, `
				)})`
			: sql``;

	const result = await input.db.execute(sql`
		UPDATE "seostats"."jobs" AS j
		   SET status = 'running',
		       lease_owner = ${input.workerId},
		       lease_until = ${leaseUntil},
		       heartbeat_at = ${now},
		       attempts = j.attempts + 1,
		       updated_at = ${now}
		 WHERE j.id = (
		       SELECT c.id
		         FROM "seostats"."jobs" AS c
		        WHERE c.status = 'queued'
		          AND c.available_at::timestamp <= ${now}::timestamp
		          ${typeFilter}
		        ORDER BY c.priority DESC, c.available_at ASC
		        FOR UPDATE SKIP LOCKED
		        LIMIT 1
		 )
		 RETURNING j.id, j.project_id, j.run_id, j.type, j.payload_json, j.attempts,
		           j.max_attempts, j.deferrals, j.idempotency_key, j.lease_owner, j.lease_until
	`);

	const rows = (result.rows ?? []) as unknown as RawJobRow[];
	return rows.length > 0 ? toClaimedJob(rows[0]) : null;
}

/** Marque un job terminé avec succès. Ne touche RIEN si le bail appartient à un autre worker. */
export async function completeJob(input: {
	db: AppDb;
	jobId: string;
	workerId: string;
	now?: Date | string;
}): Promise<boolean> {
	const now = toDbTimestamp(input.now ?? new Date());
	const res = await input.db.execute(sql`
		UPDATE "seostats"."jobs"
		   SET status = 'succeeded', finished_at = ${now}, updated_at = ${now},
		       lease_owner = NULL, lease_until = NULL
		 WHERE id = ${input.jobId} AND lease_owner = ${input.workerId} AND status = 'running'
		 RETURNING id
	`);
	return (res.rows?.length ?? 0) > 0;
}

/** Ce que `failJob` a effectivement appliqué (JOB-003 : la classe et la cause). */
export interface FailOutcome {
	/** `retry` = replanifié après backoff · `dead` = dead-letter. */
	action: Extract<RetryAction, 'retry' | 'dead'>;
	/** Statut écrit en base (conservé depuis JOB-001 : `queued` ou `dead`). */
	status: 'queued' | 'dead';
	errorClass: ErrorClass;
	errorCode: string;
	backoffMs: number;
	availableAt: string;
	deadReason: DeadReason | null;
}

/**
 * Enregistre un échec. Depuis JOB-003, la décision n'est plus uniforme : elle
 * dépend de la CLASSE de l'erreur (`decideRetry`) —
 *   retryable → replanifié avec backoff **jitté** ;
 *   auth / permanent → dead-letter **immédiat** (rejouer ne changerait rien) ;
 *   max_attempts atteint → dead-letter, comme avant.
 *
 * Le cas `quota` ne passe PAS par ici : il rend sa tentative (→ `deferJob`), c'est
 * l'appelant (`job-runner.ts`) qui route selon `decision.action`.
 *
 * `Math.random` est fourni ICI : le module de décision reste pur, seule cette
 * couche connaît le hasard. Renvoie `null` si le job n'appartient pas au worker.
 */
export async function failJob(input: {
	db: AppDb;
	job: Pick<ClaimedJob, 'id' | 'attempts' | 'maxAttempts'> & { deferrals?: number };
	workerId: string;
	error: unknown;
	now?: Date | string;
}): Promise<FailOutcome | null> {
	const now = input.now ?? new Date();
	const decision = decideRetry({
		attempts: input.job.attempts,
		maxAttempts: input.job.maxAttempts,
		deferrals: input.job.deferrals ?? 0,
		error: input.error,
		now,
		random: Math.random
	});
	const status = decision.action === 'dead' ? 'dead' : 'queued';
	const nowDb = toDbTimestamp(now);

	const res = await input.db.execute(sql`
		UPDATE "seostats"."jobs"
		   SET status = ${status},
		       available_at = ${decision.availableAt},
		       last_error_code = ${decision.errorCode},
		       last_error_message = ${decision.errorMessage},
		       last_error_class = ${decision.errorClass},
		       lease_owner = NULL,
		       lease_until = NULL,
		       updated_at = ${nowDb},
		       finished_at = ${status === 'dead' ? nowDb : null}
		 WHERE id = ${input.job.id} AND lease_owner = ${input.workerId} AND status = 'running'
		 RETURNING id
	`);
	if ((res.rows?.length ?? 0) === 0) return null;
	return {
		action: status === 'dead' ? 'dead' : 'retry',
		status,
		errorClass: decision.errorClass,
		errorCode: decision.errorCode,
		backoffMs: decision.delayMs,
		availableAt: decision.availableAt,
		deadReason: decision.deadReason
	};
}

/**
 * Reporte un job buté sur un QUOTA provider (429, quotaExceeded…).
 *
 * Ce n'est pas un échec du job : la tentative lui est RENDUE
 * (`attempts - 1`, comme `releaseJob`) et c'est `deferrals` — compteur distinct et
 * plafonné — qui borne la boucle. Sans cette asymétrie, une journée de saturation
 * provider enverrait en dead-letter des jobs parfaitement sains ; sans le plafond,
 * un provider définitivement fermé les ferait tourner sans fin.
 *
 * Gardé par `lease_owner`, comme toute mutation : on ne reporte jamais le job d'un autre.
 */
export async function deferJob(input: {
	db: AppDb;
	jobId: string;
	workerId: string;
	delayMs: number;
	errorCode: string;
	errorMessage: string;
	now?: Date | string;
}): Promise<{ availableAt: string; delayMs: number } | null> {
	const now = input.now ?? new Date();
	const nowDb = toDbTimestamp(now);
	const delayMs = Math.max(0, Math.round(input.delayMs));
	const availableAt = toDbTimestampPlus(delayMs, now);

	const res = await input.db.execute(sql`
		UPDATE "seostats"."jobs"
		   SET status = 'queued',
		       attempts = GREATEST(attempts - 1, 0),
		       deferrals = deferrals + 1,
		       available_at = ${availableAt},
		       last_error_code = ${input.errorCode},
		       last_error_message = ${input.errorMessage},
		       last_error_class = 'quota',
		       lease_owner = NULL,
		       lease_until = NULL,
		       updated_at = ${nowDb}
		 WHERE id = ${input.jobId} AND lease_owner = ${input.workerId} AND status = 'running'
		 RETURNING id
	`);
	if ((res.rows?.length ?? 0) === 0) return null;
	return { availableAt, delayMs };
}

/**
 * Relâche un job sans le compter comme un échec : arrêt gracieux du worker.
 * Le job redevient immédiatement réclamable.
 *
 * La tentative consommée à la réclamation est RENDUE (`attempts - 1`, plancher 0).
 * C'est l'asymétrie voulue : `attempts` s'incrémente au claim pour qu'un worker
 * qui MEURT en cours de route consomme quand même sa tentative (sans quoi un job
 * qui tue ses workers boucle à l'infini) ; mais un arrêt gracieux sait que rien
 * n'a été exécuté, et rend la tentative. Sans ça, redémarrer un worker deux fois
 * suffirait à envoyer un job sain en dead-letter.
 */
export async function releaseJob(input: {
	db: AppDb;
	jobId: string;
	workerId: string;
	now?: Date | string;
}): Promise<boolean> {
	const now = toDbTimestamp(input.now ?? new Date());
	const res = await input.db.execute(sql`
		UPDATE "seostats"."jobs"
		   SET status = 'queued',
		       attempts = GREATEST(attempts - 1, 0),
		       lease_owner = NULL,
		       lease_until = NULL,
		       updated_at = ${now}
		 WHERE id = ${input.jobId} AND lease_owner = ${input.workerId} AND status = 'running'
		 RETURNING id
	`);
	return (res.rows?.length ?? 0) > 0;
}

// ── Dead-letter (JOB-003) ───────────────────────────────────────────

export interface DeadJob {
	id: string;
	projectId: string;
	projectSlug: string;
	type: string;
	attempts: number;
	maxAttempts: number;
	deferrals: number;
	requeuedCount: number;
	errorClass: string | null;
	errorCode: string | null;
	errorMessage: string | null;
	finishedAt: string | null;
}

/**
 * Les jobs morts, du plus récent au plus ancien. Consomme l'index partiel
 * `idx_jobs_dead` (posé par JOB-003) → jamais de scan de toute la file.
 * Lecture seule : c'est la donnée que la console d'exploitation (JOB-007) rendra.
 */
export async function listDeadJobs(input: {
	db: AppDb;
	projectSlug?: string;
	errorClasses?: string[];
	limit?: number;
}): Promise<DeadJob[]> {
	const limit = Math.max(1, Math.floor(input.limit ?? 20));
	const projectFilter = input.projectSlug ? sql`AND p.slug = ${input.projectSlug}` : sql``;
	// Filtre PARAMÉTRÉ en `IN (…)` : `= ANY($n)` casse avec le driver Neon (le
	// tableau lié est sérialisé élément par élément → `malformed array literal`).
	const classFilter =
		input.errorClasses && input.errorClasses.length > 0
			? sql`AND j.last_error_class IN (${sql.join(
					input.errorClasses.map((c) => sql`${c}`),
					sql`, `
				)})`
			: sql``;

	const res = await input.db.execute(sql`
		SELECT j.id, j.project_id, p.slug, j.type, j.attempts, j.max_attempts, j.deferrals,
		       j.requeued_count, j.last_error_class, j.last_error_code, j.last_error_message,
		       j.finished_at
		  FROM "seostats"."jobs" AS j
		  JOIN "seostats"."projects" AS p ON p.id = j.project_id
		 WHERE j.status = 'dead' ${projectFilter} ${classFilter}
		 ORDER BY j.finished_at DESC NULLS LAST
		 LIMIT ${limit}
	`);

	interface Row {
		id: string;
		project_id: string;
		slug: string;
		type: string;
		attempts: number;
		max_attempts: number;
		deferrals: number | null;
		requeued_count: number | null;
		last_error_class: string | null;
		last_error_code: string | null;
		last_error_message: string | null;
		finished_at: string | null;
	}

	return ((res.rows ?? []) as unknown as Row[]).map((r) => ({
		id: r.id,
		projectId: r.project_id,
		projectSlug: r.slug,
		type: r.type,
		attempts: Number(r.attempts),
		maxAttempts: Number(r.max_attempts),
		deferrals: Number(r.deferrals ?? 0),
		requeuedCount: Number(r.requeued_count ?? 0),
		errorClass: r.last_error_class,
		errorCode: r.last_error_code,
		errorMessage: r.last_error_message,
		finishedAt: r.finished_at
	}));
}

export interface RequeueResult {
	jobId: string;
	type: string;
	/** Tentatives consommées avant la reprise — l'historique complet reste dans `job_attempts`. */
	previousAttempts: number;
	previousErrorClass: string | null;
	requeuedCount: number;
	attemptId: string;
}

/**
 * Relance un job depuis la dead-letter (action de reprise, BACKLOG JOB-003).
 *
 * Le compteur `attempts` est REMIS À ZÉRO : sans ça, un job repris à 5/5 repartirait
 * en dead-letter au premier échec, et la reprise ne serait qu'un geste. L'acceptation
 * « une reprise manuelle conserve l'historique des tentatives » est tenue par le
 * JOURNAL, pas par le compteur : `job_attempts` est append-only, aucune ligne n'est
 * touchée, et la reprise elle-même y écrit une ligne `requeued` (qui, quand, pourquoi).
 *
 * L'écriture est TRANSACTIONNELLE : soit le job repart ET la reprise est tracée, soit
 * rien — un job relancé sans trace serait un trou dans l'audit.
 */
export async function requeueDeadJob(input: {
	db: AppDb;
	jobId: string;
	/** Qui relance (`user:contact@jonlabs.ch`, `cron:…`) — jamais anonyme. */
	actor: string;
	reason?: string;
	now?: Date | string;
}): Promise<RequeueResult | null> {
	const now = input.now ?? new Date();
	const nowDb = toDbTimestamp(now);
	let result: RequeueResult | null = null;

	await input.db.transaction(async (tx) => {
		// Garde : seuls un job MORT (ou `failed`, statut du vocabulaire jamais écrit
		// aujourd'hui) se reprennent. On ne réveille jamais un job vivant.
		const res = await tx.execute(sql`
			UPDATE "seostats"."jobs"
			   SET status = 'queued',
			       attempts = 0,
			       deferrals = 0,
			       available_at = ${nowDb},
			       requeued_count = requeued_count + 1,
			       last_error_code = NULL,
			       last_error_message = NULL,
			       last_error_class = NULL,
			       lease_owner = NULL,
			       lease_until = NULL,
			       finished_at = NULL,
			       updated_at = ${nowDb}
			 WHERE id = ${input.jobId} AND status IN ('dead', 'failed')
			 RETURNING id, project_id, type, requeued_count
		`);
		const row = (res.rows ?? [])[0] as unknown as
			| { id: string; project_id: string; type: string; requeued_count: number }
			| undefined;
		if (!row) return; // pas mort (ou inexistant) : rien fait, rien tracé.

		// L'état d'AVANT, lu dans le journal : `jobs` vient d'être remis à neuf.
		const prev = await tx.execute(sql`
			SELECT attempt_no, error_class
			  FROM "seostats"."job_attempts"
			 WHERE job_id = ${input.jobId}
			 ORDER BY started_at DESC, attempt_no DESC
			 LIMIT 1
		`);
		const prevRow = (prev.rows ?? [])[0] as unknown as
			| { attempt_no: number; error_class: string | null }
			| undefined;
		const previousAttempts = Number(prevRow?.attempt_no ?? 0);

		const attemptId = createId();
		await tx.insert(jobAttempts).values({
			id: attemptId,
			jobId: input.jobId,
			projectId: row.project_id,
			attemptNo: previousAttempts,
			workerId: input.actor,
			outcome: 'requeued',
			errorClass: prevRow?.error_class ?? null,
			metadataJson: JSON.stringify({ reason: input.reason ?? null, requeuedFrom: 'dead_letter' }),
			startedAt: nowDb,
			finishedAt: nowDb,
			durationMs: 0
		});

		result = {
			jobId: row.id,
			type: row.type,
			previousAttempts,
			previousErrorClass: prevRow?.error_class ?? null,
			requeuedCount: Number(row.requeued_count),
			attemptId
		};
	});

	return result;
}
