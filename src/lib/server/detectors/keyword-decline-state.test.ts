import { describe, it, expect } from 'vitest';
import {
	DECLINE_DEFAULTS,
	DETECTOR_KEYWORD_DECLINE,
	MAX_EVIDENCE_QUERIES,
	aggregatePage,
	buildDeclineEvidence,
	buildDeclineReason,
	buildDeclineTitle,
	combineSpans,
	deriveDeclineSeverity,
	diffPairs,
	evaluateDecline,
	groupByPage,
	resolveDeclineThresholds,
	runDeclinePass,
	scoreDecline,
	seasonalityUnavailable,
	selectDeclines,
	weeklyClickLoss,
	type DeclineCandidate,
	type DeclineUnit,
	type PairDelta,
	type SpanFinding
} from './keyword-decline-state.js';
import { aggregateWindow, type ObservationRow } from '../detector-state.js';
import { computePriorityScore } from '../finding-state.js';
import type { WindowCompleteness } from '../gsc-windows-state.js';

const T = DECLINE_DEFAULTS;

/** Une ligne d'observation minimale : le détecteur n'en lit pas d'autres colonnes. */
function row(
	over: Partial<ObservationRow> & { query: string; page: string }
): ObservationRow {
	return {
		id: `${over.query}|${over.page}|${over.periodStart ?? 'w1'}`,
		clicks: 0,
		impressions: 0,
		position: 10,
		periodStart: 'w1',
		...over
	};
}

/** Construit un `PairDelta` directement, pour tester l'évaluation sans passer par l'agrégation. */
function delta(over: {
	query?: string;
	page?: string;
	curClicks: number;
	priClicks: number;
	curImpr: number;
	priImpr: number;
	curPos?: number;
	priPos?: number;
	curWeeks?: number;
	priWeeks?: number;
}): PairDelta {
	const current = {
		clicks: over.curClicks,
		impressions: over.curImpr,
		ctr: over.curImpr > 0 ? over.curClicks / over.curImpr : 0,
		position: over.curPos ?? 10,
		weeksSeen: over.curWeeks ?? 4
	};
	const prior = {
		clicks: over.priClicks,
		impressions: over.priImpr,
		ctr: over.priImpr > 0 ? over.priClicks / over.priImpr : 0,
		position: over.priPos ?? 10,
		weeksSeen: over.priWeeks ?? 4
	};
	const clicksAbs = current.clicks - prior.clicks;
	const impressionsAbs = current.impressions - prior.impressions;
	return {
		query: over.query ?? 'requete',
		page: over.page ?? 'https://x.test/p',
		current,
		prior,
		clicksAbs,
		clicksPct: prior.clicks !== 0 ? (clicksAbs / prior.clicks) * 100 : null,
		impressionsAbs,
		impressionsPct: prior.impressions !== 0 ? (impressionsAbs / prior.impressions) * 100 : null,
		positionAbs: current.position - prior.position,
		observationIds: ['obs-a', 'obs-b']
	};
}

function completeness(over?: Partial<WindowCompleteness>): WindowCompleteness {
	return {
		complete: true,
		coverage: 1,
		weeks: 4,
		expectedWeeks: 4,
		fresh: true,
		caveats: [],
		...over
	};
}

function unit(d: PairDelta, over?: Partial<Extract<DeclineUnit, { kind: 'query' }>>): DeclineUnit {
	const candidate: DeclineCandidate = {
		query: d.query,
		page: d.page,
		confirmation: 'confirmed',
		delta: d,
		signals: ['clicks'],
		primary: null,
		recent: null
	};
	return {
		kind: 'query',
		query: d.query,
		page: d.page,
		candidate,
		delta: d,
		signals: ['clicks'],
		confirmation: 'confirmed',
		...over
	} as DeclineUnit;
}

// ── Seuils ──────────────────────────────────────────────────────────

describe('resolveDeclineThresholds', () => {
	it('retombe sur les défauts sans overrides', () => {
		expect(resolveDeclineThresholds()).toEqual(DECLINE_DEFAULTS);
		expect(resolveDeclineThresholds(null)).toEqual(DECLINE_DEFAULTS);
	});

	it('applique un override numérique valide', () => {
		expect(resolveDeclineThresholds({ minClicksDropPct: 50 }).minClicksDropPct).toBe(50);
	});

	it('IGNORE un override corrompu au lieu de désactiver le seuil', () => {
		// Contre-épreuve : un seuil à NaN/négatif laisserait tout passer — un flot de
		// faux positifs vaut pire qu'un override silencieusement ignoré.
		const t = resolveDeclineThresholds({
			minClicksDropPct: Number.NaN,
			minPriorImpressions: -10
		} as never);
		expect(t.minClicksDropPct).toBe(DECLINE_DEFAULTS.minClicksDropPct);
		expect(t.minPriorImpressions).toBe(DECLINE_DEFAULTS.minPriorImpressions);
	});

	it('normalise les motifs de bruit et jette les vides', () => {
		const t = resolveDeclineThresholds({ excludeQueryPatterns: ['  Marque ', '', '  '] });
		expect(t.excludeQueryPatterns).toEqual(['marque']);
	});
});

// ── Appariement : le cœur de « une collecte partielle ne crée pas de baisse » ──

describe('diffPairs', () => {
	it('n’apparie que les couples présents dans les DEUX fenêtres', () => {
		const current = aggregateWindow([
			row({ query: 'a', page: 'p1', clicks: 5, impressions: 100 }),
			row({ query: 'nouveau', page: 'p1', clicks: 2, impressions: 20 })
		]);
		const prior = aggregateWindow([
			row({ query: 'a', page: 'p1', clicks: 10, impressions: 120 }),
			row({ query: 'disparu', page: 'p1', clicks: 30, impressions: 400 })
		]);
		const d = diffPairs(current, prior);
		expect(d.matched.map((m) => m.query)).toEqual(['a']);
		expect(d.vanished).toBe(1);
		expect(d.appeared).toBe(1);
	});

	it('⭐ un couple DISPARU ne devient jamais une baisse de −100 %', () => {
		// L'invariant n°1 : une disparition est indiscernable d'une semaine non
		// collectée. La convertir en baisse fabriquerait un finding à partir d'un trou.
		const d = diffPairs(
			aggregateWindow([]),
			aggregateWindow([row({ query: 'a', page: 'p1', clicks: 200, impressions: 5000 })])
		);
		expect(d.matched).toEqual([]);
		expect(d.vanished).toBe(1);
	});

	it('calcule les écarts et laisse le pourcentage à null sans base de comparaison', () => {
		const d = diffPairs(
			aggregateWindow([row({ query: 'a', page: 'p1', clicks: 3, impressions: 100 })]),
			aggregateWindow([row({ query: 'a', page: 'p1', clicks: 0, impressions: 80 })])
		);
		expect(d.matched[0].clicksAbs).toBe(3);
		expect(d.matched[0].clicksPct).toBeNull();
		expect(d.matched[0].impressionsPct).toBeCloseTo(25, 5);
	});

	it('rend un ordre déterministe quel que soit l’ordre d’entrée', () => {
		const mk = (qs: string[]) =>
			aggregateWindow(qs.map((q) => row({ query: q, page: 'p1', clicks: 5, impressions: 100 })));
		const a = diffPairs(mk(['b', 'a', 'c']), mk(['c', 'b', 'a']));
		const b = diffPairs(mk(['c', 'a', 'b']), mk(['a', 'b', 'c']));
		expect(a.matched.map((m) => m.query)).toEqual(['a', 'b', 'c']);
		expect(a.matched.map((m) => m.query)).toEqual(b.matched.map((m) => m.query));
	});
});

// ── Évaluation contre les seuils ────────────────────────────────────

describe('evaluateDecline', () => {
	it('signale une chute de clics franchissant les deux garde-fous', () => {
		const s = evaluateDecline(
			delta({ curClicks: 10, priClicks: 40, curImpr: 900, priImpr: 1000 }),
			T
		);
		expect(s).toContain('clicks');
	});

	it('⭐ le pourcentage NE SUFFIT PAS : 3 clics tombés à 2 n’est pas une baisse', () => {
		// −33 % franchit le seuil relatif ; l'absolu (1 clic) ne franchit rien. Sans ce
		// deuxième garde-fou, l'inbox se remplirait du bruit des très petits nombres.
		const s = evaluateDecline(
			delta({ curClicks: 2, priClicks: 3, curImpr: 900, priImpr: 1000 }),
			T
		);
		expect(s).not.toContain('clicks');
	});

	it('⭐ le volume se mesure AVANT la baisse, pas après', () => {
		// Une requête tombée de 60 à 1 impression a un volume courant ridicule ; c'est
		// justement la pire baisse. Gater sur la fenêtre courante l'aurait effacée.
		const s = evaluateDecline(
			delta({ curClicks: 0, priClicks: 12, curImpr: 1, priImpr: 60 }),
			T
		);
		expect(s.length).toBeGreaterThan(0);
	});

	it('ne signale rien sous le volume minimal de la fenêtre précédente', () => {
		expect(
			evaluateDecline(delta({ curClicks: 0, priClicks: 20, curImpr: 2, priImpr: 30 }), T)
		).toEqual([]);
	});

	it('⭐ une position qui MONTE est une dégradation, pas une amélioration', () => {
		const worse = evaluateDecline(
			delta({ curClicks: 10, priClicks: 10, curImpr: 1000, priImpr: 1000, curPos: 14, priPos: 8 }),
			T
		);
		const better = evaluateDecline(
			delta({ curClicks: 10, priClicks: 10, curImpr: 1000, priImpr: 1000, curPos: 4, priPos: 12 }),
			T
		);
		expect(worse).toEqual(['position']);
		expect(better).toEqual([]);
	});

	it('ne signale rien quand tout monte', () => {
		expect(
			evaluateDecline(
				delta({ curClicks: 80, priClicks: 40, curImpr: 2000, priImpr: 1000, curPos: 5, priPos: 9 }),
				T
			)
		).toEqual([]);
	});
});

// ── Croisement des deux fenêtres ────────────────────────────────────

describe('combineSpans', () => {
	const d = delta({ curClicks: 5, priClicks: 40, curImpr: 900, priImpr: 1000 });
	const key = `${d.query}\x1f${d.page}`;
	const finding = (span: 7 | 28): SpanFinding => ({
		span,
		weeks: span === 28 ? 4 : 1,
		signals: ['clicks'],
		delta: d
	});

	it('les deux fenêtres tombent → confirmed', () => {
		const [c] = combineSpans({
			primary: new Map([[key, finding(28)]]),
			recent: new Map([[key, finding(7)]])
		});
		expect(c.confirmation).toBe('confirmed');
	});

	it('seul le 4 semaines tombe → sustained', () => {
		const [c] = combineSpans({ primary: new Map([[key, finding(28)]]), recent: new Map() });
		expect(c.confirmation).toBe('sustained');
	});

	it('⭐ seul le 1 semaine tombe → emerging, même si le 4 semaines était disponible', () => {
		// C'est le cas normal d'une baisse fraîche que la moyenne 4 semaines n'a pas
		// encore absorbée : on l'écrit, mais on ne prétend pas qu'elle est prouvée.
		const [c] = combineSpans({ primary: new Map(), recent: new Map([[key, finding(7)]]) });
		expect(c.confirmation).toBe('emerging');
	});

	it('le 4 semaines porte le chiffre quand il a tiré', () => {
		const long = delta({ curClicks: 5, priClicks: 40, curImpr: 900, priImpr: 1000 });
		const short = delta({ curClicks: 1, priClicks: 3, curImpr: 200, priImpr: 260 });
		const [c] = combineSpans({
			primary: new Map([[key, { span: 28, weeks: 4, signals: ['clicks'], delta: long }]]),
			recent: new Map([[key, { span: 7, weeks: 1, signals: ['clicks'], delta: short }]])
		});
		expect(c.delta.prior.clicks).toBe(40);
	});

	it('unionne les signaux des deux fenêtres dans un ordre stable', () => {
		const [c] = combineSpans({
			primary: new Map([[key, { ...finding(28), signals: ['position'] }]]),
			recent: new Map([[key, { ...finding(7), signals: ['clicks'] }]])
		});
		expect(c.signals).toEqual(['clicks', 'position']);
	});
});

// ── Regroupement par page ───────────────────────────────────────────

describe('groupByPage', () => {
	const cand = (query: string, page: string, d: PairDelta): DeclineCandidate => ({
		query,
		page,
		confirmation: 'confirmed',
		delta: d,
		signals: ['clicks'],
		primary: null,
		recent: null
	});

	it('regroupe une page dont plusieurs requêtes baissent ET dont le total baisse', () => {
		const ds = ['a', 'b', 'c'].map((q) =>
			delta({ query: q, page: 'p1', curClicks: 2, priClicks: 20, curImpr: 200, priImpr: 400 })
		);
		const cs = ds.map((d, i) => cand(['a', 'b', 'c'][i], 'p1', d));
		const g = groupByPage(cs, ds, T);
		expect(g.groups).toHaveLength(1);
		expect(g.groups[0].members).toHaveLength(3);
		expect(g.singles).toEqual([]);
	});

	it('⭐ une page qui se RECOMPOSE n’est pas une page qui décroche', () => {
		// 3 requêtes baissent, une quatrième explose : le total de la page monte. Un
		// simple `count >= seuil` aurait annoncé une page en perte — et le chiffre du
		// finding aurait contredit celui de la page.
		const down = ['a', 'b', 'c'].map((q) =>
			delta({ query: q, page: 'p1', curClicks: 2, priClicks: 20, curImpr: 300, priImpr: 400 })
		);
		const up = delta({
			query: 'z',
			page: 'p1',
			curClicks: 500,
			priClicks: 10,
			curImpr: 9000,
			priImpr: 400
		});
		const cs = down.map((d, i) => cand(['a', 'b', 'c'][i], 'p1', d));
		const g = groupByPage(cs, [...down, up], T);
		expect(g.groups).toEqual([]);
		expect(g.singles).toHaveLength(3);
		expect(g.pagesStable).toBe(1);
	});

	it('laisse individuelles les pages sous le seuil de requêtes', () => {
		const ds = ['a', 'b'].map((q) =>
			delta({ query: q, page: 'p1', curClicks: 2, priClicks: 20, curImpr: 200, priImpr: 400 })
		);
		const g = groupByPage(
			ds.map((d, i) => cand(['a', 'b'][i], 'p1', d)),
			ds,
			T
		);
		expect(g.groups).toEqual([]);
		expect(g.singles).toHaveLength(2);
	});

	it('le groupe prend le PLUS FORT niveau de confirmation de ses membres', () => {
		const ds = ['a', 'b', 'c'].map((q) =>
			delta({ query: q, page: 'p1', curClicks: 2, priClicks: 20, curImpr: 200, priImpr: 400 })
		);
		const cs = ds.map((d, i) => cand(['a', 'b', 'c'][i], 'p1', d));
		cs[0].confirmation = 'emerging';
		cs[1].confirmation = 'sustained';
		cs[2].confirmation = 'confirmed';
		expect(groupByPage(cs, ds, T).groups[0].confirmation).toBe('confirmed');
	});
});

describe('aggregatePage', () => {
	it('pondère la position par les impressions de chaque côté', () => {
		const a = delta({ curClicks: 0, priClicks: 0, curImpr: 100, priImpr: 100, curPos: 10, priPos: 10 });
		const b = delta({ curClicks: 0, priClicks: 0, curImpr: 900, priImpr: 900, curPos: 20, priPos: 20 });
		const page = aggregatePage('p1', [a, b]);
		// Moyenne simple = 15 ; pondérée = (100×10 + 900×20)/1000 = 19.
		expect(page.current.position).toBeCloseTo(19, 5);
	});

	it('déduplique les ids d’observation du groupe', () => {
		const a = delta({ curClicks: 1, priClicks: 2, curImpr: 10, priImpr: 10 });
		const b = delta({ curClicks: 1, priClicks: 2, curImpr: 10, priImpr: 10 });
		expect(aggregatePage('p1', [a, b]).observationIds).toEqual(['obs-a', 'obs-b']);
	});

	it('vide la query : un agrégat de page n’est plus une requête', () => {
		expect(aggregatePage('p1', [delta({ curClicks: 1, priClicks: 9, curImpr: 10, priImpr: 90 })]).query).toBe('');
	});
});

// ── Tri et plafond ──────────────────────────────────────────────────

describe('selectDeclines', () => {
	it('trie par perte hebdomadaire décroissante et reporte la troncature', () => {
		const units = [
			unit(delta({ query: 'petite', curClicks: 8, priClicks: 20, curImpr: 500, priImpr: 600 })),
			unit(delta({ query: 'grosse', curClicks: 10, priClicks: 210, curImpr: 900, priImpr: 3000 }))
		];
		const sel = selectDeclines(units, { ...T, maxCandidates: 1 }, 4);
		expect(sel.units).toHaveLength(1);
		expect(sel.units[0].kind === 'query' && sel.units[0].query).toBe('grosse');
		expect(sel.matched).toHaveLength(2);
		expect(sel.totalMatched).toBe(2);
		expect(sel.truncated).toBe(true);
	});

	it('⭐ `matched` reste COMPLET sous le plafond — c’est la closure FIND-003', () => {
		// Auto-résoudre depuis `units` fermerait à tort les findings simplement non
		// réécrits (barberconcept : 1310 matched pour 50 écrits sur les opportunités).
		const units = Array.from({ length: 7 }, (_, i) =>
			unit(delta({ query: `q${i}`, curClicks: 1, priClicks: 30, curImpr: 400, priImpr: 900 }))
		);
		const sel = selectDeclines(units, { ...T, maxCandidates: 2 }, 4);
		expect(sel.units).toHaveLength(2);
		expect(sel.matched).toHaveLength(7);
	});

	it('départage deux pertes égales par le niveau de confirmation', () => {
		const a = unit(delta({ query: 'a', curClicks: 5, priClicks: 45, curImpr: 900, priImpr: 1000 }), {
			confirmation: 'emerging'
		});
		const b = unit(delta({ query: 'b', curClicks: 5, priClicks: 45, curImpr: 900, priImpr: 1000 }), {
			confirmation: 'confirmed'
		});
		const sel = selectDeclines([a, b], T, 4);
		expect(sel.units[0].kind === 'query' && sel.units[0].query).toBe('b');
	});
});

describe('weeklyClickLoss', () => {
	it('divise la perte par le nombre de semaines et ne rend jamais un gain', () => {
		expect(weeklyClickLoss(delta({ curClicks: 0, priClicks: 40, curImpr: 10, priImpr: 10 }), 4)).toBe(10);
		expect(weeklyClickLoss(delta({ curClicks: 40, priClicks: 0, curImpr: 10, priImpr: 10 }), 4)).toBe(0);
	});
});

// ── Scoring et sévérité ─────────────────────────────────────────────

describe('scoreDecline', () => {
	const season = seasonalityUnavailable('no_year_ago_data');

	it('une grosse perte confirmée sur fenêtre pleine score haut', () => {
		const u = unit(delta({ curClicks: 5, priClicks: 205, curImpr: 3000, priImpr: 6000 }));
		const s = scoreDecline(u, { thresholds: T, completeness: completeness(), weeks: 4, seasonality: season });
		expect(computePriorityScore(s)).toBeGreaterThanOrEqual(60);
	});

	it('⭐ une fenêtre incomplète BAISSE la confiance sans bloquer le finding', () => {
		const u = unit(delta({ curClicks: 5, priClicks: 205, curImpr: 3000, priImpr: 6000 }));
		const full = scoreDecline(u, { thresholds: T, completeness: completeness(), weeks: 4, seasonality: season });
		const partial = scoreDecline(u, {
			thresholds: T,
			completeness: completeness({ complete: false, coverage: 0.5, weeks: 2, caveats: ['fenêtre incomplète (2/4 semaines)'] }),
			weeks: 4,
			seasonality: season
		});
		expect(partial.confidence).toBeLessThan(full.confidence);
		expect(partial.confidenceCaveats).toContain('fenêtre incomplète (2/4 semaines)');
	});

	it('une baisse `emerging` porte moins de confiance qu’une confirmée', () => {
		const d = delta({ curClicks: 5, priClicks: 205, curImpr: 3000, priImpr: 6000 });
		const confirmed = scoreDecline(unit(d), { thresholds: T, completeness: completeness(), weeks: 4, seasonality: season });
		const emerging = scoreDecline(unit(d, { confirmation: 'emerging' }), {
			thresholds: T,
			completeness: completeness(),
			weeks: 4,
			seasonality: season
		});
		expect(emerging.confidence).toBeLessThan(confirmed.confidence);
		expect(emerging.confidenceCaveats.join(' ')).toContain('une seule semaine');
	});

	it('⭐ la saisonnalité ABSENTE est dite, jamais traitée comme neutre', () => {
		const s = scoreDecline(unit(delta({ curClicks: 5, priClicks: 205, curImpr: 3000, priImpr: 6000 })), {
			thresholds: T,
			completeness: completeness(),
			weeks: 4,
			seasonality: season
		});
		expect(s.confidenceCaveats.join(' ')).toContain('saisonnalité non évaluable');
	});
});

describe('deriveDeclineSeverity', () => {
	const base = { thresholds: T, confidenceScore: 90, confirmation: 'confirmed' as const };

	it('un score élevé, confirmé et volumineux atteint critical', () => {
		expect(deriveDeclineSeverity({ ...base, priorityScore: 85, priorImpressions: 5000 })).toBe('critical');
	});

	it('⭐ une baisse `emerging` ne dépasse JAMAIS medium, quelle que soit l’ampleur', () => {
		// Une chute de 90 % sur une seule semaine peut être une semaine fériée.
		expect(
			deriveDeclineSeverity({ ...base, priorityScore: 95, priorImpressions: 50000, confirmation: 'emerging' })
		).toBe('medium');
	});

	it('le faible volume plafonne aussi à medium (FIND-002)', () => {
		expect(deriveDeclineSeverity({ ...base, priorityScore: 85, priorImpressions: 60 })).toBe('medium');
	});

	it('une confiance dégradée plafonne à medium', () => {
		expect(
			deriveDeclineSeverity({ ...base, priorityScore: 85, priorImpressions: 5000, confidenceScore: 30 })
		).toBe('medium');
	});

	it('un plafond ne REMONTE jamais une sévérité basse', () => {
		expect(
			deriveDeclineSeverity({ ...base, priorityScore: 10, priorImpressions: 60, confirmation: 'emerging' })
		).toBe('info');
	});
});

// ── Preuves, titre, raison ──────────────────────────────────────────

describe('preuves et libellés', () => {
	const season = seasonalityUnavailable('no_year_ago_data');
	const d = delta({ curClicks: 5, priClicks: 45, curImpr: 900, priImpr: 2000, curPos: 14, priPos: 8 });

	it('les preuves restent des POINTEURS et bornent le détail par requête', () => {
		const members: DeclineCandidate[] = Array.from({ length: 40 }, (_, i) => ({
			query: `q${String(i).padStart(2, '0')}`,
			page: 'p1',
			confirmation: 'confirmed',
			delta: d,
			signals: ['clicks'],
			primary: null,
			recent: null
		}));
		const u: DeclineUnit = {
			kind: 'page',
			page: 'p1',
			group: { page: 'p1', members, pageDelta: d, signals: ['clicks'], confirmation: 'confirmed' },
			delta: d,
			signals: ['clicks'],
			confirmation: 'confirmed'
		};
		const ev = buildDeclineEvidence({
			unit: u,
			score: scoreDecline(u, { thresholds: T, completeness: completeness(), weeks: 4, seasonality: season }),
			weeks: 4,
			windows: { primary: null, recent: null },
			seasonality: season
		});
		expect(ev.detector).toBe(DETECTOR_KEYWORD_DECLINE);
		expect(ev.granularity).toBe('page');
		expect(ev.queries).toHaveLength(MAX_EVIDENCE_QUERIES);
		// Le compte complet reste dit : une troncature n'est jamais silencieuse.
		expect(ev.queryCount).toBe(40);
		expect(JSON.stringify(ev)).not.toContain('undefined');
	});

	it('le titre ne porte AUCUNE date (il est réécrit à chaque re-détection)', () => {
		expect(buildDeclineTitle(unit(d))).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	});

	it('la raison nomme chaque seuil franchi et le niveau de confirmation', () => {
		const u = unit(d, { signals: ['clicks', 'position'] });
		const reason = buildDeclineReason(u, T);
		expect(reason).toContain('clics 45 → 5');
		expect(reason).toContain('rangs');
		expect(reason).toContain('confirmation');
	});
});

// ── Passe complète ──────────────────────────────────────────────────

describe('runDeclinePass', () => {
	const rows = (specs: [string, string, number, number][], week: string) =>
		specs.map(([query, page, clicks, impressions]) =>
			row({ query, page, clicks, impressions, periodStart: week })
		);

	it('⭐ AUCUNE fenêtre comparable ⇒ AUCUN finding, et la raison est dite', () => {
		// L'acceptation FIND-005 la plus importante : un historique trop court ne
		// produit pas une baisse à faible confiance, il ne produit pas de baisse.
		const res = runDeclinePass({
			primaryCurrentRows: rows([['a', 'p1', 5, 900]], 'w2'),
			primaryPriorRows: [],
			primaryComparable: false,
			recentCurrentRows: rows([['a', 'p1', 5, 900]], 'w2'),
			recentPriorRows: [],
			recentComparable: false,
			thresholds: T
		});
		expect(res.selection.units).toEqual([]);
		expect(res.selection.matched).toEqual([]);
		expect(res.skippedReason).toMatch(/aucune fenêtre comparable/);
	});

	it('une fenêtre comparable SANS baisse n’est pas un run sauté', () => {
		const res = runDeclinePass({
			primaryCurrentRows: rows([['a', 'p1', 40, 1000]], 'w2'),
			primaryPriorRows: rows([['a', 'p1', 38, 990]], 'w1'),
			primaryComparable: true,
			recentCurrentRows: [],
			recentPriorRows: [],
			recentComparable: false,
			thresholds: T
		});
		expect(res.selection.totalMatched).toBe(0);
		expect(res.skippedReason).toBeNull();
		expect(res.matchedPairs).toBe(1);
	});

	it('détecte, croise les deux fenêtres et compte les couples hors périmètre', () => {
		const res = runDeclinePass({
			primaryCurrentRows: rows(
				[
					['a', 'p1', 5, 900],
					['stable', 'p2', 30, 800]
				],
				'w2'
			),
			primaryPriorRows: rows(
				[
					['a', 'p1', 45, 2000],
					['stable', 'p2', 29, 790],
					['parti', 'p3', 50, 1500]
				],
				'w1'
			),
			primaryComparable: true,
			recentCurrentRows: rows([['a', 'p1', 1, 200]], 'w2'),
			recentPriorRows: rows([['a', 'p1', 12, 500]], 'w1'),
			recentComparable: true,
			thresholds: T
		});
		expect(res.selection.totalMatched).toBe(1);
		expect(res.selection.matched[0].confirmation).toBe('confirmed');
		expect(res.vanished).toBe(1);
		expect(res.matchedPairs).toBe(2);
	});

	it('le bruit configuré est exclu et compté', () => {
		const res = runDeclinePass({
			primaryCurrentRows: rows([['ma marque', 'p1', 5, 900]], 'w2'),
			primaryPriorRows: rows([['ma marque', 'p1', 45, 2000]], 'w1'),
			primaryComparable: true,
			recentCurrentRows: [],
			recentPriorRows: [],
			recentComparable: false,
			thresholds: { ...T, excludeQueryPatterns: ['marque'] }
		});
		expect(res.selection.totalMatched).toBe(0);
		expect(res.excludedByNoise).toBe(1);
	});

	it('⭐ sans le 4 semaines, tout ce que le 1 semaine trouve reste `emerging`', () => {
		// C'est l'état RÉEL du parc aujourd'hui : l'historique n'a pas encore 8
		// semaines, donc rien ne peut être confirmé — et rien ne dépassera `medium`.
		const res = runDeclinePass({
			primaryCurrentRows: [],
			primaryPriorRows: [],
			primaryComparable: false,
			recentCurrentRows: rows([['a', 'p1', 2, 300]], 'w2'),
			recentPriorRows: rows([['a', 'p1', 40, 900]], 'w1'),
			recentComparable: true,
			thresholds: T
		});
		expect(res.selection.totalMatched).toBe(1);
		expect(res.selection.matched[0].confirmation).toBe('emerging');
	});

	it('regroupe une page qui décroche en UNE unité au lieu de N', () => {
		const specs = (clicks: number, impressions: number): [string, string, number, number][] =>
			['a', 'b', 'c'].map((q) => [q, 'p1', clicks, impressions] as [string, string, number, number]);
		const res = runDeclinePass({
			primaryCurrentRows: rows(specs(1, 200), 'w2'),
			primaryPriorRows: rows(specs(20, 800), 'w1'),
			primaryComparable: true,
			recentCurrentRows: [],
			recentPriorRows: [],
			recentComparable: false,
			thresholds: T
		});
		expect(res.selection.totalMatched).toBe(1);
		expect(res.selection.matched[0].kind).toBe('page');
		expect(res.selection.groupsFormed).toBe(1);
	});
});
