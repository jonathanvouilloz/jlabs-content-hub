/**
 * GMB-011 — Aperçu et latence de `GET /review-status`, en LECTURE SEULE contre Neon.
 *
 * Appelle le même service que la route (`buildAgentReviewStatus`), sans auth ni HTTP : la
 * mesure isole donc le coût des lectures base + agrégation. Aucune écriture, aucun appel Google.
 *
 * Lancer :
 *   npx tsx scripts/review-status-preview.ts                    # barberconcept, 5 mesures
 *   npx tsx scripts/review-status-preview.ts --project=barberconcept --runs=10 --quiet
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { buildAgentReviewStatus } from '../src/lib/server/reviews/agent-review-service.js';
import { reviewStatusEtag } from '../src/lib/server/reviews/agent-review-status-state.js';

neonConfig.webSocketConstructor = ws;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absent (.env).');
const args = process.argv.slice(2);
const option = (name: string): string | undefined =>
	args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const slug = option('project') ?? 'barberconcept';
const runs = Math.max(1, Number(option('runs') ?? 5));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

try {
	const timings: number[] = [];
	let last: Awaited<ReturnType<typeof buildAgentReviewStatus>> | null = null;
	for (let i = 0; i < runs; i += 1) {
		const started = performance.now();
		last = await buildAgentReviewStatus({ db, projectSlug: slug });
		timings.push(performance.now() - started);
	}
	if (!last) throw new Error('aucune mesure');
	if (!args.includes('--quiet')) console.log(JSON.stringify(last, null, 2));
	for (const [name, counts] of Object.entries(last.periods)) {
		const sum = counts.eligibleAuto + counts.requiresHuman + counts.sensitiveOrBlocked
			+ counts.alreadyReplied + counts.writeUnknown + counts.staleOrUnhealthyLocation;
		console.log(`${name}: ${counts.reviews} avis, partition ${sum === counts.reviews ? 'OK' : `KO (${sum})`}`);
	}
	const sorted = [...timings].sort((a, b) => a - b);
	const ms = (value: number) => `${Math.round(value)} ms`;
	console.log(`ETag ${reviewStatusEtag(last)}`);
	console.log(`latence (${runs} runs, 1er = connexion à froid) : min ${ms(sorted[0])} · médiane ${ms(sorted[Math.floor(sorted.length / 2)])} · max ${ms(sorted.at(-1)!)}`);
} finally {
	await pool.end();
}
