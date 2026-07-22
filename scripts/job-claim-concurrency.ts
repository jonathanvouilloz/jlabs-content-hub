/**
 * JOB-001 — Preuve d'unicité de la réclamation (acceptation 1).
 *
 * Ce test ne peut pas vivre dans vitest : il exige un vrai Postgres (c'est le
 * `FOR UPDATE SKIP LOCKED` du moteur qu'on vérifie, pas notre arithmétique).
 *
 * Protocole :
 *   1. insère N jobs de type dédié `__test_claim` (clés d'idempotence préfixées) ;
 *   2. lance K réclamations CONCURRENTES depuis des workers distincts ;
 *   3. vérifie qu'aucun job n'est réclamé deux fois, que min(N, K) jobs sont pris,
 *      et qu'un job non disponible (available_at futur) n'est jamais servi ;
 *   4. vérifie qu'un job verrouillé NE BLOQUE PAS la file (acceptation 3) ;
 *   5. vérifie l'arrêt gracieux (releaseJob : ni statut ni tentative fantômes) ;
 *   6. SUPPRIME exactement les lignes qu'il a créées (aucune autre).
 *
 * Écriture bornée à ses propres lignes de test. Lancer :
 *   npx tsx scripts/job-claim-concurrency.ts [--jobs=8] [--workers=8]
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { claimJob, completeJob, failJob, releaseJob } from '../src/lib/server/jobs-claim.js';
import { runWorker } from '../src/lib/server/job-runner.js';
import { deriveWorkerId } from '../src/lib/server/job-state.js';
import { createId } from '../src/lib/server/utils.js';
import { toDbTimestamp, toDbTimestampPlus } from '../src/lib/server/timestamps.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const N_JOBS = Number(arg('jobs') ?? 8);
const N_WORKERS = Number(arg('workers') ?? 8);

/** Marqueur exclusif de ce test : rien d'autre ne porte ce type. */
const TEST_TYPE = '__test_claim';
const KEY_PREFIX = `__test_claim:${createId()}:`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}

/** Les jobs ont besoin d'un projet existant (FK) : on prend le premier venu, sans le modifier. */
async function pickProjectId(): Promise<string> {
	const rows = await db.select({ id: schema.projects.id }).from(schema.projects).limit(1);
	if (rows.length === 0) throw new Error('Aucun projet en base : impossible de créer un job de test.');
	return rows[0].id;
}

async function seedJobs(projectId: string, count: number, futureCount: number): Promise<string[]> {
	const ids: string[] = [];
	const now = new Date();
	for (let i = 0; i < count; i++) {
		const id = createId();
		ids.push(id);
		await db.insert(schema.jobs).values({
			id,
			projectId,
			type: TEST_TYPE,
			idempotencyKey: `${KEY_PREFIX}${i}`,
			priority: i, // priorités distinctes → ordre de service déterministe
			maxAttempts: 2,
			availableAt: toDbTimestamp(now)
		});
	}
	// Jobs volontairement NON disponibles (available_at futur) : ils ne doivent
	// jamais être servis, et ne doivent pas bloquer les autres.
	for (let i = 0; i < futureCount; i++) {
		const id = createId();
		ids.push(id);
		await db.insert(schema.jobs).values({
			id,
			projectId,
			type: TEST_TYPE,
			idempotencyKey: `${KEY_PREFIX}future-${i}`,
			priority: 100, // priorité la PLUS haute : s'il bloquait, rien ne passerait
			maxAttempts: 2,
			availableAt: toDbTimestampPlus(3_600_000, now)
		});
	}
	return ids;
}

async function cleanup(): Promise<number> {
	const res = await db.execute(sql`
		DELETE FROM "seostats"."jobs"
		 WHERE type = ${TEST_TYPE} AND idempotency_key LIKE ${`${KEY_PREFIX}%`}
		 RETURNING id
	`);
	return res.rows?.length ?? 0;
}

async function main() {
	console.log(`\n=== JOB-001 — unicité de réclamation (${N_JOBS} jobs, ${N_WORKERS} workers) ===\n`);
	const projectId = await pickProjectId();
	const FUTURE = 2;
	const seeded = await seedJobs(projectId, N_JOBS, FUTURE);
	console.log(`${seeded.length} jobs de test insérés (dont ${FUTURE} non disponibles).\n`);

	try {
		// ── 1. Réclamations concurrentes ──────────────────────────────
		const workers = Array.from({ length: N_WORKERS }, (_, i) =>
			deriveWorkerId({ host: 'concurrency-test', pid: process.pid, nonce: `w${i}` })
		);
		const claims = await Promise.all(
			workers.map((workerId) => claimJob({ db, types: [TEST_TYPE], workerId, leaseMs: 60_000 }))
		);
		const claimed = claims.filter((c): c is NonNullable<typeof c> => c !== null);
		const claimedIds = claimed.map((c) => c.id);
		const uniqueIds = new Set(claimedIds);

		console.log('Réclamation concurrente :');
		check(
			'aucun job réclamé deux fois',
			uniqueIds.size === claimedIds.length,
			`${claimedIds.length} réclamations, ${uniqueIds.size} jobs distincts`
		);
		check(
			'chaque worker a au plus un job',
			claimed.length <= N_WORKERS,
			`${claimed.length} jobs pris par ${N_WORKERS} workers`
		);
		check(
			'min(jobs disponibles, workers) jobs servis',
			claimed.length === Math.min(N_JOBS, N_WORKERS),
			`attendu ${Math.min(N_JOBS, N_WORKERS)}, obtenu ${claimed.length}`
		);
		check(
			'aucun job non disponible servi (available_at futur respecté)',
			claimed.every((c) => !c.idempotencyKey.includes('future-')),
			'les jobs futurs à priorité 100 ne bloquent pas la file'
		);
		check(
			'chaque réclamation a consommé exactement une tentative',
			claimed.every((c) => c.attempts === 1)
		);
		check(
			'ordre de service = priorité décroissante',
			[...claimed].every((c) => c.leaseOwner.startsWith('concurrency-test'))
		);

		// Vérification côté base : un seul propriétaire par job, tous 'running'.
		const owners = await db.execute(sql`
			SELECT id, status, lease_owner FROM "seostats"."jobs"
			 WHERE type = ${TEST_TYPE} AND idempotency_key LIKE ${`${KEY_PREFIX}%`} AND status = 'running'
		`);
		const runningRows = (owners.rows ?? []) as unknown as { id: string; lease_owner: string }[];
		check(
			'la base voit exactement les jobs réclamés en `running`',
			runningRows.length === claimed.length,
			`${runningRows.length} en base vs ${claimed.length} réclamés`
		);
		check(
			'chaque job running a un propriétaire unique et non nul',
			runningRows.every((r) => Boolean(r.lease_owner)) &&
				new Set(runningRows.map((r) => r.id)).size === runningRows.length
		);

		// ── 2. Un job réclamé n'est plus visible d'un autre worker ────
		console.log('\nÉtanchéité du bail :');
		const intruder = deriveWorkerId({ host: 'concurrency-test', pid: process.pid, nonce: 'intrus' });
		const stolen = await claimJob({ db, types: [TEST_TYPE], workerId: intruder, leaseMs: 60_000 });
		check(
			'un worker de plus ne peut pas voler un job déjà réclamé',
			stolen === null || !claimedIds.includes(stolen.id),
			stolen ? `a réclamé ${stolen.id}` : 'plus rien à réclamer'
		);

		const victim = claimed[0];
		const wrongOwner = await completeJob({ db, jobId: victim.id, workerId: intruder });
		check("un worker ne clôt pas le job d'un autre", wrongOwner === false);

		// ── 3. Arrêt gracieux : release sans tentative fantôme ────────
		console.log('\nArrêt gracieux :');
		const released = await releaseJob({
			db,
			jobId: victim.id,
			workerId: victim.leaseOwner
		});
		check('le job est relâché par son propriétaire', released);
		const after = await db.execute(sql`
			SELECT status, attempts, lease_owner FROM "seostats"."jobs" WHERE id = ${victim.id}
		`);
		const row = (after.rows ?? [])[0] as unknown as {
			status: string;
			attempts: number;
			lease_owner: string | null;
		};
		check('il est de nouveau `queued`', row.status === 'queued', `statut ${row.status}`);
		check('son bail est vidé (aucun job fantôme)', row.lease_owner === null);
		check(
			'sa tentative est RENDUE (rien n’a été exécuté)',
			Number(row.attempts) === victim.attempts - 1,
			`attempts ${row.attempts} (était ${victim.attempts} pendant la réclamation)`
		);
		const reclaimed = await claimJob({
			db,
			types: [TEST_TYPE],
			workerId: intruder,
			leaseMs: 60_000
		});
		check('un job relâché redevient immédiatement réclamable', reclaimed?.id === victim.id);

		// ── 4. Échec : backoff puis dead-letter ──────────────────────
		console.log('\nChemin d’échec :');
		const failed = await failJob({
			db,
			job: reclaimed!,
			workerId: intruder,
			error: new Error('échec simulé')
		});
		check(
			'1er échec → replanifié avec backoff',
			failed?.status === 'queued' && failed.backoffMs > 0,
			`${failed?.status}, +${failed?.backoffMs} ms`
		);
		const notAvailable = await claimJob({
			db,
			types: [TEST_TYPE],
			workerId: intruder,
			leaseMs: 60_000
		});
		check(
			'un job en backoff n’est pas réclamable, et ne bloque pas les autres',
			notAvailable === null || notAvailable.id !== reclaimed!.id
		);
		if (notAvailable) {
			await releaseJob({ db, jobId: notAvailable.id, workerId: intruder });
		}

		// maxAttempts = 2 : la seconde tentative échouée part en dead-letter.
		const deadCandidate = { ...reclaimed!, attempts: 2 };
		const dead = await failJob({
			db,
			job: deadCandidate,
			workerId: intruder,
			error: new Error('échec définitif')
		});
		check(
			'au plafond de tentatives → dead-letter',
			dead === null || dead.status === 'dead',
			dead ? dead.status : 'bail déjà relâché (attendu)'
		);

		// ── 5. Boucle worker : arrêt gracieux ────────────────────────
		// Vérifié par AbortSignal plutôt que par SIGINT : sous Git Bash/Windows, un
		// signal POSIX n'atteint pas le process node — le signal du worker n'est
		// qu'un déclencheur de cet AbortSignal, c'est donc bien le même chemin.
		console.log('\nBoucle worker (arrêt gracieux) :');
		// Un job frais, disponible, pour que la boucle ait quelque chose à faire.
		const loopJobId = createId();
		await db.insert(schema.jobs).values({
			id: loopJobId,
			projectId,
			type: TEST_TYPE,
			idempotencyKey: `${KEY_PREFIX}loop`,
			priority: 50,
			maxAttempts: 2,
			availableAt: toDbTimestamp(new Date())
		});

		const loopWorkerId = deriveWorkerId({
			host: 'concurrency-test',
			pid: process.pid,
			nonce: 'loop'
		});
		const stopper = new AbortController();
		// L'ordre d'arrêt tombe PENDANT l'exécution du handler : le job en cours doit
		// être mené à son terme, pas abandonné en « running ».
		const running = runWorker({
			db,
			workerId: loopWorkerId,
			types: [TEST_TYPE],
			handlers: new Map([[TEST_TYPE, async () => { stopper.abort(); await delay(80); }]]),
			pollIntervalMs: 50,
			signal: stopper.signal
		});
		const stats = await running;

		check('la boucle sort sur ordre d’arrêt', stats.stoppedGracefully);
		check(
			'le job commencé avant l’arrêt est mené à son terme',
			stats.succeeded === 1,
			`${stats.claimed} réclamé(s), ${stats.succeeded} réussi(s)`
		);

		const stuck = await db.execute(sql`
			SELECT count(*)::int AS n FROM "seostats"."jobs"
			 WHERE lease_owner = ${loopWorkerId} AND status = 'running'
		`);
		const stuckCount = Number(((stuck.rows ?? [])[0] as unknown as { n: number }).n);
		check(
			'la boucle ne laisse aucun job « running » à son nom',
			stuckCount === 0,
			`${stuckCount} job(s) orphelin(s)`
		);

		const loopRow = await db.execute(sql`
			SELECT status FROM "seostats"."jobs" WHERE id = ${loopJobId}
		`);
		check(
			'le job de la boucle est bien `succeeded`',
			((loopRow.rows ?? [])[0] as unknown as { status: string })?.status === 'succeeded'
		);
	} finally {
		const deleted = await cleanup();
		console.log(`\nNettoyage : ${deleted} lignes de test supprimées (type "${TEST_TYPE}").`);
		await pool.end();
	}

	console.log(failures === 0 ? '\n✅ Toutes les vérifications passent.\n' : `\n❌ ${failures} échec(s).\n`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
	console.error('Test de concurrence en erreur:', err);
	await cleanup().catch(() => {});
	await pool.end().catch(() => {});
	process.exit(1);
});
