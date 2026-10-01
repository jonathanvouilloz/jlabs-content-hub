/**
 * GMB-010 — mentions d'équipe pilotées par l'agent : lecture et édition du roster,
 * soumission jugée à la réception, résolution humaine relayée par l'agent.
 *
 * Le roster reste dans la projection `current` (une seule source, dont dérive aussi le
 * roster publiable des réponses). Le modifier = promouvoir une NOUVELLE projection hashée,
 * l'ancienne passe `stale` : l'historique des versions est l'historique des projections.
 * Conséquence assumée : une proposition de réponse rédigée sous l'ancien roster est refusée
 * au `/publish` (`projection_changed`) et doit être re-proposée.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, isNull, like } from 'drizzle-orm';
import type { AppDb } from '../db/types.js';
import { gmbReviews, projectGmbLocations, projectProjections, projects, reviewMentionCandidates } from '../db/schema.js';
import { createId } from '../utils.js';
import { toDbTimestamp } from '../timestamps.js';
import { assertNoInlineSecret } from '../projection-state.js';
import { buildAgentMentionCandidate } from './agent-mention-state.js';
import { AgentReviewApiError } from './agent-review-service.js';
import { normalizeRosterToken, parseEmployeeMentionsCapability, type EmployeeMentionsRoster } from './employee-mentions-state.js';
import {
	applyRosterChanges,
	assessSubmittedMention,
	mergeValidatedMention,
	nextRosterVersion,
	type AgentMatchKind,
	type MentionAssessment,
	type MentionSentiment,
	type RosterChange
} from './mention-resolution-state.js';

type CandidateRow = typeof reviewMentionCandidates.$inferSelect;

interface RosterLastChange {
	idempotencyKey: string;
	requestHash: string;
	fromVersion: string;
	toVersion: string;
	actor: string;
	reason: string;
	at: string;
}

function stableHash(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseJson(raw: string | null): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw);
		return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

async function requireProject(db: AppDb, slug: string) {
	const project = await db.query.projects.findFirst({
		columns: { id: true, slug: true, archived: true },
		where: eq(projects.slug, slug)
	});
	if (!project || project.archived) throw new AgentReviewApiError(404, 'project_not_found');
	return project;
}

interface CurrentRoster {
	projectionId: string;
	payload: Record<string, unknown>;
	roster: EmployeeMentionsRoster;
	locations: Array<{ id: string; label: string | null }>;
}

async function loadCurrentRoster(db: AppDb, projectId: string): Promise<CurrentRoster | null> {
	const projection = await db.query.projectProjections.findFirst({
		where: and(eq(projectProjections.projectId, projectId), eq(projectProjections.status, 'current'))
	});
	const payload = parseJson(projection?.payload ?? null);
	const capability = parseEmployeeMentionsCapability(payload);
	if (!projection || !payload || !capability.roster) return null;
	const declared = (payload.gmb as { reviewReplies?: { locations?: unknown } } | undefined)?.reviewReplies?.locations;
	let locations: Array<{ id: string; label: string | null }> = Array.isArray(declared)
		? declared.flatMap((entry) =>
				entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
					? [{ id: (entry as { id: string }).id, label: typeof (entry as { label?: unknown }).label === 'string' ? (entry as { label: string }).label : null }]
					: []
			)
		: [];
	if (locations.length === 0) {
		const rows = await db
			.select({ id: projectGmbLocations.gmbLocationId, label: projectGmbLocations.label })
			.from(projectGmbLocations)
			.where(eq(projectGmbLocations.projectId, projectId));
		locations = rows;
	}
	return { projectionId: projection.id, payload, roster: capability.roster, locations };
}

// ── Lecture ─────────────────────────────────────────────────────────────────────

export async function getAgentRoster(input: { db: AppDb; projectSlug: string }) {
	const project = await requireProject(input.db, input.projectSlug);
	const current = await loadCurrentRoster(input.db, project.id);
	if (!current) throw new AgentReviewApiError(409, 'roster_unavailable');
	const { roster } = current;
	return {
		version: roster.version,
		extraction: roster.extraction ?? 'hub',
		locations: current.locations,
		// Pas d'`eligibleForBonus` : la prime n'est pas une décision d'agent.
		employees: roster.employees.map((employee) => ({
			id: employee.id,
			displayName: employee.displayName,
			aliases: employee.aliases,
			locations: employee.locations,
			active: employee.active,
			publicReplyAllowed: employee.publicReplyAllowed,
			trackMentions: employee.trackMentions !== false
		}))
	};
}

function toCandidateView(row: CandidateRow, idempotent = false) {
	const resolution = parseJson(row.resolutionJson);
	return {
		id: row.id,
		reviewId: row.reviewId,
		locationId: row.locationId,
		token: row.detectedToken,
		sentiment: row.sentiment,
		evidence: row.evidence,
		confidence: row.confidence,
		status: row.status,
		reason: (resolution?.reason as string | undefined) ?? null,
		employeeId: (resolution?.employeeId as string | undefined) ?? null,
		displayName: (resolution?.displayName as string | undefined) ?? null,
		suggestedEmployeeId: (resolution?.suggestedEmployeeId as string | undefined) ?? null,
		resolvedBy: (resolution?.resolvedBy as string | undefined) ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		...(idempotent ? { idempotent: true } : {})
	};
}

export type MentionCandidateView = ReturnType<typeof toCandidateView>;

export async function listAgentMentionCandidates(input: {
	db: AppDb;
	projectSlug: string;
	status: 'candidate' | 'validated' | 'rejected' | 'resolved';
	limit: number;
}) {
	const project = await requireProject(input.db, input.projectSlug);
	const rows = await input.db
		.select()
		.from(reviewMentionCandidates)
		.where(and(eq(reviewMentionCandidates.projectId, project.id), eq(reviewMentionCandidates.status, input.status)))
		.orderBy(asc(reviewMentionCandidates.createdAt), asc(reviewMentionCandidates.id))
		.limit(Math.min(200, Math.max(1, Math.floor(input.limit || 100))));
	return rows.map((row) => toCandidateView(row));
}

// ── Écritures partagées ──────────────────────────────────────────────────────────

async function mergeMentionIntoReview(
	db: AppDb,
	projectId: string,
	reviewId: string,
	mention: { name: string; sentiment: MentionSentiment }
): Promise<void> {
	const review = await db.query.gmbReviews.findFirst({
		columns: { id: true, mentionedEmployees: true },
		where: and(eq(gmbReviews.projectId, projectId), eq(gmbReviews.reviewId, reviewId))
	});
	if (!review) return;
	const merged = mergeValidatedMention(review.mentionedEmployees, mention);
	if (merged !== null) {
		await db.update(gmbReviews).set({ mentionedEmployees: merged }).where(eq(gmbReviews.id, review.id));
	}
}

function assessmentJson(assessment: MentionAssessment, extra: Record<string, unknown>): string {
	return JSON.stringify({ ...assessment, ...extra });
}

/**
 * Pose le verdict automatique sur une ligne encore `candidate`. Le `WHERE status` empêche
 * d'écraser une décision humaine arrivée entre-temps.
 */
async function applyAssessment(
	db: AppDb,
	row: CandidateRow,
	assessment: MentionAssessment,
	extra: Record<string, unknown>
): Promise<CandidateRow> {
	const resolvedBy = assessment.status === 'candidate' ? null : 'roster_exact';
	const [updated] = await db
		.update(reviewMentionCandidates)
		.set({
			status: assessment.status,
			resolutionJson: assessmentJson(assessment, { ...extra, resolvedBy }),
			updatedAt: toDbTimestamp()
		})
		.where(and(eq(reviewMentionCandidates.id, row.id), eq(reviewMentionCandidates.status, 'candidate')))
		.returning();
	if (!updated) return row;
	if (assessment.status === 'validated') {
		await mergeMentionIntoReview(db, row.projectId, row.reviewId, {
			name: assessment.displayName,
			sentiment: row.sentiment as MentionSentiment
		});
	}
	return updated;
}

/** Re-juge toutes les candidates en attente contre un nouveau roster. */
async function reassessPendingCandidates(db: AppDb, projectId: string, roster: EmployeeMentionsRoster) {
	const pending = await db
		.select()
		.from(reviewMentionCandidates)
		.where(and(eq(reviewMentionCandidates.projectId, projectId), eq(reviewMentionCandidates.status, 'candidate')));
	const counts = { validated: 0, resolved: 0, stillPending: 0 };
	for (const row of pending) {
		const previous = parseJson(row.resolutionJson);
		const assessment = assessSubmittedMention({
			token: row.detectedToken,
			locationId: row.locationId,
			roster,
			suggestedEmployeeId: (previous?.suggestedEmployeeId as string | null | undefined) ?? null
		});
		if (assessment.status === 'candidate') {
			counts.stillPending += 1;
			continue;
		}
		await applyAssessment(db, row, assessment, { rosterVersion: roster.version, matchKind: previous?.matchKind ?? null });
		counts[assessment.status] += 1;
	}
	return counts;
}

// ── Roster : changements ─────────────────────────────────────────────────────────

async function findRosterReplay(db: AppDb, projectId: string, idempotencyKey: string): Promise<RosterLastChange | null> {
	const rows = await db
		.select({ payload: projectProjections.payload })
		.from(projectProjections)
		.where(and(eq(projectProjections.projectId, projectId), like(projectProjections.payload, `%${idempotencyKey}%`)));
	for (const row of rows) {
		const lastChange = (parseJson(row.payload)?.gmb as { employeeMentions?: { lastChange?: RosterLastChange } } | undefined)
			?.employeeMentions?.lastChange;
		if (lastChange?.idempotencyKey === idempotencyKey) return lastChange;
	}
	return null;
}

function isUniqueViolation(error: unknown): boolean {
	const candidate = error as { code?: string; cause?: { code?: string } } | null;
	return candidate?.code === '23505' || candidate?.cause?.code === '23505';
}

export async function applyAgentRosterChanges(input: {
	db: AppDb;
	projectSlug: string;
	idempotencyKey: string;
	actor: string;
	baseVersion: string;
	reason: string;
	changes: RosterChange[];
}) {
	const project = await requireProject(input.db, input.projectSlug);
	const requestHash = stableHash({ baseVersion: input.baseVersion, reason: input.reason, changes: input.changes });

	const replay = await findRosterReplay(input.db, project.id, input.idempotencyKey);
	if (replay) {
		if (replay.requestHash !== requestHash) throw new AgentReviewApiError(409, 'idempotency_key_reused');
		return { version: replay.toVersion, previousVersion: replay.fromVersion, changed: true, idempotent: true, reassessed: null };
	}

	const current = await loadCurrentRoster(input.db, project.id);
	if (!current) throw new AgentReviewApiError(409, 'roster_unavailable');
	if (current.roster.version !== input.baseVersion) throw new AgentReviewApiError(409, 'roster_version_conflict');

	const applied = applyRosterChanges({
		roster: current.roster,
		changes: input.changes,
		knownLocations: current.locations.map((location) => location.id)
	});
	if (!applied.ok) throw new AgentReviewApiError(409, applied.code, `${applied.code} (changement ${applied.index})`);
	if (!applied.changed) {
		return { version: current.roster.version, previousVersion: current.roster.version, changed: false, idempotent: false, reassessed: null };
	}

	const version = nextRosterVersion(current.roster.version);
	const lastChange: RosterLastChange = {
		idempotencyKey: input.idempotencyKey,
		requestHash,
		fromVersion: current.roster.version,
		toVersion: version,
		actor: input.actor,
		reason: input.reason,
		at: toDbTimestamp()
	};
	const roster: EmployeeMentionsRoster & { lastChange: RosterLastChange } = { ...applied.roster, version, lastChange };
	const payload = structuredClone(current.payload) as { gmb: Record<string, unknown> };
	payload.gmb.employeeMentions = roster;
	if (!parseEmployeeMentionsCapability(payload).enabled) throw new AgentReviewApiError(409, 'roster_invalid');

	const serialized = JSON.stringify(payload);
	assertNoInlineSecret(serialized, 'roster agent');
	const sourceHash = createHash('sha256').update(serialized).digest('hex');
	const now = toDbTimestamp();
	try {
		await input.db.transaction(async (tx) => {
			const stale = await tx
				.update(projectProjections)
				.set({ status: 'stale' })
				.where(and(eq(projectProjections.id, current.projectionId), eq(projectProjections.status, 'current')))
				.returning({ id: projectProjections.id });
			if (stale.length === 0) throw new AgentReviewApiError(409, 'roster_version_conflict');
			await tx.insert(projectProjections).values({
				id: createId(),
				projectId: project.id,
				schemaVersion: 1,
				sourceHash,
				payload: serialized,
				status: 'current',
				validationErrors: null,
				compiledAt: now,
				receivedAt: now
			});
		});
	} catch (error) {
		if (error instanceof AgentReviewApiError) throw error;
		if (isUniqueViolation(error)) throw new AgentReviewApiError(409, 'roster_version_conflict');
		throw error;
	}

	const reassessed = await reassessPendingCandidates(input.db, project.id, roster);
	return { version, previousVersion: current.roster.version, changed: true, idempotent: false, reassessed };
}

// ── Soumission ───────────────────────────────────────────────────────────────────

export interface SubmittedMention {
	token: string;
	sentiment: MentionSentiment;
	evidence: string;
	confidence: number;
	rosterVersion?: string | null;
	employeeId?: string | null;
	matchKind?: AgentMatchKind | null;
}

/**
 * Enregistre les mentions de l'agent et les juge tout de suite. Une liste VIDE est valide :
 * elle dit « avis analysé, personne de cité », ce qui marque l'avis comme traité.
 */
export async function submitAgentMentionCandidates(input: {
	db: AppDb;
	projectSlug: string;
	reviewId: string;
	idempotencyKey: string;
	actor: string;
	candidates: SubmittedMention[];
}) {
	const project = await requireProject(input.db, input.projectSlug);
	const review = await input.db.query.gmbReviews.findFirst({
		where: and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, input.reviewId))
	});
	if (!review) throw new AgentReviewApiError(404, 'review_not_found');
	const current = await loadCurrentRoster(input.db, project.id);
	const roster = current?.roster ?? null;

	const results: MentionCandidateView[] = [];
	for (const [index, candidate] of input.candidates.entries()) {
		const key = `${input.idempotencyKey}:${index}`;
		const record = buildAgentMentionCandidate(candidate);

		// Même couple (avis, token) déjà reçu sous une autre clé : on rend la ligne existante.
		const duplicate = await input.db.query.reviewMentionCandidates.findFirst({
			where: and(
				eq(reviewMentionCandidates.projectId, project.id),
				eq(reviewMentionCandidates.reviewId, review.reviewId),
				eq(reviewMentionCandidates.normalizedToken, record.normalizedToken)
			)
		});
		if (duplicate) {
			results.push(toCandidateView(duplicate, true));
			continue;
		}

		const [inserted] = await input.db
			.insert(reviewMentionCandidates)
			.values({
				id: createId(),
				projectId: project.id,
				reviewId: review.reviewId,
				locationId: review.locationId,
				detectedToken: record.detectedToken,
				normalizedToken: record.normalizedToken,
				sentiment: record.sentiment,
				evidence: record.evidence,
				confidence: record.confidence,
				rosterVersion: record.rosterVersion,
				status: record.status,
				idempotencyKey: key,
				createdBy: input.actor
			})
			.onConflictDoNothing()
			.returning();
		if (!inserted) {
			const existing = await input.db.query.reviewMentionCandidates.findFirst({
				where: and(eq(reviewMentionCandidates.projectId, project.id), eq(reviewMentionCandidates.idempotencyKey, key))
			});
			if (existing) results.push(toCandidateView(existing, true));
			continue;
		}

		const assessment = assessSubmittedMention({
			token: inserted.detectedToken,
			locationId: inserted.locationId,
			roster,
			suggestedEmployeeId: candidate.employeeId ?? null
		});
		const row = await applyAssessment(input.db, inserted, assessment, {
			rosterVersion: roster?.version ?? null,
			matchKind: candidate.matchKind ?? null
		});
		results.push(toCandidateView(row));
	}

	if (review.mentionedEmployees === null) {
		await input.db
			.update(gmbReviews)
			.set({ mentionedEmployees: '[]' })
			.where(and(eq(gmbReviews.id, review.id), isNull(gmbReviews.mentionedEmployees)));
	}
	return results;
}

// ── Résolution humaine ───────────────────────────────────────────────────────────

export async function resolveAgentMentionCandidate(input: {
	db: AppDb;
	projectSlug: string;
	candidateId: string;
	idempotencyKey: string;
	actor: string;
	decision: 'validate' | 'reject';
	employeeId?: string | null;
	rememberAlias?: boolean;
	note?: string | null;
}) {
	const project = await requireProject(input.db, input.projectSlug);
	const row = await input.db.query.reviewMentionCandidates.findFirst({
		where: and(eq(reviewMentionCandidates.projectId, project.id), eq(reviewMentionCandidates.id, input.candidateId))
	});
	if (!row) throw new AgentReviewApiError(404, 'candidate_not_found');

	const previous = parseJson(row.resolutionJson);
	if (row.status !== 'candidate') {
		if (previous?.decisionKey === input.idempotencyKey) {
			return { candidate: toCandidateView(row, true), alias: null };
		}
		throw new AgentReviewApiError(409, 'candidate_already_resolved');
	}

	const current = await loadCurrentRoster(input.db, project.id);
	const decided = { decisionKey: input.idempotencyKey, decidedBy: input.actor, note: input.note ?? null, resolvedBy: 'human' };

	if (input.decision === 'reject') {
		if (input.rememberAlias) throw new AgentReviewApiError(400, 'remember_alias_requires_validate');
		const [updated] = await input.db
			.update(reviewMentionCandidates)
			.set({
				status: 'rejected',
				resolutionJson: JSON.stringify({ ...previous, ...decided, decision: 'reject' }),
				updatedAt: toDbTimestamp()
			})
			.where(and(eq(reviewMentionCandidates.id, row.id), eq(reviewMentionCandidates.status, 'candidate')))
			.returning();
		if (!updated) throw new AgentReviewApiError(409, 'candidate_already_resolved');
		return { candidate: toCandidateView(updated), alias: null };
	}

	if (!current) throw new AgentReviewApiError(409, 'roster_unavailable');
	const employeeId = input.employeeId ?? (previous?.suggestedEmployeeId as string | undefined) ?? null;
	if (!employeeId) throw new AgentReviewApiError(400, 'employee_required');
	const employee = current.roster.employees.find((entry) => entry.id === employeeId);
	if (!employee) throw new AgentReviewApiError(404, 'employee_not_found');
	if (!employee.active) throw new AgentReviewApiError(409, 'employee_inactive');

	const notTracked = employee.trackMentions === false;
	const [updated] = await input.db
		.update(reviewMentionCandidates)
		.set({
			status: notTracked ? 'resolved' : 'validated',
			resolutionJson: JSON.stringify({
				...previous,
				...decided,
				decision: 'validate',
				employeeId: employee.id,
				displayName: employee.displayName,
				reason: notTracked ? 'not_tracked' : (previous?.reason ?? null),
				rosterVersion: current.roster.version
			}),
			updatedAt: toDbTimestamp()
		})
		.where(and(eq(reviewMentionCandidates.id, row.id), eq(reviewMentionCandidates.status, 'candidate')))
		.returning();
	if (!updated) throw new AgentReviewApiError(409, 'candidate_already_resolved');
	if (!notTracked) {
		await mergeMentionIntoReview(input.db, project.id, row.reviewId, {
			name: employee.displayName,
			sentiment: row.sentiment as MentionSentiment
		});
	}

	// La décision est acquise ; retenir l'orthographe est une conséquence, jamais une condition.
	let alias: { added: boolean; version?: string; error?: string; reassessed?: unknown } | null = null;
	const alreadyKnown = [employee.displayName, ...employee.aliases]
		.map(normalizeRosterToken)
		.includes(row.normalizedToken);
	if (input.rememberAlias && alreadyKnown) alias = { added: false, version: current.roster.version };
	if (input.rememberAlias && !alreadyKnown) {
		try {
			const result = await applyAgentRosterChanges({
				db: input.db,
				projectSlug: input.projectSlug,
				idempotencyKey: `${input.idempotencyKey}:alias`,
				actor: input.actor,
				baseVersion: current.roster.version,
				reason: `Alias validé depuis la mention ${row.id}`,
				changes: [{ op: 'add_alias', employeeId: employee.id, alias: row.detectedToken }]
			});
			alias = { added: result.changed, version: result.version, reassessed: result.reassessed };
		} catch (error) {
			alias = { added: false, error: error instanceof AgentReviewApiError ? error.code : 'internal_error' };
		}
	}
	return { candidate: toCandidateView(updated), alias };
}
