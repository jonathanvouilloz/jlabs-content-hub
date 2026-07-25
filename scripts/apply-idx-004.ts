/**
 * IDX-004 — Application déterministe du DDL additif (drizzle/manual-idx-004.sql).
 *
 * Crée `seostats.index_selection` (registre des décisions de sélection d'inspection) si elle
 * n'existe pas. Aucune donnée migrée, aucun DROP, aucune colonne existante touchée. La table
 * naît VIDE : sans ligne, `loadDueSelections` rend une liste vide et le sélecteur retombe sur
 * ses seuls candidats calculés — appliquer ce DDL ne change donc strictement aucun
 * comportement. C'est écrire des lignes qui en change un.
 *
 * Lancer : npx tsx scripts/apply-idx-004.ts
 * Vérif  : npx tsx scripts/data-001-cartography.ts post-idx-004   (attendu 59 tables)
 *
 * ⚠ L'introspection passe de 58 à 59 tables `seostats`. L'écart est ATTENDU, et il doit être
 *   exactement `index_selection`. Rappel de la convention (DECISIONS.md, DATA-002) : SQL
 *   additif idempotent + ce script, JAMAIS `db:push` (interactif et moins déterministe sous
 *   Windows).
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
	'bucket',
	'created_at',
	'due_date',
	'id',
	'project_id',
	'rank',
	'reason',
	'reason_detail',
	'run_id',
	'schema_version',
	'selector_version',
	'url',
	'url_normalized'
];

const EXPECTED_INDEXES = [
	'idx_index_selection_project_due',
	'idx_index_selection_project_url',
	'index_selection_unique'
];

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-idx-004.sql');
	const sql = readFileSync(sqlPath, 'utf8');

	console.log(`Application de ${sqlPath} …`);
	await pool.query(sql);
	console.log('DDL IDX-004 appliqué (idempotent).');

	const { rows } = await pool.query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = 'seostats' AND table_name = 'index_selection'
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
		  WHERE schemaname = 'seostats' AND tablename = 'index_selection'
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
		`SELECT count(*)::text AS n FROM "seostats"."index_selection"`
	);
	console.log(`  lignes : ${countRows[0]?.n ?? '?'} (0 attendu à la première application)`);

	// L'écart d'introspection doit être CETTE table et rien d'autre.
	const { rows: tableRows } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM information_schema.tables
		  WHERE table_schema = 'seostats' AND table_type = 'BASE TABLE'`
	);
	console.log(`  tables seostats : ${tableRows[0]?.n ?? '?'} (59 attendu après ce lot)`);

	await pool.end();
}

main().catch(async (err) => {
	console.error('Application échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
