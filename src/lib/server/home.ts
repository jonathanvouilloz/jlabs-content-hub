/**
 * DASH-002 — Accueil cross-projet : la LECTURE.
 *
 * Le jugement pur vit dans `home-state.ts` (testé par vitest) ; ici on lit la base et on
 * applique les fonctions pures. Client drizzle INJECTÉ : l'app passe son `db`, les runners
 * `scripts/` passent leur Pool (cf. `db/types.ts`) — c'est ce qui rend ce lot prouvable
 * sur Neon hors runtime SvelteKit.
 *
 * ⚠️ Jamais `= ANY($n)` (driver Neon) : les bornes de période sont des `>=` sur des
 * horodatages au FORMAT DB, et les listes de valeurs passent par `inArray` (`IN (…)`
 * paramétré classique).
 *
 * Une lecture par DOMAINE, groupée par projet — jamais une requête par projet dans une
 * boucle. Six projets × sept compteurs feraient 42 allers-retours pour une page d'accueil,
 * sur un pooler serverless où chaque aller-retour se paie.
 *
 * Ce que ce module ne fait PAS : recopier un chiffre. Il lit le CANON de chaque domaine
 * (findings, finding_events, action_proposals, gmb_reviews, project_integrations,
 * monitoring_runs, jobs) et la capacité DÉRIVÉE de JOB-006. L'accueil ne peut donc pas
 * diverger de l'inbox, de `/jobs` ou du détecteur : il n'a pas de source à lui.
 *
 * (Les cumuls cross-projet sont la SOMME des cartes, pas une requête de plus : le total et
 * le détail ne peuvent pas annoncer deux chiffres pour la même chose.)
 */
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import {
	actionProposals,
	findingEvents,
	findings,
	gmbReviews,
	jobs,
	monitoringRuns,
	projectIntegrations,
	projectProjections,
	projects
} from './db/schema.js';
import type { AppDb } from './db/types.js';
import { ACTIVE_STATUSES } from './finding-state.js';
import { toDbTimestamp } from './timestamps.js';
import { loadCapacitySnapshot, type CapacitySnapshot } from './jobs-limits.js';
import {
	ACTIVITY_EVENTS,
	DEFAULT_WINDOW_DAYS,
	buildCounter,
	classifyProject,
	emptyActivity,
	groupActivity,
	rankProjects,
	summarizeCosts,
	summarizePortfolio,
	type ActivityCounts,
	type Counter,
	type CostSummary,
	type DetectorCoverage,
	type IntegrationSummary,
	type PortfolioHealth,
	type ProjectCard
} from './home-state.js';
import {
	SCHEDULE_CADENCES,
	catalogFor,
	resolveScheduleConfig,
	type CadenceSpec,
	type ScheduleCadence
} from './schedule-state.js';

/**
 * Au-delà de ce délai sans succès de collecte GSC, le pipeline est dit « en retard ».
 *
 * 10 jours, et non 7 : la cadence est HEBDOMADAIRE (lundi 09:00 `Europe/Zurich`) et la
 * latence GSC vise 8+ jours (GSC-002). Un seuil à 7 j ferait crier les six projets tous
 * les dimanches, pour une file parfaitement saine — et une alerte qui crie chaque semaine
 * n'est plus lue.
 */
export const GSC_STALE_AFTER_HOURS = 24 * 10;

/** Combien de runs récents l'accueil montre. Au-delà, c'est un journal, pas un accueil. */
const RECENT_RUNS_LIMIT = 12;

/** Le provider dont la fraîcheur porte le pipeline de ce produit. */
const FRESHNESS_PROVIDER = 'gsc';

// ── Lectures par domaine, groupées par projet ───────────────────────

interface ProjectRow {
	id: string;
	slug: string;
	name: string;
	color: string | null;
}

/** Les projets ACTIFS. Un projet archivé n'a pas à peser sur la santé du portefeuille. */
async function loadProjects(db: AppDb): Promise<ProjectRow[]> {
	return db
		.select({ id: projects.id, slug: projects.slug, name: projects.name, color: projects.color })
		.from(projects)
		.where(eq(projects.archived, false))
		.orderBy(projects.name);
}

/** Findings OUVERTS par (projet, sévérité) — statuts actifs uniquement, comme l'inbox. */
async function loadOpenBySeverity(db: AppDb): Promise<Map<string, Record<string, number>>> {
	const rows = await db
		.select({
			projectId: findings.projectId,
			severity: findings.severity,
			n: sql<number>`count(*)::int`
		})
		.from(findings)
		.where(inArray(findings.status, [...ACTIVE_STATUSES]))
		.groupBy(findings.projectId, findings.severity);

	const out = new Map<string, Record<string, number>>();
	for (const r of rows) {
		const bucket = out.get(r.projectId) ?? {};
		bucket[r.severity] = (bucket[r.severity] ?? 0) + r.n;
		out.set(r.projectId, bucket);
	}
	return out;
}

/**
 * Activité de la période par (projet, type d'événement), depuis le JOURNAL.
 *
 * `finding_events` est append-only : c'est la seule source qui sache dire « ce qui s'est
 * passé cette semaine » sans état dérivé à maintenir. Les compteurs de l'accueil et le
 * filtre d'activité de `listFindings` lisent la MÊME table avec la MÊME borne — c'est ce
 * qui rend le lien de chaque compteur honnête.
 *
 * ⚠️ `count(DISTINCT finding_id)` et NON `count(*)` : on compte des PROBLÈMES, pas des
 * lignes de journal. Un finding aggravé deux semaines de suite porte deux événements
 * `aggravated` — et `reconcileDetectionRun` en écrit un par run —, si bien qu'un `count(*)`
 * annoncerait « 2 aggravés » là où la liste liée (qui dédoublonne par finding) n'en
 * montrerait qu'un. Le compteur et sa liste doivent décrire le MÊME ensemble pour toute
 * fenêtre, pas seulement pour celles où le hasard ne produit qu'un événement par finding.
 */
async function loadActivity(db: AppDb, sinceDb: string): Promise<Map<string, ActivityCounts>> {
	const rows = await db
		.select({
			projectId: findingEvents.projectId,
			eventType: findingEvents.eventType,
			n: sql<number>`count(distinct ${findingEvents.findingId})::int`
		})
		.from(findingEvents)
		.where(
			and(
				gte(findingEvents.createdAt, sinceDb),
				inArray(findingEvents.eventType, [...ACTIVITY_EVENTS])
			)
		)
		.groupBy(findingEvents.projectId, findingEvents.eventType);

	const byProject = new Map<string, { eventType: string; n: number }[]>();
	for (const r of rows) {
		const list = byProject.get(r.projectId) ?? [];
		list.push({ eventType: r.eventType, n: r.n });
		byProject.set(r.projectId, list);
	}
	const out = new Map<string, ActivityCounts>();
	for (const [projectId, list] of byProject) out.set(projectId, groupActivity(list));
	return out;
}

/** Propositions en attente de décision humaine (`proposed`), par projet. */
async function loadProposalsPending(db: AppDb): Promise<Map<string, number>> {
	const rows = await db
		.select({ projectId: actionProposals.projectId, n: sql<number>`count(*)::int` })
		.from(actionProposals)
		.where(eq(actionProposals.status, 'proposed'))
		.groupBy(actionProposals.projectId);
	return new Map(rows.map((r) => [r.projectId, r.n]));
}

/** Avis Google sans réponse, par projet (`replied_at IS NULL`). */
async function loadReviewsUnanswered(db: AppDb): Promise<Map<string, number>> {
	const rows = await db
		.select({ projectId: gmbReviews.projectId, n: sql<number>`count(*)::int` })
		.from(gmbReviews)
		.where(isNull(gmbReviews.repliedAt))
		.groupBy(gmbReviews.projectId);
	return new Map(rows.map((r) => [r.projectId, r.n]));
}

/**
 * Jobs en DEAD-LETTER par projet.
 *
 * `dead` et non `failed` : un `failed` repartira au prochain tick (JOB-003), un `dead` ne
 * repartira JAMAIS sans geste humain. Les compter ensemble ferait clignoter l'accueil sur
 * du travail qui se répare tout seul.
 */
async function loadJobsDead(db: AppDb): Promise<Map<string, number>> {
	const rows = await db
		.select({ projectId: jobs.projectId, n: sql<number>`count(*)::int` })
		.from(jobs)
		.where(eq(jobs.status, 'dead'))
		.groupBy(jobs.projectId);
	return new Map(rows.map((r) => [r.projectId, r.n]));
}

/** Intégrations déclarées, par projet — l'axe « est-ce que la donnée arrive ? ». */
async function loadIntegrations(db: AppDb): Promise<Map<string, IntegrationSummary[]>> {
	const rows = await db
		.select({
			projectId: projectIntegrations.projectId,
			provider: projectIntegrations.provider,
			healthStatus: projectIntegrations.healthStatus,
			status: projectIntegrations.status,
			enabled: projectIntegrations.enabled,
			lastSuccessAt: projectIntegrations.lastSuccessAt,
			lastErrorCode: projectIntegrations.lastErrorCode
		})
		.from(projectIntegrations)
		.orderBy(projectIntegrations.provider);

	const out = new Map<string, IntegrationSummary[]>();
	for (const r of rows) {
		const list = out.get(r.projectId) ?? [];
		list.push({
			provider: r.provider,
			healthStatus: r.healthStatus,
			status: r.status,
			enabled: r.enabled,
			lastSuccessAt: r.lastSuccessAt,
			lastErrorCode: r.lastErrorCode
		});
		out.set(r.projectId, list);
	}
	return out;
}

/**
 * Tous les types de job détecteur du catalogue, toutes cadences confondues.
 *
 * Dérivé du CATALOGUE et non écrit à la main : l'ensemble « ce qui diagnostique » ne peut
 * donc pas diverger de « ce que le scheduler enfile ». Ajouter un `detect:*` au catalogue
 * l'intègre d'office à la couverture — sans quoi un détecteur neuf ferait passer les
 * projets pour couverts avant même d'avoir tourné une seule fois.
 */
export const DETECTOR_JOB_TYPES: string[] = [
	...new Set(
		SCHEDULE_CADENCES.flatMap((c) => catalogFor(c).map((e) => e.jobType)).filter((t) =>
			t.startsWith('detect:')
		)
	)
];

/**
 * Les détecteurs ATTENDUS par projet, selon les cadences activées pour lui.
 *
 * Une seule requête sur `project_projections` puis résolution en mémoire — jamais un
 * `loadProjectScheduleConfig` par projet, qui rendrait six allers-retours à l'accueil.
 * Même tolérance que le scheduler : un payload illisible retombe sur les défauts SPEC
 * plutôt que de faire croire qu'un projet n'a rien de planifié.
 */
async function loadExpectedDetectors(db: AppDb): Promise<Map<string, string[]>> {
	const rows = await db
		.select({ projectId: projectProjections.projectId, payload: projectProjections.payload })
		.from(projectProjections)
		.where(eq(projectProjections.status, 'current'));

	const overrides = new Map<string, Partial<Record<ScheduleCadence, Partial<CadenceSpec>>> | null>();
	for (const r of rows) {
		let parsed: { schedules?: Partial<Record<ScheduleCadence, Partial<CadenceSpec>>> } | null = null;
		try {
			parsed = r.payload ? JSON.parse(r.payload) : null;
		} catch {
			parsed = null;
		}
		overrides.set(r.projectId, parsed?.schedules ?? null);
	}

	const detectorsFor = (o: Partial<Record<ScheduleCadence, Partial<CadenceSpec>>> | null) => {
		const config = resolveScheduleConfig(o);
		const set = new Set<string>();
		for (const cadence of SCHEDULE_CADENCES) {
			if (!config[cadence].enabled) continue;
			for (const entry of catalogFor(cadence)) {
				if (entry.jobType.startsWith('detect:')) set.add(entry.jobType);
			}
		}
		return [...set];
	};

	const defaults = detectorsFor(null);
	const out = new Map<string, string[]>();
	for (const [projectId, o] of overrides) out.set(projectId, detectorsFor(o));
	// Les projets sans projection ne sont PAS absents de la couverture : ils tournent sur
	// les défauts, donc tous les détecteurs les attendent. `home.ts` retombera dessus.
	out.set('__default__', defaults);
	return out;
}

/**
 * Dernier passage RÉUSSI de chaque détecteur, par (projet, type de job).
 *
 * `succeeded` uniquement : un détecteur mort en dead-letter n'a rien diagnostiqué, et le
 * compter comme passage ferait exactement l'erreur qu'on corrige — prendre l'absence de
 * verdict pour un verdict vide.
 */
async function loadDetectorLastSuccess(db: AppDb): Promise<Map<string, Map<string, string | null>>> {
	if (DETECTOR_JOB_TYPES.length === 0) return new Map();
	const rows = await db
		.select({
			projectId: jobs.projectId,
			type: jobs.type,
			lastSuccessAt: sql<string | null>`max(${jobs.finishedAt})`
		})
		.from(jobs)
		.where(and(inArray(jobs.type, DETECTOR_JOB_TYPES), eq(jobs.status, 'succeeded')))
		.groupBy(jobs.projectId, jobs.type);

	const out = new Map<string, Map<string, string | null>>();
	for (const r of rows) {
		const bucket = out.get(r.projectId) ?? new Map<string, string | null>();
		bucket.set(r.type, r.lastSuccessAt);
		out.set(r.projectId, bucket);
	}
	return out;
}

export interface RecentRun {
	id: string;
	projectId: string;
	projectSlug: string | null;
	projectName: string | null;
	runType: string;
	status: string;
	periodStart: string | null;
	periodEnd: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	createdAt: string;
	costJson: string | null;
}

/** Les derniers runs, cross-projet, les plus récents d'abord. */
async function loadRecentRuns(db: AppDb, limit: number): Promise<RecentRun[]> {
	return db
		.select({
			id: monitoringRuns.id,
			projectId: monitoringRuns.projectId,
			projectSlug: projects.slug,
			projectName: projects.name,
			runType: monitoringRuns.runType,
			status: monitoringRuns.status,
			periodStart: monitoringRuns.periodStart,
			periodEnd: monitoringRuns.periodEnd,
			startedAt: monitoringRuns.startedAt,
			finishedAt: monitoringRuns.finishedAt,
			createdAt: monitoringRuns.createdAt,
			costJson: monitoringRuns.costJson
		})
		.from(monitoringRuns)
		.leftJoin(projects, eq(projects.id, monitoringRuns.projectId))
		.orderBy(desc(monitoringRuns.createdAt))
		.limit(limit);
}

/** Runs de la PÉRIODE par statut — l'état d'exploitation, pas la liste. */
async function loadRunStatusCounts(db: AppDb, sinceDb: string): Promise<Record<string, number>> {
	const rows = await db
		.select({ status: monitoringRuns.status, n: sql<number>`count(*)::int` })
		.from(monitoringRuns)
		.where(gte(monitoringRuns.createdAt, sinceDb))
		.groupBy(monitoringRuns.status);
	return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Runs de la période, pour le résumé de coûts (le gate inerte de `summarizeCosts`). */
async function loadPeriodRunCosts(db: AppDb, sinceDb: string): Promise<{ costJson: string | null }[]> {
	return db
		.select({ costJson: monitoringRuns.costJson })
		.from(monitoringRuns)
		.where(gte(monitoringRuns.createdAt, sinceDb));
}

// ── Le rapport assemblé ─────────────────────────────────────────────

export interface HomeCockpit {
	/** Borne basse de la période, au format DB — celle sous laquelle TOUT a été compté. */
	sinceDb: string;
	windowDays: number;
	/** L'heure du serveur, format DB : les écarts affichés se calculent contre elle. */
	now: string;
	portfolio: PortfolioHealth;
	/** Toutes les cartes, déjà triées par urgence (ordre total). */
	projects: ProjectCard[];
	/** Les cartes qui demandent une action — le haut de l'écran. */
	needingAction: ProjectCard[];
	/** Activité cumulée de la période, tous projets. */
	activity: ActivityCounts;
	/** Compteurs cross-projet (avec leurs liens, ou sans lien s'il n'y a rien de cohérent à ouvrir). */
	counters: Counter[];
	recentRuns: RecentRun[];
	runStatusCounts: Record<string, number>;
	/**
	 * Les mêmes nombres que `runStatusCounts`, chacun avec le lien qui les
	 * reproduit (DASH-006). Dérivés de la même map — il n'existe donc pas deux
	 * définitions de « les runs `failed` de la période ».
	 */
	runCounters: Counter[];
	/** Quotas/capacité — DÉRIVÉS (JOB-006), jamais lus dans un état persisté. */
	capacity: CapacitySnapshot;
	costs: CostSummary;
}

/**
 * L'accueil cross-projet en UNE lecture.
 *
 * Toutes les requêtes partent en parallèle (elles sont indépendantes), puis les cartes sont
 * assemblées par le module pur et triées par urgence. `sinceDb` est calculé UNE fois et
 * passé partout : si chaque compteur calculait sa propre borne, deux compteurs de la même
 * ligne pourraient décrire deux périodes différentes.
 */
export async function loadHomeCockpit(input: {
	db: AppDb;
	now?: Date;
	windowDays?: number;
	staleAfterHours?: number;
}): Promise<HomeCockpit> {
	const now = input.now ?? new Date();
	const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
	const staleAfterHours = input.staleAfterHours ?? GSC_STALE_AFTER_HOURS;
	const sinceDb = toDbTimestamp(new Date(now.getTime() - windowDays * 86_400_000));

	const [
		projectRows,
		openBySeverity,
		activityByProject,
		proposalsPending,
		reviewsUnanswered,
		jobsDead,
		integrations,
		recentRuns,
		runStatusCounts,
		periodRunCosts,
		capacity,
		expectedDetectors,
		detectorLastSuccess
	] = await Promise.all([
		loadProjects(input.db),
		loadOpenBySeverity(input.db),
		loadActivity(input.db, sinceDb),
		loadProposalsPending(input.db),
		loadReviewsUnanswered(input.db),
		loadJobsDead(input.db),
		loadIntegrations(input.db),
		loadRecentRuns(input.db, RECENT_RUNS_LIMIT),
		loadRunStatusCounts(input.db, sinceDb),
		loadPeriodRunCosts(input.db, sinceDb),
		loadCapacitySnapshot({ db: input.db, now }),
		loadExpectedDetectors(input.db),
		loadDetectorLastSuccess(input.db)
	]);

	const cards = projectRows.map((p) => {
		const projectIntegrationList = integrations.get(p.id) ?? [];
		// La fraîcheur du PIPELINE est celle de la collecte GSC : c'est elle qui nourrit le
		// canon d'observations dont dépend tout le reste. Prendre le dernier succès de
		// n'importe quel provider ferait passer un projet pour frais parce que LinkedIn a
		// publié un post.
		const gsc = projectIntegrationList.find((i) => i.provider === FRESHNESS_PROVIDER);
		// Ce que le catalogue prévoit pour CE projet, croisé au dernier succès réel. Un
		// détecteur attendu mais jamais exécuté entre ici avec `lastSuccessAt: null` — c'est
		// exactement ce qui interdit à la carte de conclure « au vert ».
		const expected = expectedDetectors.get(p.id) ?? expectedDetectors.get('__default__') ?? [];
		const lastSuccess = detectorLastSuccess.get(p.id);
		const detectors: DetectorCoverage[] = expected.map((detector) => ({
			detector,
			lastSuccessAt: lastSuccess?.get(detector) ?? null
		}));
		return classifyProject({
			projectId: p.id,
			slug: p.slug,
			name: p.name,
			color: p.color,
			integrations: projectIntegrationList,
			openBySeverity: openBySeverity.get(p.id) ?? {},
			activity: activityByProject.get(p.id) ?? emptyActivity(),
			proposalsPending: proposalsPending.get(p.id) ?? 0,
			reviewsUnanswered: reviewsUnanswered.get(p.id) ?? 0,
			jobsDead: jobsDead.get(p.id) ?? 0,
			gscLastSuccessAt: gsc?.lastSuccessAt ?? null,
			detectors,
			sinceDb,
			now,
			staleAfterHours
		});
	});

	const ranked = rankProjects(cards);

	// Cumuls cross-projet : la somme des cartes, jamais une requête de plus — sinon le
	// total et le détail pourraient annoncer deux chiffres différents pour la même chose.
	const activity = ranked.reduce<ActivityCounts>((acc, c) => {
		for (const key of ACTIVITY_EVENTS) acc[key] += c.activity[key];
		return acc;
	}, emptyActivity());
	const sum = (pick: (c: ProjectCard) => number) => ranked.reduce((a, c) => a + pick(c), 0);

	const counters: Counter[] = [
		buildCounter('findings ouverts', sum((c) => c.openTotal), { kind: 'findings_open' }),
		buildCounter('nouveaux', activity.created, {
			kind: 'findings_activity',
			event: 'created',
			sinceDb
		}),
		buildCounter('aggravés', activity.aggravated, {
			kind: 'findings_activity',
			event: 'aggravated',
			sinceDb
		}),
		buildCounter('résolus', activity.resolved, {
			kind: 'findings_activity',
			event: 'resolved',
			sinceDb
		}),
		buildCounter('à valider', sum((c) => c.proposalsPending), { kind: 'proposals_pending' }),
		buildCounter('avis sans réponse', sum((c) => c.reviewsUnanswered), { kind: 'reviews_unanswered' }),
		buildCounter('dead-letter', sum((c) => c.jobsDead), { kind: 'jobs_failed' })
	];

	return {
		sinceDb,
		windowDays,
		now: toDbTimestamp(now),
		portfolio: summarizePortfolio(ranked),
		projects: ranked,
		needingAction: ranked.filter((c) => c.state !== 'ok'),
		activity,
		counters,
		recentRuns,
		runStatusCounts,
		// Le lien naît du MÊME `sinceDb` que le compte : c'est ce qui garantit que
		// la liste ouverte contient exactement ce que le nombre annonce.
		runCounters: Object.entries(runStatusCounts).map(([status, n]) =>
			buildCounter(status, n, { kind: 'runs_period', status, sinceDb })
		),
		capacity,
		costs: summarizeCosts(periodRunCosts)
	};
}
