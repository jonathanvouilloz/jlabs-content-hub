import { describe, it, expect } from 'vitest';
import {
	DETECTOR_QUERY_TURNOVER,
	LOST_QUERY_SKILL_INDEXED,
	LOST_QUERY_SKILL_UNVERIFIED,
	MAX_EVIDENCE_VARIANTS,
	TURNOVER_DEFAULTS,
	aggregateByQuery,
	buildTurnoverEvidence,
	buildTurnoverReason,
	buildTurnoverTitle,
	classifyNewGroup,
	deriveTurnoverSeverity,
	hasRepeatedGrowth,
	lostQuerySkill,
	normalizeQueryKey,
	resolveGroupIndexation,
	resolveTurnoverThresholds,
	runTurnoverPass,
	scoreTurnover,
	unitKey,
	type PageIndexation,
	type QueryLifespan,
	type TurnoverPassInput,
	type TurnoverUnit
} from './query-turnover-state.js';
import type { ObservationRow } from '../detector-state.js';
import { computePriorityScore } from '../finding-state.js';
import type { WindowCompleteness } from '../gsc-windows-state.js';

const T = TURNOVER_DEFAULTS;

/** Fenêtre courante : semaines w5..w8 ; fenêtre précédente : w1..w4. */
const CURRENT_WEEKS = ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22'];
const PRIOR_WEEKS = ['2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25'];
const CURRENT_START = CURRENT_WEEKS[0];

function row(
	over: Partial<ObservationRow> & { query: string; page?: string }
): ObservationRow {
	const page = over.page ?? 'https://site.test/p';
	const periodStart = over.periodStart ?? CURRENT_WEEKS[0];
	return {
		id: `${over.query}|${page}|${periodStart}`,
		query: over.query,
		page,
		clicks: over.clicks ?? 0,
		impressions: over.impressions ?? 0,
		position: over.position ?? 10,
		periodStart
	};
}

/**
 * Étale des impressions sur des semaines données (une ligne par semaine).
 *
 * Une semaine à zéro impression ne produit AUCUNE ligne : GSC n'émet pas de ligne
 * pour une requête qui n'est pas sortie. En fabriquer une ferait croire au détecteur
 * que la requête a été vue cette semaine-là, et gonflerait sa persistance.
 */
function spread(
	query: string,
	weeks: string[],
	impressionsPerWeek: number[],
	over: { page?: string; clicks?: number; position?: number } = {}
): ObservationRow[] {
	return weeks
		.map((periodStart, i) => ({ periodStart, impressions: impressionsPerWeek[i] ?? 0, i }))
		.filter((w) => w.impressions > 0)
		.map((w) =>
			row({
				query,
				periodStart: w.periodStart,
				impressions: w.impressions,
				clicks: w.i === 0 ? (over.clicks ?? 0) : 0,
				page: over.page,
				position: over.position
			})
		);
}

function life(query: string, firstSeen: string, lastSeen: string, weeksSeen = 4): QueryLifespan {
	return { query, firstSeen, lastSeen, weeksSeen };
}

function pass(over: Partial<TurnoverPassInput> = {}) {
	const input: TurnoverPassInput = {
		currentRows: [],
		priorRows: [],
		comparable: true,
		currentWindowStart: CURRENT_START,
		lifespans: [],
		indexation: new Map(),
		thresholds: T,
		...over
	};
	return runTurnoverPass(input);
}

const COMPLETENESS: WindowCompleteness = {
	complete: true,
	coverage: 1,
	weeks: 4,
	expectedWeeks: 4,
	fresh: true,
	caveats: []
};

// ── Normalisation de variantes ──────────────────────────────────────

describe('normalizeQueryKey', () => {
	it('déplie les accents, la casse et la ponctuation', () => {
		expect(normalizeQueryKey('Coiffeur Genève')).toBe(normalizeQueryKey('coiffeur geneve'));
		expect(normalizeQueryKey('coiffeur, genève !')).toBe(normalizeQueryKey('coiffeur geneve'));
	});

	it('⭐ ignore l’ORDRE des mots : c’est la même demande', () => {
		expect(normalizeQueryKey('coiffeur genève')).toBe(normalizeQueryKey('genève coiffeur'));
	});

	it('ne fusionne PAS deux intentions qui partagent un mot', () => {
		expect(normalizeQueryKey('coiffeur homme')).not.toBe(normalizeQueryKey('coiffeur femme'));
		// Aucun stemming : un pluriel reste un terme distinct. Une normalisation plus
		// ambitieuse fabriquerait des pertes et des découvertes qui n'ont pas eu lieu.
		expect(normalizeQueryKey('coiffeur')).not.toBe(normalizeQueryKey('coiffeurs'));
	});

	it('rend une clé vide pour une requête sans lettre ni chiffre', () => {
		expect(normalizeQueryKey('  ??? ')).toBe('');
	});
});

// ── Agrégation par requête ──────────────────────────────────────────

describe('aggregateByQuery', () => {
	it('somme les pages et les devices sous UNE requête, et pondère la position', () => {
		const agg = aggregateByQuery([
			row({ query: 'q', page: 'https://a.test', impressions: 100, position: 4, clicks: 5 }),
			row({ query: 'q', page: 'https://b.test', impressions: 10, position: 40, clicks: 0 })
		]);
		const side = agg.get('q')!;
		expect(side.impressions).toBe(110);
		expect(side.clicks).toBe(5);
		// Pondérée : (100×4 + 10×40) / 110 ≈ 7,3 — jamais la moyenne simple (22).
		expect(side.position).toBeCloseTo(7.27, 1);
		expect([...side.pages.keys()].sort()).toEqual(['https://a.test', 'https://b.test']);
	});

	it('compte les semaines distinctes et garde la série hebdo', () => {
		const agg = aggregateByQuery(spread('q', CURRENT_WEEKS, [1, 2, 3, 4]));
		const side = agg.get('q')!;
		expect(side.weeksSeen).toBe(4);
		expect([...side.weekly.values()]).toEqual([1, 2, 3, 4]);
	});
});

// ── Gate de comparabilité ───────────────────────────────────────────

describe('runTurnoverPass — gate de comparabilité', () => {
	it('⭐ deux fenêtres non comparables ne produisent RIEN, et le DISENT', () => {
		const r = pass({
			comparable: false,
			currentRows: spread('nouveau', CURRENT_WEEKS, [100, 100, 100, 100])
		});
		expect(r.newQueries.totalMatched).toBe(0);
		expect(r.lostQueries.totalMatched).toBe(0);
		expect(r.skippedReason).toMatch(/comparable/);
	});

	it('une fenêtre comparable sans mouvement n’est PAS un run sauté', () => {
		const rows = spread('stable', CURRENT_WEEKS, [50, 50, 50, 50]);
		const r = pass({
			currentRows: rows,
			priorRows: spread('stable', PRIOR_WEEKS, [50, 50, 50, 50]),
			lifespans: [life('stable', '2025-01-06', CURRENT_WEEKS[3])]
		});
		expect(r.skippedReason).toBeNull();
		expect(r.newQueries.totalMatched).toBe(0);
		expect(r.lostQueries.totalMatched).toBe(0);
	});
});

// ── Découvertes ─────────────────────────────────────────────────────

describe('runTurnoverPass — nouvelles requêtes', () => {
	it('détecte une requête absente de tout l’historique et assez volumineuse', () => {
		const r = pass({
			currentRows: spread('nouvelle requete', CURRENT_WEEKS, [20, 20, 20, 20]),
			lifespans: [life('nouvelle requete', CURRENT_WEEKS[0], CURRENT_WEEKS[3])]
		});
		expect(r.newQueries.totalMatched).toBe(1);
		const unit = r.newQueries.units[0];
		expect(unit.kind).toBe('new');
		expect(unit.group.label).toBe('nouvelle requete');
	});

	it('⭐ une requête à UNE impression ne pollue pas le rapport', () => {
		const r = pass({
			currentRows: spread('minuscule', CURRENT_WEEKS, [1, 0, 0, 0]),
			lifespans: [life('minuscule', CURRENT_WEEKS[0], CURRENT_WEEKS[0], 1)]
		});
		expect(r.newQueries.totalMatched).toBe(0);
		expect(r.newBelowThreshold).toBe(1);
	});

	it('même en croissance, une requête sous le plancher reste dehors', () => {
		// 1 → 2 → 3 : croissance répétée réelle, mais 6 impressions au total.
		const r = pass({
			currentRows: spread('bruit', CURRENT_WEEKS.slice(0, 3), [1, 2, 3]),
			lifespans: [life('bruit', CURRENT_WEEKS[0], CURRENT_WEEKS[2], 3)]
		});
		expect(r.newQueries.totalMatched).toBe(0);
		expect(r.newBelowThreshold).toBe(1);
	});

	it('la croissance répétée est une porte d’entrée sous le seuil de volume', () => {
		// 15 impressions : sous `minNewImpressions` (30), au-dessus du plancher (10),
		// et la dernière semaine pèse plus que la première.
		const r = pass({
			currentRows: spread('emergente', CURRENT_WEEKS, [2, 3, 4, 6]),
			lifespans: [life('emergente', CURRENT_WEEKS[0], CURRENT_WEEKS[3])]
		});
		expect(r.newQueries.totalMatched).toBe(1);
		const unit = r.newQueries.units[0] as Extract<TurnoverUnit, { kind: 'new' }>;
		expect(unit.confirmation).toBe('emerging');
	});

	it('une seule semaine ne suffit jamais à parler de croissance', () => {
		expect(
			hasRepeatedGrowth(aggregateByQuery(spread('q', [CURRENT_WEEKS[0]], [25])).get('q')!, T)
		).toBe(false);
	});

	it('⭐ une requête connue REVENUE n’est pas une découverte', () => {
		const r = pass({
			currentRows: spread('retour', CURRENT_WEEKS, [50, 50, 50, 50]),
			// Vue il y a six mois, absente de la fenêtre précédente, de retour maintenant.
			lifespans: [life('retour', '2025-12-01', CURRENT_WEEKS[3])]
		});
		expect(r.newQueries.totalMatched).toBe(0);
		expect(r.returning).toBe(1);
	});

	it('⭐ une "nouveauté" qui n’est qu’une variante d’une requête connue est écartée', () => {
		// « genève coiffeur » apparaît pour la première fois, mais « coiffeur genève »
		// est là depuis des mois : Google a réécrit la requête, rien n'a été découvert.
		const r = pass({
			currentRows: [
				...spread('coiffeur geneve', CURRENT_WEEKS, [40, 40, 40, 40]),
				...spread('geneve coiffeur', CURRENT_WEEKS, [30, 30, 30, 30])
			],
			priorRows: spread('coiffeur geneve', PRIOR_WEEKS, [40, 40, 40, 40]),
			lifespans: [
				life('coiffeur geneve', '2025-01-06', CURRENT_WEEKS[3]),
				life('geneve coiffeur', CURRENT_WEEKS[0], CURRENT_WEEKS[3])
			]
		});
		expect(r.newQueries.totalMatched).toBe(0);
		expect(r.variantOfKnown).toBe(1);
	});

	it('⭐ la même variante vue seulement dans la fenêtre PRÉCÉDENTE écarte aussi la découverte', () => {
		// Aucun membre commun entre les deux fenêtres : seule la clé normalisée relie
		// « genève coiffeur » (maintenant) à « coiffeur genève » (avant).
		const r = pass({
			currentRows: spread('geneve coiffeur', CURRENT_WEEKS, [40, 40, 40, 40]),
			priorRows: spread('coiffeur geneve', PRIOR_WEEKS, [40, 40, 40, 40]),
			lifespans: [
				life('coiffeur geneve', '2025-01-06', PRIOR_WEEKS[3]),
				life('geneve coiffeur', CURRENT_WEEKS[0], CURRENT_WEEKS[3])
			]
		});
		expect(r.newQueries.totalMatched).toBe(0);
		expect(r.variantOfKnown).toBe(1);
		// Et symétriquement : ce n'est pas non plus une perte.
		expect(r.lostQueries.totalMatched).toBe(0);
		expect(r.variantSurvived).toBe(1);
	});

	it('deux variantes NEUVES ensemble font UN seul finding, pas deux', () => {
		const r = pass({
			currentRows: [
				...spread('barbier vevey', CURRENT_WEEKS, [20, 20, 20, 20]),
				...spread('vevey barbier', CURRENT_WEEKS, [10, 10, 10, 10])
			],
			lifespans: [
				life('barbier vevey', CURRENT_WEEKS[0], CURRENT_WEEKS[3]),
				life('vevey barbier', CURRENT_WEEKS[0], CURRENT_WEEKS[3])
			]
		});
		expect(r.newQueries.totalMatched).toBe(1);
		const unit = r.newQueries.units[0];
		expect(unit.group.members.map((m) => m.query)).toEqual(['barbier vevey', 'vevey barbier']);
		// Le terme dominant nomme le finding — jamais la clé normalisée.
		expect(unit.group.label).toBe('barbier vevey');
		expect(unit.group.side.impressions).toBe(120);
	});

	it('le gate de volume s’applique au GROUPE, pas à chaque variante', () => {
		// Deux variantes à 16 impressions : chacune sous le seuil, le groupe au-dessus.
		const r = pass({
			currentRows: [
				...spread('a b', CURRENT_WEEKS, [4, 4, 4, 4]),
				...spread('b a', CURRENT_WEEKS, [4, 4, 4, 4])
			],
			lifespans: [life('a b', CURRENT_WEEKS[0], CURRENT_WEEKS[3]), life('b a', CURRENT_WEEKS[0], CURRENT_WEEKS[3])]
		});
		expect(r.newQueries.totalMatched).toBe(1);
		expect(r.newQueries.units[0].group.side.impressions).toBe(32);
	});
});

// ── Pertes ──────────────────────────────────────────────────────────

describe('runTurnoverPass — requêtes perdues', () => {
	const lostInput = (over: Partial<TurnoverPassInput> = {}) =>
		pass({
			priorRows: spread('requete perdue', PRIOR_WEEKS, [30, 30, 30, 30], { clicks: 8 }),
			lifespans: [life('requete perdue', '2025-06-02', PRIOR_WEEKS[3])],
			...over
		});

	it('détecte une requête présente avant et absente maintenant', () => {
		const r = lostInput();
		expect(r.lostQueries.totalMatched).toBe(1);
		const unit = r.lostQueries.units[0] as Extract<TurnoverUnit, { kind: 'lost' }>;
		expect(unit.group.label).toBe('requete perdue');
		expect(unit.pageIndexation).toBe('unknown');
	});

	it('⭐ une disparition sous le seuil de volume n’est pas une perte', () => {
		// 12 impressions sur la fenêtre précédente : la longue traîne va et vient, ce
		// n'est pas un événement. Sans ce gate, `lecureux` écrirait 87 findings par run.
		const r = pass({
			priorRows: spread('longue traine', PRIOR_WEEKS, [3, 3, 3, 3]),
			lifespans: [life('longue traine', PRIOR_WEEKS[0], PRIOR_WEEKS[3])]
		});
		expect(r.lostQueries.totalMatched).toBe(0);
		expect(r.lostBelowThreshold).toBe(1);
	});

	it('une requête vue UNE seule semaine puis disparue n’est pas une perte', () => {
		const r = pass({
			priorRows: spread('feu de paille', [PRIOR_WEEKS[0]], [200]),
			lifespans: [life('feu de paille', PRIOR_WEEKS[0], PRIOR_WEEKS[0], 1)]
		});
		expect(r.lostQueries.totalMatched).toBe(0);
		expect(r.lostBelowThreshold).toBe(1);
	});

	it('⭐ une perte dont la page n’est plus indexée appartient à index_drop, pas ici', () => {
		const r = lostInput({
			indexation: new Map<string, PageIndexation>([['https://site.test/p', 'not_indexed']])
		});
		expect(r.lostQueries.totalMatched).toBe(0);
		expect(r.attributedToIndexing).toBe(1);
	});

	it('⭐ une indexation INCONNUE ne bloque rien : elle baisse la confiance', () => {
		// C'est le cas de tout le parc (aucune inspection). Exiger la preuve
		// d'indexabilité rendrait le détecteur inerte partout.
		const r = lostInput({ indexation: new Map() });
		expect(r.lostQueries.totalMatched).toBe(1);
		const unit = r.lostQueries.units[0];
		const score = scoreTurnover(unit, { thresholds: T, completeness: COMPLETENESS, weeks: 4 });
		expect(score.confidenceCaveats.join(' ')).toMatch(/jamais inspectée/);
		expect(score.confidenceScore).toBeLessThan(100);
	});

	it('une page encore indexée laisse la perte au diagnostic de contenu', () => {
		const r = lostInput({
			indexation: new Map<string, PageIndexation>([['https://site.test/p', 'indexed']])
		});
		const unit = r.lostQueries.units[0] as Extract<TurnoverUnit, { kind: 'lost' }>;
		expect(unit.pageIndexation).toBe('indexed');
		expect(lostQuerySkill(unit.pageIndexation)).toBe(LOST_QUERY_SKILL_INDEXED);
		expect(lostQuerySkill('unknown')).toBe(LOST_QUERY_SKILL_UNVERIFIED);
	});

	it('⭐ une variante qui survit annule la perte', () => {
		const r = pass({
			priorRows: spread('coiffeur geneve', PRIOR_WEEKS, [30, 30, 30, 30]),
			currentRows: spread('geneve coiffeur', CURRENT_WEEKS, [30, 30, 30, 30]),
			lifespans: [
				life('coiffeur geneve', '2025-01-06', PRIOR_WEEKS[3]),
				life('geneve coiffeur', CURRENT_WEEKS[0], CURRENT_WEEKS[3])
			]
		});
		expect(r.lostQueries.totalMatched).toBe(0);
		expect(r.variantSurvived).toBe(1);
	});

	it('la portée des pertes contient les groupes PRÉSENTS, base de la réconciliation', () => {
		const r = pass({
			currentRows: spread('toujours la', CURRENT_WEEKS, [10, 10, 10, 10]),
			lifespans: [life('toujours la', '2025-01-06', CURRENT_WEEKS[3])]
		});
		expect(r.presentKeys.has(normalizeQueryKey('toujours la'))).toBe(true);
	});
});

// ── Bruit configuré ─────────────────────────────────────────────────

describe('runTurnoverPass — bruit configuré', () => {
	it('une requête de marque n’entre ni dans les découvertes ni dans les pertes', () => {
		const thresholds = resolveTurnoverThresholds({ excludeQueryPatterns: ['MaMarque'] });
		const r = pass({
			thresholds,
			currentRows: spread('mamarque horaires', CURRENT_WEEKS, [100, 100, 100, 100]),
			priorRows: spread('mamarque adresse', PRIOR_WEEKS, [100, 100, 100, 100]),
			lifespans: [
				life('mamarque horaires', CURRENT_WEEKS[0], CURRENT_WEEKS[3]),
				life('mamarque adresse', '2025-01-06', PRIOR_WEEKS[3])
			]
		});
		expect(r.newQueries.totalMatched).toBe(0);
		expect(r.lostQueries.totalMatched).toBe(0);
		expect(r.excludedByNoise).toBe(2);
	});

	it('une requête présente des deux côtés n’est comptée qu’une fois', () => {
		const thresholds = resolveTurnoverThresholds({ excludeQueryPatterns: ['marque'] });
		const r = pass({
			thresholds,
			currentRows: spread('marque avis', CURRENT_WEEKS, [10, 10, 10, 10]),
			priorRows: spread('marque avis', PRIOR_WEEKS, [10, 10, 10, 10]),
			lifespans: [life('marque avis', PRIOR_WEEKS[0], CURRENT_WEEKS[3])]
		});
		expect(r.excludedByNoise).toBe(1);
	});
});

// ── Seuils ──────────────────────────────────────────────────────────

describe('resolveTurnoverThresholds', () => {
	it('un override corrompu ne DÉSACTIVE jamais un seuil', () => {
		const t = resolveTurnoverThresholds({
			minNewImpressions: Number.NaN,
			minLostImpressions: -5,
			maxCandidates: 10
		});
		expect(t.minNewImpressions).toBe(T.minNewImpressions);
		expect(t.minLostImpressions).toBe(T.minLostImpressions);
		expect(t.maxCandidates).toBe(10);
	});

	it('normalise les motifs de bruit (trim + minuscules) et jette les vides', () => {
		const t = resolveTurnoverThresholds({ excludeQueryPatterns: ['  MaMarque ', '', '  '] });
		expect(t.excludeQueryPatterns).toEqual(['mamarque']);
	});
});

// ── Troncature et ordre ─────────────────────────────────────────────

describe('sélection', () => {
	it('trie par clics puis impressions, et REPORTE la troncature', () => {
		const rows = [
			...spread('peu de clics', CURRENT_WEEKS, [200, 0, 0, 0], { clicks: 1 }),
			...spread('beaucoup de clics', CURRENT_WEEKS, [40, 0, 0, 0], { clicks: 20 })
		];
		const r = pass({
			thresholds: resolveTurnoverThresholds({ maxCandidates: 1 }),
			currentRows: rows,
			lifespans: [
				life('peu de clics', CURRENT_WEEKS[0], CURRENT_WEEKS[0], 1),
				life('beaucoup de clics', CURRENT_WEEKS[0], CURRENT_WEEKS[0], 1)
			]
		});
		expect(r.newQueries.totalMatched).toBe(2);
		expect(r.newQueries.units).toHaveLength(1);
		expect(r.newQueries.units[0].group.label).toBe('beaucoup de clics');
		expect(r.newQueries.truncated).toBe(true);
		// La closure porte les DEUX : une unité tronquée n'a pas cessé d'exister.
		expect(r.newQueries.matched).toHaveLength(2);
	});

	it('le plafond s’applique par TYPE, pas au total', () => {
		const r = pass({
			thresholds: resolveTurnoverThresholds({ maxCandidates: 1 }),
			currentRows: [
				...spread('neuve a', CURRENT_WEEKS, [40, 0, 0, 0]),
				...spread('neuve b', CURRENT_WEEKS, [40, 0, 0, 0])
			],
			priorRows: [
				...spread('perdue a', PRIOR_WEEKS, [30, 30, 0, 0]),
				...spread('perdue b', PRIOR_WEEKS, [30, 30, 0, 0])
			],
			lifespans: [
				life('neuve a', CURRENT_WEEKS[0], CURRENT_WEEKS[0], 1),
				life('neuve b', CURRENT_WEEKS[0], CURRENT_WEEKS[0], 1),
				life('perdue a', PRIOR_WEEKS[0], PRIOR_WEEKS[1], 2),
				life('perdue b', PRIOR_WEEKS[0], PRIOR_WEEKS[1], 2)
			]
		});
		expect(r.newQueries.units).toHaveLength(1);
		expect(r.lostQueries.units).toHaveLength(1);
	});

	it('l’ordre est reproductible à égalité parfaite', () => {
		const build = () =>
			pass({
				currentRows: [
					...spread('zzz', CURRENT_WEEKS, [40, 0, 0, 0]),
					...spread('aaa', CURRENT_WEEKS, [40, 0, 0, 0])
				],
				lifespans: [
					life('zzz', CURRENT_WEEKS[0], CURRENT_WEEKS[0], 1),
					life('aaa', CURRENT_WEEKS[0], CURRENT_WEEKS[0], 1)
				]
			});
		expect(build().newQueries.units.map(unitKey)).toEqual(build().newQueries.units.map(unitKey));
		expect(build().newQueries.units.map((u) => u.group.label)).toEqual(['aaa', 'zzz']);
	});
});

// ── Indexation d'un groupe ──────────────────────────────────────────

describe('resolveGroupIndexation', () => {
	const map = new Map<string, PageIndexation>([
		['a', 'indexed'],
		['b', 'not_indexed'],
		['c', 'unknown']
	]);

	it('une seule page encore indexée suffit à maintenir la perte', () => {
		expect(resolveGroupIndexation(['a', 'b'], map)).toBe('indexed');
	});

	it('toutes les pages CONNUES non indexées ⇒ la cause est l’indexation', () => {
		expect(resolveGroupIndexation(['b'], map)).toBe('not_indexed');
	});

	it('aucune page connue ⇒ `unknown`, jamais `indexed` par défaut', () => {
		expect(resolveGroupIndexation(['c', 'd'], map)).toBe('unknown');
		expect(resolveGroupIndexation([], map)).toBe('unknown');
	});
});

// ── Scoring et sévérité ─────────────────────────────────────────────

describe('scoreTurnover / deriveTurnoverSeverity', () => {
	function newUnit(over: { impressions: number; clicks: number; position?: number }): TurnoverUnit {
		const r = pass({
			currentRows: spread('scored', CURRENT_WEEKS, [over.impressions, 0, 0, 0], {
				clicks: over.clicks,
				position: over.position
			}),
			lifespans: [life('scored', CURRENT_WEEKS[0], CURRENT_WEEKS[0], 1)]
		});
		return r.newQueries.units[0];
	}

	it('⭐ l’impact d’une découverte se mesure en CLICS, jamais en impressions', () => {
		// Le potentiel d'une requête très vue et peu cliquée est le métier de
		// `keyword_opportunity` : le compter ici remonterait deux fois le même signal.
		const silent = scoreTurnover(newUnit({ impressions: 5000, clicks: 0 }), {
			thresholds: T,
			completeness: COMPLETENESS,
			weeks: 4
		});
		expect(silent.impact).toBe(0);
		const clicked = scoreTurnover(newUnit({ impressions: 50, clicks: 40 }), {
			thresholds: T,
			completeness: COMPLETENESS,
			weeks: 4
		});
		expect(clicked.impact).toBeGreaterThan(0);
	});

	it('une fenêtre incomplète BAISSE la confiance sans bloquer le finding', () => {
		const partial: WindowCompleteness = {
			complete: false,
			coverage: 0.5,
			weeks: 2,
			expectedWeeks: 4,
			fresh: false,
			caveats: ['fenêtre incomplète (2/4 semaines)']
		};
		const score = scoreTurnover(newUnit({ impressions: 200, clicks: 10 }), {
			thresholds: T,
			completeness: partial,
			weeks: 4
		});
		const full = scoreTurnover(newUnit({ impressions: 200, clicks: 10 }), {
			thresholds: T,
			completeness: COMPLETENESS,
			weeks: 4
		});
		expect(score.confidenceScore).toBeLessThan(full.confidenceScore);
		expect(score.confidenceCaveats.join(' ')).toMatch(/incomplète/);
	});

	it('une découverte `emerging` ne dépasse JAMAIS `medium`', () => {
		expect(
			deriveTurnoverSeverity({
				priorityScore: 95,
				impressions: 100_000,
				thresholds: T,
				confidenceScore: 100,
				emerging: true
			})
		).toBe('medium');
		expect(
			deriveTurnoverSeverity({
				priorityScore: 95,
				impressions: 100_000,
				thresholds: T,
				confidenceScore: 100,
				emerging: false
			})
		).toBe('critical');
	});

	it('le faible volume plafonne aussi la sévérité (FIND-002)', () => {
		expect(
			deriveTurnoverSeverity({
				priorityScore: 85,
				impressions: 10,
				thresholds: T,
				confidenceScore: 100,
				emerging: false
			})
		).toBe('medium');
	});

	it('le score de priorité reste dans le barème §10.2', () => {
		const score = scoreTurnover(newUnit({ impressions: 500, clicks: 100, position: 2 }), {
			thresholds: T,
			completeness: COMPLETENESS,
			weeks: 4
		});
		const total = computePriorityScore(score);
		expect(total).toBeGreaterThan(0);
		expect(total).toBeLessThanOrEqual(100);
	});
});

// ── Preuves, titres, raisons ────────────────────────────────────────

describe('preuves et rendu', () => {
	const r = pass({
		currentRows: [
			...spread('barbier vevey', CURRENT_WEEKS, [10, 15, 20, 25], { clicks: 4 }),
			...spread('vevey barbier', CURRENT_WEEKS, [5, 5, 5, 5], { page: 'https://site.test/b' })
		],
		lifespans: [
			life('barbier vevey', CURRENT_WEEKS[0], CURRENT_WEEKS[3]),
			life('vevey barbier', CURRENT_WEEKS[1], CURRENT_WEEKS[3], 3)
		]
	});
	const unit = r.newQueries.units[0];
	const score = scoreTurnover(unit, { thresholds: T, completeness: COMPLETENESS, weeks: 4 });
	const evidence = buildTurnoverEvidence({
		unit,
		score,
		window: {
			current: { start: CURRENT_WEEKS[0], end: '2026-06-28', weeks: 4 },
			prior: { start: PRIOR_WEEKS[0], end: '2026-05-31', weeks: 4 }
		},
		indexation: new Map<string, PageIndexation>([['https://site.test/b', 'indexed']])
	});

	it('⭐ les preuves portent la PREMIÈRE et la DERNIÈRE apparition', () => {
		expect(evidence.firstSeen).toBe(CURRENT_WEEKS[0]);
		expect(evidence.lastSeen).toBe(CURRENT_WEEKS[3]);
		// Et chaque variante porte les siennes : le groupe ne masque pas ses membres.
		expect(evidence.variants.map((v) => v.firstSeen)).toEqual([CURRENT_WEEKS[0], CURRENT_WEEKS[1]]);
	});

	it('⭐ le regroupement est réversible : la clé et tous les termes bruts sont là', () => {
		expect(evidence.variantKey).toBe(normalizeQueryKey('barbier vevey'));
		expect(normalizeQueryKey('vevey barbier')).toBe(evidence.variantKey);
		expect(evidence.variants.map((v) => v.query)).toEqual(['barbier vevey', 'vevey barbier']);
		expect(evidence.variantCount).toBe(2);
	});

	it('les preuves sont des POINTEURS bornés, et la série hebdo est vérifiable', () => {
		expect(evidence.detector).toBe(DETECTOR_QUERY_TURNOVER);
		expect(evidence.observationIds.length).toBeLessThanOrEqual(evidence.observationCount);
		expect(evidence.metrics.weekly.map((w) => w.impressions)).toEqual([15, 20, 25, 30]);
		expect(evidence.variants.length).toBeLessThanOrEqual(MAX_EVIDENCE_VARIANTS);
		expect(JSON.stringify(evidence).length).toBeLessThan(32 * 1024);
	});

	it('les pages portent leur état d’indexation, `unknown` par défaut', () => {
		const byPage = new Map(evidence.pages.map((p) => [p.page, p.indexation]));
		expect(byPage.get('https://site.test/b')).toBe('indexed');
		expect(byPage.get('https://site.test/p')).toBe('unknown');
	});

	it('le titre affiche le terme BRUT dominant, jamais la clé normalisée', () => {
		const title = buildTurnoverTitle(unit);
		expect(title).toContain('barbier vevey');
		expect(title).toContain('+1 variantes');
		// Aucune date : le titre est réécrit à chaque re-détection.
		expect(title).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	});

	it('la raison nomme le gate franchi et les variantes regroupées', () => {
		const reason = buildTurnoverReason(unit, T);
		expect(reason).toMatch(/absente de tout l'historique/);
		expect(reason).toContain('"vevey barbier"');
	});

	it('la raison d’une perte nomme l’état d’indexation', () => {
		const lost = pass({
			priorRows: spread('perdue', PRIOR_WEEKS, [30, 30, 30, 30], { clicks: 5 }),
			lifespans: [life('perdue', '2025-06-02', PRIOR_WEEKS[3])]
		}).lostQueries.units[0];
		expect(buildTurnoverReason(lost, T)).toMatch(/jamais inspectée/);
		expect(buildTurnoverTitle(lost)).toMatch(/Requête perdue/);
	});

	it('classifyNewGroup rend null sous les deux portes', () => {
		const group = pass({
			currentRows: spread('rien', CURRENT_WEEKS, [1, 1, 1, 1]),
			lifespans: [life('rien', CURRENT_WEEKS[0], CURRENT_WEEKS[3])]
		});
		expect(group.newQueries.totalMatched).toBe(0);
		const side = aggregateByQuery(spread('rien', CURRENT_WEEKS, [1, 1, 1, 1]));
		expect(
			classifyNewGroup(
				{
					key: 'rien',
					members: [{ query: 'rien', impressions: 4, clicks: 0, firstSeen: '', lastSeen: '' }],
					label: 'rien',
					side: side.get('rien')!,
					firstSeen: '',
					lastSeen: ''
				},
				T
			)
		).toBeNull();
	});
});
