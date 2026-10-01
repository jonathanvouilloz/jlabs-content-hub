import { json } from '@sveltejs/kit';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { getAgentRoster } from '$lib/server/reviews/agent-mention-service.js';
import { agentReviewError } from '$lib/server/reviews/agent-review-route.js';
import type { RequestHandler } from './$types.js';

/** Roster canonique courant : sa `version` est la `baseVersion` à renvoyer pour le modifier. */
export const GET: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'review:read', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);
	try {
		return json({ ok: true, data: await getAgentRoster({ db, projectSlug: event.params.slug }) });
	} catch (error) {
		return agentReviewError(error);
	}
};
