import { json } from '@sveltejs/kit';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { decodeReviewCursor } from '$lib/server/reviews/agent-review-state.js';
import { listAgentReviews } from '$lib/server/reviews/agent-review-service.js';
import { agentReviewError } from '$lib/server/reviews/agent-review-route.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'review:read', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);
	const rawLimit = event.url.searchParams.get('limit');
	const limit = rawLimit === null ? 50 : Number(rawLimit);
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		return json({ ok: false, error: 'invalid_limit' }, { status: 400 });
	}
	const rawCursor = event.url.searchParams.get('cursor');
	const cursor = decodeReviewCursor(rawCursor);
	if (rawCursor && !cursor) return json({ ok: false, error: 'invalid_cursor' }, { status: 400 });
	try {
		return json({ ok: true, ...(await listAgentReviews({
			db,
			projectSlug: event.params.slug,
			limit,
			cursor
		})) });
	} catch (error) {
		return agentReviewError(error);
	}
};
