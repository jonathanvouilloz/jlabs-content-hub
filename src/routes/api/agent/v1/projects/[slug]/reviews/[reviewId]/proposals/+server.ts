import { json } from '@sveltejs/kit';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { AgentReviewApiError, proposeAgentReviewReply } from '$lib/server/reviews/agent-review-service.js';
import { agentReviewError, requireIdempotencyKey } from '$lib/server/reviews/agent-review-route.js';
import type { RequestHandler } from './$types.js';

export const POST: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'review:propose', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);
	try {
		const idempotencyKey = requireIdempotencyKey(event.request);
		const body = await event.request.json() as Record<string, unknown>;
		if (typeof body.reviewSnapshot !== 'string' || !/^[a-f0-9]{64}$/.test(body.reviewSnapshot)) {
			throw new AgentReviewApiError(400, 'invalid_review_snapshot');
		}
		if (typeof body.replyText !== 'string' || body.replyText.trim().length === 0 || body.replyText.length > 2_000) {
			throw new AgentReviewApiError(400, 'invalid_reply_text');
		}
		const language = typeof body.language === 'string' ? body.language.trim() : 'fr';
		if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) throw new AgentReviewApiError(400, 'invalid_language');
		const result = await proposeAgentReviewReply({
			db,
			projectSlug: event.params.slug,
			reviewId: event.params.reviewId,
			reviewSnapshot: body.reviewSnapshot,
			replyText: body.replyText,
			language,
			idempotencyKey,
			actor: auth.credential.id
		});
		return json({
			ok: true,
			data: {
				proposalId: result.proposal.id,
				state: result.proposal.state,
				gateStatus: result.proposal.gateStatus,
				gateReasons: JSON.parse(result.proposal.gateReasonsJson),
				proposalHash: result.proposal.proposalHash,
				idempotent: result.idempotent
			}
		}, { status: result.idempotent ? 200 : 201 });
	} catch (error) {
		return agentReviewError(error);
	}
};
