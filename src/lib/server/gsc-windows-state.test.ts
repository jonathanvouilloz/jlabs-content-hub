import { describe, it, expect } from 'vitest';
import {
	WINDOW_SPANS,
	spanToWeeks,
	buildWindowComparison,
	sumWindow,
	computeWindowDelta,
	windowCompleteness,
	buildYoyComparison,
	type WeekBounds
} from './gsc-windows-state.js';
import type { ObservationRow } from './detector-state.js';

// Semaines synthétiques : des lundis consécutifs, la plus récente en dernier index.
// 2026-06-01, -08, -15, … tous des lundis.
const MONDAYS = [
	'2026-05-04',
	'2026-05-11',
	'2026-05-18',
	'2026-05-25',
	'2026-06-01',
	'2026-06-08',
	'2026-06-15',
	'2026-06-22'
];

function weeks(starts: string[]): WeekBounds[] {
	return starts.map((s) => {
		const d = new Date(`${s}T00:00:00Z`);
		d.setUTCDate(d.getUTCDate() + 6);
		return { periodStart: s, periodEnd: d.toISOString().slice(0, 10) };
	});
}

function row(over: Partial<ObservationRow> & { periodStart: string }): ObservationRow {
	return {
		id: over.id ?? `${over.periodStart}-${over.query ?? 'q'}`,
		query: over.query ?? 'q',
		page: over.page ?? 'https://x/p',
		clicks: over.clicks ?? 0,
		impressions: over.impressions ?? 0,
		position: over.position ?? 0,
		periodStart: over.periodStart
	};
}

describe('spans → semaines', () => {
	it('mappe 7/28/90 jours sur 1/4/13 semaines', () => {
		expect(WINDOW_SPANS).toEqual([7, 28, 90]);
		expect(spanToWeeks(7)).toBe(1);
		expect(spanToWeeks(28)).toBe(4);
		expect(spanToWeeks(90)).toBe(13);
	});
});

describe('buildWindowComparison', () => {
	it('découpe courante puis précédente sur la bonne profondeur (28 j = 4 sem)', () => {
		const cmp = buildWindowComparison(weeks(MONDAYS), 28);
		expect(cmp.span).toBe(28);
		expect(cmp.weeks).toBe(4);
		expect(cmp.current).not.toBeNull();
		expect(cmp.prior).not.toBeNull();
		// 8 semaines dispo → courante = 4 plus récentes, précédente = 4 d'avant.
		expect(cmp.current!.start).toBe('2026-06-01');
		expect(cmp.current!.end).toBe('2026-06-28'); // 2026-06-22 + 6
		expect(cmp.prior!.start).toBe('2026-05-04');
		expect(cmp.prior!.end).toBe('2026-05-31'); // 2026-05-25 + 6
		expect(cmp.comparable).toBe(true);
	});

	it('historique trop court → précédente incomplète → non comparable', () => {
		// 6 semaines pour un span de 4 : courante pleine (4), précédente n'a que 2.
		const cmp = buildWindowComparison(weeks(MONDAYS.slice(2)), 28);
		expect(cmp.current!.weeks).toBe(4);
		expect(cmp.prior!.weeks).toBe(2);
		expect(cmp.comparable).toBe(false);
	});

	it('aucune donnée → fenêtres nulles, non comparable', () => {
		const cmp = buildWindowComparison([], 7);
		expect(cmp.current).toBeNull();
		expect(cmp.prior).toBeNull();
		expect(cmp.comparable).toBe(false);
	});

	it('dédup des semaines en double', () => {
		const dup = [...weeks(MONDAYS), ...weeks(MONDAYS)];
		const cmp = buildWindowComparison(dup, 90);
		// 8 semaines distinctes seulement, span 13 : courante = 8, pas 13.
		expect(cmp.current!.weeks).toBe(8);
	});
});

describe('sumWindow', () => {
	it('position pondérée par les impressions, CTR recalculé', () => {
		const totals = sumWindow([
			row({ periodStart: '2026-06-22', clicks: 5, impressions: 100, position: 3 }),
			row({ periodStart: '2026-06-22', clicks: 1, impressions: 900, position: 20, query: 'r' })
		]);
		expect(totals.clicks).toBe(6);
		expect(totals.impressions).toBe(1000);
		expect(totals.ctr).toBeCloseTo(6 / 1000);
		// (3*100 + 20*900) / 1000 = 18.3 — la ligne à 900 impressions domine.
		expect(totals.position).toBeCloseTo((3 * 100 + 20 * 900) / 1000);
		expect(totals.weeksSeen).toBe(1);
	});

	it('impressions nulles → CTR et position à 0, jamais NaN', () => {
		const totals = sumWindow([row({ periodStart: '2026-06-22', clicks: 0, impressions: 0 })]);
		expect(totals.ctr).toBe(0);
		expect(totals.position).toBe(0);
	});

	it('compte les semaines distinctes vues', () => {
		const totals = sumWindow([
			row({ periodStart: '2026-06-22', impressions: 10 }),
			row({ periodStart: '2026-06-15', impressions: 10 }),
			row({ periodStart: '2026-06-15', impressions: 10, query: 'r' })
		]);
		expect(totals.weeksSeen).toBe(2);
	});
});

describe('computeWindowDelta — gate de comparabilité (acceptation GSC-004)', () => {
	const cur = sumWindow([row({ periodStart: '2026-06-22', clicks: 12, impressions: 200, position: 4 })]);
	const prev = sumWindow([row({ periodStart: '2026-06-15', clicks: 8, impressions: 100, position: 6 })]);

	it('longueurs incompatibles → AUCUN delta', () => {
		const d = computeWindowDelta(cur, prev, false);
		expect(d.available).toBe(false);
		if (!d.available) expect(d.reason).toBe('incomparable_lengths');
	});

	it('comparable → deltas abs et % corrects', () => {
		const d = computeWindowDelta(cur, prev, true);
		expect(d.available).toBe(true);
		if (d.available) {
			expect(d.clicks.abs).toBe(4);
			expect(d.clicks.pct).toBeCloseTo((4 / 8) * 100);
			expect(d.impressions.abs).toBe(100);
		}
	});

	it('prior à 0 → pct null (pas de division par zéro)', () => {
		const zero = sumWindow([]);
		const d = computeWindowDelta(cur, zero, true);
		if (d.available) expect(d.clicks.pct).toBeNull();
	});
});

describe('windowCompleteness — confiance dérivée (acceptation GSC-004)', () => {
	const full = buildWindowComparison(weeks(MONDAYS), 28).current;
	const latestEnd = '2026-06-28'; // dimanche de la dernière semaine (2026-06-22 + 6)

	it('fenêtre pleine et fraîche → complète, aucun caveat', () => {
		const c = windowCompleteness({ current: full, expectedWeeks: 4, latestCompleteWeekEnd: latestEnd });
		expect(c.complete).toBe(true);
		expect(c.coverage).toBe(1);
		expect(c.fresh).toBe(true);
		expect(c.caveats).toEqual([]);
	});

	it('fenêtre tronquée → incomplète, coverage < 1, caveat explicite', () => {
		const short = buildWindowComparison(weeks(MONDAYS.slice(-2)), 28).current; // 2 semaines pour 4
		const c = windowCompleteness({ current: short, expectedWeeks: 4, latestCompleteWeekEnd: latestEnd });
		expect(c.complete).toBe(false);
		expect(c.coverage).toBeCloseTo(0.5);
		expect(c.caveats.some((x) => x.includes('incomplète'))).toBe(true);
	});

	it('fenêtre en retard (pas la dernière semaine) → pas fraîche, caveat', () => {
		const c = windowCompleteness({ current: full, expectedWeeks: 4, latestCompleteWeekEnd: '2026-07-05' });
		expect(c.fresh).toBe(false);
		expect(c.complete).toBe(false);
		expect(c.caveats.some((x) => x.includes('pas à jour'))).toBe(true);
	});

	it('aucune donnée → coverage 0, caveat', () => {
		const c = windowCompleteness({ current: null, expectedWeeks: 4, latestCompleteWeekEnd: latestEnd });
		expect(c.coverage).toBe(0);
		expect(c.caveats.some((x) => x.includes('aucune donnée'))).toBe(true);
	});
});

describe('buildYoyComparison — gate inerte', () => {
	it('sans semaine N-1 en base → indisponible (no_year_ago_data)', () => {
		const y = buildYoyComparison(weeks(MONDAYS), 7);
		expect(y.available).toBe(false);
		if (!y.available) expect(y.reason).toBe('no_year_ago_data');
	});

	it('courante trop courte → insufficient_current', () => {
		const y = buildYoyComparison(weeks(MONDAYS), 90); // 8 sem dispo pour 13
		expect(y.available).toBe(false);
		if (!y.available) expect(y.reason).toBe('insufficient_current');
	});

	it("s'active dès que les semaines N-1 existent (364 j plus tôt)", () => {
		// Courante = 1 semaine (span 7). Ajoute la même semaine 52 semaines plus tôt.
		const current = '2026-06-22';
		const yearAgo = '2025-06-23'; // 2026-06-22 − 364 j
		const y = buildYoyComparison(weeks([yearAgo, current]), 7);
		expect(y.available).toBe(true);
		if (y.available) {
			expect(y.current.start).toBe(current);
			expect(y.yearAgo.start).toBe(yearAgo);
		}
	});
});
