/**
 * GMB-002 lot 2 — Runner du détecteur d'avis sans réponse.
 *
 * Lit `gmb_reviews` et `project_gmb_locations` (peuplées par `collect:gmb_reviews`) et écrit de
 * vrais findings (`review_pending_sla`, `negative_review`). Additif et idempotent : l'upsert vise
 * l'unique `(project_id, fingerprint)` → rejouer n'ajoute jamais un doublon, il incrémente
 * `occurrence_count`.
 *
 * ⚠️ **Le `.env` local pointe la base de PRODUCTION.** Sans `--dry-run`, ce runner écrit dans
 * l'inbox réelle. Sur `barberconcept` (6 fiches, 499 avis en attente), un premier run réel écrit
 * jusqu'à 30 `review_pending_sla` + 30 `negative_review`.
 *
 * Pattern runner (cf. detect-index.ts) : Pool propre + drizzle autonome, injecté dans les modules
 * serveur. Toute la logique métier vit dans le module PUR `review-pending-state.ts` (vitest).
 *
 * Lancer (à blanc) : npx tsx scripts/detect-reviews.ts --project=<slug> --dry-run
 * Lancer (réel)    : npx tsx scripts/detect-reviews.ts --project=<slug>
 * Tous les projets : npx tsx scripts/detect-reviews.ts --project=all
 * Options          : --sla=3  --lookback=180  --limit=20  --now=YYYY-MM-DDTHH:MM:SSZ
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { eq, inArray } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	runReviewPendingDetector,
	listProjectsWithGmbLocations
} from '../src/lib/server/detectors/review-pending.js';
import {
	DETECTOR_REVIEW_PENDING,
	NEGATIVE_REVIEW_TYPE
} from '../src/lib/server/detectors/review-pending-state.js';
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
const LIMIT = Number(arg('limit') ?? 20);
const SLA = arg('sla') ? Number(arg('sla')) : undefined;
const LOOKBACK = arg('lookback') ? Number(arg('lookback')) : undefined;
const NOW = arg('now') ? new Date(arg('now') as string) : new Date();
if (Number.isNaN(NOW.getTime())) {
	console.error(`--now="${arg('now')}" illisible. Abandon.`);
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

/** `detect:<detector>` — le step_type qui identifie ce détecteur dans un run. */
const STEP_TYPE = `detect:${DETECTOR_REVIEW_PENDING.split('@')[0]}`;
const OVERRIDES = { slaDays: SLA, slaLookbackDays: LOOKBACK };

async function resolveProjects(): Promise<{ id: string; slug: string; name: string }[]> {
	if (PROJECT !== 'all') {
		const rows = await db
			.select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name })
			.from(schema.projects)
			.where(eq(schema.projects.slug, PROJECT));
		if (rows.length === 0) throw new Error(`Projet "${PROJECT}" introuvable.`);
		return rows;
	}
	// --project=all : uniquement ceux qui ont une fiche GMB. Ouvrir un run pour les 5 projets qui
	// n'en ont aucune produirait cinq `no_gmb_location` par jour dans `/jobs` sans rien apprendre —
	// c'est le job planifié, pas ce runner manuel, qui doit porter ce constat.
	const withLocations = await listProjectsWithGmbLocations(db);
	if (withLocations.length === 0) return [];
	return db
		.select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name })
		.from(schema.projects)
		.where(
			inArray(
				schema.projects.id,
				withLocations.map((p) => p.projectId)
			)
		);
}

async function detectProject(project: { id: string; slug: string; name: string }): Promise<void> {
	console.log(`\n── ${project.name} (${project.slug}) ─────────────────────────`);

	// Dry-run : aucune écriture, pas même le run d'orchestration.
	if (DRY_RUN) {
		report(
			await runReviewPendingDetector({
				db,
				projectId: project.id,
				now: NOW,
				thresholds: OVERRIDES,
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
				periodEnd: NOW.toISOString().slice(0, 10),
				stepType: STEP_TYPE,
				schemaVersion: 1
			}),
			triggeredBy: 'user',
			periodEnd: NOW.toISOString().slice(0, 10)
		},
		db
	);
	if (!run.created) console.log(`(run existant réutilisé — même clé d'idempotence)`);

	const startedAt = toDbTimestamp();
	const t0 = Date.now();
	try {
		const res = await runReviewPendingDetector({
			db,
			projectId: project.id,
			now: NOW,
			thresholds: OVERRIDES,
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
					reviewsRead: res.reviewsRead,
					locationsFresh: res.locationsFresh,
					locationsStale: res.locationsStale,
					counts: res.counts,
					totalMatchedSla: res.totalMatchedSla,
					totalMatchedNegative: res.totalMatchedNegative,
					notifiable: res.notifiable,
					excluded: res.excluded,
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

function report(res: Awaited<ReturnType<typeof runReviewPendingDetector>>): void {
	if (res.skippedReason) {
		console.log(`  ⏭  ${res.skippedReason}`);
		reportLifecycle(res);
		return;
	}
	const t = res.thresholds;
	// La borne de lecture est dite EXPLICITEMENT : les avis antérieurs ne sont pas « hors
	// fenêtre », ils ne sont pas lus du tout. Sur `barberconcept`, ce sont les ~1 700 avis
	// d'avant la borne — un stock consultable à l'écran, jamais une alerte.
	console.log(
		`  ${res.reviewsRead} avis lus depuis le ${res.window?.since} · fiches : ` +
			`${res.locationsFresh} dans la portée, ${res.locationsStale} hors portée ` +
			`(synchro absente, en erreur ou > ${t.syncFreshnessHours} h)`
	);
	console.log(
		`  règles : SLA ${t.slaDays} j sur ${t.slaLookbackDays} j · négatif ≤ ${t.negativeRatingMax}★ ` +
			`sur ${t.negativeLookbackDays} j · notification ≤ ${t.notifyRatingMax}★ · plafond ` +
			`${t.maxCandidates} par type`
	);
	console.log(
		`  portée : ${res.inScopeSla} avis (SLA) · ${res.inScopeNegative} avis (négatif) · ` +
			`franchissent les seuils : ${res.totalMatchedSla} SLA · ${res.totalMatchedNegative} négatifs`
	);
	// Chaque exclusion est un FAIT, pas un silence. Le hors-fenêtre porte à lui seul les 332 avis
	// d'avant 2025 sur `barberconcept` : ils restent visibles à l'écran, jamais une alerte.
	const e = res.excluded;
	console.log(
		`  écartés : ${e.answered} répondus (dont ${e.divergent} divergents GMB-007) · ` +
			`${e.outOfWindow} hors fenêtre · ${e.staleLocation} sur fiche hors portée · ` +
			`${e.neverSeen} jamais vus chez Google · ${e.vanished} disparus · ` +
			`${e.unreadableRating + e.unreadableCreateTime} illisibles`
	);
	// Jamais de troncature silencieuse : un plafond atteint se dit.
	if (res.truncated) {
		console.log(
			`  ⚠ plafond atteint (maxCandidates=${t.maxCandidates} par type) : le tour d'équité par ` +
				`fiche a réparti les places, et la closure porte TOUT (aucune auto-résolution).`
		);
	}

	if (res.reviews.length === 0) {
		console.log('  aucun finding (aucun avis de la portée ne franchit les seuils).');
		reportLifecycle(res);
		return;
	}

	console.log(`\n  ${res.reviews.length} finding(s) :`);
	for (const r of res.reviews.slice(0, LIMIT)) {
		console.log(
			`   • [${r.severity.padEnd(8)}] score ${String(r.priorityScore).padStart(3)} ` +
				`conf ${String(r.confidenceScore).padStart(3)} | ${r.type}` +
				(r.notifyImmediately ? '  🔔 notifiable §14.3' : '')
		);
		console.log(
			`     ${r.locationLabel} · ${r.rating}★ · ${r.ageDays} j` +
				(r.type !== NEGATIVE_REVIEW_TYPE ? ` (${r.overdueBy} j de retard)` : '') +
				` · ${r.reviewId}` +
				(r.outcome ? ` · ${r.outcome}` : '')
		);
	}
	if (res.reviews.length > LIMIT) {
		console.log(`   … ${res.reviews.length - LIMIT} de plus (--limit=${LIMIT}).`);
	}

	if (res.dryRun) {
		console.log(`\n  DRY-RUN : aucun finding écrit.`);
	} else {
		const c = res.counts;
		console.log(
			`\n  écrits : ${c.created} créés · ${c.refreshed} rafraîchis · ` +
				`${c.aggravated} aggravés · ${c.improved} améliorés · ${res.notifiable} notifiable(s)`
		);
	}
	reportLifecycle(res);
}

/**
 * Cycle de vie (FIND-003). Deux choses se disent ici et nulle part ailleurs : une réconciliation
 * SAUTÉE (sans elle, un finding qui a cessé de matcher reste ouvert et l'inbox ment), et le
 * HORS-PORTÉE — ici il porte DEUX faits attendus et distincts : une fiche dont la synchro est
 * cassée, et un avis sorti de la fenêtre. Aucun des deux n'est une guérison.
 */
function reportLifecycle(res: Awaited<ReturnType<typeof runReviewPendingDetector>>): void {
	const l = res.lifecycle;
	if (l.snoozeExpired > 0) {
		console.log(`  ⏰ ${l.snoozeExpired} veille(s) échue(s) → findings réveillés.`);
	}
	if (!l.reconciled) {
		console.log(
			`  ⚠ cycle de vie NON réconcilié (${res.dryRun ? 'dry-run' : (res.skippedReason ?? 'aucune donnée')}) : ` +
				`aucune auto-résolution, aucune réouverture.`
		);
		return;
	}
	console.log(
		`  cycle de vie : ${l.autoResolved} auto-résolu(s) · ${l.reopened} rouvert(s) · ` +
			`${l.missed} absent(s) sous le seuil · ${l.held} maintenu(s) (veille/dismiss) · ` +
			`closure ${l.closureSla}/${l.closureNegative} · portée ${l.scopeSla}/${l.scopeNegative}`
	);
	if (l.outOfScope > 0) {
		console.log(
			`  ℹ ${l.outOfScope} finding(s) HORS PORTÉE de ce run : sortis de la fenêtre ou sur une ` +
				`fiche dont la synchro n'est pas fiable. Rien n'a été conclu à leur sujet.`
		);
	}
}

async function main() {
	console.log(
		`\n=== ${DETECTOR_REVIEW_PENDING} — ${DRY_RUN ? 'DRY-RUN' : 'ÉCRITURE RÉELLE'} — ` +
			`réf. ${NOW.toISOString()} ===`
	);

	const projects = await resolveProjects();
	if (projects.length === 0) {
		console.log('Aucun projet avec une fiche Google Business déclarée.');
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
	console.error('Détection des avis échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
