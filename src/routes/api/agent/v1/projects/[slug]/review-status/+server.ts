import { json } from '@sveltejs/kit';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { buildAgentReviewStatus } from '$lib/server/reviews/agent-review-service.js';
import { reviewStatusEtag } from '$lib/server/reviews/agent-review-status-state.js';
import { agentReviewError } from '$lib/server/reviews/agent-review-route.js';
import type { RequestHandler } from './$types.js';

/**
 * GMB-011 — Résumé lecture seule pour les questions rapides. Jamais une autorité :
 * une mutation relit toujours `GET /reviews` et suit `decision.status`.
 */
export const GET: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'review:read', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);
	try {
		const data = await buildAgentReviewStatus({ db, projectSlug: event.params.slug });
		const etag = reviewStatusEtag(data);
		const headers = { ETag: etag, 'Cache-Control': 'private, max-age=30' };
		if (event.request.headers.get('if-none-match') === etag) {
			return new Response(null, { status: 304, headers });
		}
		return json({ ok: true, data }, { headers });
	} catch (error) {
		return agentReviewError(error);
	}
};
