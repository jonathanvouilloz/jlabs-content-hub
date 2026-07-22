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
 * Le renouvellement de bail et la récupération des workers morts sont JOB-002 ;
 * la classification fine des erreurs est JOB-003. Ici : claim, complete, fail
 * (backoff/dead-letter via le module pur), release.
 *
 * Comparaison temporelle : les colonnes sont des `text` de formats potentiellement
 * mixtes (cf. `timestamps.ts`) → tout prédicat CAST en `timestamp`, jamais de
 * comparaison lexicale sur `available_at`.
 */
import { sql } from 'drizzle-orm';
import type { AppDb } from './db/types.js';
import { decideAfterFailure, computeLeaseUntil, DEFAULT_LEASE_MS } from './job-state.js';
import { toDbTimestamp } from './timestamps.js';

/** Le job tel que la réclamation le renvoie (colonnes utiles au worker). */
export interface ClaimedJob {
	id: string;
	projectId: string;
	runId: string | null;
	type: string;
	payloadJson: string | null;
	attempts: number;
	maxAttempts: number;
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
		           j.max_attempts, j.idempotency_key, j.lease_owner, j.lease_until
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

/**
 * Enregistre un échec : replanification avec backoff, ou dead-letter au plafond
 * de tentatives (décision prise par le module pur `decideAfterFailure`).
 * Renvoie la décision appliquée, ou `null` si le job n'appartient pas au worker.
 */
export async function failJob(input: {
	db: AppDb;
	job: Pick<ClaimedJob, 'id' | 'attempts' | 'maxAttempts'>;
	workerId: string;
	error: unknown;
	now?: Date | string;
}): Promise<{ status: 'queued' | 'dead'; backoffMs: number; availableAt: string } | null> {
	const now = input.now ?? new Date();
	const decision = decideAfterFailure({
		attempts: input.job.attempts,
		maxAttempts: input.job.maxAttempts,
		error: input.error,
		now
	});
	const nowDb = toDbTimestamp(now);

	const res = await input.db.execute(sql`
		UPDATE "seostats"."jobs"
		   SET status = ${decision.status},
		       available_at = ${decision.availableAt},
		       last_error_code = ${decision.errorCode},
		       last_error_message = ${decision.errorMessage},
		       lease_owner = NULL,
		       lease_until = NULL,
		       updated_at = ${nowDb},
		       finished_at = ${decision.status === 'dead' ? nowDb : null}
		 WHERE id = ${input.job.id} AND lease_owner = ${input.workerId} AND status = 'running'
		 RETURNING id
	`);
	if ((res.rows?.length ?? 0) === 0) return null;
	return {
		status: decision.status,
		backoffMs: decision.backoffMs,
		availableAt: decision.availableAt
	};
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
