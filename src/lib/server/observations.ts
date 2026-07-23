/**
 * DATA-004 — Écriture d'observations (upsert idempotent).
 *
 * Un upsert par domaine ANCRÉ sur une source vivante (gsc_query_page, gsc_page,
 * index, keyword_rank, gmb_insight). Chaque upsert vise l'unique de sa table :
 * deux collectes identiques ne créent JAMAIS deux lignes (acceptation DATA-004),
 * elles rafraîchissent les métriques + `fetched_at` + `run_id`.
 *
 * Les cinq tables spéculatives (sitemap, plausible, backlink, ai_visibility,
 * gmb_review) restent SANS write-helper tant que leur collecteur n'existe pas :
 * on n'écrit pas ce qu'on ne collecte pas encore.
 *
 * Garde commune : payload brut BORNÉ (assertBoundedPayload) et sans secret
 * (assertNoInlineSecret) avant persistance.
 *
 * GSC-002 — trois changements, tous exigés par le premier collecteur réel :
 *
 *   - **client INJECTÉ** (motif `findings.ts`). Ce module importait `db`
 *     statiquement, donc était inchargeable hors runtime SvelteKit : aucune preuve
 *     sur Neon n'était possible. Il n'avait jamais gêné personne pour une raison
 *     gênante — PERSONNE NE L'APPELAIT (le piège AGT-000 : un module complet que
 *     rien n'invoque). Le collecteur en est le premier appelant ;
 *   - **`fetched_at` au format DB** (`toDbTimestamp`) et non plus en ISO. Dette
 *     nommée dans les quatre derniers blocs de session, close ici : la colonne a
 *     pour DEFAULT `to_char(now(), …)`, et deux formats mélangés dans une même
 *     colonne ne se comparent pas (`'T'` 0x54 > `' '` 0x20) ;
 *   - **upserts par LOT**. Une semaine × 6 projets ≈ 4 500 lignes ; ligne à ligne
 *     ce serait 4 500 aller-retours Neon, hors budget de drain (240 s).
 */
import { sql } from 'drizzle-orm';
import {
	gscQueryPageObservations,
	gscPageObservations,
	indexObservations,
	keywordRankObservations,
	gmbInsightObservations
} from './db/schema.js';
import type { AppDb } from './db/types.js';
import { createId } from './utils.js';
import { toDbTimestamp } from './timestamps.js';
import { assertNoInlineSecret } from './projection-state.js';
import { assertBoundedPayload } from './observation-state.js';

/** Cf. `findings.ts` : import dynamique, donc chargeable hors runtime SvelteKit. */
async function resolveDb(client?: AppDb): Promise<AppDb> {
	if (client) return client;
	const mod = await import('./db/index.js');
	return mod.db as unknown as AppDb;
}

const nowDb = () => toDbTimestamp();

/**
 * Taille de lot. Postgres plafonne à **65 535 paramètres bind par requête** ; la
 * table la plus large (`gsc_query_page_observations`) insère 16 colonnes par ligne
 * → 4000 × 16 = 64 000, sous la limite avec marge. Valeur reprise telle quelle de
 * `scripts/backfill-observations.ts`, qui a chargé 73 009 lignes avec.
 */
export const OBSERVATION_CHUNK = 4000;

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

function guardPayload(payloadJson: string | null | undefined, context: string): void {
	assertBoundedPayload(payloadJson, context);
	assertNoInlineSecret(payloadJson, context);
}

// ── 1. GSC query×page×device ────────────────────────────────────────

export interface UpsertGscQueryPageInput {
	projectId: string;
	periodStart: string;
	periodEnd: string;
	query: string;
	page: string;
	device?: string;
	clicks?: number;
	impressions?: number;
	ctr?: number;
	position?: number;
	runId?: string | null;
	schemaVersion?: number;
	payloadJson?: string | null;
}

function gscQueryPageValues(input: UpsertGscQueryPageInput, fetchedAt: string) {
	return {
		id: createId(),
		projectId: input.projectId,
		provider: 'gsc',
		schemaVersion: input.schemaVersion ?? 1,
		periodStart: input.periodStart,
		periodEnd: input.periodEnd,
		query: input.query,
		page: input.page,
		device: input.device ?? '',
		clicks: input.clicks ?? 0,
		impressions: input.impressions ?? 0,
		ctr: input.ctr ?? 0,
		position: input.position ?? 0,
		runId: input.runId ?? null,
		payloadJson: input.payloadJson ?? null,
		fetchedAt
	};
}

/**
 * `set` d'un upsert par LOT : chaque ligne doit reprendre SA propre valeur, donc
 * `excluded.*` (la ligne refusée par le conflit) et non une constante — une
 * constante écraserait tout le lot avec la valeur de la dernière ligne.
 */
const GSC_QUERY_PAGE_CONFLICT_SET = {
	clicks: sql`excluded.clicks`,
	impressions: sql`excluded.impressions`,
	ctr: sql`excluded.ctr`,
	position: sql`excluded.position`,
	runId: sql`excluded.run_id`,
	payloadJson: sql`excluded.payload_json`,
	fetchedAt: sql`excluded.fetched_at`
};

export async function upsertGscQueryPageObservation(
	input: UpsertGscQueryPageInput,
	client?: AppDb
): Promise<{ id: string }> {
	guardPayload(input.payloadJson, 'payload gsc_query_page_observations');
	const db = await resolveDb(client);
	const rows = await db
		.insert(gscQueryPageObservations)
		.values(gscQueryPageValues(input, nowDb()))
		.onConflictDoUpdate({
			target: [
				gscQueryPageObservations.projectId,
				gscQueryPageObservations.periodStart,
				gscQueryPageObservations.query,
				gscQueryPageObservations.page,
				gscQueryPageObservations.device
			],
			set: GSC_QUERY_PAGE_CONFLICT_SET
		})
		.returning({ id: gscQueryPageObservations.id });
	return { id: rows[0].id };
}

/**
 * Upsert par lot. Rend le nombre de lignes ENVOYÉES, pas le nombre de lignes
 * créées : `ON CONFLICT DO UPDATE` ne les distingue pas, et prétendre le contraire
 * ferait lire « 4 500 nouvelles observations » là où la semaine est simplement
 * recollectée. L'appelant compare les comptes avant/après s'il veut le delta.
 *
 * ⚠️ Le lot doit être DÉDUPLIQUÉ sur la clé unique en amont : Postgres refuse
 * (`ON CONFLICT DO UPDATE command cannot affect row a second time`) deux lignes de
 * même clé dans un même `INSERT`.
 */
export async function upsertGscQueryPageObservations(
	inputs: UpsertGscQueryPageInput[],
	client?: AppDb
): Promise<{ sent: number }> {
	if (inputs.length === 0) return { sent: 0 };
	for (const input of inputs) guardPayload(input.payloadJson, 'payload gsc_query_page_observations');
	const db = await resolveDb(client);
	const fetchedAt = nowDb();
	for (const part of chunk(inputs, OBSERVATION_CHUNK)) {
		await db
			.insert(gscQueryPageObservations)
			.values(part.map((i) => gscQueryPageValues(i, fetchedAt)))
			.onConflictDoUpdate({
				target: [
					gscQueryPageObservations.projectId,
					gscQueryPageObservations.periodStart,
					gscQueryPageObservations.query,
					gscQueryPageObservations.page,
					gscQueryPageObservations.device
				],
				set: GSC_QUERY_PAGE_CONFLICT_SET
			});
	}
	return { sent: inputs.length };
}

// ── 2. GSC agrégat page×device ──────────────────────────────────────

export interface UpsertGscPageInput {
	projectId: string;
	periodStart: string;
	periodEnd: string;
	page: string;
	device?: string;
	clicks?: number;
	impressions?: number;
	ctr?: number;
	position?: number;
	runId?: string | null;
	schemaVersion?: number;
	payloadJson?: string | null;
}

function gscPageValues(input: UpsertGscPageInput, fetchedAt: string) {
	return {
		id: createId(),
		projectId: input.projectId,
		provider: 'gsc',
		schemaVersion: input.schemaVersion ?? 1,
		periodStart: input.periodStart,
		periodEnd: input.periodEnd,
		page: input.page,
		device: input.device ?? '',
		clicks: input.clicks ?? 0,
		impressions: input.impressions ?? 0,
		ctr: input.ctr ?? 0,
		position: input.position ?? 0,
		runId: input.runId ?? null,
		payloadJson: input.payloadJson ?? null,
		fetchedAt
	};
}

const GSC_PAGE_CONFLICT_SET = GSC_QUERY_PAGE_CONFLICT_SET;

export async function upsertGscPageObservation(
	input: UpsertGscPageInput,
	client?: AppDb
): Promise<{ id: string }> {
	guardPayload(input.payloadJson, 'payload gsc_page_observations');
	const db = await resolveDb(client);
	const rows = await db
		.insert(gscPageObservations)
		.values(gscPageValues(input, nowDb()))
		.onConflictDoUpdate({
			target: [
				gscPageObservations.projectId,
				gscPageObservations.periodStart,
				gscPageObservations.page,
				gscPageObservations.device
			],
			set: GSC_PAGE_CONFLICT_SET
		})
		.returning({ id: gscPageObservations.id });
	return { id: rows[0].id };
}

/** Upsert par lot — mêmes règles que `upsertGscQueryPageObservations`. */
export async function upsertGscPageObservations(
	inputs: UpsertGscPageInput[],
	client?: AppDb
): Promise<{ sent: number }> {
	if (inputs.length === 0) return { sent: 0 };
	for (const input of inputs) guardPayload(input.payloadJson, 'payload gsc_page_observations');
	const db = await resolveDb(client);
	const fetchedAt = nowDb();
	for (const part of chunk(inputs, OBSERVATION_CHUNK)) {
		await db
			.insert(gscPageObservations)
			.values(part.map((i) => gscPageValues(i, fetchedAt)))
			.onConflictDoUpdate({
				target: [
					gscPageObservations.projectId,
					gscPageObservations.periodStart,
					gscPageObservations.page,
					gscPageObservations.device
				],
				set: GSC_PAGE_CONFLICT_SET
			});
	}
	return { sent: inputs.length };
}

// ── 3. Indexation / URL Inspection ──────────────────────────────────

export interface UpsertIndexInput {
	projectId: string;
	observedDate: string;
	url: string;
	coverageState?: string | null;
	verdict?: string | null;
	indexingState?: string | null;
	robotsState?: string | null;
	googleCanonical?: string | null;
	userCanonical?: string | null;
	lastCrawlAt?: string | null;
	runId?: string | null;
	schemaVersion?: number;
	payloadJson?: string | null;
}

export async function upsertIndexObservation(
	input: UpsertIndexInput,
	client?: AppDb
): Promise<{ id: string }> {
	guardPayload(input.payloadJson, 'payload index_observations');
	const db = await resolveDb(client);
	const id = createId();
	const fields = {
		coverageState: input.coverageState ?? null,
		verdict: input.verdict ?? null,
		indexingState: input.indexingState ?? null,
		robotsState: input.robotsState ?? null,
		googleCanonical: input.googleCanonical ?? null,
		userCanonical: input.userCanonical ?? null,
		lastCrawlAt: input.lastCrawlAt ?? null,
		runId: input.runId ?? null,
		payloadJson: input.payloadJson ?? null,
		fetchedAt: nowDb()
	};
	const rows = await db
		.insert(indexObservations)
		.values({
			id,
			projectId: input.projectId,
			observedDate: input.observedDate,
			url: input.url,
			schemaVersion: input.schemaVersion ?? 1,
			...fields
		})
		.onConflictDoUpdate({
			target: [indexObservations.projectId, indexObservations.url, indexObservations.observedDate],
			set: fields
		})
		.returning({ id: indexObservations.id });
	return { id: rows[0].id };
}

// ── 6. Positions mot-clé ────────────────────────────────────────────

export interface UpsertKeywordRankInput {
	projectId: string;
	observedDate: string;
	keyword: string;
	device?: string;
	page?: string | null;
	position?: number;
	clicks?: number | null;
	impressions?: number | null;
	ctr?: number | null;
	runId?: string | null;
	schemaVersion?: number;
	payloadJson?: string | null;
}

export async function upsertKeywordRankObservation(
	input: UpsertKeywordRankInput,
	client?: AppDb
): Promise<{ id: string }> {
	guardPayload(input.payloadJson, 'payload keyword_rank_observations');
	const db = await resolveDb(client);
	const id = createId();
	const fields = {
		page: input.page ?? null,
		position: input.position ?? 0,
		clicks: input.clicks ?? null,
		impressions: input.impressions ?? null,
		ctr: input.ctr ?? null,
		runId: input.runId ?? null,
		payloadJson: input.payloadJson ?? null,
		fetchedAt: nowDb()
	};
	const rows = await db
		.insert(keywordRankObservations)
		.values({
			id,
			projectId: input.projectId,
			observedDate: input.observedDate,
			keyword: input.keyword,
			device: input.device ?? '',
			schemaVersion: input.schemaVersion ?? 1,
			...fields
		})
		.onConflictDoUpdate({
			target: [
				keywordRankObservations.projectId,
				keywordRankObservations.keyword,
				keywordRankObservations.device,
				keywordRankObservations.observedDate
			],
			set: fields
		})
		.returning({ id: keywordRankObservations.id });
	return { id: rows[0].id };
}

// ── 10. Métriques Performance GMB ───────────────────────────────────

export interface UpsertGmbInsightInput {
	projectId: string;
	observedDate: string;
	locationId: string;
	metric: string;
	value?: number;
	runId?: string | null;
	schemaVersion?: number;
	payloadJson?: string | null;
}

export async function upsertGmbInsightObservation(
	input: UpsertGmbInsightInput,
	client?: AppDb
): Promise<{ id: string }> {
	guardPayload(input.payloadJson, 'payload gmb_insight_observations');
	const db = await resolveDb(client);
	const id = createId();
	const fields = {
		value: input.value ?? 0,
		runId: input.runId ?? null,
		payloadJson: input.payloadJson ?? null,
		fetchedAt: nowDb()
	};
	const rows = await db
		.insert(gmbInsightObservations)
		.values({
			id,
			projectId: input.projectId,
			observedDate: input.observedDate,
			locationId: input.locationId,
			metric: input.metric,
			schemaVersion: input.schemaVersion ?? 1,
			...fields
		})
		.onConflictDoUpdate({
			target: [
				gmbInsightObservations.projectId,
				gmbInsightObservations.locationId,
				gmbInsightObservations.observedDate,
				gmbInsightObservations.metric
			],
			set: fields
		})
		.returning({ id: gmbInsightObservations.id });
	return { id: rows[0].id };
}
