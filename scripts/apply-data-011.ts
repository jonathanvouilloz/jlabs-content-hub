/**
 * DATA-011 — Ajout additif/idempotent de gmb_reviews.review_reply_url.
 * Dry-run par defaut ; `--apply` execute le DDL puis verifie la colonne.
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

const apply = process.argv.includes('--apply');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function columnExists(): Promise<boolean> {
	const { rows } = await pool.query<{ present: boolean }>(
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'seostats'
			  AND table_name = 'gmb_reviews'
			  AND column_name = 'review_reply_url'
		) AS present`
	);
	return rows[0]?.present === true;
}

async function main() {
	const before = await columnExists();
	if (apply && !before) {
		const here = dirname(fileURLToPath(import.meta.url));
		const sql = readFileSync(join(here, '..', 'drizzle', 'manual-data-011.sql'), 'utf8');
		await pool.query(sql);
	}
	const after = await columnExists();
	console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', before, after }, null, 2));
	if (apply && !after) process.exitCode = 1;
	await pool.end();
}

main().catch(async (error) => {
	console.error('Application DATA-011 echouee:', error);
	await pool.end().catch(() => {});
	process.exit(1);
});
