import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import { getFindingWithEvidence } from '$lib/server/findings.js';
import { listProposalsOfFinding } from '$lib/server/proposals.js';
import { canTransition, LIFECYCLE_DEFAULTS } from '$lib/server/finding-state.js';
import { toDbTimestamp } from '$lib/server/timestamps.js';

/**
 * DASH-004 — Un finding, ses preuves, son histoire.
 *
 * Les actions offertes sont dérivées du graphe §10.1 (`canTransition`) et non
 * d'une liste écrite à la main dans le template : l'endpoint applique la même
 * fonction, donc l'écran ne peut pas proposer un geste que l'écriture refusera.
 *
 * Rien n'est synthétisé ici. `evidence_json` est rendu tel que le détecteur l'a
 * écrit — l'acceptation « aucune affirmation ne manque de source identifiable »
 * n'est tenable que si la source est montrée, pas résumée.
 */
const ACTIONS = [
	{ key: 'acknowledge', to: 'acknowledged', label: 'Prendre en compte' },
	{ key: 'plan', to: 'planned', label: 'Planifier' },
	{ key: 'start', to: 'in_progress', label: 'Démarrer' },
	{ key: 'resolve', to: 'resolved', label: 'Marquer résolu' },
	{ key: 'snooze', to: 'snoozed', label: 'Mettre en veille' },
	{ key: 'dismiss', to: 'dismissed', label: 'Écarter' },
	{ key: 'reopen', to: 'reopened', label: 'Rouvrir' }
] as const;

export const load: PageServerLoad = async ({ params }) => {
	const found = await getFindingWithEvidence(params.id, db);
	if (!found) throw error(404, 'Finding introuvable');

	// Les propositions issues de ce finding : c'est le lien que la chaîne SPEC
	// promet (`findings → propositions`) et que rien ne montrait jusqu'ici.
	const proposals = await listProposalsOfFinding(found.finding.id, db);

	return {
		finding: found.finding,
		project: found.project,
		events: found.events,
		proposals,
		actions: ACTIONS.filter((a) => canTransition(found.finding.status, a.to)),
		defaultSnoozeDays: LIFECYCLE_DEFAULTS.defaultSnoozeDays,
		now: toDbTimestamp(new Date())
	};
};
