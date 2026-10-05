import { describe, expect, it } from 'vitest';
import {
	reviewStatusEtag,
	reviewStatusWindows,
	summarizeReviewStatus,
	type StatusLocationRow,
	type StatusReviewRow
} from './agent-review-status-state.js';

const now = new Date('2026-10-05T10:00:00Z');

const locations: StatusLocationRow[] = [
	{ locationId: 'loc-sion', label: 'Sion', lastSyncAt: '2026-10-05 05:00:00', lastSyncStatus: 'success', autoPublishingEnabled: true },
	{ locationId: 'loc-cornavin', label: 'Cornavin', lastSyncAt: '2026-10-01 05:00:00', lastSyncStatus: 'success', autoPublishingEnabled: true },
	{ locationId: 'loc-jonction', label: 'Jonction', lastSyncAt: '2026-10-05 05:00:00', lastSyncStatus: 'error', autoPublishingEnabled: true }
];

function review(overrides: Partial<StatusReviewRow>): StatusReviewRow {
	return {
		locationId: 'loc-sion',
		locationLabel: 'Sion',
		rating: 5,
		createTime: '2026-10-05T08:00:00Z',
		status: 'eligible_auto',
		latestProposalState: null,
		hasVerifiedReply: false,
		...overrides
	};
}

const policy = { mode: 'guarded_auto', killSwitch: false, autoGenerationEnabled: true, minRatingForAutoSend: 4 };

function build(reviews: StatusReviewRow[], pending = new Map<string, number>()) {
	return summarizeReviewStatus({ projectSlug: 'barberconcept', now, reviews, locations, policy, pendingConfirmationsByLocation: pending });
}

const sample = [
	review({}),
	review({ rating: 2, status: 'requires_human', createTime: '2026-10-04T12:00:00Z' }),
	review({ rating: 4, status: 'write_unknown', latestProposalState: 'write_unknown', createTime: '2026-10-03T12:00:00Z' }),
	review({ rating: 5, status: 'already_replied', hasVerifiedReply: true, latestProposalState: 'verified', createTime: '2026-10-02T12:00:00Z' }),
	review({ locationId: 'loc-cornavin', locationLabel: 'Cornavin', status: 'stale_or_unhealthy_location', createTime: '2026-09-01T12:00:00Z' }),
	review({ rating: 1, status: 'sensitive_or_blocked', createTime: '2026-08-01T12:00:00Z' })
];

describe('reviewStatusWindows', () => {
	it('rend des bornes explicites, jour civil Europe/Zurich compris', () => {
		const windows = reviewStatusWindows(now);
		expect(windows.last24Hours).toEqual({ fromInclusive: '2026-10-04T10:00:00.000Z', toExclusive: '2026-10-05T10:00:00.000Z' });
		expect(windows.last7Days.fromInclusive).toBe('2026-09-28T10:00:00.000Z');
		// Heure d'été : minuit local = 22:00 UTC la veille.
		expect(windows.today).toMatchObject({ fromInclusive: '2026-10-04T22:00:00.000Z', toExclusive: '2026-10-05T22:00:00.000Z' });
	});

	it('suit le changement d heure (journée de 25 h le 25 octobre)', () => {
		const today = reviewStatusWindows(new Date('2026-10-25T12:00:00Z')).today;
		expect(today.fromInclusive).toBe('2026-10-24T22:00:00.000Z');
		expect(today.toExclusive).toBe('2026-10-25T23:00:00.000Z');
	});
});

describe('summarizeReviewStatus', () => {
	it('les statuts canoniques partitionnent le total de chaque fenêtre', () => {
		const data = build(sample);
		for (const counts of Object.values(data.periods)) {
			const sum = counts.eligibleAuto + counts.requiresHuman + counts.sensitiveOrBlocked
				+ counts.alreadyReplied + counts.writeUnknown + counts.staleOrUnhealthyLocation;
			expect(sum).toBe(counts.reviews);
			expect(Object.values(counts.ratings).reduce((a, b) => a + b, 0)).toBe(counts.reviews);
		}
		expect(data.periods.last24Hours).toMatchObject({ reviews: 2, eligibleAuto: 1, requiresHuman: 1 });
		expect(data.periods.last7Days).toMatchObject({
			reviews: 4,
			writeUnknown: 1,
			alreadyReplied: 1,
			verifiedReplies: 1,
			pendingConfirmations: 1,
			ratings: { '1': 0, '2': 1, '3': 0, '4': 1, '5': 2 }
		});
		expect(data.periods.today.reviews).toBe(1);
	});

	it('rend explicites les fiches stale, en panne et inconnues — jamais saines par défaut', () => {
		const data = build([review({ locationId: 'loc-ghost', locationLabel: 'Fantôme' })]);
		const byId = Object.fromEntries(data.locations.map((l) => [l.locationId, l]));
		expect(byId['loc-sion'].freshnessStatus).toBe('healthy');
		expect(byId['loc-cornavin'].freshnessStatus).toBe('stale');
		expect(byId['loc-jonction']).toMatchObject({ freshnessStatus: 'degraded', lastSuccessfulSyncAt: null, lastSyncAt: '2026-10-05T05:00:00.000Z' });
		expect(byId['loc-ghost'].freshnessStatus).toBe('unknown');
		expect(data.freshness.overallStatus).toBe('degraded');
		expect(data.freshness.oldestLocationSyncAt).toBeNull();
		expect(data.freshness.lastSuccessfulCollectionAt).toBe('2026-10-05T05:00:00.000Z');
	});

	it('expose les confirmations en attente par salon sans rien relancer', () => {
		const data = build(sample, new Map([['loc-sion', 2]]));
		expect(data.pendingConfirmationsTotal).toBe(2);
		expect(data.locations.find((l) => l.locationId === 'loc-sion')?.pendingConfirmations).toBe(2);
	});

	it('compte les ouverts humains/sensibles sur 180 j par salon', () => {
		const sion = build(sample).locations.find((l) => l.locationId === 'loc-sion');
		expect(sion).toMatchObject({ requiresHumanOpen: 1, sensitiveOpen: 1, reviewsLast24Hours: 2, reviewsLast7Days: 4 });
		const old = build([review({ status: 'requires_human', createTime: '2026-01-01T00:00:00Z' })]);
		expect(old.locations.find((l) => l.locationId === 'loc-sion')?.requiresHumanOpen).toBe(0);
	});

	it('trie les salons de façon stable par label', () => {
		const labels = build(sample).locations.map((l) => l.label);
		expect(labels).toEqual(['Cornavin', 'Jonction', 'Sion']);
		expect(build([...sample].reverse()).locations.map((l) => l.label)).toEqual(labels);
	});

	it('résume la policy, et une policy absente reste unknown', () => {
		expect(build([]).policy).toEqual({ status: 'active', mode: 'guarded_auto', autoPublishingEnabled: true, minimumAutoRating: 4 });
		const none = summarizeReviewStatus({ projectSlug: 'barberconcept', now, reviews: [], locations: [], policy: null, pendingConfirmationsByLocation: new Map() });
		expect(none.policy.status).toBe('unknown');
		expect(none.freshness.overallStatus).toBe('unknown');
		const killed = summarizeReviewStatus({ projectSlug: 'barberconcept', now, reviews: [], locations, policy: { ...policy, killSwitch: true }, pendingConfirmationsByLocation: new Map() });
		expect(killed.policy).toMatchObject({ status: 'disabled', autoPublishingEnabled: false });
	});

	it('ne contient aucune donnée client ni texte', () => {
		const serialized = JSON.stringify(build(sample));
		for (const forbidden of ['reviewId', 'comment', 'text', 'author', 'googleReviewUrl', 'replyText', 'http']) {
			expect(serialized).not.toContain(forbidden);
		}
	});
});

describe('reviewStatusEtag', () => {
	it('est identique pour des données identiques, même à un autre instant de génération', () => {
		const a = build(sample);
		const b = { ...build(sample), generatedAt: '2026-10-05T10:00:20.000Z' };
		expect(reviewStatusEtag(a)).toBe(reviewStatusEtag(b));
		expect(reviewStatusEtag(a)).toMatch(/^"[0-9a-f]{64}"$/);
	});

	it('change dès que les données changent', () => {
		expect(reviewStatusEtag(build(sample))).not.toBe(reviewStatusEtag(build([...sample, review({})])));
	});
});
