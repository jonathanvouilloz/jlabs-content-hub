import { json } from '@sveltejs/kit';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { AgentReviewApiError } from '$lib/server/reviews/agent-review-service.js';
import { applyAgentRosterChanges } from '$lib/server/reviews/agent-mention-service.js';
import { parseRosterChanges } from '$lib/server/reviews/mention-resolution-state.js';
import { agentReviewError, requireIdempotencyKey } from '$lib/server/reviews/agent-review-route.js';
import type { RequestHandler } from './$types.js';

/**
 * Modifie le roster : nouvelle projection hashée, l'ancienne passe `stale`. Tout ou rien,
 * `baseVersion` obligatoire (409 `roster_version_conflict` si quelqu'un est passé avant).
 */
export const POST: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'roster:write', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);
	try {
		const idempotencyKey = requireIdempotencyKey(event.request);
		const body = await event.request.json() as { baseVersion?: unknown; reason?: unknown; changes?: unknown };
		if (typeof body.baseVersion !== 'string' || body.baseVersion.trim() === '') {
			throw new AgentReviewApiError(400, 'base_version_required');
		}
		if (typeof body.reason !== 'string' || body.reason.trim() === '' || body.reason.length > 240) {
			throw new AgentReviewApiError(400, 'reason_required');
		}
		const parsed = parseRosterChanges(body.changes);
		if (!parsed.ok) throw new AgentReviewApiError(400, parsed.code);
		const result = await applyAgentRosterChanges({
			db,
			projectSlug: event.params.slug,
			idempotencyKey,
			actor: auth.credential.id,
			baseVersion: body.baseVersion,
			reason: body.reason.trim(),
			changes: parsed.changes
		});
		return json({ ok: true, data: result }, { status: result.changed && !result.idempotent ? 201 : 200 });
	} catch (error) {
		return agentReviewError(error);
	}
};
