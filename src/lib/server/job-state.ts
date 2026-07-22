/**
 * JOB-001 — Helpers PURS de la queue durable (SPEC §6.2).
 *
 * Zéro import db/`$env` → testables en isolation par vitest. Ce module décide
 * (quoi faire après un échec, jusqu'à quand tient un bail, qui est ce worker) ;
 * `jobs-claim.ts` exécute (SQL). Le barème de retry n'est pas réinventé : il
 * réutilise `computeBackoff`/`shouldDeadLetter`/`normalizeError` de DATA-003.
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
 * clore un job dont elle a perdu la propriété ; la REMISE EN QUEUE des baux
 * morts (le « reaper ») est JOB-002, hors périmètre.
 */
export function isLeaseExpired(leaseUntil: string | null, now: Date | string): boolean {
	if (!leaseUntil) return true;
	return leaseUntil < toDbTimestamp(now);
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
