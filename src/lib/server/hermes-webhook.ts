import { createHmac } from 'node:crypto';
import type { SeoWeeklyDispatchEvent } from './seo-weekly-dispatch-state.js';

export class HermesWebhookError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status?: number
	) {
		super(message);
		this.name = 'HermesWebhookError';
	}
}

function webhookUrl(raw: string): string {
	if (!raw.trim()) {
		throw new HermesWebhookError(
			'HermesWebhookNotConfigured',
			'La destination webhook Hermes n’est pas configurée.'
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new HermesWebhookError('HermesWebhookInvalidUrl', 'URL webhook Hermes invalide.');
	}
	if (parsed.protocol !== 'https:') {
		throw new HermesWebhookError(
			'HermesWebhookInsecureUrl',
			'Le webhook Hermes doit utiliser HTTPS.'
		);
	}
	return parsed.toString();
}

export async function deliverHermesWebhook(input: {
	event: SeoWeeklyDispatchEvent;
	url: string;
	secret: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	now?: () => Date;
}): Promise<void> {
	const url = webhookUrl(input.url);
	if (!input.secret) {
		throw new HermesWebhookError(
			'HermesWebhookNotConfigured',
			'Le secret HMAC du webhook Hermes n’est pas configuré.'
		);
	}

	const body = JSON.stringify(input.event);
	const timestamp = String(Math.floor((input.now?.() ?? new Date()).getTime() / 1000));
	const signature = createHmac('sha256', input.secret)
		.update(`${timestamp}.${body}`)
		.digest('hex');
	const controller = new AbortController();
	const onAbort = () => controller.abort(input.signal?.reason);
	input.signal?.addEventListener('abort', onAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new DOMException('Hermes webhook timeout', 'TimeoutError')),
		input.timeoutMs ?? 30_000
	);

	try {
		const response = await (input.fetchImpl ?? fetch)(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-github-event': input.event.eventType,
				'x-request-id': input.event.eventId,
				'x-webhook-timestamp': timestamp,
				'x-webhook-signature-v2': signature
			},
			body,
			signal: controller.signal
		});
		if (!response.ok) {
			const detail = (await response.text()).slice(0, 500);
			throw new HermesWebhookError(
				`HermesWebhookHttp${response.status}`,
				`Webhook Hermes refusé (${response.status})${detail ? ` : ${detail}` : ''}`,
				response.status
			);
		}
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener('abort', onAbort);
	}
}
