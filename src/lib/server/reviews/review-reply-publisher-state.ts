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

/**
 * Délai pendant lequel une réponse acceptée par Google (PUT 2xx) peut encore être
 * invisible en relecture. Mesuré le 2026-09-28 : les trois réponses de Jonction étaient
 * absentes à T+0 s et T+1 s, présentes plus tard avec `updateTime` = heure du PUT.
 */
export const REVIEW_REPLY_SETTLE_MS = 15 * 60 * 1000;

/** Relectures après un PUT : 0 s, puis 2, 4 et 8 s (≈ 14 s au pire, sous le plafond Vercel). */
export const REVIEW_REPLY_VERIFY_DELAYS_MS = [0, 2_000, 4_000, 8_000] as const;

export type ReviewReplyReconciliation =
	| { action: 'verified' }
	| { action: 'conflict'; reason: 'remote_reply_differs' | 'review_missing' }
	| { action: 'pending'; retryAfterSeconds: number }
	| { action: 'retry_eligible' };

/**
 * Relecture en lecture seule d'une proposition `write_unknown` ou `retry_eligible`.
 * Une absence ne rouvre le retry que si aucun PUT n'a été accepté par Google, ou si
 * la fenêtre de propagation est écoulée : sinon la réponse est probablement déjà en
 * ligne et un « retry sûr » serait une affirmation fausse.
 */
export function decideReviewReplyReconciliation(input: {
	proposal: ReviewReplyProposalSnapshot;
	remote: RemoteReviewSnapshot;
	putAcceptedAtMs: number | null;
	nowMs: number;
	settleMs?: number;
}): ReviewReplyReconciliation {
	const decision = decideReviewReplyPublication({ proposal: input.proposal, remote: input.remote });
	if (decision.action === 'verified') return { action: 'verified' };
	if (decision.action === 'conflict') {
		return { action: 'conflict', reason: decision.reason === 'review_missing' ? 'review_missing' : 'remote_reply_differs' };
	}
	const settleMs = input.settleMs ?? REVIEW_REPLY_SETTLE_MS;
	if (input.putAcceptedAtMs !== null) {
		// Heure d'acceptation illisible : on ne peut pas prouver la fin de la fenêtre.
		if (Number.isNaN(input.putAcceptedAtMs)) return { action: 'pending', retryAfterSeconds: Math.ceil(settleMs / 1000) };
		const remaining = input.putAcceptedAtMs + settleMs - input.nowMs;
		if (remaining > 0) return { action: 'pending', retryAfterSeconds: Math.ceil(remaining / 1000) };
	}
	return { action: 'retry_eligible' };
}
