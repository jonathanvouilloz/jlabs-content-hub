/**
 * DATA-004 — Application déterministe du DDL additif (drizzle/manual-data-004.sql).
 *
 * Exécute le SQL idempotent (CREATE TABLE / INDEX IF NOT EXISTS) sur la DB Neon.
 * Additif uniquement : aucun DROP, aucune donnée touchée.
 *
 * Lancer : npx tsx scripts/apply-data-004.ts
 * Vérif  : npx tsx scripts/data-001-cartography.ts 2026-07-21  (attendu 45 tables, zéro dérive)
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

const OBS_TABLES = [
	'gsc_query_page_observations',
	'gsc_page_observations',
	'index_observations',
	'sitemap_observations',
	'plausible_page_observations',
	'keyword_rank_observations',
	'backlink_observations',
	'ai_visibility_observations',
	'gmb_review_observations',
	'gmb_insight_observations'
];

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-data-004.sql');
	const sql = readFileSync(sqlPath, 'utf8');

	console.log(`Application de ${sqlPath} …`);
	// node-postgres exécute plusieurs statements dans une même query() (pas de params).
	await pool.query(sql);
	console.log('DDL DATA-004 appliqué (idempotent).');

	// Contrôle rapide : les dix tables existent bien.
	const { rows } = await pool.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		  WHERE table_schema = 'seostats'
		    AND table_name = ANY($1)
		  ORDER BY table_name`,
		[OBS_TABLES]
	);
	const present = rows.map((r) => r.table_name);
	console.log(`Tables présentes (${present.length}/10) :`, present.join(', ') || '∅');
	if (present.length !== OBS_TABLES.length) {
		const missing = OBS_TABLES.filter((t) => !present.includes(t));
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
