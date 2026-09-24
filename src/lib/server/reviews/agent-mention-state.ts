import { normalizeRosterToken } from './employee-mentions-state.js';

export function buildAgentMentionCandidate(input: {
	token: string;
	sentiment: 'positive' | 'neutral' | 'negative';
	evidence: string;
	confidence: number;
	rosterVersion?: string | null;
}) {
	return {
		detectedToken: input.token.trim(),
		normalizedToken: normalizeRosterToken(input.token),
		sentiment: input.sentiment,
		evidence: input.evidence.trim(),
		confidence: input.confidence,
		rosterVersion: input.rosterVersion ?? null,
		status: 'candidate' as const
	};
}
