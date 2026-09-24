import { createHash } from 'node:crypto';

export interface ReviewReplyCandidateInput {
	projectId: string;
	reviewId: string;
	locationId: string;
	rating: number;
	comment: string;
	remoteUpdateAt: string | null;
	replyText: string;
	language: string;
	projectionHash: string;
	policyHash: string;
	policyVersion: number;
}

export interface ReviewReplyCandidate extends ReviewReplyCandidateInput {
	reviewSnapshotHash: string;
	proposalHash: string;
}

function hash(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Fige les deux empreintes qui rendent un candidat rejouable : l'avis distant d'une part,
 * et le texte + contexte/policy qui ont servi à le proposer d'autre part.
 */
export function buildReviewReplyCandidate(input: ReviewReplyCandidateInput): ReviewReplyCandidate {
	const replyText = input.replyText.trim();
	if (!replyText) throw new Error('replyText must not be empty');
	const language = input.language.trim();
	if (!language) throw new Error('language must not be empty');

	const reviewSnapshotHash = hash({
		projectId: input.projectId,
		reviewId: input.reviewId,
		locationId: input.locationId,
		rating: input.rating,
		comment: input.comment,
		remoteUpdateAt: input.remoteUpdateAt
	});
	const proposalHash = hash({
		reviewSnapshotHash,
		replyText,
		language,
		projectionHash: input.projectionHash,
		policyHash: input.policyHash,
		policyVersion: input.policyVersion
	});
	return { ...input, replyText, language, reviewSnapshotHash, proposalHash };
}
