import type { PublicationReadiness, ReadinessState } from './report-publication-state.js';

export const SEO_WEEKLY_DISPATCH_SCHEMA_VERSION = 1;
export const SEO_WEEKLY_DISPATCH_EVENT_TYPE = 'seo.weekly_report.published' as const;

export interface SeoWeeklyDispatchEvent {
	schemaVersion: typeof SEO_WEEKLY_DISPATCH_SCHEMA_VERSION;
	eventType: typeof SEO_WEEKLY_DISPATCH_EVENT_TYPE;
	eventId: string;
	idempotencyKey: string;
	projectSlug: string;
	periodSlot: string;
	revision: number;
	reportId: string;
	runId: string;
	runStatus: string;
	readinessState: Extract<ReadinessState, 'ready' | 'degraded'>;
	snapshotUrl: string;
}

function snapshotUrl(input: {
	baseUrl: string;
	periodSlot: string;
	projectSlug: string;
	revision: number;
}): string {
	const base = input.baseUrl.replace(/\/$/, '');
	const parsed = new URL(base);
	if (parsed.protocol !== 'https:') throw new Error('PUBLIC_APP_URL doit utiliser HTTPS');
	return `${parsed.toString().replace(/\/$/, '')}/api/agent/reports/${encodeURIComponent(input.periodSlot)}/projects/${encodeURIComponent(input.projectSlug)}?revision=${input.revision}`;
}

export class SeoWeeklyDispatchPayloadError extends Error {
	readonly code = 'InvalidSeoWeeklyDispatchPayload';

	constructor() {
		super('payload dispatch SEO hebdomadaire invalide');
		this.name = 'SeoWeeklyDispatchPayloadError';
	}
}

export function parseSeoWeeklyDispatchEvent(raw: string | null): SeoWeeklyDispatchEvent {
	let value: unknown;
	try {
		value = JSON.parse(raw ?? '');
	} catch {
		throw new SeoWeeklyDispatchPayloadError();
	}
	if (!value || typeof value !== 'object') throw new SeoWeeklyDispatchPayloadError();
	const event = value as Record<string, unknown>;
	const stringKeys = [
		'eventId',
		'idempotencyKey',
		'projectSlug',
		'periodSlot',
		'reportId',
		'runId',
		'runStatus',
		'snapshotUrl'
	] as const;
	if (
		event.schemaVersion !== SEO_WEEKLY_DISPATCH_SCHEMA_VERSION ||
		event.eventType !== SEO_WEEKLY_DISPATCH_EVENT_TYPE ||
		!Number.isInteger(event.revision) ||
		Number(event.revision) < 1 ||
		!stringKeys.every((key) => typeof event[key] === 'string' && event[key] !== '') ||
		(event.readinessState !== 'ready' && event.readinessState !== 'degraded')
	) {
		throw new SeoWeeklyDispatchPayloadError();
	}
	try {
		const snapshot = new URL(String(event.snapshotUrl));
		if (snapshot.protocol !== 'https:') throw new Error('insecure');
	} catch {
		throw new SeoWeeklyDispatchPayloadError();
	}
	return event as unknown as SeoWeeklyDispatchEvent;
}

export function buildSeoWeeklyDispatchEvents(input: {
	readiness: PublicationReadiness;
	reportId: string;
	revision: number;
	baseUrl: string;
}): SeoWeeklyDispatchEvent[] {
	return input.readiness.byProject
		.filter(
			(project): project is typeof project & {
				state: 'ready' | 'degraded';
				runId: string;
				runStatus: string;
			} =>
				(project.state === 'ready' || project.state === 'degraded') &&
				typeof project.runId === 'string' &&
				typeof project.runStatus === 'string'
		)
		.sort((a, b) => a.projectSlug.localeCompare(b.projectSlug))
		.map((project) => {
			const identity = `${input.readiness.periodSlot}:r${input.revision}:${project.projectSlug}`;
			return {
				schemaVersion: SEO_WEEKLY_DISPATCH_SCHEMA_VERSION,
				eventType: SEO_WEEKLY_DISPATCH_EVENT_TYPE,
				eventId: `seo-weekly:${identity}`,
				idempotencyKey: `seo-weekly-dispatch:${identity}`,
				projectSlug: project.projectSlug,
				periodSlot: input.readiness.periodSlot,
				revision: input.revision,
				reportId: input.reportId,
				runId: project.runId,
				runStatus: project.runStatus,
				readinessState: project.state,
				snapshotUrl: snapshotUrl({
					baseUrl: input.baseUrl,
					periodSlot: input.readiness.periodSlot,
					projectSlug: project.projectSlug,
					revision: input.revision
				})
			};
		});
}
