import { describe, expect, it } from 'vitest';
import { classifyAutoReply } from './auto-reply-state.js';

describe('classifyAutoReply', () => {
	it('autorise un avis 5 étoiles positif et simple', () => {
		expect(
			classifyAutoReply({ rating: 5, comment: 'Super coupe, merci Alexis !' })
		).toEqual({ category: 'positive', autoPublishable: true, reason: 'positive_simple' });
	});

	it('autorise une réponse courte à un avis 5 étoiles sans commentaire', () => {
		expect(classifyAutoReply({ rating: 5, comment: '' })).toEqual({
			category: 'positive',
			autoPublishable: true,
			reason: 'positive_no_comment'
		});
	});

	it('bloque un avis qui comporte une accusation même si sa note est 5 étoiles', () => {
		expect(
			classifyAutoReply({ rating: 5, comment: 'Très bon accueil, mais on m’a facturé deux fois.' })
		).toEqual({ category: 'sensitive', autoPublishable: false, reason: 'sensitive_content' });
	});

	it('oriente toute note inférieure à 5 étoiles vers un traitement humain', () => {
		expect(classifyAutoReply({ rating: 4, comment: 'Bien mais attente longue.' })).toEqual({
			category: 'positive',
			autoPublishable: true,
			reason: 'positive_simple'
		});
	});

	it('oriente les notes 1 a 3 vers un traitement humain', () => {
		expect(classifyAutoReply({ rating: 3, comment: 'Moyen.' })).toEqual({
			category: 'human_review',
			autoPublishable: false,
			reason: 'rating_below_policy'
		});
	});
});
