import { json } from '@sveltejs/kit';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { reconcileAgentReviewReply } from '$lib/server/reviews/agent-review-service.js';
import { agentReviewError, createAgentGoogleReplyDeps } from '$lib/server/reviews/agent-review-route.js';
import type { RequestHandler } from './$types.js';

/** Action GET-only cote Google : elle peut journaliser le resultat local, mais ne fait jamais de PUT. */
export const GET: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'review:publish', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);
	try {
		const remote = await createAgentGoogleReplyDeps({
			db,
			projectSlug: event.params.slug,
			proposalId: event.params.proposalId
		});
		const result = await reconcileAgentReviewReply({
			db,
			projectSlug: event.params.slug,
			proposalId: event.params.proposalId,
			loadRemote: remote.loadRemote
		});
		return json({ ok: true, data: result });
	} catch (error) {
		return agentReviewError(error);
	}
};
