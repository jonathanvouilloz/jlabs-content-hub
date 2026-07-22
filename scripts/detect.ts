/**
 * FIND-001/FIND-004 — Runner du détecteur déterministe `keyword_opportunity`.
 *
 * Lit les observations GSC (DATA-004, peuplées par le backfill MIGRATE) et écrit de
 * vrais findings (DATA-005). Additif et idempotent : l'upsert vise l'unique
 * `(project_id, fingerprint)` → rejouer la même fenêtre n'ajoute jamais un doublon,
 * il incrémente `occurrence_count`.
 *
 * Pattern runner (cf. backfill-observations.ts / purge.ts) : Pool propre + drizzle
 * autonome, injecté dans les modules serveur (qui acceptent un client). Toute la
 * logique métier vit dans le module PUR src/lib/server/detector-state.ts (vitest).
 *
 * Lancer (à blanc) : npx tsx scripts/detect.ts --project=<slug> --dry-run
 * Lancer (réel)    : npx tsx scripts/detect.ts --project=<slug>
 * Tous les projets : npx tsx scripts/detect.ts --project=all
 * Options          : --weeks=4  --limit=20  --now=YYYY-MM-DD
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { eq, inArray } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	runKeywordOpportunityDetector,
	listProjectsWithObservations
} from '../src/lib/server/detectors/keyword-opportunity.js';
import { DETECTOR_KEYWORD_OPPORTUNITY } from '../src/lib/server/detector-state.js';
import { createRun, recordStep, recomputeRunStatus } from '../src/lib/server/monitoring.js';
import { deriveIdempotencyKey, normalizeError } from '../src/lib/server/monitoring-state.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const PROJECT = arg('project') ?? 'all';
const WEEKS = Number(arg('weeks') ?? 4);
const LIMIT = Number(arg('limit') ?? 20);
const NOW = arg('now') ?? new Date().toISOString().slice(0, 10);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

/** `detect:<detector>` — le step_type qui identifie ce détecteur dans un run. */
const STEP_TYPE = `detect:${DETECTOR_KEYWORD_OPPORTUNITY.split('@')[0]}`;

async function resolveProjects(): Promise<{ id: string; slug: string; name: string }[]> {
	if (PROJECT !== 'all') {
		const rows = await db
			.select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name })
			.from(schema.projects)
			.where(eq(schema.projects.slug, PROJECT));
		if (rows.length === 0) throw new Error(`Projet "${PROJECT}" introuvable.`);
		return rows;
	}
	// --project=all : uniquement ceux qui ont des observations (inutile d'ouvrir un
	// run pour un projet sans donnée).
	const withObs = await listProjectsWithObservations(db);
	if (withObs.length === 0) return [];
	return db
		.select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name })
		.from(schema.projects)
		.where(
			inArray(
				schema.projects.id,
				withObs.map((p) => p.projectId)
			)
		);
}

function fmtPct(v: number): string {
	return `${(v * 100).toFixed(2)}%`;
}

async function detectProject(project: { id: string; slug: string; name: string }): Promise<void> {
	console.log(`\n── ${project.name} (${project.slug}) ─────────────────────────`);

	// Dry-run : aucune écriture, pas même le run d'orchestration.
	if (DRY_RUN) {
		const res = await runKeywordOpportunityDetector({
			db,
			projectId: project.id,
			weeks: WEEKS,
			dryRun: true
		});
		report(res);
		return;
	}

	// Run + step : traçabilité du détecteur (findings.run_id). La clé d'idempotence
	// rend le rejeu de la même fenêtre inoffensif (un seul run logique).
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
		const res = await runKeywordOpportunityDetector({
			db,
			projectId: project.id,
			weeks: WEEKS,
			runId: run.id
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
					detectorVersion: res.detectorVersion,
					window: res.window,
					observationsRead: res.observationsRead,
					counts: res.counts,
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

function report(res: Awaited<ReturnType<typeof runKeywordOpportunityDetector>>): void {
	if (res.skippedReason) {
		console.log(`  ⏭  ${res.skippedReason}`);
		return;
	}
	const w = res.window!;
	console.log(
		`  fenêtre ${w.start} → ${w.end} (${w.weeks} sem.) · ${res.observationsRead} observations · ` +
			`${res.pairsAggregated} couples query×page`
	);
	console.log(
		`  seuils : ≥${res.thresholds.minImpressions} impressions, position ` +
			`[${res.thresholds.positionMin}, ${res.thresholds.positionMax}], CTR cible ` +
			`${fmtPct(res.thresholds.targetCtr)}` +
			(res.thresholds.excludeQueryPatterns.length
				? ` · bruit exclu : ${res.thresholds.excludeQueryPatterns.join(', ')}`
				: '')
	);
	if (res.excludedByNoise > 0) {
		console.log(`  ${res.excludedByNoise} couple(s) écarté(s) comme bruit configuré.`);
	}
	// Jamais de troncature silencieuse : un plafond atteint se dit.
	if (res.truncated) {
		console.log(
			`  ⚠ ${res.totalMatched} couples franchissent les seuils, plafond ` +
				`maxCandidates=${res.thresholds.maxCandidates} → ${res.opportunities.length} retenus ` +
				`(les moins rentables sont écartés).`
		);
	}

	if (res.opportunities.length === 0) {
		console.log('  aucun finding (aucun couple ne franchit les seuils).');
		return;
	}

	console.log(`\n  ${res.opportunities.length} opportunité(s) :`);
	for (const o of res.opportunities.slice(0, LIMIT)) {
		console.log(
			`   • [${o.severity.padEnd(8)}] score ${String(o.priorityScore).padStart(3)} ` +
				`conf ${String(o.confidenceScore).padStart(3)} | ${o.query}`
		);
		console.log(
			`     ${o.page}\n     ${o.impressions} impr · ${o.clicks} clics · CTR ${fmtPct(o.ctr)} · ` +
				`pos ${o.position.toFixed(1)} · gain ~${o.gainEstimate} clics/sem` +
				(o.outcome ? ` · ${o.outcome}` : '')
		);
	}
	if (res.opportunities.length > LIMIT) {
		console.log(`   … ${res.opportunities.length - LIMIT} de plus (--limit=${LIMIT}).`);
	}

	if (res.dryRun) {
		console.log(`\n  DRY-RUN : aucun finding écrit.`);
	} else {
		const c = res.counts;
		console.log(
			`\n  écrits : ${c.created} créés · ${c.refreshed} rafraîchis · ` +
				`${c.aggravated} aggravés · ${c.improved} améliorés`
		);
	}
}

async function main() {
	console.log(
		`\n=== ${DETECTOR_KEYWORD_OPPORTUNITY} — ${DRY_RUN ? 'DRY-RUN' : 'ÉCRITURE RÉELLE'} — ` +
			`réf. ${NOW} · fenêtre ${WEEKS} semaines ===`
	);

	const projects = await resolveProjects();
	if (projects.length === 0) {
		console.log('Aucun projet avec des observations GSC.');
		await pool.end();
		return;
	}

	for (const p of projects) {
		await detectProject(p);
	}

	console.log('');
	await pool.end();
}

main().catch(async (err) => {
	console.error('Détection échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
