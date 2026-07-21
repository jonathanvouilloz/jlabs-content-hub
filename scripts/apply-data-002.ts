/**
 * DATA-002 — Application déterministe du DDL additif (drizzle/manual-data-002.sql).
 *
 * Exécute le SQL idempotent (CREATE TABLE / INDEX IF NOT EXISTS) sur la DB Neon.
 * Additif uniquement : aucun DROP, aucune donnée touchée.
 *
 * Lancer : npx tsx scripts/apply-data-002.ts
 * Vérif  : npx tsx scripts/data-001-cartography.ts 2026-07-21  (attendu 32 tables, zéro dérive)
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

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-data-002.sql');
	const sql = readFileSync(sqlPath, 'utf8');

	console.log(`Application de ${sqlPath} …`);
	// node-postgres exécute plusieurs statements dans une même query() (pas de params).
	await pool.query(sql);
	console.log('DDL DATA-002 appliqué (idempotent).');

	// Contrôle rapide : les deux tables existent bien.
	const { rows } = await pool.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		  WHERE table_schema = 'seostats'
		    AND table_name IN ('project_integrations', 'project_projections')
		  ORDER BY table_name`
	);
	console.log('Tables présentes :', rows.map((r) => r.table_name).join(', ') || '∅');

	await pool.end();
}

main().catch(async (err) => {
	console.error('Application échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
