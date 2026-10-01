import { json } from '@sveltejs/kit';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { AgentReviewApiError } from '$lib/server/reviews/agent-review-service.js';
import { resolveAgentMentionCandidate } from '$lib/server/reviews/agent-mention-service.js';
import { agentReviewError, requireIdempotencyKey } from '$lib/server/reviews/agent-review-route.js';
import type { RequestHandler } from './$types.js';

/**
 * Décision humaine relayée par l'agent : valider (vers `employeeId` ou la suggestion),
 * retenir l'orthographe comme alias, ou rejeter. Une décision posée ne se réécrit pas.
 */
export const POST: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'review:mention:resolve', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);
	try {
		const idempotencyKey = requireIdempotencyKey(event.request);
		const body = await event.request.json() as { decision?: unknown; employeeId?: unknown; rememberAlias?: unknown; note?: unknown };
		if (body.decision !== 'validate' && body.decision !== 'reject') throw new AgentReviewApiError(400, 'invalid_decision');
		if (body.employeeId != null && (typeof body.employeeId !== 'string' || body.employeeId.length > 64)) {
			throw new AgentReviewApiError(400, 'invalid_employee');
		}
		if (body.rememberAlias !== undefined && typeof body.rememberAlias !== 'boolean') {
			throw new AgentReviewApiError(400, 'invalid_remember_alias');
		}
		if (body.note != null && (typeof body.note !== 'string' || body.note.length > 240)) {
			throw new AgentReviewApiError(400, 'invalid_note');
		}
		const result = await resolveAgentMentionCandidate({
			db,
			projectSlug: event.params.slug,
			candidateId: event.params.candidateId,
			idempotencyKey,
			actor: auth.credential.id,
			decision: body.decision,
			employeeId: (body.employeeId as string | null | undefined) ?? null,
			rememberAlias: body.rememberAlias === true,
			note: (body.note as string | null | undefined) ?? null
		});
		return json({ ok: true, data: result });
	} catch (error) {
		return agentReviewError(error);
	}
};
