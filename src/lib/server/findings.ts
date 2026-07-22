/**
 * DATA-005 — Écriture de findings (upsert idempotent + journal append-only).
 *
 * - `upsertFinding` vise l'unique `(project_id, fingerprint)` : le même problème
 *   redétecté ne crée JAMAIS un doublon, il incrémente `occurrence_count` et
 *   rafraîchit `last_seen_at` + les scores/preuves (acceptation « même problème sur
 *   deux semaines = même finding »). `first_seen_at` est préservé.
 * - `recordFindingEvent` insère une ligne de journal (append-only, jamais d'update).
 * - `transitionFinding` change le statut ET journalise la transition dans une même
 *   transaction → « toute transition possède un événement, une cause et un auteur ».
 *
 * Garde commune : `evidence_json` / `impact_estimate_json` / `payload_json` BORNÉS
 * (assertBoundedPayload) et sans secret (assertNoInlineSecret) avant persistance.
 */
import { eq, sql } from 'drizzle-orm';
import { findings, findingEvents } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { createId } from './utils.js';
import { toDbTimestamp } from './timestamps.js';
import { assertNoInlineSecret } from './projection-state.js';
import { assertBoundedPayload } from './observation-state.js';
import {
	deriveFindingFingerprint,
	deriveStatusEventType,
	isTerminalStatus,
	type FindingActor,
	type FindingEventType
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
}

/**
 * Change le statut d'un finding ET journalise la transition, atomiquement. Un
 * passage vers `resolved` pose `resolved_at` + `resolution_reason` ; une
 * réouverture les efface. La transition est refusée (throw) si le finding
 * n'existe pas ou si le statut est inchangé.
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

		const now = nowDb();
		const resolving = input.toStatus === 'resolved';
		await tx
			.update(findings)
			.set({
				status: input.toStatus,
				resolvedAt: resolving ? now : null,
				resolutionReason: resolving ? input.reason : null,
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
