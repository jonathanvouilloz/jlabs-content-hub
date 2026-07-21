import { describe, it, expect } from 'vitest';
import {
	deriveObservationFingerprint,
	computeWindowStart,
	isWithinWindow,
	assertBoundedPayload,
	OBSERVATION_DOMAINS,
	OBSERVATION_PROVIDERS,
	WINDOW_DAYS,
	MAX_OBSERVATION_PAYLOAD_BYTES,
	FINGERPRINT_SEP
} from './observation-state.js';

describe('vocabulaire SPEC §7.5', () => {
	it('expose 10 domaines d’observation', () => {
		expect(OBSERVATION_DOMAINS).toHaveLength(10);
		expect(new Set(OBSERVATION_DOMAINS).size).toBe(10); // pas de doublon
	});
	it('les providers couvrent les émetteurs attendus', () => {
		expect(OBSERVATION_PROVIDERS).toContain('gsc');
		expect(OBSERVATION_PROVIDERS).toContain('gmb');
		expect(OBSERVATION_PROVIDERS).toContain('indexing');
	});
});

describe('deriveObservationFingerprint', () => {
	it('assemble une clé déterministe des dimensions', () => {
		const dims = ['proj1', '2026-07-13', 'muay-thai-geneve', 'https://ex.ch/p', 'MOBILE'];
		const key = deriveObservationFingerprint('gsc_query_page', dims);
		expect(key).toBe(['gsc_query_page', ...dims].join(FINGERPRINT_SEP));
	});
	it('est déterministe (mêmes dimensions → même clé) — pas de doublon', () => {
		const parts = ['proj1', 'loc42', '2026-07-21', 'WEBSITE_CLICKS'];
		expect(deriveObservationFingerprint('gmb_insight', parts)).toBe(
			deriveObservationFingerprint('gmb_insight', parts)
		);
	});
	it('deux dimensions différentes → clés différentes', () => {
		expect(deriveObservationFingerprint('gmb_insight', ['p', 'l', 'd', 'A'])).not.toBe(
			deriveObservationFingerprint('gmb_insight', ['p', 'l', 'd', 'B'])
		);
	});
	it('rejette une liste vide', () => {
		expect(() => deriveObservationFingerprint('index', [])).toThrow();
	});
	it('rejette une dimension contenant le séparateur réservé', () => {
		expect(() =>
			deriveObservationFingerprint('index', ['proj', `a${FINGERPRINT_SEP}b`])
		).toThrow();
	});
});

describe('computeWindowStart', () => {
	it('calcule le début d’une fenêtre 7 jours (test positif)', () => {
		expect(computeWindowStart({ now: '2026-07-21', days: 7 })).toBe('2026-07-14');
	});
	it('couvre les fenêtres 28 et 90 jours', () => {
		expect(computeWindowStart({ now: '2026-07-21T00:00:00Z', days: 28 })).toBe('2026-06-23');
		expect(computeWindowStart({ now: '2026-07-21T00:00:00Z', days: 90 })).toBe('2026-04-22');
	});
	it('est déterministe pour un `now` donné', () => {
		const a = computeWindowStart({ now: '2026-07-21', days: 28 });
		const b = computeWindowStart({ now: '2026-07-21', days: 28 });
		expect(a).toBe(b);
	});
	it('accepte les trois fenêtres standard', () => {
		for (const d of WINDOW_DAYS) {
			expect(computeWindowStart({ now: '2026-07-21', days: d })).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});
	it('rejette une date invalide', () => {
		expect(() => computeWindowStart({ now: 'pas-une-date', days: 7 })).toThrow();
	});
});

describe('isWithinWindow', () => {
	it('inclut la borne de début et exclut l’antérieur', () => {
		expect(isWithinWindow('2026-07-14', '2026-07-14')).toBe(true);
		expect(isWithinWindow('2026-07-20', '2026-07-14')).toBe(true);
		expect(isWithinWindow('2026-07-13', '2026-07-14')).toBe(false);
	});
	it('tolère un timestamp complet en entrée', () => {
		expect(isWithinWindow('2026-07-15T09:30:00Z', '2026-07-14')).toBe(true);
	});
});

describe('assertBoundedPayload', () => {
	it('laisse passer null/vide', () => {
		expect(() => assertBoundedPayload(null, 'x')).not.toThrow();
		expect(() => assertBoundedPayload('', 'x')).not.toThrow();
	});
	it('laisse passer un payload sous le plafond', () => {
		expect(() => assertBoundedPayload('{"a":1}', 'x')).not.toThrow();
	});
	it('rejette un payload au-dessus du plafond', () => {
		const big = 'x'.repeat(MAX_OBSERVATION_PAYLOAD_BYTES + 1);
		expect(() => assertBoundedPayload(big, 'gsc payload')).toThrow();
	});
});
