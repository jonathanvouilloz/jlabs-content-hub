/**
 * JOB-006 — Limites de concurrence et quotas provider : l'EXÉCUTION.
 *
 * Le jugement est dans `job-limits.ts` (pur) ; la garde à la porte est dans la
 * réclamation elle-même (`ClaimCapacity`, `jobs-claim.ts`). Reste ce que ni l'un ni
 * l'autre ne peut faire : LIRE l'état de la file et de la configuration, et REPOUSSER
 * les jobs d'un provider mis au repos.
 *
 * Trois lectures, une écriture :
 *   - `loadSystemLimitOverrides` / `loadProjectLimits` — la configuration, système puis
 *     projet, tolérante de bout en bout ;
 *   - `loadQueueSnapshot` — la photo de la file, prise UNE fois par tour de boucle ;
 *   - `coolDownQuotaLimitedJobs` — la passe qui repousse la cohorte d'un provider au
 *     repos, jumelle de `settleBlockedJobs` (JOB-004) et du reaper : bornée, rejouable,
 *     non bloquante.
 *
 * **Aucun état de repos n'est persisté.** Le refroidissement est DÉRIVÉ du dernier
 * échec classé `quota` dans `job_attempts` — table append-only déjà écrite à chaque
 * tentative. Même raison qu'au « zéro table de planification » de JOB-005 : deux états
 * qui peuvent diverger valent moins qu'un seul qui se recalcule. C'est aussi pourquoi
 * ce lot n'écrit pas `project_integrations.health_status = 'quota_limited'` (SPEC §17.1),
 * dette nommée et laissée à OPS-002.
 *
 * Comparaison temporelle : les colonnes sont des `text` de formats potentiellement
 * mixtes (cf. `timestamps.ts`) → tout prédicat CASTE en `timestamp`, jamais de
 * comparaison lexicale.
 */
import { sql } from 'drizzle-orm';
import type { AppDb } from './db/types.js';
import { log } from './log.js';
import { DEPENDENCY_GATE } from './jobs-claim.js';
import {
	JOB_PROVIDERS,
	QUOTA_LIMITED_CODE,
	computeCapacity,
	emptySnapshot,
	jobTypesForProvider,
	openFairness,
	providerForJobType,
	resolveLimits,
	resolveProjectLimits,
	type CapacityReport,
	type JobLimitOverrides,
	type JobLimits,
	type JobProvider,
	type ProjectCapacity,
	type ProjectLimitsById,
	type QueueSnapshot
} from './job-limits.js';
import { toDbTimestamp } from './timestamps.js';

const logger = log('jobs-limits');

/**
 * Clé unique portant les limites système dans `system_settings`.
 *
 * UNE clé JSON plutôt qu'une clé par réglage : `resolveLimits` sait déjà ignorer un
 * champ illisible, alors qu'une dizaine de clés éparses se désynchroniseraient (l'une
 * mise à jour, l'autre oubliée) et rendraient un réglage partiel impossible à relire
 * d'un coup d'œil.
 */
export const SYSTEM_LIMITS_KEY = 'jobs.limits';

// ── Configuration ───────────────────────────────────────────────────

/**
 * Limites système, lues dans `system_settings`. TOLÉRANT de bout en bout : clé absente,
 * JSON cassé, table encore vide ou même absente → aucun override, donc les défauts de
 * `job-limits.ts`.
 *
 * Cette tolérance n'est pas de la politesse : une limite corrompue qui ferait LEVER
 * arrêterait la file entière, et une file arrêtée en silence est le pire mode de panne
 * — celui qui ne se plaint pas. Le pire cas ici est de tourner aux défauts du code,
 * c'est-à-dire au comportement documenté.
 */
export async function loadSystemLimitOverrides(db: AppDb): Promise<JobLimitOverrides | null> {
	try {
		const res = await db.execute(sql`
			SELECT value FROM "seostats"."system_settings" WHERE key = ${SYSTEM_LIMITS_KEY}
		`);
		const row = (res.rows ?? [])[0] as unknown as { value: string } | undefined;
		if (!row?.value) return null;
		const parsed: unknown = JSON.parse(row.value);
		return parsed && typeof parsed === 'object' ? (parsed as JobLimitOverrides) : null;
	} catch (err) {
		logger.warn('limites système illisibles (défauts de code appliqués)', {
			error: err instanceof Error ? err.message : String(err)
		});
		return null;
	}
}

/**
 * Resserrages déclarés par les projets eux-mêmes
 * (`project_projections.payload.limits`). Calque exact de `loadProjectScheduleConfig` :
 * un payload invalide n'éteint jamais la planification d'un projet, il est ignoré.
 *
 * Une seule requête pour tous les projets : la boucle du worker ne peut pas se
 * permettre une lecture par projet à chaque tour.
 */
export async function loadProjectLimits(db: AppDb): Promise<ProjectLimitsById> {
	const out: ProjectLimitsById = {};
	try {
		const res = await db.execute(sql`
			SELECT project_id, payload
			  FROM "seostats"."project_projections"
			 WHERE status = 'current'
		`);
		for (const row of (res.rows ?? []) as unknown as Array<{
			project_id: string;
			payload: string | null;
		}>) {
			if (!row.payload) continue;
			try {
				const parsed = JSON.parse(row.payload) as { limits?: unknown };
				const limits = resolveProjectLimits(parsed?.limits);
				if (Object.keys(limits).length > 0) out[row.project_id] = limits;
			} catch {
				// Un projet au payload cassé suit le système. Il ne fait pas tomber les autres.
			}
		}
	} catch (err) {
		logger.warn('projections illisibles (limites système appliquées partout)', {
			error: err instanceof Error ? err.message : String(err)
		});
	}
	return out;
}

// ── Instantané de la file ───────────────────────────────────────────

export interface SnapshotInput {
	db: AppDb;
	/** Fenêtre glissante du budget provider. */
	windowMs: number;
	now?: Date | string;
	/**
	 * Résolution type → provider, SUBSTITUABLE. Même raison d'être que le `catalog` de
	 * `planDueJobs` : une preuve sur Neon doit pouvoir démontrer le refroidissement sans
	 * emprunter les types de production (dont la détection, qui écrirait de vrais
	 * findings). L'app ne le passe jamais — elle prend la table réelle.
	 */
	providerOf?: (jobType: string) => JobProvider;
	/**
	 * Types que le worker appelant sait traiter (vide = tous).
	 *
	 * Indispensable à `projectsWithClaimableWork` : sans ce filtre, un projet dont le
	 * seul travail en file est d'un type que CE worker ne gère pas compterait comme
	 * « en attente d'être servi » — et, n'étant jamais servi, empêcherait le tour
	 * d'équité de se rouvrir POUR TOUJOURS. Les projets que le worker peut réellement
	 * servir seraient alors affamés par un projet qu'il ne peut pas toucher.
	 */
	types?: string[];
}

/**
 * La photo de la file : ce qui tourne, ce qui attend, ce qui a été consommé.
 *
 * Prise UNE fois par tour de boucle, pas en sous-requête de chaque réclamation. La file
 * réelle tient en quelques dizaines de lignes ; un `EXISTS` de plus dans le chemin chaud
 * coûterait davantage que cette photo, et la rendrait surtout beaucoup plus difficile à
 * lire — alors que le calcul qu'elle nourrit est, lui, entièrement testable à part.
 *
 * `projectsWithClaimableWork` applique **exactement** `DEPENDENCY_GATE` (importée de
 * `jobs-claim.ts`, pas recopiée). Sans elle, un projet dont le seul travail est bloqué
 * par un prérequis compterait comme « en attente d'être servi » et empêcherait un tour
 * de se rouvrir — le tick s'arrêterait avec du budget et de la file.
 */
export async function loadQueueSnapshot(input: SnapshotInput): Promise<QueueSnapshot> {
	const now = input.now ?? new Date();
	const nowDb = toDbTimestamp(now);
	const windowStartDb = toDbTimestamp(new Date(toMs(now) - Math.max(0, input.windowMs)));

	const snapshot = emptySnapshot();
	const providerOf = input.providerOf ?? providerForJobType;

	// 1. Ce qui tourne VRAIMENT, par projet ET par type (le provider se dérive du type
	// en JS — la base n'a pas à connaître cette table, qui est une règle de code).
	//
	// `status='running'` ne suffit PAS : un job dont le BAIL A EXPIRÉ n'est en train de
	// tourner nulle part — c'est la définition même de l'abandon (JOB-002), et le reaper
	// n'est simplement pas encore passé. Le compter occuperait une place de concurrence
	// au nom d'un worker mort, et quelques workers morts suffiraient alors à geler la
	// file entière jusqu'au prochain reaper. Le bail est le seul titre de propriété
	// vivant ; c'est donc lui qui décide, pas le statut.
	const running = await input.db.execute(sql`
		SELECT project_id, type, count(*)::int AS n
		  FROM "seostats"."jobs"
		 WHERE status = 'running'
		   AND lease_until IS NOT NULL
		   AND lease_until::timestamp > ${nowDb}::timestamp
		 GROUP BY project_id, type
	`);
	for (const row of (running.rows ?? []) as unknown as Array<{
		project_id: string;
		type: string;
		n: number;
	}>) {
		const n = Number(row.n);
		snapshot.running += n;
		snapshot.runningByProject[row.project_id] = (snapshot.runningByProject[row.project_id] ?? 0) + n;
		const provider = providerOf(row.type);
		snapshot.runningByProvider[provider] += n;
	}

	// 2. Les projets qui ont du travail RÉELLEMENT réclamable maintenant.
	// Filtre PARAMÉTRÉ en `IN (…)`, comme dans `claimJob` — jamais `= ANY($n)`.
	const types = input.types ?? [];
	const typeFilter =
		types.length > 0
			? sql`AND c.type IN (${sql.join(
					types.map((t) => sql`${t}`),
					sql`, `
				)})`
			: sql``;
	const claimable = await input.db.execute(sql`
		SELECT DISTINCT c.project_id
		  FROM "seostats"."jobs" AS c
		 WHERE c.status = 'queued'
		   AND c.available_at::timestamp <= ${nowDb}::timestamp
		   ${typeFilter}
		   ${DEPENDENCY_GATE}
	`);
	snapshot.projectsWithClaimableWork = (
		(claimable.rows ?? []) as unknown as Array<{ project_id: string }>
	).map((r) => r.project_id);

	// 3. Consommation de la fenêtre : les tentatives DÉMARRÉES, quel que soit leur sort.
	// Une tentative qui a échoué a quand même appelé le provider — la compter seulement
	// si elle réussit sous-estimerait précisément les journées où ça va mal.
	const attempts = await input.db.execute(sql`
		SELECT j.type, count(*)::int AS n
		  FROM "seostats"."job_attempts" AS a
		  JOIN "seostats"."jobs" AS j ON j.id = a.job_id
		 WHERE a.started_at::timestamp >= ${windowStartDb}::timestamp
		 GROUP BY j.type
	`);
	for (const row of (attempts.rows ?? []) as unknown as Array<{ type: string; n: number }>) {
		snapshot.attemptsInWindowByProvider[providerOf(row.type)] += Number(row.n);
	}

	// 4. Le dernier échec `quota` par type — c'est de là qu'est DÉRIVÉ le refroidissement.
	// `finished_at` fait foi, jamais `attempt_no` : `requeueDeadJob` remet le compteur à
	// zéro, donc le verdict le plus récent peut porter le plus petit numéro (piège JOB-004).
	const quota = await input.db.execute(sql`
		SELECT j.type, max(a.finished_at::timestamp) AS last_quota
		  FROM "seostats"."job_attempts" AS a
		  JOIN "seostats"."jobs" AS j ON j.id = a.job_id
		 WHERE a.error_class = 'quota' AND a.finished_at IS NOT NULL
		 GROUP BY j.type
	`);
	for (const row of (quota.rows ?? []) as unknown as Array<{
		type: string;
		last_quota: string | Date | null;
	}>) {
		const ms = toMsOrNull(row.last_quota);
		if (ms === null) continue;
		const provider = providerOf(row.type);
		const current = snapshot.lastQuotaFailureMsByProvider[provider];
		if (current === null || current === undefined || ms > current) {
			snapshot.lastQuotaFailureMsByProvider[provider] = ms;
		}
	}

	return snapshot;
}

// ── La passe de refroidissement ─────────────────────────────────────

export interface CooledProvider {
	provider: JobProvider;
	/** Fin du refroidissement, au format DB. */
	untilDb: string;
	/** Jobs effectivement repoussés par cette passe. */
	pushed: number;
}

export interface CooldownResult {
	providers: CooledProvider[];
	/** Total des jobs repoussés (0 quand aucun provider n'est au repos). */
	pushed: number;
}

/**
 * Repousse la cohorte des providers au repos.
 *
 * **Ce que ça ferme.** La garde de réclamation empêche déjà de PRENDRE un job dont le
 * provider est au repos ; sans cette passe, ces jobs resteraient `queued` et disponibles,
 * et chaque tour de boucle les re-examinerait pour les re-écarter — bruit pur, et
 * surtout invisible : la console montrerait des jobs « en file, disponibles » que rien
 * ne prend. Ici leur `available_at` dit la vérité, et `/jobs` la montre.
 *
 * **Ce que ça NE fait PAS.** Ni `attempts`, ni `deferrals` ne bougent : le job n'a pas
 * été réclamé, il n'a rien tenté, personne ne lui doit un échec. C'est la même asymétrie
 * que `deferJob` (JOB-003), poussée un cran plus tôt — là-bas la tentative était rendue,
 * ici elle n'a jamais eu lieu. Aucune ligne de `job_attempts` non plus, pour la même
 * raison : cette table dit « une tentative a eu lieu », et il n'y en a pas eu.
 *
 * Idempotente : au second passage, `available_at` est déjà au-delà de la fin du
 * refroidissement, la garde `<` ne matche plus, zéro ligne touchée.
 */
export async function coolDownQuotaLimitedJobs(input: {
	db: AppDb;
	/** Fins de refroidissement par provider, telles que `planAdmission` les a calculées. */
	cooldownUntilByProvider: Partial<Record<JobProvider, number>>;
	limit?: number;
	now?: Date | string;
	/** Types d'un provider, SUBSTITUABLE — cf. `providerOf` de `loadQueueSnapshot`. */
	typesForProvider?: (provider: JobProvider) => string[];
}): Promise<CooldownResult> {
	const result: CooldownResult = { providers: [], pushed: 0 };
	const limit = Math.max(1, Math.floor(input.limit ?? 200));
	const nowDb = toDbTimestamp(input.now ?? new Date());

	for (const provider of JOB_PROVIDERS) {
		const until = input.cooldownUntilByProvider[provider];
		if (until === undefined) continue;
		const types = (input.typesForProvider ?? jobTypesForProvider)(provider);
		if (types.length === 0) continue;

		const untilDb = toDbTimestamp(new Date(until));
		// Filtre PARAMÉTRÉ en `IN (…)` — jamais `= ANY($n)` (driver Neon).
		const res = await input.db.execute(sql`
			UPDATE "seostats"."jobs"
			   SET available_at = ${untilDb},
			       last_error_class = 'quota',
			       last_error_code = ${QUOTA_LIMITED_CODE},
			       last_error_message = ${`Provider ${provider} au repos jusqu'à ${untilDb} (quota).`},
			       updated_at = ${nowDb}
			 WHERE id IN (
			       SELECT id FROM "seostats"."jobs"
			        WHERE status = 'queued'
			          AND available_at::timestamp < ${untilDb}::timestamp
			          AND type IN (${sql.join(
										types.map((t) => sql`${t}`),
										sql`, `
									)})
			        LIMIT ${limit}
			 )
			 RETURNING id
		`);
		const pushed = res.rows?.length ?? 0;
		if (pushed === 0) continue;
		result.providers.push({ provider, untilDb, pushed });
		result.pushed += pushed;
	}

	if (result.pushed > 0) {
		logger.warn('jobs repoussés (provider au repos)', {
			pushed: result.pushed,
			providers: result.providers.map((p) => `${p.provider}→${p.untilDb} (${p.pushed})`)
		});
	}
	return result;
}

// ── Chargement complet, pour un tour de boucle ──────────────────────

export interface LimitsContext {
	limits: JobLimits;
	projectLimits: ProjectLimitsById;
	snapshot: QueueSnapshot;
}

/**
 * Tout ce dont `planAdmission` a besoin, en une fois.
 *
 * `resolveLimits` est appliquée par l'appelant (`job-runner.ts`) : ce module rend la
 * matière, pas la décision — c'est ce qui garde le jugement testable sans base.
 */
export async function loadLimitsContext(input: {
	db: AppDb;
	windowMs: number;
	now?: Date | string;
	/** Types du worker appelant — cf. `SnapshotInput.types`. */
	types?: string[];
}): Promise<{ overrides: JobLimitOverrides | null; projectLimits: ProjectLimitsById; snapshot: QueueSnapshot }> {
	const [overrides, projectLimits, snapshot] = await Promise.all([
		loadSystemLimitOverrides(input.db),
		loadProjectLimits(input.db),
		loadQueueSnapshot({ db: input.db, windowMs: input.windowMs, now: input.now, types: input.types })
	]);
	return { overrides, projectLimits, snapshot };
}

// ── Lecture pour l'écran et la CLI ──────────────────────────────────

/** Une ligne projet du rapport de capacité, nommée (l'écran ne montre pas des ids). */
export interface NamedProjectCapacity extends ProjectCapacity {
	projectSlug: string;
	projectName: string;
}

export interface CapacitySnapshot extends Omit<CapacityReport, 'projects'> {
	projects: NamedProjectCapacity[];
	/** Les limites effectivement appliquées (défauts + overrides système). */
	limits: JobLimits;
	/** `true` si des overrides système sont en base — sinon ce sont les défauts du code. */
	configured: boolean;
}

/**
 * Le rapport de capacité, tel que `/jobs` et `scripts/jobs-inspect.ts` le rendent.
 *
 * L'équité (`FairnessState`) n'existe QUE pendant un drain, en mémoire : un lecteur
 * externe n'en voit donc rien, et c'est exact — hors drain, aucun tour n'est en cours.
 * Le rapport porte la concurrence et les quotas, qui eux sont des faits en base.
 */
export async function loadCapacitySnapshot(input: {
	db: AppDb;
	now?: Date | string;
}): Promise<CapacitySnapshot> {
	const overrides = await loadSystemLimitOverrides(input.db);
	const limits = resolveLimits(overrides);
	const [projectLimits, snapshot] = await Promise.all([
		loadProjectLimits(input.db),
		loadQueueSnapshot({ db: input.db, windowMs: limits.providerWindowMs, now: input.now })
	]);

	const report = computeCapacity({
		limits,
		snapshot,
		projectLimits,
		fairness: openFairness(),
		now: toMs(input.now ?? new Date())
	});

	// Les noms, en une requête sur les seuls projets concernés.
	const ids = report.projects.map((p) => p.projectId);
	const names = new Map<string, { slug: string; name: string }>();
	if (ids.length > 0) {
		const res = await input.db.execute(sql`
			SELECT id, slug, name FROM "seostats"."projects"
			 WHERE id IN (${sql.join(
					ids.map((id) => sql`${id}`),
					sql`, `
				)})
		`);
		for (const row of (res.rows ?? []) as unknown as Array<{
			id: string;
			slug: string;
			name: string;
		}>) {
			names.set(row.id, { slug: row.slug, name: row.name });
		}
	}

	return {
		...report,
		limits,
		configured: overrides !== null,
		projects: report.projects.map((p) => ({
			...p,
			projectSlug: names.get(p.projectId)?.slug ?? p.projectId,
			projectName: names.get(p.projectId)?.name ?? p.projectId
		}))
	};
}

// ── Écriture de la configuration (outillage) ────────────────────────

/**
 * Écrit les limites système. Appelée par `scripts/limits.ts`, jamais par l'app : un
 * réglage d'exploitation est une décision, elle se prend à la main.
 *
 * `updated_at` au format DB, jamais en ISO (piège `timestamps.ts`).
 */
export async function saveSystemLimitOverrides(input: {
	db: AppDb;
	overrides: JobLimitOverrides;
	description?: string;
	now?: Date | string;
}): Promise<void> {
	const nowDb = toDbTimestamp(input.now ?? new Date());
	await input.db.execute(sql`
		INSERT INTO "seostats"."system_settings" (key, value, description, updated_at)
		VALUES (
			${SYSTEM_LIMITS_KEY},
			${JSON.stringify(input.overrides)},
			${input.description ?? 'Limites de file JOB-006 (concurrence, quotas provider).'},
			${nowDb}
		)
		ON CONFLICT (key) DO UPDATE
		   SET value = EXCLUDED.value,
		       description = EXCLUDED.description,
		       updated_at = EXCLUDED.updated_at
	`);
}

function toMs(v: Date | string): number {
	return typeof v === 'string' ? Date.parse(v.replace(' ', 'T') + 'Z') : v.getTime();
}

/**
 * Un horodatage rendu par la base peut être un `Date` (colonne castée en `timestamp`)
 * ou du texte. Le texte est au format DB, donc en UTC SANS suffixe de zone : le lire
 * avec `Date.parse` tel quel le ferait interpréter en heure LOCALE, et le
 * refroidissement serait décalé d'une ou deux heures selon la saison.
 */
function toMsOrNull(v: string | Date | null): number | null {
	if (v === null || v === undefined) return null;
	if (v instanceof Date) return v.getTime();
	if (typeof v !== 'string' || v.length === 0) return null;
	const ms = Date.parse(v.replace(' ', 'T') + (/[Zz]|[+-]\d\d:?\d\d$/.test(v) ? '' : 'Z'));
	return Number.isFinite(ms) ? ms : null;
}
