/**
 * REP-004 lot 1 — les invariants de l'historique et de la comparaison.
 *
 * Chaque bloc porte une CONTRE-ÉPREUVE : ce qui distingue l'état correct de l'état voisin qu'on
 * aurait écrit sans y penser. Ici la paire à ne jamais confondre est **« une section a changé
 * de disponibilité » et « un écart »** — le troisième endroit du parcours où « absent ≠ zéro »
 * se défait, et le seul où il produit un MOUVEMENT inventé plutôt qu'un compteur à zéro.
 */
import { describe, expect, it } from 'vitest';
import {
	absent,
	present,
	findingSource,
	observationSource,
	projectSource,
	type ReportItem,
	type ReportMetric,
	type ReportSection,
	type SectionBody,
	type SectionKey,
	type WeeklyReport
} from './weekly-report-state.js';
import {
	compareReports,
	comparePoints,
	decideRevision,
	describeLineage,
	itemKey,
	normalizeRevisionReason,
	sectionHasChange,
	SECTION_NATURE,
	type ComparisonPoint,
	type ReportDetail,
	type SectionComparison
} from './report-history-state.js';

// ── Fabriques ───────────────────────────────────────────────────────

function metric(key: string, value: number | null, over: Partial<ReportMetric> = {}): ReportMetric {
	return {
		key,
		label: key,
		value,
		display: value === null ? 'non mesuré' : String(value),
		source: null,
		...over
	};
}

function body(over: Partial<SectionBody> = {}): SectionBody {
	return { metrics: [], items: [], truncated: 0, blindSpots: [], note: null, ...over };
}

function finding(id: string, label = id): ReportItem {
	return { label, detail: null, projectSlug: 'wildcat', rank: 1, source: findingSource(id) };
}

function section(key: SectionKey, over: Partial<ReportSection> = {}): ReportSection {
	return { key, title: key, body: present(body()), ...over } as ReportSection;
}

function report(sections: ReportSection[], over: Partial<WeeklyReport> = {}): WeeklyReport {
	return {
		schemaVersion: 2,
		generatedAt: '2026-07-27 09:00:00',
		period: {
			sinceDb: '2026-07-20',
			untilDb: '2026-07-27',
			windowDays: 7,
			label: 'du 20 au 27 juillet'
		},
		headline: 'Neuf projets.',
		coverage: [],
		sections,
		...over
	};
}

/**
 * Un point de comparaison. `report` reste accepté par commodité (le cas nominal) ; `detail`
 * permet d'exercer le cas PURGÉ (REP-004 lot 2), où il n'y a précisément pas de rapport.
 */
function point(
	over: Partial<Omit<ComparisonPoint, 'detail'>> & { report?: WeeklyReport; detail?: ReportDetail }
): ComparisonPoint {
	const { report, detail, ...rest } = over;
	return {
		periodSlot: '2026-07-20T09:00',
		revision: 1,
		reportSchemaVersion: 2,
		detail: detail ?? { kind: 'available', report: report as WeeklyReport },
		...rest
	};
}

function sectionOf(comparison: ReturnType<typeof compareReports>, key: SectionKey): SectionComparison {
	if (comparison.kind !== 'available') throw new Error('comparaison indisponible');
	const found = comparison.sections.find((s) => s.key === key);
	if (!found) throw new Error(`section ${key} absente`);
	return found;
}

// ════════════════════════════════════════════════════════════════════
// La révision
// ════════════════════════════════════════════════════════════════════

describe('decideRevision — régénérer ne remplace pas silencieusement', () => {
	it('refuse un créneau jamais publié : ce serait une publication, pas une révision', () => {
		const d = decideRevision({ current: null, reason: 'la collecte a fini' });
		expect(d.action).toBe('refuse');
		if (d.action !== 'refuse') return;
		expect(d.refusal).toBe('no_original');
	});

	it('refuse une révision sans raison — CONTRE-ÉPREUVE : avec raison, elle passe', () => {
		const sans = decideRevision({ current: { id: 'r1', revision: 1 }, reason: '   ' });
		expect(sans.action).toBe('refuse');
		if (sans.action === 'refuse') expect(sans.refusal).toBe('reason_required');

		const avec = decideRevision({ current: { id: 'r1', revision: 1 }, reason: ' la collecte a fini ' });
		expect(avec.action).toBe('revise');
		if (avec.action !== 'revise') return;
		expect(avec.reason).toBe('la collecte a fini');
		expect(avec.revision).toBe(2);
		expect(avec.supersedesId).toBe('r1');
	});

	it('le numéro suit la révision COURANTE, pas un compte de lignes', () => {
		// Une rétention qui aurait purgé les révisions 1 et 2 laisse `count = 1` mais `max = 3` :
		// dériver du compte réécrirait la révision 2 déjà écrite.
		const d = decideRevision({ current: { id: 'r3', revision: 3 }, reason: 'correction' });
		expect(d.action === 'revise' && d.revision).toBe(4);
	});

	it('normalizeRevisionReason borne la longueur et refuse le vide', () => {
		expect(normalizeRevisionReason(null)).toBeNull();
		expect(normalizeRevisionReason('\n\t ')).toBeNull();
		expect(normalizeRevisionReason('x'.repeat(900))?.length).toBe(500);
	});
});

describe('describeLineage', () => {
	const rows = [
		{ id: 'a', revision: 1, status: 'partial' as const, publishedAt: '2026-07-27 10:00:00', revisionReason: null },
		{ id: 'b', revision: 2, status: 'complete' as const, publishedAt: '2026-07-27 14:00:00', revisionReason: 'collecte terminée' }
	];

	it('la révision courante est celle du NUMÉRO le plus haut, pas la dernière écrite', () => {
		// Ordre d'arrivée inversé : deux écritures concurrentes peuvent s'inverser d'une ms.
		const lineage = describeLineage([rows[1], rows[0]]);
		expect(lineage.entries.map((e) => e.revision)).toEqual([1, 2]);
		expect(lineage.entries.find((e) => e.current)?.revision).toBe(2);
	});

	it('dit le passage partial → complete, et que l’original reste consultable', () => {
		const lineage = describeLineage(rows);
		expect(lineage.note).toContain('partial à complete');
		expect(lineage.note).toContain('reste consultable');
	});

	it('CONTRE-ÉPREUVE : une seule révision ne raconte rien', () => {
		expect(describeLineage([rows[0]]).note).toBeNull();
	});
});

// ════════════════════════════════════════════════════════════════════
// L'ordre des points
// ════════════════════════════════════════════════════════════════════

describe('comparePoints / ordre', () => {
	it('le créneau prime, la révision départage', () => {
		expect(comparePoints({ periodSlot: '2026-07-20T09:00', revision: 9 }, { periodSlot: '2026-07-27T09:00', revision: 1 })).toBe(-1);
		expect(comparePoints({ periodSlot: '2026-07-27T09:00', revision: 1 }, { periodSlot: '2026-07-27T09:00', revision: 2 })).toBe(-1);
		expect(comparePoints({ periodSlot: '2026-07-27T09:00', revision: 2 }, { periodSlot: '2026-07-27T09:00', revision: 2 })).toBe(0);
	});

	it('refuse une comparaison à l’envers au lieu d’en inverser le signe en silence', () => {
		const older = point({ periodSlot: '2026-07-20T09:00', report: report([]) });
		const newer = point({ periodSlot: '2026-07-27T09:00', report: report([]) });
		const c = compareReports({ base: newer, head: older });
		expect(c.kind).toBe('unavailable');
		if (c.kind !== 'unavailable') return;
		expect(c.reason).toBe('not_ordered');
	});

	it('un rapport comparé à lui-même est un ÉTAT, pas une liste vide', () => {
		const p = point({ report: report([]) });
		const c = compareReports({ base: p, head: p });
		expect(c.kind).toBe('unavailable');
		if (c.kind !== 'unavailable') return;
		expect(c.reason).toBe('same_point');
	});

	it('deux révisions du même créneau se comparent sur l’axe « revision »', () => {
		const c = compareReports({
			base: point({ revision: 1, report: report([]) }),
			head: point({ revision: 2, report: report([]) })
		});
		expect(c.kind === 'available' && c.axis).toBe('revision');
	});
});

// ════════════════════════════════════════════════════════════════════
// ⭐ Le point du lot : une disponibilité qui change n'est pas un écart
// ════════════════════════════════════════════════════════════════════

describe('⭐ absent → présent (et l’inverse) ne produit AUCUN chiffre', () => {
	const empty = report([section('traffic_conversions', { body: absent('not_wired', 'aucun provider') })]);
	const filled = report([
		section('traffic_conversions', {
			body: present(
				body({
					metrics: [metric('traffic.visits', 1200)],
					items: [
						{
							label: 'wildcat',
							detail: null,
							projectSlug: 'wildcat',
							rank: 1,
							source: observationSource('plausible_page_observations')
						}
					]
				})
			)
		})
	]);

	it('une section devenue disponible n’a AUCUN champ chiffré (la case n’existe pas)', () => {
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', report: empty }),
			head: point({ periodSlot: '2026-07-27T09:00', report: filled })
		});
		const s = sectionOf(c, 'traffic_conversions');
		expect(s.kind).toBe('became_available');
		// La garde structurelle : ni métriques, ni items, ni delta — pas de `+1200` possible.
		expect(s).not.toHaveProperty('metrics');
		expect(s).not.toHaveProperty('items');
		expect(s).not.toHaveProperty('delta');
		expect(JSON.stringify(s)).not.toContain('1200');
	});

	it('une section devenue absente ne se lit pas comme une baisse', () => {
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', report: filled }),
			head: point({ periodSlot: '2026-07-27T09:00', report: empty })
		});
		const s = sectionOf(c, 'traffic_conversions');
		expect(s.kind).toBe('became_absent');
		expect(s).not.toHaveProperty('metrics');
		expect(JSON.stringify(s)).not.toContain('1200');
		if (s.kind !== 'became_absent') return;
		expect(s.headReason).toBe('not_wired');
	});

	it('CONTRE-ÉPREUVE : deux sections PRÉSENTES, elles, portent bien leur écart', () => {
		const before = report([section('reviews', { body: present(body({ metrics: [metric('reviews.unanswered', 10)] })) })]);
		const after = report([section('reviews', { body: present(body({ metrics: [metric('reviews.unanswered', 4)] })) })]);
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', report: before }),
			head: point({ periodSlot: '2026-07-27T09:00', report: after })
		});
		const s = sectionOf(c, 'reviews');
		expect(s.kind).toBe('comparable');
		if (s.kind !== 'comparable') return;
		const m = s.metrics[0];
		expect(m.kind).toBe('comparable');
		if (m.kind !== 'comparable') return;
		expect(m.delta).toBe(-6);
		expect(m.direction).toBe('down');
	});

	it('deux absences de nature DIFFÉRENTE sont un fait, pas un néant', () => {
		const a = report([section('indexation', { body: absent('not_wired', '…') })]);
		const b = report([section('indexation', { body: absent('never_collected', '…') })]);
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', report: a }),
			head: point({ periodSlot: '2026-07-27T09:00', report: b })
		});
		const s = sectionOf(c, 'indexation');
		expect(s.kind).toBe('both_absent');
		if (s.kind !== 'both_absent') return;
		expect(s.reasonChanged).toBe(true);
		expect(s.note).toContain('un geste qui a été fait');
	});

	it('le résumé NOMME les transitions au lieu de les fondre dans un compte', () => {
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', report: empty }),
			head: point({ periodSlot: '2026-07-27T09:00', report: filled })
		});
		if (c.kind !== 'available') throw new Error('indisponible');
		expect(c.summary.becameAvailable).toEqual(['traffic_conversions']);
		expect(c.summary.headline).toContain('pas une hausse');
	});
});

// ════════════════════════════════════════════════════════════════════
// Les métriques : identité stable, jamais de prose
// ════════════════════════════════════════════════════════════════════

describe('métriques', () => {
	it('apparie sur la CLÉ : un libellé réécrit est un renommage, pas une rupture de série', () => {
		const before = report([
			section('approvals_requested', {
				body: present(body({ metrics: [metric('proposals.l4', 2, { label: 'dont L4, parmi les 15 listées' })] }))
			})
		]);
		const after = report([
			section('approvals_requested', {
				body: present(body({ metrics: [metric('proposals.l4', 3, { label: 'dont L4, parmi les 12 listées' })] }))
			})
		]);
		const s = sectionOf(
			compareReports({
				base: point({ periodSlot: '2026-07-20T09:00', report: before }),
				head: point({ periodSlot: '2026-07-27T09:00', report: after })
			}),
			'approvals_requested'
		);
		if (s.kind !== 'comparable') throw new Error('attendu comparable');
		const m = s.metrics[0];
		expect(m.kind).toBe('comparable');
		if (m.kind !== 'comparable') return;
		expect(m.delta).toBe(1);
		// La preuve que le libellé a bougé est CONSERVÉE, elle n'est simplement pas structurante.
		expect(m.renamed).toBe(true);
	});

	it('un `null` n’est pas un zéro : aucun écart n’est calculé', () => {
		const before = report([
			section('indexation', { body: present(body({ metrics: [metric('indexation.coverage_rate', null)] })) })
		]);
		const after = report([
			section('indexation', { body: present(body({ metrics: [metric('indexation.coverage_rate', 0.92)] })) })
		]);
		const s = sectionOf(
			compareReports({
				base: point({ periodSlot: '2026-07-20T09:00', report: before }),
				head: point({ periodSlot: '2026-07-27T09:00', report: after })
			}),
			'indexation'
		);
		if (s.kind !== 'comparable') throw new Error('attendu comparable');
		const m = s.metrics[0];
		expect(m.kind).toBe('unquantified');
		expect(m).not.toHaveProperty('delta');
	});

	it('une métrique nouvelle est « apparue », une métrique partie « disparue »', () => {
		const before = report([
			section('automation_health', { body: present(body({ metrics: [metric('runs.ok', 4)] })) })
		]);
		const after = report([
			section('automation_health', { body: present(body({ metrics: [metric('runs.failed', 2)] })) })
		]);
		const s = sectionOf(
			compareReports({
				base: point({ periodSlot: '2026-07-20T09:00', report: before }),
				head: point({ periodSlot: '2026-07-27T09:00', report: after })
			}),
			'automation_health'
		);
		if (s.kind !== 'comparable') throw new Error('attendu comparable');
		expect(s.metrics.map((m) => `${m.kind}:${m.key}`)).toEqual([
			'appeared:runs.failed',
			'disappeared:runs.ok'
		]);
	});

	it('une clé dupliquée bloque au lieu de choisir au hasard', () => {
		const dup = report([
			section('reviews', {
				body: present(body({ metrics: [metric('reviews.unanswered', 1), metric('reviews.unanswered', 2)] }))
			})
		]);
		const s = sectionOf(
			compareReports({
				base: point({ periodSlot: '2026-07-20T09:00', report: dup }),
				head: point({ periodSlot: '2026-07-27T09:00', report: dup })
			}),
			'reviews'
		);
		if (s.kind !== 'comparable') throw new Error('attendu comparable');
		expect(s.metrics.every((m) => m.kind === 'blocked')).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════
// Les blocages : schéma et fenêtre
// ════════════════════════════════════════════════════════════════════

describe('blocages quantitatifs', () => {
	const withMetric = (v: number) =>
		report([section('reviews', { body: present(body({ metrics: [metric('reviews.unanswered', v)] })) })]);

	it('deux versions de schéma : la STRUCTURE reste lisible, les chiffres non', () => {
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', reportSchemaVersion: 1, report: withMetric(10) }),
			head: point({ periodSlot: '2026-07-27T09:00', reportSchemaVersion: 2, report: withMetric(4) })
		});
		if (c.kind !== 'available') throw new Error('indisponible');
		expect(c.blocks.map((b) => b.reason)).toEqual(['schema_changed']);
		const s = sectionOf(c, 'reviews');
		if (s.kind !== 'comparable') throw new Error('attendu comparable');
		expect(s.metrics[0].kind).toBe('blocked');
		expect(c.summary.headline).not.toContain('-6');
	});

	it('deux fenêtres de longueurs différentes ne produisent aucun delta (doctrine GSC-004)', () => {
		const long = report(
			[section('reviews', { body: present(body({ metrics: [metric('reviews.unanswered', 40)] })) })],
			{ period: { sinceDb: '2026-06-27', untilDb: '2026-07-27', windowDays: 28, label: '4 semaines' } }
		);
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', report: long }),
			head: point({ periodSlot: '2026-07-27T09:00', report: withMetric(10) })
		});
		if (c.kind !== 'available') throw new Error('indisponible');
		expect(c.blocks.map((b) => b.reason)).toEqual(['window_mismatch']);
		const s = sectionOf(c, 'reviews');
		if (s.kind !== 'comparable') throw new Error('attendu comparable');
		const m = s.metrics[0];
		expect(m.kind).toBe('blocked');
		if (m.kind !== 'blocked') return;
		// Les deux valeurs restent LISIBLES : bloquer l'écart n'est pas cacher les faits.
		expect(m.baseDisplay).toBe('40');
		expect(m.headDisplay).toBe('10');
	});

	it('CONTRE-ÉPREUVE : même schéma, même fenêtre → aucun blocage', () => {
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', report: withMetric(10) }),
			head: point({ periodSlot: '2026-07-27T09:00', report: withMetric(4) })
		});
		expect(c.kind === 'available' && c.blocks).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════════
// Les items : activité, plafond, identité
// ════════════════════════════════════════════════════════════════════

describe('mouvements d’items', () => {
	const stateSection = (items: ReportItem[], truncated = 0) =>
		report([section('opportunities', { body: present(body({ items, truncated })) })]);

	it('⭐ une section d’ACTIVITÉ ne produit aucun mouvement', () => {
		const before = report([section('findings_new', { body: present(body({ items: [finding('f1')] })) })]);
		const after = report([section('findings_new', { body: present(body({ items: [finding('f2')] })) })]);
		const s = sectionOf(
			compareReports({
				base: point({ periodSlot: '2026-07-20T09:00', report: before }),
				head: point({ periodSlot: '2026-07-27T09:00', report: after })
			}),
			'findings_new'
		);
		if (s.kind !== 'comparable') throw new Error('attendu comparable');
		expect(s.items.kind).toBe('suppressed');
		if (s.items.kind !== 'suppressed') return;
		expect(s.items.reason).toBe('activity');
		// La phrase dit POURQUOI : sinon on lit « f1 est sorti » comme « f1 est résolu ».
		expect(s.items.note).toContain('cessé d’être nouveau');
	});

	it('CONTRE-ÉPREUVE : une section d’ÉTAT produit bien entrées et sorties', () => {
		const s = sectionOf(
			compareReports({
				base: point({ periodSlot: '2026-07-20T09:00', report: stateSection([finding('f1'), finding('f2')]) }),
				head: point({ periodSlot: '2026-07-27T09:00', report: stateSection([finding('f2'), finding('f3')]) })
			}),
			'opportunities'
		);
		if (s.kind !== 'comparable' || s.items.kind !== 'movements') throw new Error('attendu movements');
		expect(s.items.entered.map((i) => i.label)).toEqual(['f3']);
		expect(s.items.left.map((i) => i.label)).toEqual(['f1']);
		expect(s.items.stayed).toBe(1);
	});

	it('⭐ une liste PLAFONNÉE ne se compare pas : le mouvement serait fabriqué par le plafond', () => {
		const s = sectionOf(
			compareReports({
				base: point({ periodSlot: '2026-07-20T09:00', report: stateSection([finding('f1')], 12) }),
				head: point({ periodSlot: '2026-07-27T09:00', report: stateSection([finding('f2')]) })
			}),
			'opportunities'
		);
		if (s.kind !== 'comparable') throw new Error('attendu comparable');
		expect(s.items.kind).toBe('suppressed');
		if (s.items.kind !== 'suppressed') return;
		expect(s.items.reason).toBe('truncated');
	});

	it('un titre réécrit ne fait pas d’un finding un autre finding', () => {
		const s = sectionOf(
			compareReports({
				base: point({ periodSlot: '2026-07-20T09:00', report: stateSection([finding('f1', 'ancien titre')]) }),
				head: point({ periodSlot: '2026-07-27T09:00', report: stateSection([finding('f1', 'titre réécrit')]) })
			}),
			'opportunities'
		);
		if (s.kind !== 'comparable' || s.items.kind !== 'movements') throw new Error('attendu movements');
		expect(s.items.entered).toEqual([]);
		expect(s.items.left).toEqual([]);
		expect(s.items.stayed).toBe(1);
	});

	it('itemKey : les items d’observation se distinguent par leur PROJET, pas par leur table', () => {
		const a: ReportItem = {
			label: 'wildcat',
			detail: null,
			projectSlug: 'wildcat',
			rank: 1,
			source: observationSource('index_observations')
		};
		const b: ReportItem = { ...a, label: 'lecureux', projectSlug: 'lecureux' };
		expect(itemKey(a)).not.toBe(itemKey(b));
		expect(itemKey(a)).toBe(itemKey({ ...a, rank: 99, detail: 'autre détail' }));
	});

	it('itemKey : un projet est identifié par son slug', () => {
		const p: ReportItem = {
			label: 'Wildcat',
			detail: null,
			projectSlug: 'wildcat',
			rank: 1,
			source: projectSource('wildcat')
		};
		expect(itemKey(p)).toBe('project:wildcat');
	});
});

// ════════════════════════════════════════════════════════════════════
// Le plan : un changement de template est traçable
// ════════════════════════════════════════════════════════════════════

describe('plan de sections', () => {
	it('une section hors du plan de l’autre rapport est NOMMÉE, jamais ignorée', () => {
		const before = report([section('reviews'), section('indexation')]);
		const after = report([section('reviews'), section('traffic_conversions')]);
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', report: before }),
			head: point({ periodSlot: '2026-07-27T09:00', report: after })
		});
		if (c.kind !== 'available') throw new Error('indisponible');
		expect(c.summary.planChanged.sort()).toEqual(['indexation', 'traffic_conversions']);
		expect(c.summary.headline).toContain('template modifié');
	});

	it('l’ordre suit le plan du rapport COURANT, pas SECTION_ORDER', () => {
		const before = report([section('reviews'), section('indexation')]);
		const after = report([section('indexation'), section('reviews')]);
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', report: before }),
			head: point({ periodSlot: '2026-07-27T09:00', report: after })
		});
		if (c.kind !== 'available') throw new Error('indisponible');
		expect(c.sections.map((s) => s.key)).toEqual(['indexation', 'reviews']);
	});

	it('SECTION_NATURE couvre les douze sections (une clé oubliée rendrait une section muette)', () => {
		expect(Object.keys(SECTION_NATURE)).toHaveLength(12);
	});
});

describe('sectionHasChange — « rien n’a changé » est un jugement, pas un `{#if}`', () => {
	function firstSection(base: WeeklyReport, head: WeeklyReport): SectionComparison {
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', report: base }),
			head: point({ periodSlot: '2026-07-27T09:00', report: head })
		});
		if (c.kind !== 'available') throw new Error('indisponible');
		return c.sections[0];
	}

	const withMetric = (v: number) =>
		report([section('reviews', { body: present(body({ metrics: [metric('reviews.unanswered', v)] })) })]);

	it('un écart nul ne dit rien — CONTRE-ÉPREUVE : un écart non nul, si', () => {
		expect(sectionHasChange(firstSection(withMetric(4), withMetric(4)))).toBe(false);
		expect(sectionHasChange(firstSection(withMetric(4), withMetric(5)))).toBe(true);
	});

	it('un blocage COMPTE : « je ne peux pas comparer » n’est pas « rien n’a bougé »', () => {
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', reportSchemaVersion: 1, report: withMetric(4) }),
			head: point({ periodSlot: '2026-07-27T09:00', reportSchemaVersion: 2, report: withMetric(4) })
		});
		if (c.kind !== 'available') throw new Error('indisponible');
		expect(sectionHasChange(c.sections[0])).toBe(true);
	});

	it('une absence STABLE ne dit rien ; une absence qui change de nature, si', () => {
		const notWired = report([section('indexation', { body: absent('not_wired', '…') })]);
		const collected = report([section('indexation', { body: absent('never_collected', '…') })]);
		expect(sectionHasChange(firstSection(notWired, notWired))).toBe(false);
		expect(sectionHasChange(firstSection(notWired, collected))).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════
// REP-004 lot 2 — un détail purgé n'est pas un rapport vide
// ════════════════════════════════════════════════════════════════════

describe('compareReports — la rétention ne fabrique pas un changement de template', () => {
	const purged: ReportDetail = {
		kind: 'purged',
		purgedAt: '2027-01-04 09:00:00',
		archiveRef: '00-Inbox/2026-07-20-_global-weekly-report.md'
	};
	const full = report([section('opportunities')]);

	it('⭐ refuse de comparer quand le point de RÉFÉRENCE a été purgé', () => {
		// La contre-épreuve de tout le lot 2 : avec un `WeeklyReport | null` et un `?? EMPTY`,
		// cette comparaison aurait annoncé « 1 section hors du plan de l’autre rapport », donc un
		// changement de TEMPLATE — un mouvement fabriqué par une politique de rétention.
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', detail: purged }),
			head: point({ periodSlot: '2026-07-27T09:00', report: full })
		});
		expect(c.kind).toBe('unavailable');
		if (c.kind !== 'unavailable') throw new Error('disponible');
		expect(c.reason).toBe('detail_purged');
		// Le refus ENVOIE quelque part : l’adresse de l’archive est dans la phrase.
		expect(c.note).toContain('00-Inbox/2026-07-20-_global-weekly-report.md');
		expect(c.note).toContain('de référence');
	});

	it('refuse aussi quand c’est le point COURANT qui a été purgé, et le nomme', () => {
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', report: full }),
			head: point({ periodSlot: '2026-07-27T09:00', detail: purged })
		});
		if (c.kind !== 'unavailable') throw new Error('disponible');
		expect(c.reason).toBe('detail_purged');
		expect(c.note).toContain('courant');
	});

	it('CONTRE-ÉPREUVE : deux détails présents comparent normalement', () => {
		const c = compareReports({
			base: point({ periodSlot: '2026-07-20T09:00', report: full }),
			head: point({ periodSlot: '2026-07-27T09:00', report: full })
		});
		expect(c.kind).toBe('available');
	});

	it('l’ORDRE est vérifié avant la rétention : deux fois le même point reste « same_point »', () => {
		// Un point purgé comparé à lui-même n’est pas « détail purgé », c’est « il n’y a rien à
		// comparer » — la première question posée reste la bonne.
		const p = point({ detail: purged });
		const c = compareReports({ base: p, head: p });
		if (c.kind !== 'unavailable') throw new Error('disponible');
		expect(c.reason).toBe('same_point');
	});
});
