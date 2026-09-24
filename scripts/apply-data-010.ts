/**
 * DATA-010 - applique le DDL additif de l'API agent avis v1.
 * Ce script n'est jamais lance automatiquement et cible la base indiquee par DATABASE_URL.
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
const TABLES = [
	'review_reply_delivery_events',
	'review_mention_candidates',
	'review_monthly_reports'
];

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const ddl = readFileSync(join(here, '..', 'drizzle', 'manual-data-010.sql'), 'utf8');
	await pool.query(ddl);
	const { rows } = await pool.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = 'seostats' AND table_name = ANY($1)
		 ORDER BY table_name`,
		[TABLES]
	);
	const present = rows.map((row) => row.table_name);
	console.log(`Tables presentes (${present.length}/${TABLES.length}) : ${present.join(', ') || 'aucune'}`);
	if (present.length !== TABLES.length) process.exitCode = 1;
	await pool.end();
}

main().catch(async (error) => {
	console.error('Application DATA-010 echouee:', error);
	await pool.end().catch(() => {});
	process.exit(1);
});
