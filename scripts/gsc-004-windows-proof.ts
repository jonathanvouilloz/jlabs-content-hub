/**
 * GSC-004 — Preuve des fenêtres de comparaison + backfill (sur Neon).
 *
 * Les règles de découpe/gate/complétude sont couvertes par vitest
 * (`gsc-windows-state.test.ts`, `gsc-settings.test.ts`). Ce qui ne peut PAS se prouver
 * en vitest, et se prouve ici, c'est ce que fait la BASE :
 *
 *   1. `computeWindowedComparison` lit le canon et rend courante/précédente/delta
 *      justes — et REFUSE le delta quand la fenêtre précédente est incomplète
 *      (acceptation « aucun delta entre longueurs incompatibles ») ;
 *   2. la complétude est dérivée contre la dernière semaine complète (fraîcheur) ;
 *   3. la latence GSC est configurable en base (system_settings) et relue ;
 *   4. `enqueueGscBackfill` n'enfile que les semaines ABSENTES, est idempotent, et
 *      AVANCE quand une semaine devient présente (reprise dérivée, sans checkpoint) ;
 *   5. le backfill ne dépasse jamais la dernière semaine complète.
 *
 * Isolation. Tout s'exerce sur des SEMAINES SENTINELLES de 2018-2019 (la plus ancienne
 * semaine réelle est de 2026) sous un vrai projet (FK). Nettoyage ENFANTS D'ABORD dans
 * un `finally` : observations sentinelles → jobs de backfill sentinelles → clé
 * system_settings. Un Ctrl-C SAUTE ce nettoyage : vérifier les semaines 2018-2019 et
 * la clé `gsc.latency_days` après toute interruption.
 *
 * Lancer : npx tsx scripts/gsc-004-windows-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { and, eq, sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { upsertGscQueryPageObservations } from '../src/lib/server/observations.js';
import {
	computeWindowedComparison,
	loadAvailableWeeks,
	loadGscWindows,
	enqueueGscBackfill,
	backfillIdempotencyKey
} from '../src/lib/server/gsc-windows.js';
import {
	loadGscLatencyDays,
	saveGscLatencyDays,
	GSC_LATENCY_KEY
} from '../src/lib/server/gsc-settings.js';
import { weekEndOf, addDaysIso } from '../src/lib/server/collectors/gsc-collector-state.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}
function section(title: string): void {
	console.log('');
	console.log(title);
}

// 8 lundis sentinelles consécutifs, le plus récent en dernier.
const SEEDED: string[] = (() => {
	const out: string[] = [];
	let w = '2018-11-19';
	for (let i = 0; i < 8; i++) {
		out.push(w);
		w = addDaysIso(w, 7);
	}
	return out; // 2018-11-19 … 2019-01-07
})();
const LATEST_SEEDED = SEEDED[SEEDED.length - 1]; // 2019-01-07
const SENTINEL_PREFIX_A = '2018-';
const SENTINEL_PREFIX_B = '2019-01-07';

/** Deux lignes par semaine ; la plus récente est DOUBLÉE pour un delta non trivial. */
function seedRows(projectId: string, week: string) {
	const factor = week === LATEST_SEEDED ? 2 : 1;
	return [
		{
			projectId,
			periodStart: week,
			periodEnd: weekEndOf(week),
			query: 'sentinelle-q1',
			page: 'https://sentinelle/p1',
			device: 'DESKTOP',
			clicks: 10 * factor,
			impressions: 100 * factor,
			position: 5
		},
		{
			projectId,
			periodStart: week,
			periodEnd: weekEndOf(week),
			query: 'sentinelle-q2',
			page: 'https://sentinelle/p2',
			device: 'DESKTOP',
			clicks: 2 * factor,
			impressions: 400 * factor,
			position: 15
		}
	];
}

async function countSentinelObs(projectId: string): Promise<number> {
	const res = await db.execute(sql`
		SELECT count(*)::int AS n FROM "seostats"."gsc_query_page_observations"
		 WHERE project_id = ${projectId}
		   AND (period_start LIKE ${SENTINEL_PREFIX_A + '%'} OR period_start = ${SENTINEL_PREFIX_B})
	`);
	return Number((res.rows?.[0] as { n: number }).n);
}

async function countSentinelJobs(projectId: string): Promise<number> {
	const res = await db.execute(sql`
		SELECT count(*)::int AS n FROM "seostats"."jobs"
		 WHERE project_id = ${projectId}
		   AND idempotency_key LIKE ${'backfill:collect:gsc_query_page:%'}
	`);
	return Number((res.rows?.[0] as { n: number }).n);
}

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(q);
	return Number((res.rows?.[0] as { n: number }).n);
}

async function cleanup(projectId: string): Promise<void> {
	await db.execute(sql`
		DELETE FROM "seostats"."gsc_query_page_observations"
		 WHERE project_id = ${projectId}
		   AND (period_start LIKE ${SENTINEL_PREFIX_A + '%'} OR period_start = ${SENTINEL_PREFIX_B})
	`);
	await db.execute(sql`
		DELETE FROM "seostats"."jobs"
		 WHERE project_id = ${projectId}
		   AND idempotency_key LIKE ${'backfill:collect:gsc_query_page:%'}
	`);
	await db.execute(sql`DELETE FROM "seostats"."system_settings" WHERE key = ${GSC_LATENCY_KEY}`);
}

async function main(): Promise<void> {
	// Projet réel pour la FK — n'importe lequel fait l'affaire.
	const projRes = await db.execute(sql`SELECT id, slug FROM "seostats"."projects" ORDER BY slug LIMIT 1`);
	const proj = projRes.rows?.[0] as { id: string; slug: string } | undefined;
	if (!proj) {
		console.error('Aucun projet en base. Abandon.');
		process.exitCode = 1;
		return;
	}
	console.log(`Projet sentinelle : ${proj.slug} (${proj.id})`);

	// Baselines à rendre à l'identique.
	const baseObs = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."gsc_query_page_observations"`);
	const baseJobs = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."jobs"`);
	const baseFindings = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`);
	const baseProposals = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."action_proposals"`);

	try {
		// Filet : purge d'un run précédent interrompu.
		await cleanup(proj.id);

		// ── A. Seed ──────────────────────────────────────────────────
		section('A. Seed des semaines sentinelles');
		for (const week of SEEDED) {
			await upsertGscQueryPageObservations(seedRows(proj.id, week), db);
		}
		const seededCount = await countSentinelObs(proj.id);
		check('16 observations sentinelles écrites (8 semaines × 2)', seededCount === 16, `${seededCount}`);
		const available = await loadAvailableWeeks(db, proj.id);
		const sentinelWeeks = available.filter(
			(w) => w.periodStart.startsWith('2018-') || w.periodStart === '2019-01-07'
		);
		check('8 semaines sentinelles distinctes lues', sentinelWeeks.length === 8, `${sentinelWeeks.length}`);

		const latestEnd = weekEndOf(LATEST_SEEDED); // 2019-01-13

		// ── B. Comparaison + gate ────────────────────────────────────
		section('B. Comparaison de fenêtres et gate de comparabilité');

		// span 7 = 1 semaine : courante (01-07, doublée) vs précédente (12-31).
		const w7 = await computeWindowedComparison({
			db,
			projectId: proj.id,
			span: 7,
			availableWeeks: sentinelWeeks,
			latestCompleteWeekEnd: latestEnd
		});
		check('span 7 comparable', w7.comparable, `comparable=${w7.comparable}`);
		check(
			'span 7 courante = 24 clics / 1000 impr (semaine doublée)',
			w7.current?.clicks === 24 && w7.current?.impressions === 1000,
			`${w7.current?.clicks}/${w7.current?.impressions}`
		);
		check(
			'span 7 précédente = 12 clics / 500 impr',
			w7.prior?.clicks === 12 && w7.prior?.impressions === 500,
			`${w7.prior?.clicks}/${w7.prior?.impressions}`
		);
		check(
			'span 7 delta clics = +12 (+100 %)',
			w7.delta.available && w7.delta.clicks.abs === 12 && w7.delta.clicks.pct === 100,
			w7.delta.available ? `abs=${w7.delta.clicks.abs} pct=${w7.delta.clicks.pct}` : 'indisponible'
		);

		// span 28 = 4 semaines : courante (4 récentes) vs précédente (4 d'avant) → comparable.
		const w28 = await computeWindowedComparison({
			db,
			projectId: proj.id,
			span: 28,
			availableWeeks: sentinelWeeks,
			latestCompleteWeekEnd: latestEnd
		});
		check(
			'span 28 courante = 60 clics / 2500 impr',
			w28.current?.clicks === 60 && w28.current?.impressions === 2500,
			`${w28.current?.clicks}/${w28.current?.impressions}`
		);
		check(
			'span 28 précédente = 48 clics / 2000 impr',
			w28.prior?.clicks === 48 && w28.prior?.impressions === 2000,
			`${w28.prior?.clicks}/${w28.prior?.impressions}`
		);
		check('span 28 delta clics = +12 (+25 %)', w28.delta.available && w28.delta.clicks.pct === 25);
		check('span 28 complète et fraîche', w28.completeness.complete, w28.completeness.caveats.join(' · '));

		// span 90 = 13 semaines : seulement 8 dispo → précédente vide → PAS de delta.
		const w90 = await computeWindowedComparison({
			db,
			projectId: proj.id,
			span: 90,
			availableWeeks: sentinelWeeks,
			latestCompleteWeekEnd: latestEnd
		});
		check(
			'span 90 : historique trop court → non comparable, AUCUN delta',
			!w90.comparable && !w90.delta.available,
			`comparable=${w90.comparable} delta=${w90.delta.available}`
		);
		check(
			'span 90 : fenêtre incomplète signalée (caveat)',
			w90.completeness.caveats.some((c) => c.includes('incomplète')),
			w90.completeness.caveats.join(' · ')
		);

		// Fraîcheur : une dernière semaine complète PLUS RÉCENTE rend la fenêtre « pas à jour ».
		const wStale = await computeWindowedComparison({
			db,
			projectId: proj.id,
			span: 28,
			availableWeeks: sentinelWeeks,
			latestCompleteWeekEnd: '2019-02-01'
		});
		check(
			'fenêtre en retard → pas fraîche + caveat « pas à jour »',
			!wStale.completeness.fresh && wStale.completeness.caveats.some((c) => c.includes('pas à jour')),
			wStale.completeness.caveats.join(' · ')
		);

		// ── C. Rapport complet ───────────────────────────────────────
		section('C. loadGscWindows (rapport complet)');
		const report = await loadGscWindows({ db, projectId: proj.id });
		check('3 fenêtres (7/28/90)', report.windows.length === 3, `${report.windows.length}`);
		check(
			'3 gates YoY bien formés',
			report.yoy.length === 3 && report.yoy.every((y) => typeof y.available === 'boolean'),
			`disponibles: ${report.yoy.filter((y) => y.available).length}`
		);
		check('weeksAvailable ≥ 8 (sentinelles présentes)', report.weeksAvailable >= 8, `${report.weeksAvailable}`);

		// ── D. Latence configurable ──────────────────────────────────
		section('D. Latence GSC configurable (system_settings)');
		const defaultLatency = await loadGscLatencyDays(db);
		check('défaut du code = 3 (aucune clé)', defaultLatency === 3, `${defaultLatency}`);
		await saveGscLatencyDays({ db, days: 7 });
		const reread = await loadGscLatencyDays(db);
		check('après écriture, relu = 7', reread === 7, `${reread}`);
		await db.execute(sql`DELETE FROM "seostats"."system_settings" WHERE key = ${GSC_LATENCY_KEY}`);
		const afterReset = await loadGscLatencyDays(db);
		check('après suppression, retour au défaut = 3', afterReset === 3, `${afterReset}`);

		// ── E. Backfill borné, idempotent, reprise dérivée ───────────
		section('E. Backfill piloté par la file');
		const fromWeek = addDaysIso(SEEDED[0], -4 * 7); // 4 semaines AVANT la première seedée
		const toWeek = LATEST_SEEDED;

		// Dry-run : dérive la plage sans toucher la file.
		const dry = await enqueueGscBackfill({
			db,
			projectId: proj.id,
			fromWeek,
			toWeek,
			maxWeeksPerBatch: 2,
			dryRun: true
		});
		check('dry-run : 12 semaines de plage', dry.targetWeeks.length === 12, `${dry.targetWeeks.length}`);
		check('dry-run : 8 déjà présentes (sautées)', dry.alreadyPresent.length === 8, `${dry.alreadyPresent.length}`);
		check('dry-run : tranche = 2 enfilées, 2 restantes', dry.enqueued.length === 2 && dry.remaining === 2);
		check('dry-run : rien en file', (await countSentinelJobs(proj.id)) === 0);

		// Enfilage réel, tranche de 2.
		const b1 = await enqueueGscBackfill({ db, projectId: proj.id, fromWeek, toWeek, maxWeeksPerBatch: 2 });
		check('réel : 2 jobs créés', b1.enqueued.length === 2 && b1.enqueued.every((e) => e.created), `${b1.enqueued.map((e) => e.weekStart).join(',')}`);
		check('réel : 2 semaines restantes', b1.remaining === 2, `${b1.remaining}`);
		check('réel : exactement 2 jobs en file', (await countSentinelJobs(proj.id)) === 2);

		// Rappel SANS collecte : idempotent, n'avance pas (reprise dérivée des observations).
		const b2 = await enqueueGscBackfill({ db, projectId: proj.id, fromWeek, toWeek, maxWeeksPerBatch: 2 });
		check('rappel : mêmes 2 semaines, created=false (idempotent)', b2.enqueued.length === 2 && b2.enqueued.every((e) => !e.created));
		check('rappel : toujours 2 jobs en file (pas de doublon)', (await countSentinelJobs(proj.id)) === 2);

		// Simule la collecte de la 1re semaine manquante → la reprise AVANCE.
		const firstMissing = b1.enqueued[0].weekStart;
		await upsertGscQueryPageObservations(seedRows(proj.id, firstMissing), db);
		const b3 = await enqueueGscBackfill({ db, projectId: proj.id, fromWeek, toWeek, maxWeeksPerBatch: 2 });
		const advanced = b3.enqueued.some((e) => e.created && e.weekStart !== firstMissing);
		check('après collecte simulée : la reprise avance (nouvelle semaine enfilée)', advanced, `${b3.enqueued.map((e) => `${e.weekStart}:${e.created}`).join(' ')}`);

		// Borne : toWeek au-delà de la dernière complète est ramené (pas de semaine partielle).
		const clamp = await enqueueGscBackfill({
			db,
			projectId: proj.id,
			fromWeek: '2026-07-01',
			toWeek: '2099-01-01',
			dryRun: true
		});
		check(
			'toWeek futur ramené à la dernière semaine complète (pas de dérive 2099)',
			clamp.targetWeeks.every((w) => w < '2030-01-01'),
			`${clamp.targetWeeks.length} sem, max ${clamp.targetWeeks[clamp.targetWeeks.length - 1]}`
		);
	} finally {
		await cleanup(proj.id);
	}

	// ── Base rendue à l'identique ──────────────────────────────────
	section('Invariants : base rendue à l’identique');
	const afterObs = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."gsc_query_page_observations"`);
	const afterJobs = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."jobs"`);
	const afterFindings = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`);
	const afterProposals = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."action_proposals"`);
	check('observations inchangées', afterObs === baseObs, `${baseObs} → ${afterObs}`);
	check('jobs inchangés', afterJobs === baseJobs, `${baseJobs} → ${afterJobs}`);
	check('findings inchangés', afterFindings === baseFindings, `${baseFindings} → ${afterFindings}`);
	check('propositions inchangées', afterProposals === baseProposals, `${baseProposals} → ${afterProposals}`);

	console.log('');
	console.log(failures === 0 ? `✅ Preuve GSC-004 : tout vert.` : `❌ Preuve GSC-004 : ${failures} échec(s).`);
	if (failures > 0) process.exitCode = 1;
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => pool.end());
