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
import { jobs, monitoringRuns, monitoringSteps } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { createId } from './utils.js';
import { toDbTimestamp } from './timestamps.js';
import { assertNoInlineSecret } from './projection-state.js';
import {
	classifyRunOutcome,
	latestAttemptPerStep,
	type RunType,
	type StepStatus,
	type TriggerSource
} from './monitoring-state.js';
import { serializeDependencies, type JobDependency } from './job-graph.js';

/**
 * Client d'écriture : celui de l'app par défaut, ou un client INJECTÉ (runners
 * `scripts/`, qui construisent leur propre Pool). L'import de `db/index.js` est
 * DYNAMIQUE et n'a lieu qu'à défaut de client fourni → ce module reste chargeable
 * hors runtime SvelteKit (où `$env/dynamic/private` n'existe pas).
 */
async function resolveDb(client?: AppDb): Promise<AppDb> {
	if (client) return client;
	const mod = await import('./db/index.js');
	return mod.db;
}

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
export async function createRun(input: CreateRunInput, client?: AppDb): Promise<CreateRunResult> {
	const db = await resolveDb(client);
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
 *
 * JOB-004 — les tentatives sont RÉDUITES au dernier verdict par `step_type` avant
 * classification : un step qui a échoué puis, après reprise, réussi ne doit pas
 * laisser son run en `partial` pour toujours (cf. `latestAttemptPerStep`).
 */
export async function recomputeRunStatus(runId: string, client?: AppDb): Promise<void> {
	const db = await resolveDb(client);
	const steps = await db.query.monitoringSteps.findMany({
		where: eq(monitoringSteps.runId, runId),
		columns: { stepType: true, attempt: true, status: true, finishedAt: true }
	});
	const status = classifyRunOutcome(latestAttemptPerStep(steps));
	await db
		.update(monitoringRuns)
		.set({ status, updatedAt: toDbTimestamp() })
		.where(eq(monitoringRuns.id, runId));
}

/**
 * JOB-005/JOB-004 — Conclut, côté RUN, le job qui vient de finir son histoire.
 *
 * Un job planifié porte le `run_id` du créneau qui l'a produit. Sans cette ligne, le
 * run resterait `queued` à vie : `classifyRunOutcome` dérive le statut d'un run de ses
 * STEPS, et personne n'en écrivait pour un job de queue. La supervision aurait alors
 * montré des runs éternellement en attente au-dessus de jobs réussis.
 *
 * N'est appelée qu'aux issues TERMINALES (réussi · mort après épuisement · sauté faute
 * de prérequis) : un job qui va être rejoué n'a rien conclu, et lui écrire un step
 * `failed` ferait basculer son run en échec avant que la partie soit jouée.
 *
 * Vit ICI plutôt que dans `job-runner.ts` parce que deux appelants en ont besoin — le
 * runner et la passe de dépendances (`jobs-graph.ts`) — et que les faire s'importer
 * l'un l'autre créerait un cycle.
 *
 * Non bloquante côté appelant : l'exécution du job fait foi, sa comptabilité de run ne
 * doit jamais pouvoir la faire échouer après coup.
 */
export async function concludeJobStep(input: {
	db?: AppDb;
	runId: string | null;
	stepType: string;
	/** `jobs.attempts` ; 0 pour un job sauté, qui n'a rien tenté. */
	attempt: number;
	status: Extract<StepStatus, 'success' | 'failed' | 'skipped'>;
	durationMs?: number | null;
	errorCode?: string | null;
	errorMessage?: string | null;
}): Promise<void> {
	if (!input.runId) return;
	const db = await resolveDb(input.db);
	await recordStep(
		{
			runId: input.runId,
			stepType: input.stepType,
			status: input.status,
			// L'`attempt` du job : deux tentatives d'un même job écrivent deux steps
			// distincts, et l'unique (run, step_type, attempt) rend l'écriture
			// idempotente si le même verdict était rejoué.
			attempt: Math.max(1, input.attempt),
			durationMs: input.durationMs ?? null,
			errorCode: input.errorCode ?? null,
			errorMessage: input.errorMessage ?? null,
			finishedAt: toDbTimestamp()
		},
		db
	);
	await recomputeRunStatus(input.runId, db);
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
export async function recordStep(input: RecordStepInput, client?: AppDb): Promise<{ id: string }> {
	assertNoInlineSecret(input.metadataJson, 'metadata_json de step');
	const db = await resolveDb(client);

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
	/**
	 * JOB-004 — prérequis de ce job. TYPÉ, jamais du texte libre : `claimJob` casse
	 * cette colonne en `jsonb` dans sa garde, et une valeur malformée y ferait échouer
	 * la requête de réclamation ENTIÈRE — donc la file, pas seulement ce job.
	 * La sérialisation est faite ici, elle n'est pas laissée à l'appelant.
	 */
	dependsOn?: JobDependency[] | null;
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
export async function enqueueJob(input: EnqueueJobInput, client?: AppDb): Promise<EnqueueJobResult> {
	assertNoInlineSecret(input.payloadJson, 'payload_json de job');
	const db = await resolveDb(client);

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
		dependsOn: serializeDependencies(input.dependsOn)
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
