/**
 * JOB-002 — Bail vivant, récupération après crash, journal des tentatives et
 * exactly-once des effets externes (SPEC §6.2).
 *
 * JOB-001 (`jobs-claim.ts`, inchangé) sait réclamer, clore, échouer et relâcher.
 * Il lui manquait tout ce qui se passe QUAND LE WORKER MEURT :
 *
 *   - `renewLease`            — le bail se prolonge tant que le worker bat ;
 *   - `reclaimExpiredLeases`  — le « reaper » : un bail mort retourne à la file ;
 *   - `startAttempt`/`finishAttempt` — le journal qui rend la reprise LISIBLE ;
 *   - `guardExternalEffect`   — une reprise ne rejoue jamais un effet externe.
 *
 * Garde commune, héritée de JOB-001 : on ne touche JAMAIS le job d'un autre
 * worker — `lease_owner` figure dans chaque `WHERE`.
 *
 * Comparaison temporelle : les colonnes sont des `text` de formats potentiellement
 * mixtes (cf. `timestamps.ts`) → tout prédicat CAST en `timestamp`, jamais de
 * comparaison lexicale sur `lease_until`.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { jobAttempts, jobEffects } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { createId } from './utils.js';
import { toDbTimestamp } from './timestamps.js';
import {
	DEFAULT_LEASE_MS,
	classifyAbandonedLease,
	computeLeaseUntil,
	computeRenewInterval,
	decideAfterAbandon,
	type AbandonKind,
	type AttemptOutcome
} from './job-state.js';

// ── Renouvellement de bail ──────────────────────────────────────────

/**
 * Prolonge le bail d'un job EN COURS et enregistre le battement.
 *
 * Renvoie `null` si le job n'appartient plus à ce worker (bail expiré et repris
 * par le reaper, job annulé…) : l'appelant doit alors ARRÊTER son travail, il
 * n'a plus le droit d'écrire l'issue de ce job.
 */
export async function renewLease(input: {
	db: AppDb;
	jobId: string;
	workerId: string;
	leaseMs?: number;
	now?: Date | string;
}): Promise<{ leaseUntil: string } | null> {
	const now = input.now ?? new Date();
	const nowDb = toDbTimestamp(now);
	const leaseUntil = computeLeaseUntil({ now, leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS });

	const res = await input.db.execute(sql`
		UPDATE "seostats"."jobs"
		   SET lease_until = ${leaseUntil},
		       heartbeat_at = ${nowDb},
		       updated_at = ${nowDb}
		 WHERE id = ${input.jobId} AND lease_owner = ${input.workerId} AND status = 'running'
		 RETURNING id
	`);
	return (res.rows?.length ?? 0) > 0 ? { leaseUntil } : null;
}

// ── Journal des tentatives ──────────────────────────────────────────

/** Ouvre la ligne de journal d'une tentative (issue `running` jusqu'à sa clôture). */
export async function startAttempt(input: {
	db: AppDb;
	jobId: string;
	projectId: string;
	attemptNo: number;
	workerId: string;
	metadataJson?: string | null;
	now?: Date | string;
}): Promise<{ id: string }> {
	const id = createId();
	await input.db.insert(jobAttempts).values({
		id,
		jobId: input.jobId,
		projectId: input.projectId,
		attemptNo: input.attemptNo,
		workerId: input.workerId,
		outcome: 'running',
		metadataJson: input.metadataJson ?? null,
		startedAt: toDbTimestamp(input.now ?? new Date())
	});
	return { id };
}

/**
 * Clôt une tentative. Le journal étant append-only, seule la ligne OUVERTE de
 * cette tentative est complétée (`outcome='running'` dans le WHERE) : une
 * tentative déjà close — typiquement abandonnée par le reaper — n'est jamais
 * réécrite par le worker zombie qui reviendrait à la vie.
 */
export async function finishAttempt(input: {
	db: AppDb;
	attemptId: string;
	outcome: Exclude<AttemptOutcome, 'running'>;
	abandonKind?: AbandonKind | null;
	errorCode?: string | null;
	errorMessage?: string | null;
	heartbeatCount?: number;
	now?: Date | string;
}): Promise<boolean> {
	const nowDb = toDbTimestamp(input.now ?? new Date());
	const res = await input.db.execute(sql`
		UPDATE "seostats"."job_attempts"
		   SET outcome = ${input.outcome},
		       abandon_kind = ${input.abandonKind ?? null},
		       error_code = ${input.errorCode ?? null},
		       error_message = ${input.errorMessage ?? null},
		       heartbeat_count = ${input.heartbeatCount ?? 0},
		       finished_at = ${nowDb},
		       duration_ms = GREATEST(
		           (EXTRACT(EPOCH FROM (${nowDb}::timestamp - started_at::timestamp)) * 1000)::integer,
		           0
		       )
		 WHERE id = ${input.attemptId} AND outcome = 'running'
		 RETURNING id
	`);
	return (res.rows?.length ?? 0) > 0;
}

/** Chronologie d'un job, la plus ancienne d'abord (CLI d'inspection, puis JOB-007). */
export async function listJobAttempts(input: {
	db: AppDb;
	jobId: string;
}): Promise<
	{
		id: string;
		attemptNo: number;
		workerId: string;
		outcome: string;
		abandonKind: string | null;
		errorCode: string | null;
		errorMessage: string | null;
		heartbeatCount: number;
		startedAt: string;
		finishedAt: string | null;
		durationMs: number | null;
	}[]
> {
	return input.db
		.select({
			id: jobAttempts.id,
			attemptNo: jobAttempts.attemptNo,
			workerId: jobAttempts.workerId,
			outcome: jobAttempts.outcome,
			abandonKind: jobAttempts.abandonKind,
			errorCode: jobAttempts.errorCode,
			errorMessage: jobAttempts.errorMessage,
			heartbeatCount: jobAttempts.heartbeatCount,
			startedAt: jobAttempts.startedAt,
			finishedAt: jobAttempts.finishedAt,
			durationMs: jobAttempts.durationMs
		})
		.from(jobAttempts)
		.where(eq(jobAttempts.jobId, input.jobId))
		.orderBy(asc(jobAttempts.startedAt), asc(jobAttempts.attemptNo));
}

// ── Reaper : récupération des baux morts ────────────────────────────

export interface ReclaimedLease {
	jobId: string;
	projectId: string;
	type: string;
	workerId: string;
	attemptNo: number;
	kind: AbandonKind;
	/** `queued` = remis en file après backoff ; `dead` = plafond de tentatives atteint. */
	outcome: 'queued' | 'dead';
	availableAt: string;
	backoffMs: number;
}

export interface ReclaimResult {
	reclaimed: ReclaimedLease[];
	requeued: number;
	deadLettered: number;
	byKind: Record<AbandonKind, number>;
	/** Baux morts vus mais NON repris (le propriétaire a renouvelé entre-temps). */
	skipped: number;
}

interface ExpiredRow {
	id: string;
	project_id: string;
	type: string;
	attempts: number;
	max_attempts: number;
	lease_owner: string;
	lease_until: string;
	heartbeat_at: string | null;
}

/**
 * Remet en file les jobs dont le bail est mort — le trou que JOB-001 laissait
 * ouvert : un worker qui crashe laissait son job `running` POUR TOUJOURS, hors
 * de portée de `claimJob` (qui ne regarde que les `queued`).
 *
 * Déroulé, dans UNE transaction :
 *   1. `SELECT … FOR UPDATE SKIP LOCKED` sur les baux expirés (consomme
 *      `idx_jobs_lease`) → deux reapers concurrents ne se disputent jamais la
 *      même ligne, ils se partagent le travail ;
 *   2. la NATURE de l'abandon est déduite du dernier battement
 *      (`classifyAbandonedLease` : mort du worker vs blocage) ;
 *   3. le SORT du job suit la politique de retry EXISTANTE (`decideAfterAbandon`
 *      → `decideAfterFailure` de DATA-003) : backoff, ou dead-letter au plafond ;
 *   4. l'`UPDATE` est GARDÉ par `lease_owner` + `lease_until` observés : si le
 *      vrai propriétaire a renouvelé entre la lecture et l'écriture, le `WHERE`
 *      ne matche pas et on ne lui vole rien (compté en `skipped`) ;
 *   5. la tentative ouverte est close en `abandoned` → la reprise est lisible.
 *
 * `dryRun` observe sans rien écrire (script `reap.ts`).
 */
export async function reclaimExpiredLeases(input: {
	db: AppDb;
	limit?: number;
	types?: string[];
	leaseMs?: number;
	dryRun?: boolean;
	now?: Date | string;
}): Promise<ReclaimResult> {
	const now = input.now ?? new Date();
	const nowDb = toDbTimestamp(now);
	const limit = Math.max(1, Math.floor(input.limit ?? 20));
	const renewIntervalMs = computeRenewInterval({ leaseMs: input.leaseMs });
	const types = input.types ?? [];
	// Filtre PARAMÉTRÉ : `IN (…)` et non `= ANY($n)` — le driver Neon sérialise un
	// tableau lié élément par élément (`malformed array literal`).
	const typeFilter =
		types.length > 0
			? sql`AND type IN (${sql.join(
					types.map((t) => sql`${t}`),
					sql`, `
				)})`
			: sql``;

	const result: ReclaimResult = {
		reclaimed: [],
		requeued: 0,
		deadLettered: 0,
		byKind: { worker_death: 0, lease_stall: 0 },
		skipped: 0
	};

	await input.db.transaction(async (tx) => {
		const selected = await tx.execute(sql`
			SELECT id, project_id, type, attempts, max_attempts, lease_owner, lease_until, heartbeat_at
			  FROM "seostats"."jobs"
			 WHERE status = 'running'
			   AND lease_until IS NOT NULL
			   AND lease_until::timestamp < ${nowDb}::timestamp
			   ${typeFilter}
			 ORDER BY lease_until ASC
			 LIMIT ${limit}
			 FOR UPDATE SKIP LOCKED
		`);
		const rows = (selected.rows ?? []) as unknown as ExpiredRow[];

		for (const row of rows) {
			const kind = classifyAbandonedLease({
				heartbeatAt: row.heartbeat_at,
				leaseUntil: row.lease_until,
				renewIntervalMs
			});
			const decision = decideAfterAbandon({
				attempts: Number(row.attempts),
				maxAttempts: Number(row.max_attempts),
				kind,
				now
			});

			const entry: ReclaimedLease = {
				jobId: row.id,
				projectId: row.project_id,
				type: row.type,
				workerId: row.lease_owner,
				attemptNo: Number(row.attempts),
				kind,
				outcome: decision.status,
				availableAt: decision.availableAt,
				backoffMs: decision.backoffMs
			};

			if (input.dryRun) {
				result.reclaimed.push(entry);
				result.byKind[kind] += 1;
				if (decision.status === 'dead') result.deadLettered += 1;
				else result.requeued += 1;
				continue;
			}

			// Garde : le bail observé doit être EXACTEMENT celui qu'on remet en file.
			// Si son propriétaire l'a renouvelé entre-temps, on ne lui vole rien.
			const updated = await tx.execute(sql`
				UPDATE "seostats"."jobs"
				   SET status = ${decision.status},
				       available_at = ${decision.availableAt},
				       last_error_code = ${decision.errorCode},
				       last_error_message = ${decision.errorMessage},
				       lease_owner = NULL,
				       lease_until = NULL,
				       updated_at = ${nowDb},
				       finished_at = ${decision.status === 'dead' ? nowDb : null}
				 WHERE id = ${row.id}
				   AND status = 'running'
				   AND lease_owner = ${row.lease_owner}
				   AND lease_until = ${row.lease_until}
				 RETURNING id
			`);
			if ((updated.rows?.length ?? 0) === 0) {
				result.skipped += 1;
				continue;
			}

			// La tentative abandonnée est close DANS la même transaction : soit le job
			// et son journal bougent ensemble, soit ni l'un ni l'autre.
			await tx.execute(sql`
				UPDATE "seostats"."job_attempts"
				   SET outcome = ${decision.status === 'dead' ? 'dead' : 'abandoned'},
				       abandon_kind = ${kind},
				       error_code = ${decision.errorCode},
				       error_message = ${decision.errorMessage},
				       finished_at = ${nowDb},
				       duration_ms = GREATEST(
				           (EXTRACT(EPOCH FROM (${nowDb}::timestamp - started_at::timestamp)) * 1000)::integer,
				           0
				       )
				 WHERE job_id = ${row.id}
				   AND worker_id = ${row.lease_owner}
				   AND outcome = 'running'
			`);

			result.reclaimed.push(entry);
			result.byKind[kind] += 1;
			if (decision.status === 'dead') result.deadLettered += 1;
			else result.requeued += 1;
		}
	});

	return result;
}

// ── Exactly-once des effets externes ────────────────────────────────

export interface EffectResult<T> {
	/** `true` si `apply()` a réellement tourné cette fois-ci. */
	applied: boolean;
	/** `true` si l'effet était déjà appliqué (ou réservé ailleurs) → non rejoué. */
	skipped: boolean;
	value?: T;
}

/**
 * Exécute un effet EXTERNE au plus une fois pour une clé donnée, quel que soit
 * le nombre de reprises du job (« deux exécutions ne produisent pas deux effets
 * externes »).
 *
 * L'ORDRE est le cœur du mécanisme — on RÉSERVE la clé, PUIS on applique :
 *   1. `INSERT … 'pending' ON CONFLICT DO NOTHING` sur `(project_id, effect_key)` ;
 *   2. 0 ligne insérée → la clé existe déjà : `applied` (on saute), `pending`
 *      chez un autre worker (on saute), `failed` (on la reprend — l'effet n'a
 *      jamais abouti, il DOIT pouvoir l'être) ;
 *   3. réservation obtenue → `apply()` tourne, puis la ligne passe `applied` ;
 *   4. `apply()` jette → la ligne passe `failed`, l'effet reste reprenable.
 *
 * Appliquer AVANT de réserver laisserait une fenêtre de double effet : c'est
 * précisément ce que cette fonction existe pour interdire.
 */
export async function guardExternalEffect<T>(input: {
	db: AppDb;
	jobId: string;
	projectId: string;
	attemptNo?: number;
	effectKey: string;
	apply: () => Promise<T>;
	resultHash?: (value: T) => string | null;
	now?: Date | string;
}): Promise<EffectResult<T>> {
	const nowDb = toDbTimestamp(input.now ?? new Date());

	const inserted = await input.db
		.insert(jobEffects)
		.values({
			id: createId(),
			jobId: input.jobId,
			projectId: input.projectId,
			attemptNo: input.attemptNo ?? null,
			effectKey: input.effectKey,
			status: 'pending',
			claimedAt: nowDb
		})
		.onConflictDoNothing({ target: [jobEffects.projectId, jobEffects.effectKey] })
		.returning({ id: jobEffects.id });

	let effectId = inserted[0]?.id ?? null;

	if (!effectId) {
		// La clé existe déjà. Un échec précédent se reprend ; un succès ne se rejoue
		// jamais. Le passage `failed` → `pending` est ATOMIQUE (le WHERE porte le
		// statut) : deux workers ne peuvent pas reprendre le même effet ensemble.
		const retaken = await input.db.execute(sql`
			UPDATE "seostats"."job_effects"
			   SET status = 'pending',
			       job_id = ${input.jobId},
			       attempt_no = ${input.attemptNo ?? null},
			       error_message = NULL,
			       claimed_at = ${nowDb}
			 WHERE project_id = ${input.projectId}
			   AND effect_key = ${input.effectKey}
			   AND status = 'failed'
			 RETURNING id
		`);
		const row = (retaken.rows ?? [])[0] as unknown as { id: string } | undefined;
		if (!row) return { applied: false, skipped: true };
		effectId = row.id;
	}

	try {
		const value = await input.apply();
		await input.db
			.update(jobEffects)
			.set({
				status: 'applied',
				resultHash: input.resultHash ? input.resultHash(value) : null,
				appliedAt: toDbTimestamp(new Date())
			})
			.where(and(eq(jobEffects.id, effectId), eq(jobEffects.status, 'pending')));
		return { applied: true, skipped: false, value };
	} catch (err) {
		await input.db
			.update(jobEffects)
			.set({
				status: 'failed',
				errorMessage: err instanceof Error ? err.message.slice(0, 2000) : String(err).slice(0, 2000)
			})
			.where(and(eq(jobEffects.id, effectId), eq(jobEffects.status, 'pending')));
		throw err;
	}
}
