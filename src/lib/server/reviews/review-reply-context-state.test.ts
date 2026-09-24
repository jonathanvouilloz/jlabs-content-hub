import { describe, expect, it } from 'vitest';
import { derivePublicRoster, parseReviewReplyContext } from './review-reply-context-state.js';

const payload = {
	gmb: {
		reviewReplies: {
			version: 'barberconcept-2026-09-24',
			businessName: 'Barber Concept',
			defaultSignature: "L'equipe Barber Concept",
			contactEmail: 'contact@barberconcept.ch',
			voice: { tutoiement: true, banned: ['atelier'] },
			interdits: ['promesse de remboursement'],
			locations: [{ id: 'locations/rive', label: 'Barber Concept Rive' }]
		},
		employeeMentions: {
			enabled: true,
			version: 'roster-2026-09-24',
			employees: [
				{
					id: 'noe',
					displayName: 'Noe',
					aliases: ['Noe'],
					locations: ['locations/rive'],
					active: true,
					eligibleForBonus: true,
					publicReplyAllowed: true
				}
			]
		}
	}
};

describe('parseReviewReplyContext', () => {
	it('derive le roster public depuis la capability canonique', () => {
		expect(parseReviewReplyContext(payload, 'locations/rive')).toEqual({
			ok: true,
			context: {
				version: 'barberconcept-2026-09-24',
				businessName: 'Barber Concept',
				defaultSignature: "L'equipe Barber Concept",
				contactEmail: 'contact@barberconcept.ch',
				locationLabel: 'Barber Concept Rive',
				voice: { tutoiement: true, banned: ['atelier'] },
				interdits: ['promesse de remboursement'],
				rosterVersion: 'roster-2026-09-24',
				rosterAvailable: true,
				publicRoster: [{ name: 'Noe', aliases: ['Noe'] }]
			}
		});
	});

	it('echoue ferme si la projection est stale ou si la fiche manque', () => {
		expect(parseReviewReplyContext(payload, 'locations/rive', 'stale')).toEqual({
			ok: false,
			reason: 'projection_stale'
		});
		expect(parseReviewReplyContext(payload, 'locations/sion')).toEqual({
			ok: false,
			reason: 'location_missing'
		});
	});

	it('ne rend jamais un employe inactif ou non publiable disponible', () => {
		const roster = structuredClone(payload.gmb.employeeMentions);
		roster.employees[0].publicReplyAllowed = false;
		expect(derivePublicRoster(roster, 'locations/rive')).toEqual([]);
		roster.employees[0].publicReplyAllowed = true;
		roster.employees[0].active = false;
		expect(derivePublicRoster(roster, 'locations/rive')).toEqual([]);
	});
});
