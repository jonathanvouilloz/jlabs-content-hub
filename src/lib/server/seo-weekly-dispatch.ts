import { inArray } from 'drizzle-orm';
import { projects } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { enqueueJob, type EnqueueJobInput, type EnqueueJobResult } from './monitoring.js';
import type { PublicationReadiness } from './report-publication-state.js';
import {
	buildSeoWeeklyDispatchEvents,
	type SeoWeeklyDispatchEvent
} from './seo-weekly-dispatch-state.js';

export const JOB_TYPE_DISPATCH_SEO_WEEKLY = 'dispatch:seo_weekly';

interface DispatchDependencies {
	loadProjectIds(slugs: string[]): Promise<Map<string, string>>;
	enqueue(input: EnqueueJobInput): Promise<EnqueueJobResult>;
}

export interface QueueSeoWeeklyDispatchesResult {
	eligible: number;
	created: number;
	existing: number;
	missingProjects: string[];
}

export async function queueSeoWeeklyDispatches(
	input: {
		enabled: boolean;
		readiness: PublicationReadiness;
		reportId: string;
		revision: number;
		baseUrl: string;
		projectAllowlist?: string[];
	},
	deps: DispatchDependencies
): Promise<QueueSeoWeeklyDispatchesResult> {
	if (!input.enabled) return { eligible: 0, created: 0, existing: 0, missingProjects: [] };

	const allowlist = input.projectAllowlist?.length
		? new Set(input.projectAllowlist.map((slug) => slug.trim()).filter(Boolean))
		: null;
	const events = buildSeoWeeklyDispatchEvents(input).filter(
		(event) => allowlist === null || allowlist.has(event.projectSlug)
	);
	if (events.length === 0) {
		return { eligible: 0, created: 0, existing: 0, missingProjects: [] };
	}

	const projectIds = await deps.loadProjectIds(events.map((event) => event.projectSlug));
	const missingProjects = events
		.filter((event) => !projectIds.has(event.projectSlug))
		.map((event) => event.projectSlug);
	const queueable = events.filter((event) => projectIds.has(event.projectSlug));
	const results = await Promise.all(
		queueable.map((event) =>
			deps.enqueue({
				projectId: projectIds.get(event.projectSlug)!,
				type: JOB_TYPE_DISPATCH_SEO_WEEKLY,
				idempotencyKey: event.idempotencyKey,
				runId: null,
				priority: 40,
				payloadJson: JSON.stringify(event satisfies SeoWeeklyDispatchEvent),
				maxAttempts: 8
			})
		)
	);

	return {
		eligible: events.length,
		created: results.filter((result) => result.created).length,
		existing: results.filter((result) => !result.created).length,
		missingProjects
	};
}

export async function queueSeoWeeklyDispatchesWithDb(input: {
	db: AppDb;
	enabled: boolean;
	readiness: PublicationReadiness;
	reportId: string;
	revision: number;
	baseUrl: string;
	projectAllowlist?: string[];
}): Promise<QueueSeoWeeklyDispatchesResult> {
	return queueSeoWeeklyDispatches(input, {
		loadProjectIds: async (slugs) => {
			const rows = await input.db
				.select({ id: projects.id, slug: projects.slug })
				.from(projects)
				.where(inArray(projects.slug, slugs));
			return new Map(rows.map((project) => [project.slug, project.id]));
		},
		enqueue: (job) => enqueueJob(job, input.db)
	});
}
