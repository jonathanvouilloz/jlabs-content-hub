import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import {
	dismissFinding,
	getFindingWithEvidence,
	reopenFinding,
	snoozeFinding,
	transitionFinding
} from '$lib/server/findings.js';
import { canTransition } from '$lib/server/finding-state.js';

/**
 * DASH-004 — Les entrées humaines du cycle de vie d'un finding.
 *
 * Cet endpoint ne réimplémente RIEN : il appelle les fonctions FIND-003
 * (`transitionFinding` et ses trois raccourcis), qui posent statut et journal dans
 * une même transaction et refusent toute transition absente du graphe §10.1. Le
 * pré-contrôle `canTransition` ici ne sert qu'à rendre un 409 lisible plutôt qu'un
 * 500 — la garde qui compte est celle de l'écriture.
 *
 * Une RAISON est exigée dans tous les cas : c'est l'acceptation « l'utilisateur
 * peut contester un finding avec une raison », et c'est ce qui rend le taux de
 * faux positifs (FIND-010) mesurable plus tard. Sans motif, un `dismissed` ne dit
 * pas si le détecteur s'est trompé ou si le problème est connu et assumé.
 */
const ACTIONS = {
	acknowledge: 'acknowledged',
	plan: 'planned',
	start: 'in_progress',
	resolve: 'resolved',
	snooze: 'snoozed',
	dismiss: 'dismissed',
	reopen: 'reopened'
} as const;

type Action = keyof typeof ACTIONS;

export const POST = async ({ params, request, locals }: RequestEvent) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as {
		action?: unknown;
		reason?: unknown;
		days?: unknown;
		category?: unknown;
	};

	const action = body.action as Action;
	if (typeof action !== 'string' || !(action in ACTIONS)) {
		return json(
			{ error: `Action attendue parmi : ${Object.keys(ACTIONS).join(', ')}.` },
			{ status: 400 }
		);
	}
	const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
	if (!reason) return json({ error: 'Une raison est requise.' }, { status: 400 });

	const found = await getFindingWithEvidence(params.id!, db);
	if (!found) return json({ error: 'Finding introuvable' }, { status: 404 });

	const toStatus = ACTIONS[action];
	if (!canTransition(found.finding.status, toStatus)) {
		return json(
			{
				error: `Transition ${found.finding.status} → ${toStatus} illégale (graphe §10.1).`,
				code: 'illegal_transition'
			},
			{ status: 409 }
		);
	}

	const actor = `user:${locals.user.email}`;
	const base = { findingId: found.finding.id, projectId: found.finding.projectId, reason, actor };

	// Les trois raccourcis FIND-003 portent des effets de bord que
	// `transitionFinding` seul n'appliquerait pas (échéance de veille, catégorie de
	// dismiss) : passer par eux, jamais autour.
	if (action === 'snooze') {
		const days = Number(body.days);
		const result = await snoozeFinding(
			{ ...base, days: Number.isFinite(days) && days > 0 ? Math.floor(days) : undefined },
			db
		);
		return json({ ok: true, status: toStatus, snoozedUntil: result.snoozedUntil });
	}
	if (action === 'dismiss') {
		const category = typeof body.category === 'string' ? body.category.trim() : undefined;
		await dismissFinding({ ...base, category: category || undefined }, db);
		return json({
			ok: true,
			status: toStatus,
			// Le dismiss vaut à vie pour ce fingerprint : le dire, sinon on croit
			// avoir masqué un finding pour cette semaine.
			note: 'Écarté définitivement : seule une réouverture explicite le fera revenir.'
		});
	}
	if (action === 'reopen') {
		await reopenFinding(base, db);
		return json({ ok: true, status: toStatus });
	}

	await transitionFinding({ ...base, toStatus }, db);
	return json({ ok: true, status: toStatus });
};
