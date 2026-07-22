/**
 * JOB-001/JOB-002 — Helpers PURS de la queue durable (SPEC §6.2).
 *
 * Zéro import db/`$env` → testables en isolation par vitest. Ce module décide
 * (quoi faire après un échec, jusqu'à quand tient un bail, qui est ce worker) ;
 * `jobs-claim.ts` et `jobs-lease.ts` exécutent (SQL). Le barème de retry n'est
 * pas réinventé : il réutilise `computeBackoff`/`shouldDeadLetter`/`normalizeError`
 * de DATA-003.
 *
 * JOB-002 y ajoute la mécanique de bail vivant : cadence de heartbeat, nature
 * d'un abandon (crash local vs blocage), et classification minimale des erreurs
 * d'exécution (timeout provider vs échec local). La classification FINE des
 * erreurs (429, auth, quota, permanent) reste JOB-003.
 */
import { computeBackoff, shouldDeadLetter, normalizeError, type JobStatus } from './monitoring-state.js';
import { toDbTimestamp, toDbTimestampPlus } from './timestamps.js';

// ── Identité d'un worker ────────────────────────────────────────────

/**
 * Identifiant de bail lisible : `host/pid/nonce`. Le nonce distingue deux workers
 * du même processus (tests de concurrence) ; il est FOURNI, jamais tiré au sort
 * ici, pour que la fonction reste pure et rejouable.
 */
export function deriveWorkerId(input: { host: string; pid: number | string; nonce: string }): string {
	const clean = (s: string | number) => String(s).replace(/[^\w.:-]/g, '-');
	return `${clean(input.host)}/${clean(input.pid)}/${clean(input.nonce)}`;
}

// ── Bail (lease) ────────────────────────────────────────────────────

/** Durée de bail par défaut : au-delà, JOB-002 considérera le worker mort. */
export const DEFAULT_LEASE_MS = 5 * 60 * 1000; // 5 min

/**
 * Fin de bail au format DB (comparable lexicalement aux colonnes `text`, cf.
 * `timestamps.ts`). `now` est passé explicitement → déterministe et testable.
 */
export function computeLeaseUntil(input: { now: Date | string; leaseMs?: number }): string {
	const leaseMs = Math.max(0, Math.floor(input.leaseMs ?? DEFAULT_LEASE_MS));
	return toDbTimestampPlus(leaseMs, input.now);
}

/**
 * Vrai si le bail est expiré à `now`. Utilisé par la boucle worker pour ne pas
 * clore un job dont elle a perdu la propriété, et par le reaper (JOB-002) pour
 * repérer les baux morts.
 */
export function isLeaseExpired(leaseUntil: string | null, now: Date | string): boolean {
	if (!leaseUntil) return true;
	return leaseUntil < toDbTimestamp(now);
}

// ── JOB-002 — Heartbeat ─────────────────────────────────────────────

/**
 * Cadence de renouvellement : un tiers du bail, plancher 1 s. Le worker a ainsi
 * TROIS occasions de renouveler avant l'échéance — une requête perdue ou un GC
 * malvenu ne suffit pas à se faire voler son job.
 */
export function computeRenewInterval(input: { leaseMs?: number }): number {
	const leaseMs = Math.max(0, Math.floor(input.leaseMs ?? DEFAULT_LEASE_MS));
	return Math.max(1000, Math.floor(leaseMs / 3));
}

// ── JOB-002 — Nature d'un abandon ───────────────────────────────────

/**
 * Pourquoi un bail a expiré. Le reaper ne peut pas interroger un process mort :
 * il DÉDUIT la cause du rythme des battements de cœur.
 */
export const ABANDON_KINDS = ['worker_death', 'lease_stall'] as const;
export type AbandonKind = (typeof ABANDON_KINDS)[number];

/** Codes d'erreur propres à JOB-002, repérables dans `last_error_code`. */
export const WORKER_DEATH_ERROR_CODE = 'WorkerDied';
export const LEASE_STALL_ERROR_CODE = 'LeaseStalled';
export const PROVIDER_TIMEOUT_ERROR_CODE = 'ProviderTimeout';

/** Code d'erreur associé à chaque nature d'abandon. */
export function abandonErrorCode(kind: AbandonKind): string {
	return kind === 'worker_death' ? WORKER_DEATH_ERROR_CODE : LEASE_STALL_ERROR_CODE;
}

/**
 * Nature d'un bail expiré, déduite du dernier battement connu.
 *
 * Le worker devait battre toutes les `renewIntervalMs`. Deux cas :
 *   - dernier battement ABSENT, ou antérieur à `leaseUntil - renewIntervalMs` :
 *     il a cessé de battre bien avant l'échéance → il est MORT (crash local,
 *     machine éteinte, process tué) ;
 *   - dernier battement POSTÉRIEUR à ce seuil : il battait encore juste avant
 *     l'expiration puis s'est tu → le process est (ou était) vivant mais BLOQUÉ
 *     (opération qui déborde, event loop saturée).
 *
 * La distinction est intentionnellement mécanique : elle ne devine rien, elle
 * lit une horloge. Un vrai timeout PROVIDER, lui, ne passe jamais par ici — il
 * est constaté de l'intérieur par le budget de durée du runner
 * (`PROVIDER_TIMEOUT_ERROR_CODE`), pendant que le worker est encore vivant.
 */
export function classifyAbandonedLease(input: {
	heartbeatAt: string | null;
	leaseUntil: string | null;
	renewIntervalMs?: number;
	leaseMs?: number;
}): AbandonKind {
	if (!input.heartbeatAt || !input.leaseUntil) return 'worker_death';

	const renewMs = input.renewIntervalMs ?? computeRenewInterval({ leaseMs: input.leaseMs });
	const leaseMs = Date.parse(`${input.leaseUntil.replace(' ', 'T')}Z`);
	const beatMs = Date.parse(`${input.heartbeatAt.replace(' ', 'T')}Z`);
	// Horodatage illisible : on ne prétend pas savoir, on suppose le pire (mort).
	if (Number.isNaN(leaseMs) || Number.isNaN(beatMs)) return 'worker_death';

	return beatMs < leaseMs - renewMs ? 'worker_death' : 'lease_stall';
}

/**
 * Que devient un job dont le bail est mort ? La politique de retry est celle de
 * DATA-003, INCHANGÉE : `decideAfterFailure` tranche entre replanification avec
 * backoff et dead-letter. On n'ajoute ici que la cause, pour que
 * `last_error_code` dise de quoi le job est mort.
 *
 * `attempts` est celui DÉJÀ consommé (la réclamation l'incrémente) : un worker
 * qui meurt a bien brûlé sa tentative — sans quoi un job qui tue ses workers
 * bouclerait à l'infini.
 */
export function decideAfterAbandon(input: {
	attempts: number;
	maxAttempts: number;
	kind: AbandonKind;
	now: Date | string;
	baseMs?: number;
	maxMs?: number;
}): FailureDecision {
	return decideAfterFailure({
		attempts: input.attempts,
		maxAttempts: input.maxAttempts,
		error: {
			code: abandonErrorCode(input.kind),
			message:
				input.kind === 'worker_death'
					? 'Bail expiré sans battement : worker présumé mort, tentative abandonnée.'
					: 'Bail expiré malgré un battement récent : worker bloqué, tentative abandonnée.'
		},
		now: input.now,
		baseMs: input.baseMs,
		maxMs: input.maxMs
	});
}

// ── JOB-002 — Classification minimale des erreurs d'exécution ───────

/**
 * Codes réseau/HTTP qui signent un provider qui ne répond pas à temps.
 * `ProviderTimeout` y figure lui-même : reclasser une erreur DÉJÀ classée doit
 * donner le même verdict (le runner repasse par ici avec sa propre erreur de
 * budget), sinon le drapeau et le code se contrediraient dans les logs.
 */
const TIMEOUT_CODES = new Set([
	PROVIDER_TIMEOUT_ERROR_CODE,
	'ETIMEDOUT',
	'ESOCKETTIMEDOUT',
	'ECONNABORTED',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
	'AbortError',
	'TimeoutError',
	'408',
	'504'
]);

/**
 * L'erreur qui vient de faire échouer un handler est-elle un TIMEOUT PROVIDER
 * (l'appel externe n'a pas répondu à temps, ou le budget de durée du job a été
 * dépassé) ou un échec LOCAL (bug, donnée invalide, handler absent) ?
 *
 * C'est la moitié « vivante » de l'acceptation « distinguer timeout provider et
 * crash local » : le crash se constate de l'extérieur (bail mort → reaper), le
 * timeout se constate de l'intérieur, ici. La classification FINE (auth, quota,
 * 429, permanent) est JOB-003 — on ne tranche que ce que JOB-002 exige.
 */
export function classifyExecutionError(err: unknown): { code: string; isProviderTimeout: boolean } {
	const { code } = normalizeError(err);
	const status = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
	const isTimeout =
		TIMEOUT_CODES.has(code) ||
		(typeof status === 'number' && (status === 408 || status === 504));
	return {
		code: isTimeout ? PROVIDER_TIMEOUT_ERROR_CODE : code,
		isProviderTimeout: isTimeout
	};
}

/** Erreur posée par le runner quand un job dépasse son budget de durée. */
export function providerTimeoutError(maxDurationMs: number): { code: string; message: string } {
	return {
		code: PROVIDER_TIMEOUT_ERROR_CODE,
		message: `Budget de durée dépassé (${maxDurationMs} ms) : exécution interrompue.`
	};
}

// ── Décision après échec (backoff / dead-letter) ────────────────────

export interface FailureDecision {
	/** `queued` = replanifié après backoff ; `dead` = dead-letter (plafond atteint). */
	status: Extract<JobStatus, 'queued' | 'dead'>;
	/** Prochaine disponibilité, au format DB (ignorée si `dead`). */
	availableAt: string;
	/** Délai appliqué, en ms (0 pour un dead-letter). */
	backoffMs: number;
	errorCode: string;
	errorMessage: string;
}

/**
 * Que faire d'un job qui vient d'échouer ? Le nombre de tentatives est celui
 * DÉJÀ consommé (la réclamation incrémente `attempts`) :
 *   - tentatives ≥ plafond → dead-letter, plus de replanification ;
 *   - sinon → replanifié à `now + backoff exponentiel` (SPEC §6.2).
 * L'erreur est normalisée (code + message borné) pour `last_error_*`.
 */
export function decideAfterFailure(input: {
	attempts: number;
	maxAttempts: number;
	error: unknown;
	now: Date | string;
	baseMs?: number;
	maxMs?: number;
}): FailureDecision {
	const { code, message } = normalizeError(input.error);

	if (shouldDeadLetter({ attempts: input.attempts, maxAttempts: input.maxAttempts })) {
		return {
			status: 'dead',
			availableAt: toDbTimestamp(input.now),
			backoffMs: 0,
			errorCode: code,
			errorMessage: message
		};
	}

	// `attempts` compte la tentative qui vient d'échouer ; le backoff est indexé
	// sur 0 pour la première (30 s, 60 s, 120 s…).
	const backoffMs = computeBackoff({
		attempt: Math.max(0, input.attempts - 1),
		baseMs: input.baseMs,
		maxMs: input.maxMs
	});
	return {
		status: 'queued',
		availableAt: toDbTimestampPlus(backoffMs, input.now),
		backoffMs,
		errorCode: code,
		errorMessage: message
	};
}

// ── Vocabulaire de la boucle worker ─────────────────────────────────

/** Issue d'un tour de boucle, pour la journalisation et les tests. */
export const WORKER_TICK_OUTCOMES = ['claimed', 'idle', 'stopped'] as const;
export type WorkerTickOutcome = (typeof WORKER_TICK_OUTCOMES)[number];

/**
 * Un job réclamé sans handler enregistré n'est PAS une erreur d'exécution qu'on
 * retenterait à l'infini : c'est une erreur de configuration. On la traite comme
 * un échec normal (donc backoff puis dead-letter), avec un code distinct pour la
 * repérer dans `last_error_code`.
 */
export const NO_HANDLER_ERROR_CODE = 'NoHandlerRegistered';

/**
 * JOB-002 — Issue d'une TENTATIVE au journal `job_attempts`. Distincte du statut
 * du job : un job `queued` peut avoir derrière lui une tentative `abandoned` et
 * une `failed`. C'est ce vocabulaire qui rend lisible « la #1 a été abandonnée,
 * la #2 a réussi ».
 */
export const ATTEMPT_OUTCOMES = [
	'running',
	'succeeded',
	'failed',
	'abandoned',
	'released',
	'dead'
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];
