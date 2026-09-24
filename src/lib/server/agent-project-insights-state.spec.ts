import { describe, expect, it } from 'vitest';
import { buildAgentProjectInsights } from './agent-project-insights-state.js';

describe('agent project insights', () => {
	it('returns a bounded read-only GSC payload without database identifiers or secret-bearing fields', () => {
		const result = buildAgentProjectInsights({
			project: { slug: 'lecureux', name: 'Lécureux Conseil' },
			snapshot: {
				id: 'snapshot-private-id',
				weekStart: '2026-08-10',
				weekEnd: '2026-08-16',
				fetchedAt: '2026-08-20T08:00:00.000Z',
				status: 'success',
				totalClicks: 32,
				totalImpressions: 912,
				avgCtr: 0.035,
				avgPosition: 11.2,
				errorMessage: null
			},
			diff: { kpis: { clicks: 32 }, rising: [], falling: [], opportunities: [], newKeywords: [], lostKeywords: [] },
			actions: {
				opportunities: [{ query: 'bail commercial restaurant genève', page: 'https://example.test/', impressions: 70, clicks: 1, ctr: 0.014, position: 9.2, gainEstimate: 3, verdict: 'Créer une page', verdictType: 'create_page' }],
				quickWins: []
			},
			movers: { gains: [], losses: [] },
			cannibalization: []
		});

		expect(result).toMatchObject({
			project: { slug: 'lecureux', name: 'Lécureux Conseil' },
			freshness: { weekStart: '2026-08-10', status: 'success' },
			gsc: { clicks: 32, impressions: 912, opportunities: [{ query: 'bail commercial restaurant genève' }] }
		});
		expect(JSON.stringify(result)).not.toContain('snapshot-private-id');
		expect(JSON.stringify(result)).not.toContain('errorMessage');
	});

	it('makes the absence of a completed snapshot explicit instead of reporting zero metrics', () => {
		expect(
			buildAgentProjectInsights({
				project: { slug: 'lecureux', name: 'Lécureux Conseil' },
				snapshot: null,
				diff: null,
				actions: { opportunities: [], quickWins: [] },
				movers: { gains: [], losses: [] },
				cannibalization: []
			})
		).toEqual({
			project: { slug: 'lecureux', name: 'Lécureux Conseil' },
			freshness: { status: 'not_collected' },
			gsc: null
		});
	});
});
