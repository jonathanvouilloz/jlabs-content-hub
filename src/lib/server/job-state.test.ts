import { describe, it, expect } from 'vitest';
import {
	ABANDON_KINDS,
	ATTEMPT_OUTCOMES,
	DEFAULT_LEASE_MS,
	LEASE_STALL_ERROR_CODE,
	NO_HANDLER_ERROR_CODE,
	PROVIDER_TIMEOUT_ERROR_CODE,
	WORKER_DEATH_ERROR_CODE,
	abandonErrorCode,
	classifyAbandonedLease,
	classifyExecutionError,
	computeLeaseUntil,
	computeRenewInterval,
	decideAfterAbandon,
	decideAfterFailure,
	deriveWorkerId,
	isLeaseExpired,
	providerTimeoutError
} from './job-state.js';

const NOW = '2026-07-22T09:00:00Z';

describe('deriveWorkerId', () => {
	it('compose host/pid/nonce', () => {
		expect(deriveWorkerId({ host: 'vps-1', pid: 4242, nonce: 'a1' })).toBe('vps-1/4242/a1');
	});

	it('neutralise les caractères exotiques (identifiant lisible en base)', () => {
		expect(deriveWorkerId({ host: 'my host!', pid: 1, nonce: 'x/y' })).toBe('my-host-/1/x-y');
	});

	it('deux nonces distincts = deux workers distincts', () => {
		const a = deriveWorkerId({ host: 'h', pid: 1, nonce: 'a' });
		const b = deriveWorkerId({ host: 'h', pid: 1, nonce: 'b' });
		expect(a).not.toBe(b);
	});
});

describe('computeLeaseUntil / isLeaseExpired', () => {
	it('pose une fin de bail au format DB', () => {
		expect(computeLeaseUntil({ now: NOW, leaseMs: 5 * 60 * 1000 })).toBe('2026-07-22 09:05:00');
	});

	it('bail par défaut = 5 minutes', () => {
		expect(computeLeaseUntil({ now: NOW })).toBe(
			computeLeaseUntil({ now: NOW, leaseMs: DEFAULT_LEASE_MS })
		);
	});

	it('un bail encore valide n’est pas expiré', () => {
		const until = computeLeaseUntil({ now: NOW, leaseMs: 60_000 });
		expect(isLeaseExpired(until, '2026-07-22T09:00:30Z')).toBe(false);
	});

	it('un bail dépassé est expiré', () => {
		const until = computeLeaseUntil({ now: NOW, leaseMs: 60_000 });
		expect(isLeaseExpired(until, '2026-07-22T09:02:00Z')).toBe(true);
	});

	it('absence de bail = expiré (on ne clôt jamais un job qu’on ne possède pas)', () => {
		expect(isLeaseExpired(null, NOW)).toBe(true);
	});
});

describe('decideAfterFailure (SPEC §6.2)', () => {
	it('première tentative échouée → replanifiée après le backoff de base (30 s)', () => {
		const d = decideAfterFailure({
			attempts: 1,
			maxAttempts: 5,
			error: new Error('timeout provider'),
			now: NOW
		});
		expect(d.status).toBe('queued');
		expect(d.backoffMs).toBe(30_000);
		expect(d.availableAt).toBe('2026-07-22 09:00:30');
		expect(d.errorMessage).toBe('timeout provider');
	});

	it('le backoff croît exponentiellement avec les tentatives', () => {
		const delays = [1, 2, 3, 4].map(
			(attempts) =>
				decideAfterFailure({ attempts, maxAttempts: 10, error: 'boom', now: NOW }).backoffMs
		);
		expect(delays).toEqual([30_000, 60_000, 120_000, 240_000]);
	});

	it('le backoff est plafonné (jamais une replanification à l’infini)', () => {
		const d = decideAfterFailure({
			attempts: 20,
			maxAttempts: 99,
			error: 'boom',
			now: NOW,
			maxMs: 3_600_000
		});
		expect(d.backoffMs).toBe(3_600_000);
	});

	it('au plafond exact de tentatives → dead-letter, pas de replanification', () => {
		const d = decideAfterFailure({ attempts: 5, maxAttempts: 5, error: 'boom', now: NOW });
		expect(d.status).toBe('dead');
		expect(d.backoffMs).toBe(0);
	});

	it('au-delà du plafond → dead-letter aussi', () => {
		expect(decideAfterFailure({ attempts: 9, maxAttempts: 5, error: 'x', now: NOW }).status).toBe(
			'dead'
		);
	});

	it('normalise l’erreur en code + message (jamais un objet brut)', () => {
		const d = decideAfterFailure({
			attempts: 1,
			maxAttempts: 5,
			error: { code: 'RateLimited', message: '429 too many requests' },
			now: NOW
		});
		expect(d.errorCode).toBe('RateLimited');
		expect(d.errorMessage).toBe('429 too many requests');
	});

	it('un handler manquant a son propre code d’erreur repérable', () => {
		expect(NO_HANDLER_ERROR_CODE).toBe('NoHandlerRegistered');
	});

	it('la disponibilité replanifiée reste comparable au format DB', () => {
		const d = decideAfterFailure({ attempts: 1, maxAttempts: 5, error: 'x', now: NOW });
		expect(d.availableAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});
});

// ── JOB-002 ─────────────────────────────────────────────────────────

describe('computeRenewInterval', () => {
	it('bat trois fois par bail (trois chances de renouveler avant l’échéance)', () => {
		expect(computeRenewInterval({ leaseMs: 300_000 })).toBe(100_000);
	});

	it('plancher à 1 s : un bail minuscule ne fait pas battre en boucle serrée', () => {
		expect(computeRenewInterval({ leaseMs: 300 })).toBe(1000);
		expect(computeRenewInterval({ leaseMs: 0 })).toBe(1000);
	});

	it('sans bail précisé, se cale sur le bail par défaut', () => {
		expect(computeRenewInterval({})).toBe(computeRenewInterval({ leaseMs: DEFAULT_LEASE_MS }));
	});
});

describe('classifyAbandonedLease (crash local vs blocage)', () => {
	// Bail de 5 min → renouvellement attendu toutes les 100 s.
	const leaseUntil = '2026-07-22 09:05:00';
	const renewIntervalMs = 100_000;

	it('aucun battement → worker présumé mort', () => {
		expect(classifyAbandonedLease({ heartbeatAt: null, leaseUntil, renewIntervalMs })).toBe(
			'worker_death'
		);
	});

	it('battement bien antérieur à l’échéance → il a cessé de battre : mort', () => {
		// 09:01:00 < 09:05:00 - 100 s (= 09:03:20)
		expect(
			classifyAbandonedLease({ heartbeatAt: '2026-07-22 09:01:00', leaseUntil, renewIntervalMs })
		).toBe('worker_death');
	});

	it('battement juste avant l’échéance → il battait encore : blocage', () => {
		// 09:04:30 > 09:03:20
		expect(
			classifyAbandonedLease({ heartbeatAt: '2026-07-22 09:04:30', leaseUntil, renewIntervalMs })
		).toBe('lease_stall');
	});

	it('la frontière est exactement `leaseUntil - renewInterval`', () => {
		expect(
			classifyAbandonedLease({ heartbeatAt: '2026-07-22 09:03:20', leaseUntil, renewIntervalMs })
		).toBe('lease_stall');
		expect(
			classifyAbandonedLease({ heartbeatAt: '2026-07-22 09:03:19', leaseUntil, renewIntervalMs })
		).toBe('worker_death');
	});

	it('bail absent → mort (on ne suppose jamais un worker vivant)', () => {
		expect(
			classifyAbandonedLease({ heartbeatAt: '2026-07-22 09:04:00', leaseUntil: null })
		).toBe('worker_death');
	});

	it('horodatage illisible → mort plutôt qu’une classification inventée', () => {
		expect(classifyAbandonedLease({ heartbeatAt: 'pas une date', leaseUntil })).toBe(
			'worker_death'
		);
	});

	it('déduit la cadence du bail quand elle n’est pas fournie', () => {
		expect(
			classifyAbandonedLease({
				heartbeatAt: '2026-07-22 09:04:30',
				leaseUntil,
				leaseMs: 300_000
			})
		).toBe('lease_stall');
	});
});

describe('decideAfterAbandon (la politique de retry est celle de DATA-003)', () => {
	it('un abandon sous le plafond est replanifié avec backoff', () => {
		const d = decideAfterAbandon({ attempts: 1, maxAttempts: 5, kind: 'worker_death', now: NOW });
		expect(d.status).toBe('queued');
		expect(d.backoffMs).toBe(30_000);
		expect(d.errorCode).toBe(WORKER_DEATH_ERROR_CODE);
	});

	it('applique EXACTEMENT le même barème que decideAfterFailure', () => {
		const abandon = decideAfterAbandon({
			attempts: 3,
			maxAttempts: 9,
			kind: 'lease_stall',
			now: NOW
		});
		const failure = decideAfterFailure({ attempts: 3, maxAttempts: 9, error: 'x', now: NOW });
		expect(abandon.backoffMs).toBe(failure.backoffMs);
		expect(abandon.availableAt).toBe(failure.availableAt);
	});

	it('au plafond de tentatives → dead-letter (un job qui tue ses workers ne boucle pas)', () => {
		const d = decideAfterAbandon({ attempts: 5, maxAttempts: 5, kind: 'worker_death', now: NOW });
		expect(d.status).toBe('dead');
	});

	it('la cause reste lisible dans le code d’erreur', () => {
		expect(
			decideAfterAbandon({ attempts: 1, maxAttempts: 5, kind: 'lease_stall', now: NOW }).errorCode
		).toBe(LEASE_STALL_ERROR_CODE);
		expect(abandonErrorCode('worker_death')).toBe(WORKER_DEATH_ERROR_CODE);
		expect(abandonErrorCode('lease_stall')).toBe(LEASE_STALL_ERROR_CODE);
	});
});

describe('classifyExecutionError (timeout provider vs échec local)', () => {
	it('un abort (budget de durée dépassé) est un timeout provider', () => {
		const err = new Error('aborted');
		err.name = 'AbortError';
		expect(classifyExecutionError(err).isProviderTimeout).toBe(true);
	});

	it('les codes réseau de timeout sont reconnus', () => {
		for (const code of ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT']) {
			expect(classifyExecutionError({ code, message: 'x' }).code).toBe(
				PROVIDER_TIMEOUT_ERROR_CODE
			);
		}
	});

	it('un 408/504 est un timeout provider', () => {
		expect(classifyExecutionError({ status: 504, message: 'gateway timeout' }).isProviderTimeout).toBe(
			true
		);
	});

	it('un bug local n’est PAS un timeout provider (et garde son code)', () => {
		const { code, isProviderTimeout } = classifyExecutionError(new TypeError('x is not a function'));
		expect(isProviderTimeout).toBe(false);
		expect(code).toBe('TypeError');
	});

	it('un 403 structurel reste local (la classification fine est JOB-003)', () => {
		expect(classifyExecutionError({ status: 403, code: 'Forbidden' }).isProviderTimeout).toBe(false);
	});

	it('l’erreur de budget porte le code de timeout provider', () => {
		expect(providerTimeoutError(1000).code).toBe(PROVIDER_TIMEOUT_ERROR_CODE);
	});

	it('la classification est idempotente (reclasser ne contredit pas)', () => {
		const once = classifyExecutionError(providerTimeoutError(1000));
		expect(once.code).toBe(PROVIDER_TIMEOUT_ERROR_CODE);
		expect(once.isProviderTimeout).toBe(true);
		expect(classifyExecutionError(once)).toEqual(once);
	});
});

describe('vocabulaires JOB-002', () => {
	it('deux natures d’abandon, pas davantage', () => {
		expect([...ABANDON_KINDS]).toEqual(['worker_death', 'lease_stall']);
	});

	it('le journal distingue abandon, échec et relâchement', () => {
		expect(ATTEMPT_OUTCOMES).toContain('abandoned');
		expect(ATTEMPT_OUTCOMES).toContain('released');
		expect(ATTEMPT_OUTCOMES).toContain('succeeded');
		expect(new Set(ATTEMPT_OUTCOMES).size).toBe(ATTEMPT_OUTCOMES.length);
	});

	it('une décision humaine est une issue à part entière (JOB-003/JOB-007)', () => {
		expect(ATTEMPT_OUTCOMES).toContain('requeued');
		expect(ATTEMPT_OUTCOMES).toContain('cancelled');
	});
});
