import { describe, it, expect } from 'vitest';
import {
	assertNoInlineSecret,
	classifyProjection,
	computeHealth,
	HEALTH_STATUSES,
	PROJECTION_STATUSES
} from './projection-state.js';

describe('classifyProjection', () => {
	it('hash identique au courant → duplicate', () => {
		expect(classifyProjection({ incomingHash: 'abc', currentHash: 'abc' })).toBe('duplicate');
	});
	it('hash différent → new_version', () => {
		expect(classifyProjection({ incomingHash: 'abc', currentHash: 'def' })).toBe('new_version');
	});
	it('pas de projection courante → new_version', () => {
		expect(classifyProjection({ incomingHash: 'abc', currentHash: null })).toBe('new_version');
		expect(classifyProjection({ incomingHash: 'abc' })).toBe('new_version');
	});
});

describe('assertNoInlineSecret', () => {
	it('accepte null / vide / contexte propre', () => {
		expect(() => assertNoInlineSecret(null, 'ctx')).not.toThrow();
		expect(() => assertNoInlineSecret('', 'ctx')).not.toThrow();
		expect(() =>
			assertNoInlineSecret(
				JSON.stringify({ slug: 'wildcat', domain: 'wildcat.ch', brand: { tone: 'direct' } }),
				'payload'
			)
		).not.toThrow();
	});

	it('rejette une clé secrète au premier niveau', () => {
		expect(() => assertNoInlineSecret(JSON.stringify({ private_key: 'x' }), 'payload')).toThrow();
		expect(() => assertNoInlineSecret(JSON.stringify({ password: 'x' }), 'config')).toThrow();
	});

	it('rejette une clé secrète imbriquée (objet ou tableau)', () => {
		expect(() =>
			assertNoInlineSecret(JSON.stringify({ auth: { access_token: 'x' } }), 'payload')
		).toThrow();
		expect(() =>
			assertNoInlineSecret(JSON.stringify({ creds: [{ refresh_token: 'x' }] }), 'payload')
		).toThrow();
	});

	it('détecte les variantes de casse / séparateurs', () => {
		expect(() => assertNoInlineSecret(JSON.stringify({ 'API-Key': 'x' }), 'config')).toThrow();
		expect(() => assertNoInlineSecret(JSON.stringify({ ClientSecret: 'x' }), 'config')).toThrow();
	});

	it('scanne le texte brut non-JSON', () => {
		expect(() => assertNoInlineSecret('service_account_json=...', 'config')).toThrow();
		expect(() => assertNoInlineSecret('juste du texte libre', 'config')).not.toThrow();
	});
});

describe('computeHealth', () => {
	it('ni succès ni erreur → unknown', () => {
		expect(computeHealth({})).toBe('unknown');
	});
	it('succès seul → healthy', () => {
		expect(computeHealth({ lastSuccessAt: '2026-07-21T10:00:00.000Z' })).toBe('healthy');
	});
	it('erreur seule → down', () => {
		expect(computeHealth({ lastErrorAt: '2026-07-21T10:00:00.000Z' })).toBe('down');
	});
	it('succès plus récent que l’erreur → healthy', () => {
		expect(
			computeHealth({ lastSuccessAt: '2026-07-21T12:00:00.000Z', lastErrorAt: '2026-07-21T10:00:00.000Z' })
		).toBe('healthy');
	});
	it('erreur plus récente que le succès → degraded (un succès existe)', () => {
		expect(
			computeHealth({ lastSuccessAt: '2026-07-21T10:00:00.000Z', lastErrorAt: '2026-07-21T12:00:00.000Z' })
		).toBe('degraded');
	});
});

describe('constantes de statut', () => {
	it('exposent les valeurs attendues', () => {
		expect([...PROJECTION_STATUSES]).toEqual(['current', 'stale', 'invalid']);
		expect([...HEALTH_STATUSES]).toEqual(['healthy', 'degraded', 'down', 'unknown']);
	});
});
