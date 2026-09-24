import { describe, expect, it } from 'vitest';
import { transitionReviewReply } from './review-reply-state.js';

describe('transitionReviewReply', () => {
	it('permet le parcours contrôlé draft → gate PASS → scheduled → reserved', () => {
		expect(transitionReviewReply('drafted', 'gated_pass')).toEqual({ allowed: true });
		expect(transitionReviewReply('gated_pass', 'scheduled')).toEqual({ allowed: true });
		expect(transitionReviewReply('scheduled', 'reserved')).toEqual({ allowed: true });
	});

	it('traite un PUT interrompu comme outcome inconnu et exige une vérification distante', () => {
		expect(transitionReviewReply('reserved', 'write_unknown')).toEqual({ allowed: true });
		expect(transitionReviewReply('write_unknown', 'verified')).toEqual({ allowed: true });
		expect(transitionReviewReply('write_unknown', 'retry_eligible')).toEqual({ allowed: true });
	});

	it('interdit un nouvel envoi après un état terminal', () => {
		expect(transitionReviewReply('verified', 'reserved')).toEqual({
		allowed: false,
		reason: 'terminal_state'
	});
	});

	it('ne permet jamais de réserver un brouillon non passé au gate', () => {
		expect(transitionReviewReply('drafted', 'reserved')).toEqual({
		allowed: false,
		reason: 'invalid_transition'
	});
	});
});
