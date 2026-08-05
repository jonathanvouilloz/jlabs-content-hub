import { describe, expect, it } from 'vitest';
import { planClientTokenBackfill } from './client-token-backfill';

describe('backfill défensif des tokens client legacy', () => {
	it('hash les bearers legacy existants sans inventer de token brut', () => {
		const raw = 'b'.repeat(48);
		const plan = planClientTokenBackfill([{ id: 'p1', slug: 'wildcat', stored: raw }]);
		expect(plan.blocked).toEqual([]);
		expect(plan.updates).toHaveLength(1);
		expect(plan.updates[0]).toMatchObject({ id: 'p1', slug: 'wildcat', previous: raw });
		expect(plan.updates[0].next).toMatch(/^v1:[a-f0-9]{64}$/);
		expect(plan.updates[0].next).not.toContain(raw);
	});

	it('est idempotent sur les vérificateurs v1/v2 et bloque les formats inconnus', () => {
		const plan = planClientTokenBackfill([
			{ id: 'p1', slug: 'legacy-done', stored: `v1:${'a'.repeat(64)}` },
			{ id: 'p2', slug: 'new', stored: `v2:1788177600:${'b'.repeat(64)}` },
			{ id: 'p3', slug: 'unknown', stored: 'do-not-guess' }
		]);
		expect(plan.updates).toEqual([]);
		expect(plan.unchanged).toEqual(['legacy-done', 'new']);
		expect(plan.blocked).toEqual([{ id: 'p3', slug: 'unknown', reason: 'unknown_format' }]);
	});
});
