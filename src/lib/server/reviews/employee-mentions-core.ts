export type EmployeeMentionSentiment = 'positive' | 'neutral' | 'negative';
export interface EmployeeMentionCandidate {
	name: string;
	sentiment: EmployeeMentionSentiment;
}

function sanitizeCandidates(input: unknown): EmployeeMentionCandidate[] {
	if (!Array.isArray(input)) return [];
	return input.flatMap((value) => {
		if (!value || typeof value !== 'object') return [];
		const candidate = value as { name?: unknown; sentiment?: unknown };
		const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
		if (!name || !['positive', 'neutral', 'negative'].includes(String(candidate.sentiment))) return [];
		return [{ name, sentiment: candidate.sentiment as EmployeeMentionSentiment }];
	});
}

/** La forme minimale transmise au modèle : le core n’a ni DB ni tâches de fond. */
export interface EmployeeMentionSourceReview {
	reviewId: string;
	locationId: string;
	comment: string;
}

export interface ExtractedEmployeeMention {
	reviewId: string;
	locationId: string;
	candidates: EmployeeMentionCandidate[];
}

export interface BoundedEmployeeMentionExtractionResult {
	processed: number;
	/** Lignes non lues parce que le plafond a été atteint. */
	capped: number;
	aborted: boolean;
	results: ExtractedEmployeeMention[];
}

/**
 * Coeur durable : l'appelant ATTEND la fin, le signal coupe entre deux appels et
 * le plafond empêche qu'un job quotidien consume un historique complet.
 */
export async function extractBoundedEmployeeMentions(input: {
	reviews: EmployeeMentionSourceReview[];
	maxReviews: number;
	signal: AbortSignal;
	extract: (review: EmployeeMentionSourceReview, signal: AbortSignal) => Promise<unknown>;
}): Promise<BoundedEmployeeMentionExtractionResult> {
	const limit = Math.max(0, Math.floor(input.maxReviews));
	const candidates = input.reviews.slice(0, limit);
	const results: ExtractedEmployeeMention[] = [];

	for (const review of candidates) {
		if (input.signal.aborted) break;
		const raw = await input.extract(review, input.signal);
		results.push({
			reviewId: review.reviewId,
			locationId: review.locationId,
			candidates: sanitizeCandidates(raw)
		});
	}

	return {
		processed: results.length,
		capped: Math.max(0, input.reviews.length - candidates.length),
		aborted: input.signal.aborted,
		results
	};
}
