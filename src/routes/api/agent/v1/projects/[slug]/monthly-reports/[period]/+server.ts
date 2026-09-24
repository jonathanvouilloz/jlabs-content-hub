import { json } from '@sveltejs/kit';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { buildAgentMonthlyReviewReport } from '$lib/server/reviews/agent-review-service.js';
import { agentReviewError } from '$lib/server/reviews/agent-review-route.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'review:report:read', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);
	try {
		return json({ ok: true, data: await buildAgentMonthlyReviewReport({
			db,
			projectSlug: event.params.slug,
			period: event.params.period
		}) });
	} catch (error) {
		return agentReviewError(error);
	}
};
