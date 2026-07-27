import { describe, it, expect } from 'vitest';
import {
	SECTION_ORDER,
	REPORT_SCHEMA_VERSION,
	buildWeeklyReport,
	buildReportHeadline,
	capItems,
	deriveAvailability,
	deriveBlindSpots,
	findingItem,
	isNeverExamined,
	proposalItem,
	rankItems,
	renderWeeklyReportText,
	type ReportFindingInput,
	type ReportItem,
	type ReportProposalInput,
	type ReportSet,
	type SectionKey,
	type WeeklyReport,
	type WeeklyReportInput
} from './weekly-report-state.js';
import {
	buildCounter,
	classifyProject,
	summarizePortfolio,
	type Counter,
	type DetectorCoverage,
	type ProjectCard,
	type ProjectCardInput,
	type ProjectPause
} from './home-state.js';

const NOW = new Date('2026-07-27T09:00:00Z');
const SINCE = '2026-07-20 09:00:00';
const UNTIL = '2026-07-27 09:00:00';

// ── Fixtures ────────────────────────────────────────────────────────
//
// Les cartes passent par `classifyProject`, jamais par un littéral : le rapport ne doit
// dépendre que de ce que l'accueil produit réellement. Un littéral figerait une forme de carte
// que la vraie classification pourrait ne plus rendre.

function detectors(ran: number, total = 3): DetectorCoverage[] {
	return Array.from({ length: total }, (_, i) => ({
		detector: `detect:d${i}`,
		lastSuccessAt: i < ran ? '2026-07-26 09:00:00' : null
	}));
}

function card(over: Partial<ProjectCardInput> = {}): ProjectCard {
	return classifyProject({
		projectId: `p-${over.slug ?? 'alpha'}`,
		slug: 'alpha',
		name: 'Alpha',
		color: null,
		integrations: [
			{
				provider: 'gsc',
				healthStatus: 'healthy',
				status: 'active',
				enabled: true,
				lastSuccessAt: '2026-07-26 09:00:00',
				lastErrorCode: null
			}
		],
		openBySeverity: {},
		activity: { created: 0, aggravated: 0, improved: 0, resolved: 0 },
		proposalsPending: 0,
		reviewsUnanswered: 0,
		jobsDead: 0,
		gscLastSuccessAt: '2026-07-26 09:00:00',
		detectors: detectors(3),
		sinceDb: SINCE,
		now: NOW,
		staleAfterHours: 24 * 10,
		...over
	});
}

function finding(over: Partial<ReportFindingInput> = {}): ReportFindingInput {
	return {
		id: 'f-1',
		projectSlug: 'alpha',
		type: 'keyword_opportunity',
		title: 'requête « plombier genève » en position 12',
		severity: 'medium',
		priorityScore: 60,
		status: 'open',
		occurrenceCount: 1,
		lastSeenAt: '2026-07-26 09:00:00',
		...over
	};
}

function proposal(over: Partial<ReportProposalInput> = {}): ReportProposalInput {
	return {
		id: 'ap-1',
		projectSlug: 'alpha',
		actionType: 'optimize_title',
		target: '/services/plomberie',
		status: 'proposed',
		riskLevel: 'low',
		requiredApprovalLevel: 'L2',
		createdAt: '2026-07-26 09:00:00',
		...over
	};
}

function set<T>(rows: T[], total = rows.length): ReportSet<T> {
	return { total, rows };
}

function input(over: Partial<WeeklyReportInput> = {}): WeeklyReportInput {
	const projects = over.projects ?? [card()];
	const counters: Counter[] = [
		buildCounter('nouveaux', 1, { kind: 'findings_activity', event: 'created', sinceDb: SINCE }),
		buildCounter('aggravés', 0, {
			kind: 'findings_activity',
			event: 'aggravated',
			sinceDb: SINCE
		}),
		buildCounter('résolus', 0, { kind: 'findings_activity', event: 'resolved', sinceDb: SINCE }),
		buildCounter('findings ouverts', 1, { kind: 'findings_open' })
	];
	return {
		generatedAt: UNTIL,
		sinceDb: SINCE,
		untilDb: UNTIL,
		windowDays: 7,
		portfolio: summarizePortfolio(projects),
		projects,
		counters,
		findingsNew: set([finding()]),
		findingsAggravated: set([]),
		findingsResolved: set([]),
		opportunities: set([finding({ id: 'f-opp', priorityScore: 80 })]),
		proposalsCreated: set([proposal()]),
		proposalsPending: set([proposal({ id: 'ap-2' })]),
		indexation: [
			{
				projectSlug: 'alpha',
				urlsObserved: 10,
				indexed: 8,
				notIndexed: 2,
				coverageRate: 0.8,
				dueNow: 3,
				wired: true
			}
		],
		reviews: [{ projectSlug: 'alpha', unanswered: 2, received: 4, negative: 1, wired: true }],
		traffic: [{ projectSlug: 'alpha', visits: 0, conversions: 0, wired: false }],
		costs: {
			instrumented: false,
			reason: 'not_instrumented',
			detail: 'aucun run ne porte de coût'
		},
		runStatusCounts: { succeeded: 4 },
		...over
	};
}

function sectionOf(report: WeeklyReport, key: SectionKey) {
	const s = report.sections.find((x) => x.key === key);
	if (!s) throw new Error(`section ${key} absente du rapport`);
	return s;
}

/** Le bloc de texte d'UNE section, entre son titre et le suivant. */
function textBlock(text: string, title: string): string {
	const lines = text.split('\n');
	const start = lines.findIndex((l) => l.includes(title));
	if (start < 0) throw new Error(`titre « ${title} » absent du rendu`);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => l.startsWith('## '));
	return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

// ── Acceptation 2 : « absent, pas zéro » ────────────────────────────

describe('deriveAvailability — trois absences, aucune n’est un zéro', () => {
	it('rien de branché et rien en base ⇒ not_wired', () => {
		const a = deriveAvailability({ wired: false, hasData: false, data: [], label: 'Trafic' });
		expect(a.available).toBe(false);
		if (a.available) return;
		expect(a.reason).toBe('not_wired');
		// La phrase doit NOMMER la confusion qu'on refuse. Sans elle, un lecteur pressé
		// interpréterait l'absence comme un résultat.
		expect(a.detail).toMatch(/pas la même chose que zéro/);
	});

	it('branché mais rien collecté ⇒ never_collected (geste différent)', () => {
		const a = deriveAvailability({ wired: true, hasData: false, data: [], label: 'Trafic' });
		expect(a.available).toBe(false);
		if (a.available) return;
		expect(a.reason).toBe('never_collected');
	});

	it('de la donnée SANS intégration déclarée ⇒ disponible (hasData prime)', () => {
		// Règle `derivePanelState` : un projet peut collecter via un compte de service partagé.
		// Annoncer « non branché » au-dessus de milliers d'observations serait un mensonge
		// vérifiable à l'écran d'à côté.
		const a = deriveAvailability({ wired: false, hasData: true, data: [1], label: 'Indexation' });
		expect(a.available).toBe(true);
	});
});

describe('section trafic — le provider non branché ne produit AUCUN chiffre', () => {
	const report = buildWeeklyReport(input());
	const section = sectionOf(report, 'traffic_conversions');

	it('la section est absente, pas vide', () => {
		expect(section.body.available).toBe(false);
		if (section.body.available) return;
		expect(section.body.reason).toBe('not_wired');
	});

	it('le JSON ne porte aucune métrique à 0 pour cette section', () => {
		// Structurel, pas cosmétique : `SectionBody` n'existe pas sur une section absente, donc
		// il n'y a AUCUN endroit où un `visits: 0` pourrait se loger.
		expect(JSON.stringify(section)).not.toMatch(/"value":0/);
		expect(JSON.stringify(section)).not.toMatch(/visits/);
	});

	it('le texte rendu de la section ne contient aucun chiffre', () => {
		const block = textBlock(renderWeeklyReportText(report), 'Trafic et conversions');
		expect(block).toMatch(/absent/);
		expect(block).not.toMatch(/\d/);
	});

	it('le jour où le provider est branché avec de la donnée, la section s’allume seule', () => {
		const report2 = buildWeeklyReport(
			input({
				traffic: [{ projectSlug: 'alpha', visits: 1200, conversions: 8, wired: true }]
			})
		);
		const s = sectionOf(report2, 'traffic_conversions');
		expect(s.body.available).toBe(true);
		if (!s.body.available) return;
		expect(s.body.data.metrics.map((m) => m.value)).toEqual([1200, 8]);
	});
});

describe('coûts — un gate inerte, jamais un zéro', () => {
	it('non instrumentés ⇒ value null et la dette est nommée', () => {
		const report = buildWeeklyReport(input());
		const s = sectionOf(report, 'automation_health');
		if (!s.body.available) throw new Error('section attendue disponible');
		const cost = s.body.data.metrics.find((m) => m.label === 'coûts de la période');
		expect(cost?.value).toBeNull();
		expect(cost?.display).toMatch(/non instrumentés/);
	});
});

// ── ⭐ « Jamais regardé » n'est pas « rien à signaler » ──────────────

describe('gate d’examen — une page blanche ne se lit pas comme une semaine calme', () => {
	it('aucun détecteur n’a jamais tourné ⇒ sections de findings ABSENTES', () => {
		const never = card({ detectors: detectors(0) });
		const report = buildWeeklyReport(input({ projects: [never] }));
		for (const key of [
			'findings_new',
			'findings_aggravated',
			'findings_resolved',
			'opportunities'
		] as SectionKey[]) {
			const s = sectionOf(report, key);
			expect(s.body.available, key).toBe(false);
			if (s.body.available) continue;
			expect(s.body.reason).toBe('not_examined');
		}
	});

	it('le gate prime même si des findings sont passés en entrée', () => {
		// Un parc jamais diagnostiqué PEUT porter des findings (import, run manuel, autre
		// version). Le rapport ne doit pas en conclure une couverture : le gate passe AVANT le
		// comptage, donc il n'existe aucun chemin qui écrive « 3 nouveaux findings » ici.
		const report = buildWeeklyReport(
			input({
				projects: [card({ detectors: detectors(0) })],
				findingsNew: set([finding(), finding({ id: 'f-2' }), finding({ id: 'f-3' })])
			})
		);
		expect(sectionOf(report, 'findings_new').body.available).toBe(false);
	});

	it('un parc vide est « non examiné », pas « sain »', () => {
		expect(isNeverExamined([])).toBe(true);
		const report = buildWeeklyReport(input({ projects: [], findingsNew: set([]) }));
		expect(sectionOf(report, 'findings_new').body.available).toBe(false);
	});

	it('un seul projet examiné suffit à ouvrir la section — les autres restent des angles morts', () => {
		const seen = card({ slug: 'alpha', detectors: detectors(3) });
		const blind = card({ slug: 'beta', detectors: detectors(0) });
		const report = buildWeeklyReport(input({ projects: [seen, blind], findingsNew: set([]) }));
		const s = sectionOf(report, 'findings_new');
		expect(s.body.available).toBe(true);
		if (!s.body.available) return;
		// ⭐ 0 finding ET un angle mort : la section dit les deux, sinon « 0 » se lirait
		// « rien à signaler sur tout le parc ».
		expect(s.body.data.metrics[0].value).toBe(0);
		expect(s.body.data.blindSpots.map((b) => b.projectSlug)).toEqual(['beta']);
	});
});

describe('deriveBlindSpots — trois natures de silence', () => {
	it('jamais examiné', () => {
		const spots = deriveBlindSpots([card({ detectors: detectors(0) })]);
		expect(spots[0].reason).toBe('never_examined');
		expect(spots[0].note).toMatch(/3 détecteurs attendus/);
	});

	it('aucun détecteur planifié est dit autrement que « jamais tourné »', () => {
		const spots = deriveBlindSpots([card({ detectors: [] })]);
		expect(spots[0].reason).toBe('never_examined');
		expect(spots[0].note).toMatch(/aucun détecteur planifié/);
	});

	it('partiellement examiné ⇒ nomme ce qui manque', () => {
		const spots = deriveBlindSpots([card({ detectors: detectors(1) })]);
		expect(spots[0].reason).toBe('partially_examined');
		expect(spots[0].note).toMatch(/detect:d1/);
	});

	it('une pause TOTALE est une décision, pas un manque', () => {
		const pause: ProjectPause = {
			scope: 'project',
			reason: 'client en vacances',
			actor: 'jon',
			since: '2026-07-01 09:00:00',
			until: null,
			cadences: ['weekly'],
			full: true,
			providers: [],
			suspendedJobTypes: ['detect:d0'],
			suspendsFreshness: true
		};
		const spots = deriveBlindSpots([card({ pause })]);
		expect(spots[0].reason).toBe('paused');
		expect(spots[0].note).toMatch(/client en vacances/);
	});

	it('une pause PARTIELLE ne masque pas la couverture réelle', () => {
		// `full: false` ⇒ une partie du diagnostic tourne encore. Annoncer « suspendu » ferait
		// ignorer les findings que le projet continue de produire.
		const pause: ProjectPause = {
			scope: 'project_cadence',
			reason: 'quota',
			actor: 'jon',
			since: '2026-07-01 09:00:00',
			until: null,
			cadences: ['daily'],
			full: false,
			providers: [],
			suspendedJobTypes: ['detect:d2'],
			suspendsFreshness: false
		};
		const spots = deriveBlindSpots([card({ pause, detectors: detectors(3) })]);
		expect(spots[0].reason).toBe('paused');
		expect(spots[0].note).toMatch(/plus renouvelée/);
		expect(spots[0].note).toMatch(/detect:d2/);
	});

	it('couverture complète et rien de suspendu ⇒ aucun angle mort', () => {
		expect(deriveBlindSpots([card()])).toEqual([]);
	});

	it('l’ordre est total (par slug), donc deux générations coïncident', () => {
		const a = card({ slug: 'zeta', detectors: detectors(0) });
		const b = card({ slug: 'alpha', detectors: detectors(0) });
		expect(deriveBlindSpots([a, b]).map((s) => s.projectSlug)).toEqual(['alpha', 'zeta']);
	});
});

// ── Acceptation 3 : chaque item renvoie à sa source ─────────────────

describe('sources — aucun item ne peut exister sans preuve à ouvrir', () => {
	it('tous les items de toutes les sections portent une source', () => {
		const report = buildWeeklyReport(
			input({
				projects: [card({ openBySeverity: { high: 2 }, jobsDead: 1 })]
			})
		);
		let seen = 0;
		for (const section of report.sections) {
			if (!section.body.available) continue;
			for (const item of section.body.data.items) {
				seen += 1;
				expect(item.source, `${section.key} / ${item.label}`).toBeTruthy();
				expect(item.source.kind).toBeTruthy();
			}
		}
		expect(seen).toBeGreaterThan(0);
	});

	it('un finding pointe vers son détail d’inbox', () => {
		expect(findingItem(finding({ id: 'f-42' })).source).toEqual({
			kind: 'finding',
			id: 'f-42',
			href: '/inbox/findings/f-42'
		});
	});

	it('une proposition pointe vers sa décision', () => {
		expect(proposalItem(proposal({ id: 'ap-9' })).source).toEqual({
			kind: 'proposal',
			id: 'ap-9',
			href: '/inbox/proposals/ap-9'
		});
	});

	it('le compteur de l’accueil prête son lien à la métrique de la section', () => {
		const report = buildWeeklyReport(input());
		const s = sectionOf(report, 'findings_new');
		if (!s.body.available) throw new Error('section attendue disponible');
		// Le rapport et l'écran ouvrent LITTÉRALEMENT la même liste : le lien n'est pas réécrit
		// ici, il est repris du compteur, donc il ne peut pas décrire un autre ensemble.
		expect(s.body.data.metrics[0].source?.href).toBe(
			buildCounter('x', 0, { kind: 'findings_activity', event: 'created', sinceDb: SINCE }).href
		);
	});
});

// ── Ordre, plafond, et le total qui ne ment pas ─────────────────────

describe('rankItems / capItems', () => {
	const mk = (rank: number, id: string): ReportItem => ({
		label: id,
		detail: null,
		projectSlug: null,
		rank,
		source: { kind: 'finding', id, href: `/inbox/findings/${id}` }
	});

	it('rang décroissant, puis clé de source — ordre TOTAL', () => {
		const out = rankItems([mk(10, 'b'), mk(20, 'z'), mk(10, 'a')]);
		expect(out.map((i) => i.label)).toEqual(['z', 'a', 'b']);
	});

	it('deux tris de la même entrée rendent le même ordre', () => {
		const items = [mk(5, 'c'), mk(5, 'a'), mk(5, 'b')];
		expect(rankItems(items)).toEqual(rankItems([...items].reverse()));
	});

	it('la troncature d’AFFICHAGE est dite', () => {
		const { items, truncated } = capItems([mk(1, 'a'), mk(2, 'b'), mk(3, 'c')], 2);
		expect(items).toHaveLength(2);
		expect(truncated).toBe(1);
	});

	it('la troncature de LECTURE est dite aussi', () => {
		// 200 en base, 3 lues, 2 affichées ⇒ 198 manquants, pas 1. Taire la seconde coupure
		// ferait passer le rapport pour exhaustif.
		const { truncated } = capItems([mk(1, 'a'), mk(2, 'b'), mk(3, 'c')], 2, 200);
		expect(truncated).toBe(198);
	});

	it('un total plus petit que la page lue ne diminue jamais le compte', () => {
		const { truncated } = capItems([mk(1, 'a'), mk(2, 'b')], 5, 1);
		expect(truncated).toBe(0);
	});
});

describe('le compteur d’une section vient du TOTAL, pas de la page lue', () => {
	it('200 findings en base, 3 lus ⇒ la métrique dit 200', () => {
		const report = buildWeeklyReport(
			input({ findingsNew: set([finding(), finding({ id: 'f-2' }), finding({ id: 'f-3' })], 200) })
		);
		const s = sectionOf(report, 'findings_new');
		if (!s.body.available) throw new Error('section attendue disponible');
		expect(s.body.data.metrics[0].value).toBe(200);
		expect(s.body.data.truncated).toBe(197);
	});
});

// ── Acceptation 1 : un rapport sans LLM, déterministe et versionné ──

describe('buildWeeklyReport — JSON versionné, déterministe', () => {
	it('porte la version de schéma', () => {
		expect(buildWeeklyReport(input()).schemaVersion).toBe(REPORT_SCHEMA_VERSION);
	});

	it('deux constructions sur les mêmes entrées sont octet pour octet identiques', () => {
		const i = input();
		expect(JSON.stringify(buildWeeklyReport(i))).toBe(JSON.stringify(buildWeeklyReport(i)));
	});

	it('l’horodatage est celui passé — aucune horloge interne', () => {
		expect(buildWeeklyReport(input({ generatedAt: '2020-01-01 00:00:00' })).generatedAt).toBe(
			'2020-01-01 00:00:00'
		);
	});

	it('les douze sections de §14.1 sont là, dans l’ordre de la spec', () => {
		expect(buildWeeklyReport(input()).sections.map((s) => s.key)).toEqual(SECTION_ORDER);
	});

	it('l’ordre vit dans le JSON, donc un rapport archivé garde son plan', () => {
		const report = buildWeeklyReport(input());
		expect(report.sections).toHaveLength(12);
		expect(report.sections[0].key).toBe('executive_summary');
		expect(report.sections[11].key).toBe('automation_health');
	});
});

// ── La phrase d'en-tête : l'ordre des cas EST la priorité ───────────

describe('buildReportHeadline', () => {
	it('une panne de collecte prime sur ce que les findings racontent', () => {
		const broken = card({
			integrations: [
				{
					provider: 'gsc',
					healthStatus: 'down',
					status: 'error',
					enabled: true,
					lastSuccessAt: null,
					lastErrorCode: 'invalid_grant'
				}
			],
			gscLastSuccessAt: null
		});
		const i = input({ projects: [broken] });
		expect(buildReportHeadline(i)).toMatch(/panne de collecte/);
	});

	it('un parc jamais diagnostiqué ne conclut rien', () => {
		const i = input({ projects: [card({ detectors: detectors(0) })] });
		expect(buildReportHeadline(i)).toMatch(/ne conclut rien/);
	});

	it('un parc vide le dit', () => {
		expect(buildReportHeadline(input({ projects: [] }))).toMatch(/Aucun projet actif/);
	});

	it('sinon, il annonce le volume de la période', () => {
		expect(buildReportHeadline(input())).toMatch(/nouveau finding/);
	});
});

// ── Le rendu texte : une projection, jamais une source ──────────────

describe('renderWeeklyReportText', () => {
	const report = buildWeeklyReport(input());
	const text = renderWeeklyReportText(report);

	it('n’a d’autre entrée que le rapport (donc rien à inventer)', () => {
		expect(renderWeeklyReportText(report)).toBe(text);
	});

	it('numérote les douze sections dans l’ordre du JSON', () => {
		report.sections.forEach((s, i) => {
			expect(text).toContain(`## ${i + 1}. ${s.title}`);
		});
	});

	it('rend la raison d’une absence, pas un compteur', () => {
		const block = textBlock(text, 'Trafic et conversions');
		expect(block).toMatch(/absent \(not_wired\)/);
		expect(block).not.toMatch(/^ {2}- /m);
	});

	it('dit la troncature au lieu de la taire', () => {
		const big = buildWeeklyReport(
			input({
				findingsNew: set(
					Array.from({ length: 30 }, (_, i) => finding({ id: `f-${i}`, priorityScore: i })),
					30
				),
				maxItemsPerSection: 5
			})
		);
		expect(renderWeeklyReportText(big)).toMatch(/25 de plus \(non affichés, pas absents\)/);
	});

	it('dit les angles morts en tête, une seule fois', () => {
		const blind = buildWeeklyReport(
			input({
				projects: [card({ slug: 'alpha' }), card({ slug: 'beta', detectors: detectors(0) })]
			})
		);
		const out = renderWeeklyReportText(blind);
		expect(out).toMatch(/⚠ 1 angle\(s\) mort\(s\) — ce que ce rapport ne peut pas dire/);
		expect(out).toMatch(/- \[beta\] aucun des 3 détecteurs/);
		// ⭐ Le détail apparaît UNE fois, pas une par section : à 9 projets et 12 sections, la
		// même liste s'imprimait 108 fois et noyait tout le reste.
		expect(out.match(/aucun des 3 détecteurs attendus/g)).toHaveLength(1);
	});

	it('mais chaque section rappelle qu’il y en a — compresser n’est pas taire', () => {
		const blind = buildWeeklyReport(
			input({
				projects: [card({ slug: 'alpha' }), card({ slug: 'beta', detectors: detectors(0) })],
				findingsNew: set([])
			})
		);
		const block = textBlock(renderWeeklyReportText(blind), 'Nouveaux findings');
		// « 0 finding » ne doit JAMAIS se lire seul : la même ligne porte le rappel.
		expect(block).toMatch(/0 finding/);
		expect(block).toMatch(/1 angle\(s\) mort\(s\) du parc — détail en tête/);
	});

	it('un angle mort PROPRE à une section est rendu en entier, là où il est', () => {
		// Le trafic déclare ses propres angles morts (projets sans provider analytics), qui ne
		// sont pas ceux du parc : ils ne doivent pas être élidés.
		const report2 = buildWeeklyReport(
			input({
				traffic: [
					{ projectSlug: 'alpha', visits: 10, conversions: 1, wired: true },
					{ projectSlug: 'beta', visits: 0, conversions: 0, wired: false }
				]
			})
		);
		expect(renderWeeklyReportText(report2)).toMatch(
			/⚠ angle mort \[beta\] : aucun provider analytics branché/
		);
	});

	it('ne bégaie pas quand le libellé EST le projet', () => {
		// La section avis liste des projets : « [alpha] alpha » ne dit pas deux fois, il bégaie.
		expect(text).not.toMatch(/\[alpha\] alpha/);
		expect(textBlock(text, 'Avis Google')).toMatch(/- alpha — 4 reçus/);
	});

	it('porte la période et la version en tête', () => {
		expect(text).toContain(`${SINCE} → ${UNTIL}`);
		expect(text).toContain(`schéma v${REPORT_SCHEMA_VERSION}`);
	});
});

// ── Indexation : le périmètre est une sélection, pas le site ────────

describe('section indexation', () => {
	it('aucun verdict tranché ⇒ « aucun verdict tranché », jamais 0 %', () => {
		const report = buildWeeklyReport(
			input({
				indexation: [
					{
						projectSlug: 'alpha',
						urlsObserved: 4,
						indexed: 0,
						notIndexed: 0,
						coverageRate: null,
						dueNow: 0,
						wired: true
					}
				]
			})
		);
		const s = sectionOf(report, 'indexation');
		if (!s.body.available) throw new Error('section attendue disponible');
		expect(s.body.data.metrics[0].value).toBeNull();
		expect(s.body.data.metrics[0].display).toBe('aucun verdict tranché');
	});

	it('le rang est le NOMBRE de non indexées, pas le taux', () => {
		// 10 pages perdues sur 1000 comptent plus qu'une sur deux : un taux ferait remonter les
		// petits échantillons.
		const report = buildWeeklyReport(
			input({
				projects: [card({ slug: 'alpha' }), card({ slug: 'beta' })],
				indexation: [
					{
						projectSlug: 'alpha',
						urlsObserved: 2,
						indexed: 1,
						notIndexed: 1,
						coverageRate: 0.5,
						dueNow: 0,
						wired: true
					},
					{
						projectSlug: 'beta',
						urlsObserved: 1000,
						indexed: 990,
						notIndexed: 10,
						coverageRate: 0.99,
						dueNow: 0,
						wired: true
					}
				]
			})
		);
		const s = sectionOf(report, 'indexation');
		if (!s.body.available) throw new Error('section attendue disponible');
		expect(s.body.data.items.map((i) => i.projectSlug)).toEqual(['beta', 'alpha']);
	});

	it('rappelle que le périmètre est la sélection IDX-004', () => {
		const s = sectionOf(buildWeeklyReport(input()), 'indexation');
		if (!s.body.available) throw new Error('section attendue disponible');
		expect(s.body.data.note).toMatch(/IDX-004/);
	});

	it('aucune observation nulle part ⇒ section absente, pas 0 % de couverture', () => {
		const report = buildWeeklyReport(
			input({
				indexation: [
					{
						projectSlug: 'alpha',
						urlsObserved: 0,
						indexed: 0,
						notIndexed: 0,
						coverageRate: null,
						dueNow: 0,
						wired: false
					}
				]
			})
		);
		const s = sectionOf(report, 'indexation');
		expect(s.body.available).toBe(false);
	});
});

// ── Avis : l'absence de fiche n'est pas un angle mort ───────────────

describe('section avis', () => {
	it('ne déclare AUCUN angle mort pour un projet sans fiche — et le dit', () => {
		const report = buildWeeklyReport(
			input({
				projects: [card({ slug: 'alpha' }), card({ slug: 'beta' })],
				reviews: [
					{ projectSlug: 'alpha', unanswered: 1, received: 2, negative: 0, wired: true },
					{ projectSlug: 'beta', unanswered: 0, received: 0, negative: 0, wired: false }
				]
			})
		);
		const s = sectionOf(report, 'reviews');
		if (!s.body.available) throw new Error('section attendue disponible');
		expect(s.body.data.blindSpots).toEqual([]);
		expect(s.body.data.note).toMatch(/fait métier, pas un angle mort/);
	});

	it('un avis négatif pèse plus qu’un avis sans réponse', () => {
		const report = buildWeeklyReport(
			input({
				projects: [card({ slug: 'alpha' }), card({ slug: 'beta' })],
				reviews: [
					{ projectSlug: 'alpha', unanswered: 9, received: 9, negative: 0, wired: true },
					{ projectSlug: 'beta', unanswered: 1, received: 1, negative: 1, wired: true }
				]
			})
		);
		const s = sectionOf(report, 'reviews');
		if (!s.body.available) throw new Error('section attendue disponible');
		expect(s.body.data.items[0].projectSlug).toBe('beta');
	});
});

// ── Propositions : deux ensembles qui ne se confondent pas ──────────

describe('sections propositions', () => {
	it('« produites » et « en attente » sont deux ensembles distincts', () => {
		const report = buildWeeklyReport(
			input({
				proposalsCreated: set([proposal({ id: 'neuve' })]),
				proposalsPending: set([proposal({ id: 'neuve' }), proposal({ id: 'vieille' })])
			})
		);
		const created = sectionOf(report, 'proposed_actions');
		const pending = sectionOf(report, 'approvals_requested');
		if (!created.body.available || !pending.body.available) throw new Error('sections attendues');
		expect(created.body.data.metrics[0].value).toBe(1);
		expect(pending.body.data.metrics[0].value).toBe(2);
	});

	it('les L4 sont comptées sur les lignes LUES, et la métrique le dit', () => {
		const report = buildWeeklyReport(
			input({
				proposalsPending: set(
					[proposal({ id: 'a', requiredApprovalLevel: 'L4' }), proposal({ id: 'b' })],
					50
				)
			})
		);
		const s = sectionOf(report, 'approvals_requested');
		if (!s.body.available) throw new Error('section attendue disponible');
		expect(s.body.data.metrics[1].value).toBe(1);
		expect(s.body.data.metrics[1].label).toMatch(/parmi les 2 listées/);
	});

	it('le risque décide de l’ordre, pas la date', () => {
		const report = buildWeeklyReport(
			input({
				proposalsPending: set([
					proposal({ id: 'vieille-et-benigne', riskLevel: 'low', createdAt: '2026-01-01 00:00:00' }),
					proposal({ id: 'neuve-et-lourde', riskLevel: 'high', requiredApprovalLevel: 'L4' })
				])
			})
		);
		const s = sectionOf(report, 'approvals_requested');
		if (!s.body.available) throw new Error('section attendue disponible');
		expect(s.body.data.items[0].source).toMatchObject({ id: 'neuve-et-lourde' });
	});

	it('rappelle qu’approuver n’exécute rien', () => {
		const s = sectionOf(buildWeeklyReport(input()), 'approvals_requested');
		if (!s.body.available) throw new Error('section attendue disponible');
		expect(s.body.data.note).toMatch(/aucune exécution/);
	});
});

// ── Projets à traiter : le même prédicat que l'accueil ──────────────

describe('section projets', () => {
	it('ne liste que ce qui n’est pas `ok`, dans l’ordre d’urgence de l’accueil', () => {
		const ok = card({ slug: 'alpha' });
		const risky = card({ slug: 'beta', openBySeverity: { critical: 1 } });
		const report = buildWeeklyReport(input({ projects: [risky, ok] }));
		const s = sectionOf(report, 'projects_needing_action');
		if (!s.body.available) throw new Error('section attendue disponible');
		expect(s.body.data.items.map((i) => i.projectSlug)).toEqual(['beta']);
	});

	it('chaque projet listé pointe vers son cockpit', () => {
		const risky = card({ slug: 'beta', openBySeverity: { critical: 1 } });
		const s = sectionOf(buildWeeklyReport(input({ projects: [risky] })), 'projects_needing_action');
		if (!s.body.available) throw new Error('section attendue disponible');
		expect(s.body.data.items[0].source).toEqual({
			kind: 'project',
			slug: 'beta',
			href: '/projects/beta'
		});
	});
});

// ── Santé des automatisations : les données manquantes viennent de l'axe pipeline ──

describe('section automatisations', () => {
	it('les « données manquantes » sont le verdict PIPELINE de chaque carte, pas un recalcul', () => {
		const broken = card({
			slug: 'beta',
			integrations: [
				{
					provider: 'gsc',
					healthStatus: 'down',
					status: 'error',
					enabled: true,
					lastSuccessAt: null,
					lastErrorCode: 'invalid_grant'
				}
			],
			gscLastSuccessAt: null
		});
		const s = sectionOf(buildWeeklyReport(input({ projects: [broken] })), 'automation_health');
		if (!s.body.available) throw new Error('section attendue disponible');
		expect(s.body.data.items[0].label).toContain('pipeline broken');
		expect(s.body.data.items[0].detail).toBe(broken.pipeline.reasons.join(' · '));
	});
});
