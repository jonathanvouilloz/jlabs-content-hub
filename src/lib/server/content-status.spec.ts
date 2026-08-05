import { describe, expect, it } from 'vitest';
import { planContentStatusChange, resolveContentStatusActor } from './content-status';

describe('changement de statut de contenu', () => {
	it('dérive l’auteur de la session et ignore toute identité fournie dans le body', () => {
		expect(resolveContentStatusActor({ user: { id: 'u-1', email: 'jon@example.test' } }, null)).toBe(
			'user:u-1:jon@example.test'
		);
	});

	it('dérive l’auteur du credential machine portant le scope dédié', () => {
		expect(resolveContentStatusActor(null, { id: 'agent-ops' })).toBe('machine:agent-ops');
	});

	it('refuse un appel sans session ni credential machine', () => {
		expect(resolveContentStatusActor(null, null)).toBeNull();
	});

	it('rend un rejeu du même statut idempotent sans historique supplémentaire', () => {
		expect(planContentStatusChange('approved', 'approved')).toEqual({
		changed: false,
		fromStatus: 'approved',
		toStatus: 'approved'
	});
		expect(planContentStatusChange('review', 'approved')).toEqual({
		changed: true,
		fromStatus: 'review',
		toStatus: 'approved'
	});
	});
});
