import { describe, it, expect } from 'vitest';
import {
	BUSINESS_TIMEZONE,
	DEFAULT_LOOKBACK_MS,
	SCHEDULE_CADENCES,
	SCHEDULE_CATALOG,
	SCHEDULE_DEFAULTS,
	catalogFor,
	dueOccurrences,
	formatLocalSlot,
	nextOccurrence,
	postPublishSlots,
	resolveScheduleConfig,
	utcToZonedFields,
	wiredCadences,
	zoneOffsetMs,
	zonedFieldsToUtc,
	type CadenceSpec
} from './schedule-state.js';
import { resolveDependencies, validateCatalogGraph } from './job-graph.js';

const TZ = BUSINESS_TIMEZONE;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (s: string) => Date.parse(s);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Spec ad hoc, sur la base des défauts. */
function spec(over: Partial<CadenceSpec> = {}): CadenceSpec {
	return { ...SCHEDULE_DEFAULTS.weekly, ...over };
}

// ── Offsets & champs civils ─────────────────────────────────────────

describe('zoneOffsetMs — Europe/Zurich', () => {
	it('+1 h en hiver (CET)', () => {
		expect(zoneOffsetMs(TZ, at('2026-01-15T12:00:00Z'))).toBe(HOUR);
	});

	it('+2 h en été (CEST)', () => {
		expect(zoneOffsetMs(TZ, at('2026-07-15T12:00:00Z'))).toBe(2 * HOUR);
	});

	it('ne dépend pas des millisecondes de l’instant', () => {
		expect(zoneOffsetMs(TZ, at('2026-07-15T12:00:00Z') + 743)).toBe(2 * HOUR);
	});
});

describe('utcToZonedFields', () => {
	it('rend les champs locaux, pas les champs UTC', () => {
		const f = utcToZonedFields(TZ, at('2026-07-20T07:00:00Z'));
		expect(f).toMatchObject({ year: 2026, month: 7, day: 20, hour: 9, minute: 0 });
	});

	it('weekday est ISO (1 = lundi, 7 = dimanche)', () => {
		expect(utcToZonedFields(TZ, at('2026-07-20T07:00:00Z')).weekday).toBe(1); // lundi
		expect(utcToZonedFields(TZ, at('2026-07-26T07:00:00Z')).weekday).toBe(7); // dimanche
	});

	it('le jour local peut différer du jour UTC (23:30 UTC = lendemain à Zurich)', () => {
		const f = utcToZonedFields(TZ, at('2026-07-20T23:30:00Z'));
		expect(f.day).toBe(21);
		expect(f.hour).toBe(1);
	});
});

// ── DST n°1 : passage à l'heure d'été (2026-03-29, 02:00 → 03:00) ──

describe('DST printemps — 2026-03-29 (CET → CEST)', () => {
	it('02:30 local n’existe pas : le créneau GLISSE à 03:30, il n’est jamais perdu', () => {
		const r = zonedFieldsToUtc({ timeZone: TZ, year: 2026, month: 3, day: 29, hour: 2, minute: 30 });
		expect(r.adjusted).toBe(true);
		expect(r.ambiguous).toBe(false);
		expect(r.localSlot).toBe('2026-03-29T03:30');
		expect(iso(r.instantMs)).toBe('2026-03-29T01:30:00.000Z');
	});

	it('une cadence quotidienne à 02:30 produit UNE occurrence ce jour-là (décalée)', () => {
		const daily = spec({ hour: 2, minute: 30 });
		const occ = dueOccurrences({
			cadence: 'daily',
			spec: daily,
			since: at('2026-03-29T00:00:00Z'),
			until: at('2026-03-29T04:00:00Z')
		});
		expect(occ).toHaveLength(1);
		expect(occ[0].localSlot).toBe('2026-03-29T03:30');
		expect(occ[0].adjusted).toBe(true);
	});

	it('le lundi 09:00 métier bascule de 08:00 UTC à 07:00 UTC de part et d’autre', () => {
		const before = zonedFieldsToUtc({ timeZone: TZ, year: 2026, month: 3, day: 23, hour: 9, minute: 0 });
		const after = zonedFieldsToUtc({ timeZone: TZ, year: 2026, month: 3, day: 30, hour: 9, minute: 0 });
		expect(iso(before.instantMs)).toBe('2026-03-23T08:00:00.000Z');
		expect(iso(after.instantMs)).toBe('2026-03-30T07:00:00.000Z');
		// Le créneau LOCAL, lui, n'a pas bougé — c'est tout l'intérêt.
		expect(before.localSlot).toBe('2026-03-23T09:00');
		expect(after.localSlot).toBe('2026-03-30T09:00');
	});

	it('la journée du saut ne duplique ni n’escamote le créneau hebdo suivant', () => {
		const next = nextOccurrence({
			cadence: 'weekly',
			spec: SCHEDULE_DEFAULTS.weekly,
			after: at('2026-03-29T12:00:00Z')
		});
		expect(next?.localSlot).toBe('2026-03-30T09:00');
		expect(iso(next!.instantMs)).toBe('2026-03-30T07:00:00.000Z');
	});
});

// ── DST n°2 : retour à l'heure d'hiver (2026-10-25, 03:00 → 02:00) ─

describe('DST automne — 2026-10-25 (CEST → CET)', () => {
	it('02:30 local existe deux fois : on retient la PREMIÈRE occurrence', () => {
		const r = zonedFieldsToUtc({ timeZone: TZ, year: 2026, month: 10, day: 25, hour: 2, minute: 30 });
		expect(r.ambiguous).toBe(true);
		expect(r.adjusted).toBe(false);
		expect(iso(r.instantMs)).toBe('2026-10-25T00:30:00.000Z'); // CEST, pas CET
	});

	it('l’heure doublée ne produit qu’UNE occurrence (la clé est le créneau LOCAL)', () => {
		const daily = spec({ hour: 2, minute: 30 });
		const occ = dueOccurrences({
			cadence: 'daily',
			spec: daily,
			since: at('2026-10-24T22:00:00Z'),
			until: at('2026-10-25T05:00:00Z')
		});
		const slots = occ.map((o) => o.localSlot);
		expect(slots).toEqual(['2026-10-25T02:30']);
	});

	it('le lundi 09:00 suivant repasse à 08:00 UTC', () => {
		const next = nextOccurrence({
			cadence: 'weekly',
			spec: SCHEDULE_DEFAULTS.weekly,
			after: at('2026-10-25T12:00:00Z')
		});
		expect(next?.localSlot).toBe('2026-10-26T09:00');
		expect(iso(next!.instantMs)).toBe('2026-10-26T08:00:00.000Z');
	});

	it('la journée de 25 h ne saute aucun créneau quotidien', () => {
		const occ = dueOccurrences({
			cadence: 'daily',
			spec: SCHEDULE_DEFAULTS.daily, // 07:00
			since: at('2026-10-23T00:00:00Z'),
			until: at('2026-10-27T00:00:00Z')
		});
		expect(occ.map((o) => o.localSlot)).toEqual([
			'2026-10-23T07:00',
			'2026-10-24T07:00',
			'2026-10-25T07:00',
			'2026-10-26T07:00'
		]);
	});
});

// ── Occurrences ─────────────────────────────────────────────────────

describe('dueOccurrences', () => {
	it('la borne basse est EXCLUE, la haute est incluse (pas de double tir au tick suivant)', () => {
		const instant = at('2026-07-20T07:00:00Z'); // lundi 09:00 local
		expect(
			dueOccurrences({
				cadence: 'weekly',
				spec: SCHEDULE_DEFAULTS.weekly,
				since: instant,
				until: instant + HOUR
			})
		).toHaveLength(0);
		expect(
			dueOccurrences({
				cadence: 'weekly',
				spec: SCHEDULE_DEFAULTS.weekly,
				since: instant - HOUR,
				until: instant
			})
		).toHaveLength(1);
	});

	it('la fenêtre de rattrapage récupère un créneau manqué (tick en retard)', () => {
		const now = at('2026-07-20T11:30:00Z'); // 13:30 local, le créneau de 09:00 est passé
		const occ = dueOccurrences({
			cadence: 'weekly',
			spec: SCHEDULE_DEFAULTS.weekly,
			since: now - DEFAULT_LOOKBACK_MS,
			until: now
		});
		expect(occ.map((o) => o.localSlot)).toEqual(['2026-07-20T09:00']);
	});

	it('une cadence désactivée ne produit rien', () => {
		expect(
			dueOccurrences({
				cadence: 'weekly',
				spec: spec({ enabled: false }),
				since: at('2026-07-19T00:00:00Z'),
				until: at('2026-07-21T00:00:00Z')
			})
		).toEqual([]);
	});

	it('une fenêtre vide ou inversée ne produit rien', () => {
		const now = at('2026-07-20T07:00:00Z');
		expect(
			dueOccurrences({ cadence: 'daily', spec: SCHEDULE_DEFAULTS.daily, since: now, until: now })
		).toEqual([]);
		expect(
			dueOccurrences({
				cadence: 'daily',
				spec: SCHEDULE_DEFAULTS.daily,
				since: now,
				until: now - HOUR
			})
		).toEqual([]);
	});

	it('hourly tire une occurrence par heure locale, à la minute configurée', () => {
		const occ = dueOccurrences({
			cadence: 'hourly',
			spec: SCHEDULE_DEFAULTS.hourly, // :05
			since: at('2026-07-20T06:00:00Z'),
			until: at('2026-07-20T09:00:00Z')
		});
		expect(occ.map((o) => o.localSlot)).toEqual([
			'2026-07-20T08:05',
			'2026-07-20T09:05',
			'2026-07-20T10:05'
		]);
	});

	it('monthly ne tire que le jour configuré', () => {
		const occ = dueOccurrences({
			cadence: 'monthly',
			spec: SCHEDULE_DEFAULTS.monthly, // 1er, 08:00
			since: at('2026-06-28T00:00:00Z'),
			until: at('2026-07-03T00:00:00Z')
		});
		expect(occ.map((o) => o.localSlot)).toEqual(['2026-07-01T08:00']);
	});

	it('weekly ne tire que le jour de semaine configuré', () => {
		const occ = dueOccurrences({
			cadence: 'weekly',
			spec: SCHEDULE_DEFAULTS.weekly, // lundi
			since: at('2026-07-13T00:00:00Z'),
			until: at('2026-07-27T00:00:00Z')
		});
		expect(occ.map((o) => o.localSlot)).toEqual(['2026-07-13T09:00', '2026-07-20T09:00']);
	});
});

describe('nextOccurrence', () => {
	it('est STRICTEMENT postérieure (un créneau qui vient d’être tiré ne se retire pas)', () => {
		const instant = at('2026-07-20T07:00:00Z');
		const next = nextOccurrence({
			cadence: 'weekly',
			spec: SCHEDULE_DEFAULTS.weekly,
			after: instant
		});
		expect(next?.localSlot).toBe('2026-07-27T09:00');
	});

	it('rend null si la cadence est désactivée', () => {
		expect(
			nextOccurrence({ cadence: 'daily', spec: spec({ enabled: false }), after: Date.UTC(2026, 6, 20) })
		).toBeNull();
	});

	it('franchit un bord de mois', () => {
		const next = nextOccurrence({
			cadence: 'monthly',
			spec: SCHEDULE_DEFAULTS.monthly,
			after: at('2026-12-15T00:00:00Z')
		});
		expect(next?.localSlot).toBe('2027-01-01T08:00');
	});

	it('tombe toujours dans la fenêtre du tick horaire qui la suit', () => {
		// Invariant du tick `0 * * * *` : chaque occurrence est rattrapée par le
		// premier tick postérieur, quel que soit le régime DST.
		for (const start of ['2026-01-05T00:00:00Z', '2026-07-06T00:00:00Z']) {
			const occ = nextOccurrence({
				cadence: 'weekly',
				spec: SCHEDULE_DEFAULTS.weekly,
				after: at(start)
			})!;
			const tickAfter = Math.ceil(occ.instantMs / HOUR) * HOUR;
			expect(tickAfter - occ.instantMs).toBeLessThanOrEqual(HOUR);
			expect(
				dueOccurrences({
					cadence: 'weekly',
					spec: SCHEDULE_DEFAULTS.weekly,
					since: tickAfter - DEFAULT_LOOKBACK_MS,
					until: tickAfter
				}).map((o) => o.localSlot)
			).toContain(occ.localSlot);
		}
	});
});

// ── Configuration ───────────────────────────────────────────────────

describe('resolveScheduleConfig', () => {
	it('sans override, rend les défauts SPEC (hebdo = lundi 09:00)', () => {
		const cfg = resolveScheduleConfig(null);
		expect(cfg.weekly).toMatchObject({ enabled: true, weekday: 1, hour: 9, minute: 0 });
	});

	it('applique un override valide', () => {
		const cfg = resolveScheduleConfig({ weekly: { hour: 6, weekday: 3 } });
		expect(cfg.weekly).toMatchObject({ hour: 6, weekday: 3, minute: 0 });
	});

	it('permet de désactiver une cadence par projet', () => {
		expect(resolveScheduleConfig({ daily: { enabled: false } }).daily.enabled).toBe(false);
	});

	it('un override corrompu retombe sur le défaut (jamais de planification muette)', () => {
		const cfg = resolveScheduleConfig({
			weekly: { hour: 99, weekday: 0, minute: -3 },
			daily: 'nope' as never
		});
		expect(cfg.weekly).toMatchObject({ hour: 9, weekday: 1, minute: 0 });
		expect(cfg.daily).toEqual(SCHEDULE_DEFAULTS.daily);
	});

	it('borne le jour du mois à 28 (un créneau au 31 n’existerait pas en février)', () => {
		expect(resolveScheduleConfig({ monthly: { day: 31 } }).monthly.day).toBe(1);
		expect(resolveScheduleConfig({ monthly: { day: 28 } }).monthly.day).toBe(28);
	});

	it('ne mute pas les défauts partagés', () => {
		const cfg = resolveScheduleConfig({ weekly: { hour: 5 } });
		cfg.weekly.hour = 23;
		expect(SCHEDULE_DEFAULTS.weekly.hour).toBe(9);
	});
});

// ── Catalogue ───────────────────────────────────────────────────────

describe('SCHEDULE_CATALOG', () => {
	it('ne déclare que des cadences connues', () => {
		expect(Object.keys(SCHEDULE_CATALOG).sort()).toEqual([...SCHEDULE_CADENCES].sort());
	});

	it('hebdo = collecter, détecter, proposer ; quotidien = veilles + échéances d’indexation', () => {
		// GSC-002 — la chaîne commence par la COLLECTE. Sans elle, le détecteur
		// travaillait sur des observations figées au backfill du 2026-07-21 et
		// vieillissait d'une semaine chaque semaine, en silence.
		// IDX-001 — l'inventaire sitemap rejoint le run (branche `fetch_sitemap` du graphe
		// SPEC §8.2), en PARALLÈLE de la collecte GSC et sans dépendance avec elle.
		// IDX-004 — la branche d'indexation se referme : inspection puis détection.
		// FIND-005 — la baisse rejoint l'opportunité au MÊME niveau du graphe : deux
		// lecteurs des mêmes observations, sans provider et sans lien entre eux.
		expect(catalogFor('weekly').map((e) => e.jobType)).toEqual([
			'collect:gsc_query_page',
			'collect:sitemap',
			'collect:url_inspection',
			'detect:keyword_opportunity',
			'detect:keyword_decline',
			// FIND-006 — troisième lecteur des mêmes observations, au même niveau.
			'detect:query_turnover',
			// FIND-008 — quatrième lecteur : combien d'URLs se disputent une requête.
			'detect:cannibalization',
			'detect:index_transition',
			'propose:actions'
		]);
		// IDX-004 lot 2 — la passe quotidienne des échéances rejoint le quotidien.
		expect(catalogFor('daily').map((e) => e.jobType)).toEqual([
			'findings:lifecycle',
			'collect:url_inspection',
			'detect:index_transition'
		]);
	});

	it('IDX-004 lot 2 — la passe quotidienne n’inspecte QUE les échéances', () => {
		// `scope: 'due'` est ce qui fait de cette passe une réserve que la configuration ne
		// peut pas désarmer : ni routine ni échantillon n'y entrent, quel que soit le réglage.
		// Un `scope: 'full'` glissé ici la transformerait en second run hebdo quotidien —
		// six projets × le budget complet, tous les jours.
		const daily = catalogFor('daily').find((e) => e.jobType === 'collect:url_inspection')!;
		expect(daily.payload).toEqual({ mode: 'policy', scope: 'due' });
		expect(daily.payload).not.toHaveProperty('urls');
	});

	it('IDX-004 lot 2 — la passe quotidienne ne dépend de RIEN, et sa détection en dépend', () => {
		// Aucun prérequis : le canal `due` ne lit ni l'inventaire sitemap ni les clics. Une
		// arête vers un type absent de la cadence serait de toute façon rejetée par
		// `validateCatalogGraph` — mais l'invariant est de FOND, pas mécanique.
		const inspection = catalogFor('daily').find((e) => e.jobType === 'collect:url_inspection')!;
		expect(inspection.dependsOn).toBeUndefined();
		// Et l'arête vers le détecteur reste OBLIGATOIRE (défaut `required` absent ⇒ true),
		// pour la même raison qu'en hebdo : détecter sur une inspection périmée est le bug
		// que GSC-002 a fermé côté Search Analytics.
		const detector = catalogFor('daily').find((e) => e.jobType === 'detect:index_transition')!;
		expect(detector.dependsOn).toEqual([{ jobType: 'collect:url_inspection' }]);
		expect(detector.priority).toBeLessThan(inspection.priority);
	});

	it('IDX-001/004 — l’inventaire sitemap ne dépend de RIEN, et son seul dépendant l’a déclaré OPTIONNEL', () => {
		const sitemap = catalogFor('weekly').find((e) => e.jobType === 'collect:sitemap')!;
		// Aucune dépendance ENTRANTE : le XML est fetchable même quand Search Analytics
		// rend 429. Le lier à la collecte GSC ferait sauter l'inventaire pour un quota
		// qu'il ne consomme pas. C'est l'invariant d'origine, et il survit à IDX-004.
		expect(sitemap.dependsOn).toBeUndefined();
		// IDX-004 lui donne un dépendant — mais OPTIONNEL. C'est la moitié de l'invariant
		// qui protège la chaîne : un sitemap mort ne doit pas priver le projet de
		// l'inspection de ses findings et de ses échéances dues. Un `required: true`
		// glissé ici rendrait un 404 de sitemap capable de tuer toute l'indexation.
		const dependents = catalogFor('weekly').filter((e) =>
			(e.dependsOn ?? []).some((d) => d.jobType === 'collect:sitemap')
		);
		expect(dependents.map((e) => e.jobType)).toEqual(['collect:url_inspection']);
		for (const dep of dependents) {
			const edge = dep.dependsOn!.find((d) => d.jobType === 'collect:sitemap')!;
			expect(edge.required).toBe(false);
		}
	});

	it('IDX-004 — la collecte GSC est elle aussi un prérequis OPTIONNEL de l’inspection', () => {
		// `strategic` vient des clics GSC. Les vouloir ne justifie pas d'abandonner
		// l'inspection quand Search Analytics rend 429 : les échéances et les findings,
		// eux, n'ont pas besoin de GSC.
		const inspection = catalogFor('weekly').find((e) => e.jobType === 'collect:url_inspection')!;
		const edge = inspection.dependsOn!.find((d) => d.jobType === 'collect:gsc_query_page')!;
		expect(edge.required).toBe(false);
	});

	it('IDX-004 — l’arête vers le détecteur d’indexation est OBLIGATOIRE', () => {
		// Détecter sur une inspection périmée est le bug exact que GSC-002 a fermé côté
		// Search Analytics. Ici le défaut (`required` absent ⇒ true) porte la garantie.
		const detector = catalogFor('weekly').find((e) => e.jobType === 'detect:index_transition')!;
		expect(detector.dependsOn).toEqual([{ jobType: 'collect:url_inspection' }]);
	});

	it('IDX-004 — l’inspection porte une INTENTION, jamais une liste d’URLs', () => {
		// Le payload du catalogue est un littéral statique : une sélection calculée au plan
		// serait faite avant que `collect:sitemap` ait écrit l'inventaire du jour.
		const inspection = catalogFor('weekly').find((e) => e.jobType === 'collect:url_inspection')!;
		expect(inspection.payload).toEqual({ mode: 'policy', scope: 'full' });
		expect(inspection.payload).not.toHaveProperty('urls');
	});

	it('FIND-005 — l’arête vers la collecte GSC est OBLIGATOIRE pour le détecteur de baisses', () => {
		// Mesurer une baisse sur des observations que la collecte n'a pas rafraîchies,
		// c'est comparer une fenêtre à elle-même décalée d'une semaine. Le défaut
		// (`required` absent ⇒ true) porte la garantie : collecte morte ⇒ détecteur
		// `skipped` ⇒ run `partial`, et le trou est VISIBLE.
		const decline = catalogFor('weekly').find((e) => e.jobType === 'detect:keyword_decline')!;
		expect(decline.dependsOn).toEqual([{ jobType: 'collect:gsc_query_page' }]);
	});

	it('⭐ FIND-005 — baisse et opportunité sont FRÈRES, jamais enchaînés', () => {
		// Les deux lisent `gsc_query_page_observations` et n'appellent aucun provider :
		// les mettre en série ajouterait un tour de propagation de skip (JOB-004 propage
		// en N-1 passes) sans aucune contrepartie. Ils partagent donc le même prérequis
		// et la même priorité.
		const weekly = catalogFor('weekly');
		const decline = weekly.find((e) => e.jobType === 'detect:keyword_decline')!;
		const opportunity = weekly.find((e) => e.jobType === 'detect:keyword_opportunity')!;
		expect(decline.dependsOn).toEqual(opportunity.dependsOn);
		expect(decline.priority).toBe(opportunity.priority);
		// Contre-épreuve : aucune arête entre eux, dans un sens comme dans l'autre.
		expect((decline.dependsOn ?? []).some((d) => d.jobType === 'detect:keyword_opportunity')).toBe(
			false
		);
		expect((opportunity.dependsOn ?? []).some((d) => d.jobType === 'detect:keyword_decline')).toBe(
			false
		);
	});

	it('⭐ FIND-006 — le renouvellement est le TROISIÈME frère, jamais enchaîné aux deux autres', () => {
		// Trois lecteurs des mêmes observations, aucun provider, rien à se dire. Les
		// mettre en série ajouterait deux tours de propagation de skip (JOB-004 propage
		// en N-1 passes) sans aucune contrepartie.
		const weekly = catalogFor('weekly');
		const turnover = weekly.find((e) => e.jobType === 'detect:query_turnover')!;
		const decline = weekly.find((e) => e.jobType === 'detect:keyword_decline')!;
		expect(turnover.dependsOn).toEqual([{ jobType: 'collect:gsc_query_page' }]);
		expect(turnover.priority).toBe(decline.priority);
		for (const sibling of ['detect:keyword_decline', 'detect:keyword_opportunity']) {
			expect((turnover.dependsOn ?? []).some((d) => d.jobType === sibling)).toBe(false);
			const other = weekly.find((e) => e.jobType === sibling)!;
			expect((other.dependsOn ?? []).some((d) => d.jobType === 'detect:query_turnover')).toBe(false);
		}
	});

	it('⭐ FIND-008 — la cannibalisation est le QUATRIÈME frère, et rien ne dépend d’elle', () => {
		const weekly = catalogFor('weekly');
		const cannibal = weekly.find((e) => e.jobType === 'detect:cannibalization')!;
		const decline = weekly.find((e) => e.jobType === 'detect:keyword_decline')!;
		expect(cannibal.dependsOn).toEqual([{ jobType: 'collect:gsc_query_page' }]);
		expect(cannibal.priority).toBe(decline.priority);
		// Aucun lien avec les trois autres, dans les deux sens.
		for (const sibling of [
			'detect:keyword_decline',
			'detect:keyword_opportunity',
			'detect:query_turnover'
		]) {
			expect((cannibal.dependsOn ?? []).some((d) => d.jobType === sibling)).toBe(false);
			const other = weekly.find((e) => e.jobType === sibling)!;
			expect((other.dependsOn ?? []).some((d) => d.jobType === 'detect:cannibalization')).toBe(
				false
			);
		}
		// ⭐ Et surtout : le producteur ne la consomme pas. « merge, redirect et canonical
		// restent L4 » commence ici — aucune arête ne mène un conflit vers une proposition.
		const propose = weekly.find((e) => e.jobType === 'propose:actions')!;
		expect((propose.dependsOn ?? []).some((d) => d.jobType === 'detect:cannibalization')).toBe(
			false
		);
	});

	it('⭐ FIND-005 — le producteur de propositions ne dépend PAS du détecteur de baisses', () => {
		// AGT-000 ne traite que `keyword_opportunity` (`proposer-state.ts`) : une baisse
		// se diagnostique avant de se corriger, elle ne produit aucune proposition. Lier
		// `propose:actions` à ce détecteur créerait un couplage FAUX — un détecteur de
		// baisses mort ferait sauter des propositions qu'il n'alimente pas.
		const propose = catalogFor('weekly').find((e) => e.jobType === 'propose:actions')!;
		expect(propose.dependsOn).toEqual([{ jobType: 'detect:keyword_opportunity' }]);
	});

	it('la production de propositions est servie APRÈS la détection (priority DESC)', () => {
		const weekly = catalogFor('weekly');
		const detect = weekly.find((e) => e.jobType === 'detect:keyword_opportunity')!;
		const propose = weekly.find((e) => e.jobType === 'propose:actions')!;
		// La file sert par `priority DESC` : une priorité plus basse passe après.
		// Depuis JOB-004 ce n'est plus le SEUL garde-fou (cf. `dependsOn` ci-dessous),
		// mais l'ordre de service reste utile au sein d'un même tour de drain.
		expect(propose.priority).toBeLessThan(detect.priority);
	});

	it('JOB-004 — le producteur DÉPEND de la détection, et c’est obligatoire', () => {
		const propose = catalogFor('weekly').find((e) => e.jobType === 'propose:actions')!;
		expect(propose.dependsOn).toEqual([{ jobType: 'detect:keyword_opportunity' }]);
		// `required` absent = obligatoire (cf. `parseDependencies`) : si la détection
		// meurt, le producteur est sauté et le run vaut `partial`. Le trou de la
		// semaine devient visible, au lieu d'être masqué par des propositions
		// fondées sur les mesures de la semaine précédente.
		expect(resolveDependencies(propose.dependsOn, new Map([['detect:keyword_opportunity', 'j1']]))[0])
			.toEqual({ jobId: 'j1', jobType: 'detect:keyword_opportunity', required: true });
	});

	it('GSC-002 — le détecteur DÉPEND désormais de la collecte, et c’est obligatoire', () => {
		const detect = catalogFor('weekly').find((e) => e.jobType === 'detect:keyword_opportunity')!;
		expect(detect.dependsOn).toEqual([{ jobType: 'collect:gsc_query_page' }]);
		expect(
			resolveDependencies(detect.dependsOn, new Map([['collect:gsc_query_page', 'j0']]))[0]
		).toEqual({ jobId: 'j0', jobType: 'collect:gsc_query_page', required: true });
	});

	it('la collecte, elle, ne dépend de rien (elle ouvre la chaîne)', () => {
		const collect = catalogFor('weekly').find((e) => e.jobType === 'collect:gsc_query_page')!;
		expect(collect.dependsOn).toBeUndefined();
	});

	it('le graphe hebdo est de PROFONDEUR 3 — un skip s’y propage en deux passes', () => {
		// Conséquence directe de JOB-004 : une chaîne de profondeur N se résout en
		// N-1 passes. Si la collecte meurt, `detect` est sauté au tour à vide
		// suivant et `propose` seulement au tick d'APRÈS. À savoir avant de conclure
		// qu'un job « ne part pas ».
		const weekly = catalogFor('weekly');
		const collect = weekly.find((e) => e.jobType === 'collect:gsc_query_page')!;
		const detect = weekly.find((e) => e.jobType === 'detect:keyword_opportunity')!;
		const propose = weekly.find((e) => e.jobType === 'propose:actions')!;
		expect(collect.dependsOn).toBeUndefined();
		expect(detect.dependsOn?.[0].jobType).toBe(collect.jobType);
		expect(propose.dependsOn?.[0].jobType).toBe(detect.jobType);
		// L'ordre de service accompagne l'ordre de dépendance.
		expect(collect.priority).toBeGreaterThan(detect.priority);
		expect(detect.priority).toBeGreaterThan(propose.priority);
	});

	it('chaque cadence déclare un graphe VALIDE (prérequis avant dépendant, sans cycle)', () => {
		// Le catalogue est un littéral : ce test ferme la question pour de bon, et
		// `planDueJobs` le revalide avant toute écriture.
		for (const cadence of SCHEDULE_CADENCES) {
			expect(() => validateCatalogGraph(catalogFor(cadence))).not.toThrow();
		}
	});

	it('hourly et monthly restent SANS job câblé (aucun type fantôme en file)', () => {
		expect(catalogFor('hourly')).toEqual([]);
		expect(catalogFor('monthly')).toEqual([]);
		expect(wiredCadences()).toEqual(['daily', 'weekly']);
	});
});

// ── Post-publication ────────────────────────────────────────────────

describe('postPublishSlots', () => {
	it('pose J+3, J+7 et J+28 après la publication', () => {
		const base = at('2026-07-20T09:00:00Z');
		expect(postPublishSlots(base).map((s) => iso(s.instantMs))).toEqual([
			'2026-07-23T09:00:00.000Z',
			'2026-07-27T09:00:00.000Z',
			'2026-08-17T09:00:00.000Z'
		]);
	});

	it('ne dépend d’aucune horloge (même entrée → même sortie)', () => {
		const base = at('2026-01-01T00:00:00Z');
		expect(postPublishSlots(base)).toEqual(postPublishSlots(new Date(base)));
	});
});

// ── Format ──────────────────────────────────────────────────────────

describe('formatLocalSlot', () => {
	it('rend un créneau canonique zéro-paddé', () => {
		expect(formatLocalSlot({ year: 2026, month: 3, day: 9, hour: 7, minute: 5 })).toBe(
			'2026-03-09T07:05'
		);
	});

	it('deux créneaux locaux distincts ne collisionnent jamais', () => {
		const a = formatLocalSlot({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 });
		const b = formatLocalSlot({ year: 2026, month: 10, day: 25, hour: 3, minute: 30 });
		expect(a).not.toBe(b);
	});
});
