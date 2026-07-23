/**
 * JOB-006 — Application déterministe du DDL additif (drizzle/manual-job-006.sql).
 *
 * Crée `seostats.system_settings` (KV de portée système) si elle n'existe pas. Aucune
 * donnée migrée, aucun DROP, aucune colonne existante touchée. La table naît VIDE : sans
 * ligne, `resolveLimits` rend les défauts de `job-limits.ts`, donc appliquer ce DDL ne
 * change strictement aucun comportement — c'est y écrire qui en change un.
 *
 * Lancer : npx tsx scripts/apply-job-006.ts
 * Vérif  : npx tsx scripts/data-001-cartography.ts post-job-006  (attendu 58 tables)
 *
 * ⚠ C'est le premier lot depuis JOB-003 à toucher au schéma : l'introspection passera de
 *   57 à 58 tables. L'écart est ATTENDU, et il doit être exactement `system_settings`.
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

const EXPECTED_COLUMNS = ['key', 'value', 'description', 'updated_at'];

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-job-006.sql');
	const sql = readFileSync(sqlPath, 'utf8');

	console.log(`Application de ${sqlPath} …`);
	await pool.query(sql);
	console.log('DDL JOB-006 appliqué (idempotent).');

	const { rows } = await pool.query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = 'seostats' AND table_name = 'system_settings'
		  ORDER BY column_name`
	);
	const present = rows.map((r) => r.column_name);
	console.log(`  system_settings (${present.length}/${EXPECTED_COLUMNS.length}) : ${present.join(', ') || '∅'}`);
	const missing = EXPECTED_COLUMNS.filter((c) => !present.includes(c));
	if (missing.length > 0) {
		console.error('  Manquantes :', missing.join(', '));
		process.exitCode = 1;
	}

	// La table doit être VIDE après application : ce script ne sème rien. Un contenu
	// préexistant n'est pas une erreur (réapplication), mais il doit se voir.
	const { rows: countRows } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM "seostats"."system_settings"`
	);
	console.log(`  lignes : ${countRows[0]?.n ?? '?'} (0 attendu à la première application)`);

	await pool.end();
}

main().catch(async (err) => {
	console.error('Application échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
