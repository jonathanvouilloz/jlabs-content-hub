/**
 * DASH-006 lot 2 — Application déterministe du DDL additif (drizzle/manual-dash-006.sql).
 *
 * Crée `seostats.automation_pauses` (journal append-only des pauses d'automatisation) si elle
 * n'existe pas. Aucune donnée migrée, aucun DROP, aucune colonne existante touchée. La table
 * naît VIDE : sans ligne, `loadPauseStates` rend une map vide, `resolveCadencePause` répond
 * « pas en pause » partout, et le scheduler planifie exactement comme avant — appliquer ce DDL
 * ne change donc strictement aucun comportement. C'est écrire des lignes qui en change un.
 *
 * Lancer : npx tsx scripts/apply-dash-006.ts
 * Vérif  : npx tsx scripts/data-001-cartography.ts post-dash-006   (attendu 60 tables)
 *
 * ⚠ L'introspection passe de 59 à 60 tables `seostats`. L'écart est ATTENDU, et il doit être
 *   exactement `automation_pauses`. Rappel de la convention (DECISIONS.md, DATA-002) : SQL
 *   additif idempotent + ce script, JAMAIS `db:push` (interactif et moins déterministe sous
 *   Windows).
 *
 * ⚠ Ce script vérifie aussi l'ABSENCE de contrainte d'unicité sur la table. Ce n'est pas un
 *   oubli à rattraper : un unique transformerait un double clic en erreur au lieu d'un
 *   non-événement. L'idempotence vit dans la transaction de `recordPauseDecision`.
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
	'actor',
	'cadence',
	'created_at',
	'event_type',
	'id',
	'payload_json',
	'project_id',
	'provider',
	'reason',
	'scope',
	'until'
];

const EXPECTED_INDEXES = ['idx_automation_pauses_created', 'idx_automation_pauses_key'];

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-dash-006.sql');
	const sql = readFileSync(sqlPath, 'utf8');

	console.log(`Application de ${sqlPath} …`);
	await pool.query(sql);
	console.log('DDL DASH-006 appliqué (idempotent).');

	const { rows } = await pool.query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = 'seostats' AND table_name = 'automation_pauses'
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

	// `project_id` DOIT être nullable : NULL ⇔ scope = 'provider'. Une pause provider
	// n'appartient à aucun projet — la contraindre en NOT NULL forcerait à l'attacher
	// arbitrairement à l'un des six, où elle serait invisible depuis les cinq autres.
	const { rows: nullableRows } = await pool.query<{ is_nullable: string }>(
		`SELECT is_nullable FROM information_schema.columns
		  WHERE table_schema = 'seostats' AND table_name = 'automation_pauses'
		    AND column_name = 'project_id'`
	);
	const projectIdNullable = nullableRows[0]?.is_nullable === 'YES';
	console.log(`  project_id nullable : ${projectIdNullable ? 'oui' : 'NON'} (oui attendu)`);
	if (!projectIdNullable) {
		console.error('  project_id NOT NULL : une pause provider n’aurait nulle part où vivre.');
		process.exitCode = 1;
	}

	const { rows: idxRows } = await pool.query<{ indexname: string; indexdef: string }>(
		`SELECT indexname, indexdef FROM pg_indexes
		  WHERE schemaname = 'seostats' AND tablename = 'automation_pauses'
		  ORDER BY indexname`
	);
	const idx = idxRows.map((r) => r.indexname);
	console.log(`  index : ${idx.join(', ') || '∅'}`);
	const missingIdx = EXPECTED_INDEXES.filter((i) => !idx.includes(i));
	if (missingIdx.length > 0) {
		console.error('  Index manquants :', missingIdx.join(', '));
		process.exitCode = 1;
	}

	// L'absence d'unique est un INVARIANT du lot, pas un oubli (cf. docblock). La clé primaire
	// est le seul index unique légitime ici.
	const unexpectedUnique = idxRows.filter(
		(r) => /UNIQUE/i.test(r.indexdef) && r.indexname !== 'automation_pauses_pkey'
	);
	console.log(`  index uniques hors PK : ${unexpectedUnique.length} (0 attendu)`);
	if (unexpectedUnique.length > 0) {
		console.error(
			'  Unique inattendu :',
			unexpectedUnique.map((r) => r.indexname).join(', '),
			'— un double clic deviendrait une erreur au lieu d’un non-événement.'
		);
		process.exitCode = 1;
	}

	// La table doit être VIDE après application : ce script ne sème rien. Un contenu
	// préexistant n'est pas une erreur (réapplication), mais il doit se voir.
	const { rows: countRows } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM "seostats"."automation_pauses"`
	);
	console.log(`  lignes : ${countRows[0]?.n ?? '?'} (0 attendu à la première application)`);

	// L'écart d'introspection doit être CETTE table et rien d'autre.
	const { rows: tableRows } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM information_schema.tables
		  WHERE table_schema = 'seostats' AND table_type = 'BASE TABLE'`
	);
	console.log(`  tables seostats : ${tableRows[0]?.n ?? '?'} (60 attendu après ce lot)`);

	await pool.end();
}

main().catch(async (err) => {
	console.error('Application échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
