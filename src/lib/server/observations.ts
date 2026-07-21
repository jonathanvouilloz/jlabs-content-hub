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
 */
import { db } from './db/index.js';
import {
	gscQueryPageObservations,
	gscPageObservations,
	indexObservations,
	keywordRankObservations,
	gmbInsightObservations
} from './db/schema.js';
import { createId } from './utils.js';
import { assertNoInlineSecret } from './projection-state.js';
import { assertBoundedPayload } from './observation-state.js';

const nowIso = () => new Date().toISOString();

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

export async function upsertGscQueryPageObservation(
	input: UpsertGscQueryPageInput
): Promise<{ id: string }> {
	guardPayload(input.payloadJson, 'payload gsc_query_page_observations');
	const id = createId();
	const metrics = {
		clicks: input.clicks ?? 0,
		impressions: input.impressions ?? 0,
		ctr: input.ctr ?? 0,
		position: input.position ?? 0,
		runId: input.runId ?? null,
		payloadJson: input.payloadJson ?? null,
		fetchedAt: nowIso()
	};
	const rows = await db
		.insert(gscQueryPageObservations)
		.values({
			id,
			projectId: input.projectId,
			periodStart: input.periodStart,
			periodEnd: input.periodEnd,
			query: input.query,
			page: input.page,
			device: input.device ?? '',
			schemaVersion: input.schemaVersion ?? 1,
			...metrics
		})
		.onConflictDoUpdate({
			target: [
				gscQueryPageObservations.projectId,
				gscQueryPageObservations.periodStart,
				gscQueryPageObservations.query,
				gscQueryPageObservations.page,
				gscQueryPageObservations.device
			],
			set: metrics
		})
		.returning({ id: gscQueryPageObservations.id });
	return { id: rows[0].id };
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

export async function upsertGscPageObservation(input: UpsertGscPageInput): Promise<{ id: string }> {
	guardPayload(input.payloadJson, 'payload gsc_page_observations');
	const id = createId();
	const metrics = {
		clicks: input.clicks ?? 0,
		impressions: input.impressions ?? 0,
		ctr: input.ctr ?? 0,
		position: input.position ?? 0,
		runId: input.runId ?? null,
		payloadJson: input.payloadJson ?? null,
		fetchedAt: nowIso()
	};
	const rows = await db
		.insert(gscPageObservations)
		.values({
			id,
			projectId: input.projectId,
			periodStart: input.periodStart,
			periodEnd: input.periodEnd,
			page: input.page,
			device: input.device ?? '',
			schemaVersion: input.schemaVersion ?? 1,
			...metrics
		})
		.onConflictDoUpdate({
			target: [
				gscPageObservations.projectId,
				gscPageObservations.periodStart,
				gscPageObservations.page,
				gscPageObservations.device
			],
			set: metrics
		})
		.returning({ id: gscPageObservations.id });
	return { id: rows[0].id };
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

export async function upsertIndexObservation(input: UpsertIndexInput): Promise<{ id: string }> {
	guardPayload(input.payloadJson, 'payload index_observations');
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
		fetchedAt: nowIso()
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
	input: UpsertKeywordRankInput
): Promise<{ id: string }> {
	guardPayload(input.payloadJson, 'payload keyword_rank_observations');
	const id = createId();
	const fields = {
		page: input.page ?? null,
		position: input.position ?? 0,
		clicks: input.clicks ?? null,
		impressions: input.impressions ?? null,
		ctr: input.ctr ?? null,
		runId: input.runId ?? null,
		payloadJson: input.payloadJson ?? null,
		fetchedAt: nowIso()
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
	input: UpsertGmbInsightInput
): Promise<{ id: string }> {
	guardPayload(input.payloadJson, 'payload gmb_insight_observations');
	const id = createId();
	const fields = {
		value: input.value ?? 0,
		runId: input.runId ?? null,
		payloadJson: input.payloadJson ?? null,
		fetchedAt: nowIso()
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
