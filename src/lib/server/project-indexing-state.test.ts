/**
 * DASH-003 lot 2 chantier 2 — les invariants de l'onglet Indexation.
 *
 * Chaque bloc porte une CONTRE-ÉPREUVE : ce qui distingue l'état correct de l'état voisin qu'on
 * aurait écrit sans y penser. Un test qui ne vérifie que le cas nominal ne prouve pas qu'on n'a
 * pas confondu « jamais mesuré » et « mesuré à zéro ».
 */
import { describe, expect, it } from 'vitest';
import type { Freshness } from './home-state.js';
import {
	buildClassFilters,
	describeCanonical,
	describeInspectionFreshness,
	normalizeIndexClass,
	summarizeQuota,
	summarizeSitemap
} from './project-indexing-state.js';

const CLASSES = { indexed: 40, not_indexed: 12, excluded: 5, unknown: 3 };

describe('buildClassFilters — le compteur et son lien naissent du même descripteur', () => {
	it('chaque classe porte l’URL qui reproduit exactement ce qu’elle a compté', () => {
		const filters = buildClassFilters({
			classes: CLASSES,
			projectSlug: 'wildcat',
			activeClass: null
		});
		const notIndexed = filters.find((f) => f.value === 'not_indexed');
		expect(notIndexed?.count).toBe(12);
		expect(notIndexed?.href).toBe('/projects/wildcat/indexing?class=not_indexed');
	});

	it('« Toutes » compte la somme des classes, et son lien ne porte aucun filtre', () => {
		const [all] = buildClassFilters({
			classes: CLASSES,
			projectSlug: 'wildcat',
			activeClass: null
		});
		expect(all.value).toBeNull();
		expect(all.count).toBe(60);
		expect(all.href).toBe('/projects/wildcat/indexing');
	});

	it('une classe à zéro reste affichée avec son lien — un zéro mesuré est une information', () => {
		const filters = buildClassFilters({
			classes: { indexed: 3, not_indexed: 0, excluded: 0, unknown: 0 },
			projectSlug: 'wildcat',
			activeClass: null
		});
		expect(filters).toHaveLength(5);
		expect(filters.find((f) => f.value === 'not_indexed')?.count).toBe(0);
	});

	it('un seul filtre est actif à la fois, et c’est celui demandé', () => {
		const filters = buildClassFilters({
			classes: CLASSES,
			projectSlug: 'wildcat',
			activeClass: 'excluded'
		});
		expect(filters.filter((f) => f.active).map((f) => f.value)).toEqual(['excluded']);
	});

	it('CONTRE-ÉPREUVE : `excluded` porte sa note — c’est une décision du site, pas un échec', () => {
		const filters = buildClassFilters({
			classes: CLASSES,
			projectSlug: 'wildcat',
			activeClass: null
		});
		expect(filters.find((f) => f.value === 'excluded')?.note).toMatch(/décision/i);
	});
});

describe('normalizeIndexClass — une valeur inventée est écartée, jamais réinterprétée', () => {
	it('accepte les quatre classes du vocabulaire', () => {
		expect(normalizeIndexClass('indexed')).toBe('indexed');
		expect(normalizeIndexClass('not_indexed')).toBe('not_indexed');
		expect(normalizeIndexClass('excluded')).toBe('excluded');
		expect(normalizeIndexClass('unknown')).toBe('unknown');
	});

	it('CONTRE-ÉPREUVE : `noindex` ne devient pas `excluded` — deviner serait inventer', () => {
		expect(normalizeIndexClass('noindex')).toBeNull();
		expect(normalizeIndexClass('')).toBeNull();
		expect(normalizeIndexClass(null)).toBeNull();
	});
});

describe('describeInspectionFreshness — « jamais » n’est pas « à l’instant »', () => {
	const never: Freshness = { state: 'never', ageHours: null, lastSuccessAt: null };

	it('jamais inspecté se dit, et ne s’écrit jamais en heures', () => {
		const phrase = describeInspectionFreshness(never);
		expect(phrase).toMatch(/jamais inspecté/i);
		expect(phrase).not.toMatch(/0 h/);
	});

	it('CONTRE-ÉPREUVE : une inspection à l’instant rend une phrase DIFFÉRENTE', () => {
		const fresh: Freshness = { state: 'fresh', ageHours: 0, lastSuccessAt: '2026-07-26 09:00:00' };
		expect(describeInspectionFreshness(fresh)).not.toBe(describeInspectionFreshness(never));
		expect(describeInspectionFreshness(fresh)).toMatch(/0 h/);
	});

	it('un retard est dit comme un cycle d’échantillon dépassé, pas comme une panne', () => {
		const stale: Freshness = {
			state: 'stale',
			ageHours: 24 * 20,
			lastSuccessAt: '2026-07-06 09:00:00'
		};
		expect(describeInspectionFreshness(stale)).toMatch(/20 j/);
		expect(describeInspectionFreshness(stale)).toMatch(/échantillon/i);
	});
});

describe('summarizeSitemap — un seul snapshot n’est pas un diff vide', () => {
	const rows = [
		{ isAlternate: false },
		{ isAlternate: false },
		{ isAlternate: true }
	];

	it('le premier inventaire annonce qu’il n’a rien à quoi se comparer', () => {
		const s = summarizeSitemap({
			date: '2026-07-26',
			rows,
			previousDate: null,
			diff: null,
			files: 2,
			filesWithErrors: 0
		});
		expect(s.diff).toBeNull();
		expect(s.note).toMatch(/premier inventaire/i);
	});

	it('CONTRE-ÉPREUVE : deux snapshots identiques disent « identique », pas « premier »', () => {
		const s = summarizeSitemap({
			date: '2026-07-26',
			rows,
			previousDate: '2026-07-19',
			diff: { added: [], removed: [], changed: [], unchanged: 3 },
			files: 2,
			filesWithErrors: 0
		});
		expect(s.diff).not.toBeNull();
		expect(s.note).toMatch(/identique/i);
		expect(s.note).not.toMatch(/premier/i);
	});

	it('une alternate n’est pas une page : elle est comptée à part', () => {
		const s = summarizeSitemap({
			date: '2026-07-26',
			rows,
			previousDate: null,
			diff: null,
			files: 1,
			filesWithErrors: 0
		});
		expect(s.urls).toBe(2);
		expect(s.alternates).toBe(1);
	});

	it('jamais collecté est un état à part — ni « 0 URL », ni un diff', () => {
		const s = summarizeSitemap({
			date: null,
			rows: [],
			previousDate: null,
			diff: null,
			files: 0,
			filesWithErrors: 0
		});
		expect(s.date).toBeNull();
		expect(s.diff).toBeNull();
		expect(s.note).toMatch(/aucun inventaire/i);
	});

	it('un fichier en erreur est un fait interrogeable, pas un silence', () => {
		const s = summarizeSitemap({
			date: '2026-07-26',
			rows,
			previousDate: null,
			diff: null,
			files: 4,
			filesWithErrors: 1
		});
		expect(s.files).toBe(4);
		expect(s.filesWithErrors).toBe(1);
	});

	it('les retraits sont comptés et dits — un constat, jamais une désindexation', () => {
		const s = summarizeSitemap({
			date: '2026-07-26',
			rows,
			previousDate: '2026-07-19',
			diff: { added: ['a'], removed: ['b', 'c'], changed: [], unchanged: 1 },
			files: 1,
			filesWithErrors: 0
		});
		expect(s.diff?.removed).toEqual(['b', 'c']);
		expect(s.note).toMatch(/2 retirée/);
	});
});

describe('summarizeQuota — la file de dépense se dit entière', () => {
	const base = {
		dueNow: 4,
		oldestDueDate: '2026-07-01',
		today: '2026-07-26',
		maxAgeDays: 14,
		poolUsedToday: 34,
		poolTotal: 800,
		dailyBudgetPerProject: 40,
		unreadable: 0
	};
	const dueRows = [
		{ dueDate: '2026-07-01', reason: 'finding' as const, bucket: 'priority' as const },
		{ dueDate: '2026-07-24', reason: 'new' as const, bucket: 'priority' as const },
		{ dueDate: '2026-07-25', reason: 'changed' as const, bucket: 'priority' as const },
		{ dueDate: '2026-07-20', reason: 'sample' as const, bucket: 'sample' as const }
	];

	it('les échéances périmées sont comptées, pas absorbées dans le total', () => {
		const q = summarizeQuota({ ...base, dueRows });
		// Seule celle du 2026-07-01 dépasse 14 jours au 2026-07-26.
		expect(q.expired).toBe(1);
		expect(q.dueNow).toBe(4);
	});

	it('CONTRE-ÉPREUVE : une échéance du jour n’est jamais périmée', () => {
		const q = summarizeQuota({
			...base,
			dueRows: [{ dueDate: '2026-07-26', reason: 'new', bucket: 'priority' }]
		});
		expect(q.expired).toBe(0);
	});

	it('les raisons illisibles sont reportées telles quelles — écartées et DITES', () => {
		const q = summarizeQuota({ ...base, dueRows, unreadable: 3 });
		expect(q.unreadable).toBe(3);
	});

	it('les familles sortent dans l’ordre de service (urgent avant routine avant échantillon)', () => {
		const q = summarizeQuota({ ...base, dueRows });
		expect(q.byFamily.map((f) => f.key)).toEqual(['urgent', 'routine', 'sample']);
		expect(q.byFamily.find((f) => f.key === 'routine')?.count).toBe(2);
	});

	it('une famille absente ne s’affiche pas à zéro', () => {
		const q = summarizeQuota({
			...base,
			dueRows: [{ dueDate: '2026-07-25', reason: 'sample', bucket: 'sample' }]
		});
		expect(q.byFamily.map((f) => f.key)).toEqual(['sample']);
	});

	it('⭐ le pool se dit « au plus », jamais « il reste »', () => {
		const q = summarizeQuota({ ...base, dueRows });
		expect(q.poolNote).toMatch(/au plus/i);
		expect(q.poolNote).not.toMatch(/il reste/i);
		expect(q.poolNote).toMatch(/766/);
	});

	it('CONTRE-ÉPREUVE : un pool dépassé ne rend pas un reste négatif', () => {
		const q = summarizeQuota({ ...base, dueRows, poolUsedToday: 900 });
		expect(q.poolNote).toMatch(/Au plus 0 /);
	});
});

describe('describeCanonical — `null` veut dire incomparable', () => {
	it('deux canonicals absents ne produisent JAMAIS un accord', () => {
		const d = describeCanonical(null);
		expect(d.verdict).toBe('incomparable');
		expect(d.verdict).not.toBe('agree');
	});

	it('CONTRE-ÉPREUVE : deux canonicals égaux, eux, donnent un accord', () => {
		expect(describeCanonical(false).verdict).toBe('agree');
		expect(describeCanonical(true).verdict).toBe('mismatch');
	});
});
