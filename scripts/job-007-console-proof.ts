/**
 * JOB-007 — Preuve de la console d'exploitation (sur Neon).
 *
 * Ce test ne peut pas vivre dans vitest : ce qu'il vérifie, c'est le comportement
 * du MOTEUR — un `UPDATE` gardé par `lease_owner` qui cesse de matcher, une
 * transaction qui écrit job + journal ensemble, un `FOR UPDATE` qui sérialise. Les
 * règles pures (filtres, légalité, verdicts) sont couvertes par
 * `src/lib/server/job-console.test.ts` ; ici on prouve la mécanique.
 *
 * Les 3 acceptations du BACKLOG, prouvées en base :
 *   1. « un opérateur peut comprendre un échec sans lire directement la DB » : la
 *      console lit ce que le CLI lit — `listJobs`/`getJobDetail`/`listJobAttempts`
 *      rendent exactement l'état, y compris la cause classée ;
 *   2. « retry et annulation sont audités » : chaque action laisse une ligne
 *      nominative au journal (acteur + raison), et rien n'est effacé ;
 *   3. « aucune opération ne permet de modifier arbitrairement le payload » :
 *      après annulation ET reprise, `payload_json` est bit à bit inchangé.
 * Plus : un job EN COURS s'annule sans tuer le worker — celui-ci perd son bail et
 * ne peut plus rien réécrire (c'est le mécanisme de JOB-002, pas une voie parallèle).
 *
 * Écriture bornée à ses propres lignes (type dédié + clés préfixées), nettoyage
 * ENFANTS D'ABORD dans un `finally`. Lancer :
 *   npx tsx scripts/job-007-console-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	cancelJob,
	claimJob,
	completeJob,
	countJobs,
	countJobsByStatus,
	failJob,
	getJobDetail,
	listJobs,
	requeueDeadJob
} from '../src/lib/server/jobs-claim.js';
import { listJobAttempts, renewLease, startAttempt } from '../src/lib/server/jobs-lease.js';
import { deriveWorkerId } from '../src/lib/server/job-state.js';
import { canCancelJob, explainFailure, normalizeJobFilters } from '../src/lib/server/job-console.js';
import { createId } from '../src/lib/server/utils.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

/**
 * Marqueur exclusif de ce test, cloisonné PAR BLOC (`__test_console:<label>`) : la
 * file sert par priorité puis ancienneté, donc un type partagé ferait réclamer à
 * un bloc le job d'un autre — la preuve mesurerait alors autre chose.
 */
const TEST_TYPE = '__test_console';
const typeFor = (label: string) => `${TEST_TYPE}:${label}`;
const KEY_PREFIX = `${TEST_TYPE}:${createId()}:`;

/** Payload témoin : il doit ressortir IDENTIQUE de toutes les actions d'exploitation. */
const PAYLOAD = JSON.stringify({ weeks: 8, canary: 'ne-doit-jamais-changer' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

const ACTOR = 'user:proof@jonlabs.ch';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}

async function pickProjectId(): Promise<string> {
	const rows = await db.select({ id: schema.projects.id }).from(schema.projects).limit(1);
	if (rows.length === 0) throw new Error('Aucun projet en base : impossible de créer un job de test.');
	return rows[0].id;
}

let seq = 0;
async function seedJob(
	projectId: string,
	label: string,
	opts: { status?: string; errorClass?: string; errorCode?: string } = {}
): Promise<string> {
	const id = createId();
	await db.insert(schema.jobs).values({
		id,
		projectId,
		type: typeFor(label),
		idempotencyKey: `${KEY_PREFIX}${label}-${seq++}`,
		priority: 10,
		maxAttempts: 5,
		payloadJson: PAYLOAD,
		availableAt: toDbTimestamp(new Date())
	});
	if (opts.status) {
		await db.execute(sql`
			UPDATE "seostats"."jobs"
			   SET status = ${opts.status},
			       last_error_class = ${opts.errorClass ?? null},
			       last_error_code = ${opts.errorCode ?? null},
			       finished_at = ${toDbTimestamp(new Date())}
			 WHERE id = ${id}
		`);
	}
	return id;
}

interface JobSnapshot {
	status: string;
	attempts: number;
	lease_owner: string | null;
	lease_until: string | null;
	finished_at: string | null;
	payload_json: string | null;
}

async function jobRow(jobId: string): Promise<JobSnapshot> {
	const res = await db.execute(sql`
		SELECT status, attempts, lease_owner, lease_until, finished_at, payload_json
		  FROM "seostats"."jobs" WHERE id = ${jobId}
	`);
	return (res.rows ?? [])[0] as never;
}

/** Nettoyage ENFANTS D'ABORD : supprimer les jobs seuls violerait `job_attempts_job_id_fkey`. */
async function cleanup(): Promise<{ jobs: number; attempts: number }> {
	const ids = await db.execute(sql`
		SELECT id FROM "seostats"."jobs" WHERE idempotency_key LIKE ${`${KEY_PREFIX}%`}
	`);
	const jobIds = ((ids.rows ?? []) as unknown as { id: string }[]).map((r) => r.id);
	if (jobIds.length === 0) return { jobs: 0, attempts: 0 };

	const inJobs = sql.join(
		jobIds.map((i) => sql`${i}`),
		sql`, `
	);
	const att = await db.execute(
		sql`DELETE FROM "seostats"."job_attempts" WHERE job_id IN (${inJobs}) RETURNING id`
	);
	await db.execute(sql`DELETE FROM "seostats"."job_effects" WHERE job_id IN (${inJobs})`);
	const jbs = await db.execute(sql`DELETE FROM "seostats"."jobs" WHERE id IN (${inJobs}) RETURNING id`);
	return { jobs: jbs.rows?.length ?? 0, attempts: att.rows?.length ?? 0 };
}

async function main() {
	console.log('\n=== JOB-007 — console d’exploitation (sur Neon) ===\n');
	const projectId = await pickProjectId();

	try {
		// ── 1. Annuler un job EN FILE ────────────────────────────────
		console.log('1. Annulation d’un job en file (acceptation 2) :');
		const queuedJob = await seedJob(projectId, 'queued');
		const cancelled = await cancelJob({
			db,
			jobId: queuedJob,
			actor: ACTOR,
			reason: 'plus nécessaire'
		});
		check('l’annulation aboutit', cancelled !== null);
		check('elle sait d’où elle vient', cancelled?.previousStatus === 'queued', cancelled?.previousStatus ?? '∅');
		check('aucune tentative ouverte à clore', cancelled?.closedOpenAttempt === false);

		const queuedRow = await jobRow(queuedJob);
		check('le job est annulé', queuedRow.status === 'cancelled', queuedRow.status);
		check('il porte une date de fin', queuedRow.finished_at !== null);
		check('le payload est INTACT (acceptation 3)', queuedRow.payload_json === PAYLOAD);

		const queuedTrail = await listJobAttempts({ db, jobId: queuedJob });
		check('une seule ligne au journal', queuedTrail.length === 1, `${queuedTrail.length}`);
		check('elle nomme son auteur', queuedTrail[0]?.workerId === ACTOR, queuedTrail[0]?.workerId ?? '∅');
		check(
			'elle porte la raison',
			(queuedTrail[0]?.metadataJson ?? '').includes('plus nécessaire')
		);

		// ── 2. Annuler un job EN COURS ───────────────────────────────
		console.log('\n2. Annulation d’un job EN COURS — le worker perd son bail :');
		const runningJob = await seedJob(projectId, 'running');
		const workerId = deriveWorkerId({ host: 'proof7', pid: process.pid, nonce: 'w1' });
		const claimed = await claimJob({ db, types: [typeFor('running')], workerId, leaseMs: 300_000 });
		check('le worker a bien réclamé le job', claimed?.id === runningJob);

		// Le worker ouvre son journal, comme le fait `runWorker`.
		await startAttempt({
			db,
			jobId: runningJob,
			projectId,
			attemptNo: claimed!.attempts,
			workerId
		});

		const cancelledRunning = await cancelJob({
			db,
			jobId: runningJob,
			actor: ACTOR,
			reason: 'job parti sur un provider bloqué'
		});
		check('l’annulation aboutit', cancelledRunning !== null);
		check('elle sait que le job tournait', cancelledRunning?.wasRunning === true);
		check('elle a clos la tentative ouverte', cancelledRunning?.closedOpenAttempt === true);

		// C'est ICI que se joue « on n'a tué personne » : le worker est vivant, mais
		// aucune de ses écritures ne matche plus.
		const renewed = await renewLease({ db, jobId: runningJob, workerId, leaseMs: 300_000 });
		check('le worker ne peut plus renouveler son bail', renewed === null);
		const completed = await completeJob({ db, jobId: runningJob, workerId });
		check('il ne peut plus conclure le job en succès', completed === false);
		const failed = await failJob({
			db,
			job: { id: runningJob, attempts: 1, maxAttempts: 5 },
			workerId,
			error: { status: 500, message: 'trop tard' }
		});
		check('il ne peut plus écrire d’échec non plus', failed === null);

		const runningRow = await jobRow(runningJob);
		check('le job reste annulé', runningRow.status === 'cancelled', runningRow.status);
		check('son bail est libéré', runningRow.lease_owner === null);
		check('le payload est INTACT (acceptation 3)', runningRow.payload_json === PAYLOAD);

		const runningTrail = await listJobAttempts({ db, jobId: runningJob });
		const workerLine = runningTrail.find((a) => a.workerId === workerId);
		const operatorLine = runningTrail.find((a) => a.workerId === ACTOR);
		check('deux lignes : celle du worker et celle de l’opérateur', runningTrail.length === 2, `${runningTrail.length}`);
		check('la tentative du worker est close', workerLine?.outcome === 'cancelled', workerLine?.outcome ?? '∅');
		check('plus aucune tentative « running » ne traîne', !runningTrail.some((a) => a.outcome === 'running'));
		check('la décision porte la raison de l’opérateur', (operatorLine?.metadataJson ?? '').includes('provider bloqué'));

		// ── 3. Ce qui ne s'annule pas ────────────────────────────────
		console.log('\n3. Ce qui ne s’annule PAS :');
		const doneJob = await seedJob(projectId, 'done', { status: 'succeeded' });
		check('la règle refuse un job réussi', canCancelJob('succeeded') === false);
		const refused = await cancelJob({ db, jobId: doneJob, actor: ACTOR, reason: 'tentative' });
		check('la fonction refuse aussi (défense en profondeur)', refused === null);
		const doneRow = await jobRow(doneJob);
		check('son statut n’a pas bougé', doneRow.status === 'succeeded', doneRow.status);
		const doneTrail = await listJobAttempts({ db, jobId: doneJob });
		check('RIEN n’a été tracé pour un refus', doneTrail.length === 0, `${doneTrail.length}`);

		const reCancel = await cancelJob({ db, jobId: queuedJob, actor: ACTOR, reason: 'deux fois' });
		check('un job déjà annulé ne se réannule pas', reCancel === null);

		// ── 4. Reprise depuis la dead-letter, via la même fonction ───
		console.log('\n4. Reprise depuis la dead-letter (acceptation 2) :');
		const deadJob = await seedJob(projectId, 'dead', {
			status: 'dead',
			errorClass: 'auth',
			errorCode: 'invalid_grant'
		});
		const detailBefore = await getJobDetail({ db, jobId: deadJob });
		check('le détail rend la cause classée', detailBefore?.errorClass === 'auth', detailBefore?.errorClass ?? '∅');

		// Acceptation 1 : la cause devient un verdict, sans lire la DB.
		const verdict = explainFailure({
			status: detailBefore!.status,
			errorClass: detailBefore!.errorClass,
			errorCode: detailBefore!.errorCode,
			attempts: detailBefore!.attempts,
			maxAttempts: detailBefore!.maxAttempts,
			deferrals: detailBefore!.deferrals,
			requeuedCount: detailBefore!.requeuedCount
		});
		check('un verdict lisible en est tiré', verdict !== null);
		check('il prévient que la cause doit être corrigée', verdict?.willRepeat === true);

		const requeued = await requeueDeadJob({
			db,
			jobId: deadJob,
			actor: ACTOR,
			reason: 'consentement Google renouvelé'
		});
		check('la reprise aboutit', requeued !== null);
		const deadRow = await jobRow(deadJob);
		check('le job repart en file', deadRow.status === 'queued', deadRow.status);
		check('le payload est INTACT (acceptation 3)', deadRow.payload_json === PAYLOAD);
		const deadTrail = await listJobAttempts({ db, jobId: deadJob });
		check('la reprise est journalisée', deadTrail.some((a) => a.outcome === 'requeued'));
		check('elle nomme son auteur', deadTrail.some((a) => a.workerId === ACTOR));

		// Puis on l'annule : un job repris redevient annulable, la chaîne complète tient.
		const afterRequeueCancel = await cancelJob({
			db,
			jobId: deadJob,
			actor: ACTOR,
			reason: 'finalement inutile'
		});
		check('un job repris s’annule ensuite', afterRequeueCancel !== null);
		const finalTrail = await listJobAttempts({ db, jobId: deadJob });
		check(
			'le journal est APPEND-ONLY : rien n’a été effacé',
			finalTrail.length === deadTrail.length + 1,
			`${deadTrail.length} → ${finalTrail.length}`
		);

		// ── 5. Ce que la console lit ─────────────────────────────────
		console.log('\n5. Lecture de la file (acceptation 1) :');
		const mine = await listJobs({ db, type: typeFor('running'), limit: 50 });
		check('la file se filtre par type', mine.length === 1 && mine[0].id === runningJob, `${mine.length} ligne(s)`);
		check('elle porte le projet, pas seulement son id', Boolean(mine[0]?.projectSlug));

		const cancelledOnly = await listJobs({ db, statuses: ['cancelled'], type: typeFor('running') });
		check('elle se filtre par statut', cancelledOnly.length === 1);
		const deadOnly = await listJobs({ db, statuses: ['dead'], type: typeFor('running') });
		check('un filtre qui ne matche pas rend une liste vide, pas tout', deadOnly.length === 0);

		const total = await countJobs({ db, type: typeFor('running') });
		check('le total suit les MÊMES filtres que la liste', total === mine.length, `${total}`);

		const byStatus = await countJobsByStatus({ db });
		check('les compteurs par statut sont peuplés', Object.keys(byStatus).length > 0, JSON.stringify(byStatus));

		// Un filtre inventé n'atteint jamais la requête : il est écarté en amont.
		const hostile = normalizeJobFilters({ status: "dead'; DROP TABLE jobs;--" });
		check('un statut hostile est écarté avant la requête', hostile.statuses.length === 0);
		const hostileList = await listJobs({ db, statuses: hostile.statuses, type: typeFor('running') });
		check('la requête tourne quand même, sans filtre', hostileList.length === 1);

		// ── Verdict ──────────────────────────────────────────────────
		console.log(
			failures === 0
				? '\n✅ Toutes les vérifications sont vertes.\n'
				: `\n❌ ${failures} vérification(s) en échec.\n`
		);
	} finally {
		const cleaned = await cleanup();
		console.log(`Nettoyage : ${cleaned.jobs} job(s), ${cleaned.attempts} tentative(s) supprimés.\n`);
		await pool.end();
	}

	if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
	console.error('Preuve en erreur:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
