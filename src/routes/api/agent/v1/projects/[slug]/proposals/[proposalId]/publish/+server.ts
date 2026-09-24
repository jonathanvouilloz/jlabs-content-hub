import { json } from '@sveltejs/kit';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { publishAgentReviewReply } from '$lib/server/reviews/agent-review-service.js';
import {
	agentReviewError,
	createAgentGoogleReplyDeps,
	requireIdempotencyKey
} from '$lib/server/reviews/agent-review-route.js';
import type { RequestHandler } from './$types.js';

export const POST: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'review:publish', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);
	try {
		const idempotencyKey = requireIdempotencyKey(event.request);
		const remote = await createAgentGoogleReplyDeps({
			db,
			projectSlug: event.params.slug,
			proposalId: event.params.proposalId
		});
		const result = await publishAgentReviewReply({
			db,
			projectSlug: event.params.slug,
			proposalId: event.params.proposalId,
			idempotencyKey,
			...remote
		});
		return json({ ok: true, data: result });
	} catch (error) {
		return agentReviewError(error);
	}
};
