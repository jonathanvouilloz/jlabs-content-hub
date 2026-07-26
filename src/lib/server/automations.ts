/**
 * DASH-006 — Vue automatisations : la LECTURE (SPEC §13.4).
 *
 * Assemble ce que `automations-state.ts` sait juger. Trois familles de données,
 * et aucune n'est recalculée ici :
 *
 *   1. **Le calendrier** — créneaux passés et à venir, calculés par
 *      `schedule-state.ts`, la même fonction que le scheduler. Rien n'est stocké,
 *      donc rien ne peut se désynchroniser de ce que le tick fera (JOB-005).
 *   2. **Les résultats** — `monitoring_runs` et `monitoring_steps`, écrits par
 *      `concludeJobStep`. Ces deux tables n'avaient jusqu'ici AUCUN lecteur : un
 *      run partiel se voyait uniquement job par job.
 *   3. **Les règles effectives** — plafonds et quotas (JOB-006), flags de
 *      migration (GOV-005), politiques d'avis (DATA-007). Lues, jamais copiées :
 *      la page montre ce que la file appliquera, pas une seconde configuration.
 *
 * Le client `AppDb` est injecté (même discipline que `home.ts`) : la route et les
 * scripts de preuve lisent par le même chemin.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
	monitoringRuns,
	monitoringSteps,
	projects,
	reviewAutomationPolicies
} from './db/schema.js';
import type { AppDb } from './db/types.js';
import { loadProjectScheduleConfig } from './scheduler.js';
import { listPauseJournal, loadPauseStates, type PauseJournalEntry } from './pauses.js';
import {
	applyPauseToSpec,
	pausedProviders,
	resolveCadencePause,
	type ActivePause,
	type CadencePauseVerdict,
	type PauseStates
} from './pause-state.js';
import { loadCapacitySnapshot, type CapacitySnapshot } from './jobs-limits.js';
import { toDbTimestamp } from './timestamps.js';
import {
	BUSINESS_TIMEZONE,
	// Reprise EXPLICITE de la constante du scheduler : la page annonce un
	// rattrapage, le tick le fait. Deux valeurs distinctes feraient promettre à
	// l'écran un run qui ne partirait jamais.
	DEFAULT_LOOKBACK_MS,
	SCHEDULE_CADENCES,
	catalogFor,
	nextOccurrence,
	type CadenceSpec,
	type Occurrence,
	type ScheduleCadence
} from './schedule-state.js';
import {
	classifyCadence,
	lastDueOccurrence,
	summarizeAutomations,
	type AutomationFilters,
	type AutomationsSummary,
	type CadenceRow
} from './automations-state.js';

// ── Runs (la liste, et ce qu'un run a produit) ──────────────────────

export interface RunRow {
	id: string;
	projectId: string;
	projectSlug: string | null;
	projectName: string | null;
	runType: string;
	status: string;
	/** `period_end` porte le CRÉNEAU LOCAL du scheduler, pas un instant UTC. */
	periodEnd: string | null;
	triggeredBy: string;
	startedAt: string | null;
	finishedAt: string | null;
	createdAt: string;
	/** Issue par step (dernière tentative de chaque `step_type`). */
	steps: RunStep[];
}

export interface RunStep {
	stepType: string;
	status: string;
	attempt: number;
	durationMs: number | null;
	errorCode: string | null;
	errorMessage: string | null;
}

function runFilterSql(f: AutomationFilters) {
	const statusFilter =
		f.statuses.length > 0
			? sql`AND r.status IN (${sql.join(
					f.statuses.map((s) => sql`${s}`),
					sql`, `
				)})`
			: sql``;
	const projectFilter = f.projectSlug ? sql`AND p.slug = ${f.projectSlug}` : sql``;
	const cadenceFilter = f.cadence ? sql`AND r.run_type = ${f.cadence}` : sql``;
	const sinceFilter = f.sinceDb ? sql`AND r.created_at >= ${f.sinceDb}` : sql``;
	return sql`${statusFilter} ${projectFilter} ${cadenceFilter} ${sinceFilter}`;
}

interface RawRunRow {
	id: string;
	project_id: string;
	slug: string | null;
	name: string | null;
	run_type: string;
	status: string;
	period_end: string | null;
	triggered_by: string;
	started_at: string | null;
	finished_at: string | null;
	created_at: string;
}

/** Runs correspondant aux filtres, les plus récents d'abord. */
export async function listRuns(input: {
	db: AppDb;
	filters: AutomationFilters;
}): Promise<RunRow[]> {
	const { db, filters } = input;
	const res = await db.execute(sql`
		SELECT r.id, r.project_id, p.slug, p.name, r.run_type, r.status, r.period_end,
		       r.triggered_by, r.started_at, r.finished_at, r.created_at
		  FROM "seostats"."monitoring_runs" AS r
		  LEFT JOIN "seostats"."projects" AS p ON p.id = r.project_id
		 WHERE 1 = 1 ${runFilterSql(filters)}
		 ORDER BY r.created_at DESC
		 LIMIT ${Math.max(1, filters.limit)} OFFSET ${Math.max(0, filters.offset)}
	`);
	const rows = (res.rows ?? []) as unknown as RawRunRow[];
	const steps = await loadStepsByRun({ db, runIds: rows.map((r) => r.id) });

	return rows.map((r) => ({
		id: r.id,
		projectId: r.project_id,
		projectSlug: r.slug,
		projectName: r.name,
		runType: r.run_type,
		status: r.status,
		periodEnd: r.period_end,
		triggeredBy: r.triggered_by,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
		createdAt: r.created_at,
		steps: steps.get(r.id) ?? []
	}));
}

export async function countRuns(input: {
	db: AppDb;
	filters: AutomationFilters;
}): Promise<number> {
	const res = await input.db.execute(sql`
		SELECT count(*)::int AS n
		  FROM "seostats"."monitoring_runs" AS r
		  LEFT JOIN "seostats"."projects" AS p ON p.id = r.project_id
		 WHERE 1 = 1 ${runFilterSql(input.filters)}
	`);
	const row = (res.rows ?? [])[0] as unknown as { n: number } | undefined;
	return Number(row?.n ?? 0);
}

/**
 * Steps des runs listés, réduits à la DERNIÈRE tentative de chaque `step_type`.
 *
 * Sans cette réduction, un step échoué puis relancé avec succès afficherait ses
 * deux tentatives côte à côte et se lirait comme un demi-échec permanent — c'est
 * la même raison qui a fait exister `latestAttemptPerStep` côté classification.
 */
async function loadStepsByRun(input: {
	db: AppDb;
	runIds: string[];
}): Promise<Map<string, RunStep[]>> {
	const out = new Map<string, RunStep[]>();
	if (input.runIds.length === 0) return out;

	const rows = await input.db
		.select({
			runId: monitoringSteps.runId,
			stepType: monitoringSteps.stepType,
			status: monitoringSteps.status,
			attempt: monitoringSteps.attempt,
			durationMs: monitoringSteps.durationMs,
			errorCode: monitoringSteps.errorCode,
			errorMessage: monitoringSteps.errorMessage
		})
		.from(monitoringSteps)
		.where(inArray(monitoringSteps.runId, input.runIds));

	// Dernière tentative par (run, step_type) : `attempt` est monotone par
	// construction (unique (run_id, step_type, attempt)).
	const best = new Map<string, RunStep & { runId: string }>();
	for (const r of rows) {
		const key = `${r.runId}|${r.stepType}`;
		const prev = best.get(key);
		if (!prev || r.attempt > prev.attempt) {
			best.set(key, {
				runId: r.runId,
				stepType: r.stepType,
				status: r.status,
				attempt: r.attempt,
				durationMs: r.durationMs,
				errorCode: r.errorCode,
				errorMessage: r.errorMessage
			});
		}
	}

	for (const step of best.values()) {
		const list = out.get(step.runId) ?? [];
		list.push(step);
		out.set(step.runId, list);
	}
	for (const list of out.values()) list.sort((a, b) => a.stepType.localeCompare(b.stepType));
	return out;
}

// ── Le calendrier (créneau attendu ↔ run observé) ───────────────────

interface SchedulableRow {
	id: string;
	slug: string;
	name: string;
	createdAt: string;
}

/** Instant DB (`YYYY-MM-DD HH:MM:SS`, UTC) → ms. Miroir de `parseDbTimestamp` côté client. */
function parseDb(ts: string | null): number | null {
	if (!ts) return null;
	const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(ts);
	if (!m) return null;
	const parsed = Date.parse(`${m[1]}T${m[2]}Z`);
	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Construit une ligne par (projet × cadence), en croisant le créneau ATTENDU
 * (calculé) et le run OBSERVÉ (en base). C'est ce croisement, et lui seul, qui
 * révèle un créneau jamais tiré : la base ne contient aucune trace d'un tick qui
 * n'a pas tourné.
 */
export async function loadCadenceRows(input: {
	db: AppDb;
	now: Date;
	projectSlug?: string | null;
	timeZone?: string;
	/** États injectables (preuves) — même porte que le `catalog` de `planDueJobs`. */
	pauses?: PauseStates;
}): Promise<CadenceRow[]> {
	const { db, now } = input;
	const timeZone = input.timeZone ?? BUSINESS_TIMEZONE;
	const nowMs = now.getTime();

	const targets = (await db
		.select({
			id: projects.id,
			slug: projects.slug,
			name: projects.name,
			createdAt: projects.createdAt
		})
		.from(projects)
		.where(eq(projects.archived, false))
		.orderBy(projects.slug)) as SchedulableRow[];

	const scoped = input.projectSlug
		? targets.filter((p) => p.slug === input.projectSlug)
		: targets;
	if (scoped.length === 0) return [];

	// Les créneaux d'abord, la base ensuite : on ne va chercher en base QUE les
	// runs des créneaux qu'on attend, plutôt que de ramener un historique et d'y
	// deviner ce qui manque.
	const pending: Array<{
		project: SchedulableRow;
		cadence: ScheduleCadence;
		spec: CadenceSpec;
		wired: boolean;
		pause: CadencePauseVerdict;
		lastDue: Occurrence | null;
		next: Occurrence | null;
	}> = [];

	// DASH-006 lot 2 — les pauses, lues UNE fois pour tout l'écran, comme dans
	// `planDueJobs`. C'est la MÊME fonction de résolution des deux côtés : l'écran ne
	// peut donc pas annoncer suspendu ce que le scheduler planifierait quand même.
	const pauses = input.pauses ?? (await loadPauseStates(db, now));

	for (const project of scoped) {
		const config = await loadProjectScheduleConfig(db, project.id);
		for (const cadence of SCHEDULE_CADENCES) {
			const spec = config[cadence];
			const pause = resolveCadencePause({ states: pauses, projectId: project.id, cadence });
			// Le créneau attendu et le prochain se calculent sur le spec APRÈS pause :
			// une cadence suspendue n'a ni dernier créneau dû, ni prochaine exécution.
			// Les calculer sur le spec brut afficherait une date que rien ne tirera.
			const effective = applyPauseToSpec(spec, pause.paused);
			pending.push({
				project,
				cadence,
				spec,
				wired: catalogFor(cadence).length > 0,
				pause,
				lastDue: lastDueOccurrence({ cadence, spec: effective, now: nowMs, timeZone }),
				next: nextOccurrence({ cadence, spec: effective, after: nowMs, timeZone })
			});
		}
	}

	const [slotRuns, lastSuccesses] = await Promise.all([
		loadRunsForSlots({
			db,
			slots: pending
				.filter((p) => p.lastDue)
				.map((p) => ({
					projectId: p.project.id,
					runType: p.cadence,
					periodEnd: p.lastDue!.localSlot
				}))
		}),
		loadLastSuccessPerCadence({ db, projectIds: scoped.map((p) => p.id) })
	]);

	return pending.map((p) => {
		const slotKey = p.lastDue ? `${p.project.id}|${p.cadence}|${p.lastDue.localSlot}` : null;
		const run = slotKey ? (slotRuns.get(slotKey) ?? null) : null;
		const success = lastSuccesses.get(`${p.project.id}|${p.cadence}`) ?? null;

		return {
			projectId: p.project.id,
			projectSlug: p.project.slug,
			projectName: p.project.name,
			cadence: p.cadence,
			spec: p.spec,
			wired: p.wired,
			lastDueSlot: p.lastDue?.localSlot ?? null,
			lastDueDb: p.lastDue ? toDbTimestamp(new Date(p.lastDue.instantMs)) : null,
			nextSlot: p.next?.localSlot ?? null,
			nextDb: p.next ? toDbTimestamp(new Date(p.next.instantMs)) : null,
			verdict: classifyCadence({
				spec: p.spec,
				wired: p.wired,
				lastDue: p.lastDue,
				runStatus: run?.status ?? null,
				nowMs,
				projectCreatedAtMs: parseDb(p.project.createdAt),
				pause: p.pause
			}),
			lastRun: run ? { id: run.id, status: run.status, finishedAt: run.finishedAt } : null,
			lastSuccess: success,
			pauseScope: p.pause.by?.target.scope ?? null
		} satisfies CadenceRow;
	});
}

interface SlotRun {
	id: string;
	status: string;
	finishedAt: string | null;
}

/**
 * Runs des créneaux demandés, indexés par `projectId|runType|periodEnd`.
 *
 * La clé de jointure est le CRÉNEAU LOCAL (`period_end`), celui-là même que
 * `planOne` y écrit — et non un intervalle de temps autour de l'instant. Un
 * intervalle ferait correspondre un run à un créneau voisin le jour du
 * changement d'heure, exactement là où la question se pose.
 */
async function loadRunsForSlots(input: {
	db: AppDb;
	slots: Array<{ projectId: string; runType: string; periodEnd: string }>;
}): Promise<Map<string, SlotRun>> {
	const out = new Map<string, SlotRun>();
	if (input.slots.length === 0) return out;

	const tuples = sql.join(
		input.slots.map((s) => sql`(${s.projectId}, ${s.runType}, ${s.periodEnd})`),
		sql`, `
	);
	const res = await input.db.execute(sql`
		SELECT id, project_id, run_type, period_end, status, finished_at
		  FROM "seostats"."monitoring_runs"
		 WHERE (project_id, run_type, period_end) IN (${tuples})
	`);

	for (const raw of (res.rows ?? []) as unknown as Array<{
		id: string;
		project_id: string;
		run_type: string;
		period_end: string;
		status: string;
		finished_at: string | null;
	}>) {
		out.set(`${raw.project_id}|${raw.run_type}|${raw.period_end}`, {
			id: raw.id,
			status: raw.status,
			finishedAt: raw.finished_at
		});
	}
	return out;
}

/** Dernière RÉUSSITE par (projet, cadence) — « dernière réussite » de SPEC §13.4. */
async function loadLastSuccessPerCadence(input: {
	db: AppDb;
	projectIds: string[];
}): Promise<Map<string, { id: string; slot: string | null; finishedAt: string | null }>> {
	const out = new Map<string, { id: string; slot: string | null; finishedAt: string | null }>();
	if (input.projectIds.length === 0) return out;

	const ids = sql.join(
		input.projectIds.map((id) => sql`${id}`),
		sql`, `
	);
	const res = await input.db.execute(sql`
		SELECT DISTINCT ON (project_id, run_type)
		       id, project_id, run_type, period_end, finished_at
		  FROM "seostats"."monitoring_runs"
		 WHERE status = 'success' AND project_id IN (${ids})
		 ORDER BY project_id, run_type, created_at DESC
	`);

	for (const raw of (res.rows ?? []) as unknown as Array<{
		id: string;
		project_id: string;
		run_type: string;
		period_end: string | null;
		finished_at: string | null;
	}>) {
		out.set(`${raw.project_id}|${raw.run_type}`, {
			id: raw.id,
			slot: raw.period_end,
			finishedAt: raw.finished_at
		});
	}
	return out;
}

// ── Règles effectives (quotas, flags, politiques) ───────────────────

export interface EffectiveRules {
	capacity: CapacitySnapshot;
	/**
	 * Flags de migration tels que le SERVEUR les résout (env). Aucun override
	 * projet n'est passé : la table qui les portera n'existe pas encore (GOV-005),
	 * et en inventer un ici ferait afficher une valeur que le runtime n'applique pas.
	 *
	 * `null` hors SvelteKit (scripts, CLI) : `flags.ts` lit `$env/dynamic/private`,
	 * indisponible là-bas. On rend alors « non lisible » plutôt que « tous à false »,
	 * qui serait une affirmation qu'on n'a pas les moyens de faire.
	 */
	flags: Record<string, boolean> | null;
	/** Politiques d'avis courantes, par projet — `kill_switch` compris (SPEC §13.4). */
	reviewPolicies: Array<{
		projectId: string;
		projectSlug: string | null;
		locationId: string | null;
		mode: string;
		syncEnabled: boolean;
		autoGenerationEnabled: boolean;
		killSwitch: boolean;
		version: number;
		promotedAt: string | null;
	}>;
	/**
	 * DASH-006 lot 2 — les pauses PROVIDER en vigueur. Elles n'ont aucune ligne de
	 * cadence où s'afficher (elles sont transverses à tous les projets), donc sans ce
	 * panneau une coupure de GSC serait invisible : on verrait six projets dont les
	 * collectes sautent, sans jamais voir la décision unique qui les fait sauter.
	 */
	providerPauses: ActivePause[];
}

/**
 * Flags effectifs, chargés en DYNAMIQUE.
 *
 * `flags.ts` → `config.ts` → `$env/dynamic/private` : un import statique rendrait
 * ce module inchargeable par les scripts `scripts/` (même piège que `findings.ts`
 * avec `db/index.js`). Le seul échec attendu est cette absence de `$env` ; on rend
 * alors `null`, jamais « tous à false ».
 */
async function loadFlagsSafely(): Promise<Record<string, boolean> | null> {
	try {
		const mod = await import('./flags.js');
		return mod.resolveFlags();
	} catch {
		return null;
	}
}

export async function loadEffectiveRules(input: {
	db: AppDb;
	now: Date;
	projectSlug?: string | null;
	pauses?: PauseStates;
}): Promise<EffectiveRules> {
	const states = input.pauses ?? (await loadPauseStates(input.db, input.now));
	const [capacity, flags, policies] = await Promise.all([
		loadCapacitySnapshot({ db: input.db, now: input.now }),
		loadFlagsSafely(),
		input.db
			.select({
				projectId: reviewAutomationPolicies.projectId,
				projectSlug: projects.slug,
				locationId: reviewAutomationPolicies.locationId,
				mode: reviewAutomationPolicies.mode,
				syncEnabled: reviewAutomationPolicies.syncEnabled,
				autoGenerationEnabled: reviewAutomationPolicies.autoGenerationEnabled,
				killSwitch: reviewAutomationPolicies.killSwitch,
				version: reviewAutomationPolicies.version,
				promotedAt: reviewAutomationPolicies.promotedAt
			})
			.from(reviewAutomationPolicies)
			.leftJoin(projects, eq(projects.id, reviewAutomationPolicies.projectId))
			.where(eq(reviewAutomationPolicies.status, 'current'))
			.orderBy(projects.slug)
	]);

	return {
		// Le filtre projet de la page vaut aussi pour la capacité : redescendre sur
		// un projet ne doit pas laisser les six autres à l'écran (règle `/jobs`).
		capacity: {
			...capacity,
			projects: input.projectSlug
				? capacity.projects.filter((p) => p.projectSlug === input.projectSlug)
				: capacity.projects
		},
		flags,
		reviewPolicies: input.projectSlug
			? policies.filter((p) => p.projectSlug === input.projectSlug)
			: policies,
		// PAS filtrées par projet, à l'inverse du reste : une pause provider coupe TOUS
		// les projets. La masquer en vue projet ferait chercher une panne locale là où il
		// y a une décision globale.
		providerPauses: [...states.values()]
			.filter((p) => p.target.scope === 'provider')
			.sort((a, b) => (a.target.provider ?? '').localeCompare(b.target.provider ?? ''))
	};
}

// ── Le rapport assemblé ─────────────────────────────────────────────

export interface AutomationsView {
	/** Heure du serveur au format DB : tous les écarts se calculent contre elle. */
	now: string;
	timeZone: string;
	/** Fenêtre de rattrapage du tick, en ms — ce qui sépare `late` de `missed`. */
	lookbackMs: number;
	cadences: CadenceRow[];
	summary: AutomationsSummary;
	runs: RunRow[];
	totalRuns: number;
	rules: EffectiveRules;
	/** DASH-006 lot 2 — l'historique des décisions de pause : qui, quand, pourquoi. */
	pauseJournal: PauseJournalEntry[];
}

export async function loadAutomations(input: {
	db: AppDb;
	now?: Date;
	filters: AutomationFilters;
}): Promise<AutomationsView> {
	const now = input.now ?? new Date();
	const { db, filters } = input;

	// Les pauses sont lues UNE fois et passées aux deux consommateurs. Deux lectures
	// séparées pourraient tomber de part et d'autre d'une reprise concurrente, et la
	// page afficherait alors une cadence suspendue sous un provider actif — un état
	// qui n'a jamais existé.
	const pauses = await loadPauseStates(db, now);

	const [cadences, runs, totalRuns, rules, pauseJournal] = await Promise.all([
		loadCadenceRows({ db, now, projectSlug: filters.projectSlug, pauses }),
		listRuns({ db, filters }),
		countRuns({ db, filters }),
		loadEffectiveRules({ db, now, projectSlug: filters.projectSlug, pauses }),
		listPauseJournal({ db, limit: 25 })
	]);

	return {
		now: toDbTimestamp(now),
		timeZone: BUSINESS_TIMEZONE,
		lookbackMs: DEFAULT_LOOKBACK_MS,
		cadences,
		summary: summarizeAutomations(cadences),
		runs,
		totalRuns,
		rules,
		pauseJournal
	};
}

/** Runs récents d'un projet, sans filtre — utilisé par les scripts de preuve. */
export async function recentRunsFor(input: {
	db: AppDb;
	projectId: string;
	limit?: number;
	sinceDb?: string | null;
}): Promise<Array<{ id: string; runType: string; status: string; periodEnd: string | null }>> {
	const where = input.sinceDb
		? and(
				eq(monitoringRuns.projectId, input.projectId),
				gte(monitoringRuns.createdAt, input.sinceDb)
			)
		: eq(monitoringRuns.projectId, input.projectId);

	return input.db
		.select({
			id: monitoringRuns.id,
			runType: monitoringRuns.runType,
			status: monitoringRuns.status,
			periodEnd: monitoringRuns.periodEnd
		})
		.from(monitoringRuns)
		.where(where)
		.orderBy(desc(monitoringRuns.createdAt))
		.limit(input.limit ?? 20);
}
