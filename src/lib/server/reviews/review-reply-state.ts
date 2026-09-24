export const REVIEW_REPLY_STATES = [
	'drafted',
	'gated_pass',
	'held',
	'scheduled',
	'reserved',
	'write_unknown',
	'retry_eligible',
	'verified',
	'conflict',
	'cancelled',
	'failed'
] as const;

export type ReviewReplyState = (typeof REVIEW_REPLY_STATES)[number];

export type ReviewReplyTransition =
	| 'gated_pass'
	| 'held'
	| 'scheduled'
	| 'reserved'
	| 'write_unknown'
	| 'retry_eligible'
	| 'verified'
	| 'conflict'
	| 'cancelled'
	| 'failed';

export type ReviewReplyTransitionResult =
	| { allowed: true }
	| { allowed: false; reason: 'terminal_state' | 'invalid_transition' };

const TERMINAL_STATES = new Set<ReviewReplyState>(['verified', 'conflict', 'cancelled']);

const ALLOWED_TRANSITIONS: Record<ReviewReplyState, readonly ReviewReplyTransition[]> = {
	drafted: ['gated_pass', 'held', 'cancelled'],
	gated_pass: ['scheduled', 'cancelled'],
	held: ['cancelled'],
	scheduled: ['reserved', 'cancelled'],
	reserved: ['write_unknown', 'failed', 'cancelled'],
	write_unknown: ['verified', 'conflict', 'retry_eligible'],
	retry_eligible: ['reserved', 'cancelled'],
	verified: [],
	conflict: [],
	cancelled: [],
	failed: ['retry_eligible', 'cancelled']
};

/**
 * Etat déterministe d'un candidat de réponse Google.
 * Un résultat de PUT interrompu reste `write_unknown` tant qu'une relecture Google
 * ne confirme pas le résultat ; il ne peut pas être rejoué directement.
 */
export function transitionReviewReply(
	from: ReviewReplyState,
	to: ReviewReplyTransition
): ReviewReplyTransitionResult {
	if (TERMINAL_STATES.has(from)) return { allowed: false, reason: 'terminal_state' };
	return ALLOWED_TRANSITIONS[from].includes(to)
		? { allowed: true }
		: { allowed: false, reason: 'invalid_transition' };
}
