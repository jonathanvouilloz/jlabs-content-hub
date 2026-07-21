/**
 * GOV-005 — Feature flags de migration.
 *
 * Chaque vertical slice risqué de la reconstruction agentique (BACKLOG) est
 * gardé par un flag, pour l'activer sur un seul projet canary avant généralisation.
 *
 * Invariants (BACKLOG GOV-005) :
 *   - override global (env) ET override par projet ;
 *   - désactiver un flag ne supprime AUCUNE donnée — un flag ne fait que router
 *     le comportement, jamais muter/effacer le stockage ;
 *   - la configuration réellement appliquée est journalisable dans chaque run
 *     (`describeFlags`), pour tracer ce qui tournait.
 *
 * Défaut : tout est `false`. Ces fonctionnalités n'existent pas encore ou ne
 * sont pas éprouvées ; rien ne s'active par accident.
 *
 * Override global : variable d'env `FLAG_<NOM_MAJUSCULE>` = `true|1|on|yes`.
 *   ex. `FLAG_INDEXNOW=true`.
 * Override par projet : passé explicitement via `FlagContext.projectOverrides`.
 *   La source DB (settings projet) arrivera avec DATA-002 ; l'API est déjà prête
 *   à la recevoir sans invention de schéma ici.
 */

import { get } from './config.js';

export const FEATURE_FLAGS = [
	'jobs_v2', // queue durable + workers (E02)
	'findings', // moteur de findings + inbox (E05)
	'indexnow', // interrupteur maître des soumissions auto aux moteurs : IndexNow (E04) ET Google Indexing API éligible (IDX-008). OFF => aucune soumission ne part.
	'plausible', // provider analytics Plausible (E10)
	'gmb_auto_send', // envoi automatique des réponses d'avis (E08)
	'telegram', // notifications + validations Telegram (E09)
	'agent_runner' // runner d'agents sur worktrees (E11)
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

const TRUTHY = new Set(['true', '1', 'on', 'yes']);

function envFlagName(flag: FeatureFlag): string {
	return `FLAG_${flag.toUpperCase()}`;
}

/** Valeur globale d'un flag, lue depuis l'env (défaut false). */
function globalValue(flag: FeatureFlag): boolean {
	const raw = get(envFlagName(flag));
	return raw !== undefined && TRUTHY.has(raw.toLowerCase());
}

export interface FlagContext {
	/** Slug du projet concerné, si l'évaluation est contextualisée. */
	project?: string;
	/** Overrides par flag pour ce projet (ex. depuis la DB plus tard). */
	projectOverrides?: Partial<Record<FeatureFlag, boolean>>;
}

/**
 * Résout un flag : override projet s'il est fourni, sinon valeur globale env.
 */
export function isEnabled(flag: FeatureFlag, ctx: FlagContext = {}): boolean {
	const override = ctx.projectOverrides?.[flag];
	if (override !== undefined) return override;
	return globalValue(flag);
}

/** Carte effective de tous les flags dans un contexte donné. */
export function resolveFlags(ctx: FlagContext = {}): Record<FeatureFlag, boolean> {
	const out = {} as Record<FeatureFlag, boolean>;
	for (const flag of FEATURE_FLAGS) out[flag] = isEnabled(flag, ctx);
	return out;
}

/**
 * Résumé sérialisable des flags effectifs, destiné aux logs de run
 * (`logger.info('run start', describeFlags(ctx))`).
 */
export function describeFlags(ctx: FlagContext = {}): { flags: Record<FeatureFlag, boolean>; project?: string } {
	return { flags: resolveFlags(ctx), project: ctx.project };
}
