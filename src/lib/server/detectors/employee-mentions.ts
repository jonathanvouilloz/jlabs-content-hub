import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../db/types.js';
import { gmbReviews, projectProjections } from '../db/schema.js';
import { upsertFinding, recordFindingEvent } from '../findings.js';
import { extractEmployeeMentionCandidates } from '../ai/employee-mentions.js';
import { extractBoundedEmployeeMentions } from '../reviews/employee-mentions-core.js';
import { matchRosterMentions, parseEmployeeMentionsCapability, type EmployeeMentionsRoster } from '../reviews/employee-mentions-state.js';
import { buildUnknownEmployeeMentionFinding, DETECTOR_EMPLOYEE_MENTIONS, EMPLOYEE_MENTION_ENTITY_TYPE } from './employee-mentions-state.js';

export const EMPLOYEE_MENTION_MAX_REVIEWS = 25;

export interface EmployeeMentionsDetectorInput {
	db: AppDb;
	projectId: string;
	runId?: string | null;
	signal: AbortSignal;
	maxReviews?: number;
	extract?: (input: { comment: string; locationId: string; roster: EmployeeMentionsRoster; signal: AbortSignal }) => Promise<unknown>;
}

export interface EmployeeMentionsDetectorResult {
	detectorVersion: string;
	projectId: string;
	rosterVersion: string | null;
	processed: number;
	persisted: number;
	unknownFindingsCreated: number;
	capped: number;
	aborted: boolean;
	skippedReason: 'employee_mentions_disabled' | null;
}

export async function runEmployeeMentionsDetector(input: EmployeeMentionsDetectorInput): Promise<EmployeeMentionsDetectorResult> {
	const projection = await input.db.query.projectProjections.findFirst({
		where: and(eq(projectProjections.projectId, input.projectId), eq(projectProjections.status, 'current')),
		columns: { payload: true }
	});
	let payload: unknown = null;
	try { payload = projection?.payload ? JSON.parse(projection.payload) : null; } catch { /* opt-in fail closed */ }
	const capability = parseEmployeeMentionsCapability(payload);
	if (!capability.enabled || !capability.roster) {
		return { detectorVersion: DETECTOR_EMPLOYEE_MENTIONS, projectId: input.projectId, rosterVersion: null, processed: 0, persisted: 0, unknownFindingsCreated: 0, capped: 0, aborted: input.signal.aborted, skippedReason: 'employee_mentions_disabled' };
	}
	const roster = capability.roster;
	const reviews = await input.db.select({
		id: gmbReviews.id, reviewId: gmbReviews.reviewId, locationId: gmbReviews.locationId, comment: gmbReviews.comment
	}).from(gmbReviews).where(and(eq(gmbReviews.projectId, input.projectId), isNull(gmbReviews.mentionedEmployees))).limit(Math.max(0, Math.floor(input.maxReviews ?? EMPLOYEE_MENTION_MAX_REVIEWS)));
	const extraction = await extractBoundedEmployeeMentions({
		reviews,
		maxReviews: input.maxReviews ?? EMPLOYEE_MENTION_MAX_REVIEWS,
		signal: input.signal,
		extract: (review, signal) => (input.extract ?? extractEmployeeMentionCandidates)({ comment: review.comment, locationId: review.locationId, roster, signal })
	});
	let persisted = 0;
	let unknownFindingsCreated = 0;
	for (const result of extraction.results) {
		if (input.signal.aborted) break;
		const matched = matchRosterMentions({ candidates: result.candidates, locationId: result.locationId, roster });
		const source = reviews.find((review) => review.reviewId === result.reviewId);
		if (!source) continue;
		await input.db.update(gmbReviews).set({ mentionedEmployees: JSON.stringify(matched.mentions) }).where(eq(gmbReviews.id, source.id));
		persisted += 1;
		for (const token of matched.unknownTokens) {
			const finding = buildUnknownEmployeeMentionFinding({ projectId: input.projectId, reviewId: result.reviewId, locationId: result.locationId, token, rosterVersion: roster.version });
			const upserted = await upsertFinding({ projectId: input.projectId, type: finding.type, entityType: EMPLOYEE_MENTION_ENTITY_TYPE, entityKey: result.reviewId, fingerprint: finding.fingerprint, title: finding.title, severity: finding.severity, priorityScore: 20, confidenceScore: 100, evidenceJson: JSON.stringify(finding.evidence), detectorVersion: DETECTOR_EMPLOYEE_MENTIONS, runId: input.runId ?? null }, input.db);
			if (upserted.isNew) {
				await recordFindingEvent({ findingId: upserted.id, projectId: input.projectId, eventType: 'created', toStatus: 'open', reason: 'Nom explicitement cité absent du roster versionné.', actor: 'detector', payloadJson: JSON.stringify(finding.eventPayload) }, input.db);
				unknownFindingsCreated += 1;
			}
		}
	}
	return { detectorVersion: DETECTOR_EMPLOYEE_MENTIONS, projectId: input.projectId, rosterVersion: roster.version, processed: extraction.processed, persisted, unknownFindingsCreated, capped: extraction.capped, aborted: extraction.aborted || input.signal.aborted, skippedReason: null };
}
