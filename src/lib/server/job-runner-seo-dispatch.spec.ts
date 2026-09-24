import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultHandlers } from './job-runner.js';
import { JOB_TYPE_DISPATCH_SEO_WEEKLY } from './seo-weekly-dispatch.js';
import type { AppDb } from './db/types.js';
import type { ClaimedJob } from './jobs-claim.js';

const payload = JSON.stringify({
	schemaVersion: 1,
	eventType: 'seo.weekly_report.published',
	eventId: 'seo-weekly:2026-08-03T09:00:r1:physiopommier',
	idempotencyKey: 'seo-weekly-dispatch:2026-08-03T09:00:r1:physiopommier',
	projectSlug: 'physiopommier',
	periodSlot: '2026-08-03T09:00',
	revision: 1,
	reportId: 'report-1',
	runId: 'run-1',
	runStatus: 'success',
	readinessState: 'ready',
	snapshotUrl:
		'https://hubseo.jonlabs.ch/api/agent/reports/2026-08-03T09%3A00/projects/physiopommier?revision=1'
});

const job = {
	id: 'job-1',
	projectId: 'project-1',
	runId: null,
	payloadJson: payload
} as ClaimedJob;

const context = {
	db: {} as AppDb,
	job,
	signal: new AbortController().signal
};

afterEach(() => vi.unstubAllGlobals());

describe('handler dispatch:seo_weekly', () => {
	it('est enregistré et transmet le payload validé au webhook configuré', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 202 }));
		vi.stubGlobal('fetch', fetchMock);
		const handler = defaultHandlers({
			hermesWebhook: { url: 'https://hermes.example/webhooks/seo', secret: 'secret' }
		}).get(JOB_TYPE_DISPATCH_SEO_WEEKLY);
		expect(handler).toBeTypeOf('function');
		await handler!(context);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('échoue explicitement quand le secret runtime manque', async () => {
		const handler = defaultHandlers().get(JOB_TYPE_DISPATCH_SEO_WEEKLY);
		await expect(handler!(context)).rejects.toMatchObject({
			code: 'HermesWebhookNotConfigured'
		});
	});
});
