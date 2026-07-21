import { describe, it, expect } from 'vitest';
import {
	weightedPosition,
	rollupPagesFromQueryPage,
	toGscQueryPageInput,
	toGmbInsightInput,
	pickKeywordRankRow,
	buildKeywordRankInputs,
	toKeywordRankInput,
	type GscQueryPageSourceRow,
	type KeywordRankSourceRow
} from './observation-backfill.js';

function qp(over: Partial<GscQueryPageSourceRow>): GscQueryPageSourceRow {
	return {
		projectId: 'p1',
		weekStart: '2026-07-13',
		weekEnd: '2026-07-19',
		query: 'muay thai geneve',
		page: 'https://ex.ch/a',
		device: 'MOBILE',
		clicks: 0,
		impressions: 0,
		ctr: 0,
		position: 0,
		...over
	};
}

function kr(over: Partial<KeywordRankSourceRow>): KeywordRankSourceRow {
	return {
		projectId: 'p1',
		weekStart: '2026-07-13',
		keyword: 'muay thai geneve',
		device: 'MOBILE',
		page: 'https://ex.ch/a',
		clicks: 0,
		impressions: 0,
		ctr: 0,
		position: 10,
		...over
	};
}

describe('weightedPosition', () => {
	it('pondère la position par les impressions', () => {
		// (3*1000 + 50*10) / 1010 ≈ 3.465
		const p = weightedPosition([
			{ position: 3, impressions: 1000 },
			{ position: 50, impressions: 10 }
		]);
		expect(p).toBeCloseTo(3500 / 1010, 6);
	});
	it('retourne 0 quand le total d’impressions est nul (division par zéro évitée)', () => {
		expect(weightedPosition([{ position: 42, impressions: 0 }])).toBe(0);
		expect(weightedPosition([])).toBe(0);
	});
});

describe('rollupPagesFromQueryPage', () => {
	it('agrège plusieurs queries d’une même page en une ligne page', () => {
		const rows = [
			qp({ query: 'a', clicks: 5, impressions: 100, position: 4 }),
			qp({ query: 'b', clicks: 3, impressions: 300, position: 8 })
		];
		const out = rollupPagesFromQueryPage(rows);
		expect(out).toHaveLength(1);
		const page = out[0];
		expect(page.page).toBe('https://ex.ch/a');
		expect(page.clicks).toBe(8);
		expect(page.impressions).toBe(400);
		expect(page.ctr).toBeCloseTo(8 / 400, 6);
		expect(page.position).toBeCloseTo((4 * 100 + 8 * 300) / 400, 6);
		expect(page.periodStart).toBe('2026-07-13');
		expect(page.periodEnd).toBe('2026-07-19');
		expect(page.runId).toBeNull();
		expect(page.payloadJson).toBeNull();
		expect(page.schemaVersion).toBe(1);
	});
	it('sépare les groupes par page ET par device', () => {
		const rows = [
			qp({ page: 'https://ex.ch/a', device: 'MOBILE', impressions: 10 }),
			qp({ page: 'https://ex.ch/a', device: 'DESKTOP', impressions: 20 }),
			qp({ page: 'https://ex.ch/b', device: 'MOBILE', impressions: 30 })
		];
		const out = rollupPagesFromQueryPage(rows);
		expect(out).toHaveLength(3);
	});
	it('ctr = 0 quand aucune impression', () => {
		const out = rollupPagesFromQueryPage([qp({ clicks: 0, impressions: 0 })]);
		expect(out[0].ctr).toBe(0);
		expect(out[0].position).toBe(0);
	});
});

describe('toGscQueryPageInput', () => {
	it('mappe week_start/week_end → period_start/period_end et fixe les défauts backfill', () => {
		const input = toGscQueryPageInput(
			qp({ clicks: 2, impressions: 50, ctr: 0.04, position: 6.5 })
		);
		expect(input).toMatchObject({
			projectId: 'p1',
			periodStart: '2026-07-13',
			periodEnd: '2026-07-19',
			query: 'muay thai geneve',
			page: 'https://ex.ch/a',
			device: 'MOBILE',
			clicks: 2,
			impressions: 50,
			ctr: 0.04,
			position: 6.5,
			runId: null,
			schemaVersion: 1,
			payloadJson: null
		});
	});
});

describe('toGmbInsightInput', () => {
	it('mappe date → observed_date et location_id', () => {
		const input = toGmbInsightInput({
			projectId: 'p1',
			date: '2026-07-20',
			gmbLocationId: 'loc42',
			metric: 'WEBSITE_CLICKS',
			value: 17
		});
		expect(input).toMatchObject({
			projectId: 'p1',
			observedDate: '2026-07-20',
			locationId: 'loc42',
			metric: 'WEBSITE_CLICKS',
			value: 17,
			runId: null,
			schemaVersion: 1,
			payloadJson: null
		});
	});
});

describe('pickKeywordRankRow', () => {
	it('retient la ligne à impressions max', () => {
		const best = pickKeywordRankRow([
			kr({ page: 'https://ex.ch/a', impressions: 10, position: 3 }),
			kr({ page: 'https://ex.ch/b', impressions: 40, position: 9 })
		]);
		expect(best.page).toBe('https://ex.ch/b');
	});
	it('départage par position la plus basse à impressions égales', () => {
		const best = pickKeywordRankRow([
			kr({ page: 'https://ex.ch/a', impressions: 10, position: 8 }),
			kr({ page: 'https://ex.ch/b', impressions: 10, position: 3 })
		]);
		expect(best.page).toBe('https://ex.ch/b');
	});
	it('est déterministe (page croissante) à impressions ET position égales', () => {
		const best = pickKeywordRankRow([
			kr({ page: 'https://ex.ch/z', impressions: 10, position: 5 }),
			kr({ page: 'https://ex.ch/a', impressions: 10, position: 5 })
		]);
		expect(best.page).toBe('https://ex.ch/a');
	});
	it('lève si aucune ligne candidate', () => {
		expect(() => pickKeywordRankRow([])).toThrow();
	});
});

describe('buildKeywordRankInputs', () => {
	it('produit une ligne par (projet, keyword, device, semaine)', () => {
		const rows = [
			kr({ device: 'MOBILE', page: 'https://ex.ch/a', impressions: 10 }),
			kr({ device: 'MOBILE', page: 'https://ex.ch/b', impressions: 40 }),
			kr({ device: 'DESKTOP', page: 'https://ex.ch/a', impressions: 5 })
		];
		const out = buildKeywordRankInputs(rows);
		expect(out).toHaveLength(2); // MOBILE + DESKTOP
		const mobile = out.find((o) => o.device === 'MOBILE');
		expect(mobile?.page).toBe('https://ex.ch/b'); // représentative = impressions max
		expect(mobile?.observedDate).toBe('2026-07-13');
	});
	it('mappe via toKeywordRankInput avec défauts backfill', () => {
		const input = toKeywordRankInput(kr({ position: 4.2, clicks: 1, impressions: 20, ctr: 0.05 }));
		expect(input).toMatchObject({
			observedDate: '2026-07-13',
			keyword: 'muay thai geneve',
			device: 'MOBILE',
			page: 'https://ex.ch/a',
			position: 4.2,
			clicks: 1,
			impressions: 20,
			ctr: 0.05,
			runId: null,
			schemaVersion: 1,
			payloadJson: null
		});
	});
});
