import { describe, it, expect } from 'vitest';
import {
	ELIGIBLE_INDEXING_TYPES,
	evaluateIndexingGuard,
	isEligibleForIndexingApi
} from './indexing-eligibility.js';

describe('isEligibleForIndexingApi', () => {
	it('accepte les types officiellement éligibles', () => {
		expect(isEligibleForIndexingApi('JobPosting')).toBe(true);
		expect(isEligibleForIndexingApi('BroadcastEvent')).toBe(true);
	});

	it('refuse une page ordinaire et les valeurs vides', () => {
		expect(isEligibleForIndexingApi('Article')).toBe(false);
		expect(isEligibleForIndexingApi('BlogPosting')).toBe(false);
		expect(isEligibleForIndexingApi('')).toBe(false);
		expect(isEligibleForIndexingApi(null)).toBe(false);
		expect(isEligibleForIndexingApi(undefined)).toBe(false);
	});

	it('expose exactement les deux types éligibles', () => {
		expect([...ELIGIBLE_INDEXING_TYPES]).toEqual(['JobPosting', 'BroadcastEvent']);
	});
});

describe('evaluateIndexingGuard', () => {
	it('bloque quand le flag maître est OFF, quel que soit le type', () => {
		const verdict = evaluateIndexingGuard({ flagEnabled: false, eligibility: 'JobPosting' });
		expect(verdict.allowed).toBe(false);
		if (!verdict.allowed) expect(verdict.reason).toBe('flag_off');
	});

	it('bloque un type non éligible même flag ON (un article standard ne peut pas appeler l\'API)', () => {
		const verdict = evaluateIndexingGuard({ flagEnabled: true, eligibility: 'Article' });
		expect(verdict.allowed).toBe(false);
		if (!verdict.allowed) expect(verdict.reason).toBe('ineligible_type');
	});

	it('bloque une éligibilité absente flag ON', () => {
		const verdict = evaluateIndexingGuard({ flagEnabled: true });
		expect(verdict.allowed).toBe(false);
		if (!verdict.allowed) expect(verdict.reason).toBe('ineligible_type');
	});

	// Test positif exigé par l'acceptation IDX-008.
	it('autorise un type éligible quand le flag est ON', () => {
		expect(evaluateIndexingGuard({ flagEnabled: true, eligibility: 'JobPosting' })).toEqual({
			allowed: true
		});
		expect(evaluateIndexingGuard({ flagEnabled: true, eligibility: 'BroadcastEvent' })).toEqual({
			allowed: true
		});
	});
});
