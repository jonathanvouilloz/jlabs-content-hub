import { describe, expect, it } from 'vitest';
import { buildReviewReplyCandidate } from './review-reply-candidate-state.js';

const input = {
	projectId: 'p-1',
	reviewId: 'reviews/r-1',
	locationId: 'locations/rive',
	rating: 5,
	comment: 'Super coupe, merci !',
	remoteUpdateAt: null,
	replyText: 'Merci pour votre retour !',
	language: 'fr',
	projectionHash: 'projection-hash',
	policyHash: 'policy-hash',
	policyVersion: 3
};

describe('buildReviewReplyCandidate', () => {
	it('produit des empreintes stables pour le même avis, contexte et texte', () => {
		expect(buildReviewReplyCandidate(input)).toEqual(buildReviewReplyCandidate(input));
	});

	it('change l’empreinte du candidat si le texte de l’avis change', () => {
		expect(buildReviewReplyCandidate({ ...input, comment: 'Merci, mais ce n’est pas la même coupe.' }).reviewSnapshotHash)
			.not.toBe(buildReviewReplyCandidate(input).reviewSnapshotHash);
	});

	it('refuse un brouillon vide avant toute persistance', () => {
		expect(() => buildReviewReplyCandidate({ ...input, replyText: '  ' })).toThrow('replyText must not be empty');
	});
});
