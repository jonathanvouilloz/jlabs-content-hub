import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import {
	rejectProposal,
	requestProposalChanges,
	DECISION_HTTP_STATUS,
	ProposalDecisionError
} from '$lib/server/proposals.js';

/**
 * DASH-005 — Décision NÉGATIVE sur une proposition : rejet, ou demande de révision.
 *
 * Un seul endpoint pour les deux, parce que c'est le même geste avec la même
 * exigence : une RAISON. Un refus sans motif n'apprend rien au détecteur, qui
 * reproduira le même finding la semaine suivante — et c'est la raison, journalisée
 * au finding, qui matérialise l'acceptation DASH-004 « l'utilisateur peut contester
 * un finding avec une raison ».
 *
 * `mode=changes` ne clôt rien : la proposition reste ouverte et, parce que
 * `decideSupersession` ne périme que `proposed`/`invalidated`, le run hebdomadaire
 * ne l'écrasera pas. `mode=reject` clôt.
 */
export const POST = async ({ params, request, locals }: RequestEvent) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as {
		reason?: unknown;
		payloadHash?: unknown;
		mode?: unknown;
	};

	// Mode inconnu → refus, jamais un défaut : se tromper de sens entre « je rejette »
	// et « je demande une révision » n'est pas rattrapable par une valeur par défaut.
	if (body.mode !== 'reject' && body.mode !== 'changes') {
		return json({ error: 'mode attendu : « reject » ou « changes ».' }, { status: 400 });
	}

	const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
	if (!reason) return json({ error: 'Une raison est requise.' }, { status: 400 });

	const payloadHash = typeof body.payloadHash === 'string' ? body.payloadHash.trim() : null;

	try {
		const decide = body.mode === 'changes' ? requestProposalChanges : rejectProposal;
		const result = await decide({
			proposalId: params.id!,
			reason,
			actor: `user:${locals.user.email}`,
			expectedPayloadHash: payloadHash
		});
		return json({ ok: true, ...result });
	} catch (e) {
		if (e instanceof ProposalDecisionError) {
			return json({ error: e.message, code: e.code }, { status: DECISION_HTTP_STATUS[e.code] });
		}
		throw e;
	}
};
