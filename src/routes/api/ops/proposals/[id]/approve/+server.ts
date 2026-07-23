import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import {
	approveProposal,
	DECISION_HTTP_STATUS,
	ProposalDecisionError
} from '$lib/server/proposals.js';

/**
 * DASH-005 — Approbation d'une proposition, côté interface.
 *
 * L'endpoint ne décide rien : il transmet l'acteur et le hash affiché, et laisse
 * `approveProposal` appliquer les trois gardes SOUS TRANSACTION (niveau, statut,
 * hash attendu). Rejouer cet appel est sans effet — l'idempotence est portée par
 * la même transaction, pas par une déduplication d'HTTP.
 *
 * `payloadHash` est OBLIGATOIRE ici, alors qu'il est optionnel côté fonction :
 * l'appelant humain a forcément vu une version, et approuver « la version
 * courante, quelle qu'elle soit » est précisément ce que l'acceptation « chaque
 * approbation est liée au hash exact » interdit. Le chemin agent, lui, vient
 * d'écrire le payload et n'a rien à comparer.
 */
export const POST = async ({ params, request, locals }: RequestEvent) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as { payloadHash?: unknown };
	const payloadHash = typeof body.payloadHash === 'string' ? body.payloadHash.trim() : '';
	if (!payloadHash) {
		return json(
			{ error: 'Le hash du payload affiché est requis (approbation liée au hash exact).' },
			{ status: 400 }
		);
	}

	try {
		const result = await approveProposal({
			proposalId: params.id!,
			approverType: 'user',
			approverId: `user:${locals.user.email}`,
			method: 'ui',
			expectedPayloadHash: payloadHash
		});
		return json({
			ok: true,
			...result,
			// Dit sans ambiguïté qu'aucune action n'est déclenchée : rien n'exécute
			// encore les propositions. Sans ça, « approuvée » se lit comme « lancée ».
			note: result.idempotent
				? 'Déjà approuvée : aucune nouvelle décision enregistrée.'
				: 'Décision enregistrée. Aucune exécution n’en découle pour l’instant.'
		});
	} catch (e) {
		if (e instanceof ProposalDecisionError) {
			return json({ error: e.message, code: e.code }, { status: DECISION_HTTP_STATUS[e.code] });
		}
		throw e;
	}
};
