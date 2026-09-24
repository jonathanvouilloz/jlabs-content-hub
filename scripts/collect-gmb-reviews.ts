import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { collectGmbReviews } from '../src/lib/server/collectors/gmb-reviews.js';
import { getGmbAccessToken, getGmbAccountId } from '../src/lib/server/gmb-auth.js';

neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent (.env).');
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
	const equals = args.find((arg) => arg.startsWith(`--${name}=`));
	if (equals) return equals.slice(name.length + 3);
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : undefined;
};
const slug = option('project') ?? 'barberconcept';
const execute = args.includes('--execute');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;
const project = await pool.query<{ id: string; name: string }>(
	'select id, name from seostats.projects where slug=$1 limit 1',
	[slug]
).then((result) => result.rows[0]);
if (!project) throw new Error(`Projet introuvable : ${slug}`);
const running = await pool.query<{ count: number }>(
	`select count(*)::int count from seostats.jobs
	 where project_id=$1 and type='collect:gmb_reviews' and status='running'
	   and (lease_until is null or lease_until::timestamp > (now() at time zone 'UTC'))`,
	[project.id]
).then((result) => result.rows[0]?.count ?? 0);
if (running > 0) throw new Error(`Une collecte GMB est déjà active pour ${slug}.`);

const result = await collectGmbReviews({
	projectId: project.id,
	client: db,
	dryRun: !execute,
	deps: {
		getAccessToken: () => getGmbAccessToken(db, { persist: false }),
		getAccountId: async () => {
			const accountId = await getGmbAccountId(db);
			if (!accountId) throw new Error('Compte GMB absent.');
			return accountId.replace(/^accounts\//, '');
		}
	}
});
console.log(JSON.stringify({
	mode: execute ? 'execute' : 'dry-run',
	project: slug,
	syncedAt: result.syncedAt,
	summary: result.summary,
	locations: result.locations.map((location) => ({
		label: location.locationLabel,
		status: location.status,
		seen: location.seen,
		inserted: location.inserted,
		updated: location.updated,
		unreadable: location.unreadable,
		truncated: location.truncated,
		error: location.error
	}))
}, null, 2));
if (result.summary.failed > 0 || result.summary.truncated > 0 || result.summary.allFailed || result.aborted) {
	await pool.end();
	process.exit(1);
}
await pool.end();
