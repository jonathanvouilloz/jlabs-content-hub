import { describe, expect, it } from 'vitest';
import { GscApiError, withRequestTimeout } from './gsc-auth.js';
import { classifyJobFailure } from './job-retry.js';

/**
 * Le plafond de temps des appels Google (correctif du 2026-07-31).
 *
 * Ce qui est prouvé ici n'est pas « on met un timeout », mais les trois propriétés dont
 * dépend le comportement de la file : le dépassement REND LA MAIN, il est CLASSÉ
 * `retryable` (donc rejoué au lieu de partir en dead-letter), et il ne masque pas un
 * abandon demandé par l'appelant.
 */

/** Un appel qui ne répond jamais — exactement ce qui a bloqué `cardrank`. */
const hangingFetch: typeof fetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
	})) as unknown as typeof fetch;

describe('withRequestTimeout', () => {
	it('un appel qui ne répond jamais rend la main au lieu de bloquer', async () => {
		const fetchWithCap = withRequestTimeout(hangingFetch, 20);
		await expect(fetchWithCap('https://example.test')).rejects.toBeInstanceOf(GscApiError);
	});

	it('le dépassement est un 504 nommé, pas un AbortError nu', async () => {
		const fetchWithCap = withRequestTimeout(hangingFetch, 20);
		const err = await fetchWithCap('https://example.test').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GscApiError);
		expect((err as GscApiError).status).toBe(504);
		expect((err as GscApiError).reason).toBe('request_timeout');
	});

	it('la file le classe retryable (et non permanent) — le job est rejoué', async () => {
		const fetchWithCap = withRequestTimeout(hangingFetch, 20);
		const err = await fetchWithCap('https://example.test').catch((e: unknown) => e);
		const verdict = classifyJobFailure(err);
		expect(verdict.errorClass).toBe('retryable');
		expect(verdict.isProviderTimeout).toBe(true);
	});

	it("un abandon demandé par l'appelant remonte tel quel, jamais en timeout provider", async () => {
		const caller = new AbortController();
		const fetchWithCap = withRequestTimeout(hangingFetch, 10_000);
		const promise = fetchWithCap('https://example.test', { signal: caller.signal });
		caller.abort(new Error('bail perdu'));
		const err = await promise.catch((e: unknown) => e);
		expect(err).not.toBeInstanceOf(GscApiError);
		expect((err as Error).message).toBe('bail perdu');
	});

	it('une réponse normale traverse sans être touchée', async () => {
		const ok: typeof fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
		const res = await withRequestTimeout(ok, 20)('https://example.test');
		expect(res.status).toBe(200);
	});
});
