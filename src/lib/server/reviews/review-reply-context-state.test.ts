import { describe, expect, it } from 'vitest';
import { parseReviewReplyContext } from './review-reply-context-state.js';

const payload = {
	gmb: {
		reviewReplies: {
			version: 'barberconcept-2026-08-17',
			businessName: 'Barber Concept',
			defaultSignature: "L'équipe Barber Concept",
			contactEmail: 'contact@barberconcept.ch',
			locations: [{ id: 'locations/rive', label: 'Barber Concept Rive' }],
			publicRoster: [
				{
					id: 'noe',
					name: 'Noé',
					aliases: ['Noe'],
					locationIds: ['locations/rive'],
					publicReplyAllowed: true
				}
			]
		}
	}
};

describe('parseReviewReplyContext', () => {
	it('accepte un contexte complet et expose uniquement le roster publiable de la fiche', () => {
		expect(parseReviewReplyContext(payload, 'locations/rive')).toEqual({
			ok: true,
			context: {
				version: 'barberconcept-2026-08-17',
				businessName: 'Barber Concept',
				defaultSignature: "L'équipe Barber Concept",
				contactEmail: 'contact@barberconcept.ch',
				locationLabel: 'Barber Concept Rive',
				publicRoster: [{ name: 'Noé', aliases: ['Noe'] }]
			}
		});
	});

	it('échoue fermé si le contexte ne donne pas la localisation de l’avis', () => {
		expect(parseReviewReplyContext(payload, 'locations/sion')).toEqual({
			ok: false,
			reason: 'location_missing'
		});
	});

	it('ne rend jamais un employé non publiable disponible pour une réponse', () => {
		const privateRoster = structuredClone(payload);
		privateRoster.gmb.reviewReplies.publicRoster[0].publicReplyAllowed = false;
		expect(parseReviewReplyContext(privateRoster, 'locations/rive')).toEqual({
			ok: true,
			context: {
				version: 'barberconcept-2026-08-17',
				businessName: 'Barber Concept',
				defaultSignature: "L'équipe Barber Concept",
				contactEmail: 'contact@barberconcept.ch',
				locationLabel: 'Barber Concept Rive',
				publicRoster: []
			}
		});
	});
});
