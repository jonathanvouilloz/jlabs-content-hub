import { describe, expect, it } from 'vitest';
import {
	decideReviewReplyPublication,
	decideReviewReplyReconciliation,
	REVIEW_REPLY_SETTLE_MS
} from './review-reply-publisher-state.js';

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

	it('reconnaît une réponse arrivée que Google a annotée de sa traduction', () => {
		for (const replyText of [
			'Merci pour votre retour !\n\n(Translated by Google)\nThanks for your feedback!',
			'(Translated by Google) Thanks for your feedback!\n\n(Original)\nMerci pour votre retour !'
		]) {
			expect(decideReviewReplyPublication({ proposal, remote: { kind: 'present', replyText } })).toEqual({
				action: 'verified',
				reason: 'remote_reply_matches'
			});
		}
	});

	it('refuse l’envoi quand l’avis n’est plus lisible à distance', () => {
		expect(decideReviewReplyPublication({ proposal, remote: { kind: 'missing' } })).toEqual({
			action: 'conflict',
			reason: 'review_missing'
		});
	});
});

describe('decideReviewReplyReconciliation', () => {
	const now = Date.parse('2026-09-28T10:40:00Z');
	const absent = { kind: 'present', replyText: null } as const;

	it('ne rouvre pas le retry pendant la fenêtre de propagation après un PUT accepté', () => {
		expect(decideReviewReplyReconciliation({
			proposal, remote: absent, putAcceptedAtMs: now - 1_000, nowMs: now
		})).toEqual({ action: 'pending', retryAfterSeconds: Math.ceil((REVIEW_REPLY_SETTLE_MS - 1_000) / 1000) });
	});

	it('rouvre le retry une fois la fenêtre écoulée, ou si aucun PUT n’a été accepté', () => {
		expect(decideReviewReplyReconciliation({
			proposal, remote: absent, putAcceptedAtMs: now - REVIEW_REPLY_SETTLE_MS, nowMs: now
		})).toEqual({ action: 'retry_eligible' });
		expect(decideReviewReplyReconciliation({
			proposal, remote: absent, putAcceptedAtMs: null, nowMs: now
		})).toEqual({ action: 'retry_eligible' });
	});

	it('reste en attente si l’heure d’acceptation est illisible', () => {
		expect(decideReviewReplyReconciliation({
			proposal, remote: absent, putAcceptedAtMs: Number.NaN, nowMs: now
		})).toMatchObject({ action: 'pending' });
	});

	it('conclut verified sur une réponse arrivée tard, traduction Google comprise', () => {
		expect(decideReviewReplyReconciliation({
			proposal,
			remote: { kind: 'present', replyText: `${proposal.replyText}

(Translated by Google)
Thanks!` },
			putAcceptedAtMs: now - 60_000,
			nowMs: now
		})).toEqual({ action: 'verified' });
	});

	it('conclut conflict sur une réponse différente ou un avis supprimé', () => {
		expect(decideReviewReplyReconciliation({
			proposal, remote: { kind: 'present', replyText: 'Autre' }, putAcceptedAtMs: null, nowMs: now
		})).toEqual({ action: 'conflict', reason: 'remote_reply_differs' });
		expect(decideReviewReplyReconciliation({
			proposal, remote: { kind: 'missing' }, putAcceptedAtMs: null, nowMs: now
		})).toEqual({ action: 'conflict', reason: 'review_missing' });
	});
});
