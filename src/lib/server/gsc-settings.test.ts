import { describe, it, expect } from 'vitest';
import { resolveLatencyDays } from './gsc-settings.js';
import { GSC_LATENCY_DAYS } from './collectors/gsc-collector-state.js';

describe('resolveLatencyDays — tolérant, défaut du code', () => {
	it('clé absente → défaut', () => {
		expect(resolveLatencyDays(null)).toBe(GSC_LATENCY_DAYS);
		expect(resolveLatencyDays(undefined)).toBe(GSC_LATENCY_DAYS);
		expect(resolveLatencyDays('')).toBe(GSC_LATENCY_DAYS);
	});

	it('nombre nu en texte', () => {
		expect(resolveLatencyDays('5')).toBe(5);
	});

	it('JSON { latencyDays }', () => {
		expect(resolveLatencyDays(JSON.stringify({ latencyDays: 7 }))).toBe(7);
	});

	it('valeur illisible ou négative → défaut', () => {
		expect(resolveLatencyDays('abc')).toBe(GSC_LATENCY_DAYS);
		expect(resolveLatencyDays('-2')).toBe(GSC_LATENCY_DAYS);
		expect(resolveLatencyDays(JSON.stringify({ latencyDays: 'oops' }))).toBe(GSC_LATENCY_DAYS);
	});

	it('valeur flottante → plancher', () => {
		expect(resolveLatencyDays('4.9')).toBe(4);
	});
});
