/**
 * FIND-001/FIND-004 — Détecteur déterministe `keyword_opportunity`.
 *
 * Le SEUL endroit de ce détecteur qui touche la base. Tout le raisonnement vit dans
 * le module PUR `detector-state.ts` (testé par vitest) : ici on lit des observations,
 * on applique les fonctions pures, on persiste des findings.
 *
 * Contrat FIND-001 : un détecteur = (projet, fenêtre, seuils, version) → findings.
 * Rejouable sur un snapshot figé (mêmes observations ⇒ mêmes findings), sans IA
 * dans la boucle (SPEC §3.3 : le FAIT est déterministe, l'agent commente ensuite).
 *
 * Le client drizzle est INJECTÉ : l'app passe son `db`, le runner `scripts/detect.ts`
 * passe son propre Pool (cf. `db/types.ts`).
 *
 * Hors périmètre (assumé) : aucune auto-résolution des findings qui cessent de
 * matcher — le cycle de vie complet (résolution, snooze, réouverture) est FIND-003.
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { findings, gscQueryPageObservations, projectProjections } from '../db/schema.js';
import type { AppDb } from '../db/types.js';
import { upsertFinding, recordFindingEvent } from '../findings.js';
import { computePriorityScore, deriveSeverityEventType } from '../finding-state.js';
import {
	DETECTOR_KEYWORD_OPPORTUNITY,
	KEYWORD_OPPORTUNITY_TYPE,
	KEYWORD_OPPORTUNITY_SKILL,
	aggregateWindow,
	buildOpportunityEvidence,
	buildOpportunityReason,
	buildOpportunityTitle,
	buildWindow,
	deriveOpportunitySeverity,
	resolveThresholds,
	scoreOpportunity,
	selectOpportunities,
	type ObservationRow,
	type ObservationWindow,
	type OpportunityThresholds
} from '../detector-state.js';
import { deriveFindingFingerprint, type FindingSeverity } from '../finding-state.js';

// ── Contrat d'entrée/sortie (interface versionnée — FIND-001) ───────

export interface DetectorInput {
	db: AppDb;
	projectId: string;
	/** Nombre de semaines complètes à couvrir (défaut : `expectedWeeks` des seuils). */
	weeks?: number;
	/** Run collecteur/détecteur pour la traçabilité (`findings.run_id`). */
	runId?: string | null;
	/** N'écrit rien : sert à inspecter le plan avant de peupler l'inbox. */
	dryRun?: boolean;
	/** Overrides de seuils explicites (priment sur ceux de la projection projet). */
	thresholds?: Partial<OpportunityThresholds> | null;
}

/** Un finding produit (ou qui l'aurait été en dry-run). */
export interface DetectedOpportunity {
	fingerprint: string;
	query: string;
	page: string;
	impressions: number;
	clicks: number;
	ctr: number;
	position: number;
	gainEstimate: number;
	priorityScore: number;
	confidenceScore: number;
	severity: FindingSeverity;
	title: string;
	reason: string;
	evidenceJson: string;
	/** null en dry-run ; l'id du finding upserté sinon. */
	findingId: string | null;
	/** 'created' | 'refreshed' | 'aggravated' | 'improved' | null (dry-run). */
	outcome: DetectionOutcome | null;
}

export type DetectionOutcome = 'created' | 'refreshed' | 'aggravated' | 'improved';

export interface DetectorResult {
	detectorVersion: string;
	projectId: string;
	thresholds: OpportunityThresholds;
	window: ObservationWindow | null;
	/** Nombre d'observations lues sur la fenêtre. */
	observationsRead: number;
	/** Couples query×page après agrégation. */
	pairsAggregated: number;
	/** Couples franchissant les seuils AVANT plafond `maxCandidates`. */
	totalMatched: number;
	/** Couples écartés par le bruit configuré (marque/navigationnel). */
	excludedByNoise: number;
	/** Vrai si le plafond `maxCandidates` a tronqué la liste (jamais silencieux). */
	truncated: boolean;
	opportunities: DetectedOpportunity[];
	counts: Record<DetectionOutcome, number>;
	dryRun: boolean;
	/** Raison d'un run sans résultat (fenêtre absente…), sinon null. */
	skippedReason: string | null;
}

// ── Seuils par projet (projection `current`, tolérante à l'absence) ──

/**
 * Lit d'éventuels seuils par projet dans la projection courante
 * (`project_projections.payload`, clé `detectors.keyword_opportunity`). La table
 * est vide aujourd'hui (DATA-002 = expand sans backfill) et un payload invalide
 * ne doit jamais faire échouer une détection : toute anomalie retombe
 * silencieusement sur les défauts.
 */
export async function loadProjectThresholdOverrides(
	db: AppDb,
	projectId: string
): Promise<Partial<OpportunityThresholds> | null> {
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
			detectors?: { keyword_opportunity?: Partial<OpportunityThresholds> };
		};
		return parsed?.detectors?.keyword_opportunity ?? null;
	} catch {
		return null;
	}
}

// ── Fenêtre : les N dernières semaines COMPLÈTES présentes ──────────

async function loadAvailableWeeks(
	db: AppDb,
	projectId: string,
	weeks: number
): Promise<{ periodStart: string; periodEnd: string }[]> {
	const rows = await db
		.selectDistinct({
			periodStart: gscQueryPageObservations.periodStart,
			periodEnd: gscQueryPageObservations.periodEnd
		})
		.from(gscQueryPageObservations)
		.where(eq(gscQueryPageObservations.projectId, projectId))
		.orderBy(desc(gscQueryPageObservations.periodStart))
		.limit(Math.max(1, Math.floor(weeks)));
	return rows;
}

async function loadObservations(
	db: AppDb,
	projectId: string,
	window: ObservationWindow
): Promise<ObservationRow[]> {
	return db
		.select({
			id: gscQueryPageObservations.id,
			query: gscQueryPageObservations.query,
			page: gscQueryPageObservations.page,
			clicks: gscQueryPageObservations.clicks,
			impressions: gscQueryPageObservations.impressions,
			position: gscQueryPageObservations.position,
			periodStart: gscQueryPageObservations.periodStart
		})
		.from(gscQueryPageObservations)
		.where(
			and(
				eq(gscQueryPageObservations.projectId, projectId),
				gte(gscQueryPageObservations.periodStart, window.start),
				lte(gscQueryPageObservations.periodStart, window.end)
			)
		);
}

/**
 * Sévérités des findings de ce type déjà connus du projet, indexées par
 * fingerprint. Une seule requête (pas une par candidat) → sert à dériver
 * l'événement de transition (aggravated/improved) sans relire ligne par ligne.
 */
async function loadKnownSeverities(db: AppDb, projectId: string): Promise<Map<string, string>> {
	const rows = await db
		.select({ fingerprint: findings.fingerprint, severity: findings.severity })
		.from(findings)
		.where(and(eq(findings.projectId, projectId), eq(findings.type, KEYWORD_OPPORTUNITY_TYPE)));
	return new Map(rows.map((r) => [r.fingerprint, r.severity]));
}

// ── Exécution du détecteur ──────────────────────────────────────────

export async function runKeywordOpportunityDetector(
	input: DetectorInput
): Promise<DetectorResult> {
	const { db, projectId } = input;
	const dryRun = input.dryRun === true;

	// Seuils : défauts < projection projet < overrides explicites.
	const projectOverrides = await loadProjectThresholdOverrides(db, projectId);
	const thresholds = resolveThresholds({ ...projectOverrides, ...input.thresholds });
	const weeks = Math.max(1, Math.floor(input.weeks ?? thresholds.expectedWeeks));

	const base: DetectorResult = {
		detectorVersion: DETECTOR_KEYWORD_OPPORTUNITY,
		projectId,
		thresholds,
		window: null,
		observationsRead: 0,
		pairsAggregated: 0,
		totalMatched: 0,
		excludedByNoise: 0,
		truncated: false,
		opportunities: [],
		counts: { created: 0, refreshed: 0, aggravated: 0, improved: 0 },
		dryRun,
		skippedReason: null
	};

	const window = buildWindow(await loadAvailableWeeks(db, projectId, weeks), weeks);
	if (!window) {
		return { ...base, skippedReason: 'aucune observation GSC pour ce projet' };
	}

	const rows = await loadObservations(db, projectId, window);
	if (rows.length === 0) {
		return { ...base, window, skippedReason: 'fenêtre sans observation' };
	}

	const pairs = aggregateWindow(rows);
	const selection = selectOpportunities(pairs, thresholds);
	const known = dryRun ? new Map<string, string>() : await loadKnownSeverities(db, projectId);

	const opportunities: DetectedOpportunity[] = [];
	const counts: Record<DetectionOutcome, number> = {
		created: 0,
		refreshed: 0,
		aggravated: 0,
		improved: 0
	};

	for (const candidate of selection.candidates) {
		const score = scoreOpportunity(candidate, { window, thresholds });
		const priorityScore = computePriorityScore(score);
		const severity = deriveOpportunitySeverity({
			priorityScore,
			impressions: candidate.impressions,
			thresholds,
			confidenceScore: score.confidenceScore
		});
		const fingerprint = deriveFindingFingerprint({
			type: KEYWORD_OPPORTUNITY_TYPE,
			entityType: 'query',
			entityKey: candidate.query,
			discriminators: [candidate.page]
		});
		const evidenceJson = JSON.stringify(
			buildOpportunityEvidence({ candidate, window, score })
		);
		const title = buildOpportunityTitle(candidate);
		const reason = buildOpportunityReason(candidate, thresholds);

		const detected: DetectedOpportunity = {
			fingerprint,
			query: candidate.query,
			page: candidate.page,
			impressions: candidate.impressions,
			clicks: candidate.clicks,
			ctr: candidate.ctr,
			position: candidate.position,
			gainEstimate: candidate.gainEstimate,
			priorityScore,
			confidenceScore: score.confidenceScore,
			severity,
			title,
			reason,
			evidenceJson,
			findingId: null,
			outcome: null
		};

		if (dryRun) {
			opportunities.push(detected);
			continue;
		}

		const previousSeverity = known.get(fingerprint) ?? null;
		const upserted = await upsertFinding(
			{
				projectId,
				type: KEYWORD_OPPORTUNITY_TYPE,
				entityType: 'query',
				entityKey: candidate.query,
				fingerprint,
				title,
				severity,
				priorityScore,
				confidenceScore: score.confidenceScore,
				impactEstimateJson: JSON.stringify({
					gainEstimateClicksPerWeek: candidate.gainEstimate,
					ctrGap: candidate.ctrGap
				}),
				evidenceJson,
				detectorVersion: DETECTOR_KEYWORD_OPPORTUNITY,
				recommendedSkill: KEYWORD_OPPORTUNITY_SKILL,
				runId: input.runId ?? null
			},
			db
		);

		// Un événement seulement quand il y a quelque chose à raconter : création,
		// ou mouvement de sévérité. Une re-détection identique n'enfle pas le journal.
		const severityEvent = previousSeverity
			? deriveSeverityEventType(previousSeverity, severity)
			: null;
		const outcome: DetectionOutcome = upserted.isNew
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
						detector: DETECTOR_KEYWORD_OPPORTUNITY,
						priorityScore,
						severity,
						previousSeverity
					})
				},
				db
			);
		}

		counts[outcome] += 1;
		opportunities.push({ ...detected, findingId: upserted.id, outcome });
	}

	return {
		...base,
		window,
		observationsRead: rows.length,
		pairsAggregated: pairs.length,
		totalMatched: selection.totalMatched,
		excludedByNoise: selection.excludedByNoise,
		truncated: selection.truncated,
		opportunities,
		counts
	};
}

/** Compte les projets ayant au moins une observation GSC (utile au runner `--project=all`). */
export async function listProjectsWithObservations(
	db: AppDb
): Promise<{ projectId: string; observations: number }[]> {
	const rows = await db
		.select({
			projectId: gscQueryPageObservations.projectId,
			observations: sql<number>`count(*)::int`
		})
		.from(gscQueryPageObservations)
		.groupBy(gscQueryPageObservations.projectId);
	return rows;
}
