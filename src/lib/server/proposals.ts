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
import { eq, and, inArray } from 'drizzle-orm';
import { actionProposals, proposalApprovals, agentRuns } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { createId } from './utils.js';
import { assertNoInlineSecret } from './projection-state.js';
import { assertBoundedPayload } from './observation-state.js';
import { toDbTimestamp } from './timestamps.js';
import {
	canActorApprove,
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

// ── Approbation (liée au hash, niveau vérifié) ──────────────────────

export interface ApproveProposalInput {
	proposalId: string;
	approverType: ApproverType | string;
	approverId?: string | null;
	method?: ApprovalMethod | string;
	scopeJson?: string | null;
	token?: string | null;
	expiresAt?: string | null;
}

/**
 * Approuve une proposition. Refuse (throw) si l'acteur ne peut pas accorder le
 * niveau requis (SPEC §12.2). L'approbation est liée au `payload_hash` courant :
 * toute modification ultérieure du payload l'invalidera.
 */
export async function approveProposal(
	input: ApproveProposalInput,
	client?: AppDb
): Promise<{ approvalId: string }> {
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
			throw new Error(`approveProposal : proposition ${input.proposalId} introuvable.`);
		}
		const p = found[0];
		if (!canActorApprove({ actorType: input.approverType, level: p.requiredApprovalLevel })) {
			throw new Error(
				`approveProposal : ${input.approverType} ne peut pas approuver un niveau ${p.requiredApprovalLevel}.`
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
		return { approvalId };
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

/** Rejette une proposition (sans approbation). */
export async function rejectProposal(proposalId: string, client?: AppDb): Promise<void> {
	const db = await resolveDb(client);
	await db
		.update(actionProposals)
		.set({ status: 'rejected', updatedAt: nowDb() })
		.where(eq(actionProposals.id, proposalId));
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
