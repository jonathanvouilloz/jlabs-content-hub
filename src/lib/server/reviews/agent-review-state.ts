import { classifyAutoReply } from './auto-reply-state.js';
import { canAutoSendReview } from '../policy-state.js';

export const AGENT_REVIEW_STATUSES = [
	'eligible_auto',
	'requires_human',
	'sensitive_or_blocked',
	'already_replied',
	'write_unknown',
	'stale_or_unhealthy_location'
] as const;

export type AgentReviewStatus = (typeof AGENT_REVIEW_STATUSES)[number];

export interface AgentReviewPolicy {
	mode: string;
	autoGenerationEnabled: boolean | null;
	killSwitch: boolean | null;
	minRatingForAutoSend: number | null;
	escalationCategories: readonly string[];
}

export interface AgentReviewDecisionInput {
	rating: number;
	comment: string;
	remoteReplyText: string | null;
	lastSeenAt: string | null;
	locationLastSyncAt: string | null;
	locationLastSyncStatus: string | null;
	proposalState?: string | null;
	policy?: AgentReviewPolicy | null;
	now?: Date;
	freshnessHours?: number;
}

export interface AgentReviewDecision {
	status: AgentReviewStatus;
	autoPublishable: boolean;
	reasons: string[];
}

function parseTimestamp(value: string | null): number | null {
	if (!value) return null;
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
		? `${value.replace(' ', 'T')}Z`
		: value;
	const parsed = Date.parse(normalized);
	return Number.isNaN(parsed) ? null : parsed;
}

export function classifyAgentReview(input: AgentReviewDecisionInput): AgentReviewDecision {
	if (input.proposalState === 'write_unknown') {
		return { status: 'write_unknown', autoPublishable: false, reasons: ['publication_state_write_unknown'] };
	}
	if (input.remoteReplyText !== null) {
		return { status: 'already_replied', autoPublishable: false, reasons: ['remote_reply_exists'] };
	}

	const nowMs = (input.now ?? new Date()).getTime();
	const syncMs = parseTimestamp(input.locationLastSyncAt);
	const seenMs = parseTimestamp(input.lastSeenAt);
	const freshnessMs = (input.freshnessHours ?? 48) * 3_600_000;
	if (
		input.locationLastSyncStatus !== 'success' ||
		syncMs === null ||
		seenMs === null ||
		nowMs - syncMs > freshnessMs ||
		seenMs < syncMs
	) {
		return {
			status: 'stale_or_unhealthy_location',
			autoPublishable: false,
			reasons: ['location_or_review_not_fresh']
		};
	}

	const content = classifyAutoReply({ rating: input.rating, comment: input.comment });
	if (content.category === 'sensitive') {
		return { status: 'sensitive_or_blocked', autoPublishable: false, reasons: [content.reason] };
	}
	if (input.rating <= 3) {
		return { status: 'requires_human', autoPublishable: false, reasons: ['rating_below_auto_policy'] };
	}
	if (!input.policy) {
		return { status: 'sensitive_or_blocked', autoPublishable: false, reasons: ['policy_missing'] };
	}

	const policy = canAutoSendReview({
		mode: input.policy.mode,
		killSwitch: input.policy.killSwitch,
		autoGenerationEnabled: input.policy.autoGenerationEnabled,
		rating: input.rating,
		minRatingForAutoSend: input.policy.minRatingForAutoSend,
		category: content.category,
		escalationCategories: input.policy.escalationCategories
	});
	if (!policy.allowed) {
		return { status: 'sensitive_or_blocked', autoPublishable: false, reasons: [policy.reason] };
	}

	return { status: 'eligible_auto', autoPublishable: true, reasons: [content.reason] };
}

export interface ReviewCursor {
	version: 1;
	createTime: string;
	reviewId: string;
}

export function encodeReviewCursor(cursor: Omit<ReviewCursor, 'version'>): string {
	return Buffer.from(JSON.stringify({ version: 1, ...cursor }), 'utf8').toString('base64url');
}

export function decodeReviewCursor(raw: string | null): ReviewCursor | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<ReviewCursor>;
		if (value.version !== 1 || typeof value.createTime !== 'string' || typeof value.reviewId !== 'string') {
			return null;
		}
		return value as ReviewCursor;
	} catch {
		return null;
	}
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23'
	}).formatToParts(date);
	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	const asUtc = Date.UTC(
		Number(values.year),
		Number(values.month) - 1,
		Number(values.day),
		Number(values.hour),
		Number(values.minute),
		Number(values.second)
	);
	return asUtc - date.getTime();
}

function zonedMidnightUtc(year: number, month: number, timeZone: string): Date {
	const guess = new Date(Date.UTC(year, month - 1, 1));
	let utcMs = guess.getTime() - timeZoneOffsetMs(guess, timeZone);
	const refined = new Date(utcMs);
	utcMs = guess.getTime() - timeZoneOffsetMs(refined, timeZone);
	return new Date(utcMs);
}

export interface MonthlyWindow {
	period: string;
	timezone: 'Europe/Zurich';
	fromInclusive: string;
	toExclusive: string;
}

export function europeZurichMonthWindow(period: string): MonthlyWindow {
	const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
	if (!match) throw new Error('period must use YYYY-MM');
	const year = Number(match[1]);
	const month = Number(match[2]);
	const nextYear = month === 12 ? year + 1 : year;
	const nextMonth = month === 12 ? 1 : month + 1;
	return {
		period,
		timezone: 'Europe/Zurich',
		fromInclusive: zonedMidnightUtc(year, month, 'Europe/Zurich').toISOString(),
		toExclusive: zonedMidnightUtc(nextYear, nextMonth, 'Europe/Zurich').toISOString()
	};
}

export function parseEscalationCategories(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
	} catch {
		return [];
	}
}
