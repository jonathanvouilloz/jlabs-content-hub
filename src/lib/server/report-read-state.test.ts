/**
 * DASH-003 lot 2 chantier 3 — les invariants de l'écran Rapports.
 *
 * Chaque bloc porte une CONTRE-ÉPREUVE : ce qui distingue l'état correct de l'état voisin qu'on
 * aurait écrit sans y penser. Ici la paire à ne jamais confondre est **« absent » et « zéro »** —
 * l'étoile de REP-001, dont l'écran est le dernier maillon non gardé.
 */
import { describe, expect, it } from 'vitest';
import {
	absent,
	present,
	findingSource,
	observationSource,
	type BlindSpot,
	type ReportSection,
	type SectionBody,
	type WeeklyReport
} from './weekly-report-state.js';
import type { PublicationReadiness, SloVerdict } from './report-publication-state.js';
import { dbTimestampToMs } from './timestamps.js';
import {
	buildReportView,
	describeCoverage,
	describeReportsFreshness,
	describeTruncation,
	formatSlotLabel,
	reportHref,
	sectionView,
	summarizeReportList
} from './report-read-state.js';

const SLO_MET: SloVerdict = { met: true, lateMs: 0, latencyMs: 12 * 60_000 };
const SLO_MISSED: SloVerdict = { met: false, lateMs: 47 * 60_000, latencyMs: 107 * 60_000 };

function readiness(over: Partial<PublicationReadiness> = {}): PublicationReadiness {
	return {
		periodSlot: '2026-07-27T09:00',
		deadlineMinutes: 60,
		expected: 9,
		ready: 6,
		degraded: 2,
		waiting: 0,
		missing: 1,
		paused: [],
		byProject: [],
		blockers: [],
		incidents: [],
		...over
	};
}

function body(over: Partial<SectionBody> = {}): SectionBody {
	return { metrics: [], items: [], truncated: 0, blindSpots: [], note: null, ...over };
}

function item(label: string, projectSlug: string | null = 'wildcat') {
	return { label, detail: null, projectSlug, rank: 1, source: findingSource('f_1') };
}

function section(over: Partial<ReportSection> = {}): ReportSection {
	return {
		key: 'findings_new',
		title: 'Nouveaux findings',
		body: present(body()),
		...over
	} as ReportSection;
}

function report(over: Partial<WeeklyReport> = {}): WeeklyReport {
	return {
		schemaVersion: 1,
		generatedAt: '2026-07-27 09:00:00',
		period: {
			sinceDb: '2026-07-20',
			untilDb: '2026-07-27',
			windowDays: 7,
			label: 'du 20 au 27 juillet 2026'
		},
		headline: 'Neuf projets, deux à surveiller.',
		coverage: [],
		sections: [section()],
		...over
	};
}

// ── Le lien et le libellé du créneau ────────────────────────────────

describe('reportHref / formatSlotLabel — le créneau est LOCAL, jamais reparsé', () => {
	it('encode le créneau : le « : » ne doit pas dépendre de la tolérance du routeur', () => {
		expect(reportHref('2026-07-27T09:00')).toBe('/reports/2026-07-27T09%3A00');
	});

	it('affiche l’heure telle qu’elle a été écrite — aucune conversion de fuseau', () => {
		// CONTRE-ÉPREUVE : un `new Date(slot).toLocaleString()` afficherait 11:00 en été à
		// Europe/Zurich. Le créneau EST local (REP-003) : le relire en UTC le décalerait.
		expect(formatSlotLabel('2026-07-27T09:00')).toBe('27.07.2026 à 09:00');
	});

	it('rend la chaîne brute plutôt que d’inventer une date sur un créneau malformé', () => {
		expect(formatSlotLabel('pas-un-creneau')).toBe('pas-un-creneau');
	});
});

// ── La liste ────────────────────────────────────────────────────────

describe('summarizeReportList — tout est repris, rien n’est recalculé', () => {
	it('reprend le verdict SLO tel quel et l’écrit avec l’échéance persistée', () => {
		const [row] = summarizeReportList([
			{
				periodSlot: '2026-07-27T09:00',
				status: 'complete',
				publishedAt: '2026-07-27 07:12:00',
				readiness: readiness({ deadlineMinutes: 45 }),
				slo: SLO_MET
			}
		]);
		expect(row.slo).toBe(SLO_MET);
		expect(row.sloLabel).toBe('SLO tenu (échéance créneau +45 min)');
		expect(row.href).toBe('/reports/2026-07-27T09%3A00');
	});

	it('dit le retard en minutes quand le SLO est manqué', () => {
		const [row] = summarizeReportList([
			{
				periodSlot: '2026-07-27T09:00',
				status: 'partial',
				publishedAt: '2026-07-27 08:47:00',
				readiness: readiness(),
				slo: SLO_MISSED
			}
		]);
		expect(row.sloLabel).toBe('SLO manqué de 47 min');
	});

	it('un `partial` dit le GESTE (une révision peut le compléter), plus l’impasse', () => {
		// La phrase disait « republier est un no-op, un partiel ne redevient jamais complet »
		// (réserve REP-003). REP-004 lot 1 l'a rendue fausse : la révision existe. L'écran ne
		// promet rien d'automatique pour autant — réviser reste un geste délibéré.
		const [row] = summarizeReportList([
			{
				periodSlot: '2026-07-27T09:00',
				status: 'partial',
				publishedAt: '2026-07-27 09:30:00',
				readiness: readiness(),
				slo: SLO_MET
			}
		]);
		expect(row.statusNote).toContain('révision');
		expect(row.statusNote).toContain('délibéré');
		expect(row.statusNote).not.toContain('no-op');
		// CONTRE-ÉPREUVE : un rapport complet ne porte aucune réserve.
		const [complete] = summarizeReportList([
			{
				periodSlot: '2026-07-20T09:00',
				status: 'complete',
				publishedAt: '2026-07-20 09:05:00',
				readiness: readiness(),
				slo: SLO_MET
			}
		]);
		expect(complete.statusNote).not.toContain('révision');
	});

	it('REP-004 — un créneau révisé le DIT, et son SLO nomme la publication d’origine', () => {
		const [row] = summarizeReportList([
			{
				periodSlot: '2026-07-27T09:00',
				status: 'complete',
				publishedAt: '2026-07-29 14:00:00',
				readiness: readiness(),
				slo: SLO_MET,
				revision: 2,
				revisionCount: 2
			}
		]);
		expect(row.revisionLabel).toContain('Révision 2/2');
		// ⚠️ Sans ce rappel, « SLO tenu » au-dessus d'une ligne datée du mercredi se lirait comme
		// la ponctualité de la révision, alors qu'il mesure celle du lundi.
		expect(row.sloLabel).toContain('publication d’origine');

		// CONTRE-ÉPREUVE : un créneau jamais révisé ne raconte rien et ne qualifie pas son SLO.
		const [once] = summarizeReportList([
			{
				periodSlot: '2026-07-20T09:00',
				status: 'complete',
				publishedAt: '2026-07-20 09:05:00',
				readiness: readiness(),
				slo: SLO_MET
			}
		]);
		expect(once.revisionLabel).toBeNull();
		expect(once.revision).toBe(1);
		expect(once.sloLabel).not.toContain('origine');
	});

	it('nomme les projets écartés par une pause, à part des incidents', () => {
		const [row] = summarizeReportList([
			{
				periodSlot: '2026-07-27T09:00',
				status: 'complete',
				publishedAt: '2026-07-27 09:05:00',
				readiness: readiness({ expected: 8, ready: 8, degraded: 0, missing: 0, paused: ['cardrank'] }),
				slo: SLO_MET
			}
		]);
		expect(row.readinessLabel).toContain('1 en pause (cardrank)');
	});

	it('une préparation ILLISIBLE ne casse pas la ligne — elle se voit', () => {
		// `toMeta` rend `readiness: null` sur un `readiness_json` corrompu : c'est le PAYLOAD
		// qui porte la valeur. L'écran doit rester lisible, sans inventer un périmètre.
		const [row] = summarizeReportList([
			{
				periodSlot: '2026-07-27T09:00',
				status: 'partial',
				publishedAt: '2026-07-27 09:05:00',
				readiness: null,
				slo: SLO_MET
			}
		]);
		expect(row.readinessLabel).toBeNull();
		expect(row.sloLabel).toBe('SLO tenu');
	});
});

// ── « Jamais publié » n'est pas « rien à dire » ──────────────────────

describe('describeReportsFreshness — l’absence de rapport est un FAIT', () => {
	const parseMs = dbTimestampToMs;
	const now = Date.parse('2026-07-27T12:00:00Z');
	/** Le couple tel que la base le porte : créneau LOCAL + instant UTC. */
	const entry = (periodSlot: string, slotAt: string) => ({ periodSlot, slotAt });

	it('aucun rapport publié : état `never`, âge `null`, et la phrase le dit', () => {
		const f = describeReportsFreshness({ entries: [], nowMs: now, parseMs });
		expect(f.state).toBe('never');
		expect(f.ageDays).toBeNull(); // JAMAIS 0 : « jamais » n'est pas « à l'instant »
		expect(f.lastSlot).toBeNull();
		expect(f.note).toContain('Aucun rapport publié');
	});

	it('un créneau récent est `current`', () => {
		const f = describeReportsFreshness({
			entries: [entry('2026-07-27T09:00', '2026-07-27 07:00:00')],
			nowMs: now,
			parseMs
		});
		expect(f.state).toBe('current');
		expect(f.ageDays).toBe(0);
		expect(f.lastSlot).toBe('2026-07-27T09:00');
	});

	it('l’âge vient de `slot_at`, pas du créneau local (sinon 1 à 2 h d’écart selon la saison)', () => {
		// CONTRE-ÉPREUVE de l'erreur exacte : le créneau LOCAL 09:00 correspond à 07:00 UTC en
		// été. Lire le créneau comme de l'UTC décalerait la mesure — ici, la phrase doit citer le
		// créneau local tout en ayant compté sur l'instant.
		const f = describeReportsFreshness({
			entries: [entry('2026-07-27T09:00', '2026-07-27 07:00:00')],
			nowMs: now,
			parseMs
		});
		expect(f.note).toContain('27.07.2026 à 09:00');
	});

	it('au-delà de 8 jours, un créneau hebdomadaire a été manqué', () => {
		const f = describeReportsFreshness({
			entries: [
				entry('2026-07-13T09:00', '2026-07-13 07:00:00'),
				entry('2026-07-06T09:00', '2026-07-06 07:00:00')
			],
			nowMs: now,
			parseMs
		});
		expect(f.state).toBe('stale');
		expect(f.lastSlot).toBe('2026-07-13T09:00'); // le plus RÉCENT, quel que soit l'ordre reçu
		expect(f.note).toContain('aucun rapport');
	});

	it('un `slot_at` illisible ne devient pas un retard imaginaire', () => {
		const f = describeReportsFreshness({
			entries: [entry('2026-07-27T09:00', 'pas-une-date')],
			nowMs: now,
			parseMs
		});
		expect(f.state).toBe('current');
		expect(f.ageDays).toBeNull();
	});
});

// ── L'invariant central : absent ≠ zéro ─────────────────────────────

describe('sectionView — une section absente n’a PAS de corps', () => {
	it('une absence rend sa raison et son geste, sans aucun compteur', () => {
		const view = sectionView(
			section({
				key: 'traffic_conversions',
				title: 'Trafic et conversions',
				body: absent('not_wired', 'Trafic : aucun provider branché')
			})
		);
		expect(view.kind).toBe('absent');
		// ⭐ Le test qui porte le lot : il n'existe AUCUN champ où un `0` pourrait vivre.
		expect(view).not.toHaveProperty('items');
		expect(view).not.toHaveProperty('metrics');
		expect(view).not.toHaveProperty('truncated');
		if (view.kind === 'absent') {
			expect(view.reason).toBe('not_wired');
			expect(view.note).toContain('rien à compter');
		}
	});

	it('les trois absences donnent trois phrases DIFFÉRENTES (trois gestes)', () => {
		const notes = (['not_wired', 'never_collected', 'not_examined'] as const).map((reason) => {
			const view = sectionView(section({ body: absent(reason, 'peu importe') }));
			return view.kind === 'absent' ? view.note : '';
		});
		expect(new Set(notes).size).toBe(3);
	});

	it('CONTRE-ÉPREUVE : une section présente à 0 item dit « j’ai regardé », pas « absent »', () => {
		const view = sectionView(
			section({ body: present(body({ blindSpots: [{ projectSlug: 'barbermedia', reason: 'never_examined', note: 'jamais diagnostiqué' }] })) })
		);
		expect(view.kind).toBe('present');
		if (view.kind === 'present') {
			expect(view.isEmpty).toBe(true);
			// La liste vide GARDE ses angles morts : « rien de nouveau » sur un parc à moitié
			// diagnostiqué n'annonce pas une semaine calme.
			expect(view.blindSpots).toHaveLength(1);
		}
	});

	it('une section présente recopie ses items et ses métriques sans les retrier', () => {
		const metrics = [
			{
				key: 'findings.new',
				label: 'Nouveaux',
				value: 3,
				display: '3',
				source: observationSource('findings')
			}
		];
		const items = [item('b'), item('a')];
		const view = sectionView(section({ body: present(body({ metrics, items })) }));
		if (view.kind === 'present') {
			expect(view.items.map((i) => i.label)).toEqual(['b', 'a']); // l'ordre du JSON archivé
			expect(view.metrics).toBe(metrics);
		}
	});
});

describe('describeTruncation — la troncature est dite avec le total réel', () => {
	it('reconstitue le total à partir des affichés et des écartés', () => {
		expect(describeTruncation(body({ items: [item('a'), item('b')], truncated: 13 }))).toBe(
			'2 affichés sur 15 — 13 écartés par le plafond de section.'
		);
	});

	it('CONTRE-ÉPREUVE : rien à dire quand rien n’a été écarté', () => {
		expect(describeTruncation(body({ items: [item('a')], truncated: 0 }))).toBeNull();
	});
});

// ── Les angles morts du parc ────────────────────────────────────────

describe('describeCoverage — les angles morts, une fois, groupés par raison', () => {
	it('groupe par raison et trie les slugs (ordre total, pas celui de la lecture)', () => {
		const coverage: BlindSpot[] = [
			{ projectSlug: 'wildcat', reason: 'never_examined', note: '' },
			{ projectSlug: 'barbermedia', reason: 'never_examined', note: '' },
			{ projectSlug: 'cardrank', reason: 'paused', note: '' }
		];
		const note = describeCoverage(coverage);
		expect(note).toContain('3 projets');
		expect(note).toContain('jamais diagnostiqués : barbermedia, wildcat');
		expect(note).toContain('en pause : cardrank');
	});

	it('CONTRE-ÉPREUVE : aucun angle mort ⇒ aucune phrase (pas « 0 angle mort »)', () => {
		expect(describeCoverage([])).toBeNull();
	});
});

// ── Le rapport entier ───────────────────────────────────────────────

describe('buildReportView — une projection du JSON archivé, rien d’autre', () => {
	it('rend les sections dans l’ordre du RAPPORT, jamais dans celui de la spec courante', () => {
		const view = buildReportView({
			periodSlot: '2026-07-27T09:00',
			status: 'partial',
			publishedAt: '2026-07-27 09:30:00',
			reportSchemaVersion: 1,
			slo: SLO_MET,
			readiness: readiness(),
			report: report({
				sections: [
					section({ key: 'reviews', title: 'Avis Google' }),
					section({ key: 'executive_summary', title: 'Résumé exécutif' })
				]
			})
		});
		expect(view.sections.map((s) => s.key)).toEqual(['reviews', 'executive_summary']);
	});

	it('reprend période, headline et generatedAt du payload — aucune valeur recalculée', () => {
		const r = report();
		const view = buildReportView({
			periodSlot: '2026-07-27T09:00',
			status: 'complete',
			publishedAt: '2026-07-27 09:05:00',
			reportSchemaVersion: 1,
			slo: SLO_MET,
			readiness: readiness(),
			report: r
		});
		expect(view.periodLabel).toBe(r.period.label);
		expect(view.headline).toBe(r.headline);
		expect(view.generatedAt).toBe(r.generatedAt);
		// `publishedAt` est la date d'ÉCRITURE, distincte du créneau : les confondre ferait
		// dire à deux publications du même lundi qu'elles couvrent deux périodes (REP-003).
		expect(view.publishedAt).not.toBe(view.periodSlot);
	});

	it('un rapport sans préparation lisible reste rendu (le payload porte la valeur)', () => {
		const view = buildReportView({
			periodSlot: '2026-07-27T09:00',
			status: 'partial',
			publishedAt: '2026-07-27 09:30:00',
			reportSchemaVersion: 1,
			slo: SLO_MISSED,
			readiness: null,
			report: report()
		});
		expect(view.readinessLabel).toBeNull();
		expect(view.sections).toHaveLength(1);
		expect(view.sloLabel).toBe('SLO manqué de 47 min');
	});
});
