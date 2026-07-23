/**
 * DATA-005 / FIND-003 — Écriture de findings (upsert idempotent, journal
 * append-only, cycle de vie).
 *
 * - `upsertFinding` vise l'unique `(project_id, fingerprint)` : le même problème
 *   redétecté ne crée JAMAIS un doublon, il incrémente `occurrence_count` et
 *   rafraîchit `last_seen_at` + les scores/preuves (acceptation « même problème sur
 *   deux semaines = même finding »). `first_seen_at` est préservé.
 * - `recordFindingEvent` insère une ligne de journal (append-only, jamais d'update).
 * - `transitionFinding` change le statut ET journalise la transition dans une même
 *   transaction → « toute transition possède un événement, une cause et un auteur ».
 *   Toute transition est vérifiée contre le graphe §10.1 (`canTransition`).
 * - FIND-003 : `snoozeFinding` / `dismissFinding` / `reopenFinding` (entrées
 *   humaines), `expireSnoozes` (la veille expire seule) et `reconcileDetectionRun`
 *   (auto-résolution des findings qui cessent de matcher, réouverture des récidives).
 *
 * Garde commune : `evidence_json` / `impact_estimate_json` / `payload_json` BORNÉS
 * (assertBoundedPayload) et sans secret (assertNoInlineSecret) avant persistance.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { findings, findingEvents, projects } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { createId } from './utils.js';
import { toDbTimestamp } from './timestamps.js';
import { assertNoInlineSecret } from './projection-state.js';
import { assertBoundedPayload } from './observation-state.js';
import {
	ACTIVE_STATUSES,
	AUTO_RESOLUTION_REASON,
	RECURRENCE_REASON,
	SNOOZE_EXPIRED_REASON,
	canTransition,
	computeSnoozeUntil,
	decideOnAbsence,
	decideOnRedetection,
	deriveFindingFingerprint,
	deriveStatusEventType,
	isSnoozeExpired,
	isTerminalStatus,
	resolveLifecycleConfig,
	type FindingActor,
	type FindingEventType,
	type LifecycleConfig
} from './finding-state.js';

// Format DB canonique (cf. timestamps.ts) : ces colonnes ont un DEFAULT
// `to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`, écrire de l'ISO les rendrait
// incomparables lexicalement avec les lignes posées par le default.
const nowDb = () => toDbTimestamp();

/**
 * Client d'écriture : celui de l'app par défaut, ou un client INJECTÉ (runner
 * `scripts/`, qui construit son propre Pool). L'import de `db/index.js` est
 * DYNAMIQUE et n'a lieu que si aucun client n'est fourni : ce module reste donc
 * chargeable hors runtime SvelteKit (où `$env/dynamic/private` n'existe pas),
 * et une seule implémentation d'upsert sert les deux chemins.
 */
async function resolveDb(client?: AppDb): Promise<AppDb> {
	if (client) return client;
	const mod = await import('./db/index.js');
	return mod.db;
}

function guardPayload(payloadJson: string | null | undefined, context: string): void {
	assertBoundedPayload(payloadJson, context);
	assertNoInlineSecret(payloadJson, context);
}

// ── Upsert idempotent d'un finding ──────────────────────────────────

export interface UpsertFindingInput {
	projectId: string;
	type: string;
	entityType: string;
	entityKey?: string | null;
	/** Discriminants additionnels du fingerprint (au-delà de type+entité). */
	discriminators?: (string | number)[];
	/** Fingerprint explicite ; sinon dérivé de type+entité+discriminants. */
	fingerprint?: string;
	title: string;
	severity?: string;
	priorityScore?: number;
	confidenceScore?: number;
	impactEstimateJson?: string | null;
	evidenceJson?: string | null;
	detectorVersion?: string | null;
	recommendedSkill?: string | null;
	runId?: string | null;
}

export interface UpsertFindingResult {
	id: string;
	fingerprint: string;
	occurrenceCount: number;
	/** true à la première détection (occurrence_count === 1), false si re-détection. */
	isNew: boolean;
}

/**
 * Insère ou rafraîchit un finding par son fingerprint stable. À la première
 * détection → nouvelle ligne (`occurrence_count = 1`). À une re-détection →
 * `occurrence_count + 1`, `last_seen_at` = maintenant, scores/preuves rafraîchis ;
 * `first_seen_at` inchangé.
 */
export async function upsertFinding(
	input: UpsertFindingInput,
	client?: AppDb
): Promise<UpsertFindingResult> {
	guardPayload(input.evidenceJson, 'evidence_json finding');
	guardPayload(input.impactEstimateJson, 'impact_estimate_json finding');
	const db = await resolveDb(client);

	const fingerprint =
		input.fingerprint ??
		deriveFindingFingerprint({
			type: input.type,
			entityType: input.entityType,
			entityKey: input.entityKey,
			discriminators: input.discriminators
		});

	const id = createId();
	const now = nowDb();
	// Colonnes rafraîchies à chaque re-détection (l'identité et first_seen_at restent).
	const refreshed = {
		title: input.title,
		severity: input.severity ?? 'info',
		priorityScore: input.priorityScore ?? 0,
		confidenceScore: input.confidenceScore ?? 0,
		impactEstimateJson: input.impactEstimateJson ?? null,
		evidenceJson: input.evidenceJson ?? null,
		detectorVersion: input.detectorVersion ?? null,
		recommendedSkill: input.recommendedSkill ?? null,
		runId: input.runId ?? null,
		lastSeenAt: now,
		// FIND-003 : le problème se manifeste → la série d'absences repart de zéro.
		// (Le STATUT, lui, n'est jamais touché ici : réouverture et auto-résolution
		// passent par `reconcileDetectionRun`, qui journalise.)
		consecutiveMisses: 0,
		updatedAt: now
	};

	const rows = await db
		.insert(findings)
		.values({
			id,
			projectId: input.projectId,
			fingerprint,
			type: input.type,
			entityType: input.entityType,
			entityKey: input.entityKey ?? '',
			...refreshed
		})
		.onConflictDoUpdate({
			target: [findings.projectId, findings.fingerprint],
			set: {
				...refreshed,
				// increment atomique côté SQL : occurrence_count = occurrence_count + 1
				occurrenceCount: sql`${findings.occurrenceCount} + 1`
			}
		})
		.returning({ id: findings.id, occurrenceCount: findings.occurrenceCount });

	const row = rows[0];
	return {
		id: row.id,
		fingerprint,
		occurrenceCount: row.occurrenceCount,
		isNew: row.occurrenceCount === 1
	};
}

// ── Journal append-only ─────────────────────────────────────────────

export interface RecordFindingEventInput {
	findingId: string;
	projectId: string;
	eventType: FindingEventType | string;
	fromStatus?: string | null;
	toStatus?: string | null;
	reason?: string | null;
	actor?: FindingActor | string;
	payloadJson?: string | null;
}

/** Insère une ligne de journal (append-only : jamais d'update/delete). */
export async function recordFindingEvent(
	input: RecordFindingEventInput,
	client?: AppDb
): Promise<{ id: string }> {
	guardPayload(input.payloadJson, 'payload_json finding_event');
	const db = await resolveDb(client);
	const id = createId();
	await db.insert(findingEvents).values({
		id,
		findingId: input.findingId,
		projectId: input.projectId,
		eventType: input.eventType,
		fromStatus: input.fromStatus ?? null,
		toStatus: input.toStatus ?? null,
		reason: input.reason ?? null,
		actor: input.actor ?? 'system',
		payloadJson: input.payloadJson ?? null
	});
	return { id };
}

// ── Transition d'état (statut + événement, transactionnel) ──────────

export interface TransitionFindingInput {
	findingId: string;
	projectId: string;
	toStatus: string;
	/** Cause de la transition (acceptation : « une cause »). */
	reason: string;
	/** Auteur de la transition (acceptation : « un auteur »). */
	actor: FindingActor | string;
	payloadJson?: string | null;
	/** FIND-003 — échéance de veille (obligatoire de fait vers `snoozed`). */
	snoozedUntil?: string | null;
	/** FIND-003 — nature du « non » humain (false_positive, wont_fix…). */
	dismissalCategory?: string | null;
}

/**
 * Change le statut d'un finding ET journalise la transition, atomiquement. Un
 * passage vers `resolved` pose `resolved_at` + `resolution_reason` ; une
 * réouverture les efface. La transition est refusée (throw) si le finding
 * n'existe pas, si le statut est inchangé, ou si le passage est ILLÉGAL au regard
 * du graphe §10.1 (`canTransition`) — un statut incohérent ne s'installe jamais
 * en silence.
 *
 * Effets de bord du cycle de vie (FIND-003), tous portés ici pour qu'aucun
 * appelant ne puisse les oublier :
 *   - entrée en veille  → pose `snoozed_until` + `snooze_reason` ;
 *   - sortie de veille  → les efface ;
 *   - retour à l'actif  → remet `consecutive_misses` à 0 (la série d'absences ne
 *     survit pas à une réouverture) ;
 *   - réouverture       → incrémente `reopen_count` (signal de qualité FIND-010).
 */
export async function transitionFinding(
	input: TransitionFindingInput,
	client?: AppDb
): Promise<{ eventId: string; eventType: FindingEventType }> {
	guardPayload(input.payloadJson, 'payload_json transition finding');
	const db = await resolveDb(client);

	return db.transaction(async (tx) => {
		const current = await tx
			.select({ status: findings.status })
			.from(findings)
			.where(eq(findings.id, input.findingId))
			.limit(1);
		if (current.length === 0) {
			throw new Error(`transitionFinding : finding ${input.findingId} introuvable.`);
		}
		const fromStatus = current[0].status;
		const eventType = deriveStatusEventType(fromStatus, input.toStatus);
		if (eventType === null) {
			throw new Error(
				`transitionFinding : statut inchangé (${fromStatus}) pour ${input.findingId}.`
			);
		}
		if (!canTransition(fromStatus, input.toStatus)) {
			throw new Error(
				`transitionFinding : transition illégale ${fromStatus} → ${input.toStatus} ` +
					`pour ${input.findingId} (graphe SPEC §10.1).`
			);
		}

		const now = nowDb();
		const resolving = input.toStatus === 'resolved';
		const snoozing = input.toStatus === 'snoozed';
		const leavingSnooze = fromStatus === 'snoozed';
		const reopening = eventType === 'reopened';
		const backToActive = reopening || leavingSnooze;

		await tx
			.update(findings)
			.set({
				status: input.toStatus,
				resolvedAt: resolving ? now : null,
				resolutionReason: resolving ? input.reason : null,
				...(snoozing
					? { snoozedUntil: input.snoozedUntil ?? computeSnoozeUntil({}), snoozeReason: input.reason }
					: {}),
				...(leavingSnooze ? { snoozedUntil: null, snoozeReason: null } : {}),
				...(input.toStatus === 'dismissed'
					? { dismissalCategory: input.dismissalCategory ?? 'false_positive' }
					: {}),
				...(backToActive ? { consecutiveMisses: 0 } : {}),
				...(reopening ? { reopenCount: sql`${findings.reopenCount} + 1` } : {}),
				updatedAt: now
			})
			.where(eq(findings.id, input.findingId));

		const eventId = createId();
		await tx.insert(findingEvents).values({
			id: eventId,
			findingId: input.findingId,
			projectId: input.projectId,
			eventType,
			fromStatus,
			toStatus: input.toStatus,
			reason: input.reason,
			actor: input.actor,
			payloadJson: input.payloadJson ?? null
		});
		return { eventId, eventType };
	});
}

// Ré-export pour les appelants qui journalisent une transition terminale sans
// passer par transitionFinding (ex. dédup côté détecteur).
export { isTerminalStatus };

// ── FIND-003 — Entrées humaines du cycle de vie ─────────────────────

/**
 * Met un finding en veille jusqu'à une échéance. Le snooze est une PROMESSE de
 * silence : ni une re-détection ni une aggravation ne le rompent (l'aggravation
 * reste journalisée) — seule l'échéance, ou une décision explicite, le lève.
 */
export async function snoozeFinding(
	input: {
		findingId: string;
		projectId: string;
		reason: string;
		/** Durée en jours (défaut `LIFECYCLE_DEFAULTS.defaultSnoozeDays`). */
		days?: number;
		/** Échéance explicite (prime sur `days`), déjà au format DB. */
		until?: string;
		actor?: FindingActor | string;
	},
	client?: AppDb
): Promise<{ eventId: string; snoozedUntil: string }> {
	const snoozedUntil = input.until ?? computeSnoozeUntil({ days: input.days });
	const { eventId } = await transitionFinding(
		{
			findingId: input.findingId,
			projectId: input.projectId,
			toStatus: 'snoozed',
			reason: input.reason,
			actor: input.actor ?? 'user',
			snoozedUntil,
			payloadJson: JSON.stringify({ snoozedUntil })
		},
		client
	);
	return { eventId, snoozedUntil };
}

/**
 * Enregistre un « non » humain (faux positif, wont_fix…). Le dismiss vaut À VIE
 * pour ce fingerprint : le détecteur continuera d'incrémenter `occurrence_count`
 * (matière première de la mesure de faux positifs, FIND-010) mais le finding ne
 * remontera jamais seul dans l'inbox — il faut `reopenFinding`.
 */
export async function dismissFinding(
	input: {
		findingId: string;
		projectId: string;
		reason: string;
		/** false_positive | wont_fix | by_design | duplicate … */
		category?: string;
		actor?: FindingActor | string;
	},
	client?: AppDb
): Promise<{ eventId: string }> {
	const { eventId } = await transitionFinding(
		{
			findingId: input.findingId,
			projectId: input.projectId,
			toStatus: 'dismissed',
			reason: input.reason,
			actor: input.actor ?? 'user',
			dismissalCategory: input.category ?? 'false_positive',
			payloadJson: JSON.stringify({ category: input.category ?? 'false_positive' })
		},
		client
	);
	return { eventId };
}

/**
 * Rouvre explicitement un finding terminal (résolu à tort, ou dismiss qu'on
 * regrette). C'est la SEULE façon de défaire un dismiss — jamais la machine.
 */
export async function reopenFinding(
	input: {
		findingId: string;
		projectId: string;
		reason: string;
		actor?: FindingActor | string;
	},
	client?: AppDb
): Promise<{ eventId: string }> {
	const { eventId } = await transitionFinding(
		{
			findingId: input.findingId,
			projectId: input.projectId,
			toStatus: 'reopened',
			reason: input.reason,
			actor: input.actor ?? 'user'
		},
		client
	);
	return { eventId };
}

// ── FIND-003 — La veille expire seule (acceptation 3) ───────────────

export interface ExpireSnoozesResult {
	/** Findings réveillés (ids). */
	reopened: string[];
	/** Findings encore en veille, échéance non atteinte. */
	stillSnoozed: number;
}

/**
 * Réveille les findings dont la veille est échue : `snoozed → open`, événement
 * `unsnoozed`, `snoozed_until`/`snooze_reason` effacés. Idempotent (un second
 * passage ne trouve plus rien).
 *
 * La lecture est bornée par l'index PARTIEL `idx_findings_snoozed_until` ; la
 * décision d'expiration reste au module pur (`isSnoozeExpired`), donc testable
 * sans DB et immunisée contre le piège lexical ISO / format DB.
 */
export async function expireSnoozes(
	input: { projectId?: string; now?: Date | string } = {},
	client?: AppDb
): Promise<ExpireSnoozesResult> {
	const db = await resolveDb(client);
	const now = input.now ?? new Date();

	const rows = await db
		.select({
			id: findings.id,
			projectId: findings.projectId,
			snoozedUntil: findings.snoozedUntil
		})
		.from(findings)
		.where(
			input.projectId
				? and(eq(findings.status, 'snoozed'), eq(findings.projectId, input.projectId))
				: eq(findings.status, 'snoozed')
		);

	const result: ExpireSnoozesResult = { reopened: [], stillSnoozed: 0 };
	for (const row of rows) {
		if (!isSnoozeExpired(row.snoozedUntil, now)) {
			result.stillSnoozed += 1;
			continue;
		}
		await transitionFinding(
			{
				findingId: row.id,
				projectId: row.projectId,
				toStatus: 'open',
				reason: SNOOZE_EXPIRED_REASON,
				actor: 'system',
				payloadJson: JSON.stringify({ snoozedUntil: row.snoozedUntil })
			},
			db
		);
		result.reopened.push(row.id);
	}
	return result;
}

// ── FIND-003 — Réconciliation d'un run de détection ─────────────────

export interface ReconcileDetectionInput {
	projectId: string;
	/** Type de finding couvert par la closure (un détecteur = un type). */
	type: string;
	/**
	 * Fingerprints de TOUS les signaux franchissant les seuils sur cette fenêtre,
	 * AVANT toute troncature d'écriture. Une closure tronquée ferait passer pour
	 * « guéris » des findings simplement non réécrits — c'est l'invariant n°1.
	 */
	closure: Set<string>;
	detectorVersion?: string | null;
	runId?: string | null;
	config?: Partial<LifecycleConfig> | null;
}

export interface ReconcileDetectionResult {
	/** Récidives : findings résolus que le signal a fait revenir. */
	reopened: number;
	/** Auto-résolus : absents assez longtemps pour être considérés guéris. */
	autoResolved: number;
	/** Absents ce tour-ci, sous le seuil de confirmation (compteur incrémenté). */
	missed: number;
	/** Intouchés par décision : en veille, ou dismissés à vie. */
	held: number;
}

/**
 * Confronte l'état persisté à ce que le détecteur voit MAINTENANT.
 *
 * Deux directions, une seule lecture :
 *   - fingerprint PRÉSENT dans la closure → `decideOnRedetection` : un finding
 *     résolu récidive donc rouvre (acceptation 2) ; un dismiss et une veille
 *     tiennent ; un actif est laissé tel quel (l'upsert l'a déjà rafraîchi) ;
 *   - fingerprint ABSENT → `decideOnAbsence` : on compte l'absence, et on résout
 *     seulement après N fenêtres consécutives (jamais sur une seule).
 *
 * ⚠ L'appelant ne doit invoquer cette fonction que pour un run AUTORITAIRE
 * (fenêtre valide, observations lues) : sans données, l'absence ne prouve rien.
 */
export async function reconcileDetectionRun(
	input: ReconcileDetectionInput,
	client?: AppDb
): Promise<ReconcileDetectionResult> {
	const db = await resolveDb(client);
	const config = resolveLifecycleConfig(input.config);
	const result: ReconcileDetectionResult = { reopened: 0, autoResolved: 0, missed: 0, held: 0 };

	const rows = await db
		.select({
			id: findings.id,
			projectId: findings.projectId,
			fingerprint: findings.fingerprint,
			status: findings.status,
			consecutiveMisses: findings.consecutiveMisses
		})
		.from(findings)
		.where(and(eq(findings.projectId, input.projectId), eq(findings.type, input.type)));

	/** Absences confirmées d'un tour : un seul UPDATE groupé plutôt que N. */
	const toCount: string[] = [];

	for (const row of rows) {
		if (input.closure.has(row.fingerprint)) {
			const decision = decideOnRedetection(row.status);
			if (decision === 'reopen') {
				await transitionFinding(
					{
						findingId: row.id,
						projectId: row.projectId,
						toStatus: 'reopened',
						reason: RECURRENCE_REASON,
						actor: 'detector',
						payloadJson: JSON.stringify({
							detector: input.detectorVersion ?? null,
							runId: input.runId ?? null
						})
					},
					db
				);
				result.reopened += 1;
			} else if (decision === 'hold') {
				result.held += 1;
			}
			continue;
		}

		const decision = decideOnAbsence({
			status: row.status,
			consecutiveMisses: row.consecutiveMisses,
			config
		});
		if (decision.action === 'skip') {
			// `held` ne compte que les décisions actives (veille / dismiss) ; un
			// finding déjà résolu et toujours absent n'est pas un « maintien ».
			if (row.status === 'snoozed' || row.status === 'dismissed') result.held += 1;
			continue;
		}
		if (decision.action === 'count') {
			toCount.push(row.id);
			result.missed += 1;
			continue;
		}
		await transitionFinding(
			{
				findingId: row.id,
				projectId: row.projectId,
				toStatus: 'resolved',
				reason: AUTO_RESOLUTION_REASON,
				actor: 'detector',
				payloadJson: JSON.stringify({
					detector: input.detectorVersion ?? null,
					runId: input.runId ?? null,
					consecutiveMisses: decision.nextMisses
				})
			},
			db
		);
		// La transition ne connaît pas le compteur : on fige l'absence qui a conclu.
		await db
			.update(findings)
			.set({ consecutiveMisses: decision.nextMisses })
			.where(eq(findings.id, row.id));
		result.autoResolved += 1;
	}

	if (toCount.length > 0) {
		// Incrément atomique côté SQL, en un seul aller-retour.
		await db
			.update(findings)
			.set({
				consecutiveMisses: sql`${findings.consecutiveMisses} + 1`,
				updatedAt: nowDb()
			})
			.where(inArray(findings.id, toCount));
	}

	return result;
}

// ── Lecture (AGT-000) ───────────────────────────────────────────────
//
// Ce module n'a longtemps porté que des ÉCRITURES : les détecteurs écrivaient
// des findings que personne ne relisait. Tout consommateur en aval — le
// producteur de propositions, l'API agent en lecture, l'inbox — a besoin des
// deux mêmes accès, et les avoir ici évite que chacun réinvente son filtre de
// statut (et se trompe sur `snoozed`/`dismissed`).

/** Un finding tel que les consommateurs le lisent. */
export interface FindingRow {
	id: string;
	projectId: string;
	runId: string | null;
	fingerprint: string;
	type: string;
	entityType: string;
	entityKey: string;
	title: string;
	status: string;
	severity: string;
	priorityScore: number;
	confidenceScore: number;
	impactEstimateJson: string | null;
	evidenceJson: string | null;
	detectorVersion: string | null;
	recommendedSkill: string | null;
	occurrenceCount: number;
	firstSeenAt: string;
	lastSeenAt: string;
	updatedAt: string;
}

const FINDING_COLUMNS = {
	id: findings.id,
	projectId: findings.projectId,
	runId: findings.runId,
	fingerprint: findings.fingerprint,
	type: findings.type,
	entityType: findings.entityType,
	entityKey: findings.entityKey,
	title: findings.title,
	status: findings.status,
	severity: findings.severity,
	priorityScore: findings.priorityScore,
	confidenceScore: findings.confidenceScore,
	impactEstimateJson: findings.impactEstimateJson,
	evidenceJson: findings.evidenceJson,
	detectorVersion: findings.detectorVersion,
	recommendedSkill: findings.recommendedSkill,
	occurrenceCount: findings.occurrenceCount,
	firstSeenAt: findings.firstSeenAt,
	lastSeenAt: findings.lastSeenAt,
	updatedAt: findings.updatedAt
} as const;

/** Un finding tel que l'inbox le liste : avec son projet. */
export interface FindingListRow extends FindingRow {
	projectSlug: string | null;
	projectName: string | null;
	projectColor: string | null;
}

export interface ListFindingsInput {
	projectId?: string;
	/** Slug du projet — l'inbox filtre par slug (ce que porte l'URL), pas par id. */
	projectSlug?: string | null;
	/** Statuts retenus ; par défaut, les statuts ACTIFS (l'inbox). */
	statuses?: readonly string[];
	types?: readonly string[];
	minPriority?: number;
	limit?: number;
	offset?: number;
}

/**
 * Liste les findings, triés par priorité décroissante puis fingerprint (ordre
 * TOTAL et déterministe : deux findings à score égal ne peuvent pas permuter
 * d'un appel à l'autre, ce dont dépend la reproductibilité du producteur).
 *
 * Le défaut est volontairement l'inbox (`ACTIVE_STATUSES`) et non « tout » :
 * un appelant qui oublie de filtrer récupérerait sinon les `dismissed` et les
 * `snoozed`, c'est-à-dire précisément ce que des humains ont décidé de ne plus
 * voir. `projectId + status` consomme `idx_findings_project_status`.
 */
export async function listFindings(
	input: ListFindingsInput = {},
	client?: AppDb
): Promise<FindingListRow[]> {
	const db = await resolveDb(client);

	const rows = await db
		.select({
			...FINDING_COLUMNS,
			// L'inbox est CROSS-PROJET : sans le nom du projet sur chaque ligne, une
			// liste de 13 findings de 6 projets ne se lit pas. Joint ici plutôt que
			// résolu par l'appelant, sinon chaque page referait la jointure.
			projectSlug: projects.slug,
			projectName: projects.name,
			projectColor: projects.color
		})
		.from(findings)
		.leftJoin(projects, eq(projects.id, findings.projectId))
		.where(findingFilters(input))
		.orderBy(desc(findings.priorityScore), findings.fingerprint)
		.limit(Math.max(1, Math.floor(input.limit ?? 500)))
		.offset(Math.max(0, Math.floor(input.offset ?? 0)));

	return rows;
}

/** Filtres communs à `listFindings` et `countFindings` — définis une fois, sinon
 *  la liste et son total finissent par décrire deux ensembles différents. */
function findingFilters(input: ListFindingsInput) {
	const statuses = input.statuses ?? ACTIVE_STATUSES;
	const filters = [];
	if (input.projectId) filters.push(eq(findings.projectId, input.projectId));
	if (input.projectSlug) filters.push(eq(projects.slug, input.projectSlug));
	if (statuses.length > 0) filters.push(inArray(findings.status, [...statuses]));
	if (input.types && input.types.length > 0) filters.push(inArray(findings.type, [...input.types]));
	if (typeof input.minPriority === 'number' && Number.isFinite(input.minPriority)) {
		filters.push(gte(findings.priorityScore, Math.floor(input.minPriority)));
	}
	return filters.length > 0 ? and(...filters) : undefined;
}

/** Total correspondant aux mêmes filtres (pagination de l'inbox). */
export async function countFindings(
	input: ListFindingsInput = {},
	client?: AppDb
): Promise<number> {
	const db = await resolveDb(client);
	const rows = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(findings)
		.leftJoin(projects, eq(projects.id, findings.projectId))
		.where(findingFilters(input));
	return rows[0]?.n ?? 0;
}

/**
 * Compteurs par statut, pour l'en-tête de l'inbox. Ils IGNORENT le filtre de
 * statut (ils SONT le filtre) mais respectent le projet — même règle que
 * `countJobsByStatus` : cliquer « en veille » ne doit pas afficher « 0 ouvert »
 * et laisser croire qu'il n'y a rien à traiter.
 */
export async function countFindingsByStatus(
	input: { projectSlug?: string | null } = {},
	client?: AppDb
): Promise<Record<string, number>> {
	const db = await resolveDb(client);
	const rows = await db
		.select({ status: findings.status, n: sql<number>`count(*)::int` })
		.from(findings)
		.leftJoin(projects, eq(projects.id, findings.projectId))
		.where(input.projectSlug ? eq(projects.slug, input.projectSlug) : undefined)
		.groupBy(findings.status);
	return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/**
 * Un finding et son journal (SPEC §13.3 « vue finding »). Les événements sont
 * rendus du plus ancien au plus récent : c'est une chronologie, elle se lit dans
 * l'ordre où les choses sont arrivées.
 */
export async function getFindingWithEvidence(
	findingId: string,
	client?: AppDb
): Promise<{
	finding: FindingRow;
	/** Le projet porteur — l'écran a besoin du slug pour lier, pas de l'id. */
	project: { slug: string | null; name: string | null; color: string | null };
	events: {
		id: string;
		eventType: string;
		fromStatus: string | null;
		toStatus: string | null;
		reason: string | null;
		actor: string;
		createdAt: string;
	}[];
} | null> {
	const db = await resolveDb(client);
	const rows = await db
		.select({
			...FINDING_COLUMNS,
			projectSlug: projects.slug,
			projectName: projects.name,
			projectColor: projects.color
		})
		.from(findings)
		.leftJoin(projects, eq(projects.id, findings.projectId))
		.where(eq(findings.id, findingId))
		.limit(1);
	if (rows.length === 0) return null;
	const { projectSlug, projectName, projectColor, ...finding } = rows[0];

	const events = await db
		.select({
			id: findingEvents.id,
			eventType: findingEvents.eventType,
			fromStatus: findingEvents.fromStatus,
			toStatus: findingEvents.toStatus,
			reason: findingEvents.reason,
			actor: findingEvents.actor,
			createdAt: findingEvents.createdAt
		})
		.from(findingEvents)
		.where(eq(findingEvents.findingId, findingId))
		.orderBy(findingEvents.createdAt);

	return {
		finding,
		project: { slug: projectSlug, name: projectName, color: projectColor },
		events
	};
}
