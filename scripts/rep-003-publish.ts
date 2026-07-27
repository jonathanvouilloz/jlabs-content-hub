/**
 * REP-003 — Publier / lire le rapport du lundi à la main.
 *
 * Le chemin normal est le cron `/api/cron/tick` (JOB-005), qui tente la publication à chaque
 * battement. Ce script existe pour les trois gestes que le cron ne rend pas :
 *
 *   - `--dry-run`  : voir la DÉCISION (publier ? attendre ? pourquoi ?) sans rien écrire ;
 *   - (sans flag)  : publier le créneau courant, à la main (rattrapage après une panne de cron) ;
 *   - `--show`     : imprimer un rapport PUBLIÉ, tel qu'il a été stocké ;
 *   - `--list`     : les derniers rapports publiés, avec leur SLO.
 *
 * ⚠️ `--show` n'imprime jamais un rapport reconstruit : le texte est rendu à partir du JSON
 * archivé (`renderWeeklyReportText`), donc ce qu'on lit est exactement ce qui a été publié —
 * contrairement à `rep-001-preview.ts`, qui construit le rapport de l'instant présent.
 *
 * Lancer :
 *   npx tsx scripts/rep-003-publish.ts --dry-run
 *   npx tsx scripts/rep-003-publish.ts
 *   npx tsx scripts/rep-003-publish.ts --list
 *   npx tsx scripts/rep-003-publish.ts --show [2026-07-27T09:00] [--json]
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	listPublishedReports,
	loadPublishedReport,
	publishWeeklyReport
} from '../src/lib/server/report-publication.js';
import { renderWeeklyReportText } from '../src/lib/server/weekly-report-state.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
/** Premier argument positionnel (le créneau de `--show`). */
const positional = args.find((a) => !a.startsWith('--')) ?? undefined;

const minutes = (ms: number) => `${Math.round(ms / 60000)} min`;

async function main(): Promise<void> {
	if (flag('list')) {
		const rows = await listPublishedReports({ db, limit: 20 });
		if (rows.length === 0) {
			console.log('Aucun rapport publié.');
			return;
		}
		for (const r of rows) {
			console.log(
				`${r.periodSlot}  ${r.status.padEnd(8)}  SLO ${r.slo.met ? 'tenu ' : 'manqué'}` +
					`  latence ${minutes(r.slo.latencyMs).padStart(8)}` +
					`  attendus ${r.readiness?.expected ?? '?'}` +
					`  prêts ${r.readiness?.ready ?? '?'}` +
					`  incidents ${r.readiness?.incidents.length ?? '?'}`
			);
		}
		return;
	}

	if (flag('show')) {
		const published = await loadPublishedReport({ db, periodSlot: positional });
		if (!published) {
			console.log(positional ? `Aucun rapport pour ${positional}.` : 'Aucun rapport publié.');
			return;
		}
		if (flag('json')) {
			console.log(JSON.stringify(published, null, 2));
			return;
		}
		console.log(
			`# ${published.periodSlot} — ${published.status.toUpperCase()} · publié ${published.publishedAt}` +
				` · échéance ${published.dueAt} · SLO ${published.slo.met ? 'tenu' : `manqué de ${minutes(published.slo.lateMs)}`}`
		);
		if (published.readiness) {
			console.log(
				`# attendus ${published.readiness.expected} · prêts ${published.readiness.ready}` +
					` · dégradés ${published.readiness.degraded} · en attente ${published.readiness.waiting}` +
					` · absents ${published.readiness.missing}` +
					(published.readiness.paused.length > 0
						? ` · écartés (pause) ${published.readiness.paused.join(', ')}`
						: '')
			);
			for (const incident of published.readiness.incidents) {
				console.log(`#   ⚠ ${incident.projectSlug} — ${incident.detail}`);
			}
		}
		console.log('');
		console.log(renderWeeklyReportText(published.report));
		return;
	}

	const result = await publishWeeklyReport({ db, dryRun: flag('dry-run') });
	console.log(`créneau      : ${result.periodSlot ?? '∅ (cadence hebdo désactivée)'}`);
	console.log(`décision     : ${result.action} (${result.reason})${result.dryRun ? ' [dry-run]' : ''}`);
	console.log(`statut       : ${result.status ?? '—'}`);
	console.log(`échéance     : ${result.dueAtDb ?? '—'}`);
	console.log(`publié à     : ${result.publishedAtDb ?? '—'}`);
	if (result.slo) {
		console.log(
			`SLO          : ${result.slo.met ? 'tenu' : `manqué de ${minutes(result.slo.lateMs)}`} · latence ${minutes(result.slo.latencyMs)}`
		);
	}
	if (result.readiness) {
		console.log(
			`préparation  : attendus ${result.readiness.expected} · prêts ${result.readiness.ready}` +
				` · dégradés ${result.readiness.degraded} · en attente ${result.readiness.waiting}` +
				` · absents ${result.readiness.missing}`
		);
		if (result.readiness.blockers.length > 0) {
			console.log(`bloquants    : ${result.readiness.blockers.join(', ')}`);
		}
		if (result.readiness.paused.length > 0) {
			console.log(`écartés      : ${result.readiness.paused.join(', ')} (pause)`);
		}
	}
	if (result.announcement) {
		console.log('');
		console.log(result.announcement.lines.join('\n'));
	}
}

main()
	.catch((e) => {
		console.error(e);
		process.exitCode = 1;
	})
	.finally(async () => {
		await pool.end();
	});
