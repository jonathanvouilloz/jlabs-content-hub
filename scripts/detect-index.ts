/**
 * IDX-005 — Runner du détecteur de transitions d'indexation.
 *
 * Lit `index_observations` (peuplées par `collect:url_inspection`, IDX-002) et écrit de vrais
 * findings (`index_drop`, `crawled_not_indexed`, `discovered_not_indexed`). Additif et idempotent :
 * l'upsert vise l'unique `(project_id, fingerprint)` → rejouer la même fenêtre n'ajoute jamais un
 * doublon, il incrémente `occurrence_count`.
 *
 * ⚠️ **Tant qu'IDX-004 n'existe pas, ce runner ne trouvera à peu près rien** : l'inspection n'est
 * pas planifiée, donc la table est quasi vide. Ce n'est pas une panne — et le runner le DIT
 * (`skippedReason`) plutôt que d'afficher un silence qu'on lirait comme « tout va bien ».
 *
 * Pattern runner (cf. detect.ts / backfill-observations.ts) : Pool propre + drizzle autonome,
 * injecté dans les modules serveur (qui acceptent un client). Toute la logique métier vit dans le
 * module PUR src/lib/server/detectors/index-transition-state.ts (vitest).
 *
 * Lancer (à blanc) : npx tsx scripts/detect-index.ts --project=<slug> --dry-run
 * Lancer (réel)    : npx tsx scripts/detect-index.ts --project=<slug>
 * Tous les projets : npx tsx scripts/detect-index.ts --project=all
 * Options          : --lookback=90  --limit=20  --now=YYYY-MM-DD
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { eq, inArray } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	runIndexTransitionDetector,
	listProjectsWithIndexObservations
} from '../src/lib/server/detectors/index-transition.js';
import { DETECTOR_INDEX_TRANSITION } from '../src/lib/server/detectors/index-transition-state.js';
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
const LOOKBACK = Number(arg('lookback') ?? 90);
const LIMIT = Number(arg('limit') ?? 20);
const NOW = arg('now') ?? new Date().toISOString().slice(0, 10);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

/** `detect:<detector>` — le step_type qui identifie ce détecteur dans un run. */
const STEP_TYPE = `detect:${DETECTOR_INDEX_TRANSITION.split('@')[0]}`;

async function resolveProjects(): Promise<{ id: string; slug: string; name: string }[]> {
	if (PROJECT !== 'all') {
		const rows = await db
			.select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name })
			.from(schema.projects)
			.where(eq(schema.projects.slug, PROJECT));
		if (rows.length === 0) throw new Error(`Projet "${PROJECT}" introuvable.`);
		return rows;
	}
	// --project=all : uniquement ceux qui ont des observations d'indexation (inutile d'ouvrir un
	// run pour un projet que l'inspection n'a jamais visité).
	const withObs = await listProjectsWithIndexObservations(db);
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

async function detectProject(project: { id: string; slug: string; name: string }): Promise<void> {
	console.log(`\n── ${project.name} (${project.slug}) ─────────────────────────`);

	// Dry-run : aucune écriture, pas même le run d'orchestration.
	if (DRY_RUN) {
		report(
			await runIndexTransitionDetector({
				db,
				projectId: project.id,
				lookbackDays: LOOKBACK,
				now: NOW,
				dryRun: true
			})
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
		const res = await runIndexTransitionDetector({
			db,
			projectId: project.id,
			lookbackDays: LOOKBACK,
			now: NOW,
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
					urlsExamined: res.urlsExamined,
					counts: res.counts,
					pending: res.pending,
					notifiable: res.notifiable,
					lifecycle: res.lifecycle,
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

function report(res: Awaited<ReturnType<typeof runIndexTransitionDetector>>): void {
	if (res.skippedReason) {
		console.log(`  ⏭  ${res.skippedReason}`);
		reportLifecycle(res);
		return;
	}
	const w = res.window!;
	console.log(
		`  fenêtre ${w.since} → ${w.now} (${res.config.lookbackDays} j) · ` +
			`${res.observationsRead} observations · ${res.urlsExamined} URL(s) suivie(s)`
	);
	console.log(
		`  règles : confirmation après ${res.config.confirmAfterObservations} observations ` +
			`consécutives · page stratégique ≥ ${res.config.strategicMinClicks} clics` +
			(res.config.strategicPages.length
				? ` ou déclarée (${res.config.strategicPages.length})`
				: '') +
			` → ${res.strategicUrls} stratégique(s) parmi les URLs suivies`
	);
	// Jamais de troncature silencieuse : un plafond atteint se dit.
	if (res.truncated) {
		console.log(
			`  ⚠ ${res.totalMatched} URL(s) en problème, plafond maxCandidates=` +
				`${res.config.maxCandidates} → ${res.transitions.length} retenues.`
		);
	}

	if (res.transitions.length === 0) {
		console.log('  aucun finding (aucune URL suivie n’est en défaut d’indexation).');
		reportLifecycle(res);
		return;
	}

	console.log(`\n  ${res.transitions.length} transition(s) :`);
	for (const t of res.transitions.slice(0, LIMIT)) {
		console.log(
			`   • [${t.severity.padEnd(8)}] score ${String(t.priorityScore).padStart(3)} ` +
				`conf ${String(t.confidenceScore).padStart(3)} | ${t.type}` +
				(t.status === 'pending' ? `  (EN ATTENTE ${t.streak}/${t.required})` : '') +
				(t.notifyImmediately ? '  🔔 notifiable §14.3' : '')
		);
		console.log(
			`     ${t.url}\n     ${t.previousClass ?? 'aucun état antérieur'} → « ${t.coverageState ?? '?'} »` +
				(t.strategic ? ` · stratégique (${t.strategicReason}, ${t.clicks} clics)` : '') +
				(t.outcome ? ` · ${t.outcome}` : '')
		);
	}
	if (res.transitions.length > LIMIT) {
		console.log(`   … ${res.transitions.length - LIMIT} de plus (--limit=${LIMIT}).`);
	}

	if (res.dryRun) {
		console.log(`\n  DRY-RUN : aucun finding écrit.`);
	} else {
		const c = res.counts;
		console.log(
			`\n  écrits : ${c.created} créés · ${c.refreshed} rafraîchis · ` +
				`${c.aggravated} aggravés · ${c.improved} améliorés` +
				` · ${res.pending} en attente de confirmation · ${res.notifiable} notifiable(s)`
		);
	}
	reportLifecycle(res);
}

/**
 * Cycle de vie (FIND-003). Deux choses se disent ici et nulle part ailleurs : une réconciliation
 * SAUTÉE (sans elle, un finding qui a cessé de matcher reste ouvert et l'inbox ment), et le
 * HORS-PORTÉE — les findings d'indexation qu'aucune inspection de ce run n'a couverts. Le second
 * est le compteur qui empêche de lire « rien n'a bougé » là où on n'a rien regardé.
 */
function reportLifecycle(res: Awaited<ReturnType<typeof runIndexTransitionDetector>>): void {
	const l = res.lifecycle;
	if (l.snoozeExpired > 0) {
		console.log(`  ⏰ ${l.snoozeExpired} veille(s) échue(s) → findings réveillés.`);
	}
	if (!l.reconciled) {
		console.log(
			`  ⚠ cycle de vie NON réconcilié (${res.dryRun ? 'dry-run' : 'aucune observation'}) : ` +
				`aucune auto-résolution, aucune réouverture` +
				(l.closureSize > 0 ? ` (closure qui aurait servi : ${l.closureSize} signaux)` : '') +
				`.`
		);
		return;
	}
	console.log(
		`  cycle de vie : ${l.autoResolved} auto-résolu(s) · ${l.reopened} rouvert(s) · ` +
			`${l.missed} absent(s) sous le seuil · ${l.held} maintenu(s) (veille/dismiss) ` +
			`· closure ${l.closureSize} · portée ${l.scopeSize} URL(s)`
	);
	if (l.outOfScope > 0) {
		console.log(
			`  ℹ ${l.outOfScope} finding(s) HORS PORTÉE de ce run : aucune inspection ne les a ` +
				`couverts, donc rien n'a été conclu à leur sujet (ni absence, ni guérison).`
		);
	}
}

async function main() {
	console.log(
		`\n=== ${DETECTOR_INDEX_TRANSITION} — ${DRY_RUN ? 'DRY-RUN' : 'ÉCRITURE RÉELLE'} — ` +
			`réf. ${NOW} · fenêtre ${LOOKBACK} jours ===`
	);

	const projects = await resolveProjects();
	if (projects.length === 0) {
		console.log(
			'Aucun projet avec des observations d’indexation. ' +
				'C’est attendu tant qu’IDX-004 ne planifie pas `collect:url_inspection`.'
		);
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
	console.error('Détection d’indexation échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
