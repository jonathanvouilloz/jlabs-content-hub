/**
 * FIND-003 — Application déterministe du DDL additif (drizzle/manual-find-003.sql).
 *
 * Exécute le SQL idempotent (ADD COLUMN / CREATE INDEX IF NOT EXISTS) sur la DB Neon.
 * Additif uniquement : aucune table créée, aucun DROP, aucune donnée touchée.
 *
 * Lancer : npx tsx scripts/apply-find-003.ts
 * Vérif  : npx tsx scripts/data-001-cartography.ts post-find-003  (attendu 55 tables, zéro dérive)
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

const LIFECYCLE_COLUMNS = [
	'snoozed_until',
	'snooze_reason',
	'consecutive_misses',
	'reopen_count',
	'dismissal_category'
];

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-find-003.sql');
	const sql = readFileSync(sqlPath, 'utf8');

	console.log(`Application de ${sqlPath} …`);
	// node-postgres exécute plusieurs statements dans une même query() (pas de params).
	await pool.query(sql);
	console.log('DDL FIND-003 appliqué (idempotent).');

	// Contrôle : les 5 colonnes existent (la cartographie compare les TABLES, pas les colonnes).
	const { rows } = await pool.query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = 'seostats'
		    AND table_name = 'findings'
		    AND column_name = ANY($1)
		  ORDER BY column_name`,
		[LIFECYCLE_COLUMNS]
	);
	const present = rows.map((r) => r.column_name);
	console.log(
		`Colonnes présentes (${present.length}/${LIFECYCLE_COLUMNS.length}) :`,
		present.join(', ') || '∅'
	);
	if (present.length !== LIFECYCLE_COLUMNS.length) {
		console.error('Manquantes :', LIFECYCLE_COLUMNS.filter((c) => !present.includes(c)).join(', '));
		process.exitCode = 1;
	}

	// Et l'index partiel d'expiration de veille.
	const idx = await pool.query<{ indexname: string }>(
		`SELECT indexname FROM pg_indexes
		  WHERE schemaname = 'seostats' AND indexname = 'idx_findings_snoozed_until'`
	);
	console.log(`Index idx_findings_snoozed_until : ${idx.rows.length ? 'présent' : 'ABSENT'}`);
	if (idx.rows.length === 0) process.exitCode = 1;

	await pool.end();
}

main().catch(async (err) => {
	console.error('Application échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
