/**
 * JOB-003 — Reprise d'un job depuis la dead-letter (action de reprise).
 *
 * Un job `dead` est un cul-de-sac : rien ne le relance. Ce script est l'action
 * manquante, en attendant que la console d'exploitation (JOB-007) l'expose dans
 * l'interface — elle appellera exactement la même fonction.
 *
 * Le compteur `attempts` repart à zéro (sans quoi le job retomberait en
 * dead-letter au premier échec), mais RIEN de l'historique n'est effacé : le
 * journal `job_attempts` est append-only, et la reprise y ajoute sa propre ligne
 * (qui a relancé, quand, pourquoi).
 *
 * Lancer (annonce) : npx tsx scripts/jobs-requeue.ts --job=<id> --dry-run
 * Lancer (réel)    : npx tsx scripts/jobs-requeue.ts --job=<id> --actor=<qui> --reason="…"
 *
 * Voir d'abord ce qui est mort : npx tsx scripts/jobs-inspect.ts --dead
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { requeueDeadJob } from '../src/lib/server/jobs-claim.js';
import { listJobAttempts } from '../src/lib/server/jobs-lease.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const JOB_ID = arg('job');
const DRY_RUN = args.includes('--dry-run');
const ACTOR = arg('actor') ?? 'user:cli';
const REASON = arg('reason');

if (!JOB_ID) {
	console.error('Usage : --job=<id> [--actor=<qui>] [--reason="…"] [--dry-run]');
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
	deferrals: number;
	requeued_count: number;
	last_error_class: string | null;
	last_error_code: string | null;
	last_error_message: string | null;
	slug: string;
}

async function main() {
	const res = await db.execute(sql`
		SELECT j.id, j.type, j.status, j.attempts, j.max_attempts, j.deferrals, j.requeued_count,
		       j.last_error_class, j.last_error_code, j.last_error_message, p.slug
		  FROM "seostats"."jobs" AS j
		  JOIN "seostats"."projects" AS p ON p.id = j.project_id
		 WHERE j.id = ${JOB_ID}
	`);
	const job = ((res.rows ?? []) as unknown as JobRow[])[0];

	if (!job) {
		console.error(`\nAucun job ${JOB_ID}.\n`);
		await pool.end();
		process.exit(1);
	}

	console.log(
		`\n=== JOB-003 — reprise ${DRY_RUN ? '(DRY-RUN, aucune écriture)' : '(réelle)'} ===\n\n` +
			`  job ${job.id}  ${job.type}  (${job.slug})\n` +
			`  statut : ${job.status}  ·  ${job.attempts}/${job.max_attempts} tentatives  ·  ` +
			`${job.deferrals} report(s)  ·  ${job.requeued_count} reprise(s)\n` +
			`  dernière erreur : ${job.last_error_class ?? '—'} / ${job.last_error_code ?? '—'}\n` +
			`  ${job.last_error_message ? `« ${job.last_error_message.slice(0, 160)} »` : ''}\n`
	);

	if (job.status !== 'dead' && job.status !== 'failed') {
		console.error(`Ce job n'est pas en dead-letter (statut « ${job.status} ») — rien à reprendre.\n`);
		await pool.end();
		process.exit(1);
	}

	// Une erreur d'auth ou structurelle re-tombera à l'identique si la cause n'a pas
	// été corrigée : le dire, sans l'interdire (c'est l'humain qui sait).
	if (job.last_error_class === 'auth' || job.last_error_class === 'permanent') {
		console.log(
			`  ⚠ Erreur ${job.last_error_class} : la reprise échouera à l'identique si la cause\n` +
				`    (token, permission, configuration) n'a pas été corrigée entre-temps.\n`
		);
	}

	if (DRY_RUN) {
		console.log(
			`Serait fait : statut → queued · attempts ${job.attempts} → 0 · deferrals ${job.deferrals} → 0 ·\n` +
				`  disponible immédiatement · 1 ligne « requeued » ajoutée au journal (acteur ${ACTOR}).\n` +
				`\nRien n'a été écrit. Relancer sans --dry-run pour appliquer.\n`
		);
		await pool.end();
		return;
	}

	const result = await requeueDeadJob({ db, jobId: JOB_ID!, actor: ACTOR, reason: REASON });
	if (!result) {
		console.error('Reprise refusée (le job a changé d’état entre-temps).\n');
		await pool.end();
		process.exit(1);
	}

	console.log(
		`Job remis en file. Reprise n°${result.requeuedCount} par ${ACTOR}` +
			`${REASON ? ` — « ${REASON} »` : ''}.\n`
	);

	const attempts = await listJobAttempts({ db, jobId: JOB_ID! });
	console.log(`Historique conservé : ${attempts.length} ligne(s) au journal.`);
	for (const a of attempts) {
		console.log(
			`  #${a.attemptNo}  ${a.workerId}  ${a.outcome}` +
				`${a.errorClass ? `  [${a.errorClass}]` : ''}${a.errorCode ? `  ${a.errorCode}` : ''}`
		);
	}
	console.log('\nLe job repartira au prochain lancement de worker (npx tsx scripts/worker.ts --once).\n');

	await pool.end();
}

main().catch(async (err) => {
	console.error('Reprise en erreur:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
