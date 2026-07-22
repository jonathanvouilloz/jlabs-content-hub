import { describe, it, expect } from 'vitest';
import {
	normalizeTimestamp,
	computeCutoff,
	isExpired,
	isPurgeable,
	requiresL4ForPurge,
	assertPurgeAuthorized,
	derivePeriod,
	canonicalDimensions,
	RETENTION_CATEGORIES,
	AGGREGATE_GRAINS,
	PURGE_RUN_STATUSES,
	type RetentionPolicyShape
} from './retention-state.js';

describe('vocabulaire SPEC §7.11', () => {
	it('catégories, grains, statuts', () => {
		expect(RETENTION_CATEGORIES).toEqual(['detail', 'aggregate', 'audit', 'report', 'debug']);
		expect(AGGREGATE_GRAINS).toEqual(['week', 'month', 'year']);
		expect(PURGE_RUN_STATUSES).toContain('aborted');
	});
});

describe('normalizeTimestamp', () => {
	it('date seule → minuit UTC', () => {
		expect(normalizeTimestamp('2026-07-22')).toBe('2026-07-22T00:00:00Z');
	});
	it("format 'YYYY-MM-DD HH:MM:SS' → ISO UTC", () => {
		expect(normalizeTimestamp('2026-07-22 09:30:00')).toBe('2026-07-22T09:30:00Z');
	});
	it('ISO déjà normalisé → inchangé', () => {
		expect(normalizeTimestamp('2026-07-22T09:30:00.000Z')).toBe('2026-07-22T09:30:00.000Z');
	});
});

describe('computeCutoff', () => {
	it('24 mois = 730 jours en arrière', () => {
		// 2× 365 (le 29 févr. 2024 est hors des deux fenêtres) → 2024-07-22
		expect(computeCutoff('2026-07-22T00:00:00Z', 730).slice(0, 10)).toBe('2024-07-22');
	});
});

describe('isExpired (rétention null = sans limite)', () => {
	const now = '2026-07-22T00:00:00Z';
	it('rétention null → jamais expiré (agrégats/audit/findings)', () => {
		expect(isExpired({ timestamp: '2000-01-01', retentionDays: null, now })).toBe(false);
		expect(isExpired({ timestamp: '2000-01-01', retentionDays: undefined, now })).toBe(false);
	});
	it('plus vieux que la rétention → expiré', () => {
		expect(isExpired({ timestamp: '2023-01-01', retentionDays: 730, now })).toBe(true);
	});
	it('dans la fenêtre → non expiré', () => {
		expect(isExpired({ timestamp: '2026-07-01', retentionDays: 730, now })).toBe(false);
	});
	it('gère le format métier YYYY-MM-DD HH:MM:SS', () => {
		expect(isExpired({ timestamp: '2023-01-01 12:00:00', retentionDays: 90, now })).toBe(true);
	});
});

describe('isPurgeable (refus par défaut, aucun agrégat requis supprimé)', () => {
	const detail: RetentionPolicyShape = {
		category: 'detail',
		retentionDays: 730,
		protected: false,
		active: true
	};
	it('détail actif, rétention finie, non protégé → purgeable', () => {
		expect(isPurgeable(detail)).toBe(true);
	});
	it('protégé → jamais purgeable', () => {
		expect(isPurgeable({ ...detail, protected: true })).toBe(false);
	});
	it('rétention infinie → jamais purgeable (agrégat/audit/report)', () => {
		expect(isPurgeable({ ...detail, retentionDays: null })).toBe(false);
	});
	it('inactif → non purgeable', () => {
		expect(isPurgeable({ ...detail, active: false })).toBe(false);
	});
	it('champ active absent → actif (défauts §7.11)', () => {
		const { category, retentionDays, protected: p } = detail;
		expect(isPurgeable({ category, retentionDays, protected: p })).toBe(true);
	});
});

describe('requiresL4ForPurge / assertPurgeAuthorized (audit = L4)', () => {
	it('catégorie audit exige L4', () => {
		expect(requiresL4ForPurge({ category: 'audit' })).toBe(true);
	});
	it('flag requiresL4 explicite', () => {
		expect(requiresL4ForPurge({ category: 'detail', requiresL4: true })).toBe(true);
	});
	it('détail ordinaire → pas de L4', () => {
		expect(requiresL4ForPurge({ category: 'detail' })).toBe(false);
	});
	it('purge audit sans L4 → throw', () => {
		expect(() =>
			assertPurgeAuthorized({ policy: { category: 'audit' }, approvalLevel: 'L2' })
		).toThrow(/L4/);
	});
	it('purge audit avec L4 → ok', () => {
		expect(() =>
			assertPurgeAuthorized({ policy: { category: 'audit' }, approvalLevel: 'L4' })
		).not.toThrow();
	});
	it('purge détail sans approbation → ok', () => {
		expect(() => assertPurgeAuthorized({ policy: { category: 'detail' } })).not.toThrow();
	});
});

describe('derivePeriod (buckets déterministes)', () => {
	it('année : 1er janvier → 31 décembre', () => {
		expect(derivePeriod('2026-07-22', 'year')).toEqual({
			periodStart: '2026-01-01',
			periodEnd: '2026-12-31'
		});
	});
	it('mois : 1er → dernier jour (février bissextile)', () => {
		expect(derivePeriod('2024-02-15', 'month')).toEqual({
			periodStart: '2024-02-01',
			periodEnd: '2024-02-29'
		});
	});
	it('mois : février non bissextile', () => {
		expect(derivePeriod('2026-02-10', 'month')).toEqual({
			periodStart: '2026-02-01',
			periodEnd: '2026-02-28'
		});
	});
	it('semaine : lundi → dimanche (2026-07-22 = mercredi)', () => {
		expect(derivePeriod('2026-07-22', 'week')).toEqual({
			periodStart: '2026-07-20',
			periodEnd: '2026-07-26'
		});
	});
	it('semaine : un dimanche reste dans SA semaine (lundi précédent)', () => {
		// 2026-07-26 est un dimanche → lundi = 2026-07-20
		expect(derivePeriod('2026-07-26', 'week')).toEqual({
			periodStart: '2026-07-20',
			periodEnd: '2026-07-26'
		});
	});
	it('semaine à cheval sur deux mois', () => {
		// 2026-08-01 = samedi → lundi = 2026-07-27
		expect(derivePeriod('2026-08-01', 'week')).toEqual({
			periodStart: '2026-07-27',
			periodEnd: '2026-08-02'
		});
	});
});

describe('canonicalDimensions', () => {
	it('déterministe, normalise null/undefined', () => {
		expect(canonicalDimensions(['q', 'p', undefined])).toBe(canonicalDimensions(['q', 'p', null]));
	});
	it('ordre significatif', () => {
		expect(canonicalDimensions(['a', 'b'])).not.toBe(canonicalDimensions(['b', 'a']));
	});
});
