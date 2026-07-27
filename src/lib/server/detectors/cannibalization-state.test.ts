import { describe, it, expect } from 'vitest';
import {
	CANNIBALIZATION_DEFAULTS,
	CANNIBALIZATION_SKILL,
	DETECTOR_CANNIBALIZATION,
	MAX_EVIDENCE_CONFLICT_URLS,
	MAX_EVIDENCE_RAW_URLS,
	TRACKING_PARAMS,
	URL_NORMALIZATION_RULE,
	aggregateByQueryUrl,
	buildCannibalizationEvidence,
	buildCannibalizationReason,
	buildCannibalizationTitle,
	classifyShape,
	computeConflictMetrics,
	countSwitches,
	deriveCannibalizationSeverity,
	isProbableConflict,
	longestStreakOf,
	normalizePageUrl,
	overlapWeeksOf,
	resolveCannibalizationThresholds,
	runCannibalizationPass,
	scoreCannibalization,
	significanceThreshold,
	unitKey,
	urlSetKey,
	weekLeaders,
	type CannibalizationPassInput,
	type CannibalizationUnit,
	type ConflictMetrics,
	type UrlSide
} from './cannibalization-state.js';
import { MAX_EVIDENCE_IDS, type ObservationRow } from '../detector-state.js';
import { computePriorityScore } from '../finding-state.js';
import type { WindowCompleteness } from '../gsc-windows-state.js';

const T = CANNIBALIZATION_DEFAULTS;

/** Fenêtre de 4 semaines complètes. */
const WEEKS = ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22'];

const PAGE_A = 'https://site.test/a';
const PAGE_B = 'https://site.test/b';
const PAGE_C = 'https://site.test/c';

function row(
	over: Partial<ObservationRow> & { query: string; page: string }
): ObservationRow {
	const periodStart = over.periodStart ?? WEEKS[0];
	return {
		id: over.id ?? `${over.query}|${over.page}|${periodStart}`,
		query: over.query,
		page: over.page,
		clicks: over.clicks ?? 0,
		impressions: over.impressions ?? 0,
		position: over.position ?? 10,
		periodStart
	};
}

/**
 * Étale des impressions d'un couple query×page sur les semaines de la fenêtre.
 *
 * Une semaine à zéro impression ne produit AUCUNE ligne : GSC n'émet pas de ligne pour
 * une page qui n'est pas sortie. En fabriquer une ferait croire au détecteur que les
 * deux URLs coexistaient cette semaine-là, et inventerait un chevauchement.
 */
function spread(
	query: string,
	page: string,
	perWeek: number[],
	over: { clicks?: number; position?: number; weeks?: string[] } = {}
): ObservationRow[] {
	const weeks = over.weeks ?? WEEKS;
	return weeks
		.map((periodStart, i) => ({ periodStart, impressions: perWeek[i] ?? 0, i }))
		.filter((w) => w.impressions > 0)
		.map((w) =>
			row({
				query,
				page,
				periodStart: w.periodStart,
				impressions: w.impressions,
				clicks: w.i === 0 ? (over.clicks ?? 0) : 0,
				position: over.position
			})
		);
}

function pass(rows: ObservationRow[], overrides: Partial<typeof T> = {}) {
	const input: CannibalizationPassInput = {
		rows,
		windowWeeks: WEEKS,
		thresholds: resolveCannibalizationThresholds(overrides)
	};
	return runCannibalizationPass(input);
}

/** Un conflit franc : deux URLs à parts comparables, présentes toutes les semaines. */
function frankConflict(query = 'kw'): ObservationRow[] {
	return [
		...spread(query, PAGE_A, [40, 40, 40, 40], { clicks: 6, position: 4 }),
		...spread(query, PAGE_B, [30, 30, 30, 30], { clicks: 3, position: 7 })
	];
}

const COMPLETE: WindowCompleteness = {
	complete: true,
	coverage: 1,
	weeks: 4,
	expectedWeeks: 4,
	fresh: true,
	caveats: []
};

function urlSide(over: Partial<UrlSide> & { url: string }): UrlSide {
	return {
		url: over.url,
		rawUrls: over.rawUrls ?? [over.url],
		clicks: over.clicks ?? 0,
		impressions: over.impressions ?? 0,
		ctr: over.ctr ?? 0,
		position: over.position ?? 10,
		weeksSeen: over.weeksSeen ?? (over.weekly ? over.weekly.size : 0),
		weekly: over.weekly ?? new Map(),
		observationIds: over.observationIds ?? []
	};
}

function metricsOf(over: Partial<ConflictMetrics> = {}): ConflictMetrics {
	return {
		queryImpressions: 280,
		conflictImpressions: 280,
		conflictClicks: 9,
		significanceThreshold: 42,
		urlCount: 2,
		observedUrlCount: 2,
		rawUrlCount: 2,
		dominance: 0.57,
		alternation: 0,
		switches: 0,
		overlapWeeks: 4,
		overlapRatio: 1,
		longestStreak: 4,
		currentlyOverlapping: true,
		bestPosition: 4,
		positionSpread: 3,
		misallocation: 0,
		...over
	};
}

function unitOf(over: Partial<CannibalizationUnit> = {}): CannibalizationUnit {
	const metrics = over.metrics ?? metricsOf();
	return {
		query: over.query ?? 'kw',
		urls: over.urls ?? [
			urlSide({ url: PAGE_A, impressions: 160, clicks: 6, position: 4 }),
			urlSide({ url: PAGE_B, impressions: 120, clicks: 3, position: 7 })
		],
		marginalUrlCount: over.marginalUrlCount ?? 0,
		metrics,
		shape: over.shape ?? 'split',
		probable: over.probable ?? true,
		leaders: over.leaders ?? WEEKS.map((week) => ({ week, url: PAGE_A, impressions: 40 }))
	};
}

// ── 1. normalizePageUrl ─────────────────────────────────────────────

describe('normalizePageUrl — le repli qui empêche les faux conflits', () => {
	it('supprime le fragment : deux ancres du même article sont UNE page', () => {
		expect(normalizePageUrl('https://site.test/blog/article#section-2')).toBe(
			'https://site.test/blog/article'
		);
		expect(normalizePageUrl('https://site.test/blog/article#autre')).toBe(
			normalizePageUrl('https://site.test/blog/article')
		);
	});

	it('force https et retire www', () => {
		expect(normalizePageUrl('http://www.site.test/a')).toBe('https://site.test/a');
		expect(normalizePageUrl('https://www.site.test/a')).toBe(normalizePageUrl('http://site.test/a'));
	});

	it('retire le slash final mais garde la racine à "/"', () => {
		expect(normalizePageUrl('https://site.test/a/')).toBe('https://site.test/a');
		expect(normalizePageUrl('https://site.test/')).toBe('https://site.test/');
		expect(normalizePageUrl('https://site.test')).toBe('https://site.test/');
	});

	it('abaisse la casse de l’hôte mais PRÉSERVE celle du chemin', () => {
		expect(normalizePageUrl('https://SITE.test/Article')).toBe('https://site.test/Article');
		expect(normalizePageUrl('https://site.test/Article')).not.toBe('https://site.test/article');
	});

	it('⭐ CONSERVE la query string : ?page=4 est une autre ressource que la racine', () => {
		expect(normalizePageUrl('https://www.site.test/?f9688240_page=4')).toBe(
			'https://site.test/?f9688240_page=4'
		);
		expect(normalizePageUrl('https://site.test/?page=4')).not.toBe(normalizePageUrl('https://site.test/'));
	});

	it('retire les paramètres de tracking et TRIE les clés restantes', () => {
		expect(normalizePageUrl('https://site.test/a?utm_source=x&b=2&a=1')).toBe(
			'https://site.test/a?a=1&b=2'
		);
		for (const p of TRACKING_PARAMS) {
			expect(normalizePageUrl(`https://site.test/a?${p}=zz`)).toBe('https://site.test/a');
		}
	});

	it('déplie le percent-encoding : /coupe-%C3%A9t%C3%A9 et /coupe-été sont la même page', () => {
		expect(normalizePageUrl('https://site.test/blog/coupe-%C3%A9t%C3%A9')).toBe(
			normalizePageUrl('https://site.test/blog/coupe-été')
		);
	});

	it('une URL non parsable retombe sans exception, fragment coupé', () => {
		expect(() => normalizePageUrl('pas une url#frag')).not.toThrow();
		expect(normalizePageUrl('pas une url#frag')).toBe('pas une url');
		expect(() => normalizePageUrl('https://site.test/%')).not.toThrow();
	});

	it('est IDEMPOTENTE : f(f(x)) === f(x)', () => {
		const samples = [
			'http://www.site.test/blog/article#a',
			'https://site.test/a/',
			'https://site.test/?utm_source=x&b=2',
			'https://site.test/blog/coupe-%C3%A9t%C3%A9',
			'pas une url#frag'
		];
		for (const s of samples) {
			const once = normalizePageUrl(s);
			expect(normalizePageUrl(once)).toBe(once);
		}
	});

	it('la règle de repli est versionnée et non vide', () => {
		expect(URL_NORMALIZATION_RULE).toBe('gsc_page_url@1');
		expect(DETECTOR_CANNIBALIZATION).toBe('cannibalization@1');
		expect(CANNIBALIZATION_SKILL).toBe('seo-cannibalisation');
	});
});

// ── 2. aggregateByQueryUrl ──────────────────────────────────────────

describe('aggregateByQueryUrl — le grain hebdo, préservé', () => {
	it('replie devices ET variantes d’URL sous une seule clé, en gardant les formes brutes', () => {
		const rows = [
			row({ query: 'kw', page: 'https://site.test/a', impressions: 10, id: 'o1' }),
			row({ query: 'kw', page: 'https://site.test/a#top', impressions: 5, id: 'o2' }),
			row({ query: 'kw', page: 'http://www.site.test/a/', impressions: 3, id: 'o3' })
		];
		const urls = aggregateByQueryUrl(rows).get('kw')!;
		expect(urls.size).toBe(1);
		const side = urls.get('https://site.test/a')!;
		expect(side.impressions).toBe(18);
		expect(side.rawUrls).toEqual([
			'http://www.site.test/a/',
			'https://site.test/a',
			'https://site.test/a#top'
		]);
		expect(side.observationIds).toEqual(['o1', 'o2', 'o3']);
	});

	it('pondère la position par les impressions, jamais une moyenne simple', () => {
		const rows = [
			row({ query: 'kw', page: PAGE_A, impressions: 1000, position: 2 }),
			row({ query: 'kw', page: PAGE_A, impressions: 10, position: 90, id: 'x' })
		];
		const side = aggregateByQueryUrl(rows).get('kw')!.get(PAGE_A)!;
		expect(side.position).toBeCloseTo((1000 * 2 + 10 * 90) / 1010, 9);
	});

	it('garde une entrée hebdo par period_start — sans quoi l’alternance disparaît', () => {
		const rows = spread('kw', PAGE_A, [10, 20, 0, 40]);
		const side = aggregateByQueryUrl(rows).get('kw')!.get(PAGE_A)!;
		expect([...side.weekly.entries()].sort()).toEqual([
			[WEEKS[0], 10],
			[WEEKS[1], 20],
			[WEEKS[3], 40]
		]);
		expect(side.weeksSeen).toBe(3);
	});
});

// ── 3. Significativité ──────────────────────────────────────────────

describe('significativité — le plancher et la part se relaient', () => {
	it('θ = max(plancher, part × T) exactement', () => {
		expect(significanceThreshold(24, T)).toBe(5); // max(5, 3.6)
		expect(significanceThreshold(3152, T)).toBeCloseTo(472.8, 9); // max(5, 472.8)
		expect(significanceThreshold(0, T)).toBe(5);
	});

	it('sur une petite requête locale, c’est le plancher qui décide', () => {
		// T = 24 → θ = 5. Une URL à 6 impressions compte, une à 4 non.
		const rows = [
			...spread('kw', PAGE_A, [5, 5, 4, 4]),
			...spread('kw', PAGE_B, [2, 2, 1, 1])
		];
		const r = pass(rows, { minQueryImpressions: 1 });
		expect(r.selection.totalMatched).toBe(1);
		expect(r.selection.matched[0].metrics.urlCount).toBe(2);
	});

	it('sur une grosse requête, c’est la part qui décide : une URL à 2 % ne compte pas', () => {
		const rows = [
			...spread('kw', PAGE_A, [800, 800, 800, 800]),
			...spread('kw', PAGE_B, [15, 15, 15, 15])
		];
		const r = pass(rows);
		expect(r.selection.totalMatched).toBe(0);
		expect(r.singleUrl).toBe(1);
	});

	it('une seule URL significative n’est pas un candidat, et c’est compté', () => {
		const r = pass(spread('kw', PAGE_A, [40, 40, 40, 40]));
		expect(r.selection.totalMatched).toBe(0);
		expect(r.singleUrl).toBe(1);
	});

	it('⭐ S(q) exclut les marginales : la dominance ne se dilue pas sur la longue traîne', () => {
		const rows = [
			...spread('kw', PAGE_A, [100, 100, 100, 100]),
			...spread('kw', PAGE_B, [80, 80, 80, 80]),
			// 6 URLs marginales sous le seuil : présentes, jamais dans le dénominateur.
			...Array.from({ length: 6 }, (_, i) =>
				spread('kw', `https://site.test/m${i}`, [6, 6, 6, 6])
			).flat()
		];
		const r = pass(rows);
		const u = r.selection.matched[0];
		expect(u.metrics.urlCount).toBe(2);
		expect(u.marginalUrlCount).toBe(6);
		expect(u.metrics.queryImpressions).toBe(864);
		expect(u.metrics.conflictImpressions).toBe(720);
		// Avec T au dénominateur la dominance vaudrait 400/864 ≈ 0.46 : on serait passé
		// d'un partage 55/45 à un « conflit équilibré » fabriqué par la traîne.
		expect(u.metrics.dominance).toBeCloseTo(400 / 720, 9);
	});
});

// ── 4. Dominance, alternance, durée, chevauchement ──────────────────

describe('les quatre grandeurs', () => {
	const a = urlSide({
		url: PAGE_A,
		impressions: 100,
		weekly: new Map([
			[WEEKS[0], 40],
			[WEEKS[2], 30],
			[WEEKS[3], 30]
		])
	});
	const b = urlSide({
		url: PAGE_B,
		impressions: 60,
		weekly: new Map([
			[WEEKS[0], 10],
			[WEEKS[2], 40],
			[WEEKS[3], 10]
		])
	});

	it('le CHEVAUCHEMENT ne retient que les semaines où DEUX URLs sont sorties', () => {
		expect(overlapWeeksOf([a, b], WEEKS)).toEqual([WEEKS[0], WEEKS[2], WEEKS[3]]);
	});

	it('⭐ l’alternance se compte sur la sous-suite overlap, pas sur la fenêtre', () => {
		// Semaines de chevauchement : w1, w3, w4. Meneurs : A, B, A → 2 bascules.
		// w2 (absente du chevauchement) ne rompt PAS la comparaison w1 → w3.
		const overlap = overlapWeeksOf([a, b], WEEKS);
		const leaders = [
			{ week: WEEKS[0], url: PAGE_A, impressions: 40 },
			{ week: WEEKS[2], url: PAGE_B, impressions: 40 },
			{ week: WEEKS[3], url: PAGE_A, impressions: 30 }
		];
		const m = computeConflictMetrics({
			significant: [a, b],
			allUrls: [a, b],
			queryImpressions: 160,
			threshold: 24,
			overlap,
			leaders,
			windowWeeks: WEEKS
		});
		expect(m.switches).toBe(2);
		expect(m.alternation).toBe(1);
		expect(m.overlapWeeks).toBe(3);
		expect(m.overlapRatio).toBeCloseTo(3 / 4, 9);
	});

	it('⭐ streak ≠ duration : un trou de collecte n’est pas une fin de conflit', () => {
		const overlap = [WEEKS[0], WEEKS[2], WEEKS[3]];
		expect(overlap.length).toBe(3);
		expect(longestStreakOf(overlap, WEEKS)).toBe(2);
	});

	it('currentlyOverlapping suit la DERNIÈRE semaine de la fenêtre', () => {
		expect(longestStreakOf([WEEKS[0], WEEKS[1]], WEEKS)).toBe(2);
		const m = computeConflictMetrics({
			significant: [a, b],
			allUrls: [a, b],
			queryImpressions: 160,
			threshold: 24,
			overlap: [WEEKS[0], WEEKS[1]],
			leaders: [{ week: WEEKS[0], url: PAGE_A, impressions: 40 }],
			windowWeeks: WEEKS
		});
		expect(m.currentlyOverlapping).toBe(false);
	});

	it('le meneur d’une semaine est départagé LEXICOGRAPHIQUEMENT à égalité', () => {
		const x = urlSide({ url: 'https://site.test/zzz', weekly: new Map([[WEEKS[0], 10]]) });
		const y = urlSide({ url: 'https://site.test/aaa', weekly: new Map([[WEEKS[0], 10]]) });
		// Quel que soit l'ordre d'entrée, le meneur est le même.
		expect(weekLeaders([x, y], [WEEKS[0]])[0].url).toBe('https://site.test/aaa');
		expect(weekLeaders([y, x], [WEEKS[0]])[0].url).toBe('https://site.test/aaa');
	});

	it('countSwitches ne compte que les changements de meneur', () => {
		expect(countSwitches([])).toBe(0);
		expect(countSwitches([{ week: 'w', url: PAGE_A, impressions: 1 }])).toBe(0);
		expect(
			countSwitches([
				{ week: 'w1', url: PAGE_A, impressions: 1 },
				{ week: 'w2', url: PAGE_A, impressions: 1 },
				{ week: 'w3', url: PAGE_B, impressions: 1 }
			])
		).toBe(1);
	});

	it('misallocation = position de la dominante − meilleure position, bornée à ≥ 0', () => {
		const rows = [
			...spread('kw', PAGE_A, [50, 50, 50, 50], { position: 9 }),
			...spread('kw', PAGE_B, [40, 40, 40, 40], { position: 4 })
		];
		const m = pass(rows).selection.matched[0].metrics;
		expect(m.bestPosition).toBeCloseTo(4, 9);
		expect(m.misallocation).toBeCloseTo(5, 9);

		const inverse = [
			...spread('kw', PAGE_A, [50, 50, 50, 50], { position: 4 }),
			...spread('kw', PAGE_B, [40, 40, 40, 40], { position: 9 })
		];
		expect(pass(inverse).selection.matched[0].metrics.misallocation).toBe(0);
	});
});

// ── 5. Remplacement ≠ cannibalisation ───────────────────────────────

describe('⭐ le REMPLACEMENT n’est pas une cannibalisation', () => {
	it('deux URLs significatives qui ne se croisent jamais ne produisent RIEN', () => {
		const rows = [
			...spread('kw', PAGE_A, [80, 80, 0, 0]),
			...spread('kw', PAGE_B, [0, 0, 80, 80])
		];
		const r = pass(rows);
		expect(r.selection.totalMatched).toBe(0);
		expect(r.replacements).toBe(1);
		expect(r.belowPersistence).toBe(1);
	});

	it('les mêmes URLs qui se chevauchent 2 semaines produisent un conflit', () => {
		const rows = [
			...spread('kw', PAGE_A, [80, 80, 40, 0]),
			...spread('kw', PAGE_B, [0, 40, 80, 80])
		];
		const r = pass(rows);
		expect(r.replacements).toBe(0);
		expect(r.selection.totalMatched).toBe(1);
		expect(r.selection.matched[0].metrics.overlapWeeks).toBe(2);
	});
});

// ── 6. Le gate DUR de persistance ───────────────────────────────────

describe('⭐ persistance : gate dur, jamais un plafond', () => {
	it('une seule semaine de chevauchement n’écrit RIEN — et c’est compté', () => {
		const rows = [
			...spread('kw', PAGE_A, [0, 0, 0, 80]),
			...spread('kw', PAGE_B, [0, 0, 0, 60])
		];
		const r = pass(rows);
		expect(r.selection.totalMatched).toBe(0);
		expect(r.belowPersistence).toBe(1);
		expect(r.replacements).toBe(0);
	});

	it('deux semaines suffisent', () => {
		const rows = [
			...spread('kw', PAGE_A, [0, 0, 80, 80]),
			...spread('kw', PAGE_B, [0, 0, 60, 60])
		];
		const r = pass(rows);
		expect(r.selection.totalMatched).toBe(1);
		expect(r.belowPersistence).toBe(0);
	});

	it('le seuil est configurable et reste dur', () => {
		const rows = [
			...spread('kw', PAGE_A, [0, 80, 80, 80]),
			...spread('kw', PAGE_B, [0, 60, 60, 60])
		];
		expect(pass(rows, { minOverlapWeeks: 3 }).selection.totalMatched).toBe(1);
		expect(pass(rows, { minOverlapWeeks: 4 }).selection.totalMatched).toBe(0);
		expect(pass(rows, { minOverlapWeeks: 4 }).belowPersistence).toBe(1);
	});
});

// ── 7. Forme mécanique et conflit probable ──────────────────────────

describe('classifyShape / isProbableConflict', () => {
	it('alternating gagne sur toutes les autres formes', () => {
		const m = metricsOf({ switches: 1, dominance: 0.95, positionSpread: 40 });
		expect(classifyShape(m, T)).toBe('alternating');
	});

	it('stacked passe avant dominant quand le meneur ne change pas', () => {
		expect(classifyShape(metricsOf({ positionSpread: 20, dominance: 0.95 }), T)).toBe('stacked');
	});

	it('dominant à partir du plafond, split en dessous', () => {
		expect(classifyShape(metricsOf({ dominance: 0.8, positionSpread: 3 }), T)).toBe('dominant');
		expect(classifyShape(metricsOf({ dominance: 0.79, positionSpread: 3 }), T)).toBe('split');
	});

	it('les frontières sont inclusives côté seuil', () => {
		expect(classifyShape(metricsOf({ positionSpread: 19.9, dominance: 0.5 }), T)).toBe('split');
		expect(classifyShape(metricsOf({ positionSpread: 20, dominance: 0.5 }), T)).toBe('stacked');
	});

	it('alternating et split sont probables par nature', () => {
		expect(isProbableConflict('alternating', metricsOf({ misallocation: 0 }), T)).toBe(true);
		expect(isProbableConflict('split', metricsOf({ misallocation: 0 }), T)).toBe(true);
	});

	it('⭐ un mauvais aiguillage promeut dominant et stacked en probable', () => {
		expect(isProbableConflict('dominant', metricsOf({ misallocation: 1.9 }), T)).toBe(false);
		expect(isProbableConflict('dominant', metricsOf({ misallocation: 2 }), T)).toBe(true);
		expect(isProbableConflict('stacked', metricsOf({ misallocation: 2 }), T)).toBe(true);
	});
});

// ── 8. resolveCannibalizationThresholds ─────────────────────────────

describe('resolveCannibalizationThresholds', () => {
	it('sans override, rend les défauts', () => {
		expect(resolveCannibalizationThresholds()).toEqual(T);
		expect(resolveCannibalizationThresholds(null)).toEqual(T);
	});

	it('ignore silencieusement NaN, Infinity et les négatifs', () => {
		const out = resolveCannibalizationThresholds({
			minUrlImpressions: Number.NaN,
			minQueryImpressions: Number.POSITIVE_INFINITY,
			maxCandidates: -1
		});
		expect(out.minUrlImpressions).toBe(T.minUrlImpressions);
		expect(out.minQueryImpressions).toBe(T.minQueryImpressions);
		expect(out.maxCandidates).toBe(T.maxCandidates);
	});

	it('⭐ clampe relativeShare et dominanceCeiling dans ]0,1] — 0 les désactiverait', () => {
		expect(resolveCannibalizationThresholds({ relativeShare: 0 }).relativeShare).toBe(
			T.relativeShare
		);
		expect(resolveCannibalizationThresholds({ relativeShare: 1.5 }).relativeShare).toBe(
			T.relativeShare
		);
		expect(resolveCannibalizationThresholds({ relativeShare: 0.3 }).relativeShare).toBe(0.3);
		expect(resolveCannibalizationThresholds({ dominanceCeiling: 0 }).dominanceCeiling).toBe(
			T.dominanceCeiling
		);
		expect(resolveCannibalizationThresholds({ dominanceCeiling: 1 }).dominanceCeiling).toBe(1);
	});

	it('normalise les motifs de bruit et jette les vides', () => {
		const out = resolveCannibalizationThresholds({
			excludeQueryPatterns: ['  MaRque ', '', '   ', 'autre']
		});
		expect(out.excludeQueryPatterns).toEqual(['marque', 'autre']);
	});

	it('le bruit configuré écarte la requête AVANT tout le reste', () => {
		const r = pass(frankConflict('marque genève'), { excludeQueryPatterns: ['marque'] });
		expect(r.excludedByNoise).toBe(1);
		expect(r.selection.totalMatched).toBe(0);
		expect(r.measurableQueries.size).toBe(0);
	});
});

// ── 9. runCannibalizationPass ───────────────────────────────────────

describe('runCannibalizationPass', () => {
	it('une fenêtre plus courte que la persistance minimale rend un skippedReason', () => {
		const r = runCannibalizationPass({
			rows: frankConflict(),
			windowWeeks: [WEEKS[0]],
			thresholds: T
		});
		expect(r.skippedReason).toContain('fenêtre trop courte');
		expect(r.selection.totalMatched).toBe(0);
		expect(r.measurableQueries.size).toBe(0);
	});

	it('⭐ une fenêtre valide sans conflit rend skippedReason === null', () => {
		const r = pass(spread('kw', PAGE_A, [40, 40, 40, 40]));
		expect(r.skippedReason).toBeNull();
		expect(r.selection.totalMatched).toBe(0);
	});

	it('la portée contient les requêtes présentes AU-DESSUS du plancher, et pas les autres', () => {
		const rows = [
			...spread('grosse', PAGE_A, [40, 40, 40, 40]),
			...spread('petite', PAGE_A, [2, 2, 2, 2])
		];
		const r = pass(rows);
		expect(r.measurableQueries.has('grosse')).toBe(true);
		expect(r.measurableQueries.has('petite')).toBe(false);
	});

	it('⭐ la portée est calculée AVANT la significativité : une requête guérie y reste', () => {
		// Une seule URL : plus de conflit. La requête doit rester MESURABLE, sinon le
		// finding existant sortirait de la portée au lieu de se résoudre.
		const r = pass(spread('kw', PAGE_A, [40, 40, 40, 40]));
		expect(r.singleUrl).toBe(1);
		expect(r.measurableQueries.has('kw')).toBe(true);
	});

	it('le volume de requête écarte un candidat, et le compte à part', () => {
		const rows = [...spread('kw', PAGE_A, [6, 6]), ...spread('kw', PAGE_B, [5, 5])];
		const r = pass(rows);
		expect(r.belowVolume).toBe(1);
		expect(r.singleUrl).toBe(0);
		expect(r.selection.totalMatched).toBe(0);
	});

	it('compte les variantes d’URL repliées', () => {
		const rows = [
			...spread('kw', PAGE_A, [40, 40, 40, 40]),
			...spread('kw', `${PAGE_A}#top`, [10, 10, 10, 10]),
			...spread('kw', PAGE_B, [30, 30, 30, 30])
		];
		const r = pass(rows);
		expect(r.urlVariantsCollapsed).toBe(1);
		expect(r.selection.matched[0].metrics.observedUrlCount).toBe(2);
		expect(r.selection.matched[0].metrics.rawUrlCount).toBe(3);
	});

	it('⭐ la troncature laisse la closure COMPLÈTE', () => {
		const rows = Array.from({ length: 5 }, (_, i) => frankConflict(`kw${i}`)).flat();
		const r = pass(rows, { maxCandidates: 2 });
		expect(r.selection.units).toHaveLength(2);
		expect(r.selection.matched).toHaveLength(5);
		expect(r.selection.totalMatched).toBe(5);
		expect(r.selection.truncated).toBe(true);
	});

	it('les conflits non probables descendent dans la pile, ils ne disparaissent pas', () => {
		const probable = frankConflict('probable');
		// dominant sans mauvais aiguillage : non probable, mais bien plus de clics.
		const legit = [
			...spread('legitime', PAGE_A, [500, 500, 500, 500], { clicks: 90, position: 3 }),
			...spread('legitime', PAGE_B, [90, 90, 90, 90], { clicks: 1, position: 5 })
		];
		const r = pass([...probable, ...legit]);
		expect(r.legitimate).toBe(1);
		expect(r.selection.totalMatched).toBe(2);
		expect(r.selection.units[0].query).toBe('probable');
		expect(r.selection.units[1].probable).toBe(false);
	});

	it('le tri est déterministe quel que soit l’ordre d’arrivée des lignes', () => {
		const rows = Array.from({ length: 4 }, (_, i) => frankConflict(`kw${i}`)).flat();
		const straight = pass(rows).selection.matched.map(unitKey);
		const shuffled = pass([...rows].reverse()).selection.matched.map(unitKey);
		expect(shuffled).toEqual(straight);
	});

	it('⭐ relativeShare borne le nombre d’URLs significatives à ⌊1/part⌋ = 6 au défaut', () => {
		// Sept URLs à parts égales : chacune capte 1/7 ≈ 14,3 % < 15 %. Aucune n'est
		// significative — la part est un plafond structurel sur le nombre de concurrentes.
		const rows = Array.from({ length: 7 }, (_, i) =>
			spread('kw', `https://site.test/p${i}`, [30, 30, 30, 30])
		).flat();
		const r = pass(rows);
		expect(r.selection.totalMatched).toBe(0);
		expect(r.singleUrl).toBe(1);
		expect(r.suspiciousUrlCount).toBe(0);

		const six = Array.from({ length: 6 }, (_, i) =>
			spread('kw', `https://site.test/p${i}`, [30, 30, 30, 30])
		).flat();
		expect(pass(six).selection.matched[0].metrics.urlCount).toBe(6);
	});

	it('le tripwire maxUrls ne se déclenche que si la part est ABAISSÉE — et il compte, il n’écarte pas', () => {
		const rows = Array.from({ length: 10 }, (_, i) =>
			spread('kw', `https://site.test/p${i}`, [30, 30, 30, 30])
		).flat();
		const r = pass(rows, { relativeShare: 0.05 });
		expect(r.selection.totalMatched).toBe(1);
		expect(r.suspiciousUrlCount).toBe(1);
		expect(r.selection.matched[0].metrics.urlCount).toBe(10);
	});

	it('⭐ les variantes de REQUÊTE ne sont pas regroupées (inversion de FIND-006)', () => {
		// Deux orthographes, chacune mono-URL. FIND-006 en ferait un groupe ; ici, deux
		// requêtes distinctes et AUCUN conflit — les fusionner en fabriquerait un.
		const rows = [
			...spread('alpha beta', PAGE_A, [40, 40, 40, 40]),
			...spread('beta alpha', PAGE_B, [40, 40, 40, 40])
		];
		const r = pass(rows);
		expect(r.selection.totalMatched).toBe(0);
		expect(r.singleUrl).toBe(2);
		expect([...r.measurableQueries].sort()).toEqual(['alpha beta', 'beta alpha']);
	});
});

// ── 10. Scoring et sévérité ─────────────────────────────────────────

describe('scoreCannibalization / deriveCannibalizationSeverity', () => {
	const ctx = { thresholds: T, completeness: COMPLETE, weeks: 4 };

	it('impact = 0 sans clic contesté, quelle que soit la visibilité', () => {
		const s = scoreCannibalization(
			unitOf({ metrics: metricsOf({ conflictClicks: 0, queryImpressions: 5000 }) }),
			ctx
		);
		expect(s.impact).toBe(0);
	});

	it('⭐ le facteur (1 − dominance) : un conflit dominé disperse moins', () => {
		const base = metricsOf({ conflictClicks: 40 });
		const balanced = scoreCannibalization(unitOf({ metrics: { ...base, dominance: 0.5 } }), ctx);
		const dominated = scoreCannibalization(unitOf({ metrics: { ...base, dominance: 0.95 } }), ctx);
		expect(balanced.impact).toBeGreaterThan(dominated.impact);
		expect(dominated.impact).toBeLessThan(5);
	});

	it('urgency suit la MEILLEURE position, pas celle de la dominante', () => {
		const near = scoreCannibalization(unitOf({ metrics: metricsOf({ bestPosition: 4 }) }), ctx);
		const far = scoreCannibalization(unitOf({ metrics: metricsOf({ bestPosition: 28 }) }), ctx);
		expect(near.urgency).toBeGreaterThan(far.urgency);
		const beyond = scoreCannibalization(unitOf({ metrics: metricsOf({ bestPosition: 45 }) }), ctx);
		expect(beyond.urgency).toBe(0);
	});

	it('aucune composante ne dépasse son plafond §10.2', () => {
		const s = scoreCannibalization(
			unitOf({
				metrics: metricsOf({ conflictClicks: 100000, bestPosition: 1, misallocation: 40 })
			}),
			ctx
		);
		expect(s.impact).toBeLessThanOrEqual(40);
		expect(s.urgency).toBeLessThanOrEqual(25);
		expect(s.confidence).toBeLessThanOrEqual(20);
		expect(s.strategicFit).toBeLessThanOrEqual(15);
		expect(computePriorityScore(s)).toBeLessThanOrEqual(100);
	});

	it('la confiance baisse avec la forme et avec la persistance', () => {
		const alt = scoreCannibalization(unitOf({ shape: 'alternating' }), ctx);
		const stacked = scoreCannibalization(unitOf({ shape: 'stacked' }), ctx);
		expect(alt.confidence).toBeGreaterThan(stacked.confidence);

		const partial = scoreCannibalization(
			unitOf({ metrics: metricsOf({ overlapWeeks: 2 }) }),
			ctx
		);
		expect(partial.confidence).toBeLessThan(alt.confidence);
		expect(partial.confidenceCaveats).toContain('conflit observé sur 2/4 semaines de la fenêtre');
	});

	it('chaque caveat est déclenché par sa propre condition', () => {
		const s = scoreCannibalization(
			unitOf({
				shape: 'dominant',
				metrics: metricsOf({
					queryImpressions: 30,
					urlCount: 8,
					observedUrlCount: 8,
					rawUrlCount: 12,
					currentlyOverlapping: false
				})
			}),
			ctx
		);
		const joined = s.confidenceCaveats.join(' | ');
		expect(joined).toContain('faible volume (30 impressions)');
		expect(joined).toContain('8 URLs significatives');
		expect(joined).toContain(`repliée(s) par la règle ${URL_NORMALIZATION_RULE}`);
		expect(joined).toContain('absent de la dernière semaine collectée');
		expect(joined).toContain('forme « dominant »');
	});

	it('les caveats de complétude de fenêtre sont repris tels quels', () => {
		const s = scoreCannibalization(unitOf(), {
			...ctx,
			completeness: { ...COMPLETE, coverage: 0.5, complete: false, caveats: ['fenêtre en retard'] }
		});
		expect(s.confidenceCaveats).toContain('fenêtre en retard');
		expect(s.confidenceScore).toBeLessThan(100);
	});

	it('⭐ !probable ⇒ jamais au-dessus de low, même à priorityScore 95', () => {
		expect(
			deriveCannibalizationSeverity({
				priorityScore: 95,
				impressions: 10000,
				thresholds: T,
				confidenceScore: 100,
				probable: false,
				urlCount: 2
			})
		).toBe('low');
		expect(
			deriveCannibalizationSeverity({
				priorityScore: 5,
				impressions: 10000,
				thresholds: T,
				confidenceScore: 100,
				probable: false,
				urlCount: 2
			})
		).toBe('info');
	});

	it('le plafond FIND-002 s’applique aux trois motifs', () => {
		const strong = {
			priorityScore: 85,
			impressions: 10000,
			thresholds: T,
			confidenceScore: 100,
			probable: true,
			urlCount: 2
		};
		expect(deriveCannibalizationSeverity(strong)).toBe('critical');
		expect(deriveCannibalizationSeverity({ ...strong, impressions: 50 })).toBe('medium');
		expect(deriveCannibalizationSeverity({ ...strong, confidenceScore: 49 })).toBe('medium');
		expect(deriveCannibalizationSeverity({ ...strong, urlCount: 7 })).toBe('medium');
		// Un plafond ne remonte jamais une sévérité basse.
		expect(deriveCannibalizationSeverity({ ...strong, priorityScore: 25, impressions: 50 })).toBe(
			'low'
		);
	});
});

// ── 11. Preuves et rendu ────────────────────────────────────────────

describe('preuves et rendu', () => {
	const ctx = { thresholds: T, completeness: COMPLETE, weeks: 4 };

	function evidenceOf(rows: ObservationRow[], overrides: Partial<typeof T> = {}) {
		const r = pass(rows, overrides);
		const unit = r.selection.units[0];
		const score = scoreCannibalization(unit, ctx);
		return {
			unit,
			evidence: buildCannibalizationEvidence({
				unit,
				score,
				window: { start: WEEKS[0], end: '2026-06-28', weeks: 4 }
			})
		};
	}

	it('⭐ les formes BRUTES permettent de retrouver chaque URL repliée, et de rejouer la règle', () => {
		const { evidence } = evidenceOf([
			...spread('kw', PAGE_A, [40, 40, 40, 40]),
			...spread('kw', `${PAGE_A}#top`, [10, 10, 10, 10]),
			...spread('kw', PAGE_B, [30, 30, 30, 30])
		]);
		expect(evidence.urlNormalization).toBe(URL_NORMALIZATION_RULE);
		const folded = evidence.urls.find((u) => u.url === PAGE_A)!;
		expect(folded.rawUrls).toEqual([PAGE_A, `${PAGE_A}#top`]);
		expect(folded.rawUrlCount).toBe(2);
		for (const raw of folded.rawUrls) {
			expect(normalizePageUrl(raw)).toBe(folded.url);
		}
	});

	it('les parts se rapportent au conflit et somment à 1', () => {
		const { evidence } = evidenceOf(frankConflict());
		const total = evidence.urls.reduce((s, u) => s + u.share, 0);
		expect(total).toBeCloseTo(1, 9);
	});

	it('⭐ leaders est chronologique et de longueur overlapWeeks', () => {
		const { unit, evidence } = evidenceOf([
			...spread('kw', PAGE_A, [80, 20, 80, 20]),
			...spread('kw', PAGE_B, [20, 80, 20, 80])
		]);
		expect(evidence.leaders).toHaveLength(unit.metrics.overlapWeeks);
		expect(evidence.leaders.map((l) => l.week)).toEqual(WEEKS);
		expect(evidence.leaders.map((l) => l.url)).toEqual([PAGE_A, PAGE_B, PAGE_A, PAGE_B]);
		expect(unit.metrics.switches).toBe(3);
		expect(unit.metrics.alternation).toBe(1);
		expect(unit.shape).toBe('alternating');
	});

	it('la série hebdo rend la dominance vérifiable à la main', () => {
		const { unit, evidence } = evidenceOf(frankConflict());
		const recomputed =
			Math.max(...evidence.urls.map((u) => u.impressions)) /
			evidence.urls.reduce((s, u) => s + u.impressions, 0);
		expect(recomputed).toBeCloseTo(unit.metrics.dominance, 9);
		for (const u of evidence.urls) {
			expect(u.weekly.reduce((s, w) => s + w.impressions, 0)).toBe(u.impressions);
		}
	});

	it('urlSetKey est stable et indépendant de l’ordre', () => {
		const a = urlSide({ url: PAGE_A });
		const b = urlSide({ url: PAGE_B });
		expect(urlSetKey([a, b])).toBe(urlSetKey([b, a]));
		expect(urlSetKey([a, b])).toContain(PAGE_A);
	});

	it('les plafonds de preuves sont respectés, avec le VRAI total à côté', () => {
		// 14 URLs significatives exigent une part abaissée (plafond structurel ⌊1/0,15⌋ = 6).
		const many = Array.from({ length: 14 }, (_, i) =>
			spread('kw', `https://site.test/p${i}`, [30, 30, 30, 30])
		).flat();
		const { evidence } = evidenceOf(many, { relativeShare: 0.01 });
		expect(evidence.urls).toHaveLength(MAX_EVIDENCE_CONFLICT_URLS);
		expect(evidence.urlCount).toBe(14);
		expect(evidence.observationIds.length).toBeLessThanOrEqual(MAX_EVIDENCE_IDS);
		expect(evidence.observationCount).toBe(56);
	});

	it('les formes brutes par URL sont plafonnées, le compte reste exact', () => {
		const variants = ['', '#a', '#b', '#c', '#d', '#e'].map((frag) =>
			spread('kw', `${PAGE_A}${frag}`, [20, 20, 20, 20])
		);
		const { evidence } = evidenceOf([...variants.flat(), ...spread('kw', PAGE_B, [80, 80, 80, 80])]);
		const folded = evidence.urls.find((u) => u.url === PAGE_A)!;
		expect(folded.rawUrls).toHaveLength(MAX_EVIDENCE_RAW_URLS);
		expect(folded.rawUrlCount).toBe(6);
	});

	it('le blob de preuves reste très en deçà des 32 Ko, même au pire cas structurel', () => {
		const long = (i: number) =>
			`https://www.barberconcept.ch/blog/coupe-de-cheveux-homme-tendance-${i}-guide-complet-2026`;
		const build = (n: number) =>
			Array.from({ length: n }, (_, i) =>
				['', '#intro', '#etapes', '#conclusion'].map((frag) =>
					spread('coupe homme genève', `${long(i)}${frag}`, [200, 200, 200, 200])
				)
			)
				.flat()
				.flat();

		// Pire cas ATTEIGNABLE aux seuils par défaut : 6 URLs (plafond structurel).
		const atDefaults = evidenceOf(build(6)).evidence;
		expect(atDefaults.urls).toHaveLength(6);
		expect(JSON.stringify(atDefaults).length).toBeLessThan(32 * 1024);

		// Pire cas du plafond de preuves, part abaissée : 10 URLs détaillées.
		const capped = evidenceOf(build(10), { relativeShare: 0.05 }).evidence;
		expect(capped.urls).toHaveLength(MAX_EVIDENCE_CONFLICT_URLS);
		expect(JSON.stringify(capped).length).toBeLessThan(32 * 1024);
	});

	it('le titre porte la requête BRUTE et AUCUNE date', () => {
		const { unit } = evidenceOf(frankConflict('coupe homme genève'));
		const title = buildCannibalizationTitle(unit);
		expect(title).toContain('"coupe homme genève"');
		expect(title).toContain('2 URLs');
		expect(title).not.toMatch(/20\d\d-\d\d-\d\d/);
	});

	it('la raison publie le seuil effectif, la persistance et le verdict mécanique', () => {
		const { unit } = evidenceOf(frankConflict());
		const reason = buildCannibalizationReason(unit, T);
		expect(reason).toContain('URLs significatives (seuil effectif');
		expect(reason).toContain('persistance minimale 2');
		expect(reason).toContain('conflit probable');
		expect(reason).toContain('forme mécanique');
	});

	it('une coexistence le dit dans sa raison, sans se faire passer pour un conflit', () => {
		const unit = unitOf({ shape: 'dominant', probable: false });
		expect(buildCannibalizationReason(unit, T)).toContain('coexistence');
	});
});
