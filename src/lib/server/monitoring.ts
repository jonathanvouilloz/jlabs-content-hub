/**
 * DATA-003 — Orchestration : runs, steps & queue de jobs (SPEC §7.3/§7.4/§6.2).
 *
 * Helpers d'écriture concurrency-safe. La réclamation atomique des jobs
 * (`FOR UPDATE SKIP LOCKED`) N'EST PAS ici : c'est JOB-001. Ce module se limite à
 * créer/dédupliquer runs, steps et jobs, et à recalculer le statut d'un run.
 * Invariant clé : deux créations concurrentes avec la même `idempotency_key` ne
 * produisent qu'un seul run/job logique (unique index + onConflictDoNothing).
 */
import { and, eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { jobs, monitoringRuns, monitoringSteps } from './db/schema.js';
import { createId } from './utils.js';
import { assertNoInlineSecret } from './projection-state.js';
import { classifyRunOutcome, type RunType, type StepStatus, type TriggerSource } from './monitoring-state.js';

// ── Runs ────────────────────────────────────────────────────────────

export interface CreateRunInput {
	projectId: string;
	runType: RunType | string;
	idempotencyKey: string;
	triggeredBy?: TriggerSource | string;
	periodStart?: string | null;
	periodEnd?: string | null;
	summaryJson?: string | null;
	costJson?: string | null;
}

export interface CreateRunResult {
	created: boolean;
	id: string;
}

/**
 * Crée un run logique, ou renvoie l'existant si la clé d'idempotence est déjà prise.
 * `onConflictDoNothing` sur (project_id, idempotency_key) rend l'opération sûre en
 * concurrence : deux appels simultanés avec la même clé → un seul run inséré,
 * l'autre récupère l'id existant.
 */
export async function createRun(input: CreateRunInput): Promise<CreateRunResult> {
	const id = createId();

	const inserted = await db
		.insert(monitoringRuns)
		.values({
			id,
			projectId: input.projectId,
			runType: input.runType,
			idempotencyKey: input.idempotencyKey,
			triggeredBy: input.triggeredBy ?? 'schedule',
			periodStart: input.periodStart ?? null,
			periodEnd: input.periodEnd ?? null,
			summaryJson: input.summaryJson ?? null,
			costJson: input.costJson ?? null
		})
		.onConflictDoNothing({
			target: [monitoringRuns.projectId, monitoringRuns.idempotencyKey]
		})
		.returning({ id: monitoringRuns.id });

	if (inserted[0]) return { created: true, id: inserted[0].id };

	const existing = await db.query.monitoringRuns.findFirst({
		where: and(
			eq(monitoringRuns.projectId, input.projectId),
			eq(monitoringRuns.idempotencyKey, input.idempotencyKey)
		)
	});
	return { created: false, id: existing!.id };
}

/**
 * Recalcule le statut d'un run depuis les statuts de ses steps (classifyRunOutcome)
 * et le persiste. `partial` = mix succès + échec. No-op si le run n'existe pas.
 */
export async function recomputeRunStatus(runId: string): Promise<void> {
	const steps = await db.query.monitoringSteps.findMany({
		where: eq(monitoringSteps.runId, runId),
		columns: { status: true }
	});
	const status = classifyRunOutcome(steps.map((s) => s.status as StepStatus));
	await db
		.update(monitoringRuns)
		.set({ status, updatedAt: new Date().toISOString() })
		.where(eq(monitoringRuns.id, runId));
}

// ── Steps ───────────────────────────────────────────────────────────

export interface RecordStepInput {
	runId: string;
	stepType: string;
	provider?: string | null;
	status?: StepStatus | string;
	attempt?: number;
	inputHash?: string | null;
	outputHash?: string | null;
	startedAt?: string | null;
	finishedAt?: string | null;
	durationMs?: number | null;
	errorCode?: string | null;
	errorMessage?: string | null;
	metadataJson?: string | null;
}

/**
 * Enregistre une tentative de step. Unique par (run_id, step_type, attempt) :
 * `onConflictDoNothing` rend l'insert idempotent (rejeu de la même tentative =
 * no-op). `force` doit passer un `attempt` supérieur pour créer une nouvelle ligne.
 */
export async function recordStep(input: RecordStepInput): Promise<{ id: string }> {
	assertNoInlineSecret(input.metadataJson, 'metadata_json de step');

	const id = createId();
	const inserted = await db
		.insert(monitoringSteps)
		.values({
			id,
			runId: input.runId,
			stepType: input.stepType,
			provider: input.provider ?? null,
			status: input.status ?? 'queued',
			attempt: input.attempt ?? 1,
			inputHash: input.inputHash ?? null,
			outputHash: input.outputHash ?? null,
			startedAt: input.startedAt ?? null,
			finishedAt: input.finishedAt ?? null,
			durationMs: input.durationMs ?? null,
			errorCode: input.errorCode ?? null,
			errorMessage: input.errorMessage ?? null,
			metadataJson: input.metadataJson ?? null
		})
		.onConflictDoNothing({
			target: [monitoringSteps.runId, monitoringSteps.stepType, monitoringSteps.attempt]
		})
		.returning({ id: monitoringSteps.id });

	if (inserted[0]) return { id: inserted[0].id };

	const existing = await db.query.monitoringSteps.findFirst({
		where: and(
			eq(monitoringSteps.runId, input.runId),
			eq(monitoringSteps.stepType, input.stepType),
			eq(monitoringSteps.attempt, input.attempt ?? 1)
		)
	});
	return { id: existing!.id };
}

// ── Jobs (enqueue only ; le dequeue atomique = JOB-001) ─────────────

export interface EnqueueJobInput {
	projectId: string;
	type: string;
	idempotencyKey: string;
	runId?: string | null;
	priority?: number;
	payloadJson?: string | null;
	maxAttempts?: number;
	availableAt?: string | null;
	dependsOn?: string | null;
}

export interface EnqueueJobResult {
	created: boolean;
	id: string;
}

/**
 * Met un job en file, ou renvoie l'existant si la clé d'idempotence est déjà prise.
 * Même garantie de concurrence que `createRun` (unique (project_id, idempotency_key)
 * + onConflictDoNothing) : pas de doublon de job pour une même clé.
 */
export async function enqueueJob(input: EnqueueJobInput): Promise<EnqueueJobResult> {
	assertNoInlineSecret(input.payloadJson, 'payload_json de job');

	const id = createId();
	const values: typeof jobs.$inferInsert = {
		id,
		projectId: input.projectId,
		type: input.type,
		idempotencyKey: input.idempotencyKey,
		runId: input.runId ?? null,
		priority: input.priority ?? 0,
		payloadJson: input.payloadJson ?? null,
		maxAttempts: input.maxAttempts ?? 5,
		dependsOn: input.dependsOn ?? null
	};
	if (input.availableAt) values.availableAt = input.availableAt;

	const inserted = await db
		.insert(jobs)
		.values(values)
		.onConflictDoNothing({ target: [jobs.projectId, jobs.idempotencyKey] })
		.returning({ id: jobs.id });

	if (inserted[0]) return { created: true, id: inserted[0].id };

	const existing = await db.query.jobs.findFirst({
		where: and(eq(jobs.projectId, input.projectId), eq(jobs.idempotencyKey, input.idempotencyKey))
	});
	return { created: false, id: existing!.id };
}
