/**
 * REP-004 lot 2 — Application déterministe du DDL de rétention (drizzle/manual-rep-004-lot2.sql).
 *
 * Rend `payload_json` nullable, ajoute les cinq colonnes qui SURVIVENT au détail (taille,
 * empreinte, adresse d'archive, dates d'archivage et de purge) et pose le CHECK qui interdit
 * l'état muet — un détail disparu sans adresse ni empreinte. AUCUNE table créée (61 avant, 61
 * après), aucune donnée migrée : les rapports existants gardent leur payload et leurs cinq
 * nouvelles colonnes à `NULL`, ce qu'ils sont (jamais archivés, jamais purgés).
 *
 * Lancer : npx tsx scripts/apply-rep-004-lot2.ts
 * Vérif  : npx tsx scripts/data-001-cartography.ts post-rep-004-lot2   (attendu 61 tables)
 *
 * ⚠ Le script VÉRIFIE le CHECK après coup, et pas seulement sa présence : il tente une ligne
 *   interdite (payload NULL sans adresse) dans une transaction annulée. Un CHECK présent mais
 *   trop permissif laisserait passer exactement l'état que ce lot existe pour interdire, et
 *   personne ne s'en apercevrait avant la première purge.
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

const NEW_COLUMNS = [
	'payload_bytes',
	'payload_digest',
	'payload_archived_at',
	'payload_archive_ref',
	'payload_purged_at'
];
const EXPECTED_CHECKS = [
	'weekly_reports_revision_reason_check',
	'weekly_reports_payload_presence_check'
];

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-rep-004-lot2.sql');
	const sql = readFileSync(sqlPath, 'utf8');

	console.log(`Application de ${sqlPath} …`);
	await pool.query(sql);
	console.log('DDL REP-004 lot 2 appliqué (idempotent).');

	let failed = false;

	const { rows } = await pool.query<{
		column_name: string;
		is_nullable: string;
	}>(
		`SELECT column_name, is_nullable FROM information_schema.columns
		  WHERE table_schema = 'seostats' AND table_name = 'weekly_reports'
		  ORDER BY column_name`
	);
	const present = rows.map((r) => r.column_name);
	console.log(`  colonnes (${present.length}, 19 attendues) : ${present.join(', ') || '∅'}`);
	const missing = NEW_COLUMNS.filter((c) => !present.includes(c));
	if (missing.length > 0) {
		console.error('  Manquantes :', missing.join(', '));
		failed = true;
	}

	// `payload_json` DOIT être nullable : sans ça, la purge du détail est impossible et le
	// CHECK ne protège rien.
	const payload = rows.find((r) => r.column_name === 'payload_json');
	console.log(`  payload_json nullable : ${payload?.is_nullable ?? '?'} (YES attendu)`);
	if (payload?.is_nullable !== 'YES') {
		console.error('  payload_json est encore NOT NULL : aucune purge ne pourra avoir lieu.');
		failed = true;
	}

	const { rows: checkRows } = await pool.query<{ conname: string }>(
		`SELECT conname FROM pg_constraint
		  WHERE conrelid = '"seostats"."weekly_reports"'::regclass AND contype = 'c'`
	);
	const checks = checkRows.map((r) => r.conname);
	console.log(`  contraintes CHECK : ${checks.join(', ') || '∅'}`);
	for (const expected of EXPECTED_CHECKS) {
		if (!checks.includes(expected)) {
			console.error(`  CHECK manquant : ${expected}`);
			failed = true;
		}
	}

	// ── Le CHECK est-il vraiment mordant ? ──────────────────────────
	//
	// Une contrainte présente mais trop large laisserait passer la ligne purgée SANS adresse —
	// précisément l'état que ce lot interdit. On l'exerce, dans une transaction annulée.
	const client = await pool.connect();
	let refused = false;
	try {
		await client.query('BEGIN');
		await client.query(
			`INSERT INTO "seostats"."weekly_reports"
			   (id, period_slot, status, schema_version, report_schema_version,
			    slot_at, due_at, published_at, readiness_json, payload_json,
			    revision, payload_purged_at)
			 VALUES ('ddl-probe-rep-004-lot2', '1990-01-01T09:00', 'partial', 1, 2,
			         '1990-01-01 08:00:00', '1990-01-01 09:00:00', '1990-01-01 09:00:00',
			         '{}', NULL, 1, '1990-01-02 09:00:00')`
		);
	} catch {
		refused = true;
	} finally {
		await client.query('ROLLBACK').catch(() => {});
		client.release();
	}
	console.log(`  sonde « détail purgé sans adresse » : ${refused ? 'REFUSÉE' : 'ACCEPTÉE'}`);
	if (!refused) {
		console.error('  Le CHECK laisse passer une ligne purgée sans archive : purge interdite.');
		failed = true;
	}

	const { rows: countRows } = await pool.query<{
		n: string;
		purged: string;
		archived: string;
	}>(
		`SELECT count(*)::text AS n,
		        count(payload_purged_at)::text AS purged,
		        count(payload_archived_at)::text AS archived
		   FROM "seostats"."weekly_reports"`
	);
	console.log(
		`  lignes : ${countRows[0]?.n ?? '?'} · archivées : ${countRows[0]?.archived ?? '?'} · purgées : ${
			countRows[0]?.purged ?? '?'
		}`
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
