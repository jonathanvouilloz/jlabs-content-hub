/**
 * DATA-008 — Rétention, agrégation & purge (SPEC §7.11).
 *
 * - `RETENTION_DEFAULTS` + `seedRetentionPolicies` : politique §7.11 configurable
 *   par type de donnée, upsert idempotent (dédup par data_type).
 * - `upsertObservationAggregate` : agrégat semaine/mois/année idempotent (avant purge).
 * - `createPurgeRun`/`updatePurgeRun`/`checkpointPurgeRun` : run de purge observable
 *   et reprenable (dry-run par défaut). La suppression réelle vit dans scripts/purge.ts.
 *
 * Garde commune : les blobs JSON (dimensions, métriques, plan) sont BORNÉS
 * (assertBoundedPayload) et sans secret (assertNoInlineSecret) avant persistance.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { retentionPolicies, observationAggregates, purgeRuns } from './db/schema.js';
import { createId } from './utils.js';
import { assertNoInlineSecret } from './projection-state.js';
import { assertBoundedPayload } from './observation-state.js';
import {
	canonicalDimensions,
	RETENTION_DEFAULTS,
	type RetentionDefault
} from './retention-state.js';

// Ré-export : les défauts de rétention (§7.11) vivent dans le module pur pour être
// importables sans tirer `db`/`$env` (runner scripts/purge.ts).
export { RETENTION_DEFAULTS, type RetentionDefault };

const nowIso = () => new Date().toISOString();

function guard(json: string | null | undefined, context: string): void {
	assertBoundedPayload(json, context);
	assertNoInlineSecret(json, context);
}

/** Upsert idempotent des politiques par défaut (dédup par data_type). */
export async function seedRetentionPolicies(defaults: RetentionDefault[] = RETENTION_DEFAULTS) {
	const now = nowIso();
	for (const d of defaults) {
		await db
			.insert(retentionPolicies)
			.values({
				id: createId(),
				dataType: d.dataType,
				category: d.category,
				retentionDays: d.retentionDays,
				aggregateBeforePurge: d.aggregateBeforePurge,
				requiresL4: d.requiresL4,
				protected: d.protected,
				sourceTable: d.sourceTable,
				timestampColumn: d.timestampColumn,
				description: d.description,
				active: true,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: retentionPolicies.dataType,
				set: {
					category: d.category,
					retentionDays: d.retentionDays,
					aggregateBeforePurge: d.aggregateBeforePurge,
					requiresL4: d.requiresL4,
					protected: d.protected,
					sourceTable: d.sourceTable,
					timestampColumn: d.timestampColumn,
					description: d.description,
					updatedAt: now
				}
			});
	}
	return defaults.length;
}

/** Toutes les politiques (pour le planificateur de purge). */
export async function listRetentionPolicies() {
	return db.select().from(retentionPolicies);
}

// ── Agrégats (idempotents, avant purge) ─────────────────────────────

export interface UpsertAggregateInput {
	projectId: string;
	source: string;
	grain: string; // week|month|year
	periodStart: string;
	periodEnd: string;
	dimensions: ReadonlyArray<string | number | null | undefined>;
	metricsJson?: string | null;
	sampleCount: number;
}

/** Hash canonique du tuple de dimensions d'un agrégat (dédup). */
export function computeDimensionsHash(
	dimensions: ReadonlyArray<string | number | null | undefined>
): string {
	return createHash('sha256').update(canonicalDimensions(dimensions)).digest('hex');
}

/**
 * Upsert d'un agrégat. Idempotent (unique projet+source+grain+période+dimensions)
 * → re-agréger une même période ne duplique pas et rafraîchit les métriques : la
 * reprise de purge ne double-compte jamais.
 */
export async function upsertObservationAggregate(input: UpsertAggregateInput): Promise<{ id: string }> {
	const dimensionsJson = canonicalDimensions(input.dimensions);
	guard(dimensionsJson, 'dimensions_json agrégat');
	guard(input.metricsJson, 'metrics_json agrégat');
	const dimensionsHash = computeDimensionsHash(input.dimensions);
	const id = createId();
	const now = nowIso();

	const rows = await db
		.insert(observationAggregates)
		.values({
			id,
			projectId: input.projectId,
			source: input.source,
			grain: input.grain,
			periodStart: input.periodStart,
			periodEnd: input.periodEnd,
			dimensionsHash,
			dimensionsJson,
			metricsJson: input.metricsJson ?? null,
			sampleCount: input.sampleCount,
			computedAt: now
		})
		.onConflictDoUpdate({
			target: [
				observationAggregates.projectId,
				observationAggregates.source,
				observationAggregates.grain,
				observationAggregates.periodStart,
				observationAggregates.dimensionsHash
			],
			set: {
				metricsJson: input.metricsJson ?? null,
				sampleCount: input.sampleCount,
				periodEnd: input.periodEnd,
				computedAt: now
			}
		})
		.returning({ id: observationAggregates.id });

	return { id: rows[0].id };
}

// ── Runs de purge (observables, reprenables) ────────────────────────

export interface CreatePurgeRunInput {
	dryRun?: boolean;
	triggeredBy?: string;
	approvalRef?: string | null;
	policyVersion?: number | null;
	planJson?: string | null;
}

/** Ouvre un run de purge (dry-run par défaut). */
export async function createPurgeRun(input: CreatePurgeRunInput = {}): Promise<{ id: string }> {
	guard(input.planJson, 'plan_json purge_run');
	const id = createId();
	await db.insert(purgeRuns).values({
		id,
		status: input.dryRun === false ? 'running' : 'planned',
		dryRun: input.dryRun ?? true,
		triggeredBy: input.triggeredBy ?? null,
		approvalRef: input.approvalRef ?? null,
		policyVersion: input.policyVersion ?? null,
		planJson: input.planJson ?? null,
		startedAt: input.dryRun === false ? nowIso() : null
	});
	return { id };
}

/** Enregistre l'avancement (reprise sans double effet). */
export async function checkpointPurgeRun(id: string, checkpointJson: string): Promise<void> {
	guard(checkpointJson, 'checkpoint_json purge_run');
	await db.update(purgeRuns).set({ checkpointJson }).where(eq(purgeRuns.id, id));
}

/** Clôt un run de purge avec statut + métriques. */
export async function updatePurgeRun(
	id: string,
	patch: { status: string; metricsJson?: string | null; errorMessage?: string | null }
): Promise<void> {
	guard(patch.metricsJson, 'metrics_json purge_run');
	await db
		.update(purgeRuns)
		.set({
			status: patch.status,
			metricsJson: patch.metricsJson ?? undefined,
			errorMessage: patch.errorMessage ?? undefined,
			finishedAt: nowIso()
		})
		.where(eq(purgeRuns.id, id));
}
