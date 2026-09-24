/**
 * DATA-009 — Application déterministe du DDL GMB-004→007.
 *
 * Additif/idempotent : crée les candidats et livraisons sans modifier les avis.
 * Lancer explicitement après revue : npx tsx scripts/apply-data-009.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TABLES = ['review_reply_proposals', 'review_reply_deliveries'];

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sql = readFileSync(join(here, '..', 'drizzle', 'manual-data-009.sql'), 'utf8');
	await pool.query(sql);

	const { rows } = await pool.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = 'seostats' AND table_name = ANY($1)
		 ORDER BY table_name`,
		[TABLES]
	);
	const present = rows.map((row) => row.table_name);
	console.log(`Tables présentes (${present.length}/${TABLES.length}) : ${present.join(', ') || '∅'}`);
	if (present.length !== TABLES.length) {
		console.error(`Manquantes : ${TABLES.filter((table) => !present.includes(table)).join(', ')}`);
		process.exitCode = 1;
	}
	await pool.end();
}

main().catch(async (error) => {
	console.error('Application DATA-009 échouée:', error);
	await pool.end().catch(() => {});
	process.exit(1);
});
