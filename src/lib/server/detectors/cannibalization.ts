/**
 * FIND-008 — Détecteur `cannibalization` : la LECTURE et l'ÉCRITURE.
 *
 * Le SEUL endroit de ce détecteur qui touche la base. Tout le raisonnement vit dans le
 * module PUR `cannibalization-state.ts` (testé par vitest) : ici on lit des
 * observations, on applique les fonctions pures, on persiste des findings.
 *
 * Le client drizzle est INJECTÉ (`AppDb`) : l'app passe son `db`, les runners
 * `scripts/` passent leur propre Pool.
 *
 * ── Une seule fenêtre, et pourquoi `comparable` n'est PAS un gate ────────────────
 *
 * FIND-005 et FIND-006 comparent deux fenêtres parce qu'ils mesurent un DELTA (une
 * baisse, une apparition, une disparition). La cannibalisation est un ÉTAT : « pour
 * cette requête, Google montre deux de mes pages, et il le fait depuis N semaines ».
 * La persistance se lit DANS la fenêtre, pas entre deux fenêtres.
 *
 * D'où le seul gate d'entrée : la fenêtre doit porter au moins `minOverlapWeeks`
 * semaines, sinon la persistance est structurellement inobservable. Conséquence
 * mesurée et voulue : `spinlink` et `wildcat` (6 semaines d'historique) PRODUISENT ici,
 * là où les deux frères s'arrêtent faute de fenêtre comparable.
 *
 * ── La portée (`scope`) : la MESURABILITÉ, pas la présence ───────────────────────
 *
 * Un conflit dont la requête a disparu de la fenêtre — ou dont le volume est tombé
 * sous le plancher — n'a pas « guéri » : le run ne peut simplement plus dire si le
 * conflit tient. Sortir son fingerprint de la closure sans plus l'auto-résoudrait en
 * deux runs, et « je ne peux plus mesurer » se lirait « c'est réglé ». La disparition
 * d'une requête est déjà le métier de `lost_query` (FIND-006) : elle n'a pas à être
 * racontée deux fois.
 *
 * D'où `scope` = closure ∪ requêtes présentes AU-DESSUS du plancher de volume. Un
 * finding hors portée est laissé **strictement intact** (`consecutive_misses`
 * compris), exactement comme IDX-005 traite une URL qu'il n'a pas inspectée.
 *
 * ⚠️ Mode de défaillance ACCEPTÉ : un conflit sur une requête dont le volume
 * s'effondre durablement reste `open` indéfiniment. Trois atténuations, aucune
 * silencieuse — `lost_query` produit son propre signal si la requête disparaît
 * vraiment, le dismiss humain reste disponible, et la portée le COMPTE
 * (`lifecycle.outOfScope`), donc le gel est visible dans le log du job.
 *
 * ── Ce que ce module ne fait PAS ─────────────────────────────────────────────────
 *
 * ⚠️ Il ne lit **pas** l'état d'indexation des pages (`loadLatestIndexStates`).
 * Tentant — « une page désindexée n'est plus en conflit » — mais faux : Google ne peut
 * pas montrer une page désindexée, donc elle n'a pas d'impressions, donc elle n'est
 * pas significative. La garde est déjà structurelle ; l'ajouter coûterait une requête
 * par run pour zéro effet et un couplage IDX-005 injustifié.
 *
 * ⚠️ Il ne produit **aucune proposition**. `buildProposals` (`proposer-state.ts`) rend
 * `[]` pour tout type autre que `keyword_opportunity` : « merge, redirect et canonical
 * restent L4 » (acceptation FIND-008) n'est pas une consigne à respecter, c'est
 * l'absence d'un chemin d'écriture.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { findings, projectProjections } from '../db/schema.js';
import type { AppDb } from '../db/types.js';
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
import {
	CANNIBALIZATION_SKILL,
	CANNIBALIZATION_TYPE,
	DETECTOR_CANNIBALIZATION,
	buildCannibalizationEvidence,
	buildCannibalizationReason,
	buildCannibalizationTitle,
	deriveCannibalizationSeverity,
	normalizePageUrl,
	resolveCannibalizationThresholds,
	runCannibalizationPass,
	scoreCannibalization,
	urlSetKey,
	type CannibalizationEvidence,
	type CannibalizationThresholds,
	type CannibalizationUnit,
	type ConflictShape
} from './cannibalization-state.js';

/**
 * Fenêtre d'observation : 4 semaines, comme la fenêtre structurelle de FIND-005/006.
 * Assez pour qu'une alternance ait le temps de se produire, assez courte pour qu'un
 * conflit résolu cesse d'être rapporté au run suivant.
 */
export const CANNIBALIZATION_SPAN: WindowSpan = 28;

// ── Contrat d'entrée/sortie (interface versionnée — FIND-001) ───────

export interface CannibalizationDetectorInput {
	db: AppDb;
	projectId: string;
	runId?: string | null;
	/** N'écrit rien : sert à inspecter le plan avant de peupler l'inbox. */
	dryRun?: boolean;
	/** Overrides de seuils explicites (priment sur ceux de la projection projet). */
	thresholds?: Partial<CannibalizationThresholds> | null;
	/** Overrides du cycle de vie FIND-003. */
	lifecycle?: Partial<LifecycleConfig> | null;
	/** Instant de référence (tests/preuves) — sinon maintenant. */
	now?: Date;
}

export type CannibalizationOutcome = 'created' | 'refreshed' | 'aggravated' | 'improved';

export interface DetectedCannibalization {
	fingerprint: string;
	/** Requête BRUTE — l'entité du finding (décision porteuse n°5). */
	query: string;
	shape: ConflictShape;
	probable: boolean;
	urlCount: number;
	/** Les URLs NORMALISÉES en conflit, triées : lisible sans ouvrir les preuves. */
	urls: string[];
	dominance: number;
	switches: number;
	overlapWeeks: number;
	clicks: number;
	impressions: number;
	priorityScore: number;
	confidenceScore: number;
	severity: FindingSeverity;
	title: string;
	reason: string;
	findingId: string | null;
	outcome: CannibalizationOutcome | null;
}

export interface CannibalizationLifecycleReport {
	reconciled: boolean;
	snoozeExpired: number;
	reopened: number;
	autoResolved: number;
	missed: number;
	held: number;
	/** Findings laissés INTACTS parce que le run ne pouvait plus les mesurer. */
	outOfScope: number;
	closure: number;
	scope: number;
}

export interface CannibalizationDetectorResult {
	detectorVersion: string;
	projectId: string;
	thresholds: CannibalizationThresholds;
	window: CannibalizationEvidence['window'];
	/** Semaines distinctes présentes pour le projet. */
	weeksAvailable: number;
	conflicts: DetectedCannibalization[];
	counts: Record<CannibalizationOutcome, number>;
	/** Compteurs de ce qui a été REGARDÉ et écarté — jamais des silences. */
	singleUrl: number;
	belowVolume: number;
	belowPersistence: number;
	replacements: number;
	legitimate: number;
	urlVariantsCollapsed: number;
	suspiciousUrlCount: number;
	excludedByNoise: number;
	totalMatched: number;
	truncated: boolean;
	dryRun: boolean;
	skippedReason: string | null;
	lifecycle: CannibalizationLifecycleReport;
}

// ── Seuils par projet ───────────────────────────────────────────────

/**
 * Overrides éventuels dans `project_projections.payload`, clé
 * `detectors.cannibalization`. Un payload invalide ne doit JAMAIS faire échouer une
 * détection : toute anomalie retombe silencieusement sur les défauts (même tolérance
 * que les deux frères).
 */
export async function loadCannibalizationThresholdOverrides(
	db: AppDb,
	projectId: string
): Promise<Partial<CannibalizationThresholds> | null> {
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
			detectors?: { cannibalization?: Partial<CannibalizationThresholds> };
		};
		return parsed?.detectors?.cannibalization ?? null;
	} catch {
		return null;
	}
}

// ── Fingerprint ─────────────────────────────────────────────────────

/**
 * L'identité d'un conflit est la REQUÊTE, brute, et rien d'autre.
 *
 * ⚠️ Pas l'ensemble des URLs : une URL qui entre ou sort du conflit auto-résoudrait le
 * finding et en créerait un autre, alors que le problème — « Google hésite sur cette
 * requête » — n'a pas changé. L'ensemble d'URLs vit dans les preuves (`urlSetKey`), où
 * il pourra servir à un dédoublonnage futur sans toucher au fingerprint.
 *
 * ⚠️ Pas la clé normalisée de requête non plus (contrairement à FIND-006) : regrouper
 * deux orthographes qui sortent sur deux pages différentes FABRIQUERAIT un conflit.
 */
export function cannibalizationFingerprint(query: string): string {
	return deriveFindingFingerprint({
		type: CANNIBALIZATION_TYPE,
		entityType: 'query',
		entityKey: query
	});
}

// ── Exécution ───────────────────────────────────────────────────────

export async function runCannibalizationDetector(
	input: CannibalizationDetectorInput
): Promise<CannibalizationDetectorResult> {
	const { db, projectId } = input;
	const dryRun = input.dryRun === true;
	const now = input.now ?? new Date();

	const projectOverrides = await loadCannibalizationThresholdOverrides(db, projectId);
	const thresholds = resolveCannibalizationThresholds({
		...projectOverrides,
		...input.thresholds
	});

	const lifecycle: CannibalizationLifecycleReport = {
		reconciled: false,
		snoozeExpired: 0,
		reopened: 0,
		autoResolved: 0,
		missed: 0,
		held: 0,
		outOfScope: 0,
		closure: 0,
		scope: 0
	};

	// La veille expire AVANT la détection : un finding réveillé est traité par ce run
	// comme n'importe quel autre (rafraîchi s'il matche, compté absent sinon).
	if (!dryRun) {
		const expired = await expireSnoozes({ projectId }, db);
		lifecycle.snoozeExpired = expired.reopened.length;
	}

	const availableWeeks = await loadAvailableWeeks(db, projectId);
	const comparison = buildWindowComparison(availableWeeks, CANNIBALIZATION_SPAN);

	const base: CannibalizationDetectorResult = {
		detectorVersion: DETECTOR_CANNIBALIZATION,
		projectId,
		thresholds,
		window: null,
		weeksAvailable: availableWeeks.length,
		conflicts: [],
		counts: { created: 0, refreshed: 0, aggravated: 0, improved: 0 },
		singleUrl: 0,
		belowVolume: 0,
		belowPersistence: 0,
		replacements: 0,
		legitimate: 0,
		urlVariantsCollapsed: 0,
		suspiciousUrlCount: 0,
		excludedByNoise: 0,
		totalMatched: 0,
		truncated: false,
		dryRun,
		skippedReason: null,
		lifecycle
	};

	if (availableWeeks.length === 0) {
		return { ...base, skippedReason: 'aucune observation GSC pour ce projet' };
	}

	// ⚠️ On n'utilise QUE `comparison.current`. `comparison.comparable` n'est PAS un
	// gate ici : la cannibalisation est un état, pas un delta — aucune fenêtre de
	// comparaison n'est requise.
	const current = comparison.current;
	const window: CannibalizationEvidence['window'] = current
		? { start: current.start, end: current.end, weeks: current.weeks }
		: null;

	if (!current) {
		return { ...base, skippedReason: 'aucune fenêtre exploitable' };
	}

	const rows = await loadWindowRows(db, projectId, current);
	// Les semaines RÉELLEMENT présentes, dans l'ordre : c'est la grille sur laquelle le
	// chevauchement et l'alternance se lisent. Les dériver des lignes plutôt que des
	// bornes évite de compter une semaine vide comme une semaine sans conflit.
	const windowWeeks = [...new Set(rows.map((r) => r.periodStart))].sort();

	const pass = runCannibalizationPass({ rows, windowWeeks, thresholds });

	if (pass.skippedReason) {
		return { ...base, window, skippedReason: pass.skippedReason };
	}

	// La complétude de la fenêtre alimente la confiance — la MÊME que celle affichée
	// par `/windows`, calculée contre la même « dernière semaine complète ».
	const latencyDays = await loadGscLatencyDays(db);
	const latestCompleteWeekEnd = weekEndOf(latestCompleteWeekStart(now, latencyDays));
	const completeness: WindowCompleteness = windowCompleteness({
		current,
		expectedWeeks: comparison.weeks,
		latestCompleteWeekEnd
	});
	const weeks = Math.max(1, windowWeeks.length);

	const known = dryRun ? new Map<string, string>() : await loadKnownSeverities(db, projectId);

	const counts: Record<CannibalizationOutcome, number> = {
		created: 0,
		refreshed: 0,
		aggravated: 0,
		improved: 0
	};

	const write = async (unit: CannibalizationUnit): Promise<DetectedCannibalization> => {
		const score = scoreCannibalization(unit, { thresholds, completeness, weeks });
		const priorityScore = computePriorityScore(score);
		const severity = deriveCannibalizationSeverity({
			priorityScore,
			impressions: unit.metrics.queryImpressions,
			thresholds,
			confidenceScore: score.confidenceScore,
			probable: unit.probable,
			urlCount: unit.metrics.urlCount
		});
		const fingerprint = cannibalizationFingerprint(unit.query);
		const title = buildCannibalizationTitle(unit);
		const reason = buildCannibalizationReason(unit, thresholds);

		const detected: DetectedCannibalization = {
			fingerprint,
			query: unit.query,
			shape: unit.shape,
			probable: unit.probable,
			urlCount: unit.metrics.urlCount,
			urls: unit.urls.map((u) => u.url),
			dominance: unit.metrics.dominance,
			switches: unit.metrics.switches,
			overlapWeeks: unit.metrics.overlapWeeks,
			clicks: unit.metrics.conflictClicks,
			impressions: unit.metrics.conflictImpressions,
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
				type: CANNIBALIZATION_TYPE,
				entityType: 'query',
				entityKey: unit.query,
				fingerprint,
				title,
				severity,
				priorityScore,
				confidenceScore: score.confidenceScore,
				impactEstimateJson: JSON.stringify({
					contestedClicks: unit.metrics.conflictClicks * (1 - unit.metrics.dominance),
					contestedClicksPerWeek:
						(unit.metrics.conflictClicks / weeks) * (1 - unit.metrics.dominance),
					conflictImpressions: unit.metrics.conflictImpressions,
					urlCount: unit.metrics.urlCount,
					dominance: unit.metrics.dominance
				}),
				evidenceJson: JSON.stringify(buildCannibalizationEvidence({ unit, score, window })),
				detectorVersion: DETECTOR_CANNIBALIZATION,
				// Skill d'ANALYSE (§10.5). Aucune variante selon la forme : le détecteur ne
				// choisit pas le remède, il désigne celui qui a le droit de le proposer.
				recommendedSkill: CANNIBALIZATION_SKILL,
				runId: input.runId ?? null
			},
			db
		);

		// Un événement seulement quand il y a quelque chose à raconter : création, ou
		// mouvement de sévérité. Une re-détection identique n'enfle pas le journal.
		const severityEvent = previousSeverity
			? deriveSeverityEventType(previousSeverity, severity)
			: null;
		const outcome: CannibalizationOutcome = upserted.isNew
			? 'created'
			: (severityEvent ?? 'refreshed');

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
						detector: DETECTOR_CANNIBALIZATION,
						type: CANNIBALIZATION_TYPE,
						priorityScore,
						severity,
						previousSeverity,
						shape: unit.shape,
						probable: unit.probable,
						urlSetKey: urlSetKey(unit.urls)
					})
				},
				db
			);
		}

		counts[outcome] += 1;
		return { ...detected, findingId: upserted.id, outcome };
	};

	const conflicts: DetectedCannibalization[] = [];
	for (const unit of pass.selection.units) conflicts.push(await write(unit));

	// ── FIND-003 — réconciliation ────────────────────────────────────
	// La closure couvre TOUTES les unités franchissant les gates (`matched`), pas
	// seulement celles écrites : une unité absente d'ici a vraiment cessé de matcher,
	// alors qu'une unité absente de `units` peut n'avoir été que tronquée.
	const closure = new Set(pass.selection.matched.map((u) => cannibalizationFingerprint(u.query)));
	// La portée : ce que le run a pu JUGER. Une requête absente de la fenêtre ou tombée
	// sous le plancher de volume n'y est pas — son finding reste intact plutôt que
	// d'être auto-résolu par manque de mesure.
	const scope = new Set(closure);
	for (const query of pass.measurableQueries) scope.add(cannibalizationFingerprint(query));

	lifecycle.closure = closure.size;
	lifecycle.scope = scope.size;

	if (!dryRun) {
		const reconciled = await reconcileDetectionRun(
			{
				projectId,
				type: CANNIBALIZATION_TYPE,
				closure,
				scope,
				detectorVersion: DETECTOR_CANNIBALIZATION,
				runId: input.runId ?? null,
				config: input.lifecycle
			},
			db
		);
		lifecycle.reconciled = true;
		lifecycle.reopened = reconciled.reopened;
		lifecycle.autoResolved = reconciled.autoResolved;
		lifecycle.missed = reconciled.missed;
		lifecycle.held = reconciled.held;
		lifecycle.outOfScope = reconciled.outOfScope;
	}

	return {
		...base,
		window,
		conflicts,
		counts,
		singleUrl: pass.singleUrl,
		belowVolume: pass.belowVolume,
		belowPersistence: pass.belowPersistence,
		replacements: pass.replacements,
		legitimate: pass.legitimate,
		urlVariantsCollapsed: pass.urlVariantsCollapsed,
		suspiciousUrlCount: pass.suspiciousUrlCount,
		excludedByNoise: pass.excludedByNoise,
		totalMatched: pass.selection.totalMatched,
		truncated: pass.selection.truncated,
		lifecycle
	};
}

/**
 * Sévérités des findings de ce type déjà connus du projet, indexées par fingerprint.
 * Une seule requête (pas une par unité) → l'événement de transition se dérive sans
 * relire ligne par ligne.
 */
async function loadKnownSeverities(db: AppDb, projectId: string): Promise<Map<string, string>> {
	const rows = await db
		.select({ fingerprint: findings.fingerprint, severity: findings.severity })
		.from(findings)
		.where(and(eq(findings.projectId, projectId), inArray(findings.type, [CANNIBALIZATION_TYPE])));
	return new Map(rows.map((r) => [r.fingerprint, r.severity]));
}

/** Réexport pratique pour les scripts de preuve (le repli d'URL est une fonction pure). */
export { normalizePageUrl };
