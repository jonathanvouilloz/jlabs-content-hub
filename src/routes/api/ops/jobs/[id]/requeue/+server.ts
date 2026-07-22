import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { getJobDetail, requeueDeadJob } from '$lib/server/jobs-claim.js';
import { canRequeueJob } from '$lib/server/job-console.js';

/**
 * JOB-007 — Reprise d'un job depuis la dead-letter, côté interface.
 *
 * Appelle EXACTEMENT la fonction du CLI (`requeueDeadJob`), comme le commentaire
 * de `scripts/jobs-requeue.ts` l'annonçait : deux portes, une seule mécanique —
 * `attempts` repart à zéro, le journal `job_attempts` conserve tout, et la reprise
 * y écrit sa propre ligne (qui, quand, pourquoi).
 *
 * Une cause `auth`/`permanent` non corrigée re-tombera à l'identique. Comme le
 * CLI, on le DIT (le champ `warning` de la réponse) sans l'interdire : c'est
 * l'humain qui sait si la cause est levée.
 */
export const POST = async ({ params, request, locals }: RequestEvent) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const jobId = params.id!;
	const job = await getJobDetail({ db, jobId });
	if (!job) return json({ error: 'Job introuvable' }, { status: 404 });

	if (!canRequeueJob(job.status)) {
		return json(
			{ error: `Un job « ${job.status} » n'est pas en dead-letter — rien à reprendre.` },
			{ status: 409 }
		);
	}

	const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
	const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
	if (!reason) return json({ error: 'Une raison est requise.' }, { status: 400 });

	const result = await requeueDeadJob({
		db,
		jobId,
		actor: `user:${locals.user.email}`,
		reason
	});

	if (!result) {
		return json({ error: 'Reprise refusée — le job a changé d’état.' }, { status: 409 });
	}

	return json({
		ok: true,
		...result,
		warning:
			job.errorClass === 'auth' || job.errorClass === 'permanent'
				? `Cause « ${job.errorClass} » : la reprise échouera à l'identique si le token, la ` +
					`permission ou la configuration n'ont pas été corrigés entre-temps.`
				: null
	});
};
