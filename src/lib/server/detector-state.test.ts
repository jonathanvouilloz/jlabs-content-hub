import { describe, it, expect } from 'vitest';
import {
	DETECTOR_KEYWORD_OPPORTUNITY,
	OPPORTUNITY_DEFAULTS,
	resolveThresholds,
	isExcludedQuery,
	buildWindow,
	areWindowsComparable,
	aggregateWindow,
	selectOpportunities,
	scoreOpportunity,
	deriveOpportunitySeverity,
	buildOpportunityEvidence,
	buildOpportunityTitle,
	MAX_EVIDENCE_IDS,
	type ObservationRow,
	type ObservationWindow
} from './detector-state.js';
import { computePriorityScore, deriveFindingFingerprint } from './finding-state.js';

// ── Fixtures ────────────────────────────────────────────────────────

const WEEKS = [
	{ periodStart: '2026-06-29', periodEnd: '2026-07-05' },
	{ periodStart: '2026-07-06', periodEnd: '2026-07-12' },
	{ periodStart: '2026-07-13', periodEnd: '2026-07-19' },
	{ periodStart: '2026-06-22', periodEnd: '2026-06-28' }
];

const WINDOW: ObservationWindow = { start: '2026-06-22', end: '2026-07-19', weeks: 4 };

function obs(over: Partial<ObservationRow> & { id: string }): ObservationRow {
	return {
		query: 'coiffeur geneve',
		page: 'https://x.ch/coiffeur',
		clicks: 1,
		impressions: 100,
		position: 8,
		periodStart: '2026-07-13',
		...over
	};
}

describe('identité versionnée du détecteur (FIND-001)', () => {
	it('la version porte le nom du détecteur et un numéro', () => {
		expect(DETECTOR_KEYWORD_OPPORTUNITY).toBe('keyword_opportunity@1');
	});
});

describe('resolveThresholds (seuils configurables par projet — FIND-004)', () => {
	it('sans override → défauts', () => {
		expect(resolveThresholds()).toEqual(OPPORTUNITY_DEFAULTS);
		expect(resolveThresholds(null)).toEqual(OPPORTUNITY_DEFAULTS);
	});

	it('override partiel appliqué, reste inchangé', () => {
		const t = resolveThresholds({ minImpressions: 5, positionMax: 40 });
		expect(t.minImpressions).toBe(5);
		expect(t.positionMax).toBe(40);
		expect(t.targetCtr).toBe(OPPORTUNITY_DEFAULTS.targetCtr);
	});

	it('override corrompu ignoré (jamais de seuil désactivé par erreur)', () => {
		const t = resolveThresholds({
			minImpressions: Number.NaN,
			positionMin: -3,
			maxCandidates: Number.POSITIVE_INFINITY
		} as Partial<typeof OPPORTUNITY_DEFAULTS>);
		expect(t.minImpressions).toBe(OPPORTUNITY_DEFAULTS.minImpressions);
		expect(t.positionMin).toBe(OPPORTUNITY_DEFAULTS.positionMin);
		expect(t.maxCandidates).toBe(OPPORTUNITY_DEFAULTS.maxCandidates);
	});
});

describe('buildWindow / areWindowsComparable (GSC-004)', () => {
	it('retient les N semaines les plus récentes, bornes exactes', () => {
		const w = buildWindow(WEEKS, 3);
		expect(w).toEqual({ start: '2026-06-29', end: '2026-07-19', weeks: 3 });
	});

	it('moins de semaines disponibles que demandé → fenêtre plus courte, pas une erreur', () => {
		expect(buildWindow(WEEKS.slice(0, 2), 4)?.weeks).toBe(2);
	});

	it('aucune semaine → null (absence de donnée ≠ zéro)', () => {
		expect(buildWindow([], 4)).toBeNull();
	});

	it('refuse de comparer des fenêtres de longueurs différentes', () => {
		expect(areWindowsComparable(WINDOW, { ...WINDOW, weeks: 3 })).toBe(false);
		expect(areWindowsComparable(WINDOW, { ...WINDOW })).toBe(true);
		expect(areWindowsComparable({ ...WINDOW, weeks: 0 }, { ...WINDOW, weeks: 0 })).toBe(false);
	});
});

describe('aggregateWindow', () => {
	it('somme les métriques et pondère la position par les impressions', () => {
		const rows = [
			obs({ id: 'a', impressions: 1000, position: 4, clicks: 10, periodStart: '2026-07-06' }),
			obs({ id: 'b', impressions: 10, position: 40, clicks: 0, periodStart: '2026-07-13' })
		];
		const [pair] = aggregateWindow(rows);
		expect(pair.impressions).toBe(1010);
		expect(pair.clicks).toBe(10);
		// (4×1000 + 40×10) / 1010 ≈ 4.36 — la ligne à 10 impressions ne tire pas la moyenne.
		expect(pair.position).toBeCloseTo(4.356, 2);
		expect(pair.ctr).toBeCloseTo(10 / 1010, 5);
		expect(pair.weeksSeen).toBe(2);
		expect(pair.observationIds).toEqual(['a', 'b']);
	});

	it('sépare les couples query×page distincts', () => {
		const pairs = aggregateWindow([
			obs({ id: 'a', query: 'q1', page: 'p1' }),
			obs({ id: 'b', query: 'q1', page: 'p2' }),
			obs({ id: 'c', query: 'q2', page: 'p1' })
		]);
		expect(pairs).toHaveLength(3);
	});

	it('rejouable : l’ordre d’arrivée ne change pas le résultat', () => {
		const rows = [
			obs({ id: 'a', query: 'b-query', impressions: 300 }),
			obs({ id: 'b', query: 'a-query', impressions: 200 }),
			obs({ id: 'c', query: 'b-query', impressions: 100, periodStart: '2026-07-06' })
		];
		expect(aggregateWindow(rows)).toEqual(aggregateWindow([...rows].reverse()));
	});

	it('aucune impression → position et CTR à 0 sans division par zéro', () => {
		const [pair] = aggregateWindow([obs({ id: 'a', impressions: 0, clicks: 0, position: 0 })]);
		expect(pair.position).toBe(0);
		expect(pair.ctr).toBe(0);
	});
});

describe('selectOpportunities (signal §10.4)', () => {
	const t = OPPORTUNITY_DEFAULTS;

	it('retient un couple à volume suffisant, position exploitable et CTR sous cible', () => {
		const picked = selectOpportunities(
			aggregateWindow([obs({ id: 'a', impressions: 500, clicks: 5, position: 7 })]),
			t
		);
		expect(picked.candidates).toHaveLength(1);
		expect(picked.candidates[0].gainEstimate).toBe(45); // 500 × (0.10 − 0.01)
		expect(picked.truncated).toBe(false);
		expect(picked.excludedByNoise).toBe(0);
	});

	it('exclut sous le seuil d’impressions', () => {
		expect(
			selectOpportunities(aggregateWindow([obs({ id: 'a', impressions: 10, position: 7 })]), t)
				.candidates
		).toHaveLength(0);
	});

	it('exclut hors de la plage de position (déjà top 3 / trop loin)', () => {
		expect(
			selectOpportunities(aggregateWindow([obs({ id: 'a', impressions: 500, position: 2 })]), t)
				.candidates
		).toHaveLength(0);
		expect(
			selectOpportunities(aggregateWindow([obs({ id: 'a', impressions: 500, position: 60 })]), t)
				.candidates
		).toHaveLength(0);
	});

	it('exclut quand le CTR atteint déjà la cible (rien à récupérer)', () => {
		expect(
			selectOpportunities(
				aggregateWindow([obs({ id: 'a', impressions: 500, clicks: 100, position: 7 })]),
				t
			).candidates
		).toHaveLength(0);
	});

	it('exclut le bruit CONFIGURÉ (marque/navigationnel) et le compte', () => {
		const pairs = aggregateWindow([
			obs({ id: 'a', query: 'barber concept geneve', impressions: 500, clicks: 0, position: 7 }),
			obs({ id: 'b', query: 'coupe homme', impressions: 500, clicks: 0, position: 7 })
		]);
		const res = selectOpportunities(pairs, { ...t, excludeQueryPatterns: ['barber concept'] });
		expect(res.candidates.map((c) => c.query)).toEqual(['coupe homme']);
		expect(res.excludedByNoise).toBe(1);
	});

	it('sans liste configurée, rien n’est filtré implicitement', () => {
		const pairs = aggregateWindow([
			obs({ id: 'a', query: 'barber concept', impressions: 500, clicks: 0, position: 7 })
		]);
		expect(selectOpportunities(pairs, t).candidates).toHaveLength(1);
	});

	it('trie par gain décroissant et respecte maxCandidates', () => {
		const pairs = aggregateWindow([
			obs({ id: 'a', query: 'petit', impressions: 100, clicks: 0, position: 7 }),
			obs({ id: 'b', query: 'gros', impressions: 900, clicks: 0, position: 7 }),
			obs({ id: 'c', query: 'moyen', impressions: 400, clicks: 0, position: 7 })
		]);
		expect(selectOpportunities(pairs, t).candidates.map((c) => c.query)).toEqual([
			'gros',
			'moyen',
			'petit'
		]);
		const capped = selectOpportunities(pairs, { ...t, maxCandidates: 2 });
		expect(capped.candidates).toHaveLength(2);
		// La troncature est reportée : jamais un « tout est couvert » mensonger.
		expect(capped.truncated).toBe(true);
		expect(capped.totalMatched).toBe(3);
	});
});

describe('scoreOpportunity + computePriorityScore (§10.2)', () => {
	const t = OPPORTUNITY_DEFAULTS;
	const strong = selectOpportunities(
		aggregateWindow(
			WEEKS.map((w, i) =>
				obs({ id: `o${i}`, impressions: 900, clicks: 5, position: 5, periodStart: w.periodStart })
			)
		),
		t
	).candidates[0];

	it('les composantes restent dans leurs plafonds §10.2', () => {
		const s = scoreOpportunity(strong, { window: WINDOW, thresholds: t });
		expect(s.impact).toBeLessThanOrEqual(40);
		expect(s.urgency).toBeLessThanOrEqual(25);
		expect(s.confidence).toBeLessThanOrEqual(20);
		expect(s.strategicFit).toBeLessThanOrEqual(15);
		expect(computePriorityScore(s)).toBeLessThanOrEqual(100);
	});

	it('fenêtre complète + couple persistant → confiance pleine, aucun caveat', () => {
		const s = scoreOpportunity(strong, { window: WINDOW, thresholds: t });
		expect(s.confidenceScore).toBe(100);
		expect(s.confidenceCaveats).toEqual([]);
	});

	it('fenêtre incomplète → confiance BAISSÉE et caveat explicite (GSC-004)', () => {
		const partialWindow: ObservationWindow = { start: '2026-07-13', end: '2026-07-19', weeks: 1 };
		const s = scoreOpportunity(strong, { window: partialWindow, thresholds: t });
		const full = scoreOpportunity(strong, { window: WINDOW, thresholds: t });
		expect(s.confidence).toBeLessThan(full.confidence);
		expect(s.confidenceCaveats.join(' ')).toContain('fenêtre incomplète');
	});

	it('couple vu sur une seule semaine de la fenêtre → confiance dégradée', () => {
		const sporadic = selectOpportunities(
			aggregateWindow([obs({ id: 'a', impressions: 900, clicks: 0, position: 5 })]),
			t
		).candidates[0];
		const s = scoreOpportunity(sporadic, { window: WINDOW, thresholds: t });
		expect(s.confidenceScore).toBe(25); // 1 semaine vue / 4 de fenêtre
		expect(s.confidenceCaveats.join(' ')).toContain('1/4 semaines');
	});

	it('urgence plus forte pour une position proche du top', () => {
		const near = scoreOpportunity({ ...strong, position: 5 }, { window: WINDOW, thresholds: t });
		const far = scoreOpportunity({ ...strong, position: 22 }, { window: WINDOW, thresholds: t });
		expect(near.urgency).toBeGreaterThan(far.urgency);
	});

	it('déterministe : deux appels identiques donnent le même score', () => {
		const a = scoreOpportunity(strong, { window: WINDOW, thresholds: t });
		const b = scoreOpportunity(strong, { window: WINDOW, thresholds: t });
		expect(a).toEqual(b);
	});
});

describe('deriveOpportunitySeverity (plafond faible volume — FIND-002)', () => {
	const t = OPPORTUNITY_DEFAULTS;

	it('score élevé + volume solide → sévérité haute', () => {
		expect(
			deriveOpportunitySeverity({
				priorityScore: 85,
				impressions: 5000,
				thresholds: t,
				confidenceScore: 100
			})
		).toBe('critical');
	});

	it('score élevé mais FAIBLE VOLUME → plafonné à medium', () => {
		expect(
			deriveOpportunitySeverity({
				priorityScore: 85,
				impressions: 40,
				thresholds: t,
				confidenceScore: 100
			})
		).toBe('medium');
	});

	it('score élevé mais confiance basse → plafonné à medium', () => {
		expect(
			deriveOpportunitySeverity({
				priorityScore: 90,
				impressions: 5000,
				thresholds: t,
				confidenceScore: 25
			})
		).toBe('medium');
	});

	it('score bas → sévérité basse, le plafond ne remonte jamais rien', () => {
		expect(
			deriveOpportunitySeverity({
				priorityScore: 10,
				impressions: 20,
				thresholds: t,
				confidenceScore: 20
			})
		).toBe('info');
	});
});

describe('preuves = POINTEURS (piège DATA-005)', () => {
	const t = OPPORTUNITY_DEFAULTS;
	const candidate = selectOpportunities(
		aggregateWindow([obs({ id: 'obs-1', impressions: 500, clicks: 2, position: 7 })]),
		t
	).candidates[0];

	it('embarque des ids et des mesures, jamais de texte de contenu', () => {
		const score = scoreOpportunity(candidate, { window: WINDOW, thresholds: t });
		const ev = buildOpportunityEvidence({ candidate, window: WINDOW, score });
		expect(ev.observationIds).toEqual(['obs-1']);
		expect(ev.window).toEqual({ start: '2026-06-22', end: '2026-07-19', weeks: 4 });
		expect(ev.metrics.impressions).toBe(500);
		expect(ev.scoreBreakdown.impact).toBe(score.impact);
	});

	it('plafonne le nombre d’ids embarqués mais garde le compte réel', () => {
		const many = { ...candidate, observationIds: Array.from({ length: 120 }, (_, i) => `o${i}`) };
		const score = scoreOpportunity(many, { window: WINDOW, thresholds: t });
		const ev = buildOpportunityEvidence({ candidate: many, window: WINDOW, score });
		expect(ev.observationIds).toHaveLength(MAX_EVIDENCE_IDS);
		expect(ev.observationCount).toBe(120);
	});
});

describe('fingerprint (dédup inter-semaines)', () => {
	it('le même couple query×page produit la même clé d’une semaine à l’autre', () => {
		const key = (page: string) =>
			deriveFindingFingerprint({
				type: 'keyword_opportunity',
				entityType: 'query',
				entityKey: 'coiffeur geneve',
				discriminators: [page]
			});
		expect(key('https://x.ch/a')).toBe(key('https://x.ch/a'));
		expect(key('https://x.ch/a')).not.toBe(key('https://x.ch/b'));
	});

	it('le titre ne contient pas de date (réécrit à chaque re-détection sans faux diff)', () => {
		const t = OPPORTUNITY_DEFAULTS;
		const c = selectOpportunities(
			aggregateWindow([obs({ id: 'a', impressions: 500, clicks: 2, position: 7 })]),
			t
		).candidates[0];
		expect(buildOpportunityTitle(c)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	});
});

describe('isExcludedQuery', () => {
	it('insensible à la casse, sur sous-chaîne', () => {
		expect(isExcludedQuery('Barber Concept Genève', ['barber concept'])).toBe(true);
		expect(isExcludedQuery('coupe homme', ['barber concept'])).toBe(false);
	});

	it('liste vide → aucune exclusion', () => {
		expect(isExcludedQuery('nimporte quoi', [])).toBe(false);
	});
});
