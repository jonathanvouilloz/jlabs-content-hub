import { json } from '@sveltejs/kit';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { AgentReviewApiError } from '$lib/server/reviews/agent-review-service.js';
import { submitAgentMentionCandidates } from '$lib/server/reviews/agent-mention-service.js';
import { AGENT_MATCH_KINDS, type AgentMatchKind } from '$lib/server/reviews/mention-resolution-state.js';
import { agentReviewError, requireIdempotencyKey } from '$lib/server/reviews/agent-review-route.js';
import type { RequestHandler } from './$types.js';

/**
 * Mentions jugées par l'agent. Le hub valide d'office le match exact au roster du salon et
 * garde le reste en `candidate` (doute → décision humaine via `/mention-candidates/{id}/resolve`).
 * `candidates: []` est valide : avis analysé, personne de cité.
 */
export const POST: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'review:propose', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);
	try {
		const idempotencyKey = requireIdempotencyKey(event.request);
		const body = await event.request.json() as { candidates?: unknown };
		if (!Array.isArray(body.candidates) || body.candidates.length > 20) {
			throw new AgentReviewApiError(400, 'invalid_candidates');
		}
		const candidates = body.candidates.map((raw) => {
			if (!raw || typeof raw !== 'object') throw new AgentReviewApiError(400, 'invalid_candidate');
			const value = raw as Record<string, unknown>;
			if (typeof value.token !== 'string' || value.token.trim().length === 0 || value.token.length > 80) {
				throw new AgentReviewApiError(400, 'invalid_candidate_token');
			}
			if (!['positive', 'neutral', 'negative'].includes(String(value.sentiment))) {
				throw new AgentReviewApiError(400, 'invalid_candidate_sentiment');
			}
			if (typeof value.evidence !== 'string' || value.evidence.trim().length === 0 || value.evidence.length > 240) {
				throw new AgentReviewApiError(400, 'invalid_candidate_evidence');
			}
			if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) {
				throw new AgentReviewApiError(400, 'invalid_candidate_confidence');
			}
			if (value.employeeId != null && (typeof value.employeeId !== 'string' || value.employeeId.length > 64)) {
				throw new AgentReviewApiError(400, 'invalid_candidate_employee');
			}
			if (value.matchKind != null && !AGENT_MATCH_KINDS.includes(value.matchKind as AgentMatchKind)) {
				throw new AgentReviewApiError(400, 'invalid_candidate_match_kind');
			}
			return {
				token: value.token,
				sentiment: value.sentiment as 'positive' | 'neutral' | 'negative',
				evidence: value.evidence,
				confidence: value.confidence,
				rosterVersion: typeof value.rosterVersion === 'string' ? value.rosterVersion : null,
				employeeId: (value.employeeId as string | null | undefined) ?? null,
				matchKind: (value.matchKind as AgentMatchKind | null | undefined) ?? null
			};
		});
		const created = await submitAgentMentionCandidates({
			db,
			projectSlug: event.params.slug,
			reviewId: event.params.reviewId,
			idempotencyKey,
			actor: auth.credential.id,
			candidates
		});
		return json({ ok: true, data: { candidates: created } }, { status: 201 });
	} catch (error) {
		return agentReviewError(error);
	}
};
