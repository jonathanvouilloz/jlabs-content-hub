import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deliverHermesWebhook } from './hermes-webhook.js';
import type { SeoWeeklyDispatchEvent } from './seo-weekly-dispatch-state.js';

const event: SeoWeeklyDispatchEvent = {
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
};

describe('Hermes webhook delivery', () => {
	it('envoie le JSON exact avec une signature HMAC-SHA256 vérifiable', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
		await deliverHermesWebhook({
			event,
			url: 'https://hermes.example/webhooks/seo',
			secret: 'test-secret',
			fetchImpl,
			now: () => new Date('2026-08-06T12:00:00Z')
		});

		const [url, init] = fetchImpl.mock.calls[0];
		const body = init.body as string;
		const timestamp = String(Date.parse('2026-08-06T12:00:00Z') / 1000);
		expect(url).toBe('https://hermes.example/webhooks/seo');
		expect(JSON.parse(body)).toEqual(event);
		expect(init.headers['content-type']).toBe('application/json');
		expect(init.headers['x-github-event']).toBe(event.eventType);
		expect(init.headers['x-request-id']).toBe(event.eventId);
		expect(init.headers['x-webhook-timestamp']).toBe(timestamp);
		expect(init.headers['x-webhook-signature-v2']).toBe(
			createHmac('sha256', 'test-secret').update(`${timestamp}.${body}`).digest('hex')
		);
	});

	it('refuse une configuration absente sans lancer de requête', async () => {
		const fetchImpl = vi.fn();
		await expect(
			deliverHermesWebhook({ event, url: '', secret: '', fetchImpl })
		).rejects.toMatchObject({ code: 'HermesWebhookNotConfigured' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('rend les réponses non-2xx classifiables par la queue', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response('temporarily unavailable', { status: 503 }));
		await expect(
			deliverHermesWebhook({
				event,
				url: 'https://hermes.example/webhooks/seo',
				secret: 'test-secret',
				fetchImpl
			})
		).rejects.toEqual(
			expect.objectContaining({
				code: 'HermesWebhookHttp503',
				status: 503
			})
		);
	});
});
