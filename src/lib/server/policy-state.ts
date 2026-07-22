/**
 * DATA-007 — Helpers PURS pour les politiques d'avis & d'automatisation (SPEC §7.10).
 *
 * Zéro import (ni db, ni `$env`, ni crypto) → testables en isolation par vitest.
 * Portent les invariants du BACKLOG DATA-007 :
 *   - le kill switch bloque les ENVOIS sans bloquer la synchronisation
 *     (evaluatePolicyGates : `syncAllowed` ignore délibérément le kill switch) ;
 *   - `draft_only`/`manual` n'autorisent jamais l'envoi autonome ; seul
 *     `guarded_auto` envoie, et uniquement les avis éligibles (canAutoSendReview) ;
 *   - une policy est versionnée → une ancienne proposition ne profite jamais
 *     silencieusement d'une nouvelle policy (le versionnage vit dans policies.ts,
 *     ici on fournit `nextPolicyVersion` + la canonicalisation qui alimente le hash).
 */

// ── Vocabulaire (SPEC §7.10) ────────────────────────────────────────

/** Modes d'automatisation (SPEC §7.10 / §8.4). */
export const POLICY_MODES = ['draft_only', 'guarded_auto', 'manual'] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

/** Statuts de version d'une policy. `current` = effective, `superseded` = historique. */
export const POLICY_STATUSES = ['current', 'superseded'] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

/** Nature d'une promotion (journal policy_promotions). */
export const POLICY_PROMOTION_KINDS = [
	'create',
	'mode_change',
	'kill_switch',
	'config_change'
] as const;
export type PolicyPromotionKind = (typeof POLICY_PROMOTION_KINDS)[number];

/** Sentinelle de scope projet-wide (aucune localisation ciblée). */
export const PROJECT_WIDE_SCOPE = '*';

// ── Scope & versionnage ─────────────────────────────────────────────

/**
 * Clé de scope d'une policy : l'id de localisation, ou `'*'` pour une policy
 * projet-wide. Rend robuste l'unicité « une seule policy courante par scope »
 * (Postgres traite les NULL comme distincts → deux policies projet-wide `current`
 * pourraient coexister sans cette sentinelle).
 */
export function deriveScopeKey(locationId?: string | null): string {
	return locationId && locationId.length > 0 ? locationId : PROJECT_WIDE_SCOPE;
}

/** Numéro de version suivant (les versions commencent à 1). */
export function nextPolicyVersion(currentVersion?: number | null): number {
	return (currentVersion ?? 0) + 1;
}

// ── Config canonique (alimente le hash de dédup) ────────────────────

/** Champs de configuration d'une policy (SPEC §7.10), hors identité/versionnage. */
export interface PolicyConfig {
	mode: string;
	syncEnabled: boolean;
	autoGenerationEnabled: boolean;
	killSwitch: boolean;
	minRatingForAutoSend?: number | null;
	sendDelayMinutes?: number | null;
	jitterMinutes?: number | null;
	sendWindowsJson?: string | null;
	defaultLanguage?: string | null;
	signature?: string | null;
	escalationCategoriesJson?: string | null;
	maxSendsPerRun?: number | null;
}

/**
 * Sérialisation déterministe et stable de la config (ordre de champs figé,
 * `undefined` normalisé en `null`). Deux configs sémantiquement égales produisent
 * la même chaîne → le hash calculé par-dessus (policies.ts) dédup une re-promotion
 * identique. NE PAS réordonner les champs sans invalider tous les hash existants.
 */
export function canonicalPolicyConfig(config: PolicyConfig): string {
	const norm = <T>(v: T | undefined | null): T | null => (v === undefined || v === null ? null : v);
	return JSON.stringify([
		norm(config.mode),
		norm(config.syncEnabled),
		norm(config.autoGenerationEnabled),
		norm(config.killSwitch),
		norm(config.minRatingForAutoSend),
		norm(config.sendDelayMinutes),
		norm(config.jitterMinutes),
		norm(config.sendWindowsJson),
		norm(config.defaultLanguage),
		norm(config.signature),
		norm(config.escalationCategoriesJson),
		norm(config.maxSendsPerRun)
	]);
}

// ── Portes d'automatisation (kill switch ⟂ sync) ────────────────────

/**
 * Kill switch effectif pour une localisation : le kill switch de la policy locale
 * OU celui de la policy projet-wide. Un des deux suffit à bloquer les envois.
 */
export function resolveEffectiveKillSwitch(input: {
	locationKillSwitch?: boolean | null;
	projectKillSwitch?: boolean | null;
}): boolean {
	return Boolean(input.locationKillSwitch) || Boolean(input.projectKillSwitch);
}

/**
 * Portes d'automatisation dérivées d'une policy. INVARIANT DATA-007 :
 *   - `syncAllowed` = `syncEnabled` SEUL — le kill switch ne bloque JAMAIS la sync
 *     (« le kill switch bloque les envois sans bloquer la synchronisation ») ;
 *   - `autoSendAllowed` exige `guarded_auto` + génération auto + pas de kill switch.
 */
export function evaluatePolicyGates(policy: {
	mode: string;
	syncEnabled?: boolean | null;
	autoGenerationEnabled?: boolean | null;
	killSwitch?: boolean | null;
}): { syncAllowed: boolean; autoSendAllowed: boolean; reason: string } {
	const syncAllowed = policy.syncEnabled !== false; // kill switch ignoré ici, volontairement
	if (policy.mode !== 'guarded_auto') {
		return { syncAllowed, autoSendAllowed: false, reason: `mode ${policy.mode} : jamais d'envoi autonome` };
	}
	if (policy.killSwitch) {
		return { syncAllowed, autoSendAllowed: false, reason: 'kill switch actif' };
	}
	if (!policy.autoGenerationEnabled) {
		return { syncAllowed, autoSendAllowed: false, reason: 'génération automatique désactivée' };
	}
	return { syncAllowed, autoSendAllowed: true, reason: 'envoi automatique autorisé' };
}

/**
 * Décide si un avis précis peut partir automatiquement sous la policy effective
 * (SPEC §8.4). Refus par défaut (jamais d'envoi non prévu). Ordre des gardes :
 * mode → kill switch → génération auto → catégorie escaladée → note minimale.
 */
export function canAutoSendReview(input: {
	mode: string;
	killSwitch?: boolean | null;
	autoGenerationEnabled?: boolean | null;
	rating?: number | null;
	minRatingForAutoSend?: number | null;
	category?: string | null;
	escalationCategories?: readonly string[] | null;
}): { allowed: boolean; reason: string } {
	if (input.mode !== 'guarded_auto') {
		return { allowed: false, reason: `mode ${input.mode} : jamais d'envoi autonome` };
	}
	if (input.killSwitch) {
		return { allowed: false, reason: 'kill switch actif' };
	}
	if (!input.autoGenerationEnabled) {
		return { allowed: false, reason: 'génération automatique désactivée' };
	}
	if (
		input.category &&
		input.escalationCategories &&
		input.escalationCategories.includes(input.category)
	) {
		return { allowed: false, reason: `catégorie escaladée : ${input.category}` };
	}
	if (
		input.minRatingForAutoSend != null &&
		input.rating != null &&
		input.rating < input.minRatingForAutoSend
	) {
		return {
			allowed: false,
			reason: `note ${input.rating} < minimale ${input.minRatingForAutoSend}`
		};
	}
	return { allowed: true, reason: 'éligible envoi automatique' };
}

// ── Classification d'une promotion ──────────────────────────────────

/**
 * Nature d'une promotion à journaliser : `create` si pas de version précédente ;
 * sinon `mode_change` (le mode change) prime, puis `kill_switch` (bascule du seul
 * kill switch), sinon `config_change`.
 */
export function derivePromotionKind(input: {
	hadPrevious: boolean;
	modeChanged: boolean;
	killSwitchChanged: boolean;
}): PolicyPromotionKind {
	if (!input.hadPrevious) return 'create';
	if (input.modeChanged) return 'mode_change';
	if (input.killSwitchChanged) return 'kill_switch';
	return 'config_change';
}
