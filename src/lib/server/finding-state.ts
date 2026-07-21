/**
 * DATA-005 — Helpers PURS pour les findings (SPEC §7.6/§7.7/§10).
 *
 * Zéro import (ni db, ni `$env`) → testables en isolation par vitest.
 * Portent les invariants d'acceptation DATA-005 :
 *   - le même problème sur deux semaines conserve le MÊME finding (fingerprint
 *     déterministe = clé d'upsert, en miroir de l'unique posé dans schema.ts) ;
 *   - la priorité est un score explicite et borné (barème §10.2) ;
 *   - une transition d'état/sévérité se traduit par un `event_type` dérivable.
 */

// ── Vocabulaire (SPEC §7.6 / §10.4) ─────────────────────────────────

/** Catalogue initial des types de findings (SPEC §10.4). */
export const FINDING_TYPES = [
	'keyword_opportunity',
	'keyword_decline',
	'new_query',
	'lost_query',
	'ctr_gap',
	'content_decay',
	'target_url_mismatch',
	'cannibalization',
	'index_drop',
	'crawled_not_indexed',
	'discovered_not_indexed',
	'canonical_conflict',
	'sitemap_anomaly',
	'redirect_in_sitemap',
	'soft_404',
	'traffic_anomaly',
	'conversion_drop',
	'review_pending_sla',
	'negative_review',
	'integration_stale'
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

/**
 * Statuts persistés = les 7 de SPEC §7.6 + `reopened` (réapparition après
 * résolution, explicite dans le cycle de vie §10.1). `new` reste transitoire :
 * un finding naît directement `open`.
 */
export const FINDING_STATUSES = [
	'open',
	'acknowledged',
	'planned',
	'in_progress',
	'resolved',
	'dismissed',
	'snoozed',
	'reopened'
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Statuts terminaux : un finding y arrête son cycle actif (jusqu'à réouverture). */
export const TERMINAL_STATUSES = ['resolved', 'dismissed'] as const;

/** Sévérités (SPEC §7.6). */
export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** Types d'entité qu'un finding peut viser (SPEC §7.6). */
export const FINDING_ENTITY_TYPES = ['project', 'query', 'page', 'review', 'integration'] as const;
export type FindingEntityType = (typeof FINDING_ENTITY_TYPES)[number];

/** Types d'événement du journal append-only (SPEC §7.7). */
export const FINDING_EVENT_TYPES = [
	'created',
	'aggravated',
	'improved',
	'agent_comment',
	'validated',
	'rejected',
	'snoozed',
	'reopened',
	'resolved'
] as const;
export type FindingEventType = (typeof FINDING_EVENT_TYPES)[number];

/** Auteurs possibles d'un événement (cause/auteur, acceptation DATA-005). */
export const FINDING_ACTORS = ['schedule', 'user', 'agent', 'system', 'detector'] as const;
export type FindingActor = (typeof FINDING_ACTORS)[number];

// ── Fingerprint stable (dédup ; acceptation "même problème = même finding") ──

/**
 * Séparateur de fingerprint : ASCII Unit Separator (0x1F). Non imprimable, jamais
 * présent dans une query/URL/keyword légitime → pas de collision entre dimensions.
 * Aligné sur `observation-state.FINGERPRINT_SEP` (même discipline de dédup).
 */
export const FINDING_FINGERPRINT_SEP = '\x1f';

/**
 * Clé déterministe et STABLE d'un finding, en miroir de l'unique posé en DB
 * (`findings_fingerprint_unique` sur project_id + fingerprint). Le même problème
 * (même type + entité + discriminants) redétecté une autre semaine produit la
 * MÊME clé → upsert (jamais un doublon). La normalisation (trim/minuscule des
 * URLs/queries) est laissée à l'appelant ; les parties sont jointes par le
 * séparateur réservé.
 *
 * @throws si `type`/`entityType` sont vides, ou si une partie contient le
 *         séparateur réservé (casserait la dédup silencieusement).
 */
export function deriveFindingFingerprint(input: {
	type: string;
	entityType: string;
	entityKey?: string | null;
	discriminators?: (string | number)[];
}): string {
	if (!input.type) throw new Error('Fingerprint finding : type manquant.');
	if (!input.entityType) throw new Error('Fingerprint finding : entityType manquant.');
	const parts = [
		input.type,
		input.entityType,
		input.entityKey ?? '',
		...(input.discriminators ?? []).map((d) => String(d))
	];
	parts.forEach((p, i) => {
		if (p.includes(FINDING_FINGERPRINT_SEP)) {
			throw new Error(`Fingerprint finding : partie #${i} contient le séparateur réservé.`);
		}
	});
	return parts.join(FINDING_FINGERPRINT_SEP);
}

// ── Priorité (barème SPEC §10.2) ────────────────────────────────────

/** Borne un score entier dans [min, max] (défaut [0, 100]). */
export function clampScore(value: number, min = 0, max = 100): number {
	if (Number.isNaN(value)) return min;
	return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Plafonds des composantes du score de priorité (SPEC §10.2) :
 *   priority = impact (0–40) + urgency (0–25) + confidence (0–20) + strategic_fit (0–15)
 * Somme maximale = 100. Chaque composante est bornée avant sommation.
 */
export const PRIORITY_WEIGHTS = {
	impact: 40,
	urgency: 25,
	confidence: 20,
	strategicFit: 15
} as const;

/**
 * Score de priorité déterministe 0–100 à partir de ses 4 composantes. Chaque
 * composante est bornée à son plafond (§10.2) puis sommée. Le score et ses
 * composantes restent visibles/explicables (SPEC §10.2 : « l'agent peut commenter
 * la priorité mais ne remplace pas le calcul de base »).
 */
export function computePriorityScore(input: {
	impact: number;
	urgency: number;
	confidence: number;
	strategicFit: number;
}): number {
	const impact = clampScore(input.impact, 0, PRIORITY_WEIGHTS.impact);
	const urgency = clampScore(input.urgency, 0, PRIORITY_WEIGHTS.urgency);
	const confidence = clampScore(input.confidence, 0, PRIORITY_WEIGHTS.confidence);
	const strategicFit = clampScore(input.strategicFit, 0, PRIORITY_WEIGHTS.strategicFit);
	return impact + urgency + confidence + strategicFit;
}

// ── Transitions → event_type dérivé (journal §7.7) ──────────────────

/** Vrai si `status` est un statut terminal (resolved/dismissed). */
export function isTerminalStatus(status: string): boolean {
	return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Dérive l'`event_type` d'un changement de SÉVÉRITÉ : une sévérité qui monte est
 * une aggravation, qui baisse une amélioration, inchangée = pas d'événement.
 * Retourne `null` si l'une des sévérités est inconnue (pas d'événement inventé).
 */
export function deriveSeverityEventType(
	oldSeverity: string,
	newSeverity: string
): 'aggravated' | 'improved' | null {
	const order = FINDING_SEVERITIES as readonly string[];
	const a = order.indexOf(oldSeverity);
	const b = order.indexOf(newSeverity);
	if (a < 0 || b < 0 || a === b) return null;
	return b > a ? 'aggravated' : 'improved';
}

/**
 * Dérive l'`event_type` d'un changement de STATUT (SPEC §7.7). Statuts sans
 * événement dédié dans le catalogue (acknowledged/planned/in_progress) tombent sur
 * `validated` (décision humaine/agent enregistrée). Retourne `null` si aucun
 * changement.
 */
export function deriveStatusEventType(
	fromStatus: string,
	toStatus: string
): FindingEventType | null {
	if (fromStatus === toStatus) return null;
	switch (toStatus) {
		case 'resolved':
			return 'resolved';
		case 'dismissed':
			return 'rejected';
		case 'snoozed':
			return 'snoozed';
		case 'reopened':
		case 'open':
			// Repasser à un état actif depuis un terminal = réouverture.
			return isTerminalStatus(fromStatus) ? 'reopened' : 'validated';
		default:
			return 'validated';
	}
}
