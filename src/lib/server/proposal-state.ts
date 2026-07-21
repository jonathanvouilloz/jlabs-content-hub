/**
 * DATA-006 — Helpers PURS pour propositions & approbations (SPEC §7.8/§12).
 *
 * Zéro import (ni db, ni `$env`) → testables en isolation par vitest.
 * Portent les invariants d'autorisation (SPEC §12.2) :
 *   - une approbation est liée au HASH exact de la proposition ; toute modification
 *     du payload l'invalide (isApprovalValid : hash égal + active + non expirée) ;
 *   - un agent ne peut pas s'auto-accorder un niveau supérieur (canActorApprove :
 *     L4 = humain seul, L3 = user/policy, agent ≤ L2).
 */

// ── Vocabulaire (SPEC §7.8 / §12.1) ─────────────────────────────────

/** Statuts d'une proposition : 7 de §7.8 + `invalidated` (payload modifié après
 *  approbation) + `expired`. */
export const PROPOSAL_STATUSES = [
	'proposed',
	'approved',
	'rejected',
	'executing',
	'executed',
	'failed',
	'superseded',
	'invalidated',
	'expired'
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Niveaux d'autonomie/validation (SPEC §12.1). L0 auto → L4 toujours humaine. */
export const APPROVAL_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

/** Statuts d'une approbation. */
export const APPROVAL_STATUSES = ['active', 'consumed', 'expired', 'revoked', 'invalidated'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Qui peut approuver (SPEC §12 : humain, agent — borné —, ou policy explicite). */
export const APPROVER_TYPES = ['user', 'agent', 'policy'] as const;
export type ApproverType = (typeof APPROVER_TYPES)[number];

/** Canal d'approbation. */
export const APPROVAL_METHODS = ['ui', 'telegram', 'policy'] as const;
export type ApprovalMethod = (typeof APPROVAL_METHODS)[number];

/** Statut de vérification post-exécution (SPEC §7.8 verification_status). */
export const VERIFICATION_STATUSES = ['pending', 'passed', 'failed', 'skipped'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Statut d'un agent run (SPEC §7.9). */
export const AGENT_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** Nature de la sortie d'un agent run. */
export const OUTPUT_TYPES = ['proposal', 'report'] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];

// ── Séparation des niveaux (« un agent ne peut pas élever son niveau ») ──

/**
 * Niveau d'approbation maximal qu'un type d'acteur peut accorder de lui-même
 * (SPEC §12.1/§12.2) :
 *   - `user`   : tous les niveaux (L0–L4) ;
 *   - `policy` : jusqu'à L3 (une policy explicite peut autoriser une publication),
 *                mais JAMAIS L4 (§12.2 : « les actions L4 ne peuvent pas être
 *                activées en auto par simple configuration ») ;
 *   - `agent`  : jusqu'à L2 (diagnostiquer/prioriser/brouillon) ; L3/L4 lui sont
 *                interdits (il ne peut pas s'auto-accorder un scope supérieur).
 */
const MAX_LEVEL_BY_ACTOR: Record<ApproverType, number> = {
	user: 4,
	policy: 3,
	agent: 2
};

/**
 * Vrai si `actorType` peut approuver une proposition de niveau `level`. Enforce
 * l'invariant §12.2 « un agent ne peut pas s'auto-accorder un scope supérieur ».
 * Retourne `false` pour tout acteur/niveau inconnu (refus par défaut, jamais
 * d'escalade silencieuse).
 */
export function canActorApprove(input: { actorType: string; level: string }): boolean {
	const max = MAX_LEVEL_BY_ACTOR[input.actorType as ApproverType];
	const idx = (APPROVAL_LEVELS as readonly string[]).indexOf(input.level);
	if (max === undefined || idx < 0) return false;
	return idx <= max;
}

// ── Validité d'une approbation (« modifier le payload l'invalide ») ──

/**
 * Vrai si une approbation est encore valide au moment `now`. Trois conditions
 * cumulatives (SPEC §12.2) :
 *   1. `status === 'active'` (ni consommée, révoquée, expirée ou invalidée) ;
 *   2. `approvedPayloadHash === currentPayloadHash` — le payload n'a pas changé
 *      depuis l'approbation (« toute modification du payload invalide l'approbation ») ;
 *   3. non expirée : pas d'`expiresAt`, ou `now` strictement avant.
 * `now`/`expiresAt` comparés comme chaînes ISO (ordre lexical = chronologique).
 */
export function isApprovalValid(input: {
	status: string;
	approvedPayloadHash: string;
	currentPayloadHash: string;
	expiresAt?: string | null;
	now: string;
}): boolean {
	if (input.status !== 'active') return false;
	if (input.approvedPayloadHash !== input.currentPayloadHash) return false;
	if (input.expiresAt && input.now >= input.expiresAt) return false;
	return true;
}

// ── Transitions de proposition ──────────────────────────────────────

/** Statuts terminaux d'une proposition (cycle actif clos). */
export const TERMINAL_PROPOSAL_STATUSES = [
	'executed',
	'failed',
	'rejected',
	'superseded',
	'expired'
] as const;

/** Vrai si `status` est terminal. */
export function isTerminalProposalStatus(status: string): boolean {
	return (TERMINAL_PROPOSAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Dérive le statut d'une proposition suite à une modification de son payload : si
 * elle était `approved`, elle retombe à `invalidated` (l'approbation ne tient plus) ;
 * sinon elle reste `proposed`. Toute autre valeur en entrée est inchangée.
 */
export function statusAfterPayloadChange(currentStatus: string): ProposalStatus {
	if (currentStatus === 'approved') return 'invalidated';
	if (currentStatus === 'proposed' || currentStatus === 'invalidated') return 'proposed';
	return currentStatus as ProposalStatus;
}
