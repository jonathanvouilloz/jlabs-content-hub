import { describe, expect, it } from 'vitest';
import { decideReviewReplyPublication } from './review-reply-publisher-state.js';

const proposal = { reviewId: 'reviews/r-1', replyText: 'Merci pour votre retour !' };

describe('decideReviewReplyPublication', () => {
	it('autorise un PUT seulement après une relecture qui confirme l’absence de réponse distante', () => {
		expect(decideReviewReplyPublication({ proposal, remote: { kind: 'present', replyText: null } })).toEqual({
			action: 'put'
		});
	});

	it('n’écrase jamais une réponse distante différente et signale une divergence', () => {
		expect(
			decideReviewReplyPublication({
				proposal,
				remote: { kind: 'present', replyText: 'Merci, nous allons revenir vers vous.' }
			})
		).toEqual({ action: 'conflict', reason: 'remote_reply_differs' });
	});

	it('reconnaît une écriture déjà arrivée comme vérifiée, sans second PUT', () => {
		expect(
			decideReviewReplyPublication({
				proposal,
				remote: { kind: 'present', replyText: 'Merci pour votre retour !' }
			})
		).toEqual({ action: 'verified', reason: 'remote_reply_matches' });
	});

	it('refuse l’envoi quand l’avis n’est plus lisible à distance', () => {
		expect(decideReviewReplyPublication({ proposal, remote: { kind: 'missing' } })).toEqual({
			action: 'conflict',
			reason: 'review_missing'
		});
	});
});
