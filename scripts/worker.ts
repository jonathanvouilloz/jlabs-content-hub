/**
 * JOB-001 — Worker de la queue durable.
 *
 * Réclame les jobs disponibles (FOR UPDATE SKIP LOCKED) et les exécute via le
 * registre de handlers. Démo bout-en-bout de la chaîne agentique :
 *   enqueue `detect:keyword_opportunity` → worker → détecteur → findings.
 *
 * Lancer (un passage)  : npx tsx scripts/worker.ts --once
 * Lancer (en continu)  : npx tsx scripts/worker.ts
 * Mettre un job en file: npx tsx scripts/worker.ts --enqueue=<slug> [--weeks=4]
 *                        npx tsx scripts/worker.ts --enqueue=<slug> --job=lifecycle
 * Options              : --types=a,b  --lease-ms=300000  --poll-ms=2000  --max-jobs=N
 *
 * Ctrl-C = arrêt gracieux : plus aucune réclamation, le job en cours est terminé
 * (ou relâché s'il n'avait pas commencé) → aucun job fantôme.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { eq } from 'drizzle-orm';
import { hostname } from 'node:os';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	runWorker,
	JOB_TYPE_DETECT_KEYWORD_OPPORTUNITY,
	JOB_TYPE_FINDINGS_LIFECYCLE
} from '../src/lib/server/job-runner.js';
import { deriveWorkerId } from '../src/lib/server/job-state.js';
import { enqueueJob } from '../src/lib/server/monitoring.js';
import { deriveIdempotencyKey } from '../src/lib/server/monitoring-state.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const ONCE = args.includes('--once');
const ENQUEUE = arg('enqueue');
const JOB = arg('job'); // 'lifecycle' | défaut : détection
const WEEKS = Number(arg('weeks') ?? 4);
const TYPES = arg('types')?.split(',').filter(Boolean);
const LEASE_MS = Number(arg('lease-ms') ?? 300_000);
const POLL_MS = Number(arg('poll-ms') ?? 2000);
const MAX_JOBS = Number(arg('max-jobs') ?? 0);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

/** Met un job en file pour un projet (clé d'idempotence = pas de doublon). */
async function enqueueForProject(slug: string, jobType: string): Promise<void> {
	const rows = await db
		.select({ id: schema.projects.id, slug: schema.projects.slug })
		.from(schema.projects)
		.where(eq(schema.projects.slug, slug));
	if (rows.length === 0) throw new Error(`Projet "${slug}" introuvable.`);

	const today = new Date().toISOString().slice(0, 10);
	const res = await enqueueJob(
		{
			projectId: rows[0].id,
			type: jobType,
			idempotencyKey: deriveIdempotencyKey({
				runType: 'manual',
				projectSlug: rows[0].slug,
				periodEnd: today,
				stepType: jobType,
				schemaVersion: 1
			}),
			payloadJson: JSON.stringify({ weeks: WEEKS }),
			priority: 10
		},
		db
	);
	console.log(
		res.created
			? `Job "${jobType}" mis en file pour "${slug}" (${res.id}).`
			: `Job "${jobType}" déjà en file pour "${slug}" (${res.id}) — clé d'idempotence identique.`
	);
}

async function main() {
	if (ENQUEUE) {
		// --job=lifecycle : expiration des veilles (FIND-003), sans détection.
		await enqueueForProject(
			ENQUEUE,
			JOB === 'lifecycle' ? JOB_TYPE_FINDINGS_LIFECYCLE : JOB_TYPE_DETECT_KEYWORD_OPPORTUNITY
		);
		await pool.end();
		return;
	}

	const workerId = deriveWorkerId({
		host: hostname(),
		pid: process.pid,
		nonce: Math.random().toString(36).slice(2, 8)
	});

	// Arrêt gracieux : le signal coupe la réclamation, pas l'exécution en cours.
	const controller = new AbortController();
	let stopping = false;
	const stop = (sig: string) => {
		if (stopping) {
			console.log('\nSecond signal — arrêt immédiat.');
			process.exit(130);
		}
		stopping = true;
		console.log(`\n${sig} reçu — arrêt gracieux (fin du job en cours)…`);
		controller.abort();
	};
	process.on('SIGINT', () => stop('SIGINT'));
	process.on('SIGTERM', () => stop('SIGTERM'));

	console.log(
		`\n=== worker ${workerId} — ${ONCE ? 'un passage' : 'continu'} ` +
			`(bail ${LEASE_MS} ms · sondage ${POLL_MS} ms) ===\n`
	);

	const stats = await runWorker({
		db,
		workerId,
		types: TYPES,
		leaseMs: LEASE_MS,
		pollIntervalMs: POLL_MS,
		once: ONCE,
		maxJobs: MAX_JOBS,
		signal: controller.signal
	});

	console.log(
		`\nRésumé : ${stats.claimed} réclamés · ${stats.succeeded} réussis · ` +
			`${stats.failed} échoués (dont ${stats.deadLettered} dead-letter) · ` +
			`${stats.released} relâchés · ${stats.idleTicks} tours à vide` +
			(stats.stoppedGracefully ? ' · arrêt gracieux' : '')
	);
	await pool.end();
}

main().catch(async (err) => {
	console.error('Worker en erreur:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
