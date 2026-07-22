import { describe, it, expect } from 'vitest';
import {
	DEFAULT_LEASE_MS,
	NO_HANDLER_ERROR_CODE,
	computeLeaseUntil,
	decideAfterFailure,
	deriveWorkerId,
	isLeaseExpired
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
