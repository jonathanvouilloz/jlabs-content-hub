/**
 * JOB-002 — Application déterministe du DDL additif (drizzle/manual-job-002.sql).
 *
 * Exécute le SQL idempotent (CREATE TABLE / CREATE INDEX IF NOT EXISTS) sur la DB Neon.
 * Additif uniquement : aucune table modifiée, aucun DROP, aucune donnée touchée.
 *
 * Lancer : npx tsx scripts/apply-job-002.ts
 * Vérif  : npx tsx scripts/data-001-cartography.ts post-job-002  (attendu 57 tables, zéro dérive)
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

const TABLES = ['job_attempts', 'job_effects'];
const INDEXES = [
	'idx_job_attempts_job',
	'idx_job_attempts_outcome',
	'job_effects_key_unique',
	'idx_job_effects_job'
];

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-job-002.sql');
	const sql = readFileSync(sqlPath, 'utf8');

	console.log(`Application de ${sqlPath} …`);
	// node-postgres exécute plusieurs statements dans une même query() (pas de params).
	await pool.query(sql);
	console.log('DDL JOB-002 appliqué (idempotent).');

	const { rows: tableRows } = await pool.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		  WHERE table_schema = 'seostats' AND table_name = ANY($1)
		  ORDER BY table_name`,
		[TABLES]
	);
	const tables = tableRows.map((r) => r.table_name);
	console.log(`Tables présentes (${tables.length}/${TABLES.length}) :`, tables.join(', ') || '∅');
	if (tables.length !== TABLES.length) {
		console.error('Manquantes :', TABLES.filter((t) => !tables.includes(t)).join(', '));
		process.exitCode = 1;
	}

	const { rows: idxRows } = await pool.query<{ indexname: string }>(
		`SELECT indexname FROM pg_indexes
		  WHERE schemaname = 'seostats' AND indexname = ANY($1)
		  ORDER BY indexname`,
		[INDEXES]
	);
	const indexes = idxRows.map((r) => r.indexname);
	console.log(`Index présents (${indexes.length}/${INDEXES.length}) :`, indexes.join(', ') || '∅');
	if (indexes.length !== INDEXES.length) {
		console.error('Manquants :', INDEXES.filter((i) => !indexes.includes(i)).join(', '));
		process.exitCode = 1;
	}

	await pool.end();
}

main().catch(async (err) => {
	console.error('Application échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
