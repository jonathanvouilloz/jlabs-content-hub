import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { getJobDetail } from '$lib/server/jobs-claim.js';
import { listJobAttempts } from '$lib/server/jobs-lease.js';
import { canCancelJob, canRequeueJob, explainFailure } from '$lib/server/job-console.js';
import { toDbTimestamp } from '$lib/server/timestamps.js';

/**
 * JOB-007 — Un job, et TOUTE son histoire.
 *
 * La chronologie vient de `job_attempts`, jamais de `jobs.attempts` : ce compteur
 * est remis à zéro par `requeueDeadJob`, il ne raconte rien. C'est le journal
 * append-only qui porte « la #1 a été abandonnée, la #2 a réussi ».
 */
export const load: PageServerLoad = async ({ params }) => {
	const job = await getJobDetail({ db, jobId: params.id });
	if (!job) throw error(404, 'Job introuvable');

	const attempts = await listJobAttempts({ db, jobId: job.id });

	return {
		job,
		attempts,
		explanation: explainFailure({
			status: job.status,
			errorClass: job.errorClass,
			errorCode: job.errorCode,
			attempts: job.attempts,
			maxAttempts: job.maxAttempts,
			deferrals: job.deferrals,
			requeuedCount: job.requeuedCount
		}),
		// La légalité est décidée SERVEUR, comme dans les endpoints : l'interface
		// propose exactement ce que les gardes accepteront.
		canCancel: canCancelJob(job.status),
		canRequeue: canRequeueJob(job.status),
		now: toDbTimestamp(new Date())
	};
};
