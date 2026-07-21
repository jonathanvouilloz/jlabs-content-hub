/**
 * DATA-003 — Helpers PURS pour l'orchestration (runs / steps / jobs).
 *
 * Zéro import (ni db, ni `$env`) → testables en isolation par vitest.
 * Portent les invariants d'acceptation DATA-003 :
 *   - un run partiel distingue succès, skip, échec et provider indisponible ;
 *   - la clé d'idempotence est déterministe (rerun = même clé, pas de doublon) ;
 *   - le backoff et le passage en dead-letter sont dérivés du nombre de tentatives.
 */

// ── Vocabulaire de statut (SPEC §7.3/§7.4/§6.2) ─────────────────────

export const RUN_TYPES = ['daily', 'weekly', 'monthly', 'manual', 'post_publish'] as const;
export type RunType = (typeof RUN_TYPES)[number];

export const RUN_STATUSES = ['queued', 'running', 'partial', 'success', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TRIGGER_SOURCES = ['schedule', 'user', 'agent', 'webhook'] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const STEP_STATUSES = [
	'queued',
	'running',
	'success',
	'skipped',
	'failed',
	'provider_unavailable'
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// ── Clé d'idempotence (SPEC §8.3) ──────────────────────────────────

/**
 * Clé déterministe d'un job/run logique. Format SPEC §8.3 :
 *   `{runType}:{projectSlug}:{periodEnd}:{stepType}:{schemaVersion}`
 * Un rerun avec les mêmes paramètres produit la même clé → dédup en DB (unique
 * index) : ni observations, ni findings, ni réponses ne sont dupliqués.
 */
export function deriveIdempotencyKey(input: {
	runType: RunType | string;
	projectSlug: string;
	periodEnd: string;
	stepType: string;
	schemaVersion: number;
}): string {
	return `${input.runType}:${input.projectSlug}:${input.periodEnd}:${input.stepType}:${input.schemaVersion}`;
}

// ── Agrégation d'un run depuis ses steps (acceptation 1) ────────────

const STEP_TERMINAL_OK = new Set<StepStatus>(['success', 'skipped']);
const STEP_TERMINAL_KO = new Set<StepStatus>(['failed', 'provider_unavailable']);

/**
 * Dérive le statut d'un run de l'ensemble des statuts de ses steps. Règles :
 *   - aucun step → `queued` ;
 *   - au moins un step encore `queued`/`running` → `running` (pas terminal) ;
 *   - tous terminaux OK (`success`/`skipped`) → `success` ;
 *   - tous terminaux KO (`failed`/`provider_unavailable`) → `failed` ;
 *   - mélange OK + KO → `partial` (un run partiel distingue bien succès, skip,
 *     échec et provider indisponible).
 * `cancelled` n'est jamais dérivé ici : c'est une décision externe portée sur le run.
 */
export function classifyRunOutcome(stepStatuses: StepStatus[]): RunStatus {
	if (stepStatuses.length === 0) return 'queued';
	if (stepStatuses.some((s) => s === 'queued' || s === 'running')) return 'running';

	const anyOk = stepStatuses.some((s) => STEP_TERMINAL_OK.has(s));
	const anyKo = stepStatuses.some((s) => STEP_TERMINAL_KO.has(s));

	if (anyOk && anyKo) return 'partial';
	if (anyKo) return 'failed';
	return 'success';
}

// ── Retry / backoff / dead-letter (SPEC §6.2) ──────────────────────

/**
 * Délai de backoff (ms) avant la prochaine tentative : exponentiel plafonné,
 * DÉTERMINISTE (pas de jitter aléatoire, pour rester pur/testable).
 *   delay = min(baseMs * 2^attempt, maxMs)
 * `attempt` est le numéro de la tentative qui vient d'échouer (0-indexé côté job).
 */
export function computeBackoff(input: { attempt: number; baseMs?: number; maxMs?: number }): number {
	const base = input.baseMs ?? 30_000; // 30 s
	const max = input.maxMs ?? 3_600_000; // 1 h
	const attempt = Math.max(0, Math.floor(input.attempt));
	const raw = base * 2 ** attempt;
	return Math.min(raw, max);
}

/** Un job passe en dead-letter dès que ses tentatives atteignent le plafond. */
export function shouldDeadLetter(input: { attempts: number; maxAttempts: number }): boolean {
	return input.attempts >= input.maxAttempts;
}

// ── Normalisation d'erreur (erreur normalisée, SPEC DATA-003) ──────

/**
 * Normalise une erreur arbitraire en `{ code, message }` stable et sérialisable.
 * - Error → code = son `name` (ou 'Error'), message = son `message` ;
 * - objet `{ code?, message? }` → repris tels quels si présents ;
 * - string → code 'Error', message = la string ;
 * - autre → code 'UnknownError', message = String(err).
 * Le message est tronqué (2000 car.) pour ne pas gonfler `error_message`.
 */
export function normalizeError(err: unknown): { code: string; message: string } {
	const clip = (m: string) => (m.length > 2000 ? `${m.slice(0, 2000)}…` : m);

	if (err instanceof Error) {
		return { code: err.name || 'Error', message: clip(err.message || String(err)) };
	}
	if (typeof err === 'string') {
		return { code: 'Error', message: clip(err) };
	}
	if (err && typeof err === 'object') {
		const o = err as { code?: unknown; message?: unknown };
		const code = typeof o.code === 'string' ? o.code : 'Error';
		const message =
			typeof o.message === 'string' ? o.message : clip(safeStringify(err));
		return { code, message: clip(message) };
	}
	return { code: 'UnknownError', message: clip(String(err)) };
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
