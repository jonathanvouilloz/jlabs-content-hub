import { and, eq } from 'drizzle-orm';
import { json } from '@sveltejs/kit';
import type { AppDb } from '../db/types.js';
import { projects, reviewReplyProposals } from '../db/schema.js';
import { getGmbAccessToken, getGmbAccountId } from '../gmb-auth.js';
import { readGoogleReviewReply, putGoogleReviewReply } from './gmb-review-reply-api.js';
import { AgentReviewApiError } from './agent-review-service.js';

export function agentReviewError(error: unknown): Response {
	if (error instanceof AgentReviewApiError) {
		return json({ ok: false, error: error.code }, { status: error.status });
	}
	if (error instanceof SyntaxError) return json({ ok: false, error: 'invalid_json' }, { status: 400 });
	console.error('agent_review_api_error', error);
	return json({ ok: false, error: 'internal_error' }, { status: 500 });
}

export function requireIdempotencyKey(request: Request): string {
	const value = request.headers.get('idempotency-key')?.trim() ?? '';
	if (value.length < 8 || value.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
		throw new AgentReviewApiError(400, 'invalid_idempotency_key');
	}
	return value;
}

export async function createAgentGoogleReplyDeps(input: {
	db: AppDb;
	projectSlug: string;
	proposalId: string;
}) {
	const [row] = await input.db
		.select({ proposal: reviewReplyProposals })
		.from(reviewReplyProposals)
		.innerJoin(projects, eq(projects.id, reviewReplyProposals.projectId))
		.where(and(eq(projects.slug, input.projectSlug), eq(reviewReplyProposals.id, input.proposalId)))
		.limit(1);
	if (!row) throw new AgentReviewApiError(404, 'proposal_not_found');

	let authPromise: Promise<{ accessToken: string; accountId: string }> | null = null;
	const auth = () => {
		authPromise ??= Promise.all([
			getGmbAccessToken(input.db),
			getGmbAccountId(input.db)
		]).then(([accessToken, accountId]) => ({ accessToken, accountId }));
		return authPromise;
	};
	const request = async () => {
		const credentials = await auth();
		return {
			...credentials,
			locationId: row.proposal.locationId,
			reviewId: row.proposal.reviewId
		};
	};
	return {
		loadRemote: async () => readGoogleReviewReply(await request()),
		putReply: async (replyText: string) => putGoogleReviewReply(await request(), replyText)
	};
}
