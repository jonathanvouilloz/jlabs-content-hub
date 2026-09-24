import type { RemoteReviewSnapshot } from './review-reply-publisher-state.js';

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

/** Lit l'avis sans transformer une absence Google en « pas de réponse » locale. */
export async function readGoogleReviewReply(input: GoogleReviewReplyRequest): Promise<RemoteReviewSnapshot> {
	const res = await (input.fetchImpl ?? fetch)(endpoint(input), { headers: headers(input.accessToken) });
	if (res.status === 404) return { kind: 'missing' };
	if (!res.ok) throw new Error(`Google review GET failed: ${res.status} ${await res.text()}`);
	const body = (await res.json()) as { reviewReply?: { comment?: unknown } };
	return {
		kind: 'present',
		replyText: typeof body.reviewReply?.comment === 'string' ? body.reviewReply.comment : null
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
