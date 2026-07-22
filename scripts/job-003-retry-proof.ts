/**
 * JOB-003 — Preuve du retry classé, du backoff jitté et de la dead-letter.
 *
 * Ce test ne peut pas vivre dans vitest : il exige un vrai Postgres (transaction
 * de reprise, garde de bail, journal append-only). Pendant de
 * `scripts/job-002-recovery-proof.ts` (JOB-002) et `job-claim-concurrency.ts` (JOB-001).
 *
 * Les 3 acceptations du BACKLOG, prouvées en base :
 *   1. « 429 et 5xx sont retentés conformément à la policy » : le 429 REPORTE le
 *      job (tentative rendue, `deferrals` +1, Retry-After honoré), le 5xx le
 *      replanifie (tentative consommée, délai dans la fourchette de jitter) ;
 *   2. « 400/403 structurels ne bouclent pas » : dead-letter à la PREMIÈRE
 *      tentative — et le 403+`rateLimitExceeded` de Google atterrit bien en quota,
 *      pas en permanent (c'est le piège que ce module existe pour éviter) ;
 *   3. « une reprise manuelle conserve l'historique des tentatives » : après
 *      `jobs-requeue`, les lignes antérieures sont intactes, une ligne `requeued`
 *      s'ajoute, et un vrai `runWorker` mène ensuite le job à `succeeded`.
 * Plus : le plafond de reports (un provider fermé ne fait pas boucler le job).
 *
 * Écriture bornée à ses propres lignes (type dédié + clés préfixées), nettoyage
 * dans un `finally`. Lancer :
 *   npx tsx scripts/job-003-retry-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { listDeadJobs, requeueDeadJob } from '../src/lib/server/jobs-claim.js';
import { listJobAttempts } from '../src/lib/server/jobs-lease.js';
import { runWorker } from '../src/lib/server/job-runner.js';
import { deriveWorkerId } from '../src/lib/server/job-state.js';
import { createId } from '../src/lib/server/utils.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

/**
 * Marqueur exclusif de ce test. Chaque bloc a son PROPRE type
 * (`__test_retry:<label>`) : la file sert par priorité puis ancienneté, donc sans
 * cloisonnement un bloc réclamerait le job d'un bloc précédent resté en file — et
 * la preuve mesurerait autre chose que ce qu'elle annonce.
 */
const TEST_TYPE = '__test_retry';
const typeFor = (label: string) => `${TEST_TYPE}:${label}`;
const KEY_PREFIX = `__test_retry:${createId()}:`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

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
	opts: { maxAttempts?: number; deferrals?: number } = {}
): Promise<string> {
	const id = createId();
	await db.insert(schema.jobs).values({
		id,
		projectId,
		type: typeFor(label),
		idempotencyKey: `${KEY_PREFIX}${label}-${seq++}`,
		priority: 10,
		maxAttempts: opts.maxAttempts ?? 5,
		deferrals: opts.deferrals ?? 0,
		availableAt: toDbTimestamp(new Date())
	});
	return id;
}

interface JobSnapshot {
	status: string;
	attempts: number;
	deferrals: number;
	requeued_count: number;
	last_error_class: string | null;
	last_error_code: string | null;
	available_at: string;
	lease_owner: string | null;
	finished_at: string | null;
}

async function jobRow(jobId: string): Promise<JobSnapshot> {
	const res = await db.execute(sql`
		SELECT status, attempts, deferrals, requeued_count, last_error_class, last_error_code,
		       available_at, lease_owner, finished_at
		  FROM "seostats"."jobs" WHERE id = ${jobId}
	`);
	return (res.rows ?? [])[0] as never;
}

/** Écart en secondes entre `available_at` et maintenant (mesure du backoff réel). */
function delaySeconds(availableAt: string): number {
	const target = Date.parse(`${availableAt.replace(' ', 'T')}Z`);
	return Math.round((target - Date.now()) / 1000);
}

/** Un handler qui jette l'erreur fournie : c'est le provider qu'on simule, pas le worker. */
function throwingHandlers(label: string, err: unknown) {
	return new Map([
		[
			typeFor(label),
			async () => {
				throw err;
			}
		]
	]);
}

/** Fait tourner UN job du type donné jusqu'à son issue, comme le ferait la prod. */
async function runOne(label: string, nonce: string, handlers: Map<string, () => Promise<void>>) {
	return runWorker({
		db,
		workerId: deriveWorkerId({ host: 'proof3', pid: process.pid, nonce }),
		types: [typeFor(label)],
		handlers,
		once: true,
		maxJobs: 1,
		leaseMs: 300_000,
		reapLimit: 0 // on mesure le chemin d'ÉCHEC, pas une passe de reaper
	});
}

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
	const jbs = await db.execute(sql`DELETE FROM "seostats"."jobs" WHERE id IN (${inJobs}) RETURNING id`);
	return { jobs: jbs.rows?.length ?? 0, attempts: att.rows?.length ?? 0 };
}

async function main() {
	console.log('\n=== JOB-003 — retry classé, backoff jitté, dead-letter (sur Neon) ===\n');
	const projectId = await pickProjectId();

	try {
		// ── 1. 5xx : retenté, tentative consommée, délai jitté ───────
		console.log('1. Erreur serveur 5xx (acceptation 1) :');
		const serverJob = await seedJob(projectId, 'server');
		const serverStats = await runOne(
			'server',
			'server',
			throwingHandlers('server', { status: 503, message: 'Service Unavailable' })
		);
		check('le job échoue une fois', serverStats.failed === 1);
		check('il est classé « retryable »', serverStats.failedByClass.retryable === 1);

		const serverRow = await jobRow(serverJob);
		check('il est REPLANIFIÉ, pas mort', serverRow.status === 'queued', serverRow.status);
		check('sa classe est persistée', serverRow.last_error_class === 'retryable', serverRow.last_error_class ?? '∅');
		check('la tentative est consommée', Number(serverRow.attempts) === 1, `${serverRow.attempts}`);
		const serverDelay = delaySeconds(serverRow.available_at);
		check(
			'le délai tombe dans la fourchette de jitter (30 s ±20 %)',
			serverDelay >= 23 && serverDelay <= 37,
			`+${serverDelay} s`
		);
		check('aucun bail orphelin', serverRow.lease_owner === null);

		// ── 2. 429 : REPORTÉ, tentative rendue, Retry-After honoré ───
		console.log('\n2. Quota provider 429 (acceptation 1) :');
		const quotaJob = await seedJob(projectId, 'quota');
		const quotaStats = await runOne(
			'quota',
			'quota',
			throwingHandlers('quota', {
				status: 429,
				message: 'Too Many Requests',
				headers: { 'retry-after': '120' }
			})
		);
		check('le job est REPORTÉ, pas compté en échec', quotaStats.deferred === 1 && quotaStats.failed === 0);

		const quotaRow = await jobRow(quotaJob);
		check('il reste réclamable (queued)', quotaRow.status === 'queued', quotaRow.status);
		check('il est classé « quota »', quotaRow.last_error_class === 'quota', quotaRow.last_error_class ?? '∅');
		check(
			'la tentative lui est RENDUE (le budget n’est pas entamé)',
			Number(quotaRow.attempts) === 0,
			`attempts=${quotaRow.attempts}`
		);
		check('le report est compté à part', Number(quotaRow.deferrals) === 1, `deferrals=${quotaRow.deferrals}`);
		const quotaDelay = delaySeconds(quotaRow.available_at);
		check(
			'le Retry-After du provider est honoré (jamais raboté par le jitter)',
			quotaDelay >= 120,
			`+${quotaDelay} s (Retry-After : 120 s)`
		);
		check(
			'la tentative est journalisée « deferred »',
			(await listJobAttempts({ db, jobId: quotaJob })).some(
				(a) => a.outcome === 'deferred' && a.errorClass === 'quota'
			)
		);

		// ── 3. 403 + rateLimitExceeded : quota, PAS permanent ────────
		console.log('\n3. Le piège Google : 403 qui est en réalité un quota :');
		const gJob = await seedJob(projectId, 'google');
		const gStats = await runOne(
			'google',
			'google',
			throwingHandlers('google', {
				code: 403,
				errors: [{ reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' }],
				message: 'Rate Limit Exceeded'
			})
		);
		check('un 403 de quota est REPORTÉ, pas condamné', gStats.deferred === 1);
		const gRow = await jobRow(gJob);
		check('il est classé « quota » malgré son 403', gRow.last_error_class === 'quota', gRow.last_error_class ?? '∅');
		check('il reste vivant', gRow.status === 'queued', gRow.status);

		// ── 4. 403 structurel : dead-letter immédiat ─────────────────
		console.log('\n4. 403/400 structurels ne bouclent pas (acceptation 2) :');
		const forbiddenJob = await seedJob(projectId, 'forbidden');
		const forbiddenStats = await runOne(
			'forbidden',
			'forbidden',
			throwingHandlers('forbidden', {
				status: 403,
				message: 'The caller does not have permission'
			})
		);
		check('le job part en dead-letter', forbiddenStats.deadLettered === 1);
		check('il est classé « permanent »', forbiddenStats.failedByClass.permanent === 1);

		const forbiddenRow = await jobRow(forbiddenJob);
		check('il est mort DÈS LA PREMIÈRE tentative', Number(forbiddenRow.attempts) === 1, `${forbiddenRow.attempts}/5`);
		check('son statut est « dead »', forbiddenRow.status === 'dead', forbiddenRow.status);
		check('sa date de mort est posée', forbiddenRow.finished_at !== null);

		// Un 401 doit mourir aussi, mais avec sa PROPRE cause (auth ≠ structurel).
		const authJob = await seedJob(projectId, 'auth');
		await runOne(
			'auth',
			'auth',
			throwingHandlers('auth', { status: 400, error: 'invalid_grant', message: 'Token has been expired or revoked.' })
		);
		const authRow = await jobRow(authJob);
		check('un invalid_grant meurt immédiatement', authRow.status === 'dead', authRow.status);
		check(
			'…avec la cause « auth », distincte de « permanent »',
			authRow.last_error_class === 'auth',
			authRow.last_error_class ?? '∅'
		);

		// ── 5. Plafond de reports : la boucle reste bornée ───────────
		console.log('\n5. Plafond de reports (un provider fermé ne boucle pas) :');
		const cappedJob = await seedJob(projectId, 'capped', { deferrals: 20 });
		await runOne('capped', 'capped', throwingHandlers('capped', { status: 429, message: 'Too Many Requests' }));
		const cappedRow = await jobRow(cappedJob);
		check('au plafond de reports, le job part en dead-letter', cappedRow.status === 'dead', cappedRow.status);
		check('sa cause reste « quota »', cappedRow.last_error_class === 'quota', cappedRow.last_error_class ?? '∅');

		// ── 6. Dead-letter listable ──────────────────────────────────
		console.log('\n6. La dead-letter est consultable :');
		const dead = await listDeadJobs({ db, limit: 50 });
		const mine = dead.filter((d) => d.type.startsWith(TEST_TYPE));
		check('les jobs morts de ce run y figurent', mine.length >= 3, `${mine.length} trouvé(s)`);
		check(
			'chacun porte sa cause',
			mine.every((d) => d.errorClass !== null),
			mine.map((d) => d.errorClass).join(', ')
		);
		const authOnly = await listDeadJobs({ db, errorClasses: ['auth'], limit: 50 });
		check(
			'le filtre par classe fonctionne',
			authOnly.every((d) => d.errorClass === 'auth') && authOnly.some((d) => d.id === authJob)
		);

		// ── 7. Reprise manuelle : l'historique survit (acceptation 3) ─
		console.log('\n7. Reprise manuelle depuis la dead-letter (acceptation 3) :');
		const beforeRequeue = await listJobAttempts({ db, jobId: forbiddenJob });
		check('le job mort a bien une histoire', beforeRequeue.length === 1, `${beforeRequeue.length} tentative(s)`);

		const requeued = await requeueDeadJob({
			db,
			jobId: forbiddenJob,
			actor: 'user:proof',
			reason: 'permission corrigée côté Google'
		});
		check('la reprise est acceptée', requeued !== null);
		check('elle est comptée sur le job', requeued?.requeuedCount === 1, `${requeued?.requeuedCount}`);

		const afterRequeue = await jobRow(forbiddenJob);
		check('le job est de nouveau réclamable', afterRequeue.status === 'queued', afterRequeue.status);
		check(
			'son budget de tentatives repart à neuf',
			Number(afterRequeue.attempts) === 0,
			`attempts=${afterRequeue.attempts}`
		);
		check('sa dernière erreur est effacée (plus de cause périmée affichée)', afterRequeue.last_error_class === null);

		const timeline = await listJobAttempts({ db, jobId: forbiddenJob });
		check(
			'AUCUNE ligne d’historique n’a été perdue',
			timeline.filter((a) => a.outcome === 'dead').length === 1,
			`${timeline.length} ligne(s) au total`
		);
		const requeueLine = timeline.find((a) => a.outcome === 'requeued');
		check('la reprise elle-même est journalisée', Boolean(requeueLine));
		check('elle nomme son auteur', requeueLine?.workerId === 'user:proof', requeueLine?.workerId);
		check(
			'elle garde sa raison',
			(requeueLine?.metadataJson ?? '').includes('permission corrigée'),
			requeueLine?.metadataJson ?? '∅'
		);

		// Et le job repart VRAIMENT : un worker sain le mène à son terme.
		let ran = 0;
		const rescue = await runOne(
			'forbidden',
			'rescue',
			new Map([
				[
					typeFor('forbidden'),
					async () => {
						ran += 1;
					}
				]
			])
		);
		check('un worker reprend le job relancé et le termine', rescue.succeeded === 1 && ran === 1);
		const finalTimeline = await listJobAttempts({ db, jobId: forbiddenJob });
		check(
			'la chronologie complète se lit : mort → relance → succès',
			finalTimeline.map((a) => a.outcome).join(' → ') === 'dead → requeued → succeeded',
			finalTimeline.map((a) => `#${a.attemptNo} ${a.outcome}`).join(' → ')
		);

		// ── 8. Garde : on ne relance pas un job vivant ───────────────
		console.log('\n8. Garde de la reprise :');
		const aliveJob = await seedJob(projectId, 'alive');
		const refused = await requeueDeadJob({ db, jobId: aliveJob, actor: 'user:proof' });
		check('un job vivant ne se « reprend » pas', refused === null);
		check('il n’a reçu aucune ligne de journal', (await listJobAttempts({ db, jobId: aliveJob })).length === 0);

		// ── 9. Intégrité des horodatages ─────────────────────────────
		console.log('\n9. Format temporel (piège timestamps.ts) :');
		const isoJobs = await db.execute(sql`
			SELECT count(*)::int AS n FROM "seostats"."jobs"
			 WHERE idempotency_key LIKE ${`${KEY_PREFIX}%`}
			   AND (available_at LIKE '%T%' OR COALESCE(finished_at, '') LIKE '%T%')
		`);
		check(
			'aucun horodatage ISO écrit dans `jobs`',
			((isoJobs.rows ?? [])[0] as unknown as { n: number }).n === 0
		);
	} finally {
		const del = await cleanup();
		console.log(`\nNettoyage : ${del.jobs} job(s), ${del.attempts} tentative(s) supprimés.`);
		await pool.end();
	}

	console.log(failures === 0 ? '\n✅ Toutes les vérifications passent.\n' : `\n❌ ${failures} échec(s).\n`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
	console.error('Preuve JOB-003 en erreur:', err);
	await cleanup().catch(() => {});
	await pool.end().catch(() => {});
	process.exit(1);
});
