/**
 * Retrait de GMB et LinkedIn — application de drizzle/manual-drop-gmb-linkedin.sql.
 *
 * ⚠️ DESTRUCTIF : supprime 19 tables, 2 colonnes et les résidus GMB des tables partagées.
 * Dry-run par défaut : compte ce qui partirait, sans rien écrire.
 * `--apply` exige `--backup-branch=<nom>` : la branche Neon créée juste avant, nommée ici
 * pour que la trace de la sauvegarde accompagne la trace de la suppression.
 *
 * Lancer : npx tsx scripts/apply-drop-gmb-linkedin.ts
 *          npx tsx scripts/apply-drop-gmb-linkedin.ts --apply --backup-branch=backup-2026-10-25
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

const APPLY = process.argv.includes('--apply');
const BACKUP_BRANCH = process.argv.find((a) => a.startsWith('--backup-branch='))?.split('=')[1];

const DROPPED_TABLES = [
	'publish_logs',
	'review_reply_delivery_events',
	'review_reply_deliveries',
	'review_reply_proposals',
	'policy_promotions',
	'review_automation_policies',
	'review_mention_candidates',
	'review_monthly_reports',
	'employee_mentions',
	'gmb_reviews',
	'gmb_review_observations',
	'gmb_insight_observations',
	'gmb_insights_daily',
	'gmb_location_profiles',
	'gmb_profile_edits',
	'gmb_ai_reports',
	'project_gmb_locations',
	'gmb_settings',
	'linkedin_settings'
];
const GMB_JOB_TYPES = ['collect:gmb_reviews', 'detect:review_pending', 'detect:employee_mentions'];
const GMB_FINDING_TYPES = ['review_pending_sla', 'negative_review', 'unknown_employee_mention'];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function count(query: string, params: unknown[] = []): Promise<number> {
	const { rows } = await pool.query<{ n: string }>(query, params);
	return Number(rows[0]?.n ?? 0);
}

async function presentTables(): Promise<string[]> {
	const { rows } = await pool.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		  WHERE table_schema = 'seostats' AND table_name = ANY($1)
		  ORDER BY table_name`,
		[DROPPED_TABLES]
	);
	return rows.map((r) => r.table_name);
}

async function report(): Promise<void> {
	const tables = await presentTables();
	console.log(`Tables GMB/LinkedIn présentes : ${tables.length}/${DROPPED_TABLES.length}`);
	for (const t of tables) {
		console.log(`  ${t.padEnd(30)} ${await count(`SELECT count(*) AS n FROM "seostats"."${t}"`)}`);
	}
	console.log('Résidus dans les tables partagées :');
	console.log(`  jobs GMB                       ${await count(`SELECT count(*) AS n FROM "seostats"."jobs" WHERE "type" = ANY($1)`, [GMB_JOB_TYPES])}`);
	console.log(`  monitoring_steps GMB           ${await count(`SELECT count(*) AS n FROM "seostats"."monitoring_steps" WHERE "step_type" = ANY($1)`, [GMB_JOB_TYPES])}`);
	console.log(`  findings d'avis                ${await count(`SELECT count(*) AS n FROM "seostats"."findings" WHERE "type" = ANY($1)`, [GMB_FINDING_TYPES])}`);
	console.log(`  contents gmb/linkedin          ${await count(`SELECT count(*) AS n FROM "seostats"."contents" WHERE "type" IN ('gmb', 'linkedin')`)}`);
}

async function main() {
	await report();

	if (!APPLY) {
		console.log('\nDry-run : rien n’a été écrit. Relancer avec --apply --backup-branch=<nom>.');
		await pool.end();
		return;
	}
	if (!BACKUP_BRANCH) {
		console.error('\n--apply refusé : --backup-branch=<nom> manquant (créer la branche Neon d’abord).');
		await pool.end();
		process.exit(1);
	}

	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-drop-gmb-linkedin.sql');
	console.log(`\nSauvegarde déclarée : branche Neon « ${BACKUP_BRANCH} ».`);
	console.log(`Application de ${sqlPath} …`);
	// Le fichier porte son propre BEGIN/COMMIT : une erreur annule tout.
	await pool.query(readFileSync(sqlPath, 'utf8'));

	const left = await presentTables();
	if (left.length > 0) {
		console.error('Tables encore présentes :', left.join(', '));
		process.exitCode = 1;
	} else {
		console.log('Retrait appliqué : 19 tables et 2 colonnes supprimées.');
	}
	await pool.end();
}

main().catch(async (err) => {
	console.error('Application échouée (transaction annulée) :', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
