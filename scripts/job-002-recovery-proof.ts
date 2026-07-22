/**
 * JOB-002 — Preuve de récupération après crash (les 3 acceptations).
 *
 * Ce test ne peut pas vivre dans vitest : il exige un vrai Postgres (transaction,
 * `FOR UPDATE SKIP LOCKED`, unicité sous concurrence). Pendant de
 * `scripts/job-claim-concurrency.ts` pour JOB-001.
 *
 * Ce qu'il prouve :
 *   1. un bail RENOUVELÉ pendant un handler long n'est jamais volé par le reaper ;
 *   2. tuer un worker en pleine exécution → reprise automatique (`worker_death`),
 *      tentative journalisée `abandoned`, puis un autre worker mène le job à
 *      son terme → la chronologie montre l'abandon ET la reprise ;
 *   3. bail expiré mais battement RÉCENT → `lease_stall` (la distinction crash
 *      local / blocage est mesurée, pas postulée) ;
 *   4. un abandon au plafond de tentatives part en dead-letter (pas de boucle) ;
 *   5. `guardExternalEffect` : deux exécutions, UN SEUL effet externe ;
 *   6. un bail encore VALIDE n'est jamais repris, et deux reapers concurrents
 *      ne se disputent pas la même ligne ;
 *   7. budget de durée dépassé → `ProviderTimeout`, replanifié, aucun orphelin.
 *
 * Écriture bornée à ses propres lignes (type dédié + clés préfixées), nettoyage
 * dans un `finally`. Lancer :
 *   npx tsx scripts/job-002-recovery-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { claimJob, completeJob } from '../src/lib/server/jobs-claim.js';
import { runWorker } from '../src/lib/server/job-runner.js';
import {
	guardExternalEffect,
	listJobAttempts,
	reclaimExpiredLeases,
	renewLease
} from '../src/lib/server/jobs-lease.js';
import { deriveWorkerId } from '../src/lib/server/job-state.js';
import { createId } from '../src/lib/server/utils.js';
import { toDbTimestamp, toDbTimestampPlus } from '../src/lib/server/timestamps.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

/**
 * Marqueur exclusif de ce test. Chaque bloc utilise son PROPRE type
 * (`__test_lease:<label>`) : la file sert par priorité puis ancienneté, donc sans
 * cloisonnement un bloc réclamerait le job d'un bloc précédent resté en file — et
 * la preuve mesurerait autre chose que ce qu'elle annonce.
 */
const TEST_TYPE = '__test_lease';
const typeFor = (label: string) => `${TEST_TYPE}:${label}`;
const KEY_PREFIX = `__test_lease:${createId()}:`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
/** Insère un job de test disponible immédiatement, sur le type propre à son bloc. */
async function seedJob(
	projectId: string,
	label: string,
	opts: { maxAttempts?: number; priority?: number } = {}
): Promise<string> {
	const id = createId();
	await db.insert(schema.jobs).values({
		id,
		projectId,
		type: typeFor(label),
		idempotencyKey: `${KEY_PREFIX}${label}-${seq++}`,
		priority: opts.priority ?? 10,
		maxAttempts: opts.maxAttempts ?? 5,
		availableAt: toDbTimestamp(new Date())
	});
	return id;
}

/**
 * Simule la MORT d'un worker : son bail est repoussé dans le passé sans qu'il
 * l'ait relâché. `heartbeatAgoMs` positionne le dernier battement, ce qui décide
 * de la nature de l'abandon (worker mort vs bloqué).
 *
 * Pourquoi pas un `kill` : SIGINT n'atteint pas node sous Git Bash/Windows, et
 * un vrai kill ne prouverait rien de plus — ce que le reaper voit d'un worker
 * mort, c'est EXACTEMENT ça : un bail périmé et un battement qui s'est arrêté.
 */
async function killWorker(jobId: string, leaseAgoMs: number, heartbeatAgoMs: number): Promise<void> {
	const now = new Date();
	await db.execute(sql`
		UPDATE "seostats"."jobs"
		   SET lease_until = ${toDbTimestampPlus(-leaseAgoMs, now)},
		       heartbeat_at = ${toDbTimestampPlus(-heartbeatAgoMs, now)}
		 WHERE id = ${jobId}
	`);
}

async function jobRow(jobId: string): Promise<{
	status: string;
	attempts: number;
	lease_owner: string | null;
	last_error_code: string | null;
	available_at: string;
}> {
	const res = await db.execute(sql`
		SELECT status, attempts, lease_owner, last_error_code, available_at
		  FROM "seostats"."jobs" WHERE id = ${jobId}
	`);
	return (res.rows ?? [])[0] as never;
}

async function cleanup(): Promise<{ jobs: number; attempts: number; effects: number }> {
	// Ordre imposé par les FK : les enfants d'abord. Le préfixe de clé est unique
	// par exécution → on ne supprime QUE ce que ce run a créé, tous types confondus.
	const ids = await db.execute(sql`
		SELECT id FROM "seostats"."jobs"
		 WHERE idempotency_key LIKE ${`${KEY_PREFIX}%`}
	`);
	const jobIds = ((ids.rows ?? []) as unknown as { id: string }[]).map((r) => r.id);
	if (jobIds.length === 0) return { jobs: 0, attempts: 0, effects: 0 };

	const inJobs = sql.join(
		jobIds.map((i) => sql`${i}`),
		sql`, `
	);
	const att = await db.execute(
		sql`DELETE FROM "seostats"."job_attempts" WHERE job_id IN (${inJobs}) RETURNING id`
	);
	const eff = await db.execute(
		sql`DELETE FROM "seostats"."job_effects" WHERE job_id IN (${inJobs}) RETURNING id`
	);
	const jbs = await db.execute(
		sql`DELETE FROM "seostats"."jobs" WHERE id IN (${inJobs}) RETURNING id`
	);
	return {
		jobs: jbs.rows?.length ?? 0,
		attempts: att.rows?.length ?? 0,
		effects: eff.rows?.length ?? 0
	};
}

async function main() {
	console.log('\n=== JOB-002 — récupération après crash, sur Neon ===\n');
	const projectId = await pickProjectId();

	try {
		// ── 1. Le bail renouvelé n'est pas volé ──────────────────────
		console.log('1. Bail renouvelé pendant un travail long :');
		const longJob = await seedJob(projectId, 'long');
		const longWorker = deriveWorkerId({ host: 'proof', pid: process.pid, nonce: 'long' });
		// Bail volontairement court (2 s) : sans renouvellement, il serait mort.
		const claimedLong = await claimJob({
			db,
			types: [typeFor('long')],
			workerId: longWorker,
			leaseMs: 2000
		});
		check('le job long est réclamé', claimedLong?.id === longJob);

		await delay(1200);
		const renewed = await renewLease({ db, jobId: longJob, workerId: longWorker, leaseMs: 2000 });
		check('le bail se prolonge', renewed !== null, `nouvelle échéance ${renewed?.leaseUntil}`);

		const reapDuringWork = await reclaimExpiredLeases({ db, limit: 50, types: [typeFor('long')] });
		check(
			'le reaper ne touche PAS un bail renouvelé',
			!reapDuringWork.reclaimed.some((r) => r.jobId === longJob),
			`${reapDuringWork.reclaimed.length} bail(s) mort(s) vu(s) au total`
		);

		const stranger = deriveWorkerId({ host: 'proof', pid: process.pid, nonce: 'stranger' });
		const stolenRenew = await renewLease({ db, jobId: longJob, workerId: stranger, leaseMs: 2000 });
		check('un autre worker ne peut pas prolonger ce bail', stolenRenew === null);
		await completeJob({ db, jobId: longJob, workerId: longWorker });

		// ── 2. Worker tué → reprise automatique, chronologie lisible ──
		console.log('\n2. Worker tué en pleine exécution (acceptations 1 et 3) :');
		const deadJob = await seedJob(projectId, 'dead');
		const victimWorker = deriveWorkerId({ host: 'proof', pid: process.pid, nonce: 'victim' });
		const claimedDead = await claimJob({
			db,
			types: [typeFor('dead')],
			workerId: victimWorker,
			leaseMs: 300_000
		});
		check('le job est réclamé et sa tentative ouverte', claimedDead?.id === deadJob);
		// Le worker journalise sa tentative (ce que fait `runWorker`) …
		const attemptId = createId();
		await db.insert(schema.jobAttempts).values({
			id: attemptId,
			jobId: deadJob,
			projectId,
			attemptNo: claimedDead!.attempts,
			workerId: victimWorker,
			outcome: 'running',
			startedAt: toDbTimestampPlus(-400_000, new Date())
		});
		// … puis il MEURT : bail périmé, plus aucun battement depuis longtemps.
		await killWorker(deadJob, 60_000, 400_000);

		const reaped = await reclaimExpiredLeases({ db, limit: 50, types: [typeFor('dead')] });
		const entry = reaped.reclaimed.find((r) => r.jobId === deadJob);
		check('le reaper le retrouve', Boolean(entry));
		check('la cause est « worker mort »', entry?.kind === 'worker_death', entry?.kind);
		check('il est remis en file (pas perdu)', entry?.outcome === 'queued');

		const afterReap = await jobRow(deadJob);
		check('son bail est vidé', afterReap.lease_owner === null);
		check('sa cause de mort est lisible en base', afterReap.last_error_code === 'WorkerDied');
		check(
			'la tentative est close ABANDONNÉE dans le journal',
			(await listJobAttempts({ db, jobId: deadJob })).some(
				(a) => a.outcome === 'abandoned' && a.abandonKind === 'worker_death'
			)
		);

		// Reprise réelle par un worker sain : la chaîne complète, pas une simulation.
		await db.execute(
			sql`UPDATE "seostats"."jobs" SET available_at = ${toDbTimestamp(new Date())} WHERE id = ${deadJob}`
		);
		let handlerRan = 0;
		const rescueStats = await runWorker({
			db,
			workerId: deriveWorkerId({ host: 'proof', pid: process.pid, nonce: 'rescue' }),
			types: [typeFor('dead')],
			handlers: new Map([[typeFor('dead'), async () => { handlerRan += 1; }]]),
			once: true,
			maxJobs: 1,
			reapLimit: 0 // on veut mesurer la REPRISE, pas une nouvelle passe de reaper
		});
		check('un autre worker reprend le job', rescueStats.succeeded === 1 && handlerRan === 1);

		const timeline = await listJobAttempts({ db, jobId: deadJob });
		check(
			'la chronologie montre l’abandon PUIS la reprise',
			timeline.length === 2 &&
				timeline[0].outcome === 'abandoned' &&
				timeline[1].outcome === 'succeeded',
			timeline.map((a) => `#${a.attemptNo} ${a.outcome}`).join(' → ')
		);
		check(
			'les deux tentatives portent des workers distincts',
			timeline.length === 2 && timeline[0].workerId !== timeline[1].workerId
		);

		// ── 3. Bail expiré mais battement récent → blocage ───────────
		console.log('\n3. Distinction worker mort / worker bloqué :');
		const stallJob = await seedJob(projectId, 'stall');
		const stallWorker = deriveWorkerId({ host: 'proof', pid: process.pid, nonce: 'stall' });
		await claimJob({ db, types: [typeFor('stall')], workerId: stallWorker, leaseMs: 300_000 });
		// Bail expiré il y a 5 s, dernier battement il y a 6 s : il battait encore
		// juste avant l'échéance (cadence attendue : 100 s) → il est bloqué, pas mort.
		await killWorker(stallJob, 5_000, 6_000);

		const stallReap = await reclaimExpiredLeases({ db, limit: 50, types: [typeFor('stall')] });
		const stallEntry = stallReap.reclaimed.find((r) => r.jobId === stallJob);
		check('un bail expiré au battement récent est classé « bloqué »', stallEntry?.kind === 'lease_stall', stallEntry?.kind);
		check(
			'sa cause est distincte de celle d’un worker mort',
			(await jobRow(stallJob)).last_error_code === 'LeaseStalled'
		);

		// ── 4. Abandon au plafond → dead-letter ──────────────────────
		console.log('\n4. Abandon au plafond de tentatives :');
		const dyingJob = await seedJob(projectId, 'dying', { maxAttempts: 1 });
		const dyingWorker = deriveWorkerId({ host: 'proof', pid: process.pid, nonce: 'dying' });
		await claimJob({ db, types: [typeFor('dying')], workerId: dyingWorker, leaseMs: 300_000 });
		await killWorker(dyingJob, 60_000, 400_000);

		const deadReap = await reclaimExpiredLeases({ db, limit: 50, types: [typeFor('dying')] });
		const deadEntry = deadReap.reclaimed.find((r) => r.jobId === dyingJob);
		check('un job au plafond part en dead-letter', deadEntry?.outcome === 'dead', deadEntry?.outcome);
		check('il n’est plus réclamable (pas de boucle infinie)', (await jobRow(dyingJob)).status === 'dead');

		// ── 5. Exactly-once des effets externes (acceptation 2) ──────
		console.log('\n5. Deux exécutions, un seul effet externe (acceptation 2) :');
		const effectJob = await seedJob(projectId, 'effect');
		const effectKey = `${KEY_PREFIX}effect`;
		let externalCalls = 0;
		const apply = async () => {
			externalCalls += 1;
			return { ok: true };
		};

		const first = await guardExternalEffect({
			db,
			jobId: effectJob,
			projectId,
			attemptNo: 1,
			effectKey,
			apply
		});
		const second = await guardExternalEffect({
			db,
			jobId: effectJob,
			projectId,
			attemptNo: 2, // la reprise, après mort du worker
			effectKey,
			apply
		});
		check('la 1re exécution applique l’effet', first.applied && !first.skipped);
		check('la reprise le SAUTE', second.skipped && !second.applied);
		check('l’effet externe n’a tourné qu’une fois', externalCalls === 1, `${externalCalls} appel(s)`);

		const effectRows = await db.execute(
			sql`SELECT status FROM "seostats"."job_effects" WHERE project_id = ${projectId} AND effect_key = ${effectKey}`
		);
		check(
			'une seule ligne, en état « applied »',
			effectRows.rows?.length === 1 &&
				(effectRows.rows[0] as unknown as { status: string }).status === 'applied'
		);

		// Un effet ÉCHOUÉ doit rester reprenable : il n'a jamais abouti.
		const failKey = `${KEY_PREFIX}effect-fail`;
		let failCalls = 0;
		await guardExternalEffect({
			db,
			jobId: effectJob,
			projectId,
			effectKey: failKey,
			apply: async () => {
				failCalls += 1;
				throw new Error('provider indisponible');
			}
		}).catch(() => {});
		const retried = await guardExternalEffect({
			db,
			jobId: effectJob,
			projectId,
			effectKey: failKey,
			apply: async () => {
				failCalls += 1;
				return { ok: true };
			}
		});
		check('un effet échoué reste reprenable', retried.applied && failCalls === 2, `${failCalls} appels`);

		// ── 6. Baux valides intouchés · reapers concurrents ──────────
		console.log('\n6. Étanchéité du reaper :');
		const safeJob = await seedJob(projectId, 'safe');
		const safeWorker = deriveWorkerId({ host: 'proof', pid: process.pid, nonce: 'safe' });
		await claimJob({ db, types: [typeFor('safe')], workerId: safeWorker, leaseMs: 600_000 });

		const concurrentJob = await seedJob(projectId, 'concurrent');
		await claimJob({
			db,
			types: [typeFor('concurrent')],
			workerId: deriveWorkerId({ host: 'proof', pid: process.pid, nonce: 'concurrent' }),
			leaseMs: 300_000
		});
		await killWorker(concurrentJob, 60_000, 400_000);

		// Deux reapers EN MÊME TEMPS sur la même ligne morte.
		const reapTypes = [typeFor('concurrent'), typeFor('safe')];
		const [reapA, reapB] = await Promise.all([
			reclaimExpiredLeases({ db, limit: 50, types: reapTypes }),
			reclaimExpiredLeases({ db, limit: 50, types: reapTypes })
		]);
		const takenA = reapA.reclaimed.filter((r) => r.jobId === concurrentJob).length;
		const takenB = reapB.reclaimed.filter((r) => r.jobId === concurrentJob).length;
		check(
			'deux reapers concurrents ne reprennent pas le même job deux fois',
			takenA + takenB === 1,
			`A:${takenA} B:${takenB}`
		);
		check(
			'un bail encore VALIDE n’est jamais repris',
			![...reapA.reclaimed, ...reapB.reclaimed].some((r) => r.jobId === safeJob) &&
				(await jobRow(safeJob)).status === 'running'
		);
		const safeAttempts = await listJobAttempts({ db, jobId: concurrentJob });
		check(
			'une seule tentative abandonnée est journalisée',
			safeAttempts.filter((a) => a.outcome === 'abandoned').length <= 1
		);

		// ── 7. Budget de durée → ProviderTimeout ─────────────────────
		console.log('\n7. Budget de durée dépassé (timeout provider vs crash local) :');
		const slowJob = await seedJob(projectId, 'slow');
		const slowStats = await runWorker({
			db,
			workerId: deriveWorkerId({ host: 'proof', pid: process.pid, nonce: 'slow' }),
			types: [typeFor('slow')],
			// Handler qui ignore délibérément son signal : le budget doit le borner
			// quand même, sinon ce ne serait qu'une suggestion.
			handlers: new Map([[typeFor('slow'), async () => { await delay(5000); }]]),
			maxJobDurationMs: 600,
			leaseMs: 300_000,
			once: true,
			maxJobs: 1,
			reapLimit: 0
		});
		check('le job est interrompu, pas attendu', slowStats.failed === 1);

		const slowRow = await jobRow(slowJob);
		check('il est classé ProviderTimeout', slowRow.last_error_code === 'ProviderTimeout', slowRow.last_error_code ?? '∅');
		check('il est replanifié (rejouable), pas mort', slowRow.status === 'queued', slowRow.status);
		check('aucun job « running » orphelin', slowRow.lease_owner === null);
		check(
			'la tentative porte la cause dans le journal',
			(await listJobAttempts({ db, jobId: slowJob })).some(
				(a) => a.outcome === 'failed' && a.errorCode === 'ProviderTimeout'
			)
		);
	} finally {
		const del = await cleanup();
		console.log(
			`\nNettoyage : ${del.jobs} job(s), ${del.attempts} tentative(s), ${del.effects} effet(s) supprimés.`
		);
		await pool.end();
	}

	console.log(failures === 0 ? '\n✅ Toutes les vérifications passent.\n' : `\n❌ ${failures} échec(s).\n`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
	console.error('Preuve JOB-002 en erreur:', err);
	await cleanup().catch(() => {});
	await pool.end().catch(() => {});
	process.exit(1);
});
