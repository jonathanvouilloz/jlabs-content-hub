import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { getProposalDetail } from '$lib/server/proposals.js';
import { getFindingWithEvidence } from '$lib/server/findings.js';
import { explainProposal, proposalAbilities } from '$lib/server/proposal-console.js';
import { isApprovalValid } from '$lib/server/proposal-state.js';
import { toDbTimestamp } from '$lib/server/timestamps.js';

/**
 * DASH-005 — Une proposition, et de quoi décider.
 *
 * L'écran doit montrer trois choses qu'on ne peut pas déduire l'une de l'autre :
 * ce qui est proposé (payload + hash), pourquoi (rationale, impact attendu, et les
 * PREUVES du finding source), et ce qui a déjà été décidé (approbations, y compris
 * tombées).
 *
 * La validité de chaque approbation est recalculée ici par `isApprovalValid` contre
 * le hash COURANT : une approbation `active` dont le hash ne correspond plus n'est
 * pas une approbation valide, et l'afficher comme telle ferait croire la décision
 * encore couverte.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	const detail = await getProposalDetail(params.id, db);
	if (!detail) throw error(404, 'Proposition introuvable');

	// Le finding source, avec son journal : l'acceptation DASH-004 « aucune
	// affirmation ne manque de source identifiable » vaut aussi pour la proposition
	// qui en découle — sans ses preuves, le rationale n'est qu'une assertion.
	const finding = detail.proposal.findingId
		? await getFindingWithEvidence(detail.proposal.findingId, db)
		: null;

	const now = toDbTimestamp(new Date());

	return {
		proposal: detail.proposal,
		approvals: detail.approvals.map((a) => ({
			...a,
			valid: isApprovalValid({
				status: a.status,
				approvedPayloadHash: a.approvedPayloadHash,
				currentPayloadHash: detail.proposal.payloadHash,
				expiresAt: a.expiresAt,
				now
			})
		})),
		agentRuns: detail.agentRuns,
		finding: finding?.finding ?? null,
		findingEvents: finding?.events ?? [],
		abilities: proposalAbilities({
			status: detail.proposal.status,
			requiredApprovalLevel: detail.proposal.requiredApprovalLevel,
			actorType: locals.user ? 'user' : 'agent'
		}),
		explanation: explainProposal({
			status: detail.proposal.status,
			requiredApprovalLevel: detail.proposal.requiredApprovalLevel,
			actorType: locals.user ? 'user' : 'agent'
		}),
		now
	};
};
