import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db/index.js';
import { recordPauseDecision } from '$lib/server/pauses.js';
import { PAUSE_EVENT_TYPES, isPauseEventType } from '$lib/server/pause-state.js';
import { toDbTimestampPlus } from '$lib/server/timestamps.js';

/**
 * DASH-006 lot 2 — La seule porte humaine des pauses d'automatisation.
 *
 * Cet endpoint ne réimplémente RIEN : il appelle `recordPauseDecision`, qui valide la
 * cible, dérive l'état courant et écrit le journal dans une même transaction. Les
 * contrôles faits ici (vocabulaire, raison, échéance) servent à rendre un 400 lisible
 * plutôt qu'un 500 — la garde qui compte est celle de l'écriture, comme pour les findings.
 *
 * Une RAISON est exigée dans les deux sens, y compris pour REPRENDRE. C'est délibéré :
 * « pourquoi le monitoring de ce client a-t-il redémarré le 12 août » est exactement la
 * question qu'on se posera trois semaines plus tard, et une reprise sans motif y répond
 * par un blanc. L'acceptation dit « pause ET reprise sont auditables ».
 *
 * ⚠️ Rejouer le même geste n'est PAS une erreur : la réponse porte `idempotent: true` et
 * rien n'a été écrit. Un double clic doit être un non-événement, jamais un 409 — sans
 * quoi l'écran devrait apprendre à distinguer « déjà fait » de « refusé ».
 */
export const POST = async ({ request, locals }: RequestEvent) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as {
		eventType?: unknown;
		scope?: unknown;
		projectId?: unknown;
		cadence?: unknown;
		provider?: unknown;
		reason?: unknown;
		untilDays?: unknown;
	};

	if (!isPauseEventType(body.eventType)) {
		return json(
			{ error: `eventType attendu parmi : ${PAUSE_EVENT_TYPES.join(', ')}.` },
			{ status: 400 }
		);
	}

	const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
	if (!reason) return json({ error: 'Une raison est requise.' }, { status: 400 });

	// L'échéance se saisit en JOURS et se convertit ici, au format DB. Laisser le client
	// envoyer une date brute inviterait deux formats (ISO côté navigateur, `YYYY-MM-DD
	// HH:MM:SS` en base) dont la comparaison lexicale ne veut plus rien dire.
	let until: string | null = null;
	if (body.untilDays !== undefined && body.untilDays !== null && body.untilDays !== '') {
		const days = Number(body.untilDays);
		if (!Number.isFinite(days) || days < 1 || days > 365) {
			return json({ error: 'Échéance attendue entre 1 et 365 jours.' }, { status: 400 });
		}
		until = toDbTimestampPlus(Math.floor(days) * 24 * 60 * 60 * 1000);
	}
	if (until && body.eventType === 'resumed') {
		return json({ error: 'Une reprise ne porte pas d’échéance.' }, { status: 400 });
	}

	try {
		const result = await recordPauseDecision({
			db,
			target: {
				scope: String(body.scope ?? ''),
				projectId: typeof body.projectId === 'string' ? body.projectId : null,
				cadence: typeof body.cadence === 'string' ? body.cadence : null,
				provider: typeof body.provider === 'string' ? body.provider : null
			},
			eventType: body.eventType,
			reason,
			until,
			actor: `user:${locals.user.email}`
		});

		return json({
			ok: true,
			idempotent: result.idempotent,
			eventId: result.eventId,
			scope: result.target.scope,
			note: result.idempotent
				? 'Déjà dans cet état : aucune nouvelle décision enregistrée.'
				: body.eventType === 'paused'
					? until
						? 'Suspendu. La reprise sera automatique à l’échéance, sans autre geste.'
						: 'Suspendu jusqu’à reprise explicite. Les jobs déjà en file seront conclus au prochain tick.'
					: 'Repris. Le prochain créneau dû repartira ; les créneaux manqués entre-temps sont perdus.'
		});
	} catch (err) {
		// `normalizePauseTarget` / `normalizePauseReason` lèvent sur une cible ou une
		// raison invalides : ce sont des 400, pas des 500.
		return json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
	}
};
