/**
 * JOB-005 — Runner du scheduler. DRY-RUN par défaut.
 *
 * Deux lectures dans une commande :
 *   - ce qui est DÛ dans la fenêtre de rattrapage (et serait mis en file) ;
 *   - la PROCHAINE exécution par projet et par cadence — l'acceptation « la prochaine
 *     exécution est visible par projet », lisible sans ouvrir le navigateur.
 *
 * Le dry-run est le défaut (idiome `purge.ts` / `jobs-purge-test.ts`) : planifier
 * écrit dans la vraie file, et un `--now` mal choisi enfilerait des jobs pour un
 * créneau passé. Rien d'irréversible cela dit — la clé d'idempotence rend un rejeu
 * inoffensif, et `/jobs` permet d'annuler.
 *
 * Lancer (dry-run) : npx tsx scripts/schedule.ts
 * Planifier        : npx tsx scripts/schedule.ts --execute
 * Options          : --now=<ISO>  --project=<slug>  --lookback-hours=N  --next-only
 *
 * `--now` fige la référence de temps : c'est ainsi qu'on rejoue un dimanche de
 * changement d'heure sans attendre le mois de mars.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { listNextOccurrences, planDueJobs } from '../src/lib/server/scheduler.js';
import { BUSINESS_TIMEZONE, DEFAULT_LOOKBACK_MS } from '../src/lib/server/schedule-state.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const EXECUTE = args.includes('--execute');
const NEXT_ONLY = args.includes('--next-only');
const PROJECT = arg('project');
const LOOKBACK_MS = arg('lookback-hours')
	? Number(arg('lookback-hours')) * 60 * 60 * 1000
	: DEFAULT_LOOKBACK_MS;

const nowArg = arg('now');
const NOW = nowArg ? new Date(nowArg) : new Date();
if (Number.isNaN(NOW.getTime())) {
	console.error(`--now="${nowArg}" n'est pas une date valide. Abandon.`);
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

function fmtLocal(instantMs: number): string {
	return new Intl.DateTimeFormat('fr-CH', {
		timeZone: BUSINESS_TIMEZONE,
		dateStyle: 'short',
		timeStyle: 'short'
	}).format(new Date(instantMs));
}

async function showNext(): Promise<void> {
	const rows = await listNextOccurrences({ db, now: NOW });
	console.log('\n=== Prochaine exécution par projet ===\n');

	let currentSlug = '';
	for (const row of rows) {
		if (row.projectSlug !== currentSlug) {
			currentSlug = row.projectSlug;
			console.log(`── ${row.projectName} (${row.projectSlug})`);
		}
		if (!row.enabled) {
			console.log(`     ${row.cadence.padEnd(8)} désactivé pour ce projet`);
			continue;
		}
		// Une cadence non câblée se calcule mais ne produit aucun job : le dire ici
		// évite d'attendre un run qui ne viendra pas.
		const suffix = row.wired ? '' : '  (aucun job câblé)';
		console.log(
			`     ${row.cadence.padEnd(8)} ${row.localSlot} ${BUSINESS_TIMEZONE}` +
				`  ·  ${row.instantDb} UTC${suffix}`
		);
	}
}

async function main() {
	console.log(
		`\nRéférence : ${NOW.toISOString()} (UTC) · ${fmtLocal(NOW.getTime())} ${BUSINESS_TIMEZONE}`
	);
	console.log(
		`Fenêtre de rattrapage : ${Math.round(LOOKBACK_MS / 3_600_000)} h` +
			(PROJECT ? ` · projet : ${PROJECT}` : '') +
			(EXECUTE ? ' · MODE RÉEL' : ' · dry-run (aucune écriture)')
	);

	if (!NEXT_ONLY) {
		const plan = await planDueJobs({
			db,
			now: NOW,
			lookbackMs: LOOKBACK_MS,
			dryRun: !EXECUTE,
			onlyProjectSlug: PROJECT
		});

		console.log(`\n=== Occurrences dues (${plan.sinceDb} → ${plan.nowDb} UTC) ===\n`);
		if (plan.occurrences.length === 0) {
			console.log(`Aucune occurrence due sur ${plan.projects} projet(s).`);
		}
		for (const occ of plan.occurrences) {
			const flags = [
				occ.adjusted ? 'CRÉNEAU DÉCALÉ (heure inexistante)' : '',
				occ.ambiguous ? 'heure doublée (1re occurrence retenue)' : ''
			]
				.filter(Boolean)
				.join(' · ');
			console.log(
				`• ${occ.projectSlug} — ${occ.cadence} · ${occ.localSlot} ${BUSINESS_TIMEZONE}` +
					` (${occ.instantDb} UTC)${flags ? ` — ${flags}` : ''}`
			);
			console.log(`    run : ${occ.runId ?? '(dry-run)'}${occ.runCreated ? ' [créé]' : occ.runId ? ' [réutilisé]' : ''}`);
			for (const job of occ.jobs) {
				console.log(
					`    job : ${job.jobType} → ${job.jobId}` +
						(EXECUTE ? (job.created ? ' [mis en file]' : ' [déjà en file]') : '')
				);
			}
		}

		const c = plan.counters;
		console.log(
			`\nBilan : ${c.occurrences} occurrence(s) · runs ${c.runsCreated} créés / ${c.runsReused} réutilisés` +
				` · jobs ${c.jobsCreated} créés / ${c.jobsReused} déjà en file`
		);
		if (plan.cadencesWithoutJob.length > 0) {
			console.log(
				`Cadences écartées (aucun handler à ce jour) : ${plan.cadencesWithoutJob.join(', ')}.`
			);
		}
		if (plan.failures.length > 0) {
			console.log(`\n⚠ ${plan.failures.length} projet(s) en échec (les autres ont été traités) :`);
			for (const f of plan.failures) console.log(`   • ${f.slug} : ${f.error}`);
		}
		if (!EXECUTE) {
			console.log('\n(dry-run : aucune écriture. Ajouter --execute pour planifier réellement.)');
		} else {
			console.log('\nRappel : mettre en file ne suffit pas à exécuter — le drain se fait au tick');
			console.log('(`/api/cron/tick`) ou à la main : npx tsx scripts/worker.ts --once');
		}
	}

	await showNext();
	await pool.end();
}

main().catch(async (err) => {
	console.error('Scheduler en erreur:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
