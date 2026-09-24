import { json } from '@sveltejs/kit';
import { authorizeMachineProject, machineAuthError } from '$lib/server/api-auth.js';
import { db } from '$lib/server/db/index.js';
import { closeAgentMonthlyReviewReport } from '$lib/server/reviews/agent-review-service.js';
import { agentReviewError } from '$lib/server/reviews/agent-review-route.js';
import type { RequestHandler } from './$types.js';

export const POST: RequestHandler = async (event) => {
	const auth = authorizeMachineProject(event, 'review:propose', event.params.slug);
	if (!auth.ok) return machineAuthError(auth);
	try {
		const result = await closeAgentMonthlyReviewReport({
			db,
			projectSlug: event.params.slug,
			period: event.params.period,
			actor: auth.credential.id
		});
		return json({ ok: true, data: result }, { status: result.idempotent ? 200 : 201 });
	} catch (error) {
		return agentReviewError(error);
	}
};
