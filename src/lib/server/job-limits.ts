/**
 * JOB-006 — Limites de concurrence et quotas provider : le JUGEMENT (BACKLOG JOB-006,
 * SPEC §6.2 « queue durable », §17.1 `quota_limited`, §17.2 « consommation de quotas »).
 *
 * Module PUR (zéro import db/`$env`), dans la lignée de `job-retry.ts` et
 * `job-graph.ts` : il décide **ce que la file a le droit de réclamer maintenant** ;
 * `jobs-limits.ts` exécute et `jobs-claim.ts` garde la porte.
 *
 * Ce que JOB-003 laissait ouvert. La file sait RÉAGIR à un quota — 429 classé `quota`,
 * tentative rendue, `deferrals` qui borne la boucle. Elle ne sait pas le PRÉVENIR, et
 * ça se voit à trois endroits :
 *
 *   1. **chaque job découvre le 429 tout seul** : six projets sur le même compte GSC,
 *      le premier se fait refouler, les cinq suivants partent quand même et brûlent un
 *      report chacun. Rien ne dit au deuxième ce que le premier vient d'apprendre ;
 *   2. **rien ne borne un projet** : le tick sert 25 jobs par priorité puis ancienneté,
 *      donc un projet volumineux peut remplir le tick entier et repousser les cinq
 *      autres d'une heure ;
 *   3. **aucune capacité n'est réservée** : les avis et les alertes critiques (SLO
 *      §17.3) passent dans la même file que le travail de fond.
 *
 * Trois mécaniques, une seule sortie (`planAdmission`) :
 *   - **concurrence** — plafonds global / par projet / par provider, calculés sur les
 *     jobs `running` réels ;
 *   - **équité** — un TOUR : chaque projet prend au plus `perProjectPerLap` jobs, et
 *     quand plus personne ne peut prendre, un nouveau tour s'ouvre. Un tick à moitié
 *     utilisé serait pire qu'un tick déséquilibré ;
 *   - **quota** — un échec `quota` met TOUT le provider au repos pour la cohorte, et un
 *     budget de tentatives par fenêtre glissante borne le reste.
 *
 * **Ce que ce module ne prétend pas être.** Le budget par fenêtre compte des JOBS, pas
 * des APPELS API (une détection = N appels GSC). C'est un garde-fou grossier ; la vraie
 * prévention est portée par le refroidissement. Le compte fin d'appels viendra avec les
 * collecteurs E03 — c'est-à-dire quand quelque chose pourra réellement l'écrire, et pas
 * avant (le piège d'AGT-000 : un module complet que personne n'appelle).
 */

// ── Providers ───────────────────────────────────────────────────────

/**
 * Providers externes soumis à quota. `none` = un job qui ne sort pas de la base
 * (détection, production de propositions, expiration de veilles) : il compte dans les
 * plafonds de concurrence, jamais dans un budget provider.
 */
export const JOB_PROVIDERS = ['gsc', 'dataforseo', 'gmb', 'llm', 'none'] as const;
export type JobProvider = (typeof JOB_PROVIDERS)[number];

/**
 * Provider d'un TYPE de job — pas d'une ligne.
 *
 * Pourquoi pas une colonne `jobs.provider` : le provider ne varie pas d'un job à
 * l'autre au sein d'un type, et `monitoring_steps.provider` porte déjà la traçabilité
 * par étape. Une colonne serait une donnée dupliquée, donc une donnée qui peut mentir.
 *
 * **GSC-002 a fait arriver le premier consommateur réel.** `collect:gsc_query_page`
 * appelle l'API Search Analytics, et les 6 projets du parc partagent UN service account
 * (`indexing-api@jonlabs.iam.gserviceaccount.com`) — donc un seul pool de quota. C'est
 * exactement la situation pour laquelle le refroidissement a été écrit : le premier
 * projet refoulé met toute la cohorte au repos, au lieu que les cinq suivants brûlent un
 * report chacun. Le harnais a précédé le collecteur, comme prévu.
 *
 * Les autres types ne sortent pas de la base : la détection lit
 * `gsc_query_page_observations`, le producteur de propositions est déterministe et sans
 * IA (AGT-000), les veilles ne sortent pas de Postgres.
 */
export const PROVIDER_BY_JOB_TYPE: Readonly<Record<string, JobProvider>> = {
	'collect:gsc_query_page': 'gsc',
	// IDX-001 — le fetch du XML ne consomme aucun quota Google, mais la RÉSOLUTION de la
	// racine passe par la propriété GSC (donc le service account partagé). Classer `none` le
	// sortirait du refroidissement provider : un `invalid_grant` général le laisserait partir
	// six fois de suite pour échouer six fois sur l'auth.
	'collect:sitemap': 'gsc',
	// IDX-002 — URL Inspection : quotas propres (2 000/j et 600/min par propriété) mais MÊME
	// service account que Search Analytics. Même cohorte de refroidissement, donc : un 429
	// d'inspection met aussi la collecte GSC au repos, ce qui est exactement voulu sur un compte
	// que les 6 projets partagent.
	'collect:url_inspection': 'gsc',
	'detect:keyword_opportunity': 'none',
	// IDX-005 — le détecteur de transitions ne sort PAS de Postgres : il relit
	// `index_observations` que l'inspection a déjà payées. Le classer `gsc` le mettrait au repos
	// avec la cohorte au premier 429, alors qu'il n'a aucune raison d'attendre : ce qu'il lit est
	// déjà acquis.
	'detect:index_transition': 'none',
	'findings:lifecycle': 'none',
	'propose:actions': 'none',
	noop: 'none',
	// E03 — pas encore de handler (`NoHandlerRegistered`), mais déjà planifiable par
	// `schedulePostPublish` : le jour où son handler arrive, il est déjà gouverné.
	'post_publish:check': 'gsc'
};

/**
 * Un type inconnu vaut `none`.
 *
 * C'est le choix INVERSE de `required` (JOB-004), et il est délibéré. Là-bas, relâcher
 * la garde sur ce qu'on n'avait pas su lire aurait fait tourner un job sur des données
 * absentes — le défaut prudent était donc de bloquer. Ici, resserrer sur un type qu'on
 * ne connaît pas empêcherait tout nouveau handler de démarrer, alors qu'un type non
 * déclaré reste soumis aux plafonds global et projet. Le pire cas est qu'un nouveau
 * provider échappe un temps à son budget ; le pire cas de l'autre choix est une file
 * muette, et une file muette est le pire des échecs.
 */
export function providerForJobType(jobType: string): JobProvider {
	return PROVIDER_BY_JOB_TYPE[jobType] ?? 'none';
}

/** Types du catalogue qui relèvent d'un provider donné (filtre de réclamation). */
export function jobTypesForProvider(provider: JobProvider): string[] {
	return Object.keys(PROVIDER_BY_JOB_TYPE).filter(
		(type) => PROVIDER_BY_JOB_TYPE[type] === provider
	);
}

// ── Limites ─────────────────────────────────────────────────────────

/**
 * Les plafonds. **Convention unique : `0` = pas de limite** (même sémantique que
 * `maxJobs` / `reapLimit` dans `WorkerOptions`). Un plafond absent ne doit jamais se
 * lire « zéro job autorisé » — ce serait une file éteinte par une valeur manquante.
 */
export interface JobLimits {
	/** Jobs simultanément `running`, tous projets confondus. */
	globalConcurrency: number;
	/** Jobs `running` d'un même projet. */
	perProjectConcurrency: number;
	/** Jobs `running` par provider. */
	perProviderConcurrency: Record<JobProvider, number>;
	/** Jobs qu'un projet peut prendre dans un même TOUR d'équité. */
	perProjectPerLap: number;
	/** Places gardées pour `reservedTypes` quand la capacité globale se resserre. */
	reservedSlots: number;
	/** Types prioritaires (avis, alertes) — les seuls réclamables sur la réserve. */
	reservedTypes: string[];
	/** Fenêtre glissante du budget provider. */
	providerWindowMs: number;
	/** Tentatives autorisées par provider et par fenêtre. */
	providerWindowBudget: Record<JobProvider, number>;
	/** Mise au repos d'un provider après un échec classé `quota`. */
	cooldownMs: number;
}

/**
 * Codes portés par `jobs.last_error_code` quand un job est repoussé pour cause de
 * capacité. Distincts de ceux de JOB-003 : ce ne sont pas des échecs, aucune tentative
 * n'a été consommée, et l'opérateur ne doit pas les lire comme tels.
 */
export const QUOTA_LIMITED_CODE = 'QuotaLimited';

/**
 * Défauts. Dimensionnés pour le tick réel : `MAX_JOBS_PER_TICK = 25`, six projets, un
 * seul worker séquentiel par invocation Vercel (mais `scripts/worker.ts` peut tourner
 * à côté — d'où des plafonds de concurrence > 1 qui ne sont pas décoratifs).
 */
export const LIMIT_DEFAULTS: JobLimits = {
	globalConcurrency: 4,
	perProjectConcurrency: 2,
	perProviderConcurrency: { gsc: 2, dataforseo: 2, gmb: 2, llm: 2, none: 0 },
	// 25 jobs / 6 projets ≈ 4 : un tour de 5 laisse une marge sans qu'un projet
	// puisse jamais enchaîner tout un tick.
	perProjectPerLap: 5,
	reservedSlots: 1,
	// SPEC §8.1 — synchronisation des avis et notification d'alerte. Aucun des deux
	// n'a de handler aujourd'hui (E03/E06) : la réserve est armée, pas encore mordante.
	reservedTypes: ['reviews:sync', 'alerts:notify'],
	providerWindowMs: 60 * 60 * 1000,
	providerWindowBudget: { gsc: 200, dataforseo: 100, gmb: 200, llm: 100, none: 0 },
	cooldownMs: 15 * 60 * 1000
};

/** Overrides tels qu'une source de configuration peut les porter (JSON, donc douteux). */
export type JobLimitOverrides = Partial<{
	globalConcurrency: unknown;
	perProjectConcurrency: unknown;
	perProviderConcurrency: unknown;
	perProjectPerLap: unknown;
	reservedSlots: unknown;
	reservedTypes: unknown;
	providerWindowMs: unknown;
	providerWindowBudget: unknown;
	cooldownMs: unknown;
}>;

/**
 * Fusionne des overrides avec les défauts. Idiome tolérant de `resolveScheduleConfig`
 * (schedule-state) et `resolveThresholds` (detector-state) : une valeur absente, d'un
 * mauvais type ou hors bornes retombe sur le DÉFAUT, jamais sur « aucune limite » ni
 * sur « file éteinte ». Une limite illisible qui arrêterait la file serait exactement
 * la panne muette que ce module existe pour éviter.
 *
 * Les sources sont fusionnées dans l'ordre reçu : système d'abord, projet ensuite —
 * un projet peut donc se serrer la ceinture, et c'est le seul sens qui a du sens.
 */
export function resolveLimits(...sources: Array<JobLimitOverrides | null | undefined>): JobLimits {
	const out: JobLimits = {
		...LIMIT_DEFAULTS,
		perProviderConcurrency: { ...LIMIT_DEFAULTS.perProviderConcurrency },
		providerWindowBudget: { ...LIMIT_DEFAULTS.providerWindowBudget },
		reservedTypes: [...LIMIT_DEFAULTS.reservedTypes]
	};

	for (const raw of sources) {
		if (!raw || typeof raw !== 'object') continue;
		out.globalConcurrency = boundedInt(raw.globalConcurrency, 0, 64, out.globalConcurrency);
		out.perProjectConcurrency = boundedInt(raw.perProjectConcurrency, 0, 64, out.perProjectConcurrency);
		out.perProjectPerLap = boundedInt(raw.perProjectPerLap, 0, 1000, out.perProjectPerLap);
		out.reservedSlots = boundedInt(raw.reservedSlots, 0, 64, out.reservedSlots);
		// Bornes larges mais réelles : une fenêtre d'un jour ou un refroidissement de
		// 6 h restent des réglages ; au-delà c'est une faute de frappe, pas une intention.
		out.providerWindowMs = boundedInt(raw.providerWindowMs, 60_000, 24 * 60 * 60 * 1000, out.providerWindowMs);
		out.cooldownMs = boundedInt(raw.cooldownMs, 0, 6 * 60 * 60 * 1000, out.cooldownMs);
		out.perProviderConcurrency = mergeProviderMap(raw.perProviderConcurrency, out.perProviderConcurrency, 64);
		out.providerWindowBudget = mergeProviderMap(raw.providerWindowBudget, out.providerWindowBudget, 1_000_000);
		out.reservedTypes = mergeStringList(raw.reservedTypes, out.reservedTypes);
	}

	return out;
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	const n = Math.floor(value);
	return n >= min && n <= max ? n : fallback;
}

/** Une clé inconnue est IGNORÉE : `none` et les providers réels sont le vocabulaire. */
function mergeProviderMap(
	raw: unknown,
	current: Record<JobProvider, number>,
	max: number
): Record<JobProvider, number> {
	if (!raw || typeof raw !== 'object') return current;
	const source = raw as Record<string, unknown>;
	const out = { ...current };
	for (const provider of JOB_PROVIDERS) {
		out[provider] = boundedInt(source[provider], 0, max, out[provider]);
	}
	return out;
}

/** Liste vide = « plus aucun type réservé », valeur illisible = liste inchangée. */
function mergeStringList(raw: unknown, current: string[]): string[] {
	if (!Array.isArray(raw)) return current;
	const clean = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
	return [...new Set(clean)];
}

// ── Réglages PAR PROJET ─────────────────────────────────────────────

/**
 * Ce qu'un projet peut resserrer pour lui-même, lu dans
 * `project_projections.payload.limits` (calque exact des `schedules` de JOB-005).
 *
 * Deux knobs seulement, et ce sont les seuls qui aient un sens à cette portée : un
 * projet n'a pas à décider du budget GSC, qui est partagé — il ne peut décider que de
 * la place qu'il prend. Une clé absente retombe sur la valeur système.
 */
export interface ProjectLimits {
	perProjectConcurrency: number;
	perProjectPerLap: number;
}

/** Réglages par projet, par `project_id`. Un projet absent suit le système. */
export type ProjectLimitsById = Record<string, Partial<ProjectLimits>>;

/**
 * Lit les overrides d'un projet. TOLÉRANT, même discipline que `resolveLimits` : une
 * valeur illisible retombe sur le système, jamais sur « aucune limite ».
 */
export function resolveProjectLimits(raw: unknown): Partial<ProjectLimits> {
	if (!raw || typeof raw !== 'object') return {};
	const source = raw as Record<string, unknown>;
	const out: Partial<ProjectLimits> = {};
	const concurrency = boundedIntOrNull(source.perProjectConcurrency, 0, 64);
	const perLap = boundedIntOrNull(source.perProjectPerLap, 0, 1000);
	if (concurrency !== null) out.perProjectConcurrency = concurrency;
	if (perLap !== null) out.perProjectPerLap = perLap;
	return out;
}

function boundedIntOrNull(value: unknown, min: number, max: number): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	const n = Math.floor(value);
	return n >= min && n <= max ? n : null;
}

/** Plafond de concurrence effectif d'un projet (override projet, sinon système). */
export function concurrencyForProject(
	limits: JobLimits,
	byProject: ProjectLimitsById | undefined,
	projectId: string
): number {
	return byProject?.[projectId]?.perProjectConcurrency ?? limits.perProjectConcurrency;
}

/** Part de tour effective d'un projet (override projet, sinon système). */
export function lapShareForProject(
	limits: JobLimits,
	byProject: ProjectLimitsById | undefined,
	projectId: string
): number {
	return byProject?.[projectId]?.perProjectPerLap ?? limits.perProjectPerLap;
}

// ── L'état lu en base, tel que le jugement l'attend ─────────────────

/**
 * Instantané de la file. Calculé UNE fois par tour de boucle plutôt qu'en sous-requête
 * de chaque réclamation : la file réelle tient en quelques dizaines de lignes, et un
 * `EXISTS` de plus dans le chemin chaud coûterait davantage que cette photo.
 */
export interface QueueSnapshot {
	/** Jobs `running`, par `project_id`. */
	runningByProject: Record<string, number>;
	/** Jobs `running`, par provider (dérivé du type). */
	runningByProvider: Record<JobProvider, number>;
	/** Total des jobs `running`, tous projets et providers confondus. */
	running: number;
	/** Projets ayant au moins un job réclamable maintenant (`queued` et disponible). */
	projectsWithClaimableWork: string[];
	/** Tentatives démarrées dans la fenêtre glissante, par provider. */
	attemptsInWindowByProvider: Record<JobProvider, number>;
	/**
	 * Instant (ms epoch) du dernier échec classé `quota`, par provider. C'est de là
	 * qu'on DÉRIVE le refroidissement — aucun état de repos n'est persisté nulle part.
	 */
	lastQuotaFailureMsByProvider: Record<JobProvider, number | null>;
}

export function emptySnapshot(): QueueSnapshot {
	return {
		runningByProject: {},
		runningByProvider: zeroByProvider(),
		running: 0,
		projectsWithClaimableWork: [],
		attemptsInWindowByProvider: zeroByProvider(),
		lastQuotaFailureMsByProvider: {
			gsc: null,
			dataforseo: null,
			gmb: null,
			llm: null,
			none: null
		}
	};
}

export function zeroByProvider(): Record<JobProvider, number> {
	return { gsc: 0, dataforseo: 0, gmb: 0, llm: 0, none: 0 };
}

// ── Équité : le TOUR ────────────────────────────────────────────────

/**
 * L'équité d'un drain n'est PAS un état global : personne d'autre que cette invocation
 * ne peut s'en tromper, et deux workers concurrents ne se doivent rien sur ce point
 * (leurs plafonds de concurrence, eux, sont bien gardés en base). Elle vit donc en
 * mémoire dans `runWorker`, et se transmet ici en valeur.
 */
export interface FairnessState {
	/** Numéro du tour courant, à partir de 1 (lisible dans les logs). */
	lap: number;
	/** Jobs pris dans le tour courant, par `project_id`. */
	takenThisLap: Record<string, number>;
}

export function openFairness(): FairnessState {
	return { lap: 1, takenThisLap: {} };
}

/** Comptabilise un job réclamé. Rend un état NEUF (rien n'est muté sur place). */
export function recordClaim(state: FairnessState, projectId: string): FairnessState {
	return {
		lap: state.lap,
		takenThisLap: {
			...state.takenThisLap,
			[projectId]: (state.takenThisLap[projectId] ?? 0) + 1
		}
	};
}

// ── La décision ─────────────────────────────────────────────────────

export const ADMISSION_HOLD_REASONS = [
	'global_concurrency',
	'project_concurrency',
	'project_lap',
	'provider_concurrency',
	'provider_cooldown',
	'provider_budget'
] as const;
export type AdmissionHoldReason = (typeof ADMISSION_HOLD_REASONS)[number];

export interface AdmissionHold {
	reason: AdmissionHoldReason;
	/** `project_id` ou nom de provider selon la cause — jamais un hold anonyme. */
	subject: string;
	/** Phrase prête pour le log et pour l'écran. */
	detail: string;
}

export interface AdmissionPlan {
	/** Rien n'est réclamable : capacité globale atteinte. */
	saturated: boolean;
	/** Seuls les types réservés passent : la réserve mord. */
	reservedOnly: boolean;
	/** Types exclus de la réclamation (provider saturé, au repos, ou hors budget). */
	excludedTypes: string[];
	/** Projets exclus (plafond de concurrence, ou part du tour consommée). */
	excludedProjectIds: string[];
	/** État d'équité à adopter — un nouveau tour a pu s'ouvrir ici. */
	fairness: FairnessState;
	/** `true` si ce plan a ouvert un tour (journalisé, jamais muet). */
	lapOpened: boolean;
	/** Toutes les causes, nommées. Alimente les compteurs du worker et l'écran. */
	holds: AdmissionHold[];
	/** Providers au repos, avec la fin de leur refroidissement (ms epoch). */
	cooldownUntilByProvider: Partial<Record<JobProvider, number>>;
}

export interface PlanAdmissionInput {
	limits: JobLimits;
	snapshot: QueueSnapshot;
	fairness: FairnessState;
	/** Resserrages déclarés par les projets eux-mêmes (`payload.limits`). */
	projectLimits?: ProjectLimitsById;
	/**
	 * Types d'un provider, SUBSTITUABLE — même porte que le `catalog` de `planDueJobs`.
	 * Sans elle, une preuve sur Neon ne pourrait exercer le refroidissement qu'avec les
	 * types de PRODUCTION : elle vérifierait alors que `post_publish:check` est écarté
	 * pendant qu'elle croit tester le sien, et passerait au vert sans rien prouver.
	 * L'app ne le passe jamais.
	 */
	typesForProvider?: (provider: JobProvider) => string[];
	/** Référence de temps, INJECTÉE (rejouable, testable). */
	now: number;
}

/**
 * Ce que la file a le droit de réclamer maintenant.
 *
 * Rend des EXCLUSIONS plutôt qu'un verdict par job : la réclamation est un `SELECT …
 * FOR UPDATE SKIP LOCKED` qui choisit lui-même sa ligne, on ne peut donc pas lui
 * soumettre un candidat — on peut seulement restreindre ce parmi quoi il choisit.
 * C'est aussi ce qui garde la garde À LA PORTE (leçon JOB-004) : les exclusions
 * descendent dans la requête de réclamation, pas dans une vérification d'appelant.
 *
 * **Le tour se rouvre ici.** Si tous les projets qui ont du travail réclamable ont
 * consommé leur part, un tour s'ouvre et les exclusions d'équité tombent : un tick qui
 * s'arrêterait avec du budget et une file pleine serait pire qu'un tick déséquilibré.
 * Le calcul est dans le module pur parce que c'est là qu'un test peut le fermer.
 */
export function planAdmission(input: PlanAdmissionInput): AdmissionPlan {
	const { limits, snapshot, now } = input;
	const holds: AdmissionHold[] = [];
	const cooldownUntilByProvider: Partial<Record<JobProvider, number>> = {};

	// 1. Capacité globale. Un plafond atteint arrête tout : inutile de calculer le reste.
	const globalFull =
		limits.globalConcurrency > 0 && snapshot.running >= limits.globalConcurrency;
	if (globalFull) {
		holds.push({
			reason: 'global_concurrency',
			subject: 'global',
			detail: `${snapshot.running}/${limits.globalConcurrency} jobs en cours.`
		});
	}

	// 2. Réserve : quand il reste moins de places que la réserve, seuls les types
	// réservés passent. Sans elle, un lot de fond saturerait la file au moment précis
	// où un avis ou une alerte critique arrive (SLO §17.3).
	const remaining =
		limits.globalConcurrency > 0 ? limits.globalConcurrency - snapshot.running : Number.POSITIVE_INFINITY;
	const reservedOnly =
		!globalFull &&
		limits.reservedSlots > 0 &&
		limits.reservedTypes.length > 0 &&
		remaining <= limits.reservedSlots;

	// 3. Providers : concurrence, refroidissement, budget de fenêtre. Un provider
	// écarté l'est par ses TYPES — la réclamation ne connaît pas la notion de provider.
	const excludedTypes = new Set<string>();
	const typesOf = input.typesForProvider ?? jobTypesForProvider;
	for (const provider of JOB_PROVIDERS) {
		const types = typesOf(provider);
		if (types.length === 0) continue;

		const running = snapshot.runningByProvider[provider] ?? 0;
		const concurrency = limits.perProviderConcurrency[provider] ?? 0;
		if (concurrency > 0 && running >= concurrency) {
			types.forEach((t) => excludedTypes.add(t));
			holds.push({
				reason: 'provider_concurrency',
				subject: provider,
				detail: `${running}/${concurrency} jobs ${provider} en cours.`
			});
			continue;
		}

		const lastQuota = snapshot.lastQuotaFailureMsByProvider[provider];
		if (limits.cooldownMs > 0 && lastQuota !== null && lastQuota !== undefined) {
			const until = lastQuota + limits.cooldownMs;
			if (until > now) {
				cooldownUntilByProvider[provider] = until;
				types.forEach((t) => excludedTypes.add(t));
				holds.push({
					reason: 'provider_cooldown',
					subject: provider,
					detail: `${provider} au repos encore ${Math.ceil((until - now) / 1000)} s après un quota.`
				});
				continue;
			}
		}

		const budget = limits.providerWindowBudget[provider] ?? 0;
		const used = snapshot.attemptsInWindowByProvider[provider] ?? 0;
		if (budget > 0 && used >= budget) {
			types.forEach((t) => excludedTypes.add(t));
			holds.push({
				reason: 'provider_budget',
				subject: provider,
				detail: `${used}/${budget} tentatives ${provider} sur la fenêtre.`
			});
		}
	}

	// 4. Projets : plafond de concurrence, puis part du tour. Un projet peut s'être
	// resserré lui-même (`payload.limits`) ; à défaut il suit le réglage système.
	const byConcurrency = new Set<string>();
	for (const [projectId, running] of Object.entries(snapshot.runningByProject)) {
		const cap = concurrencyForProject(limits, input.projectLimits, projectId);
		if (cap > 0 && running >= cap) {
			byConcurrency.add(projectId);
			holds.push({
				reason: 'project_concurrency',
				subject: projectId,
				detail: `${running}/${cap} jobs en cours sur ce projet.`
			});
		}
	}

	let fairness = input.fairness;
	let lapOpened = false;
	let byLap = lapExhaustedProjects(limits, fairness, input.projectLimits);

	// Le tour se rouvre quand tout projet AYANT du travail réclamable a consommé sa
	// part — et seulement à cause de l'équité : un projet retenu par sa concurrence
	// n'est pas « servi », il est occupé, et rouvrir un tour ne le libérerait pas.
	const claimable = snapshot.projectsWithClaimableWork.filter((p) => !byConcurrency.has(p));
	if (claimable.length > 0 && claimable.every((p) => byLap.has(p))) {
		fairness = { lap: fairness.lap + 1, takenThisLap: {} };
		byLap = new Set<string>();
		lapOpened = true;
	} else {
		for (const projectId of byLap) {
			holds.push({
				reason: 'project_lap',
				subject: projectId,
				detail: `part du tour ${fairness.lap} consommée (${lapShareForProject(
					limits,
					input.projectLimits,
					projectId
				)}).`
			});
		}
	}

	return {
		saturated: globalFull,
		reservedOnly,
		excludedTypes: [...excludedTypes],
		excludedProjectIds: [...new Set([...byConcurrency, ...byLap])],
		fairness,
		lapOpened,
		holds,
		cooldownUntilByProvider
	};
}

function lapExhaustedProjects(
	limits: JobLimits,
	fairness: FairnessState,
	byProject?: ProjectLimitsById
): Set<string> {
	const out = new Set<string>();
	for (const [projectId, taken] of Object.entries(fairness.takenThisLap)) {
		const share = lapShareForProject(limits, byProject, projectId);
		if (share > 0 && taken >= share) out.add(projectId);
	}
	return out;
}

// ── Exposition : « exposer les quotas restants » ────────────────────

export type CapacityState = 'ok' | 'saturated' | 'quota_limited';

export interface ProviderCapacity {
	provider: JobProvider;
	running: number;
	/** `0` = pas de limite. */
	concurrencyLimit: number;
	attemptsInWindow: number;
	/** `0` = pas de budget. */
	windowBudget: number;
	windowMs: number;
	/** Fin du refroidissement (ms epoch), `null` si le provider n'est pas au repos. */
	cooldownUntilMs: number | null;
	state: CapacityState;
	/** Types de jobs concernés — sans eux, `none` et `gsc` se lisent pareil à l'écran. */
	jobTypes: string[];
}

export interface ProjectCapacity {
	projectId: string;
	running: number;
	concurrencyLimit: number;
	takenThisLap: number;
	lapLimit: number;
	state: CapacityState;
}

export interface CapacityReport {
	global: { running: number; limit: number; reservedSlots: number; state: CapacityState };
	providers: ProviderCapacity[];
	projects: ProjectCapacity[];
	lap: number;
}

/**
 * Ce qu'il reste de capacité — DÉRIVÉ de l'instantané, jamais lu dans un état persisté.
 *
 * Même raison qu'au « zéro table de planification » de JOB-005 : deux états qui peuvent
 * diverger valent moins qu'un seul qui se recalcule. C'est aussi pourquoi ce lot
 * n'écrit pas `project_integrations.health_status = 'quota_limited'` (SPEC §17.1) : ce
 * serait un second état, persistant, dont personne ne serait clairement propriétaire du
 * retour à `healthy`.
 */
export function computeCapacity(input: {
	limits: JobLimits;
	snapshot: QueueSnapshot;
	fairness: FairnessState;
	projectLimits?: ProjectLimitsById;
	now: number;
}): CapacityReport {
	const { limits, snapshot, fairness, now } = input;

	const providers: ProviderCapacity[] = JOB_PROVIDERS.map((provider) => {
		const running = snapshot.runningByProvider[provider] ?? 0;
		const concurrencyLimit = limits.perProviderConcurrency[provider] ?? 0;
		const attemptsInWindow = snapshot.attemptsInWindowByProvider[provider] ?? 0;
		const windowBudget = limits.providerWindowBudget[provider] ?? 0;
		const lastQuota = snapshot.lastQuotaFailureMsByProvider[provider];
		const until =
			limits.cooldownMs > 0 && lastQuota !== null && lastQuota !== undefined
				? lastQuota + limits.cooldownMs
				: null;
		const cooling = until !== null && until > now;

		let state: CapacityState = 'ok';
		if (cooling || (windowBudget > 0 && attemptsInWindow >= windowBudget)) state = 'quota_limited';
		else if (concurrencyLimit > 0 && running >= concurrencyLimit) state = 'saturated';

		return {
			provider,
			running,
			concurrencyLimit,
			attemptsInWindow,
			windowBudget,
			windowMs: limits.providerWindowMs,
			cooldownUntilMs: cooling ? until : null,
			state,
			jobTypes: jobTypesForProvider(provider)
		};
	});

	const projectIds = [
		...new Set([
			...Object.keys(snapshot.runningByProject),
			...Object.keys(fairness.takenThisLap),
			...snapshot.projectsWithClaimableWork
		])
	].sort();

	const projects: ProjectCapacity[] = projectIds.map((projectId) => {
		const running = snapshot.runningByProject[projectId] ?? 0;
		const takenThisLap = fairness.takenThisLap[projectId] ?? 0;
		const concurrencyLimit = concurrencyForProject(limits, input.projectLimits, projectId);
		const lapLimit = lapShareForProject(limits, input.projectLimits, projectId);
		const saturated =
			(concurrencyLimit > 0 && running >= concurrencyLimit) ||
			(lapLimit > 0 && takenThisLap >= lapLimit);
		return {
			projectId,
			running,
			concurrencyLimit,
			takenThisLap,
			lapLimit,
			state: saturated ? 'saturated' : 'ok'
		};
	});

	return {
		global: {
			running: snapshot.running,
			limit: limits.globalConcurrency,
			reservedSlots: limits.reservedSlots,
			state:
				limits.globalConcurrency > 0 && snapshot.running >= limits.globalConcurrency
					? 'saturated'
					: 'ok'
		},
		providers,
		projects,
		lap: fairness.lap
	};
}
