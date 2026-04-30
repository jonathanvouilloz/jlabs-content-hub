import { json } from '@sveltejs/kit';
import { getJob } from '$lib/server/ai/jobs.js';
import type { RequestEvent } from '@sveltejs/kit';

export const GET = async ({ params, locals }: RequestEvent) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const job = await getJob(params.id!);
	if (!job) return json({ error: 'Not found' }, { status: 404 });
	return json({ id: job.id, status: job.status, result: job.result, error: job.error });
};
