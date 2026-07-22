/**
 * JOB-005 — Scheduler : de l'horloge métier à la file de jobs.
 *
 * Ce module ne contient AUCUNE règle de calendrier — tout le raisonnement de
 * cadence et de timezone vit dans le module pur `schedule-state.ts`. Ici on ne fait
 * que trois choses : lire quels projets planifier, ouvrir un run logique par
 * occurrence due, et mettre les jobs du catalogue en file.
 *
 * **Aucune table de planification.** Le non-double-déclenchement n'est pas gardé par
 * un `last_fired_at` (qui pourrait diverger, se corrompre, ou se perdre au
 * redéploiement) mais par la clé d'idempotence du CRÉNEAU LOCAL, déjà unique en base
 * (`jobs_idempotency_unique`, `monitoring_runs_idempotency_unique`). Conséquence
 * directe : rejouer un tick, redémarrer à 09:00 ou rattraper un créneau manqué sont
 * la même opération, et elle est sans effet la deuxième fois.
 *
 * Le client `AppDb` est injectable (même discipline que `monitoring.ts`/`findings.ts`) :
 * une seule implémentation sert la route cron ET les runners `scripts/`.
 */
import { and, eq } from 'drizzle-orm';
import { projectProjections, projects } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { createRun, enqueueJob } from './monitoring.js';
import { deriveIdempotencyKey } from './monitoring-state.js';
import { toDbTimestamp } from './timestamps.js';
import {
	BUSINESS_TIMEZONE,
	DEFAULT_LOOKBACK_MS,
	SCHEDULE_CADENCES,
	catalogFor,
	dueOccurrences,
	nextOccurrence,
	postPublishSlots,
	resolveScheduleConfig,
	type CadenceSpec,
	type CatalogEntry,
	type Occurrence,
	type ScheduleCadence,
	type ScheduleConfig
} from './schedule-state.js';

/** Version de schéma portée par les clés d'idempotence du scheduler (SPEC §8.3). */
export const SCHEDULE_SCHEMA_VERSION = 1;

/**
 * `step_type` du RUN lui-même (les jobs, eux, portent leur propre type). Distinct de
 * tout type de job réel : le run et ses jobs ne doivent pas partager une clé.
 */
const RUN_STEP_TYPE = 'schedule';

/** Type de job des vérifications post-publication (pas encore de handler — cf. E03). */
export const JOB_TYPE_POST_PUBLISH_CHECK = 'post_publish:check';

async function resolveDb(client?: AppDb): Promise<AppDb> {
	if (client) return client;
	const mod = await import('./db/index.js');
	return mod.db;
}

// ── Projets & configuration ─────────────────────────────────────────

export interface SchedulableProject {
	id: string;
	slug: string;
	name: string;
}

/**
 * Projets à planifier : tous les non-archivés. On ne filtre PAS sur la présence
 * d'observations — un projet sans donnée doit quand même ouvrir son run hebdo, ne
 * serait-ce que pour que son absence de donnée devienne visible plutôt que muette.
 */
export async function listSchedulableProjects(client?: AppDb): Promise<SchedulableProject[]> {
	const db = await resolveDb(client);
	return db
		.select({ id: projects.id, slug: projects.slug, name: projects.name })
		.from(projects)
		.where(eq(projects.archived, false))
		.orderBy(projects.slug);
}

/**
 * Cadences d'un projet, lues dans la projection courante
 * (`project_projections.payload.schedules`). Calque exact de
 * `loadProjectThresholdOverrides` (detectors/keyword-opportunity.ts) : la table est
 * vide aujourd'hui, et un payload invalide ne doit jamais faire échouer — ni pire,
 * faire taire — la planification. Toute anomalie retombe sur les défauts SPEC.
 */
export async function loadProjectScheduleConfig(
	db: AppDb,
	projectId: string
): Promise<ScheduleConfig> {
	try {
		const row = await db.query.projectProjections.findFirst({
			where: and(
				eq(projectProjections.projectId, projectId),
				eq(projectProjections.status, 'current')
			),
			columns: { payload: true }
		});
		if (!row?.payload) return resolveScheduleConfig(null);
		const parsed = JSON.parse(row.payload) as {
			schedules?: Partial<Record<ScheduleCadence, Partial<CadenceSpec>>>;
		};
		return resolveScheduleConfig(parsed?.schedules ?? null);
	} catch {
		return resolveScheduleConfig(null);
	}
}

// ── Planification ───────────────────────────────────────────────────

export interface PlannedJob {
	jobType: string;
	jobId: string;
	created: boolean;
}

export interface PlannedOccurrence {
	projectId: string;
	projectSlug: string;
	cadence: ScheduleCadence;
	/** Créneau LOCAL (Europe/Zurich) — la clé logique de l'occurrence. */
	localSlot: string;
	/** Instant du créneau, au format DB (UTC), comparable au reste de la file. */
	instantDb: string;
	runId: string | null;
	runCreated: boolean;
	jobs: PlannedJob[];
	/** Le créneau a glissé (heure inexistante, passage à l'heure d'été). */
	adjusted: boolean;
	/** Le créneau local existait deux fois (retour à l'heure d'hiver). */
	ambiguous: boolean;
}

export interface PlanCounters {
	occurrences: number;
	runsCreated: number;
	runsReused: number;
	jobsCreated: number;
	jobsReused: number;
}

export interface PlanResult {
	nowDb: string;
	sinceDb: string;
	timeZone: string;
	dryRun: boolean;
	projects: number;
	occurrences: PlannedOccurrence[];
	counters: PlanCounters;
	/**
	 * Cadences ÉCARTÉES faute de handler (aujourd'hui `hourly` et `monthly`). Elles
	 * ne produisent aucune occurrence — sans quoi chaque tick enfilerait six lignes
	 * par projet et par heure pour ne rien exécuter, et le bruit finirait par cacher
	 * les cadences qui, elles, travaillent. Listées ici : écartées, jamais tues.
	 */
	cadencesWithoutJob: ScheduleCadence[];
	/** Projets dont la planification a échoué — le batch continue (isolation). */
	failures: Array<{ slug: string; error: string }>;
}

export interface PlanDueJobsInput {
	db?: AppDb;
	/** Référence de temps, INJECTÉE (rejouable, et testable sur une date DST). */
	now?: Date | number;
	/** Fenêtre de rattrapage (défaut 6 h). */
	lookbackMs?: number;
	timeZone?: string;
	/** N'écrit rien : calcule les occurrences dues et s'arrête là. */
	dryRun?: boolean;
	/** Restreint à un projet (par slug) — outillage et preuves. */
	onlyProjectSlug?: string;
	/**
	 * Catalogue de substitution. Existe pour que la preuve sur Neon puisse démontrer
	 * la chaîne complète (planifier → réclamer → exécuter) avec un type de test, sans
	 * déclencher une vraie détection sur des données de production. L'app ne le passe
	 * jamais : elle prend le catalogue réel.
	 */
	catalog?: (cadence: ScheduleCadence) => CatalogEntry[];
}

/**
 * Planifie toutes les occurrences dues dans `]now - lookback, now]`.
 *
 * Un run logique est ouvert par occurrence (`triggered_by='schedule'`), puis chaque
 * entrée du catalogue est mise en file avec `run_id` renseigné : la traçabilité
 * « quel créneau a produit ce job » ne dépend d'aucune convention de nommage.
 *
 * L'échec d'un projet n'interrompt pas les autres (même isolation que le cron
 * `gsc-snapshot`) : une intégration cassée sur un client ne doit pas priver les cinq
 * autres de leur monitoring hebdomadaire.
 */
export async function planDueJobs(input: PlanDueJobsInput = {}): Promise<PlanResult> {
	const db = await resolveDb(input.db);
	const timeZone = input.timeZone ?? BUSINESS_TIMEZONE;
	const nowMs = input.now === undefined ? Date.now() : toMs(input.now);
	const lookbackMs = input.lookbackMs ?? DEFAULT_LOOKBACK_MS;
	const sinceMs = nowMs - lookbackMs;
	const dryRun = input.dryRun === true;
	const catalog = input.catalog ?? catalogFor;

	const all = await listSchedulableProjects(db);
	const targets = input.onlyProjectSlug
		? all.filter((p) => p.slug === input.onlyProjectSlug)
		: all;

	const result: PlanResult = {
		nowDb: toDbTimestamp(new Date(nowMs)),
		sinceDb: toDbTimestamp(new Date(sinceMs)),
		timeZone,
		dryRun,
		projects: targets.length,
		occurrences: [],
		counters: {
			occurrences: 0,
			runsCreated: 0,
			runsReused: 0,
			jobsCreated: 0,
			jobsReused: 0
		},
		cadencesWithoutJob: SCHEDULE_CADENCES.filter((c) => catalog(c).length === 0),
		failures: []
	};

	for (const project of targets) {
		try {
			const config = await loadProjectScheduleConfig(db, project.id);

			for (const cadence of SCHEDULE_CADENCES) {
				// Une cadence sans handler n'est pas planifiée du tout : elle est
				// annoncée une fois dans `cadencesWithoutJob`, pas répétée à chaque
				// créneau de chaque projet.
				if (catalog(cadence).length === 0) continue;

				const due = dueOccurrences({
					cadence,
					spec: config[cadence],
					since: sinceMs,
					until: nowMs,
					timeZone
				});

				for (const occurrence of due) {
					const planned = await planOne({ db, project, occurrence, dryRun, catalog });
					result.occurrences.push(planned);
					result.counters.occurrences += 1;
					if (planned.runCreated) result.counters.runsCreated += 1;
					else if (planned.runId) result.counters.runsReused += 1;
					for (const job of planned.jobs) {
						if (job.created) result.counters.jobsCreated += 1;
						else result.counters.jobsReused += 1;
					}
				}
			}
		} catch (err) {
			result.failures.push({
				slug: project.slug,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	result.occurrences.sort((a, b) => a.instantDb.localeCompare(b.instantDb));
	return result;
}

async function planOne(input: {
	db: AppDb;
	project: SchedulableProject;
	occurrence: Occurrence;
	dryRun: boolean;
	catalog: (cadence: ScheduleCadence) => CatalogEntry[];
}): Promise<PlannedOccurrence> {
	const { db, project, occurrence, dryRun } = input;
	const entries = input.catalog(occurrence.cadence);

	const base: PlannedOccurrence = {
		projectId: project.id,
		projectSlug: project.slug,
		cadence: occurrence.cadence,
		localSlot: occurrence.localSlot,
		instantDb: toDbTimestamp(new Date(occurrence.instantMs)),
		runId: null,
		runCreated: false,
		jobs: [],
		adjusted: occurrence.adjusted,
		ambiguous: occurrence.ambiguous
	};

	// Garde : `planDueJobs` écarte déjà les cadences sans handler en amont. Ouvrir un
	// run sans job laisserait un run éternellement `queued` dans la console.
	if (entries.length === 0) return base;

	if (dryRun) {
		return {
			...base,
			jobs: entries.map((e) => ({ jobType: e.jobType, jobId: '(dry-run)', created: false }))
		};
	}

	const run = await createRun(
		{
			projectId: project.id,
			runType: occurrence.cadence,
			idempotencyKey: deriveIdempotencyKey({
				runType: occurrence.cadence,
				projectSlug: project.slug,
				periodEnd: occurrence.localSlot,
				stepType: RUN_STEP_TYPE,
				schemaVersion: SCHEDULE_SCHEMA_VERSION
			}),
			triggeredBy: 'schedule',
			periodEnd: occurrence.localSlot
		},
		db
	);

	const jobs: PlannedJob[] = [];
	for (const entry of entries) {
		const enqueued = await enqueueJob(
			{
				projectId: project.id,
				type: entry.jobType,
				runId: run.id,
				priority: entry.priority,
				payloadJson: entry.payload ? JSON.stringify(entry.payload) : null,
				idempotencyKey: deriveIdempotencyKey({
					runType: occurrence.cadence,
					projectSlug: project.slug,
					periodEnd: occurrence.localSlot,
					stepType: entry.jobType,
					schemaVersion: SCHEDULE_SCHEMA_VERSION
				})
			},
			db
		);
		jobs.push({ jobType: entry.jobType, jobId: enqueued.id, created: enqueued.created });
	}

	return { ...base, runId: run.id, runCreated: run.created, jobs };
}

// ── Prochaines exécutions (acceptation : visible par projet) ────────

export interface NextOccurrenceRow {
	projectId: string;
	projectSlug: string;
	projectName: string;
	cadence: ScheduleCadence;
	enabled: boolean;
	/** Faux quand la cadence n'a aucun job câblé : elle se calcule, mais ne produit rien. */
	wired: boolean;
	/** Créneau local Europe/Zurich, ou null si la cadence est désactivée. */
	localSlot: string | null;
	/** Même instant, au format DB (UTC) — comparable au `now` de la page. */
	instantDb: string | null;
}

/**
 * Prochaine exécution par projet et par cadence. CALCULÉE, jamais lue dans un état
 * persisté : il n'existe donc aucun moyen que l'affichage et la planification réelle
 * se contredisent.
 */
export async function listNextOccurrences(input: {
	db?: AppDb;
	now?: Date | number;
	timeZone?: string;
} = {}): Promise<NextOccurrenceRow[]> {
	const db = await resolveDb(input.db);
	const timeZone = input.timeZone ?? BUSINESS_TIMEZONE;
	const nowMs = input.now === undefined ? Date.now() : toMs(input.now);

	const targets = await listSchedulableProjects(db);
	const rows: NextOccurrenceRow[] = [];

	for (const project of targets) {
		const config = await loadProjectScheduleConfig(db, project.id);
		for (const cadence of SCHEDULE_CADENCES) {
			const spec = config[cadence];
			const next = nextOccurrence({ cadence, spec, after: nowMs, timeZone });
			rows.push({
				projectId: project.id,
				projectSlug: project.slug,
				projectName: project.name,
				cadence,
				enabled: spec.enabled,
				wired: catalogFor(cadence).length > 0,
				localSlot: next?.localSlot ?? null,
				instantDb: next ? toDbTimestamp(new Date(next.instantMs)) : null
			});
		}
	}

	return rows;
}

// ── Post-publication (événementiel) ─────────────────────────────────

export interface PostPublishResult {
	scheduled: Array<{ offsetDays: number; jobId: string; created: boolean; availableAtDb: string }>;
}

/**
 * Pose les vérifications J+3 / J+7 / J+28 d'une publication (SPEC §8.1).
 *
 * Aucune horloge n'est mobilisée : les trois jobs partent en file tout de suite avec
 * un `available_at` futur, et la file les ignore jusque-là (`claimJob` filtre sur
 * `available_at <= now`). C'est la bonne forme sur une infrastructure sans worker
 * permanent — rien à réveiller, rien à se rappeler.
 *
 * Non branchée sur un événement de publication : le handler `post_publish:check`
 * appartient aux collecteurs (E03). Un job enfilé aujourd'hui échouerait en
 * `NoHandlerRegistered` (classé `permanent` par JOB-003) — d'où l'appel explicite,
 * jamais automatique.
 */
export async function schedulePostPublish(input: {
	db?: AppDb;
	projectId: string;
	projectSlug: string;
	contentId: string;
	publishedAt: Date | number;
}): Promise<PostPublishResult> {
	const db = await resolveDb(input.db);
	const slots = postPublishSlots(input.publishedAt);
	const scheduled: PostPublishResult['scheduled'] = [];

	for (const slot of slots) {
		const availableAtDb = toDbTimestamp(new Date(slot.instantMs));
		const enqueued = await enqueueJob(
			{
				projectId: input.projectId,
				type: JOB_TYPE_POST_PUBLISH_CHECK,
				priority: 5,
				availableAt: availableAtDb,
				payloadJson: JSON.stringify({
					contentId: input.contentId,
					offsetDays: slot.offsetDays
				}),
				idempotencyKey: deriveIdempotencyKey({
					runType: 'post_publish',
					projectSlug: input.projectSlug,
					// Le contenu ET l'échéance : deux publications du même contenu ne se
					// confondent pas, et J+3 ne recouvre pas J+7.
					periodEnd: `${input.contentId}:J+${slot.offsetDays}`,
					stepType: JOB_TYPE_POST_PUBLISH_CHECK,
					schemaVersion: SCHEDULE_SCHEMA_VERSION
				})
			},
			db
		);
		scheduled.push({
			offsetDays: slot.offsetDays,
			jobId: enqueued.id,
			created: enqueued.created,
			availableAtDb
		});
	}

	return { scheduled };
}

function toMs(v: Date | number): number {
	return typeof v === 'number' ? v : v.getTime();
}
