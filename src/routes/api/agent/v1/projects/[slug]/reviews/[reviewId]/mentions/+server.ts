import { json } from '@sveltejs/kit';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { AgentReviewApiError, submitAgentMentionCandidates } from '$lib/server/reviews/agent-review-service.js';
import { agentReviewError, requireIdempotencyKey } from '$lib/server/reviews/agent-review-route.js';
import type { RequestHandler } from './$types.js';

export const POST: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'review:propose', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);
	try {
		const idempotencyKey = requireIdempotencyKey(event.request);
		const body = await event.request.json() as { candidates?: unknown };
		if (!Array.isArray(body.candidates) || body.candidates.length < 1 || body.candidates.length > 20) {
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
			return {
				token: value.token,
				sentiment: value.sentiment as 'positive' | 'neutral' | 'negative',
				evidence: value.evidence,
				confidence: value.confidence,
				rosterVersion: typeof value.rosterVersion === 'string' ? value.rosterVersion : null
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
