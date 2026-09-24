import { describe, expect, it } from 'vitest';
import { renderMonthlyReviewRecapMarkdown, stripGoogleTranslation, type MonthlyReviewRecap } from './monthly-review-recap';

const FIXTURE: MonthlyReviewRecap = {
	projectName: 'Barber Concept',
	periodKey: '2026-08',
	periodLabel: 'août',
	recipient: 'contact@barberconcept.ch',
	generatedDate: '2026-09-01',
	timezone: 'Europe/Zurich',
	sourceSyncedAt: '2026-09-01 06:00:00',
	summary: {
		reviews: 74,
		average: 4.9459,
		ratingCounts: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 73 },
		reviewsWithMentions: 60,
		mentionItems: 63,
		collaborators: 21,
		deletedReviews: 12
	},
	history: [
		{ label: 'Juillet', reviews: 125, average: 4.912 },
		{ label: 'Août', reviews: 74, average: 4.9459 }
	],
	locations: [{ salon: 'Rive', reviews: 15, average: 4.7333, mentions: 11 }],
	employees: [{ name: 'Noé', salons: 'Rive', mentions: 5, deleted: 1, visible: 4, positive: 4, neutral: 0, negative: 1 }],
	negativeReviews: [{ date: '07.08', salon: 'Rive', rating: 1, author: 'Antoine', excerpt: 'Avis négatif.', visible: false, analysis: 'Avis retiré depuis.' }],
	deletedReviews: [{ date: '07.08', salon: 'Rive', author: 'Antoine', rating: 1, employees: ['Noé'] }],
	replyCoverage: { visibleReviews: 62, remotelyAnswered: 60, pending: 2, divergent: 0 },
	arbitrations: [{ title: 'Imran', body: 'Alias non validé.' }],
	annex: [{ salon: 'Rive', employee: 'Noé', mentions: [{ date: '07.08', author: 'Antoine', rating: 1, excerpt: 'Avis négatif.', deleted: true, sentiment: 'negative' }] }],
	noMentionReviews: [{ date: '09.08', salon: 'Rive', author: 'Client', rating: 5, excerpt: null, deleted: false }],
	methodNote: 'Période calculée en heure locale Europe/Zurich.'
};

describe('renderMonthlyReviewRecapMarkdown', () => {
	it('renders the monthly client recap with response and arbitration truth', () => {
		const markdown = renderMonthlyReviewRecapMarkdown(FIXTURE);

		expect(markdown).toContain('destinataire: contact@barberconcept.ch');
		expect(markdown).toContain('avis Google d’août');
		expect(markdown).not.toContain('avis Google de août');
		expect(markdown).toContain('**74 avis reçus en août, note moyenne 4,95/5.**');
		expect(markdown).toContain('| Avis citant un collaborateur par son nom | 60 |');
		expect(markdown).toContain('| **Noé** | Rive | 5 | 1 | 4 |');
		expect(markdown).toContain('**60 avis visibles sur 62 ont une réponse vérifiée chez Google.**');
		expect(markdown).toContain('2 avis restent en attente');
		expect(markdown).toContain('## 5. Points à arbitrer');
		expect(markdown).toContain('**Imran** — Alias non validé.');
		expect(markdown).toContain('Période calculée en heure locale Europe/Zurich.');
		expect(markdown).toContain('## Avis sans mention nominative attribuable — 1');
	});
});

describe('stripGoogleTranslation', () => {
	it('keeps only the original review text', () => {
		expect(stripGoogleTranslation('Texte original\n\n(Translated by Google)\nTranslated text')).toBe('Texte original');
	});

	it('keeps the original when Google puts the translation first', () => {
		expect(stripGoogleTranslation('(Translated by Google)\nTranslated text\n\n(Original)\nTexte original')).toBe('Texte original');
	});
});
