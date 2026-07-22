import { describe, it, expect } from 'vitest';
import {
	DEAD_REASONS,
	ERROR_CLASSES,
	MAX_RETRY_AFTER_MS,
	RETRY_ACTIONS,
	RETRY_DEFAULTS,
	applyJitter,
	classifyJobFailure,
	decideRetry,
	extractRetryAfterMs,
	parseRetryAfter
} from './job-retry.js';
import {
	LEASE_STALL_ERROR_CODE,
	NO_HANDLER_ERROR_CODE,
	PROVIDER_TIMEOUT_ERROR_CODE,
	WORKER_DEATH_ERROR_CODE
} from './job-state.js';

const NOW = '2026-07-22T09:00:00Z';
const cls = (err: unknown) => classifyJobFailure(err, NOW).errorClass;

// ── Classification ──────────────────────────────────────────────────

describe('classifyJobFailure — statuts HTTP', () => {
	it('429 = quota', () => {
		expect(cls({ status: 429, message: 'slow down' })).toBe('quota');
	});

	it('401 = auth', () => {
		expect(cls({ status: 401, message: 'unauthorized' })).toBe('auth');
	});

	it('403 nu = permanent (structurel, ne doit pas boucler)', () => {
		expect(cls({ status: 403, message: 'the caller does not have permission' })).toBe('permanent');
	});

	it('400 nu = permanent', () => {
		expect(cls({ status: 400, message: 'bad request' })).toBe('permanent');
	});

	it('404 et 422 = permanent', () => {
		expect(cls({ status: 404, message: 'no such location' })).toBe('permanent');
		expect(cls({ status: 422, message: 'unprocessable' })).toBe('permanent');
	});

	it('5xx = retryable', () => {
		expect(cls({ status: 500, message: 'internal' })).toBe('retryable');
		expect(cls({ status: 503, message: 'unavailable' })).toBe('retryable');
	});

	it('408 et 425 restent rejouables malgré leur 4xx', () => {
		expect(cls({ status: 425, message: 'too early' })).toBe('retryable');
		// 408 est déjà capté en amont comme timeout provider (JOB-002).
		expect(classifyJobFailure({ status: 408, message: 'timeout' }, NOW).isProviderTimeout).toBe(true);
		expect(cls({ status: 408, message: 'timeout' })).toBe('retryable');
	});

	it('lit le statut quelle que soit sa forme (statusCode, response.status, code chaîne)', () => {
		expect(cls({ statusCode: 429, message: 'x' })).toBe('quota');
		expect(cls({ response: { status: 403 }, message: 'x' })).toBe('permanent');
		expect(cls({ code: '403', message: 'x' })).toBe('permanent');
	});
});

describe('classifyJobFailure — la RAISON prime sur le statut', () => {
	it('403 + rateLimitExceeded = quota, pas permanent (sémantique Google)', () => {
		const err = {
			status: 403,
			errors: [{ reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' }],
			message: 'Rate Limit Exceeded'
		};
		expect(cls(err)).toBe('quota');
	});

	it('403 + quotaExceeded (googleapis, response.data.error.errors) = quota', () => {
		const err = {
			code: 403,
			response: { data: { error: { errors: [{ reason: 'quotaExceeded' }], message: 'Quota' } } },
			message: 'Quota exceeded for quota metric'
		};
		expect(cls(err)).toBe('quota');
	});

	it('403 + userRateLimitExceeded et dailyLimitExceeded = quota', () => {
		expect(cls({ status: 403, errors: [{ reason: 'userRateLimitExceeded' }] })).toBe('quota');
		expect(cls({ status: 403, errors: [{ reason: 'dailyLimitExceeded' }] })).toBe('quota');
	});

	it('400 + invalid_grant = auth, pas permanent (refresh token mort)', () => {
		const err = { status: 400, error: 'invalid_grant', error_description: 'Token has been expired or revoked.' };
		expect(cls(err)).toBe('auth');
	});

	it('RESOURCE_EXHAUSTED (gRPC) = quota', () => {
		expect(cls({ response: { data: { error: { status: 'RESOURCE_EXHAUSTED' } } } })).toBe('quota');
	});

	it('PERMISSION_DENIED = permanent, UNAUTHENTICATED = auth', () => {
		expect(cls({ response: { data: { error: { status: 'PERMISSION_DENIED' } } } })).toBe('permanent');
		expect(cls({ response: { data: { error: { status: 'UNAUTHENTICATED' } } } })).toBe('auth');
	});

	it('« too many requests » dans le message suffit à faire un quota', () => {
		expect(cls(new Error('Too Many Requests'))).toBe('quota');
	});
});

describe('classifyJobFailure — codes internes', () => {
	it('timeout provider, worker mort et bail bloqué sont rejouables', () => {
		expect(cls({ code: PROVIDER_TIMEOUT_ERROR_CODE, message: 'budget dépassé' })).toBe('retryable');
		expect(cls({ code: WORKER_DEATH_ERROR_CODE, message: 'worker mort' })).toBe('retryable');
		expect(cls({ code: LEASE_STALL_ERROR_CODE, message: 'bail bloqué' })).toBe('retryable');
	});

	it('handler manquant = permanent (erreur de configuration, pas de boucle)', () => {
		expect(cls({ code: NO_HANDLER_ERROR_CODE, message: 'aucun handler' })).toBe('permanent');
	});

	it('une erreur illisible retombe sur retryable (on ne condamne jamais à l’aveugle)', () => {
		expect(cls(new Error('boom'))).toBe('retryable');
		expect(cls('quelque chose a cassé')).toBe('retryable');
		expect(cls(null)).toBe('retryable');
		expect(cls(undefined)).toBe('retryable');
		expect(cls(42)).toBe('retryable');
	});

	it('conserve le code normalisé et le message', () => {
		const c = classifyJobFailure({ code: 'GmbApiError', message: 'nope', status: 403 }, NOW);
		expect(c.code).toBe('GmbApiError');
		expect(c.message).toBe('nope');
		expect(c.errorClass).toBe('permanent');
	});
});

// ── Retry-After ─────────────────────────────────────────────────────

describe('parseRetryAfter', () => {
	it('secondes (nombre ou chaîne)', () => {
		expect(parseRetryAfter(30, NOW)).toBe(30_000);
		expect(parseRetryAfter('120', NOW)).toBe(120_000);
	});

	it('date HTTP → delta depuis maintenant', () => {
		expect(parseRetryAfter('Wed, 22 Jul 2026 09:02:00 GMT', NOW)).toBe(120_000);
	});

	it('date déjà passée → 0 (tout de suite), jamais négatif', () => {
		expect(parseRetryAfter('Wed, 22 Jul 2026 08:00:00 GMT', NOW)).toBe(0);
	});

	it('plafonné à 6 h : un provider ne peut pas parquer un job indéfiniment', () => {
		expect(parseRetryAfter(999_999, NOW)).toBe(MAX_RETRY_AFTER_MS);
	});

	it('valeur absente ou illisible → null', () => {
		expect(parseRetryAfter(null, NOW)).toBeNull();
		expect(parseRetryAfter(undefined, NOW)).toBeNull();
		expect(parseRetryAfter('', NOW)).toBeNull();
		expect(parseRetryAfter('bientôt', NOW)).toBeNull();
	});
});

describe('extractRetryAfterMs', () => {
	it('champ explicite en ms', () => {
		expect(extractRetryAfterMs({ retryAfterMs: 4500 }, NOW)).toBe(4500);
	});

	it('en-tête objet nu, insensible à la casse', () => {
		expect(extractRetryAfterMs({ headers: { 'Retry-After': '45' } }, NOW)).toBe(45_000);
	});

	it('en-tête porté par un objet à .get (fetch Headers)', () => {
		const headers = { get: (k: string) => (k === 'retry-after' ? '10' : null) };
		expect(extractRetryAfterMs({ headers }, NOW)).toBe(10_000);
	});

	it('en-tête sur la réponse (response.headers)', () => {
		expect(extractRetryAfterMs({ response: { headers: { 'retry-after': '15' } } }, NOW)).toBe(15_000);
	});

	it('repli sur le message quand le SDK ne donne que du texte', () => {
		expect(extractRetryAfterMs(new Error('rate limited, try again in 30s'), NOW)).toBe(30_000);
		expect(extractRetryAfterMs(new Error('retry after 2 minutes'), NOW)).toBe(120_000);
	});

	it('rien à extraire → null', () => {
		expect(extractRetryAfterMs(new Error('boom'), NOW)).toBeNull();
		expect(extractRetryAfterMs('texte', NOW)).toBeNull();
	});
});

// ── Jitter ──────────────────────────────────────────────────────────

describe('applyJitter', () => {
	it('sans random, le délai ressort INCHANGÉ (comportement JOB-001/002 préservé)', () => {
		expect(applyJitter({ delayMs: 30_000, ratio: 0.2 })).toBe(30_000);
	});

	it('random=0.5 → délai nu ; 0 → borne basse ; 1 → borne haute', () => {
		expect(applyJitter({ delayMs: 30_000, ratio: 0.2, random: () => 0.5 })).toBe(30_000);
		expect(applyJitter({ delayMs: 30_000, ratio: 0.2, random: () => 0 })).toBe(24_000);
		expect(applyJitter({ delayMs: 30_000, ratio: 0.2, random: () => 1 })).toBe(36_000);
	});

	it('reste dans la fourchette quel que soit le tirage', () => {
		for (let i = 0; i <= 20; i++) {
			const r = i / 20;
			const v = applyJitter({ delayMs: 60_000, ratio: 0.2, random: () => r });
			expect(v).toBeGreaterThanOrEqual(48_000);
			expect(v).toBeLessThanOrEqual(72_000);
		}
	});

	it('déterministe à tirage égal (rejouable)', () => {
		const a = applyJitter({ delayMs: 12_345, ratio: 0.3, random: () => 0.42 });
		const b = applyJitter({ delayMs: 12_345, ratio: 0.3, random: () => 0.42 });
		expect(a).toBe(b);
	});

	it('ratio 0 ou délai 0 → aucun effet, jamais de négatif', () => {
		expect(applyJitter({ delayMs: 30_000, ratio: 0, random: () => 0 })).toBe(30_000);
		expect(applyJitter({ delayMs: 0, ratio: 0.5, random: () => 0 })).toBe(0);
	});

	it('borne un tirage hors [0,1] au lieu de produire n’importe quoi', () => {
		expect(applyJitter({ delayMs: 10_000, ratio: 0.2, random: () => 5 })).toBe(12_000);
		expect(applyJitter({ delayMs: 10_000, ratio: 0.2, random: () => -3 })).toBe(8_000);
	});
});

// ── Décision ────────────────────────────────────────────────────────

describe('decideRetry — classe permanente et auth', () => {
	it('403 structurel → dead-letter à la PREMIÈRE tentative', () => {
		const d = decideRetry({ attempts: 1, maxAttempts: 5, error: { status: 403 }, now: NOW });
		expect(d.action).toBe('dead');
		expect(d.errorClass).toBe('permanent');
		expect(d.deadReason).toBe('permanent');
		expect(d.delayMs).toBe(0);
	});

	it('400 structurel → dead, sans consommer les 5 tentatives', () => {
		const d = decideRetry({ attempts: 1, maxAttempts: 5, error: { status: 400 }, now: NOW });
		expect(d.action).toBe('dead');
		expect(d.deadReason).toBe('permanent');
	});

	it('invalid_grant → dead immédiat avec la cause auth (décision produit)', () => {
		const d = decideRetry({
			attempts: 1,
			maxAttempts: 5,
			error: { status: 400, error: 'invalid_grant' },
			now: NOW
		});
		expect(d.action).toBe('dead');
		expect(d.errorClass).toBe('auth');
		expect(d.deadReason).toBe('auth');
	});

	it('handler manquant → dead immédiat (configuration, pas transitoire)', () => {
		const d = decideRetry({
			attempts: 1,
			maxAttempts: 5,
			error: { code: NO_HANDLER_ERROR_CODE, message: 'aucun handler' },
			now: NOW
		});
		expect(d.action).toBe('dead');
		expect(d.deadReason).toBe('permanent');
	});
});

describe('decideRetry — classe retryable', () => {
	it('5xx → replanifié avec backoff, borné par max_attempts', () => {
		const d = decideRetry({ attempts: 1, maxAttempts: 5, error: { status: 503 }, now: NOW });
		expect(d.action).toBe('retry');
		expect(d.errorClass).toBe('retryable');
		expect(d.delayMs).toBe(30_000);
		expect(d.availableAt).toBe('2026-07-22 09:00:30');
	});

	it('le backoff reste exponentiel de tentative en tentative', () => {
		const a = decideRetry({ attempts: 1, maxAttempts: 5, error: { status: 503 }, now: NOW });
		const b = decideRetry({ attempts: 2, maxAttempts: 5, error: { status: 503 }, now: NOW });
		const c = decideRetry({ attempts: 3, maxAttempts: 5, error: { status: 503 }, now: NOW });
		expect([a.delayMs, b.delayMs, c.delayMs]).toEqual([30_000, 60_000, 120_000]);
	});

	it('le jitter désynchronise deux jobs échoués au même instant', () => {
		const low = decideRetry({ attempts: 1, maxAttempts: 5, error: { status: 503 }, now: NOW, random: () => 0 });
		const high = decideRetry({ attempts: 1, maxAttempts: 5, error: { status: 503 }, now: NOW, random: () => 1 });
		expect(low.delayMs).toBe(24_000);
		expect(high.delayMs).toBe(36_000);
		expect(low.availableAt).not.toBe(high.availableAt);
	});

	it('au plafond de tentatives → dead-letter (cause : épuisement)', () => {
		const d = decideRetry({ attempts: 5, maxAttempts: 5, error: { status: 503 }, now: NOW });
		expect(d.action).toBe('dead');
		expect(d.deadReason).toBe('max_attempts');
	});

	it('attemptCap serre une classe sans toucher au max_attempts du job', () => {
		const d = decideRetry({
			attempts: 2,
			maxAttempts: 5,
			error: { status: 503 },
			now: NOW,
			policies: { retryable: { attemptCap: 2 } }
		});
		expect(d.action).toBe('dead');
		expect(d.deadReason).toBe('max_attempts');
	});

	it('la disponibilité reste au format DB comparable', () => {
		const d = decideRetry({ attempts: 1, maxAttempts: 5, error: { status: 503 }, now: NOW });
		expect(d.availableAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});
});

describe('decideRetry — classe quota (report)', () => {
	it('429 → report, jamais un échec ordinaire', () => {
		const d = decideRetry({ attempts: 1, maxAttempts: 5, deferrals: 0, error: { status: 429 }, now: NOW });
		expect(d.action).toBe('defer');
		expect(d.errorClass).toBe('quota');
		expect(d.deadReason).toBeNull();
		expect(d.delayMs).toBe(60_000);
	});

	it('le report s’allonge à chaque fois (exponentiel sur les reports, pas sur les tentatives)', () => {
		const first = decideRetry({ attempts: 1, maxAttempts: 5, deferrals: 0, error: { status: 429 }, now: NOW });
		const third = decideRetry({ attempts: 1, maxAttempts: 5, deferrals: 2, error: { status: 429 }, now: NOW });
		expect(first.delayMs).toBe(60_000);
		expect(third.delayMs).toBe(240_000);
	});

	it('Retry-After honoré quand il dépasse le backoff', () => {
		const d = decideRetry({
			attempts: 1,
			maxAttempts: 5,
			deferrals: 0,
			error: { status: 429, headers: { 'retry-after': '300' } },
			now: NOW
		});
		expect(d.retryAfterMs).toBe(300_000);
		expect(d.delayMs).toBe(300_000);
		expect(d.availableAt).toBe('2026-07-22 09:05:00');
	});

	it('le jitter n’ampute JAMAIS un Retry-After (repasser dessous rejoue le 429)', () => {
		const d = decideRetry({
			attempts: 1,
			maxAttempts: 5,
			deferrals: 0,
			error: { status: 429, headers: { 'retry-after': '300' } },
			now: NOW,
			random: () => 0
		});
		expect(d.delayMs).toBeGreaterThanOrEqual(300_000);
	});

	it('au plafond de reports → dead-letter (la boucle reste bornée)', () => {
		const d = decideRetry({ attempts: 1, maxAttempts: 5, deferrals: 20, error: { status: 429 }, now: NOW });
		expect(d.action).toBe('dead');
		expect(d.deadReason).toBe('max_deferrals');
	});

	it('le plafond de reports est configurable', () => {
		const d = decideRetry({
			attempts: 1,
			maxAttempts: 5,
			deferrals: 2,
			error: { status: 429 },
			now: NOW,
			policies: { quota: { maxDeferrals: 2 } }
		});
		expect(d.action).toBe('dead');
		expect(d.deadReason).toBe('max_deferrals');
	});

	it('un quota ne regarde pas le budget de tentatives (attempts au plafond, report quand même)', () => {
		const d = decideRetry({ attempts: 5, maxAttempts: 5, deferrals: 0, error: { status: 429 }, now: NOW });
		expect(d.action).toBe('defer');
	});
});

describe('vocabulaire', () => {
	it('les 4 classes du BACKLOG, les 3 actions, les 4 causes de mort', () => {
		expect([...ERROR_CLASSES]).toEqual(['retryable', 'quota', 'auth', 'permanent']);
		expect([...RETRY_ACTIONS]).toEqual(['retry', 'defer', 'dead']);
		expect([...DEAD_REASONS]).toEqual(['max_attempts', 'max_deferrals', 'permanent', 'auth']);
	});

	it('les défauts couvrent les 4 classes et n’autorisent aucun retry sur auth/permanent', () => {
		for (const c of ERROR_CLASSES) expect(RETRY_DEFAULTS[c]).toBeDefined();
		expect(RETRY_DEFAULTS.auth.action).toBe('dead');
		expect(RETRY_DEFAULTS.permanent.action).toBe('dead');
		expect(RETRY_DEFAULTS.quota.action).toBe('defer');
		expect(RETRY_DEFAULTS.retryable.action).toBe('retry');
	});
});
