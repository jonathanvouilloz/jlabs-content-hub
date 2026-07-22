/**
 * AGT-000 — Runner du producteur de propositions (findings → `action_proposals`).
 *
 * Lit les findings ACTIFS (DATA-005/FIND-003) et écrit de vraies propositions
 * (DATA-006), gouvernées par les niveaux L0–L4 (§12.1) et les policies (DATA-007).
 * Idempotent : la dédup vise l'unique `(projet, finding, action, payload_hash)` →
 * rejouer ne crée jamais un doublon.
 *
 * Pattern runner (cf. detect.ts / backfill-observations.ts) : Pool propre +
 * drizzle autonome, injecté dans les modules serveur. Toute la logique métier
 * vit dans le module PUR src/lib/server/proposer-state.ts (vitest).
 *
 * ⚠️ DRY-RUN PAR DÉFAUT. Ce script ÉCRIT dans l'inbox de propositions ; il faut
 * demander explicitement `--execute`. Même discipline que jobs-purge-test.ts :
 * ce qui écrit se regarde d'abord.
 *
 * Inspecter :  npx tsx scripts/propose.ts --project=<slug>
 * Écrire    :  npx tsx scripts/propose.ts --project=<slug> --execute
 * Tous      :  npx tsx scripts/propose.ts --project=all --execute
 * Options   :  --limit=20  --min-priority=60  --max=10
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { eq } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { runFindingProposer } from '../src/lib/server/proposers/finding-proposer.js';
import { PROPOSER_VERSION } from '../src/lib/server/proposer-state.js';
import { createRun, recordStep, recomputeRunStatus } from '../src/lib/server/monitoring.js';
import { deriveIdempotencyKey, normalizeError } from '../src/lib/server/monitoring-state.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const PROJECT = arg('project') ?? 'all';
const LIMIT = Number(arg('limit') ?? 20);
const NOW = arg('now') ?? new Date().toISOString().slice(0, 10);
const MIN_PRIORITY = arg('min-priority') !== undefined ? Number(arg('min-priority')) : undefined;
const MAX_PROPOSALS = arg('max') !== undefined ? Number(arg('max')) : undefined;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

/** `propose:actions` — le step_type qui identifie ce producteur dans un run. */
const STEP_TYPE = 'propose:actions';

const overrides = {
	...(MIN_PRIORITY !== undefined ? { minPriority: MIN_PRIORITY } : {}),
	...(MAX_PROPOSALS !== undefined ? { maxProposals: MAX_PROPOSALS } : {})
};

async function resolveProjects(): Promise<{ id: string; slug: string; name: string }[]> {
	if (PROJECT !== 'all') {
		const rows = await db
			.select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name })
			.from(schema.projects)
			.where(eq(schema.projects.slug, PROJECT));
		if (rows.length === 0) throw new Error(`Projet "${PROJECT}" introuvable.`);
		return rows;
	}
	return db
		.select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name })
		.from(schema.projects)
		.where(eq(schema.projects.archived, false))
		.orderBy(schema.projects.slug);
}

async function proposeForProject(project: {
	id: string;
	slug: string;
	name: string;
}): Promise<void> {
	console.log(`\n── ${project.name} (${project.slug}) ─────────────────────────`);

	if (!EXECUTE) {
		report(
			await runFindingProposer({ db, projectId: project.id, dryRun: true, config: overrides })
		);
		return;
	}

	const run = await createRun(
		{
			projectId: project.id,
			runType: 'manual',
			idempotencyKey: deriveIdempotencyKey({
				runType: 'manual',
				projectSlug: project.slug,
				periodEnd: NOW,
				stepType: STEP_TYPE,
				schemaVersion: 1
			}),
			triggeredBy: 'user',
			periodEnd: NOW
		},
		db
	);
	if (!run.created) console.log(`(run existant réutilisé — même clé d'idempotence)`);

	const startedAt = toDbTimestamp();
	const t0 = Date.now();
	try {
		const res = await runFindingProposer({
			db,
			projectId: project.id,
			runId: run.id,
			config: overrides
		});
		await recordStep(
			{
				runId: run.id,
				stepType: STEP_TYPE,
				status: res.skippedReason ? 'skipped' : 'success',
				startedAt,
				finishedAt: toDbTimestamp(),
				durationMs: Date.now() - t0,
				metadataJson: JSON.stringify({
					proposerVersion: res.proposerVersion,
					findingsRead: res.findingsRead,
					totalMatched: res.totalMatched,
					truncated: res.truncated,
					counts: res.counts,
					withoutAction: res.withoutAction,
					agentRunId: res.agentRunId,
					skippedReason: res.skippedReason
				})
			},
			db
		);
		await recomputeRunStatus(run.id, db);
		report(res);
	} catch (err) {
		const e = normalizeError(err);
		await recordStep(
			{
				runId: run.id,
				stepType: STEP_TYPE,
				status: 'failed',
				startedAt,
				finishedAt: toDbTimestamp(),
				durationMs: Date.now() - t0,
				errorCode: e.code,
				errorMessage: e.message
			},
			db
		);
		await recomputeRunStatus(run.id, db);
		throw err;
	}
}

function report(res: Awaited<ReturnType<typeof runFindingProposer>>): void {
	if (res.skippedReason) {
		console.log(`  ⏭  ${res.skippedReason}`);
		return;
	}

	console.log(
		`  ${res.findingsRead} finding(s) actif(s) lu(s) · seuils : priorité ≥ ` +
			`${res.config.minPriority}, plafond ${res.config.maxProposals} proposition(s)/run`
	);
	if (res.excludedByStatus > 0 || res.excludedByPriority > 0) {
		console.log(
			`  écartés : ${res.excludedByStatus} par statut (veille/dismiss/résolu) · ` +
				`${res.excludedByPriority} sous le seuil de priorité`
		);
	}
	// Jamais de troncature silencieuse : un plafond atteint se dit, avec le total réel.
	if (res.truncated) {
		console.log(
			`  ⚠ ${res.totalMatched} finding(s) éligibles, plafond maxProposals=` +
				`${res.config.maxProposals} → les moins prioritaires attendront le prochain run.`
		);
	}
	if (res.withoutAction > 0) {
		console.log(
			`  ${res.withoutAction} finding(s) retenu(s) SANS action dérivable ` +
				`(type sans correspondance, ou cible/position absente des preuves).`
		);
	}

	if (res.proposals.length === 0) {
		console.log('  aucune proposition.');
		return;
	}

	console.log(`\n  ${res.proposals.length} proposition(s) :`);
	for (const p of res.proposals.slice(0, LIMIT)) {
		console.log(
			`   • [${p.approvalLevel}] ${p.actionType.padEnd(16)} risque ${p.riskLevel.padEnd(6)} ` +
				`→ ${p.target ?? '(sans cible)'}`
		);
		console.log(`     ${p.findingTitle}`);
		console.log(`     ${p.selectionReason}`);
		console.log(`     impact : ${p.expectedImpact}`);
		if (p.superseded.length > 0) {
			console.log(`     ↩ ${p.superseded.length} proposition(s) périmée(s) par celle-ci.`);
		}
		// Une approbation devenue obsolète ne se répare pas toute seule : elle se DIT.
		if (p.staleApproved.length > 0) {
			console.log(
				`     ⚠ ${p.staleApproved.length} approbation(s) APPROUVÉE(S) sur un payload ` +
					`périmé — laissée(s) intacte(s), à trancher par un humain : ${p.staleApproved.join(', ')}`
			);
		}
		console.log(
			`     approbation : ${p.autoApproved ? 'AUTO' : 'humaine requise'} — ${p.autoApprovalReason}`
		);
	}
	if (res.proposals.length > LIMIT) {
		console.log(`   … ${res.proposals.length - LIMIT} de plus (--limit=${LIMIT}).`);
	}

	if (res.dryRun) {
		console.log(`\n  DRY-RUN : aucune proposition écrite (relancer avec --execute).`);
	} else {
		const c = res.counts;
		console.log(
			`\n  écrites : ${c.created} nouvelle(s) · ${c.refreshed} rafraîchie(s) · ` +
				`${c.superseded} périmée(s) · ${c.autoApproved} auto-approuvée(s)` +
				(res.agentRunId ? ` · agent_run ${res.agentRunId}` : '')
		);
	}
}

async function main() {
	console.log(
		`\n=== ${PROPOSER_VERSION} — ${EXECUTE ? 'ÉCRITURE RÉELLE' : 'DRY-RUN'} — réf. ${NOW} ===`
	);
	if (!EXECUTE) {
		console.log(`(dry-run par défaut : ajouter --execute pour écrire)`);
	}

	const projects = await resolveProjects();
	if (projects.length === 0) {
		console.log('Aucun projet.');
		await pool.end();
		return;
	}

	for (const p of projects) {
		await proposeForProject(p);
	}

	console.log('');
	await pool.end();
}

main().catch(async (err) => {
	console.error('Production de propositions échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
