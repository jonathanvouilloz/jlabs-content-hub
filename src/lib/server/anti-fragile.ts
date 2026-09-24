/**
 * E18 — Anti-fragilité du monitoring hebdomadaire : l'EXÉCUTANT.
 *
 * Même paire que `report-publication-state.ts` / `report-publication.ts` : `anti-fragile-state.ts`
 * décide (pur), ici on lit la base et on applique.
 *
 * Deux gestes, tous deux **dérivés à l'exécution**, jamais écrits dans `project_projections` :
 *
 *   1. `loadInspectionTimeoutWeeks` — l'historique des tentatives d'inspection par semaine, la
 *      matière du volet B (`detectRecurrentTimeout`).
 *   2. `resolveInspectionBudgetForProject` — le budget effectif d'un projet, resserré si ses
 *      semaines récentes portent des timeouts (volet C).
 *
 * ⭐ La réversibilité est la vertu anti-fragile : parce que le resserrement est DÉRIVÉ du verdict
 * et non persistant, il revient automatiquement au défaut quand le projet redevient stable — sans
 * aucun geste d'écriture, et sans toucher au registre `project_projections` (possédé par le
 * migrateur neutre, loi n°5 du Noyau).
 */
import { and, eq, sql } from 'drizzle-orm';
import { jobAttempts, jobs } from './db/schema.js';
import type { AppDb } from './db/types.js';
import {
	RECURRENT_TIMEOUT_DEFAULTS,
	computeTightenedBudget,
	detectRecurrentTimeout,
	isInspectionTimeoutCode,
	type RecurrentTimeoutVerdict,
	type TightenedBudget,
	type TimeoutWeek
} from './anti-fragile-state.js';
import { upsertFinding, recordFindingEvent } from './findings.js';
import { toDbTimestamp } from './timestamps.js';
import { log } from './log.js';

// Le type de job d'inspection, en littéral : importer `job-runner.ts` ici créerait un cycle
// (`index-selection → anti-fragile → job-runner → index-selection`). La valeur est un contrat
// stable (miroir de `JOB_TYPE_COLLECT_URL_INSPECTION` dans `job-runner.ts`) ; si elle bouge,
// le test de cohérence la rattrapera.
const JOB_TYPE_URL_INSPECTION = 'collect:url_inspection';

const logger = log('anti-fragile');

/**
 * Charge les semaines de timeout d'inspection d'un projet sur une fenêtre glissante.
 *
 * La source de vérité est `job_attempts` (append-only, JOB-002) : on compte les tentatives de
 * `collect:url_inspection` dont `error_code` porte un code timeout (`ProviderTimeout` ou
 * `WorkerDied`), agrégées par semaine. On ne lit QUE les types d'échec qui trahissent un provider
 * lent ou un worker mort — un quota ou une erreur d'auth n'est pas une fragilité qui appelle un
 * resserrement de charge.
 *
 * La fenêtre est bornée (défaut : les N dernières semaines) : une collecte défaillante est un
 * fait récent, et un mauvais jour de juillet ne doit pas resserrer un budget en septembre.
 */
export async function loadInspectionTimeoutWeeks(input: {
	db: AppDb;
	projectId: string;
	windowWeeks?: number;
	now?: Date;
}): Promise<TimeoutWeek[]> {
	const windowWeeks = input.windowWeeks ?? RECURRENT_TIMEOUT_DEFAULTS.windowWeeks;
	const now = input.now ?? new Date();

	// Le lundi de la semaine courante (UTC) : la fenêtre couvre les `windowWeeks` dernières
	// semaines pleines. On borne par `started_at` pour ne pas compter un run du futur.
	const sinceMs = now.getTime() - windowWeeks * 7 * 24 * 60 * 60 * 1000;
	const since = toDbTimestamp(new Date(sinceMs));

	const rows = await input.db
		.select({
			weekStart: sql<string>`substr(${jobAttempts.startedAt}, 1, 10)`,
			errorCode: jobAttempts.errorCode
		})
		.from(jobAttempts)
		.innerJoin(jobs, eq(jobAttempts.jobId, jobs.id))
		.where(
			and(
				eq(jobAttempts.projectId, input.projectId),
				eq(jobs.type, JOB_TYPE_URL_INSPECTION),
				sql`${jobAttempts.startedAt} >= ${since}`
			)
		);

	// Agréger par semaine : une semaine avec au moins un timeout est une semaine `timedOut`.
	// L'ordre final est chronologique (du plus ancien au plus récent) — c'est ce que
	// `detectRecurrentTimeout` attend pour prendre les N dernières.
	const timedByWeek = new Map<string, boolean>();
	for (const row of rows) {
		if (isInspectionTimeoutCode(row.errorCode)) timedByWeek.set(row.weekStart, true);
	}
	const weeks: TimeoutWeek[] = [...timedByWeek.keys()]
		.sort()
		.map((weekStart) => ({ weekStart, timedOut: timedByWeek.get(weekStart) ?? false }));

	return weeks;
}

/**
 * Budget d'inspection effectif d'un projet à l'exécution.
 *
 * Charge les semaines de timeout du projet, en dérive le verdict de récurrence (volet B), puis
 * applique le resserrement (volet C). Le résultat est PUREMENT dérivé : il ne modifie rien, et
 * repasse au défaut dès que le projet redevient stable.
 */
export async function resolveInspectionBudgetForProject(input: {
	db: AppDb;
	projectId: string;
	baseBudget: number;
	/** Slug du projet : s'il est fourni, produit aussi le finding d'alerte (volet B). */
	projectSlug?: string | null;
	windowWeeks?: number;
	now?: Date;
	runId?: string | null;
}): Promise<TightenedBudget> {
	const weeks = await loadInspectionTimeoutWeeks({
		db: input.db,
		projectId: input.projectId,
		windowWeeks: input.windowWeeks,
		now: input.now
	});
	const verdict = detectRecurrentTimeout({
		weeks,
		windowWeeks: input.windowWeeks
	});
	const budget = computeTightenedBudget({
		baseBudget: input.baseBudget,
		recurrent: verdict.recurrent
	});
	if (budget.tightened) {
		logger.warn('budget d’inspection resserré (anti-fragile)', {
			projectId: input.projectId,
			baseBudget: budget.baseBudget,
			effectiveBudget: budget.effectiveBudget,
			timedOutWeeks: verdict.timedOutWeeks,
			totalWeeks: verdict.totalWeeks
		});
	}
	// Volet B — alerte inbox : le même verdict qui resserre le budget remonte à l'inbox, sans
	// requête supplémentaire (les semaines sont déjà chargées). Le finding ne se produit que
	// sur récurrence ; idempotent par fingerprint.
	if (input.projectSlug && verdict.recurrent) {
		await ensureRecurrentTimeoutFindingWithWeeks({
			db: input.db,
			projectId: input.projectId,
			projectSlug: input.projectSlug,
			verdict,
			now: input.now,
			runId: input.runId
		});
	}
	return budget;
}

// ── Volet B — Alerte inbox ──────────────────────────────────────────

/** Type fermé du finding de timeouts récurrents (miroir du catalogue SPEC §10.4). */
export const RECURRENT_TIMEOUT_FINDING_TYPE = 'recurrent_inspection_timeout';
/** Entité : un projet tout entier, pas une URL (le timeout est un symptôme de l'intégration). */
const TIMEOUT_ENTITY_TYPE = 'integration';
/** Version du détecteur — estampillée pour ne pas relire un vieux finding avec les règles du jour. */
const TIMEOUT_DETECTOR_VERSION = 'anti-fragile@1';

export interface RecurrentTimeoutFindingResult {
	findingId: string;
	recurrent: boolean;
	timedOutWeeks: number;
	totalWeeks: number;
}

/**
 * Volet B — produit (ou rafraîchit) le finding `recurrent_inspection_timeout` d'un projet.
 *
 * Idempotent par le fingerprint stable (type + entité + slug) : la re-détection rafraîchit la
 * ligne et incrémente `occurrence_count`, elle ne crée pas de doublon. Le finding ne se
 * PRODUIT que quand le verdict est récurrent ; s'il redevient stable, la prochaine passe de
 * réconciliation du détecteur pourra le résoudre (le cycle de vie FIND-003 reste l'autorité).
 */
export async function ensureRecurrentTimeoutFinding(input: {
	db: AppDb;
	projectId: string;
	projectSlug: string;
	windowWeeks?: number;
	now?: Date;
	runId?: string | null;
}): Promise<RecurrentTimeoutFindingResult> {
	const weeks = await loadInspectionTimeoutWeeks({
		db: input.db,
		projectId: input.projectId,
		windowWeeks: input.windowWeeks,
		now: input.now
	});
	const verdict = detectRecurrentTimeout({ weeks, windowWeeks: input.windowWeeks });
	return ensureRecurrentTimeoutFindingWithWeeks({
		db: input.db,
		projectId: input.projectId,
		projectSlug: input.projectSlug,
		verdict,
		now: input.now,
		runId: input.runId
	});
}

/**
 * Variante interne qui réutilise les semaines et le verdict déjà chargés (le budget anti-fragile
 * les calcule pour son propre compte ; on ne double pas la requête). Séparée pour que l'API
 * publique reste simple et que le chemin unique ne refasse pas le travail.
 */
async function ensureRecurrentTimeoutFindingWithWeeks(input: {
	db: AppDb;
	projectId: string;
	projectSlug: string;
	verdict: RecurrentTimeoutVerdict;
	now?: Date;
	runId?: string | null;
}): Promise<RecurrentTimeoutFindingResult> {
	const { db, projectId, projectSlug, verdict, now, runId } = input;

	if (!verdict.recurrent) {
		return {
			findingId: '',
			recurrent: false,
			timedOutWeeks: verdict.timedOutWeeks,
			totalWeeks: verdict.totalWeeks
		};
	}

	const evidence = JSON.stringify({
		kind: 'inspection_timeout',
		timedOutWeeks: verdict.timedOutWeeks,
		totalWeeks: verdict.totalWeeks,
		weeks: verdict.weeks.filter((w) => w.timedOut).map((w) => w.weekStart),
		source: 'job_attempts',
		observedAt: (now ?? new Date()).toISOString()
	});

	const result = await upsertFinding(
		{
			projectId,
			type: RECURRENT_TIMEOUT_FINDING_TYPE,
			entityType: TIMEOUT_ENTITY_TYPE,
			entityKey: projectSlug,
			title: `Inspection d’URLs en timeout récurrent (${verdict.timedOutWeeks}/${verdict.totalWeeks} semaines)`,
			severity: 'warning',
			priorityScore: 40,
			confidenceScore: 0.9,
			evidenceJson: evidence,
			detectorVersion: TIMEOUT_DETECTOR_VERSION,
			runId: runId ?? null
		},
		db
	);

	if (result.isNew) {
		await recordFindingEvent(
			{
				findingId: result.id,
				projectId,
				eventType: 'created',
				toStatus: 'open',
				reason: verdict.note,
				actor: 'system'
			},
			db
		);
	}

	return {
		findingId: result.id,
		recurrent: true,
		timedOutWeeks: verdict.timedOutWeeks,
		totalWeeks: verdict.totalWeeks
	};
}
