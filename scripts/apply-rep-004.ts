/**
 * REP-004 lot 1 — Application déterministe du DDL de révision (drizzle/manual-rep-004.sql).
 *
 * Ajoute `revision` / `revision_reason` / `supersedes_id` à `seostats.weekly_reports`, déplace
 * l'unique de (period_slot) vers (period_slot, revision), et pose le CHECK « une révision porte
 * toujours sa raison ». AUCUNE table créée (61 avant, 61 après), aucune donnée migrée : les
 * lignes existantes deviennent toutes `revision = 1`, ce qu'elles sont.
 *
 * Lancer : npx tsx scripts/apply-rep-004.ts
 * Vérif  : npx tsx scripts/data-001-cartography.ts post-rep-004   (attendu 61 tables)
 *
 * ⚠ Le seul geste non additif du fichier est le DROP de `weekly_reports_period_unique`, et il
 *   n'a lieu qu'APRÈS la création de `weekly_reports_period_revision_unique` : la table n'est à
 *   aucun instant sans protection contre le doublon. Ce script le VÉRIFIE après coup (l'ancien
 *   index doit avoir disparu, le nouveau exister) — sans quoi le tick pourrait publier deux
 *   fois le même lundi.
 *
 * ⚠ Convention (DECISIONS.md, DATA-002) : SQL additif idempotent + ce script, JAMAIS `db:push`.
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

const NEW_COLUMNS = ['revision', 'revision_reason', 'supersedes_id'];
const EXPECTED_INDEXES = ['idx_weekly_reports_published', 'weekly_reports_period_revision_unique'];
const REMOVED_INDEX = 'weekly_reports_period_unique';
const EXPECTED_CHECK = 'weekly_reports_revision_reason_check';

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-rep-004.sql');
	const sql = readFileSync(sqlPath, 'utf8');

	console.log(`Application de ${sqlPath} …`);
	await pool.query(sql);
	console.log('DDL REP-004 appliqué (idempotent).');

	let failed = false;

	const { rows } = await pool.query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = 'seostats' AND table_name = 'weekly_reports'
		  ORDER BY column_name`
	);
	const present = rows.map((r) => r.column_name);
	console.log(`  colonnes (${present.length}, 14 attendues) : ${present.join(', ') || '∅'}`);
	const missing = NEW_COLUMNS.filter((c) => !present.includes(c));
	if (missing.length > 0) {
		console.error('  Manquantes :', missing.join(', '));
		failed = true;
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
		failed = true;
	}
	// L'ancien unique DOIT avoir disparu : tant qu'il tient, la révision 2 est impossible.
	if (idx.includes(REMOVED_INDEX)) {
		console.error(`  L'ancien unique ${REMOVED_INDEX} est toujours là : la révision 2 sera refusée.`);
		failed = true;
	}

	const { rows: checkRows } = await pool.query<{ conname: string }>(
		`SELECT conname FROM pg_constraint
		  WHERE conrelid = '"seostats"."weekly_reports"'::regclass AND contype = 'c'`
	);
	const checks = checkRows.map((r) => r.conname);
	console.log(`  contraintes CHECK : ${checks.join(', ') || '∅'}`);
	if (!checks.includes(EXPECTED_CHECK)) {
		console.error(`  CHECK manquant : ${EXPECTED_CHECK}`);
		failed = true;
	}

	// Les lignes déjà publiées deviennent toutes révision 1 — le défaut de la colonne s'en
	// charge. Une révision > 1 ici signifierait que ce script a été lancé après un usage.
	const { rows: countRows } = await pool.query<{ n: string; max_rev: string | null }>(
		`SELECT count(*)::text AS n, max(revision)::text AS max_rev
		   FROM "seostats"."weekly_reports"`
	);
	console.log(
		`  lignes : ${countRows[0]?.n ?? '?'} · révision max : ${countRows[0]?.max_rev ?? '∅'}`
	);

	// L'écart d'introspection doit être NUL : ce lot ne crée aucune table.
	const { rows: tableRows } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM information_schema.tables
		  WHERE table_schema = 'seostats' AND table_type = 'BASE TABLE'`
	);
	console.log(`  tables seostats : ${tableRows[0]?.n ?? '?'} (61 attendu, inchangé)`);

	await pool.end();
	if (failed) process.exitCode = 1;
}

main().catch(async (err) => {
	console.error('Application échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
