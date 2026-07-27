/**
 * REP-003 — Application déterministe du DDL additif (drizzle/manual-rep-003.sql).
 *
 * Crée `seostats.weekly_reports` (le rapport du lundi, publié) si elle n'existe pas. Aucune
 * donnée migrée, aucun DROP, aucune colonne existante touchée. La table naît VIDE : sans
 * ligne, `loadPublishedReport` rend `null` et le tick publie au prochain créneau — appliquer
 * ce DDL ne change donc aucun comportement. C'est le PREMIER créneau qui en change un.
 *
 * Lancer : npx tsx scripts/apply-rep-003.ts
 * Vérif  : npx tsx scripts/data-001-cartography.ts post-rep-003   (attendu 61 tables)
 *
 * ⚠ L'introspection passe de 60 à 61 tables `seostats`. L'écart est ATTENDU, et il doit être
 *   exactement `weekly_reports`. Rappel de la convention (DECISIONS.md, DATA-002) : SQL
 *   additif idempotent + ce script, JAMAIS `db:push` (interactif, moins déterministe sous
 *   Windows — et depuis le cutover Neon, un `db:push` depuis `main` est un risque de PROD).
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

const EXPECTED_COLUMNS = [
	'created_at',
	'due_at',
	'id',
	'payload_json',
	'period_slot',
	'published_at',
	'readiness_json',
	'report_schema_version',
	'schema_version',
	'slot_at',
	'status'
];

const EXPECTED_INDEXES = ['idx_weekly_reports_published', 'weekly_reports_period_unique'];

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-rep-003.sql');
	const sql = readFileSync(sqlPath, 'utf8');

	console.log(`Application de ${sqlPath} …`);
	await pool.query(sql);
	console.log('DDL REP-003 appliqué (idempotent).');

	const { rows } = await pool.query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = 'seostats' AND table_name = 'weekly_reports'
		  ORDER BY column_name`
	);
	const present = rows.map((r) => r.column_name);
	console.log(
		`  colonnes (${present.length}/${EXPECTED_COLUMNS.length}) : ${present.join(', ') || '∅'}`
	);
	const missing = EXPECTED_COLUMNS.filter((c) => !present.includes(c));
	if (missing.length > 0) {
		console.error('  Manquantes :', missing.join(', '));
		process.exitCode = 1;
	}

	const { rows: idxRows } = await pool.query<{ indexname: string }>(
		`SELECT indexname FROM pg_indexes
		  WHERE schemaname = 'seostats' AND tablename = 'weekly_reports'
		  ORDER BY indexname`
	);
	const idx = idxRows.map((r) => r.indexname);
	console.log(`  index : ${idx.join(', ') || '∅'}`);
	const missingIdx = EXPECTED_INDEXES.filter((i) => !idx.includes(i));
	if (missingIdx.length > 0) {
		console.error('  Index manquants :', missingIdx.join(', '));
		process.exitCode = 1;
	}

	// La table doit être VIDE après application : ce script ne sème rien. Un contenu
	// préexistant n'est pas une erreur (réapplication), mais il doit se voir.
	const { rows: countRows } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM "seostats"."weekly_reports"`
	);
	console.log(`  lignes : ${countRows[0]?.n ?? '?'} (0 attendu à la première application)`);

	// L'écart d'introspection doit être CETTE table et rien d'autre.
	const { rows: tableRows } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM information_schema.tables
		  WHERE table_schema = 'seostats' AND table_type = 'BASE TABLE'`
	);
	console.log(`  tables seostats : ${tableRows[0]?.n ?? '?'} (61 attendu après ce lot)`);

	await pool.end();
}

main().catch(async (err) => {
	console.error('Application échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
