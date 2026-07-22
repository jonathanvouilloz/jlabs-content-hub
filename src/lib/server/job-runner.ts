/**
 * JOB-001/JOB-002 — Boucle worker : réclamer → exécuter → conclure, arrêtable
 * proprement, avec bail vivant et récupération des workers morts.
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
 * JOB-002 ajoute trois choses au tour de boucle :
 *   - un HEARTBEAT qui prolonge le bail pendant l'exécution (un job long ne se
 *     fait plus voler), et qui INTERROMPT le handler s'il perd son bail ;
 *   - un BUDGET DE DURÉE qui distingue un provider qui ne répond pas d'un crash
 *     local — le premier se constate de l'intérieur, vivant ;
 *   - une passe de REAPER sur les tours à vide : la file se répare elle-même,
 *     sans infra nouvelle (le cron reste l'affaire de JOB-005).
 *
 * JOB-003 ajoute le JUGEMENT sur l'échec : l'erreur est classée, et la classe
 * décide — replanification jittée, report pour quota (la tentative est rendue),
 * ou dead-letter immédiat quand rejouer ne peut rien changer.
 *
 * Hors périmètre : DAG de dépendances (JOB-004), console d'exploitation (JOB-007).
 */
import type { AppDb } from './db/types.js';
import { log } from './log.js';
import {
	claimJob,
	completeJob,
	deferJob,
	failJob,
	releaseJob,
	type ClaimedJob,
	type FailOutcome
} from './jobs-claim.js';
import {
	DEFAULT_LEASE_MS,
	NO_HANDLER_ERROR_CODE,
	computeRenewInterval,
	providerTimeoutError,
	type AbandonKind,
	type WorkerTickOutcome
} from './job-state.js';
import { classifyJobFailure, decideRetry, type ErrorClass } from './job-retry.js';
import {
	finishAttempt,
	reclaimExpiredLeases,
	renewLease,
	startAttempt
} from './jobs-lease.js';
import { recordStep, recomputeRunStatus } from './monitoring.js';
import { toDbTimestamp } from './timestamps.js';
import { runKeywordOpportunityDetector } from './detectors/keyword-opportunity.js';
import { runFindingProposer } from './proposers/finding-proposer.js';
import { expireSnoozes } from './findings.js';

const logger = log('worker');

// ── Handlers ────────────────────────────────────────────────────────

export interface JobContext {
	db: AppDb;
	job: ClaimedJob;
	/**
	 * Interrompu si le worker perd son bail, si le budget de durée est dépassé, ou
	 * si l'arrêt gracieux tombe. Un handler long DOIT le surveiller : au-delà, il
	 * travaille pour rien — un autre worker a déjà repris le job.
	 */
	signal: AbortSignal;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

/** Type de job du détecteur d'opportunités (miroir du `step_type` de `scripts/detect.ts`). */
export const JOB_TYPE_DETECT_KEYWORD_OPPORTUNITY = 'detect:keyword_opportunity';

/**
 * FIND-003 — expiration des veilles. Job À PART du détecteur : une veille doit
 * expirer même les semaines où aucune détection ne tourne (sans quoi le snooze
 * deviendrait un enterrement).
 */
export const JOB_TYPE_FINDINGS_LIFECYCLE = 'findings:lifecycle';

/**
 * AGT-000 — production de propositions à partir des findings actifs. Job À PART
 * du détecteur : il lit ce que la détection a laissé en base, et rejouer l'un
 * n'oblige pas à rejouer l'autre. Idempotent (dédup par `payload_hash`).
 */
export const JOB_TYPE_PROPOSE_ACTIONS = 'propose:actions';

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
		[
			JOB_TYPE_FINDINGS_LIFECYCLE,
			async ({ db, job }) => {
				const payload = parsePayload(job.payloadJson);
				const res = await expireSnoozes(
					{ projectId: (payload.projectId as string) ?? job.projectId },
					db
				);
				logger.info('veilles expirées', {
					jobId: job.id,
					projectId: job.projectId,
					reopened: res.reopened.length,
					stillSnoozed: res.stillSnoozed
				});
			}
		],
		[
			JOB_TYPE_PROPOSE_ACTIONS,
			async ({ db, job }) => {
				const payload = parsePayload(job.payloadJson);
				const res = await runFindingProposer({
					db,
					projectId: (payload.projectId as string) ?? job.projectId,
					runId: job.runId
				});
				logger.info('propositions produites', {
					jobId: job.id,
					projectId: job.projectId,
					proposer: res.proposerVersion,
					created: res.counts.created,
					refreshed: res.counts.refreshed,
					superseded: res.counts.superseded,
					// La troncature remonte dans les logs comme elle remonte en CLI :
					// un plafond atteint ne doit jamais se lire comme « tout est couvert ».
					truncated: res.truncated,
					totalMatched: res.totalMatched
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
	/**
	 * JOB-002 — budget de durée d'un job. Au-delà, l'exécution est interrompue et
	 * l'échec est classé `ProviderTimeout` (rejouable selon la politique de retry).
	 * 0 = aucun budget.
	 */
	maxJobDurationMs?: number;
	/** JOB-002 — nombre de baux morts repris par passe de reaper (0 = pas de reaper). */
	reapLimit?: number;
}

export interface WorkerStats {
	claimed: number;
	succeeded: number;
	failed: number;
	deadLettered: number;
	released: number;
	idleTicks: number;
	stoppedGracefully: boolean;
	/** JOB-002 — jobs repris à un worker mort par ce worker-ci. */
	reclaimed: number;
	abandonedByKind: Record<AbandonKind, number>;
	/** JOB-003 — jobs REPORTÉS pour cause de quota (tentative rendue, pas un échec). */
	deferred: number;
	/** JOB-003 — répartition des échecs par nature (lisible sans requêter la DB). */
	failedByClass: Record<ErrorClass, number>;
}

function emptyClassCounters(): Record<ErrorClass, number> {
	return { retryable: 0, quota: 0, auth: 0, permanent: 0 };
}

/** Budget de durée par défaut : au-delà, on considère que le provider ne répondra pas. */
export const DEFAULT_MAX_JOB_DURATION_MS = 30 * 60 * 1000; // 30 min

/** Baux morts repris par passe (borné : un tour de boucle reste court). */
export const DEFAULT_REAP_LIMIT = 20;

/**
 * Boucle principale. Renvoie ses compteurs, ce qui rend le worker testable et
 * observable sans lire les logs.
 */
export async function runWorker(options: WorkerOptions): Promise<WorkerStats> {
	const handlers = options.handlers ?? defaultHandlers();
	const types = options.types ?? [...handlers.keys()];
	const pollIntervalMs = options.pollIntervalMs ?? 2000;
	const maxJobs = options.maxJobs ?? 0;

	const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
	const reapLimit = options.reapLimit ?? DEFAULT_REAP_LIMIT;

	const stats: WorkerStats = {
		claimed: 0,
		succeeded: 0,
		failed: 0,
		deadLettered: 0,
		released: 0,
		idleTicks: 0,
		stoppedGracefully: false,
		reclaimed: 0,
		abandonedByKind: { worker_death: 0, lease_stall: 0 },
		deferred: 0,
		failedByClass: emptyClassCounters()
	};

	logger.info('worker démarré', { workerId: options.workerId, types });

	// Une passe de reaper AU DÉMARRAGE : le cas le plus fréquent est justement le
	// redémarrage après crash — les jobs que ce worker (ou son prédécesseur) a
	// laissés « running » doivent repartir tout de suite, pas au premier tour à vide.
	await reapOnce(options.db, reapLimit, leaseMs, stats);

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
			leaseMs
		});

		if (!job) {
			stats.idleTicks += 1;
			// Tour à vide = le bon moment pour réparer la file : rien d'autre à faire,
			// et un bail mort remis en queue redevient réclamable au tour suivant.
			await reapOnce(options.db, reapLimit, leaseMs, stats);
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

/**
 * Une passe de reaper, bornée et non bloquante : le reaper est une COMMODITÉ du
 * worker, pas sa mission. S'il échoue (réseau, verrou), on le journalise et la
 * boucle continue — un job perdu de plus se rattrapera à la passe suivante,
 * alors qu'un worker qui meurt sur son reaper n'en traiterait plus aucun.
 */
async function reapOnce(
	db: AppDb,
	limit: number,
	leaseMs: number,
	stats: WorkerStats
): Promise<void> {
	if (limit <= 0) return;
	try {
		const res = await reclaimExpiredLeases({ db, limit, leaseMs });
		if (res.reclaimed.length === 0) return;
		stats.reclaimed += res.reclaimed.length;
		stats.abandonedByKind.worker_death += res.byKind.worker_death;
		stats.abandonedByKind.lease_stall += res.byKind.lease_stall;
		logger.warn('baux morts repris', {
			reclaimed: res.reclaimed.length,
			requeued: res.requeued,
			deadLettered: res.deadLettered,
			workerDeath: res.byKind.worker_death,
			leaseStall: res.byKind.lease_stall
		});
	} catch (err) {
		logger.error('passe de reaper échouée (la boucle continue)', {
			error: err instanceof Error ? err.message : String(err)
		});
	}
}

/**
 * JOB-005 — Conclut, côté RUN, le job qui vient de finir son histoire.
 *
 * Un job planifié porte le `run_id` du créneau qui l'a produit. Sans cette ligne, le
 * run resterait `queued` à vie : `classifyRunOutcome` dérive le statut d'un run de
 * ses STEPS, et personne n'en écrivait pour un job de queue. La supervision aurait
 * alors montré des runs éternellement en attente au-dessus de jobs réussis.
 *
 * N'est appelée qu'aux issues TERMINALES (réussi, ou mort après épuisement) : un job
 * qui va être rejoué n'a rien conclu, et lui écrire un step `failed` ferait basculer
 * son run en échec avant que la partie soit jouée.
 *
 * Non bloquante, comme la passe de reaper : l'exécution du job fait foi, sa
 * comptabilité de run ne doit jamais pouvoir la faire échouer après coup.
 */
async function concludeRunStep(input: {
	db: AppDb;
	job: ClaimedJob;
	status: 'success' | 'failed';
	durationMs: number;
	errorCode?: string | null;
	errorMessage?: string | null;
}): Promise<void> {
	if (!input.job.runId) return;
	try {
		await recordStep(
			{
				runId: input.job.runId,
				stepType: input.job.type,
				status: input.status,
				// L'`attempt` du job : deux tentatives d'un même job écrivent deux steps
				// distincts, et l'unique (run, step_type, attempt) rend l'écriture
				// idempotente si le même verdict était rejoué.
				attempt: Math.max(1, input.job.attempts),
				durationMs: input.durationMs,
				errorCode: input.errorCode ?? null,
				errorMessage: input.errorMessage ?? null,
				finishedAt: toDbTimestamp()
			},
			input.db
		);
		await recomputeRunStatus(input.job.runId, input.db);
	} catch (err) {
		logger.warn('conclusion du run échouée (le job, lui, est conclu)', {
			jobId: input.job.id,
			runId: input.job.runId,
			error: err instanceof Error ? err.message : String(err)
		});
	}
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
		if (released) {
			stats.released += 1;
			// Journalisé quand même : le compteur `attempts` du job REDESCEND (la
			// tentative est rendue). Sans cette ligne, l'historique aurait un trou
			// inexplicable — c'est précisément ce que le journal existe pour éviter.
			const rel = await startAttempt({
				db: options.db,
				jobId: job.id,
				projectId: job.projectId,
				attemptNo: job.attempts,
				workerId: options.workerId
			});
			await finishAttempt({ db: options.db, attemptId: rel.id, outcome: 'released' });
		}
		stats.stoppedGracefully = true;
		logger.info('job relâché (arrêt gracieux)', { jobId: job.id, type: job.type });
		return;
	}

	// Le journal s'ouvre AVANT toute exécution : si ce worker meurt à l'instant
	// suivant, le reaper trouvera une tentative ouverte à clore en `abandoned` —
	// c'est ce qui rend l'abandon visible plutôt que déduit d'un compteur.
	const attempt = await startAttempt({
		db: options.db,
		jobId: job.id,
		projectId: job.projectId,
		attemptNo: job.attempts,
		workerId: options.workerId
	});

	const handler = options.handlers.get(job.type);
	if (!handler) {
		// Erreur de CONFIGURATION : depuis JOB-003 elle est classée `permanent` →
		// dead-letter immédiat. Rejouer cinq fois n'a jamais fait apparaître un
		// handler manquant, ça ne faisait que retarder le moment où on le voit.
		const outcome = await failJob({
			db: options.db,
			job,
			workerId: options.workerId,
			error: { code: NO_HANDLER_ERROR_CODE, message: `Aucun handler pour le type "${job.type}".` }
		});
		countFailure(outcome, stats);
		await finishAttempt({
			db: options.db,
			attemptId: attempt.id,
			outcome: outcome?.status === 'dead' ? 'dead' : 'failed',
			errorClass: outcome?.errorClass ?? 'permanent',
			errorCode: NO_HANDLER_ERROR_CODE,
			errorMessage: `Aucun handler pour le type "${job.type}".`
		});
		logger.error('aucun handler enregistré', {
			jobId: job.id,
			type: job.type,
			outcome: outcome?.status ?? 'bail perdu',
			deadReason: outcome?.deadReason ?? undefined
		});
		if (outcome?.status === 'dead') {
			await concludeRunStep({
				db: options.db,
				job,
				status: 'failed',
				durationMs: 0,
				errorCode: NO_HANDLER_ERROR_CODE,
				errorMessage: `Aucun handler pour le type "${job.type}".`
			});
		}
		return;
	}

	const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
	const maxDurationMs = options.maxJobDurationMs ?? DEFAULT_MAX_JOB_DURATION_MS;

	// Signal propre au job : il s'interrompt si le bail est PERDU ou si le budget
	// de durée est dépassé. Volontairement PAS relié au signal d'arrêt gracieux :
	// l'acceptation JOB-001 exige qu'un job commencé avant l'ordre d'arrêt soit
	// mené à son terme (l'arrêt coupe la RÉCLAMATION, pas l'exécution en cours).
	const jobAbort = new AbortController();

	let heartbeats = 0;
	let leaseLost = false;
	let timedOut = false;

	// Heartbeat : trois battements par bail (computeRenewInterval). Un job long
	// prolonge ainsi son bail indéfiniment ; s'il perd son bail, il l'apprend ici
	// et cesse de travailler pour un job qui ne lui appartient plus.
	const beat = setInterval(() => {
		void (async () => {
			const renewed = await renewLease({
				db: options.db,
				jobId: job.id,
				workerId: options.workerId,
				leaseMs
			}).catch(() => null);
			if (renewed) {
				heartbeats += 1;
			} else {
				leaseLost = true;
				jobAbort.abort();
			}
		})();
	}, computeRenewInterval({ leaseMs }));

	const budget =
		maxDurationMs > 0
			? setTimeout(() => {
					timedOut = true;
					jobAbort.abort();
				}, maxDurationMs)
			: null;

	const t0 = Date.now();
	// La garde rejette dès que le signal tombe. `Promise.race` en consomme le
	// rejet ; le `.catch` vide couvre le cas où il tombe APRÈS la course (bail
	// perdu pendant `completeJob`) — sans lui, ce serait un unhandled rejection.
	const guard = abortRace(jobAbort.signal, () =>
		timedOut ? providerTimeoutError(maxDurationMs) : null
	);
	guard.catch(() => {});

	try {
		// Course entre le handler et sa garde : un handler qui n'écoute pas son
		// signal ne doit pas pouvoir retenir le worker au-delà de son budget.
		await Promise.race([handler({ db: options.db, job, signal: jobAbort.signal }), guard]);
		if (timedOut) throw providerTimeoutError(maxDurationMs);

		const done = await completeJob({
			db: options.db,
			jobId: job.id,
			workerId: options.workerId
		});
		if (done) {
			stats.succeeded += 1;
			await finishAttempt({
				db: options.db,
				attemptId: attempt.id,
				outcome: 'succeeded',
				heartbeatCount: heartbeats
			});
			logger.info('job réussi', { jobId: job.id, type: job.type, durationMs: Date.now() - t0 });
			await concludeRunStep({ db: options.db, job, status: 'success', durationMs: Date.now() - t0 });
		} else {
			// Bail perdu (expiré et repris ailleurs) : on ne réécrit pas l'état
			// d'un job qu'on ne possède plus — ni le sien, ni celui de sa tentative,
			// que le reaper a déjà close en `abandoned`.
			logger.warn('job terminé mais bail perdu — état non réécrit', {
				jobId: job.id,
				type: job.type,
				leaseLost
			});
		}
	} catch (err) {
		// L'erreur est d'abord CLASSÉE : c'est elle, et non le seul compteur de
		// tentatives, qui décide du sort du job (JOB-003).
		const { code, errorClass, isProviderTimeout: timeout } = classifyJobFailure(err);
		// Un dépassement de budget est reformulé en erreur de timeout provider (JOB-002) :
		// `classifyExecutionError` étant idempotente, la classe ne bouge pas.
		const cause = timeout ? providerTimeoutError(maxDurationMs) : err;

		// Décision prise UNE fois ici pour ROUTER ; sur les chemins retry/dead c'est
		// `failJob` qui la reprend à son compte (même entrée, même politique).
		const decision = decideRetry({
			attempts: job.attempts,
			maxAttempts: job.maxAttempts,
			deferrals: job.deferrals,
			error: cause,
			now: new Date(),
			random: Math.random
		});

		if (decision.action === 'defer') {
			// Quota : le job n'a rien fait de mal. Sa tentative lui est rendue, il
			// repassera quand le provider aura desserré.
			const deferred = await deferJob({
				db: options.db,
				jobId: job.id,
				workerId: options.workerId,
				delayMs: decision.delayMs,
				errorCode: decision.errorCode,
				errorMessage: decision.errorMessage
			});
			if (deferred) stats.deferred += 1;
			await finishAttempt({
				db: options.db,
				attemptId: attempt.id,
				outcome: deferred ? 'deferred' : 'abandoned',
				errorClass,
				errorCode: code,
				errorMessage: decision.errorMessage,
				heartbeatCount: heartbeats
			});
			logger.warn('job reporté (quota provider)', {
				jobId: job.id,
				type: job.type,
				errorCode: code,
				deferrals: job.deferrals + 1,
				retryAfterMs: decision.retryAfterMs,
				retryInMs: deferred?.delayMs ?? decision.delayMs
			});
			return;
		}

		const outcome = await failJob({
			db: options.db,
			job,
			workerId: options.workerId,
			error: cause
		});
		countFailure(outcome, stats);
		await finishAttempt({
			db: options.db,
			attemptId: attempt.id,
			outcome: outcome === null ? 'abandoned' : outcome.status === 'dead' ? 'dead' : 'failed',
			errorClass,
			errorCode: code,
			errorMessage: err instanceof Error ? err.message : String(err),
			heartbeatCount: heartbeats
		});
		logger.error('job échoué', {
			jobId: job.id,
			type: job.type,
			attempts: job.attempts,
			maxAttempts: job.maxAttempts,
			errorCode: code,
			errorClass,
			providerTimeout: timeout,
			outcome: outcome?.status ?? 'bail perdu',
			deadReason: outcome?.deadReason ?? undefined,
			retryInMs: outcome?.backoffMs
		});
		// Seul un job MORT a fini son histoire : un job encore rejouable ne conclut
		// pas son run (il peut très bien réussir à la tentative suivante).
		if (outcome?.status === 'dead') {
			await concludeRunStep({
				db: options.db,
				job,
				status: 'failed',
				durationMs: Date.now() - t0,
				errorCode: code,
				errorMessage: err instanceof Error ? err.message : String(err)
			});
		}
	} finally {
		// Un intervalle survivant garderait le process en vie après la boucle.
		clearInterval(beat);
		if (budget) clearTimeout(budget);
	}
}

/**
 * Promesse qui ne se résout JAMAIS tant que le signal n'est pas déclenché, et
 * qui rejette dès qu'il l'est. Sert à borner un handler qui ignorerait son
 * signal : sans elle, le budget de durée ne serait qu'une suggestion.
 * `reason()` fournit l'erreur (timeout provider) ou `null` (bail perdu / arrêt).
 */
function abortRace(
	signal: AbortSignal,
	reason: () => { code: string; message: string } | null
): Promise<never> {
	return new Promise((_, reject) => {
		const fire = () =>
			reject(reason() ?? { code: 'LeaseLost', message: 'Bail perdu ou arrêt demandé.' });
		if (signal.aborted) return fire();
		signal.addEventListener('abort', fire, { once: true });
	});
}

function countFailure(outcome: FailOutcome | null, stats: WorkerStats): void {
	if (!outcome) return;
	stats.failed += 1;
	stats.failedByClass[outcome.errorClass] += 1;
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
