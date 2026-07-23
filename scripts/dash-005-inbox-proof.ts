/**
 * DASH-004/005 — Preuve de l'inbox sur une VRAIE base.
 *
 * Ce test ne peut pas vivre dans vitest : ce qu'on vérifie ici, c'est le
 * comportement TRANSACTIONNEL des décisions (approbation liée au hash sous
 * concurrence, idempotence d'une double soumission, journal écrit dans la même
 * transaction que le statut) et le comportement des LECTEURS sur du SQL réel. Les
 * règles pures — filtres, légalité, lots, verdicts — sont déjà couvertes par
 * `proposal-console.test.ts` (26 tests) et `proposal-state.test.ts` (22).
 *
 * Les 4 acceptations DASH-005, prouvées en base :
 *   1. « chaque approbation est liée au hash exact » : l'approbation porte le hash
 *      courant, et une approbation présentée avec un hash PÉRIMÉ n'écrit RIEN ;
 *   2. « modifier une proposition l'exclut du lot » : le payload modifié change le
 *      hash, l'item est refusé NOMMÉMENT et les autres du lot passent quand même ;
 *   3. « L4 n'a pas de bouton tout approuver » : deux L4 parfaitement homogènes ne
 *      forment aucun lot ;
 *   4. « une double soumission UI reste idempotente » : deux approbations
 *      successives ne laissent qu'UNE ligne dans `proposal_approvals`.
 * Plus DASH-004 : un finding écarté ne remonte pas seul, une veille sort de
 * l'inbox, toute transition laisse UN événement avec acteur et raison.
 * Plus la garde qui protège la décision humaine : une révision demandée n'est ni
 * périmée ni ré-approuvée par le run suivant du producteur.
 *
 * Écriture bornée à ses propres lignes (fingerprint préfixé d'une clé de run),
 * nettoyage ENFANTS D'ABORD dans un `finally`.
 * Lancer : npx tsx scripts/dash-005-inbox-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { eq, inArray, like, sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	countFindings,
	countFindingsByStatus,
	dismissFinding,
	getFindingWithEvidence,
	listFindings,
	snoozeFinding,
	transitionFinding,
	upsertFinding
} from '../src/lib/server/findings.js';
import {
	approveProposal,
	countProposals,
	countProposalsByStatus,
	createProposal,
	getProposalDetail,
	listProposals,
	ProposalDecisionError,
	rejectProposal,
	requestProposalChanges,
	updateProposalPayload
} from '../src/lib/server/proposals.js';
import { buildApprovalLots, proposalAbilities } from '../src/lib/server/proposal-console.js';
import { runFindingProposer } from '../src/lib/server/proposers/finding-proposer.js';
import { createId } from '../src/lib/server/utils.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

/**
 * Marqueur exclusif de ce test. Comme pour AGT-000, le TYPE des findings doit
 * rester le vrai type métier (sinon le producteur ne saurait rien en dériver au
 * bloc 7) : l'isolation passe donc par le FINGERPRINT, préfixé d'une clé de run,
 * et par le bornage explicite des appels au producteur.
 */
const TEST_TAG = '__test_dash005';
const RUN_KEY = createId();
const SEP = '\x1f';
const ACTOR = 'user:proof@jonlabs.ch';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}

const fp = (name: string, page: string) =>
	['keyword_opportunity', 'query', `${TEST_TAG}:${RUN_KEY}:${name}`, page].join(SEP);

function evidenceJson(position: number, clicks: number): string {
	return JSON.stringify({
		detector: 'keyword_opportunity@1',
		window: { start: '2026-06-01', end: '2026-06-28', weeks: 4 },
		observationIds: [],
		observationCount: 0,
		metrics: { clicks, impressions: 800, ctr: 0.0025, position, weeksSeen: 4, gainEstimate: 20 },
		scoreBreakdown: { impact: 40, urgency: 18, confidence: 14, strategicFit: 9 },
		confidenceCaveats: []
	});
}

async function pickProject(): Promise<{ id: string; slug: string }> {
	const rows = await db
		.select({ id: schema.projects.id, slug: schema.projects.slug })
		.from(schema.projects)
		.limit(1);
	if (rows.length === 0) throw new Error('Aucun projet en base.');
	return rows[0];
}

async function seedFinding(projectId: string, name: string, page: string, position = 6.4) {
	return upsertFinding(
		{
			projectId,
			type: 'keyword_opportunity',
			entityType: 'query',
			entityKey: `${TEST_TAG}:${RUN_KEY}:${name}`,
			fingerprint: fp(name, page),
			title: `[test] ${name}`,
			severity: 'high',
			priorityScore: 85,
			confidenceScore: 70,
			impactEstimateJson: JSON.stringify({ gainEstimateClicksPerWeek: 20 }),
			evidenceJson: evidenceJson(position, 2),
			detectorVersion: 'keyword_opportunity@1',
			recommendedSkill: 'seo-refresh'
		},
		db
	);
}

/** Une proposition de test, entièrement paramétrée (le producteur, lui, ne sait
 *  produire que du `meta_rewrite`/`refresh_plan` : ici on veut aussi des L4). */
async function seedProposal(input: {
	projectId: string;
	findingId: string;
	actionType: string;
	level: string;
	risk: string;
	marker: string;
}) {
	return createProposal(
		{
			projectId: input.projectId,
			findingId: input.findingId,
			actionType: input.actionType,
			target: `https://test.invalid/${input.marker}`,
			rationale: `[${TEST_TAG}] ${input.marker}`,
			expectedImpact: 'aucun — proposition de test',
			riskLevel: input.risk,
			requiredApprovalLevel: input.level,
			proposedBy: `${TEST_TAG}@1`,
			payloadJson: JSON.stringify({
				schema_version: 1,
				action: input.actionType,
				proposer: TEST_TAG,
				marker: `${RUN_KEY}:${input.marker}`
			})
		},
		db
	);
}

const openedAgentRuns: string[] = [];

async function testFindingIds(): Promise<string[]> {
	const rows = await db
		.select({ id: schema.findings.id })
		.from(schema.findings)
		.where(like(schema.findings.fingerprint, `%${RUN_KEY}%`));
	return rows.map((r) => r.id);
}

/**
 * Nettoyage ENFANTS D'ABORD : proposal_approvals → action_proposals → agent_runs →
 * finding_events → findings. Une suppression parent-d'abord échouerait APRÈS toutes
 * les vérifications, donc en laissant croire à un succès.
 */
async function cleanup(): Promise<Record<string, number>> {
	const out = { approvals: 0, proposals: 0, agentRuns: 0, events: 0, findings: 0 };

	if (openedAgentRuns.length > 0) {
		out.agentRuns = (
			await db
				.delete(schema.agentRuns)
				.where(inArray(schema.agentRuns.id, openedAgentRuns))
				.returning({ id: schema.agentRuns.id })
		).length;
		openedAgentRuns.length = 0;
	}

	const findingIds = await testFindingIds();
	if (findingIds.length === 0) return out;

	const proposals = await db
		.select({ id: schema.actionProposals.id })
		.from(schema.actionProposals)
		.where(inArray(schema.actionProposals.findingId, findingIds));
	const proposalIds = proposals.map((p) => p.id);

	if (proposalIds.length > 0) {
		out.approvals = (
			await db
				.delete(schema.proposalApprovals)
				.where(inArray(schema.proposalApprovals.proposalId, proposalIds))
				.returning({ id: schema.proposalApprovals.id })
		).length;
		out.proposals = (
			await db
				.delete(schema.actionProposals)
				.where(inArray(schema.actionProposals.id, proposalIds))
				.returning({ id: schema.actionProposals.id })
		).length;
	}

	out.events = (
		await db
			.delete(schema.findingEvents)
			.where(inArray(schema.findingEvents.findingId, findingIds))
			.returning({ id: schema.findingEvents.id })
	).length;
	out.findings = (
		await db
			.delete(schema.findings)
			.where(inArray(schema.findings.id, findingIds))
			.returning({ id: schema.findings.id })
	).length;
	return out;
}

async function readProposal(id: string) {
	const rows = await db
		.select({
			status: schema.actionProposals.status,
			payloadHash: schema.actionProposals.payloadHash,
			approvedBy: schema.actionProposals.approvedBy,
			approvedAt: schema.actionProposals.approvedAt,
			updatedAt: schema.actionProposals.updatedAt
		})
		.from(schema.actionProposals)
		.where(eq(schema.actionProposals.id, id));
	return rows[0];
}

async function countApprovals(proposalId: string): Promise<number> {
	const rows = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(schema.proposalApprovals)
		.where(eq(schema.proposalApprovals.proposalId, proposalId));
	return Number(rows[0]?.n ?? 0);
}

async function eventsOf(findingId: string) {
	return db
		.select({
			eventType: schema.findingEvents.eventType,
			reason: schema.findingEvents.reason,
			actor: schema.findingEvents.actor,
			toStatus: schema.findingEvents.toStatus,
			createdAt: schema.findingEvents.createdAt
		})
		.from(schema.findingEvents)
		.where(eq(schema.findingEvents.findingId, findingId));
}

/** Ce que fait l'endpoint `approve-batch` : reconstruire le lot depuis la BASE,
 *  puis approuver chaque item avec le hash que le client a affiché. */
async function approveLot(items: { id: string; payloadHash: string }[]) {
	const approved: string[] = [];
	const skipped: { id: string; reason: string }[] = [];
	for (const item of items) {
		try {
			await approveProposal(
				{
					proposalId: item.id,
					approverType: 'user',
					approverId: ACTOR,
					method: 'ui',
					expectedPayloadHash: item.payloadHash
				},
				db
			);
			approved.push(item.id);
		} catch (e) {
			if (e instanceof ProposalDecisionError) {
				skipped.push({ id: item.id, reason: e.code });
				continue;
			}
			throw e;
		}
	}
	return { approved, skipped };
}

async function main() {
	console.log(`\n=== DASH-004/005 — preuve de l'inbox (run ${RUN_KEY}) ===`);
	const project = await pickProject();

	const before = {
		findings: Number(
			(await db.select({ n: sql<number>`count(*)::int` }).from(schema.findings))[0].n
		),
		proposals: Number(
			(await db.select({ n: sql<number>`count(*)::int` }).from(schema.actionProposals))[0].n
		),
		approvals: Number(
			(await db.select({ n: sql<number>`count(*)::int` }).from(schema.proposalApprovals))[0].n
		)
	};
	console.log(
		`   base avant : ${before.findings} findings · ${before.proposals} propositions · ${before.approvals} approbations`
	);

	try {
		// ── 1. Les lecteurs voient ce qui est en base ──────────────────
		console.log("\n1. L'inbox lit (elle n'avait aucun lecteur avant ce lot) :");
		const fA = await seedFinding(project.id, 'lot-a', 'https://test.invalid/a');
		const fB = await seedFinding(project.id, 'lot-b', 'https://test.invalid/b');
		const fC = await seedFinding(project.id, 'lot-c', 'https://test.invalid/c');
		const fL4 = await seedFinding(project.id, 'sensible', 'https://test.invalid/d');

		const pA = await seedProposal({
			projectId: project.id,
			findingId: fA.id,
			actionType: 'meta_rewrite',
			level: 'L3',
			risk: 'medium',
			marker: 'a'
		});
		const pB = await seedProposal({
			projectId: project.id,
			findingId: fB.id,
			actionType: 'meta_rewrite',
			level: 'L3',
			risk: 'medium',
			marker: 'b'
		});
		const pC = await seedProposal({
			projectId: project.id,
			findingId: fC.id,
			actionType: 'meta_rewrite',
			level: 'L3',
			risk: 'medium',
			marker: 'c'
		});
		const p4a = await seedProposal({
			projectId: project.id,
			findingId: fL4.id,
			actionType: 'redirect_301',
			level: 'L4',
			risk: 'high',
			marker: 'l4a'
		});
		const p4b = await seedProposal({
			projectId: project.id,
			findingId: fL4.id,
			actionType: 'canonical_set',
			level: 'L4',
			risk: 'high',
			marker: 'l4b'
		});

		const mineIds = [pA.id, pB.id, pC.id, p4a.id, p4b.id];
		const listed = await listProposals({ ids: mineIds, limit: 50 }, db);
		check('les 5 propositions de test sont listées', listed.length === 5, `${listed.length}`);
		check(
			'chaque ligne porte son projet (l’inbox est cross-projet)',
			listed.every((p) => p.projectSlug === project.slug),
			listed[0]?.projectSlug ?? '—'
		);
		check(
			'… et son finding source (titre joint)',
			listed.every((p) => p.findingTitle?.startsWith('[test]')),
			`${listed.filter((p) => p.findingTitle).length}/5`
		);
		check(
			'le risque le plus élevé remonte en premier',
			listed[0].riskLevel === 'high',
			`${listed.map((p) => p.riskLevel).join(',')}`
		);
		check(
			'un filtre par ids VIDE ne rend pas « tout »',
			(await listProposals({ ids: [], limit: 50 }, db)).length === 0
		);
		check(
			'le total suit les mêmes filtres que la liste',
			(await countProposals({ ids: mineIds }, db)) === 5
		);
		const byStatus = await countProposalsByStatus({ projectSlug: project.slug }, db);
		check(
			'les compteurs par statut comptent nos 5 « à décider »',
			(byStatus.proposed ?? 0) >= 5,
			`proposed=${byStatus.proposed ?? 0}`
		);

		// ── 2. Lots homogènes, et L4 jamais groupée ────────────────────
		console.log('\n2. Validation groupée : lots homogènes, L4 exclue :');
		const candidates = listed.map((r) => ({
			id: r.id,
			projectId: r.projectId,
			projectSlug: r.projectSlug,
			actionType: r.actionType,
			requiredApprovalLevel: r.requiredApprovalLevel,
			riskLevel: r.riskLevel,
			status: r.status,
			payloadHash: r.payloadHash
		}));
		const { lots, excluded } = buildApprovalLots(candidates);
		check('un seul lot est formé (les 3 L3 homogènes)', lots.length === 1, `${lots.length}`);
		check('… et il compte exactement 3 items', lots[0]?.items.length === 3);
		check(
			'les DEUX L4 sont exclues, nommément',
			excluded.filter((e) => e.id === p4a.id || e.id === p4b.id).length === 2 &&
				excluded.some((e) => e.reason.includes('L4')),
			excluded.map((e) => e.reason).join(' | ')
		);

		// ── 3. Modifier une proposition l'exclut du lot ────────────────
		console.log("\n3. Modifier une proposition l'exclut du lot :");
		const hashBefore = lots[0].items.find((i) => i.id === pC.id)!.payloadHash;
		const updated = await updateProposalPayload(
			{ proposalId: pC.id, payloadJson: JSON.stringify({ edited: RUN_KEY }) },
			db
		);
		check('le hash de C a changé', updated.payloadHash !== hashBefore);

		// Le lot est approuvé AVEC les hashes affichés AVANT la modification :
		// c'est exactement la course que la garde existe pour rattraper.
		const batch = await approveLot(lots[0].items);
		check(
			'A et B sont approuvées',
			batch.approved.length === 2 && batch.approved.includes(pA.id) && batch.approved.includes(pB.id),
			batch.approved.join(',')
		);
		check(
			'C est écartée NOMMÉMENT, pour hash périmé',
			batch.skipped.length === 1 &&
				batch.skipped[0].id === pC.id &&
				batch.skipped[0].reason === 'stale_hash',
			JSON.stringify(batch.skipped)
		);
		check(
			'… et le refus n’a RIEN écrit sur C',
			(await countApprovals(pC.id)) === 0 && (await readProposal(pC.id)).status === 'proposed',
			(await readProposal(pC.id)).status
		);

		// ── 4. L'approbation est liée au hash EXACT ────────────────────
		console.log("\n4. L'approbation est liée au hash exact :");
		const detailA = await getProposalDetail(pA.id, db);
		check(
			'l’approbation porte le hash courant de la proposition',
			detailA!.approvals[0]?.approvedPayloadHash === detailA!.proposal.payloadHash,
			detailA!.approvals[0]?.approvedPayloadHash?.slice(0, 12)
		);
		check('la proposition est passée `approved`', detailA!.proposal.status === 'approved');
		check(
			'l’acteur est nominatif (audit §14.3)',
			detailA!.approvals[0]?.approverId === ACTOR,
			detailA!.approvals[0]?.approverId ?? '—'
		);

		// ── 5. Double soumission : idempotente ─────────────────────────
		console.log('\n5. Une double soumission ne crée pas deux décisions :');
		const again = await approveProposal(
			{
				proposalId: pA.id,
				approverType: 'user',
				approverId: ACTOR,
				method: 'ui',
				expectedPayloadHash: detailA!.proposal.payloadHash
			},
			db
		);
		check('le second appel se déclare idempotent', again.idempotent === true);
		check(
			'il rend LA MÊME approbation',
			again.approvalId === detailA!.approvals[0].id,
			`${again.approvalId.slice(0, 8)} vs ${detailA!.approvals[0].id.slice(0, 8)}`
		);
		check('… et `proposal_approvals` n’a QU’UNE ligne', (await countApprovals(pA.id)) === 1);

		// ── 6. Une approbation tombée reste VISIBLE ────────────────────
		console.log('\n6. Une approbation tombée n’est pas une absence de décision :');
		const upd2 = await updateProposalPayload(
			{ proposalId: pA.id, payloadJson: JSON.stringify({ changed: RUN_KEY }) },
			db
		);
		check('1 approbation invalidée', upd2.invalidatedApprovals === 1);
		const detailA2 = await getProposalDetail(pA.id, db);
		check('la proposition retombe `invalidated`', detailA2!.proposal.status === 'invalidated');
		check(
			'l’approbation est TOUJOURS rendue par le détail (statut `invalidated`)',
			detailA2!.approvals.length === 1 && detailA2!.approvals[0].status === 'invalidated',
			`${detailA2!.approvals.length} approbation(s)`
		);
		check(
			'… et `invalidated` reste décidable (l’approbation est tombée, pas la proposition)',
			proposalAbilities({
				status: detailA2!.proposal.status,
				requiredApprovalLevel: detailA2!.proposal.requiredApprovalLevel,
				actorType: 'user'
			}).approve
		);

		// ── 7. Révision demandée : ni écrasée, ni ré-approuvée ─────────
		console.log('\n7. Une révision demandée survit au run suivant :');

		// pB est `approved` : une décision engagée ne se re-décide pas. La levée est
		// attendue ICI, dans son propre `try` — l'englober dans le try du bloc
		// entier ferait passer n'importe quel autre refus pour celui-ci.
		let bRefused = '';
		try {
			await requestProposalChanges(
				{ proposalId: pB.id, reason: '[test] à reformuler avant publication', actor: ACTOR },
				db
			);
		} catch (e) {
			bRefused = e instanceof ProposalDecisionError ? e.code : 'autre';
		}
		check(
			'une proposition APPROUVÉE ne peut pas passer en révision',
			bRefused === 'not_decidable',
			bRefused
		);
		check(
			'… et son statut est intact',
			(await readProposal(pB.id)).status === 'approved',
			(await readProposal(pB.id)).status
		);

		await requestProposalChanges(
			{ proposalId: pC.id, reason: '[test] cible à revoir', actor: ACTOR },
			db
		);
		const cAfter = await readProposal(pC.id);
		check('C passe `changes_requested`', cAfter.status === 'changes_requested', cAfter.status);
		const cEvents = (await eventsOf(fC.id)).filter((e) => e.reason === '[test] cible à revoir');
		check(
			'la raison est journalisée au finding, avec son acteur',
			cEvents.length === 1 && cEvents[0].actor === ACTOR,
			`${cEvents.length} événement(s)`
		);

		// Le run du producteur ne doit ni la périmer ni la ré-approuver : il écrira
		// SA propre proposition (payload différent du nôtre), et notre proposition en
		// révision doit rester intacte à côté.
		const r = await runFindingProposer({
			db,
			projectId: project.id,
			findingIds: [fC.id],
			config: { maxProposals: 500 }
		});
		if (r.agentRunId) openedAgentRuns.push(r.agentRunId);
		const cAfterRun = await readProposal(pC.id);
		check(
			'le run du producteur ne l’a PAS périmée (decideSupersession épargne ce statut)',
			cAfterRun.status === 'changes_requested',
			cAfterRun.status
		);

		// ── 8. DASH-004 — le cycle de vie d'un finding ─────────────────
		console.log('\n8. Findings : contester, mettre en veille, écarter :');
		const projectId = project.id;
		const fSnooze = await seedFinding(projectId, 'veille', 'https://test.invalid/e');
		const fDismiss = await seedFinding(projectId, 'ecarte', 'https://test.invalid/f');
		const fAck = await seedFinding(projectId, 'pris-en-compte', 'https://test.invalid/g');

		await transitionFinding(
			{
				findingId: fAck.id,
				projectId,
				toStatus: 'acknowledged',
				reason: '[test] vu, à traiter',
				actor: ACTOR
			},
			db
		);
		const ackEvents = await eventsOf(fAck.id);
		check(
			'une transition écrit UN événement, avec acteur et raison',
			ackEvents.filter((e) => e.toStatus === 'acknowledged').length === 1 &&
				ackEvents.some((e) => e.actor === ACTOR && e.reason === '[test] vu, à traiter'),
			`${ackEvents.length} événement(s)`
		);
		check(
			'… et un `acknowledged` reste dans l’inbox (statut actif)',
			(await listFindings({ projectId, limit: 500 }, db)).some((f) => f.id === fAck.id)
		);

		const snoozed = await snoozeFinding(
			{ findingId: fSnooze.id, projectId, reason: '[test] pas maintenant', days: 7, actor: ACTOR },
			db
		);
		check('la veille porte une échéance', Boolean(snoozed.snoozedUntil), snoozed.snoozedUntil);
		check(
			'un finding en veille SORT de l’inbox',
			!(await listFindings({ projectId, limit: 500 }, db)).some((f) => f.id === fSnooze.id)
		);

		await dismissFinding(
			{
				findingId: fDismiss.id,
				projectId,
				reason: '[test] faux positif',
				category: 'false_positive',
				actor: ACTOR
			},
			db
		);
		check(
			'un finding écarté sort de l’inbox…',
			!(await listFindings({ projectId, limit: 500 }, db)).some((f) => f.id === fDismiss.id)
		);
		// Le dismiss vaut À VIE : le redétecter ne le fait pas revenir.
		await seedFinding(projectId, 'ecarte', 'https://test.invalid/f');
		const stillDismissed = await getFindingWithEvidence(fDismiss.id, db);
		check(
			'… et une re-détection ne le ressuscite PAS (dismiss à vie)',
			stillDismissed!.finding.status === 'dismissed',
			stillDismissed!.finding.status
		);
		check(
			'le détail rend le projet (slug), pas seulement son id',
			stillDismissed!.project.slug === project.slug,
			stillDismissed!.project.slug ?? '—'
		);

		const fCounts = await countFindingsByStatus({ projectSlug: project.slug }, db);
		check(
			'les compteurs distinguent veille et écartés',
			(fCounts.snoozed ?? 0) >= 1 && (fCounts.dismissed ?? 0) >= 1,
			`snoozed=${fCounts.snoozed ?? 0} dismissed=${fCounts.dismissed ?? 0}`
		);
		check(
			'la pagination compte le même ensemble que la liste',
			(await countFindings({ projectSlug: project.slug, limit: 500 }, db)) ===
				(await listFindings({ projectSlug: project.slug, limit: 500 }, db)).length
		);

		// ── 9. Rejet motivé ────────────────────────────────────────────
		console.log('\n9. Un rejet porte sa raison :');
		const fRej = await seedFinding(projectId, 'rejet', 'https://test.invalid/h');
		const pRej = await seedProposal({
			projectId,
			findingId: fRej.id,
			actionType: 'meta_rewrite',
			level: 'L3',
			risk: 'low',
			marker: 'rej'
		});
		await rejectProposal(
			{ proposalId: pRej.id, reason: '[test] hors sujet', actor: ACTOR },
			db
		);
		const rejRow = await readProposal(pRej.id);
		check('la proposition est `rejected`', rejRow.status === 'rejected', rejRow.status);
		check(
			'la raison est au journal du finding',
			(await eventsOf(fRej.id)).some((e) => e.reason === '[test] hors sujet' && e.actor === ACTOR)
		);
		let reRejected = false;
		try {
			await rejectProposal(
				{ proposalId: pRej.id, reason: '[test] deuxième fois', actor: ACTOR },
				db
			);
		} catch (e) {
			reRejected = e instanceof ProposalDecisionError && e.code === 'not_decidable';
		}
		check('une décision close ne se re-décide pas', reRejected);

		// ── 10. Un agent ne peut pas approuver une L3/L4 ───────────────
		console.log('\n10. La séparation des niveaux tient aussi par cette porte :');
		let agentRefused = '';
		try {
			await approveProposal(
				{ proposalId: p4a.id, approverType: 'agent', approverId: TEST_TAG },
				db
			);
		} catch (e) {
			agentRefused = e instanceof ProposalDecisionError ? e.code : 'autre';
		}
		check('un agent est refusé sur une L4', agentRefused === 'level_refused', agentRefused);
		check('… et le refus n’a rien écrit', (await countApprovals(p4a.id)) === 0);

		// ── 11. Aucun horodatage ISO ───────────────────────────────────
		console.log('\n11. Aucun horodatage ISO (piège lexical) :');
		const isoRows = await db.execute(sql`
			SELECT count(*)::int AS n FROM "seostats"."action_proposals"
			WHERE created_at LIKE '%T%' OR updated_at LIKE '%T%'
			   OR (approved_at IS NOT NULL AND approved_at LIKE '%T%')
		`);
		const isoApprovals = await db.execute(sql`
			SELECT count(*)::int AS n FROM "seostats"."proposal_approvals" WHERE created_at LIKE '%T%'
		`);
		check(
			'0 horodatage ISO dans action_proposals',
			Number((isoRows.rows as unknown as { n: number }[])[0].n) === 0
		);
		check(
			'0 horodatage ISO dans proposal_approvals',
			Number((isoApprovals.rows as unknown as { n: number }[])[0].n) === 0
		);
	} finally {
		console.log('\n12. Nettoyage (enfants d’abord) :');
		const removed = await cleanup();
		console.log(
			`   supprimé : ${removed.approvals} approbations · ${removed.proposals} propositions · ` +
				`${removed.agentRuns} agent_runs · ${removed.events} événements · ${removed.findings} findings`
		);

		const after = {
			findings: Number(
				(await db.select({ n: sql<number>`count(*)::int` }).from(schema.findings))[0].n
			),
			proposals: Number(
				(await db.select({ n: sql<number>`count(*)::int` }).from(schema.actionProposals))[0].n
			),
			approvals: Number(
				(await db.select({ n: sql<number>`count(*)::int` }).from(schema.proposalApprovals))[0].n
			)
		};
		check(
			`la base est rendue à l’identique (${before.findings} findings)`,
			after.findings === before.findings,
			`${after.findings}`
		);
		check(
			`… ${before.proposals} propositions`,
			after.proposals === before.proposals,
			`${after.proposals}`
		);
		check(
			`… ${before.approvals} approbations`,
			after.approvals === before.approvals,
			`${after.approvals}`
		);

		console.log(`\n${failures === 0 ? '✅ TOUT VERT' : `❌ ${failures} ÉCHEC(S)`}`);
		await pool.end();
		process.exit(failures === 0 ? 0 : 1);
	}
}

main().catch(async (e) => {
	console.error('\n❌ Erreur fatale :', e);
	try {
		await cleanup();
	} finally {
		await pool.end();
	}
	process.exit(1);
});
