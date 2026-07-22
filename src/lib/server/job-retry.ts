/**
 * JOB-003 — Classification fine des erreurs, backoff avec jitter, dead-letter
 * et politique de reprise (SPEC §6.2, §9.3).
 *
 * Module PUR (zéro import db/`$env`), dans la lignée de `job-state.ts` : il DÉCIDE
 * ce que devient un job qui vient d'échouer ; `jobs-claim.ts` exécute.
 *
 * Ce que JOB-001/JOB-002 laissaient ouvert : toute erreur y était traitée à
 * l'identique — backoff exponentiel puis dead-letter au plafond. Un 403 structurel
 * brûlait donc cinq tentatives sur une heure sans qu'aucune ne puisse aboutir, un
 * 429 consommait le même budget qu'un bug, et le backoff étant déterministe, N
 * jobs échoués sur le même provider revenaient TOUS à la même seconde.
 *
 * Ici, l'échec est d'abord CLASSÉ, et la classe décide :
 *
 *   retryable  → replanifié avec backoff exponentiel + jitter, borné par max_attempts ;
 *   quota      → REPORTÉ : la tentative est rendue, un compteur séparé (`deferrals`)
 *                s'incrémente, plafonné → un provider saturé ne tue pas un job sain ;
 *   auth       → dead-letter IMMÉDIAT : réessayer ne répare pas un token mort,
 *                ça retarde seulement l'humain qui doit re-consentir ;
 *   permanent  → dead-letter IMMÉDIAT (« 400/403 structurels ne bouclent pas »).
 *
 * La politique de plafond n'est PAS réinventée : le chemin `retryable` délègue à
 * `decideAfterFailure` (JOB-001), qui délègue lui-même à `computeBackoff`/
 * `shouldDeadLetter` (DATA-003). Ce module n'ajoute que le jugement et le jitter.
 */
import { normalizeError } from './monitoring-state.js';
import {
	LEASE_STALL_ERROR_CODE,
	NO_HANDLER_ERROR_CODE,
	PROVIDER_TIMEOUT_ERROR_CODE,
	WORKER_DEATH_ERROR_CODE,
	classifyExecutionError,
	decideAfterFailure
} from './job-state.js';
import { toDbTimestamp, toDbTimestampPlus } from './timestamps.js';

// ── Vocabulaire ─────────────────────────────────────────────────────

/** Les 4 natures d'échec du BACKLOG JOB-003. Persistées en `last_error_class`. */
export const ERROR_CLASSES = ['retryable', 'quota', 'auth', 'permanent'] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Ce qu'on FAIT du job. `defer` ne consomme pas de tentative (cf. `deferJob`). */
export const RETRY_ACTIONS = ['retry', 'defer', 'dead'] as const;
export type RetryAction = (typeof RETRY_ACTIONS)[number];

/** Pourquoi un job est mort — ce qui distingue « épuisé » de « sans espoir ». */
export const DEAD_REASONS = ['max_attempts', 'max_deferrals', 'permanent', 'auth'] as const;
export type DeadReason = (typeof DEAD_REASONS)[number];

// ── Politique par classe ────────────────────────────────────────────

export interface RetryPolicy {
	action: RetryAction;
	/** Délai de base du backoff exponentiel (ms). */
	baseMs: number;
	/** Plafond du backoff (ms), hors `Retry-After`. */
	maxMs: number;
	/** Amplitude du jitter, en fraction du délai (0.2 = ±20 %). */
	jitterRatio: number;
	/** Plafond de tentatives PROPRE à la classe (en plus de `jobs.max_attempts`). */
	attemptCap?: number;
	/** Plafond de reports pour cause de quota (classe `quota` seulement). */
	maxDeferrals?: number;
}

/**
 * Politique par défaut (constante PURE, sur le modèle de `RETENTION_DEFAULTS`).
 * Surchargeable appel par appel via `decideRetry({ policies })` ; aucune config
 * en base ici — les quotas provider configurables sont JOB-006.
 */
export const RETRY_DEFAULTS: Record<ErrorClass, RetryPolicy> = {
	// 5xx, timeouts, réseau, worker mort, bug de handler : borné par max_attempts.
	retryable: { action: 'retry', baseMs: 30_000, maxMs: 3_600_000, jitterRatio: 0.2 },
	// 429 / quota : le job n'a rien fait de mal, il attend son tour. Tentative rendue,
	// mais le nombre de reports est BORNÉ — sans quoi un provider mort boucle sans fin.
	quota: { action: 'defer', baseMs: 60_000, maxMs: 3_600_000, jitterRatio: 0.2, maxDeferrals: 20 },
	auth: { action: 'dead', baseMs: 0, maxMs: 0, jitterRatio: 0 },
	permanent: { action: 'dead', baseMs: 0, maxMs: 0, jitterRatio: 0 }
};

/**
 * Plafond dur d'un `Retry-After` honoré. Sans lui, un provider peut PARQUER un job
 * pendant des jours en renvoyant un en-tête déraisonnable.
 */
export const MAX_RETRY_AFTER_MS = 6 * 60 * 60 * 1000; // 6 h

// ── Classification ──────────────────────────────────────────────────

/**
 * Marqueurs de RAISON, examinés AVANT le statut HTTP — c'est le point le plus
 * sensible de ce module.
 *
 * Google ne respecte pas la sémantique naïve des statuts :
 *   - un dépassement de quota arrive en **403** avec `reason: rateLimitExceeded`
 *     (ou `quotaExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`) ;
 *   - un refresh token mort arrive en **400** avec `error: invalid_grant`.
 * Classer sur le statut nu ferait donc exactement l'inverse de ce qu'il faut :
 * le quota partirait en dead-letter permanent, et l'erreur d'auth boucleraient
 * cinq fois avant d'être visible.
 */
const QUOTA_MARKERS = [
	'quotaexceeded',
	'ratelimitexceeded',
	'userratelimitexceeded',
	'dailylimitexceeded',
	'resource_exhausted',
	'rate limit',
	'too many requests',
	'over_query_limit'
];

const AUTH_MARKERS = [
	'invalid_grant',
	'invalid_client',
	'unauthorized_client',
	'invalid_token',
	'unauthenticated',
	'insufficient authentication',
	'token has been expired'
];

const PERMANENT_MARKERS = [
	'permission_denied',
	'invalid_argument',
	'failed_precondition',
	'not_found'
];

/** Codes internes dont la classe est connue d'avance (JOB-002 + boucle worker). */
const INTERNAL_CLASSES: Record<string, ErrorClass> = {
	[PROVIDER_TIMEOUT_ERROR_CODE]: 'retryable',
	[WORKER_DEATH_ERROR_CODE]: 'retryable',
	[LEASE_STALL_ERROR_CODE]: 'retryable',
	// Erreur de CONFIGURATION : aucun retry ne fera apparaître le handler manquant.
	[NO_HANDLER_ERROR_CODE]: 'permanent'
};

/** Statut HTTP porté par l'erreur, quelle que soit la forme du client. */
function extractStatus(err: unknown): number | null {
	if (!err || typeof err !== 'object') return null;
	const e = err as {
		status?: unknown;
		statusCode?: unknown;
		code?: unknown;
		httpStatus?: unknown;
		response?: { status?: unknown };
	};
	const candidates = [e.status, e.statusCode, e.httpStatus, e.code, e.response?.status];
	for (const c of candidates) {
		if (typeof c === 'number' && Number.isFinite(c)) return c;
		// googleapis renvoie parfois `code` en chaîne ('403').
		if (typeof c === 'string' && /^\d{3}$/.test(c)) return Number(c);
	}
	return null;
}

/** Chaîne de recherche des marqueurs : champs de raison STRUCTURÉS + message. */
function collectMarkers(err: unknown): string {
	const parts: string[] = [];
	const push = (v: unknown) => {
		if (typeof v === 'string' && v) parts.push(v);
	};

	if (err && typeof err === 'object') {
		const e = err as Record<string, unknown>;
		push(e.code);
		push(e.reason);
		// Corps OAuth : { error: 'invalid_grant', error_description: '…' }
		push(e.error);
		push(e.error_description);
		push(e.message);

		const errors = e.errors;
		if (Array.isArray(errors)) {
			for (const item of errors.slice(0, 10)) {
				if (item && typeof item === 'object') {
					push((item as Record<string, unknown>).reason);
					push((item as Record<string, unknown>).message);
				}
			}
		}

		// googleapis : response.data.error.{status,errors[].reason}
		const data = (e.response as { data?: unknown } | undefined)?.data;
		const inner = data && typeof data === 'object' ? (data as Record<string, unknown>).error : null;
		if (inner && typeof inner === 'object') {
			const io = inner as Record<string, unknown>;
			push(io.status);
			push(io.message);
			if (Array.isArray(io.errors)) {
				for (const item of io.errors.slice(0, 10)) {
					if (item && typeof item === 'object') push((item as Record<string, unknown>).reason);
				}
			}
		}
	} else if (typeof err === 'string') {
		parts.push(err);
	}

	return parts.join(' | ').toLowerCase();
}

function hasMarker(haystack: string, markers: string[]): boolean {
	return markers.some((m) => haystack.includes(m));
}

export interface JobFailureClassification {
	/** Code normalisé (`ProviderTimeout` si l'erreur est un timeout, cf. JOB-002). */
	code: string;
	message: string;
	errorClass: ErrorClass;
	isProviderTimeout: boolean;
	/** `Retry-After` honoré (ms), plafonné — `null` si le provider n'en donne pas. */
	retryAfterMs: number | null;
}

/**
 * Classe l'erreur qui vient de faire échouer un handler.
 *
 * Ordre d'examen, du plus spécifique au plus général — le changer casse la
 * sémantique Google décrite plus haut :
 *   1. code interne connu (`ProviderTimeout`, `WorkerDied`, `NoHandlerRegistered`…) ;
 *   2. marqueurs de QUOTA (403 + `rateLimitExceeded` doit être un quota) ;
 *   3. marqueurs d'AUTH (400 + `invalid_grant` doit être une auth) ;
 *   4. marqueurs PERMANENTS ;
 *   5. statut HTTP : 429 → quota, 401 → auth, tout autre 4xx → permanent
 *      (un 4xx est par définition une erreur du CLIENT : la rejouer à l'identique
 *      redonnera le même 4xx), 5xx → retryable ;
 *   6. défaut → `retryable`, borné par `max_attempts` (on ne condamne jamais un
 *      job sur une erreur qu'on n'a pas su lire).
 *
 * S'appuie sur `classifyExecutionError` (JOB-002) pour la part timeout : sa table
 * de codes et son idempotence restent l'unique source de vérité sur ce point.
 */
export function classifyJobFailure(err: unknown, now: Date | string = new Date()): JobFailureClassification {
	const { code, isProviderTimeout } = classifyExecutionError(err);
	const { message } = normalizeError(err);
	const retryAfterMs = extractRetryAfterMs(err, now);

	const base = { code, message, isProviderTimeout, retryAfterMs };

	const internal = INTERNAL_CLASSES[code];
	if (internal) return { ...base, errorClass: internal };

	const markers = collectMarkers(err);
	if (hasMarker(markers, QUOTA_MARKERS)) return { ...base, errorClass: 'quota' };
	if (hasMarker(markers, AUTH_MARKERS)) return { ...base, errorClass: 'auth' };
	if (hasMarker(markers, PERMANENT_MARKERS)) return { ...base, errorClass: 'permanent' };

	const status = extractStatus(err);
	if (status !== null) {
		if (status === 429) return { ...base, errorClass: 'quota' };
		if (status === 401) return { ...base, errorClass: 'auth' };
		// 408 (timeout) et 425 (too early) sont des 4xx REJOUABLES ; le premier est
		// déjà capté en amont par `classifyExecutionError`.
		if (status >= 400 && status < 500 && status !== 408 && status !== 425) {
			return { ...base, errorClass: 'permanent' };
		}
	}

	return { ...base, errorClass: 'retryable' };
}

// ── Retry-After ─────────────────────────────────────────────────────

/**
 * `Retry-After` → millisecondes. Le protocole autorise deux formes : un nombre de
 * secondes, ou une date HTTP (d'où `now`, injecté pour rester pur). Plafonné à
 * `MAX_RETRY_AFTER_MS`, et jamais négatif (une date déjà passée = « tout de suite »).
 */
export function parseRetryAfter(value: unknown, now: Date | string = new Date()): number | null {
	if (value === null || value === undefined) return null;

	const clamp = (ms: number) => Math.min(Math.max(Math.round(ms), 0), MAX_RETRY_AFTER_MS);

	if (typeof value === 'number' && Number.isFinite(value)) return clamp(value * 1000);

	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) return null;
		if (/^\d+(\.\d+)?$/.test(trimmed)) return clamp(Number(trimmed) * 1000);

		const target = Date.parse(trimmed);
		if (!Number.isNaN(target)) {
			const ref = typeof now === 'string' ? Date.parse(now) : now.getTime();
			if (Number.isNaN(ref)) return null;
			return clamp(target - ref);
		}
	}
	return null;
}

/** Valeur d'en-tête, quelle que soit la forme du porteur (Headers, Map, objet nu). */
function headerValue(headers: unknown, name: string): unknown {
	if (!headers || typeof headers !== 'object') return undefined;
	const h = headers as { get?: unknown } & Record<string, unknown>;
	if (typeof h.get === 'function') {
		try {
			return (h.get as (k: string) => unknown)(name);
		} catch {
			return undefined;
		}
	}
	const key = Object.keys(h).find((k) => k.toLowerCase() === name);
	return key ? h[key] : undefined;
}

/**
 * Cherche le délai demandé par le provider : champ explicite, en-tête HTTP (sur
 * l'erreur ou sa réponse), puis repli sur le message — même esprit que
 * `parseRetryAfterSec` dans `ai/review-replies.ts`, où les SDK ne donnent parfois
 * l'information que dans le texte (« try again after 30s »).
 */
export function extractRetryAfterMs(err: unknown, now: Date | string = new Date()): number | null {
	if (!err || typeof err !== 'object') return null;
	const e = err as Record<string, unknown>;

	if (typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs)) {
		return Math.min(Math.max(Math.round(e.retryAfterMs), 0), MAX_RETRY_AFTER_MS);
	}

	const direct = parseRetryAfter(headerValue(e.headers, 'retry-after'), now);
	if (direct !== null) return direct;

	const fromResponse = parseRetryAfter(
		headerValue((e.response as { headers?: unknown } | undefined)?.headers, 'retry-after'),
		now
	);
	if (fromResponse !== null) return fromResponse;

	if (typeof e.retryAfter === 'string' || typeof e.retryAfter === 'number') {
		const parsed = parseRetryAfter(e.retryAfter, now);
		if (parsed !== null) return parsed;
	}

	const message = typeof e.message === 'string' ? e.message : '';
	const m = message.match(/(?:try again|retry)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?)?/i);
	if (m) {
		const n = Number(m[1]);
		if (Number.isFinite(n)) {
			const unit = (m[2] ?? 's').toLowerCase();
			const factor = unit.startsWith('ms') || unit.startsWith('milli') ? 1 : unit.startsWith('m') ? 60_000 : 1000;
			return Math.min(Math.round(n * factor), MAX_RETRY_AFTER_MS);
		}
	}
	return null;
}

// ── Jitter ──────────────────────────────────────────────────────────

/**
 * Désynchronise un délai de ± `ratio`.
 *
 * `random` est INJECTÉ, jamais tiré ici : même discipline que le `nonce` de
 * `deriveWorkerId` — la fonction reste pure et rejouable, et ce sont les couches
 * IO (`failJob`, le reaper) qui fournissent `Math.random`.
 *
 * Sans `random`, le délai ressort INCHANGÉ : le comportement déterministe de
 * JOB-001/JOB-002 (et ses tests) est ainsi préservé tel quel.
 */
export function applyJitter(input: {
	delayMs: number;
	ratio?: number;
	random?: () => number;
}): number {
	const delay = Math.max(0, Math.round(input.delayMs));
	if (!input.random || delay === 0) return delay;

	const ratio = Math.min(Math.max(input.ratio ?? 0, 0), 1);
	if (ratio === 0) return delay;

	const r = Math.min(Math.max(input.random(), 0), 1);
	// r=0 → borne basse (1-ratio) · r=0.5 → délai nu · r=1 → borne haute (1+ratio).
	return Math.max(0, Math.round(delay * (1 - ratio + 2 * ratio * r)));
}

// ── Décision ────────────────────────────────────────────────────────

export interface RetryDecision {
	action: RetryAction;
	errorClass: ErrorClass;
	errorCode: string;
	errorMessage: string;
	/** Délai avant la prochaine disponibilité (0 si `dead`). */
	delayMs: number;
	/** Prochaine disponibilité au format DB (`toDbTimestamp`). */
	availableAt: string;
	/** Renseigné seulement si `action === 'dead'`. */
	deadReason: DeadReason | null;
	retryAfterMs: number | null;
	isProviderTimeout: boolean;
}

export interface RetryDecisionInput {
	/** Tentatives DÉJÀ consommées (la réclamation incrémente `attempts`). */
	attempts: number;
	maxAttempts: number;
	/** Reports quota déjà consommés (`jobs.deferrals`). */
	deferrals?: number;
	error: unknown;
	now: Date | string;
	/** Injecté par la couche IO pour activer le jitter (`Math.random`). */
	random?: () => number;
	/** Surcharge ponctuelle de la politique par classe. */
	policies?: Partial<Record<ErrorClass, Partial<RetryPolicy>>>;
}

function resolvePolicy(
	errorClass: ErrorClass,
	overrides?: Partial<Record<ErrorClass, Partial<RetryPolicy>>>
): RetryPolicy {
	return { ...RETRY_DEFAULTS[errorClass], ...(overrides?.[errorClass] ?? {}) };
}

/**
 * Que devient un job qui vient d'échouer ? Entrée UNIQUE de la boucle worker.
 *
 * Les abandons (worker mort, bail bloqué) ne passent pas par ici : le reaper garde
 * `decideAfterAbandon`, qui délègue à `decideAfterFailure` — même politique, même
 * barème, appliquée depuis l'extérieur du process mort.
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
	const { code, message, errorClass, isProviderTimeout, retryAfterMs } = classifyJobFailure(
		input.error,
		input.now
	);
	const policy = resolvePolicy(errorClass, input.policies);

	const dead = (deadReason: DeadReason): RetryDecision => ({
		action: 'dead',
		errorClass,
		errorCode: code,
		errorMessage: message,
		delayMs: 0,
		availableAt: toDbTimestamp(input.now),
		deadReason,
		retryAfterMs,
		isProviderTimeout
	});

	// 1. Sans espoir : aucune tentative ne changera le verdict du provider.
	if (policy.action === 'dead') {
		return dead(errorClass === 'auth' ? 'auth' : 'permanent');
	}

	// 2. Quota : la tentative sera RENDUE par `deferJob` ; c'est le compteur de
	//    reports, distinct, qui borne la boucle.
	if (policy.action === 'defer') {
		const deferrals = Math.max(0, Math.floor(input.deferrals ?? 0));
		const maxDeferrals = policy.maxDeferrals ?? RETRY_DEFAULTS.quota.maxDeferrals ?? 20;
		if (deferrals + 1 > maxDeferrals) return dead('max_deferrals');

		const backoff = computeExponential(deferrals, policy);
		const jittered = applyJitter({
			delayMs: Math.max(backoff, retryAfterMs ?? 0),
			ratio: policy.jitterRatio,
			random: input.random
		});
		// Un `Retry-After` est un CONTRAT : le jitter peut l'allonger, jamais le raboter
		// (repasser sous la barre rejouerait le 429 à coup sûr).
		const delayMs = retryAfterMs !== null ? Math.max(jittered, retryAfterMs) : jittered;

		return {
			action: 'defer',
			errorClass,
			errorCode: code,
			errorMessage: message,
			delayMs,
			availableAt: toDbTimestampPlus(delayMs, input.now),
			deadReason: null,
			retryAfterMs,
			isProviderTimeout
		};
	}

	// 3. Retryable : la politique de plafond reste celle de JOB-001/DATA-003, on n'y
	//    ajoute que le jitter. `attemptCap` permet de serrer une classe sans toucher
	//    au `max_attempts` du job.
	const maxAttempts = Math.min(input.maxAttempts, policy.attemptCap ?? Number.POSITIVE_INFINITY);
	const decision = decideAfterFailure({
		attempts: input.attempts,
		maxAttempts,
		error: input.error,
		now: input.now,
		baseMs: policy.baseMs,
		maxMs: policy.maxMs
	});

	if (decision.status === 'dead') return dead('max_attempts');

	const delayMs = applyJitter({
		delayMs: decision.backoffMs,
		ratio: policy.jitterRatio,
		random: input.random
	});

	return {
		action: 'retry',
		errorClass,
		errorCode: code,
		errorMessage: message,
		delayMs,
		availableAt: toDbTimestampPlus(delayMs, input.now),
		deadReason: null,
		retryAfterMs,
		isProviderTimeout
	};
}

/** Backoff exponentiel plafonné, indexé sur le nombre de reports déjà subis. */
function computeExponential(index: number, policy: RetryPolicy): number {
	const raw = policy.baseMs * 2 ** Math.max(0, Math.floor(index));
	return Math.min(raw, policy.maxMs);
}
