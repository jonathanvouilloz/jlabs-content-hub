import { describe, expect, it, vi } from 'vitest';
import { readGoogleReviewReply, putGoogleReviewReply } from './gmb-review-reply-api.js';

describe('Google review reply API adapter', () => {
	it('lit la réponse distante exacte et traite un avis supprimé comme absent', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				starRating: 'FIVE',
				comment: 'Excellent',
				updateTime: '2026-09-24T08:30:00Z',
				reviewReply: { comment: 'Merci !', updateTime: '2026-09-24T09:00:00Z' }
			}), { status: 200 }))
			.mockResolvedValueOnce(new Response('', { status: 404 }));
		const input = { accountId: 'accounts/acct', locationId: 'locations/rive', reviewId: 'reviews/r-1', accessToken: 'token', fetchImpl };

		await expect(readGoogleReviewReply(input)).resolves.toMatchObject({
			kind: 'present',
			replyText: 'Merci !',
			rating: 5,
			comment: 'Excellent',
			updateAt: '2026-09-24 08:30:00',
			replyAt: '2026-09-24 09:00:00'
		});
		await expect(readGoogleReviewReply(input)).resolves.toEqual({ kind: 'missing' });
		expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://mybusiness.googleapis.com/v4/accounts/acct/locations/rive/reviews/r-1');
	});

	it('écrit avec PUT et échoue explicitement sur une réponse Google non-2xx', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response('{}', { status: 200 }))
			.mockResolvedValueOnce(new Response('quota', { status: 429 }));
		const input = { accountId: 'acct', locationId: 'rive', reviewId: 'r-1', accessToken: 'token', fetchImpl };

		await expect(putGoogleReviewReply(input, 'Merci !')).resolves.toBeUndefined();
		await expect(putGoogleReviewReply(input, 'Merci !')).rejects.toThrow('Google reply PUT failed: 429 quota');
		expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ comment: 'Merci !' }) });
	});
});
