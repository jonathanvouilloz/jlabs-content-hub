import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { approveProposal, listProposals, ProposalDecisionError } from '$lib/server/proposals.js';
import { buildApprovalLots } from '$lib/server/proposal-console.js';

/** Plafond d'un lot. Une validation groupée est une décision prise sur un résumé :
 *  au-delà, l'humain ne lit plus, il clique. */
const MAX_ITEMS = 50;

/**
 * DASH-005 — Validation groupée, lots homogènes uniquement.
 *
 * L'invariant tient à une chose : **le lot est reconstruit depuis la BASE**, pas
 * accepté tel que le client l'envoie. `buildApprovalLots` est rejoué côté serveur
 * sur les lignes réelles ; si les ids demandés ne forment pas exactement UN lot,
 * l'appel est refusé. Une page modifiée, une requête forgée ou un onglet resté
 * ouvert pendant que le run hebdomadaire est passé ne peuvent donc pas faire
 * approuver ensemble deux projets, deux niveaux — ni une L4, que `buildApprovalLots`
 * exclut toujours.
 *
 * Chaque item porte le hash que le client a AFFICHÉ : il est transmis à
 * `approveProposal`, qui refuse individuellement celui dont le payload a bougé.
 * C'est l'acceptation « modifier une proposition l'exclut du lot » — obtenue sans
 * aucune règle d'interface, par la seule comparaison de hash.
 *
 * La réponse rend TOUJOURS le détail par item. Un lot qui « réussit » en taisant
 * deux items refusés se lit comme un lot complet : c'est le mode de panne à éviter.
 */
export const POST = async ({ request, locals }: RequestEvent) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as { items?: unknown };
	const raw = Array.isArray(body.items) ? body.items : [];
	const items = raw
		.filter((i): i is { id: string; payloadHash: string } => {
			const o = i as { id?: unknown; payloadHash?: unknown };
			return typeof o?.id === 'string' && typeof o?.payloadHash === 'string';
		})
		.map((i) => ({ id: i.id.trim(), payloadHash: i.payloadHash.trim() }));

	if (items.length < 2) {
		return json(
			{ error: 'Un lot compte au moins deux propositions ; en dessous, décider une par une.' },
			{ status: 400 }
		);
	}
	if (items.length > MAX_ITEMS) {
		return json({ error: `Un lot est plafonné à ${MAX_ITEMS} propositions.` }, { status: 400 });
	}

	const ids = [...new Set(items.map((i) => i.id))];
	const rows = await listProposals({ ids, limit: MAX_ITEMS });

	const missing = ids.filter((id) => !rows.some((r) => r.id === id));
	if (missing.length > 0) {
		return json(
			{ error: `Propositions introuvables : ${missing.join(', ')}.`, code: 'not_found' },
			{ status: 404 }
		);
	}

	// Le lot, tel que la BASE le permet. `excluded` est renvoyé au client parce
	// qu'un refus muet ferait recommencer le même geste avec le même résultat.
	const { lots, excluded } = buildApprovalLots(
		rows.map((r) => ({
			id: r.id,
			projectId: r.projectId,
			projectSlug: r.projectSlug,
			actionType: r.actionType,
			requiredApprovalLevel: r.requiredApprovalLevel,
			riskLevel: r.riskLevel,
			status: r.status,
			payloadHash: r.payloadHash
		}))
	);

	if (lots.length !== 1 || lots[0].items.length !== ids.length) {
		return json(
			{
				error:
					'Ces propositions ne forment pas un lot homogène (même projet, action, niveau et ' +
					'risque) — ou l’une d’elles n’est plus à décider.',
				code: 'not_homogeneous',
				excluded,
				lots: lots.map((l) => ({
					projectSlug: l.projectSlug,
					actionType: l.actionType,
					level: l.level,
					risk: l.risk,
					ids: l.items.map((i) => i.id)
				}))
			},
			{ status: 409 }
		);
	}

	const approved: { id: string; approvalId: string; idempotent: boolean }[] = [];
	const skipped: { id: string; reason: string; code?: string }[] = [];

	for (const item of items) {
		try {
			const result = await approveProposal({
				proposalId: item.id,
				approverType: 'user',
				approverId: `user:${locals.user.email}`,
				method: 'ui',
				expectedPayloadHash: item.payloadHash
			});
			approved.push({ id: item.id, ...result });
		} catch (e) {
			if (e instanceof ProposalDecisionError) {
				// Un item qui tombe n'annule pas les autres : ils ont été jugés
				// homogènes et chacun porte sa propre approbation liée à son hash.
				skipped.push({ id: item.id, reason: e.message, code: e.code });
				continue;
			}
			throw e;
		}
	}

	return json({
		ok: skipped.length === 0,
		lot: {
			projectSlug: lots[0].projectSlug,
			actionType: lots[0].actionType,
			level: lots[0].level,
			risk: lots[0].risk
		},
		approved,
		skipped,
		note: 'Décisions enregistrées. Aucune exécution n’en découle pour l’instant.'
	});
};
