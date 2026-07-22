/**
 * JOB-003 — Application déterministe du DDL additif (drizzle/manual-job-003.sql).
 *
 * Exécute le SQL idempotent (ADD COLUMN / CREATE INDEX IF NOT EXISTS) sur la DB Neon.
 * Additif uniquement : aucune table créée, aucun DROP, aucune donnée touchée.
 *
 * Lancer : npx tsx scripts/apply-job-003.ts
 * Vérif  : npx tsx scripts/data-001-cartography.ts post-job-003  (attendu 57 tables, zéro dérive)
 *
 * La cartographie compare les TABLES, pas les colonnes : ce script vérifie donc
 * lui-même ses 4 colonnes et son index partiel.
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

/** Colonnes attendues, par table. */
const EXPECTED: Record<string, string[]> = {
	jobs: ['last_error_class', 'deferrals', 'requeued_count'],
	job_attempts: ['error_class']
};

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-job-003.sql');
	const sql = readFileSync(sqlPath, 'utf8');

	console.log(`Application de ${sqlPath} …`);
	// node-postgres exécute plusieurs statements dans une même query() (pas de params).
	await pool.query(sql);
	console.log('DDL JOB-003 appliqué (idempotent).');

	let total = 0;
	let found = 0;
	for (const [table, columns] of Object.entries(EXPECTED)) {
		total += columns.length;
		const { rows } = await pool.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			  WHERE table_schema = 'seostats'
			    AND table_name = $1
			    AND column_name = ANY($2)
			  ORDER BY column_name`,
			[table, columns]
		);
		const present = rows.map((r) => r.column_name);
		found += present.length;
		console.log(`  ${table} (${present.length}/${columns.length}) : ${present.join(', ') || '∅'}`);
		if (present.length !== columns.length) {
			console.error('  Manquantes :', columns.filter((c) => !present.includes(c)).join(', '));
			process.exitCode = 1;
		}
	}
	console.log(`Colonnes présentes : ${found}/${total}`);

	// Et l'index partiel du listing dead-letter.
	const idx = await pool.query<{ indexname: string }>(
		`SELECT indexname FROM pg_indexes
		  WHERE schemaname = 'seostats' AND indexname = 'idx_jobs_dead'`
	);
	console.log(`Index idx_jobs_dead : ${idx.rows.length ? 'présent' : 'ABSENT'}`);
	if (idx.rows.length === 0) process.exitCode = 1;

	await pool.end();
}

main().catch(async (err) => {
	console.error('Application échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
