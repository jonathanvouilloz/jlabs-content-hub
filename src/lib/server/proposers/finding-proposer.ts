/**
 * AGT-000 — Producteur de propositions : findings → `action_proposals`.
 *
 * Le SEUL endroit de ce producteur qui touche la base. Tout le raisonnement vit
 * dans le module PUR `proposer-state.ts` (testé par vitest) : ici on lit des
 * findings, on applique les fonctions pures, on persiste des propositions.
 *
 * Symétrique de `detectors/keyword-opportunity.ts`, et pour la même raison : le
 * détecteur établit un FAIT par arithmétique, le producteur en tire une ACTION
 * par table de correspondance. Ni l'un ni l'autre n'appelle un modèle — l'agent
 * IA viendra plus tard *rédiger* et *regrouper*, sur une structure dont le
 * niveau d'autorisation est déjà figé (SPEC §3.3, §12.2).
 *
 * Le client drizzle est INJECTÉ : l'app passe son `db`, le runner
 * `scripts/propose.ts` passe son propre Pool (cf. `db/types.ts`).
 *
 * Ce que ce producteur N'ÉCRIT PAS, volontairement : aucune exécution, aucune
 * mutation externe, et aucune approbation au-delà de L2 sous policy explicite.
 * Une proposition est une phrase, pas un geste.
 */
import { and, eq } from 'drizzle-orm';
import { projectProjections } from '../db/schema.js';
import type { AppDb } from '../db/types.js';
import { listFindings, recordFindingEvent } from '../findings.js';
import { getCurrentPolicy } from '../policies.js';
import {
	computePayloadHash,
	createProposal,
	finishAgentRun,
	listProposalsForFinding,
	recordAgentRun,
	supersedeProposals,
	approveProposal
} from '../proposals.js';
import { isDecidableStatus } from '../proposal-state.js';
import {
	PROPOSER_VERSION,
	SKILL_BY_ACTION,
	buildExpectedImpact,
	buildProposalPayload,
	buildRationale,
	canonicalInputSignature,
	canonicalProposalPayload,
	decideAutoApproval,
	decideSupersession,
	deriveApprovalLevel,
	deriveRiskLevel,
	mapFindingToActions,
	readFindingSignals,
	resolveProposerConfig,
	selectProposableFindings,
	type ProposableFinding,
	type ProposalActionType,
	type ProposerConfig,
	type RiskLevel
} from '../proposer-state.js';

// ── Contrat d'entrée/sortie (interface versionnée) ──────────────────

export interface ProposerInput {
	db: AppDb;
	projectId: string;
	/** Run de monitoring pour la traçabilité (`agent_runs.run_id`). */
	runId?: string | null;
	/** N'écrit rien : sert à inspecter le plan avant de peupler l'inbox. */
	dryRun?: boolean;
	/** Overrides explicites (priment sur ceux de la projection projet). */
	config?: Partial<ProposerConfig> | null;
	/** Types de findings à considérer ; par défaut, tous ceux qui savent produire une action. */
	types?: readonly string[];
	/**
	 * Restriction explicite à un ensemble de findings. Existe pour que la preuve
	 * sur Neon puisse démontrer la chaîne complète (finding → proposition →
	 * approbation) sur SES propres findings, sans écrire des propositions sur les
	 * findings de production du projet qui l'héberge. Même raison d'être que le
	 * `catalog` de substitution de `planDueJobs`. L'app ne le passe jamais.
	 */
	findingIds?: readonly string[];
}

/** Une proposition produite (ou qui l'aurait été en dry-run). */
export interface ProducedProposal {
	findingId: string;
	findingTitle: string;
	actionType: ProposalActionType;
	approvalLevel: string;
	riskLevel: RiskLevel;
	target: string | null;
	payloadHash: string;
	rationale: string;
	expectedImpact: string;
	selectionReason: string;
	/** null en dry-run ; l'id de la proposition sinon. */
	proposalId: string | null;
	/** Propositions périmées par celle-ci. */
	superseded: string[];
	/** Approbations devenues obsolètes, laissées à un humain. */
	staleApproved: string[];
	/** Auto-approuvée ? Toujours accompagné de sa raison, y compris en cas de refus. */
	autoApproved: boolean;
	autoApprovalReason: string;
}

export interface ProposerResult {
	proposerVersion: string;
	projectId: string;
	config: ProposerConfig;
	dryRun: boolean;
	/** Findings lus (avant tout filtre). */
	findingsRead: number;
	/** Éligibles AVANT plafond — la liste complète, jamais tronquée. */
	totalMatched: number;
	/** Écartés par statut (veille, dismiss, résolu). */
	excludedByStatus: number;
	/** Écartés sous `minPriority`. */
	excludedByPriority: number;
	/** Vrai si `maxProposals` a mordu — jamais silencieux. */
	truncated: boolean;
	/**
	 * Findings retenus dont AUCUNE action n'a pu être dérivée (type sans table de
	 * correspondance, cible ou position absente). Compté et nommé : un finding
	 * prioritaire qui ne produit rien est une information, pas un non-événement.
	 */
	withoutAction: number;
	proposals: ProducedProposal[];
	counts: { created: number; refreshed: number; superseded: number; autoApproved: number };
	/** `agent_runs.id` ouvert par ce run (null en dry-run). */
	agentRunId: string | null;
	/** Raison d'un run sans résultat, sinon null. */
	skippedReason: string | null;
}

// ── Configuration par projet (projection `current`, tolérante) ──────

/**
 * Lit d'éventuels réglages par projet dans la projection courante
 * (`project_projections.payload`, clé `proposers.finding_proposer`). Calque exact
 * de `loadProjectThresholdOverrides` / `loadProjectScheduleConfig` : la table est
 * vide aujourd'hui, et un payload invalide ne doit jamais faire échouer — ni
 * pire, faire taire — la production de propositions.
 */
export async function loadProjectProposerOverrides(
	db: AppDb,
	projectId: string
): Promise<Partial<ProposerConfig> | null> {
	try {
		const row = await db.query.projectProjections.findFirst({
			where: and(
				eq(projectProjections.projectId, projectId),
				eq(projectProjections.status, 'current')
			),
			columns: { payload: true }
		});
		if (!row?.payload) return null;
		const parsed = JSON.parse(row.payload) as {
			proposers?: { finding_proposer?: Partial<ProposerConfig> };
		};
		return parsed?.proposers?.finding_proposer ?? null;
	} catch {
		return null;
	}
}

/**
 * Mode de la policy projet-wide, ou `null` si aucune n'existe. Lu une seule fois
 * par run : la décision d'auto-approbation est la même pour toutes les
 * propositions d'un projet, et `decideAutoApproval` refuse par défaut sans elle.
 */
async function loadProjectPolicyGate(
	db: AppDb,
	projectId: string
): Promise<{ mode: string | null; killSwitch: boolean }> {
	try {
		const policy = await getCurrentPolicy(projectId, null, db);
		return { mode: policy?.mode ?? null, killSwitch: Boolean(policy?.killSwitch) };
	} catch {
		// Une policy illisible ne doit pas OUVRIR de droits : refus par défaut.
		return { mode: null, killSwitch: true };
	}
}

/** Plafond d'ids embarqués dans `findings_read_json` : un pointeur, pas un dump. */
export const MAX_FINDINGS_READ_IDS = 200;

// ── Exécution ───────────────────────────────────────────────────────

export async function runFindingProposer(input: ProposerInput): Promise<ProposerResult> {
	const { db, projectId } = input;
	const dryRun = input.dryRun === true;

	const projectOverrides = await loadProjectProposerOverrides(db, projectId);
	const config = resolveProposerConfig({ ...projectOverrides, ...input.config });

	const base: ProposerResult = {
		proposerVersion: PROPOSER_VERSION,
		projectId,
		config,
		dryRun,
		findingsRead: 0,
		totalMatched: 0,
		excludedByStatus: 0,
		excludedByPriority: 0,
		truncated: false,
		withoutAction: 0,
		proposals: [],
		counts: { created: 0, refreshed: 0, superseded: 0, autoApproved: 0 },
		agentRunId: null,
		skippedReason: null
	};

	// Statuts laissés au défaut de `listFindings` (les ACTIFS) : le filtre de
	// statut est la garde qui protège le snooze et le dismiss, il ne se
	// paramètre pas depuis ici.
	const all = await listFindings({ projectId, types: input.types }, db);
	const restrict = input.findingIds ? new Set(input.findingIds) : null;
	const rows = restrict ? all.filter((r) => restrict.has(r.id)) : all;
	if (rows.length === 0) {
		return { ...base, skippedReason: 'aucun finding actif pour ce projet' };
	}

	const candidates: ProposableFinding[] = rows.map((r) => ({
		id: r.id,
		type: r.type,
		fingerprint: r.fingerprint,
		entityType: r.entityType,
		entityKey: r.entityKey,
		title: r.title,
		status: r.status,
		severity: r.severity,
		priorityScore: r.priorityScore,
		confidenceScore: r.confidenceScore,
		impactEstimateJson: r.impactEstimateJson,
		evidenceJson: r.evidenceJson,
		recommendedSkill: r.recommendedSkill
	}));

	const selection = selectProposableFindings(candidates, config);
	const gate = await loadProjectPolicyGate(db, projectId);

	// L'agent run est ouvert AVANT d'écrire quoi que ce soit : une invocation qui
	// échoue à mi-course doit rester visible (SPEC §7.9), pas s'évaporer.
	let agentRunId: string | null = null;
	const t0 = Date.now();
	if (!dryRun) {
		const opened = await recordAgentRun(
			{
				projectId,
				runId: input.runId ?? null,
				agent: 'finding-proposer',
				agentVersion: PROPOSER_VERSION,
				outputType: 'proposal',
				inputHashesJson: JSON.stringify({
					minPriority: config.minPriority,
					maxProposals: config.maxProposals
				}),
				findingsReadJson: JSON.stringify({
					count: selection.matched.length,
					truncated: selection.truncated,
					ids: selection.selected.slice(0, MAX_FINDINGS_READ_IDS).map((f) => f.id)
				})
			},
			db
		);
		agentRunId = opened.id;
	}

	const proposals: ProducedProposal[] = [];
	const counts = { created: 0, refreshed: 0, superseded: 0, autoApproved: 0 };
	let withoutAction = 0;

	try {
		for (const finding of selection.selected) {
			const signals = readFindingSignals(finding);
			const actions = mapFindingToActions(finding, signals, config);
			if (actions.length === 0) {
				withoutAction += 1;
				continue;
			}

			for (const choice of actions) {
				const approvalLevel = deriveApprovalLevel(choice.actionType);
				// Ceinture : le catalogue garantit déjà un niveau, mais une action sans
				// niveau ne doit jamais être écrite — elle serait approuvable par défaut.
				if (!approvalLevel) {
					withoutAction += 1;
					continue;
				}

				const payload = buildProposalPayload({ finding, signals, choice });
				const payloadJson = canonicalProposalPayload(payload);
				const payloadHash = computePayloadHash(payloadJson);
				const riskLevel = deriveRiskLevel(choice.actionType, {
					existingClicks: signals.clicks,
					riskyClicksThreshold: config.riskyClicksThreshold
				});
				const rationale = buildRationale({ finding, signals, choice });
				const expectedImpact = buildExpectedImpact(signals);
				const autoApproval = decideAutoApproval({
					approvalLevel,
					policyMode: gate.mode,
					killSwitch: gate.killSwitch
				});

				const produced: ProducedProposal = {
					findingId: finding.id,
					findingTitle: finding.title,
					actionType: choice.actionType,
					approvalLevel,
					riskLevel,
					target: signals.page,
					payloadHash,
					rationale,
					expectedImpact,
					selectionReason: choice.selectionReason,
					proposalId: null,
					superseded: [],
					staleApproved: [],
					autoApproved: false,
					autoApprovalReason: autoApproval.reason
				};

				if (dryRun) {
					proposals.push(produced);
					continue;
				}

				// Ce qui existait AVANT l'écriture : lu d'abord, pour que la
				// proposition qu'on s'apprête à créer ne se périme pas elle-même.
				const existing = await listProposalsForFinding(finding.id, db);
				const sameAsBefore = existing.find(
					(p) => p.actionType === choice.actionType && p.payloadHash === payloadHash
				);
				const known = sameAsBefore !== undefined;

				const created = await createProposal(
					{
						projectId,
						findingId: finding.id,
						actionType: choice.actionType,
						target: signals.page,
						rationale,
						expectedImpact,
						riskLevel,
						requiredApprovalLevel: approvalLevel,
						proposedBy: PROPOSER_VERSION,
						payloadJson,
						inputHashesJson: JSON.stringify({
							signature: computePayloadHash(canonicalInputSignature({ finding, signals })),
							findingId: finding.id,
							fingerprint: finding.fingerprint
						})
					},
					db
				);
				produced.proposalId = created.id;

				const decision = decideSupersession({
					existing,
					actionType: choice.actionType,
					nextPayloadHash: payloadHash
				});
				produced.superseded = await supersedeProposals(decision.supersede, db);
				produced.staleApproved = decision.staleApproved;
				counts.superseded += produced.superseded.length;

				// Auto-approbation : bornée à L0–L2 ET à une policy explicite. Aucune
				// exception — `approveProposal` re-vérifie le niveau côté IO et lèvera
				// si cette garde-ci était un jour contournée.
				//
				// Troisième borne (DASH-005) : on ne re-décide QUE ce qui est encore
				// décidable. L'upsert de `createProposal` peut retomber sur une
				// proposition qu'un humain a rejetée ou dont il a demandé la révision —
				// la ré-approuver automatiquement ferait réécrire une décision humaine
				// par une machine, au rythme d'une fois par semaine. `approveProposal`
				// lèverait ; c'est ici qu'on s'abstient, pour ne pas faire échouer tout
				// le job de production sur un refus parfaitement normal.
				const reDecidable = !sameAsBefore || isDecidableStatus(sameAsBefore.status);
				if (autoApproval.allowed && !reDecidable) {
					produced.autoApprovalReason =
						`statut « ${sameAsBefore!.status} » : décision humaine déjà prise, ` +
						`aucune ré-approbation automatique`;
				}
				if (autoApproval.allowed && reDecidable) {
					await approveProposal(
						{
							proposalId: created.id,
							approverType: 'agent',
							approverId: PROPOSER_VERSION,
							method: 'policy'
						},
						db
					);
					produced.autoApproved = true;
					counts.autoApproved += 1;
				}

				// Le journal du finding porte la trace : la vue finding montre qu'une
				// action a été proposée sans avoir à joindre `action_proposals`. Écrit
				// SEULEMENT à la première proposition — une re-proposition identique
				// chaque semaine enflerait le journal sans rien raconter de neuf.
				if (!known) {
					await recordFindingEvent(
						{
							findingId: finding.id,
							projectId,
							eventType: 'agent_comment',
							reason: `proposition ${choice.actionType} (${approvalLevel}) : ${choice.selectionReason}`,
							actor: 'agent',
							payloadJson: JSON.stringify({
								proposer: PROPOSER_VERSION,
								proposalId: created.id,
								actionType: choice.actionType,
								approvalLevel,
								riskLevel,
								skill: SKILL_BY_ACTION[choice.actionType]
							})
						},
						db
					);
					counts.created += 1;
				} else {
					counts.refreshed += 1;
				}

				proposals.push(produced);
			}
		}
	} catch (err) {
		// L'agent run est CLOS même en échec : un run laissé `running` à vie
		// donnerait à la supervision une invocation éternellement en cours.
		if (agentRunId) {
			await finishAgentRun(
				{
					id: agentRunId,
					status: 'failed',
					durationMs: Date.now() - t0,
					errorCode: 'ProposerFailed',
					errorMessage: err instanceof Error ? err.message : String(err)
				},
				db
			).catch(() => {});
		}
		throw err;
	}

	if (agentRunId) {
		await finishAgentRun(
			{
				id: agentRunId,
				status: 'succeeded',
				durationMs: Date.now() - t0,
				resultJson: JSON.stringify({
					proposals: proposals.length,
					counts,
					truncated: selection.truncated,
					totalMatched: selection.matched.length,
					withoutAction
				})
			},
			db
		);
	}

	return {
		...base,
		findingsRead: rows.length,
		totalMatched: selection.matched.length,
		excludedByStatus: selection.excludedByStatus,
		excludedByPriority: selection.excludedByPriority,
		truncated: selection.truncated,
		withoutAction,
		proposals,
		counts,
		agentRunId
	};
}
