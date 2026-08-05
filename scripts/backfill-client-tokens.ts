import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { neonConfig, Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { planClientTokenBackfill } from '../src/lib/server/client-token-backfill.js';

neonConfig.webSocketConstructor = ws;

type TokenRow = { id: string; slug: string; access_token: string };

export async function runClientTokenBackfill(input: {
	databaseUrl: string;
	apply: boolean;
}) {
	if (!input.databaseUrl) throw new Error('DATABASE_URL manquante.');
	const pool = new Pool({
		connectionString: input.databaseUrl,
		application_name: 'seostats-client-token-backfill',
		connectionTimeoutMillis: 8_000,
		max: 1
	});
	try {
		const result = await pool.query<TokenRow>(
			`SELECT id, slug, access_token
			 FROM seostats.projects
			 WHERE access_token IS NOT NULL
			 ORDER BY slug ASC, id ASC`
		);
		const plan = planClientTokenBackfill(
			result.rows.map((row) => ({ id: row.id, slug: row.slug, stored: row.access_token }))
		);
		if (plan.blocked.length > 0) {
			throw new Error(`Backfill bloqué: ${plan.blocked.length} format(s) inconnu(s).`);
		}
		if (!input.apply) {
			return { mode: 'dry-run' as const, updates: plan.updates.length, unchanged: plan.unchanged.length };
		}
		await pool.query('BEGIN');
		try {
			for (const update of plan.updates) {
				const changed = await pool.query(
					`UPDATE seostats.projects
					 SET access_token = $1, updated_at = now()
					 WHERE id = $2 AND access_token = $3`,
					[update.next, update.id, update.previous]
				);
				if (changed.rowCount !== 1) throw new Error('Conflit concurrent pendant le backfill.');
			}
			await pool.query('COMMIT');
		} catch (error) {
			await pool.query('ROLLBACK');
			throw error;
		}
		return { mode: 'apply' as const, updates: plan.updates.length, unchanged: plan.unchanged.length };
	} finally {
		await pool.end();
	}
}

const isMain = process.argv[1]
	? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
	: false;

if (isMain) {
	runClientTokenBackfill({
		databaseUrl: process.env.DATABASE_URL ?? '',
		apply: process.argv.includes('--apply')
	})
		.then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
		.catch(() => {
			console.error('Échec du backfill des tokens client (détails protégés).');
			process.exitCode = 1;
		});
}
