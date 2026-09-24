export type AutoReplyCategory = 'positive' | 'sensitive' | 'human_review';

export interface AutoReplyClassification {
	category: AutoReplyCategory;
	autoPublishable: boolean;
	reason: '5_star_simple' | '5_star_no_comment' | 'sensitive_content' | 'rating_below_policy';
}

const SENSITIVE_TERMS = [
	'factur',
	'payé deux fois',
	'rembourse',
	'arnaque',
	'vol',
	'plainte',
	'accuse',
	'discrimin',
	'harcèl',
	'bless',
	'coupure',
	'sang',
	'urgence',
	'police',
	'avocat',
	'procès'
];

function normalize(text: string): string {
	return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Classification locale et déterministe de la policy Barber Concept.
 * Seuls les avis 5★ non sensibles peuvent entrer dans la publication automatique.
 */
export function classifyAutoReply(input: { rating: number; comment: string }): AutoReplyClassification {
	if (input.rating !== 5) {
		return { category: 'human_review', autoPublishable: false, reason: 'rating_below_policy' };
	}

	const comment = normalize(input.comment);
	if (SENSITIVE_TERMS.some((term) => comment.includes(normalize(term)))) {
		return { category: 'sensitive', autoPublishable: false, reason: 'sensitive_content' };
	}

	return comment.trim()
		? { category: 'positive', autoPublishable: true, reason: '5_star_simple' }
		: { category: 'positive', autoPublishable: true, reason: '5_star_no_comment' };
}
