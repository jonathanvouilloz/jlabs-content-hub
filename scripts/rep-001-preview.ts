/**
 * REP-001 — Aperçu : imprime le rapport hebdomadaire rendu, tel qu'il sortira.
 *
 * Lecture SEULE, aucune écriture. Existe pour une raison précise : le cockpit n'a jamais été
 * vu à l'œil (pas de session admin), et un rapport est le premier livrable de ce parc qui se
 * lit intégralement sans écran. L'imprimer est donc la seule inspection visuelle possible.
 *
 * Lancer : npx tsx scripts/rep-001-preview.ts [--json]
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { loadWeeklyReport } from '../src/lib/server/weekly-report.js';
import { renderWeeklyReportText } from '../src/lib/server/weekly-report-state.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

async function main(): Promise<void> {
	const report = await loadWeeklyReport({ db });
	if (process.argv.includes('--json')) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	console.log(renderWeeklyReportText(report));
}

main()
	.catch((e) => {
		console.error(e);
		process.exitCode = 1;
	})
	.finally(async () => {
		await pool.end();
	});
