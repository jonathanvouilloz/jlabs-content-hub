/**
 * DATA-007 — Application déterministe du DDL additif (drizzle/manual-data-007.sql).
 *
 * Exécute le SQL idempotent (CREATE TABLE / INDEX IF NOT EXISTS) sur la DB Neon.
 * Additif uniquement : aucun DROP, aucune donnée touchée.
 *
 * Lancer : npx tsx scripts/apply-data-007.ts
 * Vérif  : npx tsx scripts/data-001-cartography.ts post-backfill  (attendu 52 tables, zéro dérive)
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

const POLICY_TABLES = ['review_automation_policies', 'policy_promotions'];

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-data-007.sql');
	const sql = readFileSync(sqlPath, 'utf8');

	console.log(`Application de ${sqlPath} …`);
	// node-postgres exécute plusieurs statements dans une même query() (pas de params).
	await pool.query(sql);
	console.log('DDL DATA-007 appliqué (idempotent).');

	// Contrôle rapide : les deux tables existent bien.
	const { rows } = await pool.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		  WHERE table_schema = 'seostats'
		    AND table_name = ANY($1)
		  ORDER BY table_name`,
		[POLICY_TABLES]
	);
	const present = rows.map((r) => r.table_name);
	console.log(`Tables présentes (${present.length}/2) :`, present.join(', ') || '∅');
	if (present.length !== POLICY_TABLES.length) {
		const missing = POLICY_TABLES.filter((t) => !present.includes(t));
		console.error('Manquantes :', missing.join(', '));
		process.exitCode = 1;
	}

	await pool.end();
}

main().catch(async (err) => {
	console.error('Application échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
