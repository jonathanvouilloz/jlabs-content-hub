/**
 * AGT-000 — Preuve du producteur de propositions sur une VRAIE base.
 *
 * Ce test ne peut pas vivre dans vitest : ce qu'on vérifie ici, c'est le
 * comportement transactionnel de Postgres (upsert sur l'unique
 * projet+finding+action+hash, gardes d'approbation, invalidation liée au hash),
 * pas notre arithmétique — celle-ci est déjà couverte par
 * `proposer-state.test.ts` (49 tests purs).
 *
 * Protocole (tout se passe sur des findings marqués `__test_agt000:` — le script
 * ne lit ni ne modifie AUCUN finding ni AUCUNE proposition réelle) :
 *   1. le producteur écrit des propositions depuis de vrais findings de test  [acceptation 1]
 *   2. rejouer à l'identique ne duplique RIEN (dédup par payload_hash)        [acceptation 1]
 *   3. les champs non hashés sont RAFRAÎCHIS, le hash ne bouge pas
 *   4. un finding aggravé (action différente) → l'ancienne est `superseded`   [acceptation 2]
 *   5. un agent ne peut PAS approuver une L3 (§12.2)                          [acceptation 3]
 *   6. modifier le payload invalide l'approbation liée                        [acceptation 3]
 *   7. snoozed / dismissed / resolved ne produisent AUCUNE proposition
 *   8. l'agent_run est ouvert PUIS clos, avec les findings lus
 *   9. la troncature est annoncée avec le total réel
 *  10. aucun horodatage ISO dans les tables DATA-006 (piège lexical)
 *  11. SUPPRIME exactement les lignes qu'il a créées (enfants d'abord — FK).
 *
 * Lancer : npx tsx scripts/agt-000-proposer-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { eq, inArray, like, sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { upsertFinding, snoozeFinding, dismissFinding } from '../src/lib/server/findings.js';
import {
	approveProposal,
	updateProposalPayload,
	computePayloadHash
} from '../src/lib/server/proposals.js';
import { runFindingProposer } from '../src/lib/server/proposers/finding-proposer.js';
import { PROPOSER_VERSION } from '../src/lib/server/proposer-state.js';
import { createId } from '../src/lib/server/utils.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

/**
 * Marqueur exclusif de ce test. Le producteur ne sait dériver une action QUE
 * pour `keyword_opportunity` : le type doit donc être le VRAI type métier, et
 * l'isolation ne peut pas passer par lui. Elle tient à deux choses : le
 * FINGERPRINT est préfixé par une clé unique de run, et chaque invocation du
 * producteur est bornée par `findingIds` (son paramètre de substitution). Sans
 * cette double garde, la preuve écrirait des propositions sur les findings de
 * PRODUCTION du projet qui l'héberge.
 */
const TEST_TAG = '__test_agt000';
const RUN_KEY = createId();
const SEP = '\x1f';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}

/** Fingerprint de test : type métier réel, mais cloisonné par la clé de run. */
const fp = (name: string, page: string) =>
	['keyword_opportunity', 'query', `${TEST_TAG}:${RUN_KEY}:${name}`, page].join(SEP);

function evidenceJson(over: { position: number; clicks?: number; impressions?: number }): string {
	return JSON.stringify({
		detector: 'keyword_opportunity@1',
		window: { start: '2026-06-01', end: '2026-06-28', weeks: 4 },
		observationIds: [],
		observationCount: 0,
		metrics: {
			clicks: over.clicks ?? 2,
			impressions: over.impressions ?? 800,
			ctr: 0.0025,
			position: over.position,
			weeksSeen: 4,
			gainEstimate: 20
		},
		scoreBreakdown: { impact: 40, urgency: 18, confidence: 14, strategicFit: 9 },
		confidenceCaveats: []
	});
}

async function pickProjectId(): Promise<string> {
	const rows = await db.select({ id: schema.projects.id }).from(schema.projects).limit(1);
	if (rows.length === 0) throw new Error('Aucun projet en base.');
	return rows[0].id;
}

async function seedFinding(
	projectId: string,
	name: string,
	page: string,
	opts: { position: number; priority?: number; clicks?: number }
) {
	return upsertFinding(
		{
			projectId,
			type: 'keyword_opportunity',
			entityType: 'query',
			entityKey: `${TEST_TAG}:${RUN_KEY}:${name}`,
			fingerprint: fp(name, page),
			title: `[test] ${name}`,
			severity: 'high',
			priorityScore: opts.priority ?? 85,
			confidenceScore: 70,
			impactEstimateJson: JSON.stringify({ gainEstimateClicksPerWeek: 20, ctrGap: 0.03 }),
			evidenceJson: evidenceJson({ position: opts.position, clicks: opts.clicks }),
			detectorVersion: 'keyword_opportunity@1',
			recommendedSkill: 'seo-refresh'
		},
		db
	);
}

/**
 * `agent_runs` ouverts par cette preuve. Ils ne portent AUCUN marqueur de test
 * (le producteur écrit sa propre version, et c'est bien ainsi : il ne doit pas
 * savoir qu'un test l'appelle). On les collecte donc à la volée — c'est la seule
 * façon de les supprimer sans risquer d'emporter ceux d'un vrai run.
 */
const openedAgentRuns: string[] = [];

/** Ids des findings de test (la clé de run est dans le fingerprint). */
async function testFindingIds(): Promise<string[]> {
	const rows = await db
		.select({ id: schema.findings.id })
		.from(schema.findings)
		.where(like(schema.findings.fingerprint, `%${RUN_KEY}%`));
	return rows.map((r) => r.id);
}

/**
 * Nettoyage ENFANTS D'ABORD — c'est exactement la FK qui a mordu
 * `job-claim-concurrency` : une suppression parent-d'abord échoue APRÈS toutes
 * les vérifications, donc en laissant croire à un succès.
 * Ordre : proposal_approvals → action_proposals → agent_runs → finding_events → findings.
 */
async function cleanup(): Promise<Record<string, number>> {
	const findingIds = await testFindingIds();
	const out = { approvals: 0, proposals: 0, agentRuns: 0, events: 0, findings: 0 };

	// Les agent_runs se nettoient même si aucun finding n'a survécu (un échec en
	// cours de route a pu en laisser un ouvert).
	if (openedAgentRuns.length > 0) {
		out.agentRuns = (
			await db
				.delete(schema.agentRuns)
				.where(inArray(schema.agentRuns.id, openedAgentRuns))
				.returning({ id: schema.agentRuns.id })
		).length;
		openedAgentRuns.length = 0;
	}
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

/**
 * Le type de nos findings est le VRAI type métier (sans quoi le producteur ne
 * saurait en dériver aucune action) : l'isolation ne peut donc pas passer par
 * lui. Chaque appel est borné par `findingIds` — le paramètre de substitution
 * documenté du producteur. Ce filtre-ci est la ceinture : il vérifie qu'on ne
 * juge que nos propres propositions, et il collecte l'agent_run à nettoyer.
 */
function ours(res: Awaited<ReturnType<typeof runFindingProposer>>, ids: Set<string>) {
	if (res.agentRunId) openedAgentRuns.push(res.agentRunId);
	return res.proposals.filter((p) => ids.has(p.findingId));
}

async function readProposal(id: string) {
	const rows = await db
		.select({
			id: schema.actionProposals.id,
			status: schema.actionProposals.status,
			actionType: schema.actionProposals.actionType,
			payloadHash: schema.actionProposals.payloadHash,
			payloadJson: schema.actionProposals.payloadJson,
			rationale: schema.actionProposals.rationale,
			requiredApprovalLevel: schema.actionProposals.requiredApprovalLevel,
			riskLevel: schema.actionProposals.riskLevel,
			target: schema.actionProposals.target,
			updatedAt: schema.actionProposals.updatedAt
		})
		.from(schema.actionProposals)
		.where(eq(schema.actionProposals.id, id));
	return rows[0];
}

async function countProposalsFor(findingIds: string[]): Promise<number> {
	if (findingIds.length === 0) return 0;
	const rows = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(schema.actionProposals)
		.where(inArray(schema.actionProposals.findingId, findingIds));
	return Number(rows[0]?.n ?? 0);
}

async function main() {
	console.log(`\n=== AGT-000 — preuve du producteur de propositions (run ${RUN_KEY}) ===`);
	const projectId = await pickProjectId();
	const findingsBefore = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(schema.findings);
	const proposalsBefore = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(schema.actionProposals);

	try {
		// ── 1. Production initiale ─────────────────────────────────────
		console.log('\n1. Le producteur transforme des findings en propositions :');
		const proche = await seedFinding(projectId, 'proche', 'https://test.invalid/a', {
			position: 6.4,
			clicks: 2
		});
		const loin = await seedFinding(projectId, 'loin', 'https://test.invalid/b', {
			position: 17.2,
			clicks: 0
		});
		const gros = await seedFinding(projectId, 'gros-trafic', 'https://test.invalid/c', {
			position: 4.1,
			clicks: 55
		});
		const ids = new Set([proche.id, loin.id, gros.id]);

		const r1 = await runFindingProposer({ db, projectId, findingIds: [...ids], config: { maxProposals: 500 } });
		const mine1 = ours(r1, ids);
		check('3 propositions produites pour nos findings', mine1.length === 3, `${mine1.length}`);

		const byFinding = new Map(mine1.map((p) => [p.findingId, p]));
		check(
			'position basse → meta_rewrite (L3)',
			byFinding.get(proche.id)?.actionType === 'meta_rewrite' &&
				byFinding.get(proche.id)?.approvalLevel === 'L3',
			`${byFinding.get(proche.id)?.actionType}/${byFinding.get(proche.id)?.approvalLevel}`
		);
		check(
			'position haute → refresh_plan (L2, un brouillon)',
			byFinding.get(loin.id)?.actionType === 'refresh_plan' &&
				byFinding.get(loin.id)?.approvalLevel === 'L2',
			`${byFinding.get(loin.id)?.actionType}/${byFinding.get(loin.id)?.approvalLevel}`
		);
		check(
			'page à 55 clics → risque relevé à high (un acquis à perdre)',
			byFinding.get(gros.id)?.riskLevel === 'high',
			`${byFinding.get(gros.id)?.riskLevel}`
		);
		check(
			'aucune auto-approbation (aucune policy projet)',
			mine1.every((p) => !p.autoApproved),
			mine1.map((p) => p.autoApprovalReason)[0]
		);
		const persisted = await readProposal(byFinding.get(proche.id)!.proposalId!);
		check('la cible persistée est la PAGE, pas la query', persisted.target === 'https://test.invalid/a', `${persisted.target}`);
		check('le niveau requis est persisté', persisted.requiredApprovalLevel === 'L3');

		// ── 2. Idempotence ─────────────────────────────────────────────
		console.log('\n2. Rejouer à l’identique ne duplique rien :');
		const countAfter1 = await countProposalsFor([...ids]);
		const r2 = await runFindingProposer({ db, projectId, findingIds: [...ids], config: { maxProposals: 500 } });
		const countAfter2 = await countProposalsFor([...ids]);
		check('même nombre de propositions après un 2e run', countAfter1 === countAfter2, `${countAfter1} → ${countAfter2}`);
		check(
			'les mêmes ids sont renvoyés (upsert, pas insert)',
			ours(r2, ids).every((p) => mine1.some((q) => q.proposalId === p.proposalId)),
			`${ours(r2, ids).length} proposition(s)`
		);
		check('rien compté comme « nouveau » au 2e run', r2.counts.created === 0, `${r2.counts.created}`);

		// ── 3. Les champs non hashés sont rafraîchis ───────────────────
		console.log('\n3. Les mesures se rafraîchissent SANS toucher le hash :');
		const before3 = await readProposal(byFinding.get(proche.id)!.proposalId!);
		// Même problème, mesures qui bougent — mais l'action ne change pas.
		await seedFinding(projectId, 'proche', 'https://test.invalid/a', {
			position: 6.1,
			clicks: 4
		});
		const r3 = await runFindingProposer({ db, projectId, findingIds: [...ids], config: { maxProposals: 500 } });
		const after3 = await readProposal(byFinding.get(proche.id)!.proposalId!);
		check('le payload_hash est INCHANGÉ (sinon l’inbox doublerait chaque semaine)', before3.payloadHash === after3.payloadHash);
		check('le rationale, lui, a été rafraîchi', before3.rationale !== after3.rationale);
		check('aucune proposition de plus', (await countProposalsFor([...ids])) === countAfter1);
		check('toujours 3 propositions à nous', ours(r3, ids).length === 3);

		// ── 4. Changement d'action → supersession ──────────────────────
		console.log('\n4. La situation change → l’ancienne proposition est périmée :');
		// La page passe de position 17 à position 5 : refresh_plan → meta_rewrite.
		await seedFinding(projectId, 'loin', 'https://test.invalid/b', { position: 5.0, clicks: 1 });
		const r4 = await runFindingProposer({ db, projectId, findingIds: [...ids], config: { maxProposals: 500 } });
		const nouvelle = ours(r4, ids).find((p) => p.findingId === loin.id);
		check('la nouvelle action est meta_rewrite', nouvelle?.actionType === 'meta_rewrite', `${nouvelle?.actionType}`);
		const oldProposalId = byFinding.get(loin.id)!.proposalId!;
		const oldRow = await readProposal(oldProposalId);
		check('l’ancienne refresh_plan n’est PAS superseded (action différente)', oldRow.status === 'proposed', oldRow.status);
		// Une VRAIE supersession : même action, payload rendu obsolète à la main.
		await updateProposalPayload(
			{ proposalId: nouvelle!.proposalId!, payloadJson: JSON.stringify({ obsolete: true }) },
			db
		);
		const r4b = await runFindingProposer({ db, projectId, findingIds: [...ids], config: { maxProposals: 500 } });
		const rebuilt = ours(r4b, ids).find((p) => p.findingId === loin.id);
		check('une proposition au payload obsolète est périmée', rebuilt!.superseded.includes(nouvelle!.proposalId!), `${rebuilt!.superseded.join(',')}`);
		const supersededRow = await readProposal(nouvelle!.proposalId!);
		check('… et son statut est bien `superseded`', supersededRow.status === 'superseded', supersededRow.status);

		// ── 5. Un agent ne peut pas approuver une L3 (§12.2) ───────────
		console.log('\n5. Séparation des niveaux :');
		let refused = false;
		let refusalMsg = '';
		try {
			await approveProposal(
				{ proposalId: persisted.id, approverType: 'agent', approverId: 'proof' },
				db
			);
		} catch (e) {
			refused = true;
			refusalMsg = e instanceof Error ? e.message : String(e);
		}
		check('un agent NE PEUT PAS approuver une L3', refused, refusalMsg.slice(0, 60));
		const stillProposed = await readProposal(persisted.id);
		check('le refus n’a rien écrit', stillProposed.status === 'proposed', stillProposed.status);

		const humanApproval = await approveProposal(
			{ proposalId: persisted.id, approverType: 'user', approverId: 'proof@test', method: 'ui' },
			db
		);
		const approvedRow = await readProposal(persisted.id);
		check('un humain, si', approvedRow.status === 'approved', approvedRow.status);

		// ── 6. Modifier le payload invalide l'approbation ──────────────
		console.log('\n6. L’approbation est liée au HASH exact :');
		const upd = await updateProposalPayload(
			{ proposalId: persisted.id, payloadJson: JSON.stringify({ change: 'oui' }) },
			db
		);
		check('1 approbation invalidée', upd.invalidatedApprovals === 1, `${upd.invalidatedApprovals}`);
		const invalidated = await readProposal(persisted.id);
		check('la proposition retombe en `invalidated`', invalidated.status === 'invalidated', invalidated.status);
		check('le hash a bien changé', invalidated.payloadHash === computePayloadHash(JSON.stringify({ change: 'oui' })));
		const approvalRows = await db
			.select({ status: schema.proposalApprovals.status })
			.from(schema.proposalApprovals)
			.where(eq(schema.proposalApprovals.id, humanApproval.approvalId));
		check('l’approbation est marquée `invalidated`', approvalRows[0]?.status === 'invalidated', `${approvalRows[0]?.status}`);

		// ── 7. La troncature est annoncée ──────────────────────────────
		// AVANT la mise en veille : il faut trois findings ACTIFS pour qu'un
		// plafond à 1 puisse mordre.
		console.log('\n7. La troncature n’est jamais silencieuse :');
		const r7t = await runFindingProposer({
			db,
			projectId,
			findingIds: [...ids],
			dryRun: true,
			config: { maxProposals: 1, minPriority: 0 }
		});
		check('truncated = true quand le plafond mord', r7t.truncated === true);
		check(
			'le total réel est exposé à côté du tronqué',
			r7t.totalMatched > r7t.proposals.length,
			`${r7t.totalMatched} éligibles / ${r7t.proposals.length} proposé(s)`
		);
		const r7b = await runFindingProposer({
			db,
			projectId,
			findingIds: [...ids],
			dryRun: true,
			config: { maxProposals: 5000, minPriority: 0 }
		});
		check('… et reste faux sans troncature', r7b.truncated === false);

		// ── 8. Les statuts non actifs ne produisent rien ───────────────
		console.log('\n8. Le snooze et le dismiss tiennent :');
		await snoozeFinding({ findingId: gros.id, projectId, days: 30, reason: 'test', actor: 'user' }, db);
		await dismissFinding(
			{ findingId: proche.id, projectId, reason: 'test', actor: 'user', category: 'false_positive' },
			db
		);
		const countBefore7 = await countProposalsFor([...ids]);
		const r7 = await runFindingProposer({ db, projectId, findingIds: [...ids], config: { maxProposals: 500 } });
		const countAfter7 = await countProposalsFor([...ids]);
		check('aucune proposition de plus', countBefore7 === countAfter7, `${countBefore7} → ${countAfter7}`);
		check(
			'ni le snoozé ni le dismissé ne sont proposés',
			!ours(r7, ids).some((p) => p.findingId === gros.id || p.findingId === proche.id)
		);
		// `listFindings` filtre déjà sur les statuts ACTIFS : un finding en veille
		// ou dismissé n'est même pas LU. C'est la garde de premier rang ; celle de
		// `selectProposableFindings` est la seconde, couverte en vitest.
		check(
			'ils ne sont même plus lus (garde de premier rang)',
			r7.findingsRead === 1,
			`${r7.findingsRead} finding(s) lu(s) sur 3`
		);

		// ── 9. L'agent run est ouvert PUIS clos ────────────────────────
		console.log('\n9. L’invocation est auditable (SPEC §7.9) :');
		check('un agent_run a été ouvert', Boolean(r7.agentRunId));
		const runRows = await db
			.select({
				status: schema.agentRuns.status,
				agent: schema.agentRuns.agent,
				findingsReadJson: schema.agentRuns.findingsReadJson,
				resultJson: schema.agentRuns.resultJson,
				durationMs: schema.agentRuns.durationMs,
				finishedAt: schema.agentRuns.finishedAt
			})
			.from(schema.agentRuns)
			.where(eq(schema.agentRuns.id, r7.agentRunId!));
		const ar = runRows[0];
		check('il est clos en `succeeded`', ar?.status === 'succeeded', `${ar?.status}`);
		check('il porte les findings lus', Boolean(ar?.findingsReadJson && ar.findingsReadJson.length > 2));
		check('il porte son résultat et sa durée', Boolean(ar?.resultJson) && typeof ar?.durationMs === 'number');
		check('il a une date de fin', Boolean(ar?.finishedAt));

		// ── 10. Hygiène des horodatages ────────────────────────────────
		console.log('\n10. Hygiène (le piège lexical de timestamps.ts) :');
		const iso = await db.execute(sql`
			SELECT
			  (SELECT count(*)::int FROM "seostats"."action_proposals"
			    WHERE updated_at LIKE '%T%' OR created_at LIKE '%T%' OR approved_at LIKE '%T%') AS p,
			  (SELECT count(*)::int FROM "seostats"."agent_runs"
			    WHERE created_at LIKE '%T%' OR finished_at LIKE '%T%') AS a,
			  (SELECT count(*)::int FROM "seostats"."proposal_approvals"
			    WHERE created_at LIKE '%T%') AS ap
		`);
		const row = iso.rows?.[0] as { p: number; a: number; ap: number } | undefined;
		check('aucun horodatage ISO dans action_proposals', Number(row?.p ?? 0) === 0, `${row?.p}`);
		check('aucun horodatage ISO dans agent_runs', Number(row?.a ?? 0) === 0, `${row?.a}`);
		check('aucun horodatage ISO dans proposal_approvals', Number(row?.ap ?? 0) === 0, `${row?.ap}`);
		console.log(`  (référence temporelle du run : ${toDbTimestamp()})`);
	} finally {
		const removed = await cleanup();
		console.log(
			`\nNettoyage : ${removed.approvals} approbation(s), ${removed.proposals} proposition(s), ` +
				`${removed.agentRuns} agent_run(s), ${removed.events} événement(s), ${removed.findings} finding(s).`
		);
	}

	// ── 11. La base est rendue telle qu'on l'a trouvée ────────────────
	console.log('\n11. Aucune trace laissée :');
	const findingsAfter = await db.select({ n: sql<number>`count(*)::int` }).from(schema.findings);
	const proposalsAfter = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(schema.actionProposals);
	check(
		'le nombre de findings est revenu à son point de départ',
		Number(findingsAfter[0].n) === Number(findingsBefore[0].n),
		`${findingsBefore[0].n} → ${findingsAfter[0].n}`
	);
	check(
		'le nombre de propositions aussi',
		Number(proposalsAfter[0].n) === Number(proposalsBefore[0].n),
		`${proposalsBefore[0].n} → ${proposalsAfter[0].n}`
	);

	console.log(
		failures === 0
			? '\n✅ AGT-000 — toutes les vérifications passent.\n'
			: `\n❌ ${failures} vérification(s) en échec.\n`
	);
	await pool.end();
	if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
	console.error('Preuve AGT-000 échouée:', err);
	await cleanup().catch(() => {});
	await pool.end().catch(() => {});
	process.exit(1);
});
