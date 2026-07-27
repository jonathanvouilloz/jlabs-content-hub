/**
 * FIND-006 — Détecteur `new_query` / `lost_query` : la LECTURE et l'ÉCRITURE.
 *
 * Le SEUL endroit de ce détecteur qui touche la base. Tout le raisonnement vit dans
 * le module PUR `query-turnover-state.ts` (testé par vitest) : ici on lit des
 * observations, on applique les fonctions pures, on persiste des findings.
 *
 * Le client drizzle est INJECTÉ (`AppDb`) : l'app passe son `db`, les runners
 * `scripts/` passent leur propre Pool.
 *
 * ── UN job, DEUX types de findings ──────────────────────────────────────────────
 *
 * Découvertes et pertes sortent de la même passe, sur les mêmes fenêtres, avec la
 * même normalisation de variantes — et surtout, chacune est la garde de l'autre :
 * c'est en voyant l'ensemble des deux qu'on sait qu'une « nouveauté » n'est que
 * l'orthographe d'une requête perdue. Deux jobs reliraient deux fois les mêmes
 * lignes pour reconstruire chacun la moitié de l'information, et le premier
 * décalage entre eux produirait les deux faux signaux symétriques.
 *
 * Ils gardent en revanche DEUX `type` de findings (§10.4) et donc **deux closures
 * de réconciliation** : `reconcileDetectionRun` travaille par `(project_id, type)`,
 * et une découverte qui cesse d'être neuve n'a rien à voir avec une perte qui se
 * résorbe.
 *
 * ── La portée (`scope`), et pourquoi elle n'existe que du côté des pertes ────────
 *
 * Une DÉCOUVERTE est autoritaire : toutes les requêtes de la fenêtre courante sont
 * observées, donc un groupe absent de la closure a vraiment cessé d'être neuf — la
 * nouveauté est périssable, et l'auto-résolution est sa fin de vie normale.
 *
 * Une PERTE ne l'est pas. La fenêtre précédente glisse d'une semaine à chaque run :
 * la semaine d'après, la requête perdue n'y est plus, donc le run ne peut plus
 * mesurer ce qu'elle pesait — alors qu'elle est toujours absente. Sortir son
 * fingerprint de la closure sans plus l'auto-résoudrait : « je ne peux plus mesurer
 * sa perte » se lirait « elle est revenue ». D'où `scope` = closure ∪ groupes
 * PRÉSENTS dans la fenêtre courante. Un finding hors portée est laissé **strictement
 * intact** (`consecutive_misses` compris), exactement comme IDX-005 traite une URL
 * qu'il n'a pas inspectée. Et le retour effectif de la requête, lui, la remet dans la
 * portée et hors de la closure : c'est ce qui déclenche la résolution.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { findings, gscQueryPageObservations, projectProjections } from '../db/schema.js';
import type { AppDb } from '../db/types.js';
import type { ObservationRow, ObservationWindow } from '../detector-state.js';
import {
	upsertFinding,
	recordFindingEvent,
	expireSnoozes,
	reconcileDetectionRun
} from '../findings.js';
import {
	computePriorityScore,
	deriveFindingFingerprint,
	deriveSeverityEventType,
	type FindingSeverity,
	type LifecycleConfig
} from '../finding-state.js';
import {
	buildWindowComparison,
	windowCompleteness,
	type WindowCompleteness,
	type WindowSpan
} from '../gsc-windows-state.js';
import { loadAvailableWeeks, loadWindowRows } from '../gsc-windows.js';
import { latestCompleteWeekStart, weekEndOf } from '../collectors/gsc-collector-state.js';
import { loadGscLatencyDays } from '../gsc-settings.js';
import { loadLatestIndexStates } from '../indexing-read.js';
import {
	DETECTOR_QUERY_TURNOVER,
	LOST_QUERY_TYPE,
	NEW_QUERY_SKILL,
	NEW_QUERY_TYPE,
	buildTurnoverEvidence,
	buildTurnoverReason,
	buildTurnoverTitle,
	deriveTurnoverSeverity,
	lostQuerySkill,
	normalizeQueryKey,
	resolveTurnoverThresholds,
	runTurnoverPass,
	scoreTurnover,
	type PageIndexation,
	type QueryLifespan,
	type TurnoverEvidence,
	type TurnoverThresholds,
	type TurnoverUnit
} from './query-turnover-state.js';

/**
 * Fenêtre de comparaison : 4 semaines contre 4 semaines, comme la fenêtre
 * structurelle de FIND-005. Pas de second span ici — le croisement 7/28 j de la
 * baisse sert à MESURER un niveau de confirmation sur une grandeur continue ; une
 * apparition ou une disparition est binaire, et la regarder sur une seule semaine ne
 * produirait que le bruit de la longue traîne (44 apparues et 87 disparues par
 * fenêtre sur `lecureux`, dont l'immense majorité à une impression).
 */
export const TURNOVER_SPAN: WindowSpan = 28;

/**
 * Borne de l'historique d'indexation consulté pour la confirmation §10.4. Au-delà,
 * un verdict n'est plus un « état courant » : le réutiliser ferait supprimer une
 * perte réelle sur la foi d'une inspection périmée.
 */
const INDEXATION_LOOKBACK_DAYS = 90;

/** Plafond d'URLs dont on lit l'état d'indexation (la garde reste bornée). */
const MAX_INDEXATION_URLS = 500;

// ── Contrat d'entrée/sortie (interface versionnée — FIND-001) ───────

export interface TurnoverDetectorInput {
	db: AppDb;
	projectId: string;
	runId?: string | null;
	/** N'écrit rien : sert à inspecter le plan avant de peupler l'inbox. */
	dryRun?: boolean;
	/** Overrides de seuils explicites (priment sur ceux de la projection projet). */
	thresholds?: Partial<TurnoverThresholds> | null;
	/** Overrides du cycle de vie FIND-003. */
	lifecycle?: Partial<LifecycleConfig> | null;
	/** Instant de référence (tests/preuves) — sinon maintenant. */
	now?: Date;
}

export type TurnoverOutcome = 'created' | 'refreshed' | 'aggravated' | 'improved';

export interface DetectedTurnover {
	fingerprint: string;
	type: typeof NEW_QUERY_TYPE | typeof LOST_QUERY_TYPE;
	/** Clé de variante — l'identité du groupe, jamais affichée telle quelle. */
	variantKey: string;
	/** Terme brut dominant du groupe. */
	label: string;
	variantCount: number;
	clicks: number;
	impressions: number;
	priorityScore: number;
	confidenceScore: number;
	severity: FindingSeverity;
	title: string;
	reason: string;
	findingId: string | null;
	outcome: TurnoverOutcome | null;
}

export interface TurnoverLifecycleReport {
	reconciled: boolean;
	snoozeExpired: number;
	reopened: number;
	autoResolved: number;
	missed: number;
	held: number;
	/** Findings de perte laissés INTACTS parce que le run ne pouvait plus les mesurer. */
	outOfScope: number;
	closureNew: number;
	closureLost: number;
	scopeLost: number;
}

export interface TurnoverDetectorResult {
	detectorVersion: string;
	projectId: string;
	thresholds: TurnoverThresholds;
	windows: TurnoverEvidence['window'];
	/** Semaines distinctes présentes pour le projet. */
	weeksAvailable: number;
	/**
	 * Requêtes distinctes connues sur tout l'historique (base de « nouvelle »).
	 *
	 * `null` quand le run s'est arrêté avant de les compter — jamais `0`. Un projet dont
	 * la fenêtre n'est pas comparable a bel et bien des requêtes ; annoncer zéro serait
	 * la faute que ce détecteur passe son temps à éviter ailleurs.
	 */
	queriesKnown: number | null;
	newQueries: DetectedTurnover[];
	lostQueries: DetectedTurnover[];
	counts: Record<TurnoverOutcome, number>;
	/** Compteurs de ce qui a été REGARDÉ et écarté — jamais des silences. */
	variantOfKnown: number;
	variantSurvived: number;
	returning: number;
	attributedToIndexing: number;
	newBelowThreshold: number;
	lostBelowThreshold: number;
	excludedByNoise: number;
	totalMatchedNew: number;
	totalMatchedLost: number;
	truncatedNew: boolean;
	truncatedLost: boolean;
	/** URLs dont l'état d'indexation a pu être lu (0 = confirmation §10.4 impossible). */
	indexationKnown: number;
	dryRun: boolean;
	skippedReason: string | null;
	lifecycle: TurnoverLifecycleReport;
}

// ── Seuils par projet ───────────────────────────────────────────────

/**
 * Overrides éventuels dans `project_projections.payload`, clé
 * `detectors.query_turnover`. Un payload invalide ne doit JAMAIS faire échouer une
 * détection : toute anomalie retombe silencieusement sur les défauts (même tolérance
 * que `loadDeclineThresholdOverrides`).
 */
export async function loadTurnoverThresholdOverrides(
	db: AppDb,
	projectId: string
): Promise<Partial<TurnoverThresholds> | null> {
	try {
		const row = await db.query.projectProjections.findFirst({
			where: and(
				eq(projectProjections.projectId, projectId),
				eq(projectProjections.status, 'current')
			),
			columns: { payload: true }
		});
		if (!row?.payload) return null;
		const parsed = JSON.parse(row.payload) as {
			detectors?: { query_turnover?: Partial<TurnoverThresholds> };
		};
		return parsed?.detectors?.query_turnover ?? null;
	} catch {
		return null;
	}
}

// ── Fingerprints ────────────────────────────────────────────────────

/**
 * L'identité d'un finding de turnover est le GROUPE de variantes, pas le terme.
 *
 * `entityKey` est donc la clé normalisée : le jour où Google réécrit « coiffeur
 * genève » en « genève coiffeur », le finding reste LE MÊME (acceptation DATA-005 :
 * « le même problème sur deux semaines conserve le même finding »). Prendre le terme
 * brut dominant produirait un nouveau fingerprint à chaque bascule d'orthographe,
 * donc un doublon par réécriture.
 *
 * ⚠️ Les deux types ne partagent jamais de fingerprint (`type` en fait partie) : une
 * requête perdue puis revenue produit une résolution côté perte, pas une découverte
 * côté nouveauté — le gate `firstSeen` s'en charge.
 */
export function turnoverFingerprint(type: string, variantKey: string): string {
	return deriveFindingFingerprint({ type, entityType: 'query', entityKey: variantKey });
}

// ── Durée de vie par requête (première/dernière apparition) ──────────

/**
 * `min(period_start)`, `max(period_start)` et le nombre de semaines distinctes, PAR
 * REQUÊTE, sur TOUT l'historique du projet.
 *
 * Une seule requête groupée, servie par `idx_gsc_qp_obs_project_query`. C'est la
 * seule lecture capable de dire qu'une requête vue dans la fenêtre courante existait
 * déjà il y a six mois — la fenêtre précédente, elle, la déclarerait neuve. Elle rend
 * une ligne par requête distincte (9 577 au maximum du parc, sur `barberconcept`),
 * jamais une par observation.
 */
export async function loadQueryLifespans(db: AppDb, projectId: string): Promise<QueryLifespan[]> {
	const rows = await db
		.select({
			query: gscQueryPageObservations.query,
			firstSeen: sql<string>`min(${gscQueryPageObservations.periodStart})`,
			lastSeen: sql<string>`max(${gscQueryPageObservations.periodStart})`,
			weeksSeen: sql<number>`count(distinct ${gscQueryPageObservations.periodStart})::int`
		})
		.from(gscQueryPageObservations)
		.where(eq(gscQueryPageObservations.projectId, projectId))
		.groupBy(gscQueryPageObservations.query);
	return rows;
}

/**
 * Le dernier état d'indexation connu des pages concernées.
 *
 * ⚠️ `unknown` est le défaut et il est LOAD-BEARING : une page absente de
 * `index_observations` (le cas de tout le parc aujourd'hui) ne doit pas être traitée
 * comme indexée — ce qui supprimerait la confirmation §10.4 — ni comme non indexée —
 * ce qui supprimerait tous les findings de perte. Elle est simplement inconnue, et le
 * module pur en fait un caveat de confiance.
 */
async function loadPageIndexation(
	db: AppDb,
	projectId: string,
	pages: string[],
	now: Date
): Promise<Map<string, PageIndexation>> {
	const out = new Map<string, PageIndexation>();
	if (pages.length === 0) return out;

	const since = new Date(now.getTime() - INDEXATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10);
	const rows = await loadLatestIndexStates({
		db,
		projectId,
		urls: pages.slice(0, MAX_INDEXATION_URLS),
		since,
		limit: MAX_INDEXATION_URLS
	});

	for (const row of rows) {
		// `excluded` (noindex assumé) explique la disparition autant qu'un `not_indexed` :
		// dans les deux cas la page ne peut plus sortir, et le geste attendu n'est pas de
		// travailler la requête. `unknown` reste unknown — il n'informe de rien.
		if (row.indexedClass === 'indexed') out.set(row.url, 'indexed');
		else if (row.indexedClass === 'not_indexed' || row.indexedClass === 'excluded') {
			out.set(row.url, 'not_indexed');
		}
	}
	return out;
}

// ── Partition d'une lecture unique en fenêtres ──────────────────────

/** Les lignes dont la semaine tombe dans la fenêtre. `null` ⇒ liste vide (jamais des zéros). */
function partition(rows: ObservationRow[], window: ObservationWindow | null): ObservationRow[] {
	if (!window) return [];
	return rows.filter((r) => r.periodStart >= window.start && r.periodStart <= window.end);
}

// ── Exécution ───────────────────────────────────────────────────────

export async function runQueryTurnoverDetector(
	input: TurnoverDetectorInput
): Promise<TurnoverDetectorResult> {
	const { db, projectId } = input;
	const dryRun = input.dryRun === true;
	const now = input.now ?? new Date();

	const projectOverrides = await loadTurnoverThresholdOverrides(db, projectId);
	const thresholds = resolveTurnoverThresholds({ ...projectOverrides, ...input.thresholds });

	const lifecycle: TurnoverLifecycleReport = {
		reconciled: false,
		snoozeExpired: 0,
		reopened: 0,
		autoResolved: 0,
		missed: 0,
		held: 0,
		outOfScope: 0,
		closureNew: 0,
		closureLost: 0,
		scopeLost: 0
	};

	// La veille expire AVANT la détection : un finding réveillé est traité par ce run
	// comme n'importe quel autre (rafraîchi s'il matche, compté absent sinon).
	if (!dryRun) {
		const expired = await expireSnoozes({ projectId }, db);
		lifecycle.snoozeExpired = expired.reopened.length;
	}

	const availableWeeks = await loadAvailableWeeks(db, projectId);
	const comparison = buildWindowComparison(availableWeeks, TURNOVER_SPAN);

	const base: TurnoverDetectorResult = {
		detectorVersion: DETECTOR_QUERY_TURNOVER,
		projectId,
		thresholds,
		windows: { current: null, prior: null },
		weeksAvailable: availableWeeks.length,
		queriesKnown: null,
		newQueries: [],
		lostQueries: [],
		counts: { created: 0, refreshed: 0, aggravated: 0, improved: 0 },
		variantOfKnown: 0,
		variantSurvived: 0,
		returning: 0,
		attributedToIndexing: 0,
		newBelowThreshold: 0,
		lostBelowThreshold: 0,
		excludedByNoise: 0,
		totalMatchedNew: 0,
		totalMatchedLost: 0,
		truncatedNew: false,
		truncatedLost: false,
		indexationKnown: 0,
		dryRun,
		skippedReason: null,
		lifecycle
	};

	if (availableWeeks.length === 0) {
		return { ...base, skippedReason: 'aucune observation GSC pour ce projet' };
	}

	// Les fenêtres sont annoncées même quand elles ne sont pas comparables : « voilà ce
	// que j'ai pu construire, et ça ne suffisait pas » est plus utile qu'un `null` muet.
	const windows: TurnoverEvidence['window'] = {
		current: comparison.current,
		prior: comparison.prior
	};

	if (!comparison.comparable || !comparison.current || !comparison.prior) {
		return {
			...base,
			windows,
			skippedReason:
				'aucune fenêtre comparable (historique insuffisant pour comparer deux périodes de même longueur)'
		};
	}

	// UNE lecture pour les deux fenêtres (elles sont contiguës), puis partition —
	// deux requêtes reliraient la même plage en deux morceaux.
	const rows = await loadWindowRows(db, projectId, {
		start: comparison.prior.start,
		end: comparison.current.end,
		weeks: comparison.current.weeks + comparison.prior.weeks
	});
	const currentRows = partition(rows, comparison.current);
	const priorRows = partition(rows, comparison.prior);

	const lifespans = await loadQueryLifespans(db, projectId);

	// L'indexation ne se lit QUE pour les pages de la fenêtre précédente : ce sont les
	// seules dont la disparition est en jeu. Lire tout le parc coûterait une requête
	// bien plus large pour une garde qui ne concerne que les pertes.
	const priorPages = [...new Set(priorRows.map((r) => r.page))];
	const indexation = await loadPageIndexation(db, projectId, priorPages, now);

	const pass = runTurnoverPass({
		currentRows,
		priorRows,
		comparable: comparison.comparable,
		currentWindowStart: comparison.current.start,
		lifespans,
		indexation,
		thresholds
	});

	if (pass.skippedReason) {
		return { ...base, windows, queriesKnown: lifespans.length, skippedReason: pass.skippedReason };
	}

	// La complétude de la fenêtre courante alimente la confiance — la MÊME que celle
	// affichée par `/windows`, calculée contre la même « dernière semaine complète ».
	const latencyDays = await loadGscLatencyDays(db);
	const latestCompleteWeekEnd = weekEndOf(latestCompleteWeekStart(now, latencyDays));
	const completeness: WindowCompleteness = windowCompleteness({
		current: comparison.current,
		expectedWeeks: comparison.weeks,
		latestCompleteWeekEnd
	});
	const weeks = comparison.weeks;

	const known = dryRun ? new Map<string, string>() : await loadKnownSeverities(db, projectId);

	const counts: Record<TurnoverOutcome, number> = {
		created: 0,
		refreshed: 0,
		aggravated: 0,
		improved: 0
	};

	const write = async (unit: TurnoverUnit): Promise<DetectedTurnover> => {
		const type = unit.kind === 'new' ? NEW_QUERY_TYPE : LOST_QUERY_TYPE;
		const score = scoreTurnover(unit, { thresholds, completeness, weeks });
		const priorityScore = computePriorityScore(score);
		const severity = deriveTurnoverSeverity({
			priorityScore,
			impressions: unit.group.side.impressions,
			thresholds,
			confidenceScore: score.confidenceScore,
			emerging: unit.kind === 'new' && unit.confirmation === 'emerging'
		});
		const fingerprint = turnoverFingerprint(type, unit.group.key);
		const title = buildTurnoverTitle(unit);
		const reason = buildTurnoverReason(unit, thresholds);

		const detected: DetectedTurnover = {
			fingerprint,
			type,
			variantKey: unit.group.key,
			label: unit.group.label,
			variantCount: unit.group.members.length,
			clicks: unit.group.side.clicks,
			impressions: unit.group.side.impressions,
			priorityScore,
			confidenceScore: score.confidenceScore,
			severity,
			title,
			reason,
			findingId: null,
			outcome: null
		};

		if (dryRun) return detected;

		const previousSeverity = known.get(fingerprint) ?? null;
		const upserted = await upsertFinding(
			{
				projectId,
				type,
				entityType: 'query',
				entityKey: unit.group.key,
				fingerprint,
				title,
				severity,
				priorityScore,
				confidenceScore: score.confidenceScore,
				impactEstimateJson: JSON.stringify({
					clicks: unit.group.side.clicks,
					clicksPerWeek: unit.group.side.clicks / Math.max(1, weeks),
					impressions: unit.group.side.impressions,
					variants: unit.group.members.length
				}),
				evidenceJson: JSON.stringify(
					buildTurnoverEvidence({ unit, score, window: windows, indexation })
				),
				detectorVersion: DETECTOR_QUERY_TURNOVER,
				recommendedSkill:
					unit.kind === 'new' ? NEW_QUERY_SKILL : lostQuerySkill(unit.pageIndexation),
				runId: input.runId ?? null
			},
			db
		);

		// Un événement seulement quand il y a quelque chose à raconter : création, ou
		// mouvement de sévérité. Une re-détection identique n'enfle pas le journal.
		const severityEvent = previousSeverity
			? deriveSeverityEventType(previousSeverity, severity)
			: null;
		const outcome: TurnoverOutcome = upserted.isNew ? 'created' : (severityEvent ?? 'refreshed');

		if (outcome !== 'refreshed') {
			await recordFindingEvent(
				{
					findingId: upserted.id,
					projectId,
					eventType: upserted.isNew ? 'created' : outcome,
					toStatus: upserted.isNew ? 'open' : null,
					reason,
					actor: 'detector',
					payloadJson: JSON.stringify({
						detector: DETECTOR_QUERY_TURNOVER,
						type,
						priorityScore,
						severity,
						previousSeverity,
						variantKey: unit.group.key
					})
				},
				db
			);
		}

		counts[outcome] += 1;
		return { ...detected, findingId: upserted.id, outcome };
	};

	const newQueries: DetectedTurnover[] = [];
	for (const unit of pass.newQueries.units) newQueries.push(await write(unit));
	const lostQueries: DetectedTurnover[] = [];
	for (const unit of pass.lostQueries.units) lostQueries.push(await write(unit));

	// ── FIND-003 — réconciliation, DEUX closures ─────────────────────
	// Chacune couvre TOUTES les unités franchissant les gates (`matched`), pas
	// seulement celles écrites : une unité absente d'ici a vraiment cessé de matcher,
	// alors qu'une unité absente de `units` peut n'avoir été que tronquée.
	const closureNew = new Set(
		pass.newQueries.matched.map((u) => turnoverFingerprint(NEW_QUERY_TYPE, u.group.key))
	);
	const closureLost = new Set(
		pass.lostQueries.matched.map((u) => turnoverFingerprint(LOST_QUERY_TYPE, u.group.key))
	);
	// La portée des pertes : ce que le run a pu juger. Un groupe encore ABSENT et
	// devenu immesurable (sa fenêtre de référence a glissé) n'y est pas — son finding
	// reste intact plutôt que d'être auto-résolu par manque de mesure.
	const scopeLost = new Set(closureLost);
	for (const key of pass.presentKeys) {
		scopeLost.add(turnoverFingerprint(LOST_QUERY_TYPE, key));
	}

	lifecycle.closureNew = closureNew.size;
	lifecycle.closureLost = closureLost.size;
	lifecycle.scopeLost = scopeLost.size;

	if (!dryRun) {
		const reconciledNew = await reconcileDetectionRun(
			{
				projectId,
				type: NEW_QUERY_TYPE,
				closure: closureNew,
				detectorVersion: DETECTOR_QUERY_TURNOVER,
				runId: input.runId ?? null,
				config: input.lifecycle
			},
			db
		);
		const reconciledLost = await reconcileDetectionRun(
			{
				projectId,
				type: LOST_QUERY_TYPE,
				closure: closureLost,
				scope: scopeLost,
				detectorVersion: DETECTOR_QUERY_TURNOVER,
				runId: input.runId ?? null,
				config: input.lifecycle
			},
			db
		);
		lifecycle.reconciled = true;
		lifecycle.reopened = reconciledNew.reopened + reconciledLost.reopened;
		lifecycle.autoResolved = reconciledNew.autoResolved + reconciledLost.autoResolved;
		lifecycle.missed = reconciledNew.missed + reconciledLost.missed;
		lifecycle.held = reconciledNew.held + reconciledLost.held;
		lifecycle.outOfScope = reconciledNew.outOfScope + reconciledLost.outOfScope;
	}

	return {
		...base,
		windows,
		queriesKnown: lifespans.length,
		newQueries,
		lostQueries,
		counts,
		variantOfKnown: pass.variantOfKnown,
		variantSurvived: pass.variantSurvived,
		returning: pass.returning,
		attributedToIndexing: pass.attributedToIndexing,
		newBelowThreshold: pass.newBelowThreshold,
		lostBelowThreshold: pass.lostBelowThreshold,
		excludedByNoise: pass.excludedByNoise,
		totalMatchedNew: pass.newQueries.totalMatched,
		totalMatchedLost: pass.lostQueries.totalMatched,
		truncatedNew: pass.newQueries.truncated,
		truncatedLost: pass.lostQueries.truncated,
		indexationKnown: indexation.size,
		lifecycle
	};
}

/**
 * Sévérités des findings de ces DEUX types déjà connus du projet, indexées par
 * fingerprint. Une seule requête (pas une par unité) → l'événement de transition se
 * dérive sans relire ligne par ligne. Les fingerprints portent leur type, donc une
 * seule carte suffit sans risque de collision.
 */
async function loadKnownSeverities(db: AppDb, projectId: string): Promise<Map<string, string>> {
	const rows = await db
		.select({ fingerprint: findings.fingerprint, severity: findings.severity })
		.from(findings)
		.where(
			and(eq(findings.projectId, projectId), inArray(findings.type, [NEW_QUERY_TYPE, LOST_QUERY_TYPE]))
		);
	return new Map(rows.map((r) => [r.fingerprint, r.severity]));
}

/** Réexport pratique pour les scripts de preuve (la clé de groupe est une fonction pure). */
export { normalizeQueryKey };
