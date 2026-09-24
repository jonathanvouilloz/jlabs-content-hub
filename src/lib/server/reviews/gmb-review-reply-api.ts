import type { RemoteReviewSnapshot } from './review-reply-publisher-state.js';
import { toDbTimestamp } from '../timestamps.js';

const GMB_REVIEWS_BASE = 'https://mybusiness.googleapis.com/v4';

export interface GoogleReviewReplyRequest {
	accountId: string;
	locationId: string;
	reviewId: string;
	accessToken: string;
	fetchImpl?: typeof fetch;
}

function segment(value: string, prefix: string): string {
	return value.replace(new RegExp(`^${prefix}/`), '');
}

function endpoint(input: GoogleReviewReplyRequest): string {
	return `${GMB_REVIEWS_BASE}/accounts/${segment(input.accountId, 'accounts')}/locations/${segment(input.locationId, 'locations')}/reviews/${segment(input.reviewId, 'reviews')}`;
}

function headers(accessToken: string): HeadersInit {
	return { Authorization: `Bearer ${accessToken}` };
}

const RATING_BY_ENUM: Record<string, number> = {
	ONE: 1,
	TWO: 2,
	THREE: 3,
	FOUR: 4,
	FIVE: 5
};

/** Lit l'avis sans transformer une absence Google en « pas de réponse » locale. */
export async function readGoogleReviewReply(input: GoogleReviewReplyRequest): Promise<RemoteReviewSnapshot> {
	const res = await (input.fetchImpl ?? fetch)(endpoint(input), { headers: headers(input.accessToken) });
	if (res.status === 404) return { kind: 'missing' };
	if (!res.ok) throw new Error(`Google review GET failed: ${res.status} ${await res.text()}`);
	const body = (await res.json()) as {
		starRating?: unknown;
		comment?: unknown;
		updateTime?: unknown;
		reviewReply?: { comment?: unknown; updateTime?: unknown };
	};
	return {
		kind: 'present',
		replyText: typeof body.reviewReply?.comment === 'string' ? body.reviewReply.comment : null,
		rating: typeof body.starRating === 'string' ? RATING_BY_ENUM[body.starRating] : undefined,
		comment: typeof body.comment === 'string' ? body.comment : '',
		updateAt: typeof body.updateTime === 'string' ? toDbTimestamp(body.updateTime) : null,
		replyAt: typeof body.reviewReply?.updateTime === 'string' ? toDbTimestamp(body.reviewReply.updateTime) : null
	};
}

/** PUT nu : son résultat n'est jamais une preuve, seul le GET suivant l'est. */
export async function putGoogleReviewReply(input: GoogleReviewReplyRequest, replyText: string): Promise<void> {
	const res = await (input.fetchImpl ?? fetch)(`${endpoint(input)}/reply`, {
		method: 'PUT',
		headers: { ...headers(input.accessToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ comment: replyText })
	});
	if (!res.ok) throw new Error(`Google reply PUT failed: ${res.status} ${await res.text()}`);
}
