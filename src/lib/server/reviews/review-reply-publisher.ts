import {
	decideReviewReplyPublication,
	type RemoteReviewSnapshot,
	type ReviewReplyProposalSnapshot
} from './review-reply-publisher-state.js';

export interface PublishableReviewReply extends ReviewReplyProposalSnapshot {
	id: string;
}

export type ReviewReplyDeliveryEvent = {
	proposalId: string;
	state: 'reserved' | 'sent' | 'write_unknown' | 'verified' | 'conflict';
	error?: string;
	reason?: 'remote_reply_differs' | 'review_missing';
	remote?: RemoteReviewSnapshot;
};

export type ReviewReplyPublishResult =
	| { state: 'verified' }
	| { state: 'conflict'; reason: 'remote_reply_differs' | 'review_missing' }
	| { state: 'write_unknown'; error: string };

/**
 * Publie UNE réponse sous dépendances injectées. L'ordonnancement est la garantie :
 * audit de réservation → GET Google → PUT seulement si vide → GET Google de preuve.
 * Un timeout est indécidable : le second GET tranche et aucun retry ne part ici.
 */
export async function publishReviewReply(input: {
	proposal: PublishableReviewReply;
	loadRemote: () => Promise<RemoteReviewSnapshot>;
	putReply: (replyText: string) => Promise<void>;
	record: (event: ReviewReplyDeliveryEvent) => Promise<void>;
}): Promise<ReviewReplyPublishResult> {
	const record = (event: Omit<ReviewReplyDeliveryEvent, 'proposalId'>) =>
		input.record({ proposalId: input.proposal.id, ...event });

	await record({ state: 'reserved' });

	let before: RemoteReviewSnapshot;
	try {
		before = await input.loadRemote();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await record({ state: 'write_unknown', error: message });
		return { state: 'write_unknown', error: message };
	}

	const decision = decideReviewReplyPublication({ proposal: input.proposal, remote: before });
	if (decision.action === 'verified') {
		await record({ state: 'verified', remote: before });
		return { state: 'verified' };
	}
	if (decision.action === 'conflict') {
		await record({ state: 'conflict', reason: decision.reason, remote: before });
		return { state: 'conflict', reason: decision.reason };
	}

	try {
		await input.putReply(input.proposal.replyText);
		await record({ state: 'sent' });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await record({ state: 'write_unknown', error: message });
	}

	let after: RemoteReviewSnapshot;
	try {
		after = await input.loadRemote();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await record({ state: 'write_unknown', error: message });
		return { state: 'write_unknown', error: message };
	}

	const verified = decideReviewReplyPublication({ proposal: input.proposal, remote: after });
	if (verified.action === 'verified') {
		await record({ state: 'verified', remote: after });
		return { state: 'verified' };
	}
	if (verified.action === 'conflict') {
		await record({ state: 'conflict', reason: verified.reason, remote: after });
		return { state: 'conflict', reason: verified.reason };
	}

	const error = 'Google ne confirme toujours aucune réponse après le PUT.';
	await record({ state: 'write_unknown', error, remote: after });
	return { state: 'write_unknown', error };
}
