export interface ReviewReplyProposalSnapshot {
	reviewId: string;
	replyText: string;
}

export type RemoteReviewSnapshot =
	| {
			kind: 'present';
			replyText: string | null;
			rating?: number;
			comment?: string;
			updateAt?: string | null;
			replyAt?: string | null;
	  }
	| { kind: 'missing' };

export type ReviewReplyPublicationDecision =
	| { action: 'put' }
	| { action: 'verified'; reason: 'remote_reply_matches' }
	| { action: 'conflict'; reason: 'remote_reply_differs' | 'review_missing' | 'snapshot_changed' };

/**
 * Décide le seul prochain geste autorisé à partir d'une relecture distante.
 * Une réponse Google existante n'est jamais écrasée : identique = preuve de succès,
 * différente = divergence terminale, absente = seul cas qui autorise le PUT.
 */
export function decideReviewReplyPublication(input: {
	proposal: ReviewReplyProposalSnapshot;
	remote: RemoteReviewSnapshot;
}): ReviewReplyPublicationDecision {
	if (input.remote.kind === 'missing') return { action: 'conflict', reason: 'review_missing' };
	if (input.remote.replyText === null) return { action: 'put' };
	return input.remote.replyText === input.proposal.replyText
		? { action: 'verified', reason: 'remote_reply_matches' }
		: { action: 'conflict', reason: 'remote_reply_differs' };
}
