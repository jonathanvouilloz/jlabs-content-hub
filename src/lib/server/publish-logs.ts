import { db } from './db/index.js';
import { publishLogs } from './db/schema.js';
import { createId } from './utils.js';
import { eq, and, gte, desc } from 'drizzle-orm';

export type PublishLogSource = 'cron' | 'manual';

export interface RecordPublishLogInput {
	contentId: string;
	projectId: string;
	channel?: string;
	locationId: string | null;
	locationLabel: string | null;
	success: boolean;
	gmbPostId?: string | null;
	errorMessage?: string | null;
	durationMs?: number | null;
	source: PublishLogSource;
}

export async function recordPublishLog(input: RecordPublishLogInput): Promise<void> {
	await db.insert(publishLogs).values({
		id: createId(),
		contentId: input.contentId,
		projectId: input.projectId,
		channel: input.channel ?? 'gmb',
		locationId: input.locationId,
		locationLabel: input.locationLabel,
		success: input.success,
		gmbPostId: input.gmbPostId ?? null,
		errorMessage: input.errorMessage ?? null,
		durationMs: input.durationMs ?? null,
		source: input.source
	});
}

export async function consecutiveFailuresForLocation(
	locationId: string,
	limit = 3
): Promise<number> {
	const rows = await db
		.select()
		.from(publishLogs)
		.where(eq(publishLogs.locationId, locationId))
		.orderBy(desc(publishLogs.attemptedAt))
		.limit(limit);

	let count = 0;
	for (const r of rows) {
		if (!r.success) count++;
		else break;
	}
	return count;
}

export async function logsForProjectSince(projectId: string, sinceIso: string) {
	return db
		.select()
		.from(publishLogs)
		.where(and(eq(publishLogs.projectId, projectId), gte(publishLogs.attemptedAt, sinceIso)))
		.orderBy(desc(publishLogs.attemptedAt));
}

export async function logsForContent(contentId: string) {
	return db
		.select()
		.from(publishLogs)
		.where(eq(publishLogs.contentId, contentId))
		.orderBy(desc(publishLogs.attemptedAt));
}

export async function countLogsForContent(contentId: string): Promise<number> {
	const rows = await db
		.select({ id: publishLogs.id })
		.from(publishLogs)
		.where(eq(publishLogs.contentId, contentId));
	return rows.length;
}
