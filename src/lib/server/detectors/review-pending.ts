/**
 * GMB-002 lot 2 — Détecteur déterministe des avis sans réponse.
 *
 * Le SEUL endroit de ce détecteur qui touche la base. Tout le raisonnement vit dans le module PUR
 * `review-pending-state.ts` (testé par vitest) : ici on lit des avis, on applique les fonctions
 * pures, on persiste des findings.
 *
 * Contrat FIND-001 : un détecteur = (projet, fenêtre, seuils, version) → findings. Le client
 * drizzle est INJECTÉ : l'app passe son `db`, le runner `scripts/detect-reviews.ts` passe son
 * propre Pool.
 *
 * ⚠️ **Ce détecteur n'est PAS autoritaire sur tout son projet**, comme IDX-005 et pour une raison
 * voisine : il ne peut juger que les avis d'une fiche dont la synchro a RÉUSSI et est RÉCENTE. Une
 * fiche en panne depuis avril n'est pas une fiche sans arriéré, c'est une fiche qu'on ne voit plus.
 * D'où le `scope` passé à `reconcileDetectionRun` — sans lui, deux runs sur une fiche cassée
 * auto-résoudraient tout son arriéré.
 *
 * ⚠️ **`pendingReviewFilter()` est la seule définition de « en attente »** et n'est jamais
 * réécrite : un détecteur qui poserait son propre SQL finirait par juger un état différent de celui
 * que `/projects/[slug]/reviews` affiche, et les deux se contrediraient sans arbitre.
 */
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { findings, gmbReviews, projectGmbLocations, projectProjections } from '../db/schema.js';
import type { AppDb } from '../db/types.js';
import {
	upsertFinding,
	recordFindingEvent,
	expireSnoozes,
	reconcileDetectionRun
} from '../findings.js';
import { deriveSeverityEventType, type LifecycleConfig } from '../finding-state.js';
import { pendingReviewFilter } from '../reviews/pending-filter.js';
import {
	DETECTOR_REVIEW_PENDING,
	NEGATIVE_REVIEW_TYPE,
	REVIEW_PENDING_SLA_TYPE,
	REVIEW_PENDING_TYPES,
	REVIEW_ENTITY_TYPE,
	buildReviewEvidence,
	buildReviewReason,
	buildReviewTitle,
	decideLocationScope,
	resolveReviewPendingThresholds,
	reviewSinceBound,
	reviewSkill,
	runReviewPendingPass,
	type LocationBacklog,
	type LocationHealth,
	type ReviewFindingType,
	type ReviewPendingThresholds,
	type ReviewRow,
	type ReviewUnit
} from './review-pending-state.js';

// ── Contrat d'entrée/sortie ─────────────────────────────────────────

export interface ReviewPendingDetectorInput {
	db: AppDb;
	projectId: string;
	/** Instant de référence — passé explicitement pour rester rejouable. */
	now?: Date;
	/** Run collecteur/détecteur pour la traçabilité (`findings.run_id`). */
	runId?: string | null;
	/** N'écrit rien : sert à inspecter le plan avant de peupler l'inbox. */
	dryRun?: boolean;
	/** Overrides explicites (priment sur ceux de la projection projet). */
	thresholds?: Partial<ReviewPendingThresholds> | null;
	/** Overrides du cycle de vie FIND-003. */
	lifecycle?: Partial<LifecycleConfig> | null;
}

export type ReviewOutcome = 'created' | 'refreshed' | 'aggravated' | 'improved';

/** Un finding produit (ou qui l'aurait été en dry-run). */
export interface DetectedReview {
	fingerprint: string;
	type: ReviewFindingType;
	reviewId: string;
	locationId: string;
	locationLabel: string;
	rating: number;
	ageDays: number;
	overdueBy: number;
	priorityScore: number;
	confidenceScore: number;
	severity: string;
	/** SPEC §14.3 — le signal ; le canal est TEL-002. */
	notifyImmediately: boolean;
	title: string;
	reason: string;
	evidenceJson: string;
	findingId: string | null;
	outcome: ReviewOutcome | null;
}

/** FIND-003 — ce que le cycle de vie a bougé pendant ce run, les deux types cumulés. */
export interface ReviewLifecycleReport {
	reconciled: boolean;
	snoozeExpired: number;
	reopened: number;
	autoResolved: number;
	missed: number;
	held: number;
	/**
	 * Findings d'avis qu'aucune observation de ce run n'a couverts — ni redétectés, ni comptés
	 * absents. Ce chiffre porte deux faits distincts et tous deux attendus : une fiche dont la
	 * synchro est cassée, et un avis sorti de la fenêtre. Le taire ferait lire un run silencieux
	 * comme un run propre.
	 */
	outOfScope: number;
	closureSla: number;
	closureNegative: number;
	scopeSla: number;
	scopeNegative: number;
}

export interface ReviewPendingResult {
	detectorVersion: string;
	projectId: string;
	thresholds: ReviewPendingThresholds;
	window: { since: string; now: string } | null;
	/** Avis lus sur la fenêtre (les deux fenêtres cumulées, une seule requête). */
	reviewsRead: number;
	locationsFresh: number;
	locationsStale: number;
	/** Avis dans la portée, par type. */
	inScopeSla: number;
	inScopeNegative: number;
	/** Signaux franchissant les seuils AVANT plafond, par type. */
	totalMatchedSla: number;
	totalMatchedNegative: number;
	/** Vrai si le plafond a tronqué l'un des deux lots — jamais silencieux. */
	truncated: boolean;
	/** Ce que le run a écarté, nommé : chaque exclusion est un fait, pas un silence. */
	excluded: {
		staleLocation: number;
		neverSeen: number;
		vanished: number;
		outOfWindow: number;
		answered: number;
		divergent: number;
		unreadableRating: number;
		unreadableCreateTime: number;
	};
	reviews: DetectedReview[];
	counts: Record<ReviewOutcome, number>;
	/** Findings marqués notifiables (§14.3) — le canal reste TEL-002. */
	notifiable: number;
	dryRun: boolean;
	/** Raison d'un run sans résultat (aucune fiche, aucune fiche fraîche, aucun avis), sinon null. */
	skippedReason: string | null;
	lifecycle: ReviewLifecycleReport;
}

// ── Seuils par projet (projection `current`, tolérante à l'absence) ──

/**
 * Lit d'éventuels réglages par projet dans la projection courante
 * (`project_projections.payload`, clé `detectors.review_pending`). Un payload invalide ne doit
 * jamais faire échouer une détection : toute anomalie retombe silencieusement sur les défauts.
 */
export async function loadReviewPendingOverrides(
	db: AppDb,
	projectId: string
): Promise<Partial<ReviewPendingThresholds> | null> {
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
			detectors?: { review_pending?: Partial<ReviewPendingThresholds> };
		};
		return parsed?.detectors?.review_pending ?? null;
	} catch {
		return null;
	}
}

// ── Lectures ────────────────────────────────────────────────────────

/** La santé de synchro des fiches du projet : elle porte la portée du run. */
async function loadLocationHealth(db: AppDb, projectId: string): Promise<LocationHealth[]> {
	const rows = await db
		.select({
			locationId: projectGmbLocations.gmbLocationId,
			label: projectGmbLocations.label,
			lastSyncAt: projectGmbLocations.lastSyncAt,
			lastSyncStatus: projectGmbLocations.lastSyncStatus
		})
		.from(projectGmbLocations)
		.where(eq(projectGmbLocations.projectId, projectId));
	return rows;
}

/**
 * Les avis de la fenêtre, joints à leur fiche.
 *
 * ⚠️ La borne est une DATE NUE, jamais un horodatage : `create_time` est en ISO alors que le reste
 * du schéma est au format DB, et la seule comparaison lexicale sûre entre les deux est celle de
 * leur préfixe commun (cf. `reviewSinceBound`). Ce n'est qu'un PRÉ-FILTRE bon marché — le jugement
 * d'âge est refait en mémoire par `parseReviewCreateTime`, qui accepte les deux formes.
 *
 * Une seule requête pour les deux types : la portée a besoin des avis DÉJÀ RÉPONDUS (c'est ce qui
 * permet l'auto-résolution), qu'un filtre sur la note ou sur `pendingReviewFilter()` écarterait.
 */
async function loadReviewRows(input: {
	db: AppDb;
	projectId: string;
	since: string;
}): Promise<ReviewRow[]> {
	const rows = await input.db
		.select({
			reviewId: gmbReviews.reviewId,
			locationId: gmbReviews.locationId,
			locationLabel: gmbReviews.locationLabel,
			rating: gmbReviews.rating,
			createTime: gmbReviews.createTime,
			repliedAt: gmbReviews.repliedAt,
			remoteReplyAt: gmbReviews.remoteReplyAt,
			lastSeenAt: gmbReviews.lastSeenAt,
			hasDraft: sql<boolean>`${gmbReviews.draftReply} is not null`
		})
		.from(gmbReviews)
		.innerJoin(
			projectGmbLocations,
			and(
				eq(projectGmbLocations.projectId, gmbReviews.projectId),
				eq(projectGmbLocations.gmbLocationId, gmbReviews.locationId)
			)
		)
		.where(and(eq(gmbReviews.projectId, input.projectId), gte(gmbReviews.createTime, input.since)));

	return rows.map((r) => ({ ...r, hasDraft: r.hasDraft === true }));
}

/**
 * L'arriéré par fiche, sur TOUT l'historique — délibérément non borné dans le temps.
 *
 * La requête des avis ne voit pas les 332 avis d'avant 2025 ; calculer la part d'arriéré sur ses
 * lignes la rendrait fausse, alors que c'est précisément ce chiffre qui distingue une fiche tenue
 * (Lausanne, 1/302) d'une fiche abandonnée (Eaux Vives, 190/541).
 *
 * Le prédicat vient de `pendingReviewFilter()` — jamais réécrit ici.
 */
async function loadLocationBacklog(db: AppDb, projectId: string): Promise<LocationBacklog[]> {
	return db
		.select({
			locationId: gmbReviews.locationId,
			total: sql<number>`count(*)::int`,
			pending: sql<number>`count(*) filter (where ${pendingReviewFilter()})::int`
		})
		.from(gmbReviews)
		.where(eq(gmbReviews.projectId, projectId))
		.groupBy(gmbReviews.locationId);
}

/**
 * Sévérités des findings d'avis déjà connus du projet, indexées par fingerprint. Les deux types en
 * une seule requête : le fingerprint porte déjà le type, donc aucune collision possible.
 */
async function loadKnownSeverities(db: AppDb, projectId: string): Promise<Map<string, string>> {
	const rows = await db
		.select({ fingerprint: findings.fingerprint, severity: findings.severity })
		.from(findings)
		.where(
			and(eq(findings.projectId, projectId), inArray(findings.type, [...REVIEW_PENDING_TYPES]))
		);
	return new Map(rows.map((r) => [r.fingerprint, r.severity]));
}

// ── Exécution du détecteur ──────────────────────────────────────────

export async function runReviewPendingDetector(
	input: ReviewPendingDetectorInput
): Promise<ReviewPendingResult> {
	const { db, projectId } = input;
	const dryRun = input.dryRun === true;
	const now = input.now ?? new Date();

	const projectOverrides = await loadReviewPendingOverrides(db, projectId);
	const thresholds = resolveReviewPendingThresholds({ ...projectOverrides, ...input.thresholds });

	const lifecycle: ReviewLifecycleReport = {
		reconciled: false,
		snoozeExpired: 0,
		reopened: 0,
		autoResolved: 0,
		missed: 0,
		held: 0,
		outOfScope: 0,
		closureSla: 0,
		closureNegative: 0,
		scopeSla: 0,
		scopeNegative: 0
	};

	const base: ReviewPendingResult = {
		detectorVersion: DETECTOR_REVIEW_PENDING,
		projectId,
		thresholds,
		window: null,
		reviewsRead: 0,
		locationsFresh: 0,
		locationsStale: 0,
		inScopeSla: 0,
		inScopeNegative: 0,
		totalMatchedSla: 0,
		totalMatchedNegative: 0,
		truncated: false,
		excluded: {
			staleLocation: 0,
			neverSeen: 0,
			vanished: 0,
			outOfWindow: 0,
			answered: 0,
			divergent: 0,
			unreadableRating: 0,
			unreadableCreateTime: 0
		},
		reviews: [],
		counts: { created: 0, refreshed: 0, aggravated: 0, improved: 0 },
		notifiable: 0,
		dryRun,
		skippedReason: null,
		lifecycle
	};

	// La veille expire AVANT la détection : un finding réveillé est traité par ce run comme
	// n'importe quel autre (rafraîchi s'il matche, hors portée sinon).
	if (!dryRun) {
		const expired = await expireSnoozes({ projectId }, db);
		lifecycle.snoozeExpired = expired.reopened.length;
	}

	// ── Trois sorties NOMMÉES, aucune réconciliation ─────────────────
	// Un run qui ne sait rien ne doit rien conclure : sans données, une absence ne prouve pas une
	// guérison. Chaque sortie porte son motif, donc un job qui « ne fait rien » reste lisible.

	const locations = await loadLocationHealth(db, projectId);
	if (locations.length === 0) {
		// Cinq projets sur neuf sont dans ce cas : le job RÉUSSIT, il ne se tait pas.
		return { ...base, skippedReason: 'no_gmb_location' };
	}

	const nowMs = now.getTime();
	const freshCount = locations.filter(
		(l) =>
			decideLocationScope({
				health: l,
				nowMs,
				freshnessHours: thresholds.syncFreshnessHours
			}).fresh
	).length;
	base.locationsFresh = freshCount;
	base.locationsStale = locations.length - freshCount;
	if (freshCount === 0) {
		return {
			...base,
			skippedReason: 'no_fresh_gmb_location',
			locationsFresh: 0,
			locationsStale: locations.length
		};
	}

	// La borne SQL couvre la PLUS LARGE des deux fenêtres : une seule lecture sert les deux types.
	const lookback = Math.max(thresholds.slaLookbackDays, thresholds.negativeLookbackDays);
	const since = reviewSinceBound(now, lookback);
	const rows = await loadReviewRows({ db, projectId, since });
	if (rows.length === 0) {
		return {
			...base,
			window: { since, now: now.toISOString() },
			skippedReason: 'no_reviews_in_scope'
		};
	}

	const backlog = await loadLocationBacklog(db, projectId);
	const p = runReviewPendingPass({ reviews: rows, locations, backlog, thresholds, now });

	const known = dryRun ? new Map<string, string>() : await loadKnownSeverities(db, projectId);
	const counts: Record<ReviewOutcome, number> = {
		created: 0,
		refreshed: 0,
		aggravated: 0,
		improved: 0
	};
	const detected: DetectedReview[] = [];

	for (const unit of [...p.sla.units, ...p.negative.units]) {
		const evidenceJson = JSON.stringify(buildReviewEvidence({ unit, thresholds }));
		const title = buildReviewTitle(unit);
		const reason = buildReviewReason(unit, thresholds);
		const row: DetectedReview = {
			fingerprint: unit.fingerprint,
			type: unit.type,
			reviewId: unit.reviewId,
			locationId: unit.locationId,
			locationLabel: unit.locationLabel,
			rating: unit.rating,
			ageDays: unit.ageDays,
			overdueBy: unit.overdueBy,
			priorityScore: unit.priorityScore,
			confidenceScore: unit.confidenceScore,
			severity: unit.severity,
			notifyImmediately: unit.notifyImmediately,
			title,
			reason,
			evidenceJson,
			findingId: null,
			outcome: null
		};

		if (dryRun) {
			detected.push(row);
			continue;
		}

		const previousSeverity = known.get(unit.fingerprint) ?? null;
		const upserted = await upsertFinding(
			{
				projectId,
				type: unit.type,
				entityType: REVIEW_ENTITY_TYPE,
				entityKey: unit.reviewId,
				fingerprint: unit.fingerprint,
				title,
				severity: unit.severity,
				priorityScore: unit.priorityScore,
				confidenceScore: unit.confidenceScore,
				impactEstimateJson: JSON.stringify({
					rating: unit.rating,
					ageDays: unit.ageDays,
					overdueBy: unit.overdueBy,
					locationShare: Math.round(unit.backlog.share * 1000) / 1000,
					notifyImmediately: unit.notifyImmediately
				}),
				evidenceJson,
				detectorVersion: DETECTOR_REVIEW_PENDING,
				// §10.4 : le SLA route vers un skill, l'avis négatif vers une escalade HUMAINE.
				recommendedSkill: reviewSkill(unit.type),
				runId: input.runId ?? null
			},
			db
		);

		// Un événement seulement quand il y a quelque chose à raconter : création, ou mouvement de
		// sévérité. Un avis toujours sans réponse ne produit qu'UN seul `created`, même redétecté
		// chaque jour.
		const severityEvent = previousSeverity
			? deriveSeverityEventType(previousSeverity, unit.severity)
			: null;
		const outcome: ReviewOutcome = upserted.isNew ? 'created' : (severityEvent ?? 'refreshed');

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
						detector: DETECTOR_REVIEW_PENDING,
						type: unit.type,
						priorityScore: unit.priorityScore,
						severity: unit.severity,
						previousSeverity,
						locationId: unit.locationId,
						notifyImmediately: unit.notifyImmediately
					})
				},
				db
			);
		}

		counts[outcome] += 1;
		detected.push({ ...row, findingId: upserted.id, outcome });
	}

	lifecycle.closureSla = p.sla.totalMatched;
	lifecycle.closureNegative = p.negative.totalMatched;
	lifecycle.scopeSla = p.scopeSla.size;
	lifecycle.scopeNegative = p.scopeNegative.size;

	// ── FIND-003 — réconciliation, UNE PASSE PAR TYPE ────────────────
	// Chaque type porte SA closure et SON scope : les deux fenêtres diffèrent, donc un avis peut
	// être hors portée pour l'un et dedans pour l'autre. Les mélanger auto-résoudrait un
	// `negative_review` de 200 jours au seul motif qu'il est sorti de la fenêtre SLA.
	if (!dryRun) {
		const passes: { type: ReviewFindingType; closure: Set<string>; scope: Set<string> }[] = [
			{
				type: REVIEW_PENDING_SLA_TYPE,
				closure: new Set(p.sla.matched.map((u) => u.fingerprint)),
				scope: p.scopeSla
			},
			{
				type: NEGATIVE_REVIEW_TYPE,
				closure: new Set(p.negative.matched.map((u) => u.fingerprint)),
				scope: p.scopeNegative
			}
		];
		for (const item of passes) {
			const reconciled = await reconcileDetectionRun(
				{
					projectId,
					type: item.type,
					// La closure porte TOUT ce qui franchit les seuils, pas seulement ce qu'on écrit :
					// un finding absent d'une closure tronquée passerait pour guéri (leçon FIND-003).
					closure: item.closure,
					scope: item.scope,
					detectorVersion: DETECTOR_REVIEW_PENDING,
					runId: input.runId ?? null,
					config: input.lifecycle
				},
				db
			);
			lifecycle.reopened += reconciled.reopened;
			lifecycle.autoResolved += reconciled.autoResolved;
			lifecycle.missed += reconciled.missed;
			lifecycle.held += reconciled.held;
			lifecycle.outOfScope += reconciled.outOfScope;
		}
		lifecycle.reconciled = true;
	}

	return {
		...base,
		window: { since, now: now.toISOString() },
		reviewsRead: p.reviewsRead,
		locationsFresh: p.locationsFresh,
		locationsStale: p.locationsStale,
		inScopeSla: p.inScopeSla,
		inScopeNegative: p.inScopeNegative,
		totalMatchedSla: p.sla.totalMatched,
		totalMatchedNegative: p.negative.totalMatched,
		truncated: p.sla.truncated || p.negative.truncated,
		excluded: {
			staleLocation: p.staleLocation,
			neverSeen: p.neverSeen,
			vanished: p.vanished,
			outOfWindow: p.outOfWindow,
			answered: p.answered,
			divergent: p.divergent,
			unreadableRating: p.unreadableRating,
			unreadableCreateTime: p.unreadableCreateTime
		},
		// Rendu en ordre de PRIORITÉ, tous types confondus. Concaténer « les SLA puis les négatifs »
		// ferait passer le 2★ de Sion derrière douze 5★ oubliés : le lecteur (CLI, log, futur écran)
		// verrait d'abord le lot le plus nombreux, jamais le plus grave.
		reviews: [...detected].sort((a, b) =>
			b.priorityScore !== a.priorityScore
				? b.priorityScore - a.priorityScore
				: a.fingerprint < b.fingerprint
					? -1
					: a.fingerprint > b.fingerprint
						? 1
						: 0
		),
		counts,
		notifiable: detected.filter((d) => d.notifyImmediately).length,
		lifecycle
	};
}

/** Projets ayant au moins une fiche GMB déclarée (utile au runner `--project=all`). */
export async function listProjectsWithGmbLocations(
	db: AppDb
): Promise<{ projectId: string; locations: number }[]> {
	return db
		.select({
			projectId: projectGmbLocations.projectId,
			locations: sql<number>`count(*)::int`
		})
		.from(projectGmbLocations)
		.groupBy(projectGmbLocations.projectId);
}
