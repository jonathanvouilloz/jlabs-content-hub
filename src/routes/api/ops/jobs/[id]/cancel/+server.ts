import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { cancelJob, getJobDetail } from '$lib/server/jobs-claim.js';
import { canCancelJob } from '$lib/server/job-console.js';

/**
 * JOB-007 — Annulation d'un job depuis la console.
 *
 * Namespace `/api/ops/…` volontaire : `/api/jobs/[id]` sert les `ai_jobs` legacy,
 * et la décision « `ai_jobs → jobs` écarté » tient — les deux files ne se
 * confondent pas, leurs URL non plus.
 *
 * Le corps de la requête n'accepte QU'UNE raison. Ni payload, ni type, ni
 * priorité, ni `max_attempts` : « aucune opération ne permet de modifier
 * arbitrairement le payload » est tenu par l'absence de chemin, pas par un filtre.
 * L'acteur vient de la SESSION, jamais du client.
 */
export const POST = async ({ params, request, locals }: RequestEvent) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const jobId = params.id!;
	const job = await getJobDetail({ db, jobId });
	if (!job) return json({ error: 'Job introuvable' }, { status: 404 });

	if (!canCancelJob(job.status)) {
		return json(
			{ error: `Un job « ${job.status} » ne s'annule pas.`, status: job.status },
			{ status: 409 }
		);
	}

	const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
	const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
	if (!reason) return json({ error: 'Une raison est requise.' }, { status: 400 });

	const result = await cancelJob({
		db,
		jobId,
		actor: `user:${locals.user.email}`,
		reason
	});

	// `null` = le job a changé d'état entre la lecture et l'écriture (un worker l'a
	// réclamé, conclu…). On ne réessaie pas à l'aveugle : l'opérateur relit l'état.
	if (!result) {
		return json({ error: 'Annulation refusée — le job a changé d’état.' }, { status: 409 });
	}

	return json({ ok: true, ...result });
};
