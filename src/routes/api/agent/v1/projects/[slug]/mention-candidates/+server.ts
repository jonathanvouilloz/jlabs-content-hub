import { json } from '@sveltejs/kit';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { AgentReviewApiError } from '$lib/server/reviews/agent-review-service.js';
import { listAgentMentionCandidates } from '$lib/server/reviews/agent-mention-service.js';
import { agentReviewError } from '$lib/server/reviews/agent-review-route.js';
import type { RequestHandler } from './$types.js';

const STATUSES = ['candidate', 'validated', 'rejected', 'resolved'] as const;

/** Mentions par statut ; `candidate` (défaut) = celles qui attendent une décision humaine. */
export const GET: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'review:read', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);
	try {
		const status = event.url.searchParams.get('status') ?? 'candidate';
		if (!STATUSES.includes(status as (typeof STATUSES)[number])) throw new AgentReviewApiError(400, 'invalid_status');
		const limit = Number(event.url.searchParams.get('limit') ?? 100);
		const candidates = await listAgentMentionCandidates({
			db,
			projectSlug: event.params.slug,
			status: status as (typeof STATUSES)[number],
			limit: Number.isFinite(limit) ? limit : 100
		});
		return json({ ok: true, data: { candidates } });
	} catch (error) {
		return agentReviewError(error);
	}
};
