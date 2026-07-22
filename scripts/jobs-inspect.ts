/**
 * JOB-002/JOB-003 — Chronologie des tentatives d'un job, et dead-letter (lecture seule).
 *
 * Répond à l'acceptation « la tentative abandonnée et la reprise sont visibles »
 * sans attendre la console d'exploitation (JOB-007), qui lira les mêmes données.
 * JOB-003 y ajoute la vue dead-letter (`--dead`) et la CLASSE de chaque échec.
 *
 * Lancer :
 *   npx tsx scripts/jobs-inspect.ts --job=<id>
 *   npx tsx scripts/jobs-inspect.ts --project=<slug> [--status=running,dead] [--limit=20]
 *   npx tsx scripts/jobs-inspect.ts --dead [--class=auth,permanent] [--project=<slug>]
 *
 * Sortie type :
 *   job 01J8…  detect:keyword_opportunity  (jonlabs)  [queued, 2/5 tentatives]
 *     #1  host-a/2411/x9   09:02→09:07  ABANDONNÉE  worker mort
 *     #2  host-b/8120/k2   09:12→09:14  succeeded
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { listDeadJobs } from '../src/lib/server/jobs-claim.js';
import { listJobAttempts } from '../src/lib/server/jobs-lease.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const JOB_ID = arg('job');
const PROJECT = arg('project');
const STATUSES = arg('status')?.split(',').filter(Boolean);
const LIMIT = Number(arg('limit') ?? 20);
const DEAD = args.includes('--dead');
const CLASSES = arg('class')?.split(',').filter(Boolean);

if (!JOB_ID && !PROJECT && !DEAD) {
	console.error(
		'Usage : --job=<id> · --project=<slug> [--status=a,b] · --dead [--class=auth,permanent] [--limit=N]'
	);
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

interface JobRow {
	id: string;
	type: string;
	status: string;
	attempts: number;
	max_attempts: number;
	slug: string;
	last_error_code: string | null;
	last_error_class: string | null;
	deferrals: number | null;
	requeued_count: number | null;
}

const OUTCOME_LABEL: Record<string, string> = {
	running: 'EN COURS',
	succeeded: 'succeeded',
	failed: 'échouée',
	abandoned: 'ABANDONNÉE',
	released: 'relâchée',
	deferred: 'REPORTÉE (quota)',
	requeued: 'RELANCÉE (manuel)',
	dead: 'DEAD-LETTER'
};

/** Ce que la classe dit du sort réservé au job (JOB-003). */
const CLASS_LABEL: Record<string, string> = {
	retryable: 'rejouable',
	quota: 'quota provider',
	auth: 'authentification',
	permanent: 'structurel'
};

const KIND_LABEL: Record<string, string> = {
	worker_death: 'worker mort',
	lease_stall: 'worker bloqué'
};

/** `2026-07-22 09:02:11` → `09:02:11` (la date est déjà dans l'en-tête du job). */
const hhmmss = (ts: string | null) => (ts ? ts.slice(11, 19) : '…');

async function fetchJobs(): Promise<JobRow[]> {
	// Filtres PARAMÉTRÉS : `IN (…)` et non `= ANY($n)` (le driver Neon sérialise
	// un tableau lié élément par élément → `malformed array literal`).
	const jobFilter = JOB_ID ? sql`AND j.id = ${JOB_ID}` : sql``;
	const projectFilter = PROJECT ? sql`AND p.slug = ${PROJECT}` : sql``;
	const statusFilter =
		STATUSES && STATUSES.length > 0
			? sql`AND j.status IN (${sql.join(
					STATUSES.map((s) => sql`${s}`),
					sql`, `
				)})`
			: sql``;

	const res = await db.execute(sql`
		SELECT j.id, j.type, j.status, j.attempts, j.max_attempts, j.last_error_code,
		       j.last_error_class, j.deferrals, j.requeued_count, p.slug
		  FROM "seostats"."jobs" AS j
		  JOIN "seostats"."projects" AS p ON p.id = j.project_id
		 WHERE 1 = 1 ${jobFilter} ${projectFilter} ${statusFilter}
		 ORDER BY j.updated_at DESC
		 LIMIT ${LIMIT}
	`);
	return (res.rows ?? []) as unknown as JobRow[];
}

/** Raison d'une reprise manuelle, telle que `requeueDeadJob` l'a journalisée. */
function requeueReason(metadataJson: string | null): string {
	if (!metadataJson) return '';
	try {
		const parsed: unknown = JSON.parse(metadataJson);
		const reason = (parsed as { reason?: unknown })?.reason;
		return typeof reason === 'string' && reason ? `  « ${reason} »` : '';
	} catch {
		return '';
	}
}

/** Vue dead-letter : ce qui est mort, de quoi, et depuis quand (JOB-003). */
async function showDeadLetter() {
	const dead = await listDeadJobs({
		db,
		projectSlug: PROJECT,
		errorClasses: CLASSES,
		limit: LIMIT
	});

	console.log(
		`\n=== Dead-letter${PROJECT ? ` · ${PROJECT}` : ''}` +
			`${CLASSES ? ` · classes ${CLASSES.join(',')}` : ''} ===\n`
	);

	if (dead.length === 0) {
		console.log('Aucun job en dead-letter.\n');
		return;
	}

	for (const j of dead) {
		const klass = j.errorClass ? `${CLASS_LABEL[j.errorClass] ?? j.errorClass}` : 'cause inconnue';
		console.log(
			`  ${j.id}  ${j.type}  (${j.projectSlug})\n` +
				`    mort le ${j.finishedAt ?? '?'}  ·  ${j.attempts}/${j.maxAttempts} tentatives` +
				`${j.deferrals > 0 ? `  ·  ${j.deferrals} report(s)` : ''}` +
				`${j.requeuedCount > 0 ? `  ·  déjà relancé ${j.requeuedCount}×` : ''}\n` +
				`    cause : ${klass}${j.errorCode ? ` / ${j.errorCode}` : ''}\n` +
				`${j.errorMessage ? `    « ${j.errorMessage.slice(0, 160)} »\n` : ''}`
		);
	}

	console.log(
		`${dead.length} job(s) en dead-letter.\n` +
			`Relancer : npx tsx scripts/jobs-requeue.ts --job=<id> --actor=<qui> --reason="…"\n`
	);
}

async function main() {
	if (DEAD) {
		await showDeadLetter();
		await pool.end();
		return;
	}

	const jobs = await fetchJobs();
	if (jobs.length === 0) {
		console.log('\nAucun job ne correspond.\n');
		await pool.end();
		return;
	}

	console.log('');
	for (const job of jobs) {
		const extras = [
			`${job.attempts}/${job.max_attempts} tentatives`,
			Number(job.deferrals ?? 0) > 0 ? `${job.deferrals} report(s)` : null,
			Number(job.requeued_count ?? 0) > 0 ? `${job.requeued_count} reprise(s)` : null,
			job.last_error_code
				? `dernière erreur ${job.last_error_code}` +
					(job.last_error_class ? ` [${job.last_error_class}]` : '')
				: null
		].filter(Boolean);

		console.log(`job ${job.id}  ${job.type}  (${job.slug})  [${job.status}, ${extras.join(', ')}]`);

		const attempts = await listJobAttempts({ db, jobId: job.id });
		if (attempts.length === 0) {
			console.log('  (aucune tentative journalisée — job antérieur à JOB-002)');
		}
		for (const a of attempts) {
			const cause = a.abandonKind ? `  ${KIND_LABEL[a.abandonKind] ?? a.abandonKind}` : '';
			const err = a.errorCode && !a.abandonKind ? `  ${a.errorCode}` : '';
			const klass = a.errorClass ? `  [${a.errorClass}]` : '';
			const beats = a.heartbeatCount > 0 ? `  (${a.heartbeatCount} battements)` : '';
			const why = a.outcome === 'requeued' ? requeueReason(a.metadataJson) : '';
			console.log(
				`  #${a.attemptNo}  ${a.workerId}  ${hhmmss(a.startedAt)}→${hhmmss(a.finishedAt)}  ` +
					`${OUTCOME_LABEL[a.outcome] ?? a.outcome}${cause}${err}${klass}${beats}${why}`
			);
		}
		console.log('');
	}

	await pool.end();
}

main().catch(async (err) => {
	console.error('Inspection en erreur:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
