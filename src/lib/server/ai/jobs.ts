import { db } from '$lib/server/db/index.js';
import { aiJobs } from '$lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createId } from '$lib/server/utils.js';

export type JobType = 'review-replies' | 'monthly-report' | 'gsc-snapshot' | 'gsc-backfill';
export type JobStatus = 'pending' | 'running' | 'done' | 'error';

export interface AiJob {
	id: string;
	projectId: string;
	type: JobType;
	status: JobStatus;
	result: unknown | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
}

export async function createJob(projectId: string, type: JobType): Promise<AiJob> {
	const id = createId();
	const now = new Date().toISOString();
	await db.insert(aiJobs).values({ id, projectId, type, status: 'pending', createdAt: now, updatedAt: now });
	return { id, projectId, type, status: 'pending', result: null, error: null, createdAt: now, updatedAt: now };
}

export async function getJob(id: string): Promise<AiJob | null> {
	const row = await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, id) });
	if (!row) return null;
	return {
		...row,
		type: row.type as JobType,
		status: row.status as JobStatus,
		result: row.result ? JSON.parse(row.result) : null
	};
}

export async function updateJob(
	id: string,
	patch: { status: JobStatus; result?: unknown; error?: string }
): Promise<void> {
	await db
		.update(aiJobs)
		.set({
			status: patch.status,
			...(patch.result !== undefined ? { result: JSON.stringify(patch.result) } : {}),
			...(patch.error !== undefined ? { error: patch.error } : {}),
			updatedAt: new Date().toISOString()
		})
		.where(eq(aiJobs.id, id));
}
