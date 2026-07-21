/**
 * DATA (migrate) — Backfill des tables d'observations depuis le legacy.
 *
 * Peuple, de façon IDEMPOTENTE (upsert par unique index), 4 tables d'observations
 * à partir des sources vivantes. Additif : aucune table source n'est touchée.
 *   A+B. gsc_query_page_data → gsc_query_page_observations (1:1)
 *        + rollup page-level → gsc_page_observations (agrégé par snapshot/semaine)
 *   C.   gmb_insights_daily → gmb_insight_observations (1:1)
 *   D.   tracked_keywords × gsc_query_page_data → keyword_rank_observations (watchlist)
 *
 * Pattern runner (cf. apply-data-004.ts) : Pool propre + drizzle client autonome
 * (schema.ts est pur, importable hors runtime SvelteKit). La logique de transform
 * vit dans le module PUR src/lib/server/observation-backfill.ts (testé par vitest).
 *
 * Lancer (à blanc) : npx tsx scripts/backfill-observations.ts --dry-run
 * Lancer (réel)    : npx tsx scripts/backfill-observations.ts
 * Vérifier         : npx tsx scripts/verify-backfill.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import { createId } from '../src/lib/server/utils.js';
import {
	toGscQueryPageInput,
	rollupPagesFromQueryPage,
	toGmbInsightInput,
	buildKeywordRankInputs,
	type GscQueryPageSourceRow,
	type GmbInsightSourceRow,
	type KeywordRankSourceRow
} from '../src/lib/server/observation-backfill.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');
// Limite Postgres = 65535 paramètres bind par requête. La table la plus large
// (gsc_query_page_observations) insère 16 colonnes/ligne → 4000×16 = 64000 params,
// sous la limite avec marge. Sert aussi de taille de page keyset (passGmb).
const CHUNK = 4000;
const nowIso = () => new Date().toISOString();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

// ── Utilitaires ─────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/** Dédup last-wins par clé (nécessaire côté GSC : pas de clé naturelle → un même
 *  lot peut contenir deux lignes de même clé d'upsert, ce qui casserait un
 *  ON CONFLICT DO UPDATE au sein d'un seul INSERT). */
function dedupBy<T>(rows: T[], keyFn: (r: T) => string): T[] {
	const byKey = new Map<string, T>();
	for (const r of rows) byKey.set(keyFn(r), r);
	return [...byKey.values()];
}

// ── Upserts (miroir des unique index de schema.ts, +provider explicite) ──

async function upsertGscQueryPage(inputs: ReturnType<typeof toGscQueryPageInput>[]): Promise<number> {
	const deduped = dedupBy(inputs, (i) =>
		[i.projectId, i.periodStart, i.query, i.page, i.device ?? ''].join('\x1f')
	);
	if (DRY_RUN || deduped.length === 0) return deduped.length;
	for (const part of chunk(deduped, CHUNK)) {
		await db
			.insert(schema.gscQueryPageObservations)
			.values(
				part.map((i) => ({
					id: createId(),
					projectId: i.projectId,
					provider: 'gsc',
					schemaVersion: 1,
					periodStart: i.periodStart,
					periodEnd: i.periodEnd,
					query: i.query,
					page: i.page,
					device: i.device ?? '',
					clicks: i.clicks ?? 0,
					impressions: i.impressions ?? 0,
					ctr: i.ctr ?? 0,
					position: i.position ?? 0,
					runId: null,
					payloadJson: null,
					fetchedAt: nowIso()
				}))
			)
			.onConflictDoUpdate({
				target: [
					schema.gscQueryPageObservations.projectId,
					schema.gscQueryPageObservations.periodStart,
					schema.gscQueryPageObservations.query,
					schema.gscQueryPageObservations.page,
					schema.gscQueryPageObservations.device
				],
				set: {
					clicks: sql`excluded.clicks`,
					impressions: sql`excluded.impressions`,
					ctr: sql`excluded.ctr`,
					position: sql`excluded.position`,
					runId: sql`excluded.run_id`,
					payloadJson: sql`excluded.payload_json`,
					fetchedAt: sql`excluded.fetched_at`
				}
			});
	}
	return deduped.length;
}

async function upsertGscPage(inputs: ReturnType<typeof rollupPagesFromQueryPage>): Promise<number> {
	// clés uniques par construction (rollup groupe déjà par page×device) → pas de dédup requise.
	if (DRY_RUN || inputs.length === 0) return inputs.length;
	for (const part of chunk(inputs, CHUNK)) {
		await db
			.insert(schema.gscPageObservations)
			.values(
				part.map((i) => ({
					id: createId(),
					projectId: i.projectId,
					provider: 'gsc',
					schemaVersion: 1,
					periodStart: i.periodStart,
					periodEnd: i.periodEnd,
					page: i.page,
					device: i.device ?? '',
					clicks: i.clicks ?? 0,
					impressions: i.impressions ?? 0,
					ctr: i.ctr ?? 0,
					position: i.position ?? 0,
					runId: null,
					payloadJson: null,
					fetchedAt: nowIso()
				}))
			)
			.onConflictDoUpdate({
				target: [
					schema.gscPageObservations.projectId,
					schema.gscPageObservations.periodStart,
					schema.gscPageObservations.page,
					schema.gscPageObservations.device
				],
				set: {
					clicks: sql`excluded.clicks`,
					impressions: sql`excluded.impressions`,
					ctr: sql`excluded.ctr`,
					position: sql`excluded.position`,
					runId: sql`excluded.run_id`,
					payloadJson: sql`excluded.payload_json`,
					fetchedAt: sql`excluded.fetched_at`
				}
			});
	}
	return inputs.length;
}

async function upsertGmbInsight(inputs: ReturnType<typeof toGmbInsightInput>[]): Promise<number> {
	const deduped = dedupBy(inputs, (i) =>
		[i.projectId, i.locationId, i.observedDate, i.metric].join('\x1f')
	);
	if (DRY_RUN || deduped.length === 0) return deduped.length;
	for (const part of chunk(deduped, CHUNK)) {
		await db
			.insert(schema.gmbInsightObservations)
			.values(
				part.map((i) => ({
					id: createId(),
					projectId: i.projectId,
					provider: 'gmb',
					schemaVersion: 1,
					observedDate: i.observedDate,
					locationId: i.locationId,
					metric: i.metric,
					value: i.value ?? 0,
					runId: null,
					payloadJson: null,
					fetchedAt: nowIso()
				}))
			)
			.onConflictDoUpdate({
				target: [
					schema.gmbInsightObservations.projectId,
					schema.gmbInsightObservations.locationId,
					schema.gmbInsightObservations.observedDate,
					schema.gmbInsightObservations.metric
				],
				set: {
					value: sql`excluded.value`,
					runId: sql`excluded.run_id`,
					payloadJson: sql`excluded.payload_json`,
					fetchedAt: sql`excluded.fetched_at`
				}
			});
	}
	return deduped.length;
}

async function upsertKeywordRank(inputs: ReturnType<typeof buildKeywordRankInputs>): Promise<number> {
	// clés uniques par construction (buildKeywordRankInputs groupe déjà) → pas de dédup requise.
	if (DRY_RUN || inputs.length === 0) return inputs.length;
	for (const part of chunk(inputs, CHUNK)) {
		await db
			.insert(schema.keywordRankObservations)
			.values(
				part.map((i) => ({
					id: createId(),
					projectId: i.projectId,
					provider: 'gsc',
					schemaVersion: 1,
					observedDate: i.observedDate,
					keyword: i.keyword,
					device: i.device ?? '',
					page: i.page ?? null,
					position: i.position ?? 0,
					clicks: i.clicks ?? null,
					impressions: i.impressions ?? null,
					ctr: i.ctr ?? null,
					runId: null,
					payloadJson: null,
					fetchedAt: nowIso()
				}))
			)
			.onConflictDoUpdate({
				target: [
					schema.keywordRankObservations.projectId,
					schema.keywordRankObservations.keyword,
					schema.keywordRankObservations.device,
					schema.keywordRankObservations.observedDate
				],
				set: {
					page: sql`excluded.page`,
					position: sql`excluded.position`,
					clicks: sql`excluded.clicks`,
					impressions: sql`excluded.impressions`,
					ctr: sql`excluded.ctr`,
					runId: sql`excluded.run_id`,
					payloadJson: sql`excluded.payload_json`,
					fetchedAt: sql`excluded.fetched_at`
				}
			});
	}
	return inputs.length;
}

// ── Passe A+B : GSC query×page + rollup page, itérés par snapshot ────

async function passGsc(): Promise<void> {
	const { rows: snapshots } = await pool.query<{
		id: string;
		projectId: string;
		weekStart: string;
		weekEnd: string;
	}>(
		`SELECT id, project_id AS "projectId", week_start AS "weekStart", week_end AS "weekEnd"
		   FROM seostats.gsc_snapshots ORDER BY project_id, week_start`
	);
	let qpTotal = 0;
	let pageTotal = 0;
	for (const s of snapshots) {
		const { rows } = await pool.query<{
			projectId: string;
			query: string;
			page: string;
			device: string;
			clicks: number;
			impressions: number;
			ctr: number;
			position: number;
		}>(
			`SELECT project_id AS "projectId", query, page, device, clicks, impressions, ctr, position
			   FROM seostats.gsc_query_page_data WHERE snapshot_id = $1`,
			[s.id]
		);
		if (rows.length === 0) continue;
		const sourceRows: GscQueryPageSourceRow[] = rows.map((r) => ({
			projectId: r.projectId,
			weekStart: s.weekStart,
			weekEnd: s.weekEnd,
			query: r.query,
			page: r.page,
			device: r.device,
			clicks: r.clicks,
			impressions: r.impressions,
			ctr: r.ctr,
			position: r.position
		}));
		qpTotal += await upsertGscQueryPage(sourceRows.map(toGscQueryPageInput));
		pageTotal += await upsertGscPage(rollupPagesFromQueryPage(sourceRows));
	}
	console.log(
		`  A. gsc_query_page_observations : ${qpTotal} (depuis ${snapshots.length} snapshots)`
	);
	console.log(`  B. gsc_page_observations       : ${pageTotal} (rollup page-level)`);
}

// ── Passe C : GMB insights (keyset par id) ──────────────────────────

async function passGmb(): Promise<void> {
	let after = '';
	let total = 0;
	for (;;) {
		const { rows } = await pool.query<{
			id: string;
			projectId: string;
			date: string;
			gmbLocationId: string;
			metric: string;
			value: number;
		}>(
			`SELECT id, project_id AS "projectId", date, gmb_location_id AS "gmbLocationId", metric, value
			   FROM seostats.gmb_insights_daily WHERE id > $1 ORDER BY id LIMIT $2`,
			[after, CHUNK]
		);
		if (rows.length === 0) break;
		after = rows[rows.length - 1].id;
		const inputs = rows.map((r) =>
			toGmbInsightInput({
				projectId: r.projectId,
				date: r.date,
				gmbLocationId: r.gmbLocationId,
				metric: r.metric,
				value: r.value
			} satisfies GmbInsightSourceRow)
		);
		total += await upsertGmbInsight(inputs);
		if (rows.length < CHUNK) break;
	}
	console.log(`  C. gmb_insight_observations    : ${total}`);
}

// ── Passe D : keyword rank (tracked × gsc_query_page_data) ───────────

async function passKeywordRank(): Promise<void> {
	const { rows } = await pool.query<{
		projectId: string;
		weekStart: string;
		keyword: string;
		device: string;
		page: string;
		clicks: number;
		impressions: number;
		ctr: number;
		position: number;
	}>(
		`SELECT gqp.project_id AS "projectId", gqp.week_start AS "weekStart", tk.keyword AS keyword,
		        gqp.device, gqp.page, gqp.clicks, gqp.impressions, gqp.ctr, gqp.position
		   FROM seostats.tracked_keywords tk
		   JOIN seostats.gsc_query_page_data gqp
		     ON gqp.project_id = tk.project_id AND gqp.query = tk.keyword
		  WHERE tk.archived = false`
	);
	const inputs = buildKeywordRankInputs(rows as KeywordRankSourceRow[]);
	const total = await upsertKeywordRank(inputs);
	console.log(`  D. keyword_rank_observations   : ${total} (depuis ${rows.length} lignes candidates)`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
	console.log(`Backfill observations${DRY_RUN ? ' [DRY-RUN — aucune écriture]' : ''} …`);
	await passGsc();
	await passGmb();
	await passKeywordRank();
	console.log(DRY_RUN ? 'Dry-run terminé (compteurs attendus ci-dessus).' : 'Backfill terminé.');
	await pool.end();
}

main().catch(async (err) => {
	console.error('Backfill échoué:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
