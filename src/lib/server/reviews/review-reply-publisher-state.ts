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
 * Google annote une réponse publiée avec sa traduction automatique : le texte relu
 * devient `{réponse}\n\n(Translated by Google)\n…`, ou `…\n\n(Original)\n{réponse}`.
 * Sans cette tolérance, une réponse bien arrivée se lit comme une divergence et
 * bloque la proposition en `conflict` (incident Hermes du 2026-09-26).
 */
export function remoteReplyMatches(expected: string, actual: string | null): boolean {
	return (
		actual === expected ||
		actual?.startsWith(`${expected}\n\n(Translated by Google)\n`) === true ||
		actual?.endsWith(`\n\n(Original)\n${expected}`) === true
	);
}

/**
 * Décide le seul prochain geste autorisé à partir d'une relecture distante.
 * Une réponse Google existante n'est jamais écrasée : identique (traduction Google
 * tolérée) = preuve de succès, différente = divergence terminale, absente = seul cas
 * qui autorise le PUT.
 */
export function decideReviewReplyPublication(input: {
	proposal: ReviewReplyProposalSnapshot;
	remote: RemoteReviewSnapshot;
}): ReviewReplyPublicationDecision {
	if (input.remote.kind === 'missing') return { action: 'conflict', reason: 'review_missing' };
	if (input.remote.replyText === null) return { action: 'put' };
	return remoteReplyMatches(input.proposal.replyText, input.remote.replyText)
		? { action: 'verified', reason: 'remote_reply_matches' }
		: { action: 'conflict', reason: 'remote_reply_differs' };
}
