import { describe, it, expect } from 'vitest';
import {
	DETECTOR_INDEX_TRANSITION,
	INDEX_TRANSITION_DEFAULTS,
	NOTIFY_IMMEDIATELY_REASON,
	buildStateSeries,
	buildTransitionEvidence,
	buildTransitionTitle,
	classifyNotIndexedKind,
	computeTransitionConfidence,
	confirmTransition,
	decideStrategic,
	deriveTransitionSeverity,
	resolveIndexTransitionConfig,
	scoreTransition,
	shouldNotifyImmediately,
	type IndexStateSeries,
	type StrategicContext
} from './index-transition-state.js';
import { classifyCoverage } from '../collectors/url-inspection-state.js';
import { computePriorityScore } from '../finding-state.js';

const CONFIG = resolveIndexTransitionConfig();

/** Fabrique une série depuis des `coverageState` bruts — la classe est DÉRIVÉE, comme en lecture. */
function series(url: string, states: (string | null)[]): IndexStateSeries {
	return buildStateSeries(
		states.map((coverageState, i) => ({
			url,
			observationId: `obs-${i}`,
			observedDate: `2026-05-${String(i + 1).padStart(2, '0')}`,
			coverageState,
			indexedClass: classifyCoverage(coverageState)
		}))
	)[0];
}

const INDEXED = 'Submitted and indexed';
const CRAWLED = 'Crawled - currently not indexed';
const DISCOVERED = 'Discovered - currently not indexed';
const NOINDEX = "Excluded by 'noindex' tag";
const NOT_FOUND = 'Not found (404)';

// ── Nuance de « non indexé » ────────────────────────────────────────

describe('classifyNotIndexedKind — affine sans dupliquer classifyCoverage', () => {
	it('sépare crawled et discovered, les deux types §10.4', () => {
		expect(classifyNotIndexedKind(CRAWLED)).toBe('crawled');
		expect(classifyNotIndexedKind(DISCOVERED)).toBe('discovered');
	});

	it('tout le reste est `other` — aucun type inventé', () => {
		expect(classifyNotIndexedKind(NOT_FOUND)).toBe('other');
		expect(classifyNotIndexedKind('URL is unknown to Google')).toBe('other');
		expect(classifyNotIndexedKind(null)).toBe('other');
	});
});

// ── Série ───────────────────────────────────────────────────────────

describe('buildStateSeries — ordre TOTAL, indépendant de l’arrivée', () => {
	it('groupe par URL et ordonne du plus ancien au plus récent', () => {
		const built = buildStateSeries([
			{
				url: 'https://x.ch/b',
				observationId: 'o3',
				observedDate: '2026-05-03',
				coverageState: INDEXED,
				indexedClass: 'indexed'
			},
			{
				url: 'https://x.ch/a',
				observationId: 'o2',
				observedDate: '2026-05-02',
				coverageState: INDEXED,
				indexedClass: 'indexed'
			},
			{
				url: 'https://x.ch/a',
				observationId: 'o1',
				observedDate: '2026-05-01',
				coverageState: CRAWLED,
				indexedClass: 'not_indexed'
			}
		]);
		expect(built.map((s) => s.url)).toEqual(['https://x.ch/a', 'https://x.ch/b']);
		expect(built[0].points.map((p) => p.observedDate)).toEqual(['2026-05-01', '2026-05-02']);
	});

	it('rejouable : deux ordres d’entrée rendent le MÊME résultat', () => {
		const rows = [
			{
				url: 'https://x.ch/a',
				observationId: 'o1',
				observedDate: '2026-05-01',
				coverageState: INDEXED,
				indexedClass: 'indexed' as const
			},
			{
				url: 'https://x.ch/a',
				observationId: 'o2',
				observedDate: '2026-05-02',
				coverageState: CRAWLED,
				indexedClass: 'not_indexed' as const
			}
		];
		expect(buildStateSeries(rows)).toEqual(buildStateSeries([...rows].reverse()));
	});
});

// ── Ce qui NE produit rien ──────────────────────────────────────────

describe('confirmTransition — le silence est la réponse par défaut', () => {
	it('une page indexée ne produit aucun finding', () => {
		expect(confirmTransition(series('https://x.ch/a', [INDEXED, INDEXED]), CONFIG)).toBeNull();
	});

	it('`excluded` ne produit RIEN : c’est une décision du site, pas une panne', () => {
		expect(confirmTransition(series('https://x.ch/a', [NOINDEX, NOINDEX]), CONFIG)).toBeNull();
	});

	it('`indexed → excluded` n’est PAS un index_drop — le site a posé un noindex', () => {
		expect(
			confirmTransition(series('https://x.ch/a', [INDEXED, NOINDEX, NOINDEX]), CONFIG)
		).toBeNull();
	});

	it('une série entièrement illisible ne dit rien : ne pas savoir n’est pas un fait', () => {
		expect(confirmTransition(series('https://x.ch/a', [null, null]), CONFIG)).toBeNull();
	});

	it('un `not_indexed` de nature `other` jamais indexé ne reçoit AUCUN type §10.4', () => {
		// « Not found (404) » sans état indexé antérieur relève du sitemap, pas de l'indexation :
		// lui coller un type serait inventer un diagnostic.
		expect(
			confirmTransition(series('https://x.ch/a', [NOT_FOUND, NOT_FOUND]), CONFIG)
		).toBeNull();
	});
});

// ── Confirmation ────────────────────────────────────────────────────

describe('confirmTransition — confirmation et fluctuation (acceptation 2)', () => {
	it('une bascule ISOLÉE reste `pending` : le fait est dit, pas crié', () => {
		const v = confirmTransition(series('https://x.ch/a', [INDEXED, INDEXED, CRAWLED]), CONFIG)!;
		expect(v.type).toBe('index_drop');
		expect(v.status).toBe('pending');
		expect(v.streak).toBe(1);
		expect(v.required).toBe(2);
		expect(v.confidenceCaveats.join(' ')).toContain('non confirmé');
	});

	it('deux observations consécutives confirment', () => {
		const v = confirmTransition(
			series('https://x.ch/a', [INDEXED, CRAWLED, CRAWLED]),
			CONFIG
		)!;
		expect(v.status).toBe('confirmed');
		expect(v.streak).toBe(2);
		expect(v.previousClass).toBe('indexed');
		expect(v.since).toBe('2026-05-02');
	});

	it('une oscillation baisse la confiance même une fois confirmée', () => {
		const stable = confirmTransition(series('https://x.ch/a', [INDEXED, CRAWLED, CRAWLED]), CONFIG)!;
		const flappy = confirmTransition(
			series('https://x.ch/a', [INDEXED, CRAWLED, INDEXED, CRAWLED, CRAWLED]),
			CONFIG
		)!;
		expect(flappy.status).toBe('confirmed');
		expect(flappy.flips).toBe(3);
		expect(flappy.confidenceScore).toBeLessThan(stable.confidenceScore);
		expect(flappy.confidenceCaveats.join(' ')).toContain('instable');
	});

	it('un seuil relevé retarde la confirmation, sans changer le fait', () => {
		const strict = resolveIndexTransitionConfig({ confirmAfterObservations: 3 });
		const v = confirmTransition(series('https://x.ch/a', [INDEXED, CRAWLED, CRAWLED]), strict)!;
		expect(v.status).toBe('pending');
		expect(v.required).toBe(3);
	});
});

describe('confirmTransition — `unknown` n’est PAS un état', () => {
	it('une inspection illisible ne ROMPT pas le streak', () => {
		// Sans cette règle, une seule erreur de lecture repousserait indéfiniment la confirmation
		// d'une désindexation bien réelle.
		const v = confirmTransition(
			series('https://x.ch/a', [INDEXED, CRAWLED, null, CRAWLED]),
			CONFIG
		)!;
		expect(v.status).toBe('confirmed');
		expect(v.streak).toBe(2);
		expect(v.unknownSkipped).toBe(1);
		expect(v.confidenceCaveats.join(' ')).toContain('illisible');
	});

	it('une inspection illisible ne CONFIRME rien non plus', () => {
		const v = confirmTransition(series('https://x.ch/a', [INDEXED, CRAWLED, null]), CONFIG)!;
		expect(v.status).toBe('pending');
		expect(v.streak).toBe(1);
	});

	it('les trous font baisser la confiance', () => {
		const clean = confirmTransition(series('https://x.ch/a', [INDEXED, CRAWLED, CRAWLED]), CONFIG)!;
		const holed = confirmTransition(
			series('https://x.ch/a', [INDEXED, null, CRAWLED, CRAWLED]),
			CONFIG
		)!;
		expect(holed.confidenceScore).toBeLessThan(clean.confidenceScore);
	});
});

// ── Typage de la transition ─────────────────────────────────────────

describe('confirmTransition — le type dit ce qui s’est PASSÉ', () => {
	it('jamais indexée + crawlée → crawled_not_indexed', () => {
		const v = confirmTransition(series('https://x.ch/a', [CRAWLED, CRAWLED]), CONFIG)!;
		expect(v.type).toBe('crawled_not_indexed');
		expect(v.previousClass).toBeNull();
	});

	it('jamais indexée + découverte → discovered_not_indexed', () => {
		const v = confirmTransition(series('https://x.ch/a', [DISCOVERED, DISCOVERED]), CONFIG)!;
		expect(v.type).toBe('discovered_not_indexed');
	});

	it('tombée d’`indexed` → index_drop, quelle que soit la NUANCE de coverage', () => {
		// C'est la perte qui compte, pas le libellé : une page indexée devenue « discovered » a
		// bel et bien disparu de l'index.
		for (const state of [CRAWLED, DISCOVERED, NOT_FOUND]) {
			const v = confirmTransition(series('https://x.ch/a', [INDEXED, state, state]), CONFIG)!;
			expect(v.type).toBe('index_drop');
		}
	});
});

// ── Confiance ───────────────────────────────────────────────────────

describe('computeTransitionConfidence', () => {
	it('une observation UNIQUE est plafonnée : elle suggère, elle ne prouve pas', () => {
		expect(
			computeTransitionConfidence({
				streak: 1,
				required: 1,
				flips: 0,
				unknownSkipped: 0,
				knownPoints: 1
			})
		).toBeLessThanOrEqual(40);
	});

	it('reste bornée dans [0, 100] même sous accumulation de pénalités', () => {
		const v = computeTransitionConfidence({
			streak: 1,
			required: 5,
			flips: 9,
			unknownSkipped: 9,
			knownPoints: 20
		});
		expect(v).toBeGreaterThanOrEqual(0);
		expect(v).toBeLessThanOrEqual(100);
	});
});

// ── Page stratégique ────────────────────────────────────────────────

function ctx(over: Partial<StrategicContext> = {}): StrategicContext {
	return {
		clicksByUrl: new Map(),
		declared: new Set(),
		minClicks: INDEX_TRANSITION_DEFAULTS.strategicMinClicks,
		...over
	};
}

describe('decideStrategic — chaque sélection expose sa raison', () => {
	it('sans donnée ni déclaration, AUCUNE page n’est stratégique', () => {
		// Le défaut permissif ferait passer chaque désindexation pour une urgence critique — et
		// l'alerte qui crie toujours n'est plus lue.
		expect(decideStrategic('https://x.ch/a', ctx())).toEqual({
			strategic: false,
			reason: null,
			clicks: 0
		});
	});

	it('dérivée des clics, au-dessus du seuil', () => {
		const v = decideStrategic(
			'https://x.ch/a',
			ctx({ clicksByUrl: new Map([['https://x.ch/a', 12]]) })
		);
		expect(v).toEqual({ strategic: true, reason: 'clicks', clicks: 12 });
	});

	it('sous le seuil, la page n’est pas stratégique', () => {
		const v = decideStrategic(
			'https://x.ch/a',
			ctx({ clicksByUrl: new Map([['https://x.ch/a', 1]]) })
		);
		expect(v.strategic).toBe(false);
	});

	it('déclarée sans un seul clic — une page de conversion compte quand même', () => {
		const v = decideStrategic('https://x.ch/devis', ctx({ declared: new Set(['https://x.ch/devis']) }));
		expect(v).toEqual({ strategic: true, reason: 'declared', clicks: 0 });
	});
});

// ── Sévérité et notification ────────────────────────────────────────

function verdictFor(states: (string | null)[], url = 'https://x.ch/a') {
	return confirmTransition(series(url, states), CONFIG)!;
}

describe('deriveTransitionSeverity — le plafond du non-confirmé', () => {
	it('drop confirmé sur page stratégique → critical', () => {
		const verdict = verdictFor([INDEXED, CRAWLED, CRAWLED]);
		expect(
			deriveTransitionSeverity({ verdict, strategic: true, priorityScore: 90 })
		).toBe('critical');
	});

	it('drop confirmé, page non stratégique → high', () => {
		const verdict = verdictFor([INDEXED, CRAWLED, CRAWLED]);
		expect(deriveTransitionSeverity({ verdict, strategic: false, priorityScore: 50 })).toBe('high');
	});

	it('drop NON confirmé → plafonné à medium, même sur page stratégique', () => {
		const verdict = verdictFor([INDEXED, INDEXED, CRAWLED]);
		expect(deriveTransitionSeverity({ verdict, strategic: true, priorityScore: 90 })).toBe(
			'medium'
		);
	});

	it('une confiance dégradée sous 50 plafonne aussi', () => {
		const verdict = { ...verdictFor([INDEXED, CRAWLED, CRAWLED]), confidenceScore: 30 };
		expect(deriveTransitionSeverity({ verdict, strategic: true, priorityScore: 90 })).toBe(
			'medium'
		);
	});
});

describe('shouldNotifyImmediately — le SIGNAL, pas le canal (§14.3)', () => {
	it('drop confirmé + page stratégique = notifiable', () => {
		expect(
			shouldNotifyImmediately({ verdict: verdictFor([INDEXED, CRAWLED, CRAWLED]), strategic: true })
		).toBe(true);
	});

	it('non confirmé = jamais notifiable : c’est la fatigue d’alerte que §14.3 évite', () => {
		expect(
			shouldNotifyImmediately({ verdict: verdictFor([INDEXED, INDEXED, CRAWLED]), strategic: true })
		).toBe(false);
	});

	it('page non stratégique = jamais notifiable', () => {
		expect(
			shouldNotifyImmediately({
				verdict: verdictFor([INDEXED, CRAWLED, CRAWLED]),
				strategic: false
			})
		).toBe(false);
	});

	it('un crawled_not_indexed confirmé n’est pas une désindexation', () => {
		expect(
			shouldNotifyImmediately({ verdict: verdictFor([CRAWLED, CRAWLED]), strategic: true })
		).toBe(false);
	});
});

// ── Score ───────────────────────────────────────────────────────────

describe('scoreTransition — composantes bornées du barème §10.2', () => {
	it('chaque composante respecte son plafond, et la somme tient dans 0–100', () => {
		const verdict = verdictFor([INDEXED, CRAWLED, CRAWLED]);
		const score = scoreTransition({
			verdict,
			strategic: { strategic: true, reason: 'clicks', clicks: 999 },
			config: CONFIG
		});
		expect(score.impact).toBeLessThanOrEqual(40);
		expect(score.urgency).toBeLessThanOrEqual(25);
		expect(score.confidence).toBeLessThanOrEqual(20);
		expect(score.strategicFit).toBeLessThanOrEqual(15);
		expect(computePriorityScore(score)).toBeLessThanOrEqual(100);
	});

	it('un index_drop est plus urgent qu’un discovered_not_indexed', () => {
		const strategic = { strategic: false, reason: null, clicks: 0 } as const;
		const drop = scoreTransition({
			verdict: verdictFor([INDEXED, CRAWLED, CRAWLED]),
			strategic,
			config: CONFIG
		});
		const discovered = scoreTransition({
			verdict: verdictFor([DISCOVERED, DISCOVERED]),
			strategic,
			config: CONFIG
		});
		expect(drop.urgency).toBeGreaterThan(discovered.urgency);
	});
});

// ── Config ──────────────────────────────────────────────────────────

describe('resolveIndexTransitionConfig — un override corrompu ne DÉSACTIVE jamais une garde', () => {
	it('sans override, les défauts', () => {
		expect(resolveIndexTransitionConfig()).toEqual(INDEX_TRANSITION_DEFAULTS);
		expect(resolveIndexTransitionConfig(null)).toEqual(INDEX_TRANSITION_DEFAULTS);
	});

	it('`confirmAfterObservations: 0` retombe sur le défaut — la garde tient', () => {
		expect(resolveIndexTransitionConfig({ confirmAfterObservations: 0 }).confirmAfterObservations)
			.toBe(2);
		expect(resolveIndexTransitionConfig({ confirmAfterObservations: -5 }).confirmAfterObservations)
			.toBe(2);
		expect(
			resolveIndexTransitionConfig({ confirmAfterObservations: Number.NaN })
				.confirmAfterObservations
		).toBe(2);
	});

	it('nettoie la liste de pages déclarées, sans jamais la deviner', () => {
		const c = resolveIndexTransitionConfig({
			strategicPages: ['  https://x.ch/devis ', '', '   ', 42 as unknown as string]
		});
		expect(c.strategicPages).toEqual(['https://x.ch/devis']);
	});

	it('ne partage pas son tableau par défaut entre deux appels', () => {
		const a = resolveIndexTransitionConfig({ strategicPages: ['https://x.ch/a'] });
		const b = resolveIndexTransitionConfig();
		expect(b.strategicPages).toEqual([]);
		expect(a.strategicPages).toEqual(['https://x.ch/a']);
	});
});

// ── Preuves ─────────────────────────────────────────────────────────

describe('buildTransitionEvidence — des POINTEURS, jamais du contenu', () => {
	it('porte la transition, la confirmation, la raison stratégique et le drapeau §14.3', () => {
		const s = series('https://x.ch/a', [INDEXED, CRAWLED, CRAWLED]);
		const verdict = confirmTransition(s, CONFIG)!;
		const strategic = { strategic: true, reason: 'clicks', clicks: 30 } as const;
		const score = scoreTransition({ verdict, strategic, config: CONFIG });
		const evidence = buildTransitionEvidence({ verdict, strategic, score, series: s, config: CONFIG });

		expect(evidence.detector).toBe(DETECTOR_INDEX_TRANSITION);
		expect(evidence.transition).toMatchObject({ from: 'indexed', to: 'not_indexed', kind: 'crawled' });
		expect(evidence.confirmation).toMatchObject({ status: 'confirmed', streak: 2, required: 2 });
		expect(evidence.strategic).toEqual({ value: true, reason: 'clicks', clicks: 30 });
		expect(evidence.notifyImmediately).toBe(true);
		expect(evidence.notifyReason).toBe(NOTIFY_IMMEDIATELY_REASON);
		// Des ids et des dates. Le `coverageState` est un LIBELLÉ Google (une trace), pas du
		// contenu de page : ce qu'on vérifie, c'est que la série embarquée ne porte que des
		// dates et des classes — jamais le payload d'observation, ni un extrait de la page.
		expect(evidence.observationIds.every((id) => typeof id === 'string')).toBe(true);
		expect(Object.keys(evidence.series[0])).toEqual(['observedDate', 'indexedClass']);
	});

	it('borne la série embarquée : les preuves ne sont pas un dump', () => {
		const long = Array.from({ length: 40 }, () => CRAWLED);
		const s = series('https://x.ch/a', [INDEXED, ...long]);
		const verdict = confirmTransition(s, CONFIG)!;
		const strategic = { strategic: false, reason: null, clicks: 0 } as const;
		const evidence = buildTransitionEvidence({
			verdict,
			strategic,
			score: scoreTransition({ verdict, strategic, config: CONFIG }),
			series: s,
			config: CONFIG
		});
		expect(evidence.series.length).toBeLessThanOrEqual(20);
		expect(evidence.observationIds.length).toBeLessThanOrEqual(20);
	});
});

describe('buildTransitionTitle — STABLE entre deux runs', () => {
	it('ne contient ni date, ni compteur, ni statut de confirmation', () => {
		const pending = buildTransitionTitle(verdictFor([INDEXED, INDEXED, CRAWLED]));
		const confirmed = buildTransitionTitle(verdictFor([INDEXED, CRAWLED, CRAWLED]));
		// Le problème n'a pas changé : la ligne d'inbox ne doit pas bouger non plus.
		expect(pending).toBe(confirmed);
		expect(confirmed).not.toMatch(/2026-/);
	});
});
