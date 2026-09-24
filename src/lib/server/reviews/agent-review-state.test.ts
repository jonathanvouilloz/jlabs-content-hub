import { describe, expect, it } from 'vitest';
import {
	classifyAgentReview,
	decodeReviewCursor,
	encodeReviewCursor,
	europeZurichMonthWindow
} from './agent-review-state.js';

const healthy = {
	remoteReplyText: null,
	lastSeenAt: '2026-09-24 10:00:00',
	locationLastSyncAt: '2026-09-24 09:00:00',
	locationLastSyncStatus: 'success',
	now: new Date('2026-09-24T12:00:00Z'),
	policy: {
		mode: 'guarded_auto',
		autoGenerationEnabled: true,
		killSwitch: false,
		minRatingForAutoSend: 4,
		escalationCategories: ['sensitive']
	}
};

describe('classifyAgentReview', () => {
	it('autorise les avis 4 et 5 etoiles non sensibles sous policy active', () => {
		for (const rating of [4, 5]) {
			expect(classifyAgentReview({ ...healthy, rating, comment: 'Super service' })).toMatchObject({
				status: 'eligible_auto',
				autoPublishable: true
			});
		}
	});

	it('refuse toujours les avis 1 a 3 etoiles', () => {
		for (const rating of [1, 2, 3]) {
			expect(classifyAgentReview({ ...healthy, rating, comment: 'Avis ordinaire' }).status).toBe('requires_human');
		}
	});

	it('bloque le contenu sensible quelle que soit la note', () => {
		expect(classifyAgentReview({ ...healthy, rating: 5, comment: 'Je vais appeler mon avocat.' }).status)
			.toBe('sensitive_or_blocked');
	});

	it('distingue une reponse distante, un write unknown et une fiche stale', () => {
		expect(classifyAgentReview({ ...healthy, rating: 5, comment: '', remoteReplyText: 'Merci !' }).status)
			.toBe('already_replied');
		expect(classifyAgentReview({ ...healthy, rating: 5, comment: '', proposalState: 'write_unknown' }).status)
			.toBe('write_unknown');
		expect(classifyAgentReview({
			...healthy,
			rating: 5,
			comment: '',
			locationLastSyncAt: '2026-09-20 09:00:00'
		}).status).toBe('stale_or_unhealthy_location');
	});
});

describe('review cursor', () => {
	it('round-trips a stable cursor and rejects malformed input', () => {
		const cursor = encodeReviewCursor({ createTime: '2026-09-24T10:00:00Z', reviewId: 'r-42' });
		expect(decodeReviewCursor(cursor)).toEqual({
			version: 1,
			createTime: '2026-09-24T10:00:00Z',
			reviewId: 'r-42'
		});
		expect(decodeReviewCursor('not-json')).toBeNull();
	});
});

describe('europeZurichMonthWindow', () => {
	it('uses both Zurich offsets across the March DST boundary', () => {
		expect(europeZurichMonthWindow('2026-03')).toEqual({
			period: '2026-03',
			timezone: 'Europe/Zurich',
			fromInclusive: '2026-02-28T23:00:00.000Z',
			toExclusive: '2026-03-31T22:00:00.000Z'
		});
	});
});
