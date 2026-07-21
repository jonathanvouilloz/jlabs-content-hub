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
import { eq, and } from 'drizzle-orm';
import { db } from './db/index.js';
import { actionProposals, proposalApprovals, agentRuns } from './db/schema.js';
import { createId } from './utils.js';
import { assertNoInlineSecret } from './projection-state.js';
import { assertBoundedPayload } from './observation-state.js';
import {
	canActorApprove,
	statusAfterPayloadChange,
	type ApproverType,
	type ApprovalMethod
} from './proposal-state.js';

const nowIso = () => new Date().toISOString();

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

/** Insère une proposition, ou renvoie l'existante si identique (même projet +
 *  finding + action + hash de payload). */
export async function createProposal(input: CreateProposalInput): Promise<CreateProposalResult> {
	guardPayload(input.payloadJson, 'payload_json proposition');
	guardPayload(input.inputHashesJson, 'input_hashes_json proposition');
	const payloadHash = computePayloadHash(input.payloadJson);
	const id = createId();
	const now = nowIso();

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
			// Dédup idempotente : re-proposition identique → rafraîchit updatedAt, pas de doublon.
			target: [
				actionProposals.projectId,
				actionProposals.findingId,
				actionProposals.actionType,
				actionProposals.payloadHash
			],
			set: { updatedAt: now }
		})
		.returning({ id: actionProposals.id });

	return { id: rows[0].id, payloadHash };
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
export async function approveProposal(input: ApproveProposalInput): Promise<{ approvalId: string }> {
	guardPayload(input.scopeJson, 'scope_json approbation');
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

		const now = nowIso();
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
export async function updateProposalPayload(input: {
	proposalId: string;
	payloadJson: string | null;
	inputHashesJson?: string | null;
}): Promise<{ payloadHash: string; invalidatedApprovals: number }> {
	guardPayload(input.payloadJson, 'payload_json proposition (update)');
	guardPayload(input.inputHashesJson, 'input_hashes_json proposition (update)');
	const payloadHash = computePayloadHash(input.payloadJson);
	const now = nowIso();

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
export async function rejectProposal(proposalId: string): Promise<void> {
	await db
		.update(actionProposals)
		.set({ status: 'rejected', updatedAt: nowIso() })
		.where(eq(actionProposals.id, proposalId));
}

/** Marque une proposition remplacée par une nouvelle version. */
export async function supersedeProposal(proposalId: string): Promise<void> {
	await db
		.update(actionProposals)
		.set({ status: 'superseded', updatedAt: nowIso() })
		.where(eq(actionProposals.id, proposalId));
}

/** Rattache l'exécution à la queue durable `jobs` et passe en `executing`. */
export async function linkExecutionJob(proposalId: string, jobId: string): Promise<void> {
	await db
		.update(actionProposals)
		.set({ executionJobId: jobId, status: 'executing', updatedAt: nowIso() })
		.where(eq(actionProposals.id, proposalId));
}

/** Renseigne le statut de vérification post-exécution. */
export async function setVerificationStatus(
	proposalId: string,
	verificationStatus: string
): Promise<void> {
	await db
		.update(actionProposals)
		.set({ verificationStatus, updatedAt: nowIso() })
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
export async function recordAgentRun(input: RecordAgentRunInput): Promise<{ id: string }> {
	guardPayload(input.inputHashesJson, 'input_hashes_json agent_run');
	guardPayload(input.findingsReadJson, 'findings_read_json agent_run');
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
export async function finishAgentRun(input: FinishAgentRunInput): Promise<void> {
	guardPayload(input.costJson, 'cost_json agent_run');
	guardPayload(input.resultJson, 'result_json agent_run');
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
			finishedAt: nowIso()
		})
		.where(eq(agentRuns.id, input.id));
}
