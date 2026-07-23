/**
 * DATA-006 — Écriture de propositions, approbations & agent runs.
 *
 * - `createProposal` : upsert idempotent (unique projet+finding+action+payload_hash)
 *   → une re-proposition identique ne duplique pas.
 * - `approveProposal` : refuse (throw) si l'acteur ne peut pas accorder le niveau
 *   requis (canActorApprove), sinon crée une approbation LIÉE au payload_hash courant
 *   et passe la proposition à `approved`. Transactionnel.
 * - `updateProposalPayload` : recalcule le hash, invalide toute approbation active
 *   et repasse la proposition à `invalidated` (« modifier le payload l'invalide »).
 * - `recordAgentRun`/`finishAgentRun` : journal d'invocation d'agent (tokens/coût).
 *
 * Garde commune : payloads BORNÉS (assertBoundedPayload) et sans secret
 * (assertNoInlineSecret) avant persistance.
 */
import { createHash } from 'node:crypto';
import { eq, and, asc, desc, inArray, sql } from 'drizzle-orm';
import {
	actionProposals,
	proposalApprovals,
	agentRuns,
	projects,
	findings,
	findingEvents
} from './db/schema.js';
import type { AppDb } from './db/types.js';
import { createId } from './utils.js';
import { assertNoInlineSecret } from './projection-state.js';
import { assertBoundedPayload } from './observation-state.js';
import { toDbTimestamp } from './timestamps.js';
import {
	canActorApprove,
	isDecidableStatus,
	statusAfterPayloadChange,
	type ApproverType,
	type ApprovalMethod
} from './proposal-state.js';

/**
 * Format DB canonique (cf. `timestamps.ts`). Ces colonnes ont un DEFAULT SQL
 * `to_char(now(), 'YYYY-MM-DD HH24:MI:SS')` : y écrire de l'ISO mélangerait deux
 * formats dans une même colonne et casserait la comparaison LEXICALE dont
 * `isApprovalValid` dépend pour juger de l'expiration d'une approbation
 * (`'…T09:00:00.000Z'` > `'… 23:00:00'`, parce que `'T'` > `' '`).
 */
const nowDb = () => toDbTimestamp();

/**
 * Client d'écriture : celui de l'app par défaut, ou un client INJECTÉ (runner
 * `scripts/`, qui construit son propre Pool). Même idiome que `findings.ts` :
 * l'import de `db/index.js` est DYNAMIQUE et n'a lieu qu'à défaut de client
 * fourni, sinon ce module tirerait `$env/dynamic/private` et deviendrait
 * inchargeable hors runtime SvelteKit — donc impossible à prouver sur Neon
 * depuis un script.
 */
async function resolveDb(client?: AppDb): Promise<AppDb> {
	if (client) return client;
	const mod = await import('./db/index.js');
	return mod.db;
}

function guardPayload(payloadJson: string | null | undefined, context: string): void {
	assertBoundedPayload(payloadJson, context);
	assertNoInlineSecret(payloadJson, context);
}

/** Hash canonique d'un payload de proposition : sha256 hex de la chaîne stockée.
 *  Toute modification du payload_json change le hash → invalide l'approbation liée. */
export function computePayloadHash(payloadJson: string | null | undefined): string {
	return createHash('sha256')
		.update(payloadJson ?? '')
		.digest('hex');
}

// ── Proposition (upsert idempotent) ─────────────────────────────────

export interface CreateProposalInput {
	projectId: string;
	findingId?: string | null;
	actionType: string;
	target?: string | null;
	rationale?: string | null;
	expectedImpact?: string | null;
	riskLevel?: string | null;
	requiredApprovalLevel?: string;
	proposedBy?: string;
	payloadJson?: string | null;
	inputHashesJson?: string | null;
}

export interface CreateProposalResult {
	id: string;
	payloadHash: string;
}

/**
 * Insère une proposition, ou rafraîchit l'existante si identique (même projet +
 * finding + action + hash de payload).
 *
 * Sur conflit, les champs NON HASHÉS sont rafraîchis (`rationale`,
 * `expected_impact`, `input_hashes_json`) : ce sont les chiffres du moment, et
 * une proposition qui garderait éternellement le rationale de sa première
 * semaine afficherait des mesures périmées à qui doit décider. Le
 * `payload_hash`, lui, ne bouge pas — donc aucune approbation liée n'est
 * invalidée, conformément à §12.2 (« seule une modification du PAYLOAD invalide
 * l'approbation »). Le statut n'est jamais retouché ici : une proposition
 * approuvée ou rejetée le reste.
 */
export async function createProposal(
	input: CreateProposalInput,
	client?: AppDb
): Promise<CreateProposalResult> {
	guardPayload(input.payloadJson, 'payload_json proposition');
	guardPayload(input.inputHashesJson, 'input_hashes_json proposition');
	const db = await resolveDb(client);
	const payloadHash = computePayloadHash(input.payloadJson);
	const id = createId();
	const now = nowDb();

	const rows = await db
		.insert(actionProposals)
		.values({
			id,
			projectId: input.projectId,
			findingId: input.findingId ?? null,
			actionType: input.actionType,
			target: input.target ?? null,
			rationale: input.rationale ?? null,
			expectedImpact: input.expectedImpact ?? null,
			riskLevel: input.riskLevel ?? null,
			requiredApprovalLevel: input.requiredApprovalLevel ?? 'L2',
			proposedBy: input.proposedBy ?? 'agent',
			payloadJson: input.payloadJson ?? null,
			payloadHash,
			inputHashesJson: input.inputHashesJson ?? null,
			updatedAt: now
		})
		.onConflictDoUpdate({
			// Dédup idempotente : re-proposition identique → aucun doublon.
			target: [
				actionProposals.projectId,
				actionProposals.findingId,
				actionProposals.actionType,
				actionProposals.payloadHash
			],
			set: {
				rationale: input.rationale ?? null,
				expectedImpact: input.expectedImpact ?? null,
				riskLevel: input.riskLevel ?? null,
				inputHashesJson: input.inputHashesJson ?? null,
				updatedAt: now
			}
		})
		.returning({ id: actionProposals.id });

	return { id: rows[0].id, payloadHash };
}

/**
 * Propositions déjà connues pour un finding — ce que `decideSupersession`
 * (proposer-state.ts) relit avant d'écrire, pour ne jamais laisser deux
 * propositions vivantes porter la même intention sur la même cible.
 */
export async function listProposalsForFinding(
	findingId: string,
	client?: AppDb
): Promise<{ id: string; actionType: string; payloadHash: string; status: string }[]> {
	const db = await resolveDb(client);
	return db
		.select({
			id: actionProposals.id,
			actionType: actionProposals.actionType,
			payloadHash: actionProposals.payloadHash,
			status: actionProposals.status
		})
		.from(actionProposals)
		.where(eq(actionProposals.findingId, findingId));
}

// ── Lecture (DASH-005 — l'inbox) ────────────────────────────────────
//
// Ce module n'a longtemps porté que des ÉCRITURES : le producteur écrivait des
// propositions que personne ne relisait — le piège AGT-000, transposé à la couche
// de sortie. Ces lecteurs sont les seuls que l'inbox, la CLI et l'API agent
// utiliseront : les avoir ici évite que chacun réinvente son filtre de statut (et
// se trompe sur `superseded`/`invalidated`).

/** Une proposition telle que l'inbox la lit : avec son projet et son finding. */
export interface ProposalRow {
	id: string;
	projectId: string;
	projectSlug: string | null;
	projectName: string | null;
	projectColor: string | null;
	findingId: string | null;
	findingTitle: string | null;
	findingType: string | null;
	findingSeverity: string | null;
	findingPriority: number | null;
	findingStatus: string | null;
	actionType: string;
	target: string | null;
	rationale: string | null;
	expectedImpact: string | null;
	riskLevel: string | null;
	requiredApprovalLevel: string;
	proposedBy: string;
	payloadJson: string | null;
	payloadHash: string;
	inputHashesJson: string | null;
	status: string;
	approvedBy: string | null;
	approvedAt: string | null;
	executionJobId: string | null;
	verificationStatus: string | null;
	createdAt: string;
	updatedAt: string;
}

const PROPOSAL_COLUMNS = {
	id: actionProposals.id,
	projectId: actionProposals.projectId,
	projectSlug: projects.slug,
	projectName: projects.name,
	projectColor: projects.color,
	findingId: actionProposals.findingId,
	findingTitle: findings.title,
	findingType: findings.type,
	findingSeverity: findings.severity,
	findingPriority: findings.priorityScore,
	findingStatus: findings.status,
	actionType: actionProposals.actionType,
	target: actionProposals.target,
	rationale: actionProposals.rationale,
	expectedImpact: actionProposals.expectedImpact,
	riskLevel: actionProposals.riskLevel,
	requiredApprovalLevel: actionProposals.requiredApprovalLevel,
	proposedBy: actionProposals.proposedBy,
	payloadJson: actionProposals.payloadJson,
	payloadHash: actionProposals.payloadHash,
	inputHashesJson: actionProposals.inputHashesJson,
	status: actionProposals.status,
	approvedBy: actionProposals.approvedBy,
	approvedAt: actionProposals.approvedAt,
	executionJobId: actionProposals.executionJobId,
	verificationStatus: actionProposals.verificationStatus,
	createdAt: actionProposals.createdAt,
	updatedAt: actionProposals.updatedAt
} as const;

export interface ListProposalsInput {
	/** Ids explicites — ce que la validation groupée relit AVANT de décider, pour
	 *  reconstruire le lot depuis la BASE et non depuis ce que le client affirme. */
	ids?: readonly string[];
	statuses?: readonly string[];
	levels?: readonly string[];
	risks?: readonly string[];
	projectSlug?: string | null;
	actionType?: string | null;
	limit?: number;
	offset?: number;
}

/**
 * Ordre d'affichage : le risque d'abord (ce qui engage le plus se décide en
 * conscience), puis l'ANCIENNETÉ croissante, puis l'id.
 *
 * L'ancienneté et non la fraîcheur : une proposition qu'on repousse depuis trois
 * semaines doit remonter, pas s'enfoncer. Et `id` en dernier rend l'ordre TOTAL —
 * deux propositions créées dans la même seconde ne peuvent pas permuter d'une
 * pagination à l'autre, ce qui ferait sauter ou dupliquer une ligne entre deux pages.
 */
const RISK_RANK = sql<number>`CASE ${actionProposals.riskLevel}
	WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`;

function proposalFilters(input: ListProposalsInput) {
	const filters = [];
	if (input.ids) {
		// Une liste d'ids VIDE ne doit pas rendre « tout » : c'est la différence
		// entre « je n'ai rien demandé » et « je n'ai pas filtré ».
		filters.push(
			input.ids.length > 0 ? inArray(actionProposals.id, [...input.ids]) : sql`false`
		);
	}
	if (input.statuses && input.statuses.length > 0) {
		filters.push(inArray(actionProposals.status, [...input.statuses]));
	}
	if (input.levels && input.levels.length > 0) {
		filters.push(inArray(actionProposals.requiredApprovalLevel, [...input.levels]));
	}
	if (input.risks && input.risks.length > 0) {
		filters.push(inArray(actionProposals.riskLevel, [...input.risks]));
	}
	if (input.projectSlug) filters.push(eq(projects.slug, input.projectSlug));
	if (input.actionType) filters.push(eq(actionProposals.actionType, input.actionType));
	return filters;
}

/**
 * Liste les propositions de l'inbox. Les jointures sont des LEFT JOIN : une
 * proposition dont le finding a été purgé doit rester visible et décidable — la
 * faire disparaître d'une inbox parce qu'une table voisine a bougé serait le pire
 * mode de panne (silencieux, et il ressemble à « il n'y a rien à faire »).
 */
export async function listProposals(
	input: ListProposalsInput = {},
	client?: AppDb
): Promise<ProposalRow[]> {
	const db = await resolveDb(client);
	const filters = proposalFilters(input);

	return db
		.select(PROPOSAL_COLUMNS)
		.from(actionProposals)
		.leftJoin(projects, eq(projects.id, actionProposals.projectId))
		.leftJoin(findings, eq(findings.id, actionProposals.findingId))
		.where(filters.length > 0 ? and(...filters) : undefined)
		.orderBy(desc(RISK_RANK), asc(actionProposals.createdAt), asc(actionProposals.id))
		.limit(Math.max(1, Math.floor(input.limit ?? 50)))
		.offset(Math.max(0, Math.floor(input.offset ?? 0)));
}

/** Total correspondant aux mêmes filtres (pagination). */
export async function countProposals(
	input: ListProposalsInput = {},
	client?: AppDb
): Promise<number> {
	const db = await resolveDb(client);
	const filters = proposalFilters(input);
	const rows = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(actionProposals)
		.leftJoin(projects, eq(projects.id, actionProposals.projectId))
		.where(filters.length > 0 ? and(...filters) : undefined);
	return rows[0]?.n ?? 0;
}

/**
 * Compteurs par statut, pour l'en-tête. Ils IGNORENT le filtre de statut (ils
 * SONT le filtre) mais respectent le projet : sinon, cliquer « rejetées »
 * afficherait « 0 à décider » et laisserait croire l'inbox vide.
 */
export async function countProposalsByStatus(
	input: { projectSlug?: string | null } = {},
	client?: AppDb
): Promise<Record<string, number>> {
	const db = await resolveDb(client);
	const rows = await db
		.select({ status: actionProposals.status, n: sql<number>`count(*)::int` })
		.from(actionProposals)
		.leftJoin(projects, eq(projects.id, actionProposals.projectId))
		.where(input.projectSlug ? eq(projects.slug, input.projectSlug) : undefined)
		.groupBy(actionProposals.status);
	return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Une approbation, telle que la vue détail la montre. */
export interface ApprovalRow {
	id: string;
	approvedPayloadHash: string;
	approverType: string;
	approverId: string | null;
	method: string;
	status: string;
	expiresAt: string | null;
	createdAt: string;
}

/**
 * Une proposition et TOUT ce qui s'y rattache : ses approbations (y compris
 * tombées) et les runs d'agent qui l'ont produite.
 *
 * Les approbations invalidées sont rendues, pas filtrées : « il y a eu une
 * décision, elle est tombée avec le payload » et « il n'y a jamais eu de
 * décision » sont deux états qu'un écran ne doit pas confondre.
 */
export async function getProposalDetail(
	proposalId: string,
	client?: AppDb
): Promise<{
	proposal: ProposalRow;
	approvals: ApprovalRow[];
	agentRuns: {
		id: string;
		agent: string;
		agentVersion: string | null;
		model: string | null;
		status: string;
		durationMs: number | null;
		createdAt: string;
		finishedAt: string | null;
	}[];
} | null> {
	const db = await resolveDb(client);
	const rows = await db
		.select(PROPOSAL_COLUMNS)
		.from(actionProposals)
		.leftJoin(projects, eq(projects.id, actionProposals.projectId))
		.leftJoin(findings, eq(findings.id, actionProposals.findingId))
		.where(eq(actionProposals.id, proposalId))
		.limit(1);
	if (rows.length === 0) return null;

	const approvals = await db
		.select({
			id: proposalApprovals.id,
			approvedPayloadHash: proposalApprovals.approvedPayloadHash,
			approverType: proposalApprovals.approverType,
			approverId: proposalApprovals.approverId,
			method: proposalApprovals.method,
			status: proposalApprovals.status,
			expiresAt: proposalApprovals.expiresAt,
			createdAt: proposalApprovals.createdAt
		})
		.from(proposalApprovals)
		.where(eq(proposalApprovals.proposalId, proposalId))
		.orderBy(desc(proposalApprovals.createdAt));

	const runs = await db
		.select({
			id: agentRuns.id,
			agent: agentRuns.agent,
			agentVersion: agentRuns.agentVersion,
			model: agentRuns.model,
			status: agentRuns.status,
			durationMs: agentRuns.durationMs,
			createdAt: agentRuns.createdAt,
			finishedAt: agentRuns.finishedAt
		})
		.from(agentRuns)
		.where(eq(agentRuns.proposalId, proposalId))
		.orderBy(desc(agentRuns.createdAt));

	return { proposal: rows[0], approvals, agentRuns: runs };
}

/** Les propositions issues d'un finding, telles que la vue finding les montre
 *  (à la différence de `listProposalsForFinding`, qui ne sert que la supersession). */
export async function listProposalsOfFinding(
	findingId: string,
	client?: AppDb
): Promise<ProposalRow[]> {
	const db = await resolveDb(client);
	return db
		.select(PROPOSAL_COLUMNS)
		.from(actionProposals)
		.leftJoin(projects, eq(projects.id, actionProposals.projectId))
		.leftJoin(findings, eq(findings.id, actionProposals.findingId))
		.where(eq(actionProposals.findingId, findingId))
		.orderBy(desc(actionProposals.createdAt));
}

// ── Approbation (liée au hash, niveau vérifié) ──────────────────────

/**
 * Refus d'une décision, avec sa CAUSE. Une chaîne d'erreur ne se traduit pas en
 * code HTTP sans la relire, et un endpoint qui rendrait 500 sur « le payload a
 * changé » ferait chercher une panne serveur là où il y a une course normale.
 *
 * `stale_hash` et `not_decidable` sont des refus de CONCURRENCE (409) : l'appelant
 * a agi sur un état qu'il ne voit plus. `level_refused` est un refus
 * d'AUTORISATION (403). `not_found`, un 404.
 */
export type ProposalDecisionCode = 'not_found' | 'level_refused' | 'not_decidable' | 'stale_hash';

/** Traduction en code HTTP, définie UNE fois : quatre endpoints la partagent, et
 *  quatre traductions séparées finiraient par diverger. */
export const DECISION_HTTP_STATUS: Record<ProposalDecisionCode, number> = {
	not_found: 404,
	level_refused: 403,
	not_decidable: 409,
	stale_hash: 409
};

export class ProposalDecisionError extends Error {
	constructor(
		readonly code: ProposalDecisionCode,
		message: string
	) {
		super(message);
		this.name = 'ProposalDecisionError';
	}
}

export interface ApproveProposalInput {
	proposalId: string;
	approverType: ApproverType | string;
	approverId?: string | null;
	method?: ApprovalMethod | string;
	scopeJson?: string | null;
	token?: string | null;
	expiresAt?: string | null;
	/**
	 * Hash que l'appelant CROIT approuver (DASH-005). Fourni, il est comparé au
	 * hash courant sous transaction et fait échouer l'approbation en cas d'écart.
	 * C'est ce qui rend « chaque approbation est liée au hash exact » vrai *sous
	 * concurrence* : entre l'affichage d'une proposition et le clic, le run
	 * hebdomadaire peut l'avoir périmée et une autre l'avoir remplacée. Omis (le
	 * chemin agent), on approuve le hash courant — l'agent vient de l'écrire.
	 */
	expectedPayloadHash?: string | null;
}

export interface ApproveProposalResult {
	approvalId: string;
	/**
	 * `true` si cette approbation existait DÉJÀ : rien n'a été écrit, on rend
	 * l'existante. Un double clic ne doit pas produire deux lignes d'audit.
	 */
	idempotent: boolean;
}

/**
 * Approuve une proposition. Trois gardes, toutes DANS la transaction :
 *
 *   1. le NIVEAU — un acteur qui ne peut pas accorder ce niveau est refusé
 *      (SPEC §12.2) ; c'est la garde que `decideAutoApproval` duplique en amont et
 *      que celle-ci tient même si l'amont était contourné ;
 *   2. le STATUT — on ne décide que ce qui est encore décidable. Sans elle, une
 *      proposition `rejected` par un humain repasserait `approved` sur un simple
 *      rappel, et une machine réécrirait une décision humaine ;
 *   3. le HASH attendu, quand l'appelant en fournit un.
 *
 * L'approbation est liée au `payload_hash` courant : toute modification ultérieure
 * du payload l'invalidera (`updateProposalPayload`).
 *
 * IDEMPOTENCE : si la proposition est déjà `approved` et porte une approbation
 * `active` sur le MÊME hash, cette approbation est rendue telle quelle, sans
 * insertion. Une double soumission (double clic, rejeu réseau) écrirait sinon deux
 * lignes dans `proposal_approvals` — et §14.3 fait de cette table la trace de
 * référence : l'audit dirait deux décisions là où un humain n'en a pris qu'une.
 */
export async function approveProposal(
	input: ApproveProposalInput,
	client?: AppDb
): Promise<ApproveProposalResult> {
	guardPayload(input.scopeJson, 'scope_json approbation');
	const db = await resolveDb(client);
	return db.transaction(async (tx) => {
		const found = await tx
			.select({
				status: actionProposals.status,
				payloadHash: actionProposals.payloadHash,
				projectId: actionProposals.projectId,
				requiredApprovalLevel: actionProposals.requiredApprovalLevel
			})
			.from(actionProposals)
			.where(eq(actionProposals.id, input.proposalId))
			.limit(1);
		if (found.length === 0) {
			throw new ProposalDecisionError(
				'not_found',
				`approveProposal : proposition ${input.proposalId} introuvable.`
			);
		}
		const p = found[0];
		if (!canActorApprove({ actorType: input.approverType, level: p.requiredApprovalLevel })) {
			throw new ProposalDecisionError(
				'level_refused',
				`approveProposal : ${input.approverType} ne peut pas approuver un niveau ${p.requiredApprovalLevel}.`
			);
		}
		if (input.expectedPayloadHash && input.expectedPayloadHash !== p.payloadHash) {
			throw new ProposalDecisionError(
				'stale_hash',
				`approveProposal : le payload a changé depuis l'affichage — ` +
					`rien n'a été approuvé. Relire la proposition avant de décider.`
			);
		}

		// Rejeu d'une approbation déjà accordée : on rend l'existante. Cherchée par
		// hash ET par statut `active`, donc une approbation tombée avec un ancien
		// payload ne compte pas — c'est précisément ce qu'`invalidated` veut dire.
		if (p.status === 'approved') {
			const existing = await tx
				.select({ id: proposalApprovals.id })
				.from(proposalApprovals)
				.where(
					and(
						eq(proposalApprovals.proposalId, input.proposalId),
						eq(proposalApprovals.status, 'active'),
						eq(proposalApprovals.approvedPayloadHash, p.payloadHash)
					)
				)
				.limit(1);
			if (existing.length > 0) {
				return { approvalId: existing[0].id, idempotent: true };
			}
		}

		if (!isDecidableStatus(p.status)) {
			throw new ProposalDecisionError(
				'not_decidable',
				`approveProposal : une proposition « ${p.status} » n'est plus à décider.`
			);
		}

		const now = nowDb();
		const approvalId = createId();
		await tx.insert(proposalApprovals).values({
			id: approvalId,
			proposalId: input.proposalId,
			projectId: p.projectId,
			approvedPayloadHash: p.payloadHash, // lie l'approbation au payload exact
			approverType: input.approverType,
			approverId: input.approverId ?? null,
			scopeJson: input.scopeJson ?? null,
			method: input.method ?? 'ui',
			token: input.token ?? null,
			expiresAt: input.expiresAt ?? null
		});
		await tx
			.update(actionProposals)
			.set({
				status: 'approved',
				approvedBy: input.approverId ?? input.approverType,
				approvedAt: now,
				updatedAt: now
			})
			.where(eq(actionProposals.id, input.proposalId));
		return { approvalId, idempotent: false };
	});
}

// ── Modification de payload → invalidation ──────────────────────────

/**
 * Remplace le payload d'une proposition et INVALIDE toute approbation active :
 * l'approbation était liée à l'ancien hash, elle ne tient plus (SPEC §12.2). La
 * proposition repasse à `invalidated` si elle était `approved`, sinon `proposed`.
 */
export async function updateProposalPayload(
	input: {
		proposalId: string;
		payloadJson: string | null;
		inputHashesJson?: string | null;
	},
	client?: AppDb
): Promise<{ payloadHash: string; invalidatedApprovals: number }> {
	guardPayload(input.payloadJson, 'payload_json proposition (update)');
	guardPayload(input.inputHashesJson, 'input_hashes_json proposition (update)');
	const db = await resolveDb(client);
	const payloadHash = computePayloadHash(input.payloadJson);
	const now = nowDb();

	return db.transaction(async (tx) => {
		const found = await tx
			.select({ status: actionProposals.status })
			.from(actionProposals)
			.where(eq(actionProposals.id, input.proposalId))
			.limit(1);
		if (found.length === 0) {
			throw new Error(`updateProposalPayload : proposition ${input.proposalId} introuvable.`);
		}
		const nextStatus = statusAfterPayloadChange(found[0].status);

		await tx
			.update(actionProposals)
			.set({
				payloadJson: input.payloadJson,
				payloadHash,
				inputHashesJson: input.inputHashesJson ?? null,
				status: nextStatus,
				approvedBy: null,
				approvedAt: null,
				updatedAt: now
			})
			.where(eq(actionProposals.id, input.proposalId));

		const invalidated = await tx
			.update(proposalApprovals)
			.set({ status: 'invalidated' })
			.where(
				and(
					eq(proposalApprovals.proposalId, input.proposalId),
					eq(proposalApprovals.status, 'active')
				)
			)
			.returning({ id: proposalApprovals.id });

		return { payloadHash, invalidatedApprovals: invalidated.length };
	});
}

// ── Rejet / supersession / exécution / vérification ─────────────────

export interface DecideProposalInput {
	proposalId: string;
	/** Cause de la décision. Obligatoire : un refus sans motif n'apprend rien au
	 *  détecteur qui reproduira le même finding la semaine suivante. */
	reason: string;
	/** Qui décide (`user:{email}`). */
	actor: string;
	/** Hash affiché au décideur — même garde de concurrence que `approveProposal`. */
	expectedPayloadHash?: string | null;
}

/**
 * Applique une décision NÉGATIVE (rejet ou demande de révision) et la journalise
 * dans la même transaction.
 *
 * La raison va dans `finding_events` — le seul journal que ce lot a à sa
 * disposition, et celui que la vue finding lit déjà. Conséquence connue et
 * nommée : une proposition SANS `finding_id` (celles que produiront les rapports,
 * REP-001) n'a nulle part où écrire sa raison ; elle est alors journalisée dans
 * `action_proposals` seul. Aucune n'existe aujourd'hui.
 *
 * Le type d'événement `agent_comment` est le seul « commentaire » du catalogue
 * §7.7 ; c'est l'`actor` qui dit que la décision est humaine, pas le type. Ajouter
 * un type d'événement de finding pour une décision de PROPOSITION mélangerait deux
 * vocabulaires.
 */
async function decideAgainst(
	input: DecideProposalInput & { toStatus: 'rejected' | 'changes_requested' },
	client?: AppDb
): Promise<{ status: string }> {
	const db = await resolveDb(client);
	return db.transaction(async (tx) => {
		const found = await tx
			.select({
				status: actionProposals.status,
				payloadHash: actionProposals.payloadHash,
				projectId: actionProposals.projectId,
				findingId: actionProposals.findingId,
				actionType: actionProposals.actionType
			})
			.from(actionProposals)
			.where(eq(actionProposals.id, input.proposalId))
			.limit(1);
		if (found.length === 0) {
			throw new ProposalDecisionError(
				'not_found',
				`décision : proposition ${input.proposalId} introuvable.`
			);
		}
		const p = found[0];
		if (input.expectedPayloadHash && input.expectedPayloadHash !== p.payloadHash) {
			throw new ProposalDecisionError(
				'stale_hash',
				`décision : le payload a changé depuis l'affichage — rien n'a été décidé.`
			);
		}
		if (!isDecidableStatus(p.status)) {
			throw new ProposalDecisionError(
				'not_decidable',
				`décision : une proposition « ${p.status} » n'est plus à décider.`
			);
		}

		const now = nowDb();
		await tx
			.update(actionProposals)
			.set({ status: input.toStatus, updatedAt: now })
			.where(eq(actionProposals.id, input.proposalId));

		if (p.findingId) {
			await tx.insert(findingEvents).values({
				id: createId(),
				findingId: p.findingId,
				projectId: p.projectId,
				eventType: 'agent_comment',
				reason: input.reason,
				actor: input.actor,
				payloadJson: JSON.stringify({
					proposalId: input.proposalId,
					actionType: p.actionType,
					decision: input.toStatus
				})
			});
		}

		return { status: input.toStatus };
	});
}

/** Rejette une proposition (sans approbation), avec sa raison journalisée. */
export async function rejectProposal(
	input: DecideProposalInput,
	client?: AppDb
): Promise<{ status: string }> {
	return decideAgainst({ ...input, toStatus: 'rejected' }, client);
}

/**
 * Demande une révision : « l'intention tient, sa forme ne tient pas encore ».
 *
 * Ni un rejet (qui clôt) ni une modification (qui changerait le hash sous une
 * approbation). Le statut `changes_requested` a un effet de bord VOULU : comme
 * `decideSupersession` ne périme que `proposed`/`invalidated`, le run hebdomadaire
 * suivant ne l'écrasera pas — sans quoi la demande d'un humain disparaîtrait au
 * prochain lundi, sans trace et sans erreur.
 */
export async function requestProposalChanges(
	input: DecideProposalInput,
	client?: AppDb
): Promise<{ status: string }> {
	return decideAgainst({ ...input, toStatus: 'changes_requested' }, client);
}

/**
 * Marque des propositions remplacées par une version plus récente. Gardée par
 * les statuts encore OUVERTS : une proposition déjà approuvée, exécutée ou
 * rejetée porte une décision, et une machine ne réécrit pas une décision prise
 * (c'est `decideSupersession` qui choisit les cibles, cette garde n'est que la
 * ceinture). Renvoie les ids réellement périmés.
 */
export async function supersedeProposals(
	proposalIds: string[],
	client?: AppDb
): Promise<string[]> {
	if (proposalIds.length === 0) return [];
	const db = await resolveDb(client);
	const rows = await db
		.update(actionProposals)
		.set({ status: 'superseded', updatedAt: nowDb() })
		.where(
			and(
				inArray(actionProposals.id, proposalIds),
				inArray(actionProposals.status, ['proposed', 'invalidated'])
			)
		)
		.returning({ id: actionProposals.id });
	return rows.map((r) => r.id);
}

/** Marque UNE proposition remplacée (confort ; délègue à `supersedeProposals`). */
export async function supersedeProposal(proposalId: string, client?: AppDb): Promise<void> {
	await supersedeProposals([proposalId], client);
}

/** Rattache l'exécution à la queue durable `jobs` et passe en `executing`. */
export async function linkExecutionJob(
	proposalId: string,
	jobId: string,
	client?: AppDb
): Promise<void> {
	const db = await resolveDb(client);
	await db
		.update(actionProposals)
		.set({ executionJobId: jobId, status: 'executing', updatedAt: nowDb() })
		.where(eq(actionProposals.id, proposalId));
}

/** Renseigne le statut de vérification post-exécution. */
export async function setVerificationStatus(
	proposalId: string,
	verificationStatus: string,
	client?: AppDb
): Promise<void> {
	const db = await resolveDb(client);
	await db
		.update(actionProposals)
		.set({ verificationStatus, updatedAt: nowDb() })
		.where(eq(actionProposals.id, proposalId));
}

// ── Agent runs (journal d'invocation) ───────────────────────────────

export interface RecordAgentRunInput {
	projectId: string;
	runId?: string | null;
	proposalId?: string | null;
	agent: string;
	agentVersion?: string | null;
	skill?: string | null;
	model?: string | null;
	inputHashesJson?: string | null;
	findingsReadJson?: string | null;
	outputType?: string | null;
	outputRef?: string | null;
}

/** Ouvre un agent run (status `running`). */
export async function recordAgentRun(
	input: RecordAgentRunInput,
	client?: AppDb
): Promise<{ id: string }> {
	guardPayload(input.inputHashesJson, 'input_hashes_json agent_run');
	guardPayload(input.findingsReadJson, 'findings_read_json agent_run');
	const db = await resolveDb(client);
	const id = createId();
	await db.insert(agentRuns).values({
		id,
		projectId: input.projectId,
		runId: input.runId ?? null,
		proposalId: input.proposalId ?? null,
		agent: input.agent,
		agentVersion: input.agentVersion ?? null,
		skill: input.skill ?? null,
		model: input.model ?? null,
		inputHashesJson: input.inputHashesJson ?? null,
		findingsReadJson: input.findingsReadJson ?? null,
		outputType: input.outputType ?? null,
		outputRef: input.outputRef ?? null
	});
	return { id };
}

export interface FinishAgentRunInput {
	id: string;
	status: string; // succeeded | failed
	proposalId?: string | null;
	humanValidationRef?: string | null;
	tokensInput?: number | null;
	tokensOutput?: number | null;
	costJson?: string | null;
	durationMs?: number | null;
	resultJson?: string | null;
	errorCode?: string | null;
	errorMessage?: string | null;
}

/** Clôt un agent run avec tokens/coût/durée/résultat. */
export async function finishAgentRun(input: FinishAgentRunInput, client?: AppDb): Promise<void> {
	guardPayload(input.costJson, 'cost_json agent_run');
	guardPayload(input.resultJson, 'result_json agent_run');
	const db = await resolveDb(client);
	await db
		.update(agentRuns)
		.set({
			status: input.status,
			proposalId: input.proposalId ?? undefined,
			humanValidationRef: input.humanValidationRef ?? undefined,
			tokensInput: input.tokensInput ?? undefined,
			tokensOutput: input.tokensOutput ?? undefined,
			costJson: input.costJson ?? undefined,
			durationMs: input.durationMs ?? undefined,
			resultJson: input.resultJson ?? undefined,
			errorCode: input.errorCode ?? undefined,
			errorMessage: input.errorMessage ?? undefined,
			finishedAt: nowDb()
		})
		.where(eq(agentRuns.id, input.id));
}
