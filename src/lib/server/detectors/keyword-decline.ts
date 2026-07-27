/**
 * FIND-005 — Détecteur `keyword_decline` : la LECTURE et l'ÉCRITURE.
 *
 * Le SEUL endroit de ce détecteur qui touche la base. Tout le raisonnement vit dans
 * le module PUR `keyword-decline-state.ts` (testé par vitest) : ici on lit des
 * observations, on applique les fonctions pures, on persiste des findings.
 *
 * Le client drizzle est INJECTÉ (`AppDb`) : l'app passe son `db`, les runners
 * `scripts/` passent leur propre Pool.
 *
 * ── Ce qui est réutilisé, et pourquoi ne rien réimplémenter ─────────────────────
 *
 * Le découpage des fenêtres (`buildWindowComparison`), la complétude
 * (`windowCompleteness`) et le gate saisonnier (`computeYoyReport`) viennent de
 * GSC-004 **tels quels**. Recopier ici la règle « 28 j = 4 semaines complètes » ou
 * « une fenêtre incomplète baisse la confiance » créerait une seconde autorité qui
 * divergerait au premier ajustement de latence : l'écran `/windows` dirait « fenêtre
 * à jour » pendant que le détecteur jugerait sur une autre semaine. C'est la même
 * discipline que l'égalité §A de DASH-003.
 *
 * ── Une seule lecture d'observations ────────────────────────────────────────────
 *
 * Les quatre fenêtres (4 sem. courante/précédente, 1 sem. courante/précédente) sont
 * imbriquées : la fenêtre récente est toujours incluse dans la plage structurelle.
 * On lit donc UNE fois la plage la plus large et on partitionne en mémoire — quatre
 * requêtes reliraient trois fois les mêmes lignes.
 */
import { and, eq } from 'drizzle-orm';
import { findings, projectProjections } from '../db/schema.js';
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
import { buildWindowComparison, windowCompleteness, type WindowCompleteness } from '../gsc-windows-state.js';
import { loadAvailableWeeks, loadWindowRows, computeYoyReport } from '../gsc-windows.js';
import { latestCompleteWeekStart, weekEndOf } from '../collectors/gsc-collector-state.js';
import { loadGscLatencyDays } from '../gsc-settings.js';
import {
	DETECTOR_KEYWORD_DECLINE,
	KEYWORD_DECLINE_SKILL,
	KEYWORD_DECLINE_TYPE,
	PRIMARY_SPAN,
	RECENT_SPAN,
	buildDeclineEvidence,
	buildDeclineReason,
	buildDeclineTitle,
	deriveDeclineSeverity,
	resolveDeclineThresholds,
	runDeclinePass,
	scoreDecline,
	seasonalityUnavailable,
	weeklyClickLoss,
	type DeclineEvidence,
	type DeclineThresholds,
	type DeclineUnit,
	type SeasonalityContext
} from './keyword-decline-state.js';

// ── Contrat d'entrée/sortie (interface versionnée — FIND-001) ───────

export interface DeclineDetectorInput {
	db: AppDb;
	projectId: string;
	runId?: string | null;
	/** N'écrit rien : sert à inspecter le plan avant de peupler l'inbox. */
	dryRun?: boolean;
	/** Overrides de seuils explicites (priment sur ceux de la projection projet). */
	thresholds?: Partial<DeclineThresholds> | null;
	/** Overrides du cycle de vie FIND-003. */
	lifecycle?: Partial<LifecycleConfig> | null;
	/** Instant de référence (tests/preuves) — sinon maintenant. */
	now?: Date;
}

export type DeclineOutcome = 'created' | 'refreshed' | 'aggravated' | 'improved';

export interface DetectedDecline {
	fingerprint: string;
	granularity: 'page' | 'query';
	query: string | null;
	page: string;
	confirmation: string;
	clicksLost: number;
	priorityScore: number;
	confidenceScore: number;
	severity: FindingSeverity;
	title: string;
	reason: string;
	findingId: string | null;
	outcome: DeclineOutcome | null;
}

export interface DeclineLifecycleReport {
	reconciled: boolean;
	snoozeExpired: number;
	reopened: number;
	autoResolved: number;
	missed: number;
	held: number;
	closureSize: number;
}

export interface DeclineDetectorResult {
	detectorVersion: string;
	projectId: string;
	thresholds: DeclineThresholds;
	/** Fenêtres réellement utilisées (null quand le span n'était pas comparable). */
	windows: DeclineEvidence['windows'];
	/** Semaines distinctes présentes pour le projet. */
	weeksAvailable: number;
	/** Couples appariés sur la fenêtre porteuse. */
	matchedPairs: number;
	/** Couples présents avant et absents maintenant : hors périmètre (FIND-006). */
	vanished: number;
	appeared: number;
	excludedByNoise: number;
	/** Pages ayant assez de requêtes en baisse mais dont le total ne baisse pas. */
	pagesStable: number;
	groupsFormed: number;
	totalMatched: number;
	truncated: boolean;
	declines: DetectedDecline[];
	counts: Record<DeclineOutcome, number>;
	seasonality: SeasonalityContext;
	dryRun: boolean;
	skippedReason: string | null;
	lifecycle: DeclineLifecycleReport;
}

// ── Seuils par projet ───────────────────────────────────────────────

/**
 * Overrides éventuels dans `project_projections.payload`, clé
 * `detectors.keyword_decline`. Un payload invalide ne doit JAMAIS faire échouer une
 * détection : toute anomalie retombe silencieusement sur les défauts (même
 * tolérance que `loadProjectThresholdOverrides` côté opportunités).
 */
export async function loadDeclineThresholdOverrides(
	db: AppDb,
	projectId: string
): Promise<Partial<DeclineThresholds> | null> {
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
			detectors?: { keyword_decline?: Partial<DeclineThresholds> };
		};
		return parsed?.detectors?.keyword_decline ?? null;
	} catch {
		return null;
	}
}

// ── Fingerprints (une identité par granularité) ─────────────────────

/**
 * Un finding de page et un finding de requête ne partagent JAMAIS de fingerprint :
 * l'`entityType` les sépare. C'est ce qui permet au regroupement d'être réversible
 * — une page qui cesse de décrocher globalement laisse ses requêtes reprendre leur
 * propre identité, et l'agrégat de page s'auto-résout par absence (FIND-003).
 *
 * ⚠️ Le corollaire assumé : la semaine où un groupe se forme, les findings de
 * requête de la même page sortent de la closure et commencent à compter leurs
 * absences. C'est voulu — mais deux vues du même problème ne doivent pas rester
 * ouvertes en parallèle dans l'inbox.
 */
export function declineFingerprint(unit: DeclineUnit): string {
	return unit.kind === 'page'
		? deriveFindingFingerprint({
				type: KEYWORD_DECLINE_TYPE,
				entityType: 'page',
				entityKey: unit.page
			})
		: deriveFindingFingerprint({
				type: KEYWORD_DECLINE_TYPE,
				entityType: 'query',
				entityKey: unit.query,
				discriminators: [unit.page]
			});
}

// ── Partition d'une lecture unique en fenêtres ──────────────────────

/** Les lignes dont la semaine tombe dans la fenêtre. `null` ⇒ liste vide (jamais des zéros). */
function partition(rows: ObservationRow[], window: ObservationWindow | null): ObservationRow[] {
	if (!window) return [];
	return rows.filter((r) => r.periodStart >= window.start && r.periodStart <= window.end);
}

/** La plage minimale couvrant toutes les fenêtres retenues — base de l'unique lecture. */
function spanningWindow(windows: (ObservationWindow | null)[]): ObservationWindow | null {
	const present = windows.filter((w): w is ObservationWindow => w !== null);
	if (present.length === 0) return null;
	return {
		start: present.reduce((min, w) => (w.start < min ? w.start : min), present[0].start),
		end: present.reduce((max, w) => (w.end > max ? w.end : max), present[0].end),
		weeks: present.reduce((sum, w) => sum + w.weeks, 0)
	};
}

// ── Exécution ───────────────────────────────────────────────────────

export async function runKeywordDeclineDetector(
	input: DeclineDetectorInput
): Promise<DeclineDetectorResult> {
	const { db, projectId } = input;
	const dryRun = input.dryRun === true;

	const projectOverrides = await loadDeclineThresholdOverrides(db, projectId);
	const thresholds = resolveDeclineThresholds({ ...projectOverrides, ...input.thresholds });

	const lifecycle: DeclineLifecycleReport = {
		reconciled: false,
		snoozeExpired: 0,
		reopened: 0,
		autoResolved: 0,
		missed: 0,
		held: 0,
		closureSize: 0
	};

	// La veille expire AVANT la détection : un finding réveillé est traité par ce run
	// comme n'importe quel autre (rafraîchi s'il matche, compté absent sinon).
	if (!dryRun) {
		const expired = await expireSnoozes({ projectId }, db);
		lifecycle.snoozeExpired = expired.reopened.length;
	}

	const availableWeeks = await loadAvailableWeeks(db, projectId);
	const primary = buildWindowComparison(availableWeeks, PRIMARY_SPAN);
	const recent = buildWindowComparison(availableWeeks, RECENT_SPAN);

	const seasonalityReport = await computeYoyReport({
		db,
		projectId,
		span: PRIMARY_SPAN,
		availableWeeks
	});
	const seasonality: SeasonalityContext = seasonalityReport.available
		? {
				available: true,
				span: PRIMARY_SPAN,
				window: { start: primary.current?.start ?? '', end: primary.current?.end ?? '' }
			}
		: seasonalityUnavailable(seasonalityReport.reason);

	const base: DeclineDetectorResult = {
		detectorVersion: DETECTOR_KEYWORD_DECLINE,
		projectId,
		thresholds,
		windows: { primary: null, recent: null },
		weeksAvailable: availableWeeks.length,
		matchedPairs: 0,
		vanished: 0,
		appeared: 0,
		excludedByNoise: 0,
		pagesStable: 0,
		groupsFormed: 0,
		totalMatched: 0,
		truncated: false,
		declines: [],
		counts: { created: 0, refreshed: 0, aggravated: 0, improved: 0 },
		seasonality,
		dryRun,
		skippedReason: null,
		lifecycle
	};

	if (availableWeeks.length === 0) {
		return { ...base, skippedReason: 'aucune observation GSC pour ce projet' };
	}

	// UNE lecture pour les quatre fenêtres (elles sont imbriquées), puis partition.
	const range = spanningWindow([primary.current, primary.prior, recent.current, recent.prior]);
	const rows = range ? await loadWindowRows(db, projectId, range) : [];

	const pass = runDeclinePass({
		primaryCurrentRows: partition(rows, primary.current),
		primaryPriorRows: partition(rows, primary.prior),
		primaryComparable: primary.comparable,
		recentCurrentRows: partition(rows, recent.current),
		recentPriorRows: partition(rows, recent.prior),
		recentComparable: recent.comparable,
		thresholds
	});

	const windows: DeclineEvidence['windows'] = {
		primary:
			primary.comparable && primary.current && primary.prior
				? { span: PRIMARY_SPAN, weeks: primary.weeks, current: primary.current, prior: primary.prior }
				: null,
		recent:
			recent.comparable && recent.current && recent.prior
				? { span: RECENT_SPAN, weeks: recent.weeks, current: recent.current, prior: recent.prior }
				: null
	};

	if (pass.skippedReason) {
		return { ...base, windows, skippedReason: pass.skippedReason };
	}

	// La fenêtre PORTEUSE : le 4 semaines quand il est comparable, sinon le 1 semaine.
	// Sa complétude est celle qui alimente la confiance — la même que celle affichée
	// par `/windows`, calculée contre la même « dernière semaine complète ».
	const latencyDays = await loadGscLatencyDays(db);
	const latestCompleteWeekEnd = weekEndOf(
		latestCompleteWeekStart(input.now ?? new Date(), latencyDays)
	);
	const carrier = primary.comparable ? primary : recent;
	const completeness: WindowCompleteness = windowCompleteness({
		current: carrier.current,
		expectedWeeks: carrier.weeks,
		latestCompleteWeekEnd
	});
	const weeks = carrier.weeks;

	const known = dryRun ? new Map<string, string>() : await loadKnownSeverities(db, projectId);

	const declines: DetectedDecline[] = [];
	const counts: Record<DeclineOutcome, number> = {
		created: 0,
		refreshed: 0,
		aggravated: 0,
		improved: 0
	};

	for (const unit of pass.selection.units) {
		const score = scoreDecline(unit, { thresholds, completeness, weeks, seasonality });
		const priorityScore = computePriorityScore(score);
		const severity = deriveDeclineSeverity({
			priorityScore,
			priorImpressions: unit.delta.prior.impressions,
			thresholds,
			confidenceScore: score.confidenceScore,
			confirmation: unit.confirmation
		});
		const fingerprint = declineFingerprint(unit);
		const evidenceJson = JSON.stringify(
			buildDeclineEvidence({ unit, score, weeks, windows, seasonality })
		);
		const title = buildDeclineTitle(unit);
		const reason = buildDeclineReason(unit, thresholds);
		const clicksLost = Math.max(0, -unit.delta.clicksAbs);

		const detected: DetectedDecline = {
			fingerprint,
			granularity: unit.kind,
			query: unit.kind === 'query' ? unit.query : null,
			page: unit.page,
			confirmation: unit.confirmation,
			clicksLost,
			priorityScore,
			confidenceScore: score.confidenceScore,
			severity,
			title,
			reason,
			findingId: null,
			outcome: null
		};

		if (dryRun) {
			declines.push(detected);
			continue;
		}

		const previousSeverity = known.get(fingerprint) ?? null;
		const upserted = await upsertFinding(
			{
				projectId,
				type: KEYWORD_DECLINE_TYPE,
				entityType: unit.kind === 'page' ? 'page' : 'query',
				entityKey: unit.kind === 'page' ? unit.page : unit.query,
				fingerprint,
				title,
				severity,
				priorityScore,
				confidenceScore: score.confidenceScore,
				impactEstimateJson: JSON.stringify({
					clicksLost,
					clicksLostPerWeek: weeklyClickLoss(unit.delta, weeks),
					impressionsLost: Math.max(0, -unit.delta.impressionsAbs),
					positionLost: Math.max(0, unit.delta.positionAbs)
				}),
				evidenceJson,
				detectorVersion: DETECTOR_KEYWORD_DECLINE,
				recommendedSkill: KEYWORD_DECLINE_SKILL,
				runId: input.runId ?? null
			},
			db
		);

		// Un événement seulement quand il y a quelque chose à raconter : création, ou
		// mouvement de sévérité. Une re-détection identique n'enfle pas le journal.
		const severityEvent = previousSeverity
			? deriveSeverityEventType(previousSeverity, severity)
			: null;
		const outcome: DeclineOutcome = upserted.isNew ? 'created' : (severityEvent ?? 'refreshed');

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
						detector: DETECTOR_KEYWORD_DECLINE,
						priorityScore,
						severity,
						previousSeverity,
						confirmation: unit.confirmation
					})
				},
				db
			);
		}

		counts[outcome] += 1;
		declines.push({ ...detected, findingId: upserted.id, outcome });
	}

	// ── FIND-003 — réconciliation ────────────────────────────────────
	// La closure couvre TOUTES les unités franchissant les seuils (`matched`), pas
	// seulement celles écrites : une unité absente d'ici a vraiment cessé de baisser,
	// alors qu'une unité absente de `units` peut n'avoir été que tronquée.
	//
	// PAS de `scope` ici, contrairement à IDX-005 : un détecteur GSC est autoritaire
	// sur tout son projet — chaque requête est réobservée chaque semaine, donc une
	// absence de la closure est une vraie absence de signal. C'est aussi ce qui donne
	// l'acceptation « une récupération résout le finding » sans une ligne de plus.
	const closure = new Set(pass.selection.matched.map(declineFingerprint));
	lifecycle.closureSize = closure.size;

	if (!dryRun) {
		const reconciled = await reconcileDetectionRun(
			{
				projectId,
				type: KEYWORD_DECLINE_TYPE,
				closure,
				detectorVersion: DETECTOR_KEYWORD_DECLINE,
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
	}

	return {
		...base,
		windows,
		matchedPairs: pass.matchedPairs,
		vanished: pass.vanished,
		appeared: pass.appeared,
		excludedByNoise: pass.excludedByNoise,
		pagesStable: pass.pagesStable,
		groupsFormed: pass.selection.groupsFormed,
		totalMatched: pass.selection.totalMatched,
		truncated: pass.selection.truncated,
		declines,
		counts,
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
		.where(and(eq(findings.projectId, projectId), eq(findings.type, KEYWORD_DECLINE_TYPE)));
	return new Map(rows.map((r) => [r.fingerprint, r.severity]));
}
