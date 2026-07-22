/**
 * JOB-001 — Boucle worker : réclamer → exécuter → conclure, arrêtable proprement.
 *
 * Le worker ne connaît pas les métiers : il résout un HANDLER par type de job.
 * Premier handler réel = le détecteur `keyword_opportunity` (FIND-004), ce qui
 * ferme la chaîne `queue → worker → détecteur → findings`.
 *
 * Arrêt gracieux (acceptation JOB-001) : sur signal, la boucle ne réclame plus
 * rien ; si un job est en cours, elle le TERMINE (ou le relâche s'il n'a pas
 * commencé) avant de sortir → aucun job « running » orphelin, aucune tentative
 * consommée pour rien.
 *
 * Hors périmètre : renouvellement de bail pendant l'exécution et récupération des
 * workers morts (JOB-002), classification fine des erreurs (JOB-003), DAG de
 * dépendances (JOB-004).
 */
import type { AppDb } from './db/types.js';
import { log } from './log.js';
import { claimJob, completeJob, failJob, releaseJob, type ClaimedJob } from './jobs-claim.js';
import { DEFAULT_LEASE_MS, NO_HANDLER_ERROR_CODE, type WorkerTickOutcome } from './job-state.js';
import { runKeywordOpportunityDetector } from './detectors/keyword-opportunity.js';

const logger = log('worker');

// ── Handlers ────────────────────────────────────────────────────────

export interface JobContext {
	db: AppDb;
	job: ClaimedJob;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

/** Type de job du détecteur d'opportunités (miroir du `step_type` de `scripts/detect.ts`). */
export const JOB_TYPE_DETECT_KEYWORD_OPPORTUNITY = 'detect:keyword_opportunity';

/** Job sans effet, utilisé par le test de concurrence et les fumigations. */
export const JOB_TYPE_NOOP = 'noop';

/**
 * Registre par défaut. `payload_json` du job peut porter `{ weeks, projectId }` ;
 * à défaut, le détecteur tourne sur le projet du job et sa fenêtre par défaut.
 */
export function defaultHandlers(): Map<string, JobHandler> {
	return new Map<string, JobHandler>([
		[
			JOB_TYPE_DETECT_KEYWORD_OPPORTUNITY,
			async ({ db, job }) => {
				const payload = parsePayload(job.payloadJson);
				const res = await runKeywordOpportunityDetector({
					db,
					projectId: (payload.projectId as string) ?? job.projectId,
					weeks: typeof payload.weeks === 'number' ? payload.weeks : undefined,
					runId: job.runId
				});
				logger.info('détection terminée', {
					jobId: job.id,
					projectId: job.projectId,
					detector: res.detectorVersion,
					created: res.counts.created,
					refreshed: res.counts.refreshed,
					truncated: res.truncated
				});
			}
		],
		[JOB_TYPE_NOOP, async () => {}]
	]);
}

function parsePayload(raw: string | null): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

// ── Boucle ──────────────────────────────────────────────────────────

export interface WorkerOptions {
	db: AppDb;
	workerId: string;
	/** Types traités par ce worker ; par défaut, ceux du registre. */
	types?: string[];
	handlers?: Map<string, JobHandler>;
	leaseMs?: number;
	/** Attente entre deux sondages quand la file est vide. */
	pollIntervalMs?: number;
	/** S'arrête dès que la file est vide (utile en cron/CI). */
	once?: boolean;
	/** Nombre maximal de jobs traités avant de rendre la main (0 = illimité). */
	maxJobs?: number;
	/** Arrêt gracieux (SIGINT/SIGTERM, timeout de cron…). */
	signal?: AbortSignal;
}

export interface WorkerStats {
	claimed: number;
	succeeded: number;
	failed: number;
	deadLettered: number;
	released: number;
	idleTicks: number;
	stoppedGracefully: boolean;
}

/**
 * Boucle principale. Renvoie ses compteurs, ce qui rend le worker testable et
 * observable sans lire les logs.
 */
export async function runWorker(options: WorkerOptions): Promise<WorkerStats> {
	const handlers = options.handlers ?? defaultHandlers();
	const types = options.types ?? [...handlers.keys()];
	const pollIntervalMs = options.pollIntervalMs ?? 2000;
	const maxJobs = options.maxJobs ?? 0;

	const stats: WorkerStats = {
		claimed: 0,
		succeeded: 0,
		failed: 0,
		deadLettered: 0,
		released: 0,
		idleTicks: 0,
		stoppedGracefully: false
	};

	logger.info('worker démarré', { workerId: options.workerId, types });

	for (;;) {
		// Point d'arrêt : on ne réclame JAMAIS un job après l'ordre d'arrêt —
		// c'est ce qui évite le job fantôme laissé « running ».
		if (options.signal?.aborted) {
			stats.stoppedGracefully = true;
			break;
		}
		if (maxJobs > 0 && stats.claimed >= maxJobs) break;

		const job = await claimJob({
			db: options.db,
			types,
			workerId: options.workerId,
			leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS
		});

		if (!job) {
			stats.idleTicks += 1;
			if (options.once) break;
			const stopped = await sleep(pollIntervalMs, options.signal);
			if (stopped) {
				stats.stoppedGracefully = true;
				break;
			}
			continue;
		}

		stats.claimed += 1;
		await handleClaimedJob(job, { ...options, handlers }, stats);
	}

	logger.info('worker arrêté', { workerId: options.workerId, ...stats });
	return stats;
}

async function handleClaimedJob(
	job: ClaimedJob,
	options: WorkerOptions & { handlers: Map<string, JobHandler> },
	stats: WorkerStats
): Promise<void> {
	// L'ordre d'arrêt est arrivé entre la réclamation et l'exécution : on rend le
	// job à la file au lieu de l'entamer (aucun effet, aucune tentative gâchée).
	if (options.signal?.aborted) {
		const released = await releaseJob({
			db: options.db,
			jobId: job.id,
			workerId: options.workerId
		});
		if (released) stats.released += 1;
		stats.stoppedGracefully = true;
		logger.info('job relâché (arrêt gracieux)', { jobId: job.id, type: job.type });
		return;
	}

	const handler = options.handlers.get(job.type);
	if (!handler) {
		// Erreur de configuration, traitée comme un échec normal (backoff puis
		// dead-letter) mais avec un code repérable.
		const outcome = await failJob({
			db: options.db,
			job,
			workerId: options.workerId,
			error: { code: NO_HANDLER_ERROR_CODE, message: `Aucun handler pour le type "${job.type}".` }
		});
		countFailure(outcome, stats);
		logger.error('aucun handler enregistré', { jobId: job.id, type: job.type });
		return;
	}

	const t0 = Date.now();
	try {
		await handler({ db: options.db, job });
		const done = await completeJob({
			db: options.db,
			jobId: job.id,
			workerId: options.workerId
		});
		if (done) {
			stats.succeeded += 1;
			logger.info('job réussi', { jobId: job.id, type: job.type, durationMs: Date.now() - t0 });
		} else {
			// Bail perdu (expiré et repris ailleurs) : on ne réécrit pas l'état
			// d'un job qu'on ne possède plus.
			logger.warn('job terminé mais bail perdu — état non réécrit', {
				jobId: job.id,
				type: job.type
			});
		}
	} catch (err) {
		const outcome = await failJob({
			db: options.db,
			job,
			workerId: options.workerId,
			error: err
		});
		countFailure(outcome, stats);
		logger.error('job échoué', {
			jobId: job.id,
			type: job.type,
			attempts: job.attempts,
			maxAttempts: job.maxAttempts,
			outcome: outcome?.status ?? 'bail perdu',
			retryInMs: outcome?.backoffMs
		});
	}
}

function countFailure(
	outcome: { status: 'queued' | 'dead' } | null,
	stats: WorkerStats
): void {
	if (!outcome) return;
	stats.failed += 1;
	if (outcome.status === 'dead') stats.deadLettered += 1;
}

/**
 * Attente interruptible : renvoie `true` si l'arrêt a été demandé pendant la
 * pause (le worker sort alors sans attendre la fin du délai).
 */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve(false);
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			resolve(true);
		}
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export type { WorkerTickOutcome };
