import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, lt, or } from 'drizzle-orm';
import type { AppDb } from '../db/types.js';
import {
	gmbReviews,
	projectGmbLocations,
	projectProjections,
	projects,
	reviewAutomationPolicies,
	reviewMentionCandidates,
	reviewMonthlyReports,
	reviewReplyDeliveries,
	reviewReplyDeliveryEvents,
	reviewReplyProposals
} from '../db/schema.js';
import { createId } from '../utils.js';
import { toDbTimestamp } from '../timestamps.js';
import { buildAgentMentionCandidate } from './agent-mention-state.js';
import { classifyAutoReply } from './auto-reply-state.js';
import {
	buildReviewReplyCandidate,
	buildReviewSnapshotHash
} from './review-reply-candidate-state.js';
import {
	applyProjectionGate,
	classifyAgentReview,
	encodeReviewCursor,
	europeZurichMonthWindow,
	parseEscalationCategories,
	type AgentReviewPolicy,
	type ReviewCursor
} from './agent-review-state.js';
import { parseReviewReplyContext, type ProjectionStatus } from './review-reply-context-state.js';
import {
	publishReviewReply,
	runIdempotentReviewPublication,
	type ReviewReplyDeliveryEvent,
	type ReviewReplyPublishResult
} from './review-reply-publisher.js';
import { decideReviewReplyPublication, type RemoteReviewSnapshot } from './review-reply-publisher-state.js';

export class AgentReviewApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message = code
	) {
		super(message);
	}
}

function stableHash(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function requireProject(db: AppDb, slug: string) {
	const project = await db.query.projects.findFirst({
		columns: { id: true, slug: true, name: true, archived: true },
		where: eq(projects.slug, slug)
	});
	if (!project || project.archived) throw new AgentReviewApiError(404, 'project_not_found');
	return project;
}

function effectivePolicy(
	rows: Array<typeof reviewAutomationPolicies.$inferSelect>,
	locationId: string
): { row: typeof reviewAutomationPolicies.$inferSelect; policy: AgentReviewPolicy } | null {
	const local = rows.find((row) => row.scopeKey === locationId);
	const global = rows.find((row) => row.scopeKey === '*');
	const row = local ?? global;
	if (!row) return null;
	return {
		row,
		policy: {
			mode: row.mode,
			autoGenerationEnabled: row.autoGenerationEnabled,
			killSwitch: Boolean(local?.killSwitch) || Boolean(global?.killSwitch),
			minRatingForAutoSend: row.minRatingForAutoSend,
			escalationCategories: parseEscalationCategories(row.escalationCategoriesJson)
		}
	};
}

function projectionFailure(
	projection: typeof projectProjections.$inferSelect | null | undefined,
	locationId: string
): string | null {
	if (!projection) return 'context_missing';
	let payload: unknown;
	try {
		payload = JSON.parse(projection.payload);
	} catch {
		return 'context_invalid';
	}
	const result = parseReviewReplyContext(
		payload,
		locationId,
		projection.status as ProjectionStatus
	);
	return result.ok ? null : result.reason;
}

export async function listAgentReviews(input: {
	db: AppDb;
	projectSlug: string;
	limit: number;
	cursor: ReviewCursor | null;
	now?: Date;
}) {
	const project = await requireProject(input.db, input.projectSlug);
	const limit = Math.min(100, Math.max(1, Math.floor(input.limit || 50)));
	const cursorFilter = input.cursor
		? or(
				lt(gmbReviews.createTime, input.cursor.createTime),
				and(
					eq(gmbReviews.createTime, input.cursor.createTime),
					lt(gmbReviews.reviewId, input.cursor.reviewId)
				)
			)
		: undefined;

	const rows = await input.db
		.select({ review: gmbReviews, location: projectGmbLocations })
		.from(gmbReviews)
		.leftJoin(
			projectGmbLocations,
			and(
				eq(projectGmbLocations.projectId, gmbReviews.projectId),
				eq(projectGmbLocations.gmbLocationId, gmbReviews.locationId)
			)
		)
		.where(and(eq(gmbReviews.projectId, project.id), cursorFilter))
		.orderBy(desc(gmbReviews.createTime), desc(gmbReviews.reviewId))
		.limit(limit + 1);

	const page = rows.slice(0, limit);
	const reviewIds = page.map(({ review }) => review.reviewId);
	const [proposalRows, policyRows, projection] = await Promise.all([
		reviewIds.length === 0
			? Promise.resolve([])
			: input.db
					.select()
					.from(reviewReplyProposals)
					.where(and(eq(reviewReplyProposals.projectId, project.id), inArray(reviewReplyProposals.reviewId, reviewIds)))
					.orderBy(desc(reviewReplyProposals.createdAt), desc(reviewReplyProposals.id)),
		input.db
			.select()
			.from(reviewAutomationPolicies)
			.where(and(eq(reviewAutomationPolicies.projectId, project.id), eq(reviewAutomationPolicies.status, 'current'))),
		input.db.query.projectProjections.findFirst({
			where: and(eq(projectProjections.projectId, project.id), eq(projectProjections.status, 'current'))
		})
	]);
	const latestProposal = new Map<string, typeof reviewReplyProposals.$inferSelect>();
	for (const proposal of proposalRows) {
		if (!latestProposal.has(proposal.reviewId)) latestProposal.set(proposal.reviewId, proposal);
	}

	const data = page.map(({ review, location }) => {
		const proposal = latestProposal.get(review.reviewId) ?? null;
		const policy = effectivePolicy(policyRows, review.locationId);
		const decision = applyProjectionGate(classifyAgentReview({
			rating: review.rating,
			comment: review.comment,
			remoteReplyText: review.remoteReplyText,
			lastSeenAt: review.lastSeenAt,
			locationLastSyncAt: location?.lastSyncAt ?? null,
			locationLastSyncStatus: location?.lastSyncStatus ?? null,
			proposalState: proposal?.state,
			policy: policy?.policy,
			now: input.now
		}), projectionFailure(projection, review.locationId));
		return {
			reviewId: review.reviewId,
			/** URL Google officielle (Review.reviewReplyUrl), null avant le prochain sync/backfill. */
			googleReviewUrl: review.reviewReplyUrl,
			snapshot: buildReviewSnapshotHash({
				projectId: project.id,
				reviewId: review.reviewId,
				locationId: review.locationId,
				rating: review.rating,
				comment: review.comment,
				remoteUpdateAt: review.remoteUpdateAt
			}),
			location: { id: review.locationId, label: review.locationLabel },
			rating: review.rating,
			googleCreatedAt: review.createTime,
			text: review.comment,
			remoteReply: review.remoteReplyText === null
				? null
				: { text: review.remoteReplyText, updatedAt: review.remoteReplyAt },
			state: {
				local: proposal?.state ?? (review.repliedAt ? 'legacy_local_replied' : 'none'),
				distant: review.remoteReplyText !== null ? 'replied' : review.lastSeenAt ? 'unreplied' : 'unknown',
				lastSeenAt: review.lastSeenAt,
				locationLastSyncAt: location?.lastSyncAt ?? null,
				locationLastSyncStatus: location?.lastSyncStatus ?? null
			},
			decision
		};
	});
	const last = page.at(-1)?.review;
	return {
		project: { slug: project.slug, name: project.name },
		freshness: { generatedAt: (input.now ?? new Date()).toISOString(), maxLocationAgeHours: 48 },
		data,
		page: {
			limit,
			hasMore: rows.length > limit,
			nextCursor: rows.length > limit && last
				? encodeReviewCursor({ createTime: last.createTime, reviewId: last.reviewId })
				: null
		}
	};
}

export async function proposeAgentReviewReply(input: {
	db: AppDb;
	projectSlug: string;
	reviewId: string;
	reviewSnapshot: string;
	replyText: string;
	language: string;
	idempotencyKey: string;
	actor: string;
	now?: Date;
}) {
	const project = await requireProject(input.db, input.projectSlug);
	const [review] = await input.db
		.select({ review: gmbReviews, location: projectGmbLocations })
		.from(gmbReviews)
		.leftJoin(
			projectGmbLocations,
			and(
				eq(projectGmbLocations.projectId, gmbReviews.projectId),
				eq(projectGmbLocations.gmbLocationId, gmbReviews.locationId)
			)
		)
		.where(and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, input.reviewId)))
		.limit(1);
	if (!review) throw new AgentReviewApiError(404, 'review_not_found');

	const currentSnapshot = buildReviewSnapshotHash({
		projectId: project.id,
		reviewId: review.review.reviewId,
		locationId: review.review.locationId,
		rating: review.review.rating,
		comment: review.review.comment,
		remoteUpdateAt: review.review.remoteUpdateAt
	});
	if (currentSnapshot !== input.reviewSnapshot) {
		throw new AgentReviewApiError(409, 'snapshot_changed');
	}

	const [projection, policyRows] = await Promise.all([
		input.db.query.projectProjections.findFirst({
			where: and(eq(projectProjections.projectId, project.id), eq(projectProjections.status, 'current'))
		}),
		input.db
			.select()
			.from(reviewAutomationPolicies)
			.where(and(eq(reviewAutomationPolicies.projectId, project.id), eq(reviewAutomationPolicies.status, 'current')))
	]);
	const policy = effectivePolicy(policyRows, review.review.locationId);
	const candidate = buildReviewReplyCandidate({
		projectId: project.id,
		reviewId: review.review.reviewId,
		locationId: review.review.locationId,
		rating: review.review.rating,
		comment: review.review.comment,
		remoteUpdateAt: review.review.remoteUpdateAt,
		replyText: input.replyText,
		language: input.language,
		projectionHash: projection?.sourceHash ?? 'missing',
		policyHash: policy?.row.policyHash ?? 'missing',
		policyVersion: policy?.row.version ?? 0
	});
	const decision = applyProjectionGate(classifyAgentReview({
		rating: review.review.rating,
		comment: review.review.comment,
		remoteReplyText: review.review.remoteReplyText,
		lastSeenAt: review.review.lastSeenAt,
		locationLastSyncAt: review.location?.lastSyncAt ?? null,
		locationLastSyncStatus: review.location?.lastSyncStatus ?? null,
		policy: policy?.policy,
		now: input.now
	}), projectionFailure(projection, review.review.locationId));
	const state = decision.autoPublishable && projection ? 'gated_pass' : 'held';
	const id = createId();
	const inserted = await input.db
		.insert(reviewReplyProposals)
		.values({
			id,
			projectId: project.id,
			reviewId: candidate.reviewId,
			locationId: candidate.locationId,
			reviewSnapshotHash: candidate.reviewSnapshotHash,
			reviewRating: candidate.rating,
			reviewComment: candidate.comment,
			remoteUpdateAt: candidate.remoteUpdateAt,
			proposalHash: candidate.proposalHash,
			replyText: candidate.replyText,
			language: candidate.language,
			projectionId: projection?.id ?? null,
			projectionHash: candidate.projectionHash,
			policyId: policy?.row.id ?? null,
			policyVersion: candidate.policyVersion,
			policyHash: candidate.policyHash,
			idempotencyKey: input.idempotencyKey,
			requestedBy: input.actor,
			gateStatus: state === 'gated_pass' ? 'passed' : 'held',
			gateReasonsJson: JSON.stringify(decision.reasons),
			state
		})
		.onConflictDoNothing()
		.returning();

	if (inserted[0]) return { proposal: inserted[0], idempotent: false, decision };
	const existingByKey = await input.db.query.reviewReplyProposals.findFirst({
		where: and(
			eq(reviewReplyProposals.projectId, project.id),
			eq(reviewReplyProposals.idempotencyKey, input.idempotencyKey)
		)
	});
	if (existingByKey) {
		if (existingByKey.proposalHash !== candidate.proposalHash) {
			throw new AgentReviewApiError(409, 'idempotency_key_reused');
		}
		return { proposal: existingByKey, idempotent: true, decision };
	}
	throw new AgentReviewApiError(409, 'review_has_live_proposal');
}

export async function submitAgentMentionCandidates(input: {
	db: AppDb;
	projectSlug: string;
	reviewId: string;
	idempotencyKey: string;
	actor: string;
	candidates: Array<{
		token: string;
		sentiment: 'positive' | 'neutral' | 'negative';
		evidence: string;
		confidence: number;
		rosterVersion?: string | null;
	}>;
}) {
	const project = await requireProject(input.db, input.projectSlug);
	const review = await input.db.query.gmbReviews.findFirst({
		where: and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, input.reviewId))
	});
	if (!review) throw new AgentReviewApiError(404, 'review_not_found');
	const created: Array<typeof reviewMentionCandidates.$inferSelect> = [];
	for (const [index, candidate] of input.candidates.entries()) {
		const key = `${input.idempotencyKey}:${index}`;
		const record = buildAgentMentionCandidate(candidate);
		const inserted = await input.db
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
		if (inserted[0]) {
			created.push(inserted[0]);
			continue;
		}
		const existing = await input.db.query.reviewMentionCandidates.findFirst({
			where: and(
				eq(reviewMentionCandidates.projectId, project.id),
				eq(reviewMentionCandidates.idempotencyKey, key)
			)
		});
		if (existing) created.push(existing);
	}
	return created.map((row) => ({
		id: row.id,
		reviewId: row.reviewId,
		token: row.detectedToken,
		sentiment: row.sentiment,
		evidence: row.evidence,
		confidence: row.confidence,
		status: row.status,
		createdAt: row.createdAt
	}));
}

function parseValidatedMentions(raw: string | null): Array<{ name: string; sentiment: string }> {
	if (!raw) return [];
	try {
		const value = JSON.parse(raw);
		if (!Array.isArray(value)) return [];
		return value.flatMap((item) => {
			if (!item || typeof item !== 'object') return [];
			const mention = item as { name?: unknown; sentiment?: unknown };
			return typeof mention.name === 'string' && typeof mention.sentiment === 'string'
				? [{ name: mention.name, sentiment: mention.sentiment }]
				: [];
		});
	} catch {
		return [];
	}
}

export async function buildAgentMonthlyReviewReport(input: {
	db: AppDb;
	projectSlug: string;
	period: string;
}) {
	const project = await requireProject(input.db, input.projectSlug);
	const window = europeZurichMonthWindow(input.period);
	const reviews = await input.db
		.select()
		.from(gmbReviews)
		.where(and(
			eq(gmbReviews.projectId, project.id),
			gte(gmbReviews.createTime, window.fromInclusive),
			lt(gmbReviews.createTime, window.toExclusive)
		))
		.orderBy(gmbReviews.createTime, gmbReviews.reviewId);
	const reviewIds = reviews.map((review) => review.reviewId);
	const [proposals, candidates, artifacts] = await Promise.all([
		reviewIds.length === 0
			? Promise.resolve([])
			: input.db.select().from(reviewReplyProposals).where(and(
				eq(reviewReplyProposals.projectId, project.id),
				inArray(reviewReplyProposals.reviewId, reviewIds)
			)),
		reviewIds.length === 0
			? Promise.resolve([])
			: input.db.select().from(reviewMentionCandidates).where(and(
				eq(reviewMentionCandidates.projectId, project.id),
				inArray(reviewMentionCandidates.reviewId, reviewIds),
				eq(reviewMentionCandidates.status, 'candidate')
			)),
		input.db
			.select()
			.from(reviewMonthlyReports)
			.where(and(
				eq(reviewMonthlyReports.projectId, project.id),
				eq(reviewMonthlyReports.periodKey, input.period)
			))
			.orderBy(desc(reviewMonthlyReports.revision))
	]);
	const ratingCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<number, number>;
	const locations = new Map<string, { reviews: number; ratingTotal: number }>();
	const validatedMentions: Array<{ reviewId: string; name: string; sentiment: string }> = [];
	let sensitive = 0;
	for (const review of reviews) {
		ratingCounts[review.rating] = (ratingCounts[review.rating] ?? 0) + 1;
		const location = locations.get(review.locationLabel) ?? { reviews: 0, ratingTotal: 0 };
		location.reviews += 1;
		location.ratingTotal += review.rating;
		locations.set(review.locationLabel, location);
		for (const mention of parseValidatedMentions(review.mentionedEmployees)) {
			validatedMentions.push({ reviewId: review.reviewId, ...mention });
		}
		if (classifyAutoReply({ rating: review.rating, comment: review.comment }).category === 'sensitive') {
			sensitive += 1;
		}
	}
	const verifiedReviewIds = new Set(
		proposals.filter((proposal) => proposal.state === 'verified').map((proposal) => proposal.reviewId)
	);
	const writeUnknown = proposals.filter((proposal) => proposal.state === 'write_unknown').length;
	const payload = {
		contractVersion: 1,
		project: { slug: project.slug, name: project.name },
		period: window,
		summary: {
			reviews: reviews.length,
			averageRating: reviews.length === 0
				? 0
				: reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length,
			ratingCounts,
			verifiedReplies: verifiedReviewIds.size,
			alerts: {
				ratingsOneToThree: reviews.filter((review) => review.rating <= 3).length,
				sensitive,
				writeUnknown
			},
			validatedMentions: validatedMentions.length,
			unresolvedMentionCandidates: candidates.length
		},
		locations: [...locations.entries()].map(([label, value]) => ({
			label,
			reviews: value.reviews,
			averageRating: value.reviews === 0 ? 0 : value.ratingTotal / value.reviews
		})),
		validatedMentions,
		unresolvedCandidates: candidates.map((candidate) => ({
			id: candidate.id,
			reviewId: candidate.reviewId,
			token: candidate.detectedToken,
			sentiment: candidate.sentiment,
			evidence: candidate.evidence,
			confidence: candidate.confidence,
			status: candidate.status
		}))
	};
	return {
		payload,
		artifact: artifacts[0]
			? {
					id: artifacts[0].id,
					revision: artifacts[0].revision,
					payloadHash: artifacts[0].payloadHash,
					createdAt: artifacts[0].createdAt
				}
			: null
	};
}

export async function closeAgentMonthlyReviewReport(input: {
	db: AppDb;
	projectSlug: string;
	period: string;
	actor: string;
}) {
	const project = await requireProject(input.db, input.projectSlug);
	const report = await buildAgentMonthlyReviewReport(input);
	const payloadJson = JSON.stringify(report.payload);
	const payloadHash = stableHash(report.payload);
	const existing = await input.db.query.reviewMonthlyReports.findFirst({
		where: and(
			eq(reviewMonthlyReports.projectId, project.id),
			eq(reviewMonthlyReports.periodKey, input.period),
			eq(reviewMonthlyReports.payloadHash, payloadHash)
		)
	});
	if (existing) return { artifact: existing, idempotent: true };
	const latest = await input.db.query.reviewMonthlyReports.findFirst({
		where: and(
			eq(reviewMonthlyReports.projectId, project.id),
			eq(reviewMonthlyReports.periodKey, input.period)
		),
		orderBy: desc(reviewMonthlyReports.revision)
	});
	const inserted = await input.db
		.insert(reviewMonthlyReports)
		.values({
			id: createId(),
			projectId: project.id,
			periodKey: input.period,
			timezone: 'Europe/Zurich',
			revision: (latest?.revision ?? 0) + 1,
			payloadJson,
			payloadHash,
			supersedesId: latest?.id ?? null,
			createdBy: input.actor
		})
		.onConflictDoNothing()
		.returning();
	if (inserted[0]) return { artifact: inserted[0], idempotent: false };
	const raced = await input.db.query.reviewMonthlyReports.findFirst({
		where: and(
			eq(reviewMonthlyReports.projectId, project.id),
			eq(reviewMonthlyReports.periodKey, input.period),
			eq(reviewMonthlyReports.payloadHash, payloadHash)
		)
	});
	if (!raced) throw new AgentReviewApiError(409, 'monthly_report_revision_conflict');
	return { artifact: raced, idempotent: true };
}

function publishResultFromDelivery(delivery: typeof reviewReplyDeliveries.$inferSelect): ReviewReplyPublishResult {
	if (delivery.state === 'verified') return { state: 'verified' };
	if (delivery.state === 'conflict') {
		return {
			state: 'conflict',
			reason: delivery.errorClass === 'snapshot_changed'
				? 'snapshot_changed'
				: delivery.errorClass === 'review_missing'
					? 'review_missing'
					: 'remote_reply_differs'
		};
	}
	return { state: 'write_unknown', error: delivery.errorMessage ?? `publication_${delivery.state}` };
}

async function applyDeliveryEvent(input: {
	db: AppDb;
	deliveryId: string;
	projectId: string;
	proposalId: string;
	reviewId: string;
	replyText: string;
	event: ReviewReplyDeliveryEvent;
}) {
	const now = toDbTimestamp();
	await input.db.insert(reviewReplyDeliveryEvents).values({
		id: createId(),
		deliveryId: input.deliveryId,
		proposalId: input.proposalId,
		projectId: input.projectId,
		state: input.event.state,
		detailJson: JSON.stringify({ error: input.event.error, reason: input.event.reason })
	});
	await input.db
		.update(reviewReplyDeliveries)
		.set({
			state: input.event.state,
			errorClass: input.event.reason ?? null,
			errorMessage: input.event.error ?? null,
			remoteReplyText: input.event.remote?.kind === 'present' ? input.event.remote.replyText : null,
			remoteReplyAt: input.event.remote?.kind === 'present' ? input.event.remote.replyAt ?? null : null,
			verifiedAt: input.event.state === 'verified' ? now : null,
			updatedAt: now
		})
		.where(eq(reviewReplyDeliveries.id, input.deliveryId));

	const proposalState = input.event.state === 'sent'
		? null
		: input.event.state;
	if (proposalState) {
		await input.db
			.update(reviewReplyProposals)
			.set({
				state: proposalState,
				reservedAt: proposalState === 'reserved' ? now : undefined,
				sentAt: input.event.state === 'sent' ? now : undefined,
				verifiedAt: proposalState === 'verified' ? now : undefined,
				updatedAt: now
			})
			.where(eq(reviewReplyProposals.id, input.proposalId));
	}
	if (input.event.state === 'verified' && input.event.remote?.kind === 'present') {
		await input.db
			.update(gmbReviews)
			.set({
				repliedAt: now,
				remoteReplyText: input.replyText,
				remoteReplyAt: input.event.remote.replyAt ?? now,
				remoteUpdateAt: input.event.remote.updateAt ?? undefined,
				lastSeenAt: now
			})
			.where(and(eq(gmbReviews.projectId, input.projectId), eq(gmbReviews.reviewId, input.reviewId)));
	}
}

export async function publishAgentReviewReply(input: {
	db: AppDb;
	projectSlug: string;
	proposalId: string;
	idempotencyKey: string;
	loadRemote: () => Promise<RemoteReviewSnapshot>;
	putReply: (replyText: string) => Promise<void>;
	now?: Date;
}) {
	const project = await requireProject(input.db, input.projectSlug);
	const proposal = await input.db.query.reviewReplyProposals.findFirst({
		where: and(
			eq(reviewReplyProposals.id, input.proposalId),
			eq(reviewReplyProposals.projectId, project.id)
		)
	});
	if (!proposal) throw new AgentReviewApiError(404, 'proposal_not_found');
	if (proposal.state === 'verified') return { result: { state: 'verified' } as const, idempotent: true };
	if (proposal.state === 'write_unknown') throw new AgentReviewApiError(409, 'reconciliation_required');
	if (!['gated_pass', 'retry_eligible'].includes(proposal.state)) {
		throw new AgentReviewApiError(409, 'proposal_not_publishable');
	}

	const [review] = await input.db
		.select({ review: gmbReviews, location: projectGmbLocations })
		.from(gmbReviews)
		.leftJoin(
			projectGmbLocations,
			and(
				eq(projectGmbLocations.projectId, gmbReviews.projectId),
				eq(projectGmbLocations.gmbLocationId, gmbReviews.locationId)
			)
		)
		.where(and(eq(gmbReviews.projectId, project.id), eq(gmbReviews.reviewId, proposal.reviewId)))
		.limit(1);
	if (!review) throw new AgentReviewApiError(404, 'review_not_found');
	const currentSnapshot = buildReviewSnapshotHash({
		projectId: project.id,
		reviewId: review.review.reviewId,
		locationId: review.review.locationId,
		rating: review.review.rating,
		comment: review.review.comment,
		remoteUpdateAt: review.review.remoteUpdateAt
	});
	if (currentSnapshot !== proposal.reviewSnapshotHash) throw new AgentReviewApiError(409, 'snapshot_changed');

	const [policyRows, projection] = await Promise.all([
		input.db
			.select()
			.from(reviewAutomationPolicies)
			.where(and(eq(reviewAutomationPolicies.projectId, project.id), eq(reviewAutomationPolicies.status, 'current'))),
		input.db.query.projectProjections.findFirst({
			where: and(eq(projectProjections.projectId, project.id), eq(projectProjections.status, 'current'))
		})
	]);
	const policy = effectivePolicy(policyRows, review.review.locationId);
	const decision = applyProjectionGate(classifyAgentReview({
		rating: review.review.rating,
		comment: review.review.comment,
		remoteReplyText: review.review.remoteReplyText,
		lastSeenAt: review.review.lastSeenAt,
		locationLastSyncAt: review.location?.lastSyncAt ?? null,
		locationLastSyncStatus: review.location?.lastSyncStatus ?? null,
		policy: policy?.policy,
		now: input.now
	}), projectionFailure(projection, review.review.locationId));
	if (!decision.autoPublishable) throw new AgentReviewApiError(409, decision.status);
	if (policy?.row.id !== proposal.policyId || policy.row.policyHash !== proposal.policyHash) {
		throw new AgentReviewApiError(409, 'policy_changed');
	}
	if (!projection || projection.id !== proposal.projectionId || projection.sourceHash !== proposal.projectionHash) {
		throw new AgentReviewApiError(409, 'projection_changed');
	}

	const deliveryId = createId();
	return runIdempotentReviewPublication({
		reserve: async () => {
			const inserted = await input.db
				.insert(reviewReplyDeliveries)
				.values({
					id: deliveryId,
					proposalId: proposal.id,
					projectId: project.id,
					effectKey: input.idempotencyKey,
					state: 'reserved',
					outboundBodyHash: stableHash({ replyText: proposal.replyText })
				})
				.onConflictDoNothing()
				.returning();
			if (inserted[0]) return { acquired: true } as const;
			const existing = await input.db.query.reviewReplyDeliveries.findFirst({
				where: and(
					eq(reviewReplyDeliveries.projectId, project.id),
					eq(reviewReplyDeliveries.effectKey, input.idempotencyKey)
				)
			});
			if (!existing || existing.proposalId !== proposal.id) {
				throw new AgentReviewApiError(409, 'idempotency_key_reused');
			}
			return { acquired: false, result: publishResultFromDelivery(existing) } as const;
		},
		execute: async () => {
			await input.db
				.update(reviewReplyProposals)
				.set({
					state: proposal.state === 'gated_pass' ? 'scheduled' : proposal.state,
					scheduledAt: proposal.state === 'gated_pass' ? toDbTimestamp(input.now) : proposal.scheduledAt,
					updatedAt: toDbTimestamp(input.now)
				})
				.where(eq(reviewReplyProposals.id, proposal.id));
			return publishReviewReply({
				proposal: {
					id: proposal.id,
					projectId: project.id,
					reviewId: proposal.reviewId,
					locationId: proposal.locationId,
					rating: proposal.reviewRating,
					comment: proposal.reviewComment,
					remoteUpdateAt: proposal.remoteUpdateAt,
					reviewSnapshotHash: proposal.reviewSnapshotHash,
					replyText: proposal.replyText
				},
				loadRemote: input.loadRemote,
				putReply: input.putReply,
				record: (event) => applyDeliveryEvent({
					db: input.db,
					deliveryId,
					projectId: project.id,
					proposalId: proposal.id,
					reviewId: proposal.reviewId,
					replyText: proposal.replyText,
					event
				})
			});
		}
	});
}

export async function reconcileAgentReviewReply(input: {
	db: AppDb;
	projectSlug: string;
	proposalId: string;
	loadRemote: () => Promise<RemoteReviewSnapshot>;
}) {
	const project = await requireProject(input.db, input.projectSlug);
	const proposal = await input.db.query.reviewReplyProposals.findFirst({
		where: and(
			eq(reviewReplyProposals.id, input.proposalId),
			eq(reviewReplyProposals.projectId, project.id)
		)
	});
	if (!proposal) throw new AgentReviewApiError(404, 'proposal_not_found');
	if (proposal.state === 'verified' || proposal.state === 'conflict') {
		return { state: proposal.state, idempotent: true };
	}
	if (proposal.state !== 'write_unknown') throw new AgentReviewApiError(409, 'proposal_not_reconcilable');
	const delivery = await input.db.query.reviewReplyDeliveries.findFirst({
		where: and(
			eq(reviewReplyDeliveries.projectId, project.id),
			eq(reviewReplyDeliveries.proposalId, proposal.id)
		),
		orderBy: desc(reviewReplyDeliveries.createdAt)
	});
	if (!delivery) throw new AgentReviewApiError(409, 'delivery_missing');
	const remote = await input.loadRemote();
	const decision = decideReviewReplyPublication({ proposal, remote });
	const state = decision.action === 'verified'
		? 'verified'
		: decision.action === 'conflict'
			? 'conflict'
			: 'retry_eligible';
	await applyDeliveryEvent({
		db: input.db,
		deliveryId: delivery.id,
		projectId: project.id,
		proposalId: proposal.id,
		reviewId: proposal.reviewId,
		replyText: proposal.replyText,
			event: {
			proposalId: proposal.id,
			state,
			reason: decision.action === 'conflict' ? decision.reason : undefined,
			remote
		}
	});
	return { state, idempotent: false };
}
