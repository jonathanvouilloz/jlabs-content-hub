import { describe, it, expect } from 'vitest';
import {
	classifyRunOutcome,
	computeBackoff,
	deriveIdempotencyKey,
	normalizeError,
	shouldDeadLetter,
	JOB_STATUSES,
	RUN_STATUSES,
	RUN_TYPES,
	STEP_STATUSES,
	TRIGGER_SOURCES
} from './monitoring-state.js';

describe('deriveIdempotencyKey', () => {
	it('assemble la clé au format SPEC §8.3', () => {
		expect(
			deriveIdempotencyKey({
				runType: 'weekly',
				projectSlug: 'wildcat',
				periodEnd: '2026-07-19',
				stepType: 'gsc-collect',
				schemaVersion: 3
			})
		).toBe('weekly:wildcat:2026-07-19:gsc-collect:3');
	});
	it('est déterministe (mêmes params → même clé)', () => {
		const args = {
			runType: 'daily' as const,
			projectSlug: 'barberconcept',
			periodEnd: '2026-07-21',
			stepType: 'indexing',
			schemaVersion: 1
		};
		expect(deriveIdempotencyKey(args)).toBe(deriveIdempotencyKey(args));
	});
});

describe('classifyRunOutcome', () => {
	it('aucun step → queued', () => {
		expect(classifyRunOutcome([])).toBe('queued');
	});
	it('un step encore en cours → running', () => {
		expect(classifyRunOutcome(['success', 'running'])).toBe('running');
		expect(classifyRunOutcome(['queued'])).toBe('running');
	});
	it('tous OK (success/skipped) → success', () => {
		expect(classifyRunOutcome(['success', 'skipped', 'success'])).toBe('success');
	});
	it('tous KO (failed/provider_unavailable) → failed', () => {
		expect(classifyRunOutcome(['failed', 'provider_unavailable'])).toBe('failed');
	});
	it('mélange OK + KO → partial (distingue succès/skip/échec/provider indispo)', () => {
		expect(classifyRunOutcome(['success', 'failed'])).toBe('partial');
		expect(classifyRunOutcome(['skipped', 'provider_unavailable'])).toBe('partial');
		expect(classifyRunOutcome(['success', 'skipped', 'failed', 'provider_unavailable'])).toBe('partial');
	});
});

describe('computeBackoff', () => {
	it('croît exponentiellement depuis la base', () => {
		expect(computeBackoff({ attempt: 0, baseMs: 1000, maxMs: 100000 })).toBe(1000);
		expect(computeBackoff({ attempt: 1, baseMs: 1000, maxMs: 100000 })).toBe(2000);
		expect(computeBackoff({ attempt: 3, baseMs: 1000, maxMs: 100000 })).toBe(8000);
	});
	it('plafonne à maxMs', () => {
		expect(computeBackoff({ attempt: 20, baseMs: 1000, maxMs: 5000 })).toBe(5000);
	});
	it('borne les attempts négatifs à 0', () => {
		expect(computeBackoff({ attempt: -5, baseMs: 1000, maxMs: 100000 })).toBe(1000);
	});
	it('est déterministe (pas de jitter)', () => {
		expect(computeBackoff({ attempt: 2 })).toBe(computeBackoff({ attempt: 2 }));
	});
});

describe('shouldDeadLetter', () => {
	it('sous le plafond → false', () => {
		expect(shouldDeadLetter({ attempts: 2, maxAttempts: 5 })).toBe(false);
	});
	it('au plafond ou au-delà → true', () => {
		expect(shouldDeadLetter({ attempts: 5, maxAttempts: 5 })).toBe(true);
		expect(shouldDeadLetter({ attempts: 7, maxAttempts: 5 })).toBe(true);
	});
});

describe('normalizeError', () => {
	it('normalise une Error native', () => {
		const e = new TypeError('boom');
		expect(normalizeError(e)).toEqual({ code: 'TypeError', message: 'boom' });
	});
	it('normalise une string', () => {
		expect(normalizeError('plain')).toEqual({ code: 'Error', message: 'plain' });
	});
	it('reprend code/message d’un objet', () => {
		expect(normalizeError({ code: 'RATE_LIMIT', message: 'trop d’appels' })).toEqual({
			code: 'RATE_LIMIT',
			message: 'trop d’appels'
		});
	});
	it('valeur inconnue → UnknownError', () => {
		expect(normalizeError(42)).toEqual({ code: 'UnknownError', message: '42' });
	});
	it('tronque un message très long', () => {
		const long = 'x'.repeat(5000);
		const { message } = normalizeError(new Error(long));
		expect(message.length).toBeLessThanOrEqual(2001);
		expect(message.endsWith('…')).toBe(true);
	});
});

describe('constantes de statut', () => {
	it('exposent les vocabulaires SPEC', () => {
		expect([...RUN_TYPES]).toEqual(['daily', 'weekly', 'monthly', 'manual', 'post_publish']);
		expect([...RUN_STATUSES]).toEqual(['queued', 'running', 'partial', 'success', 'failed', 'cancelled']);
		expect([...TRIGGER_SOURCES]).toEqual(['schedule', 'user', 'agent', 'webhook']);
		expect([...STEP_STATUSES]).toEqual([
			'queued',
			'running',
			'success',
			'skipped',
			'failed',
			'provider_unavailable'
		]);
		expect([...JOB_STATUSES]).toEqual(['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled']);
	});
});
