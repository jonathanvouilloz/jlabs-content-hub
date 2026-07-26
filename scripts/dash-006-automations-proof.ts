/**
 * DASH-006 — Preuve de la vue automatisations (sur Neon).
 *
 * Les règles de verdict sont couvertes par vitest (`automations-state.test.ts`,
 * 25 tests, sans base ni horloge). Ce qui ne peut PAS s'y prouver, et se prouve
 * ici, c'est ce que fait la BASE :
 *
 *   A. le calendrier croise bien le créneau CALCULÉ et le run OBSERVÉ : pour
 *      chaque cadence suivie, le verdict rendu correspond à l'existence réelle
 *      d'une ligne `monitoring_runs` sur (project_id, run_type, period_end) —
 *      vérifiée par une requête indépendante ;
 *   B. **le point du lot, en contre-épreuve** : sur le MÊME créneau, insérer un
 *      run `failed` fait passer la planification à `ok` tout en affichant l'échec.
 *      Le retirer la fait retomber en `missed`. C'est la seule façon de montrer
 *      que les deux axes ne se confondent pas : un run raté n'est pas un créneau
 *      manqué, et un créneau manqué n'est pas un run raté ;
 *   C. les steps rendus sont réduits à la DERNIÈRE tentative de chaque
 *      `step_type` (un step échoué puis réussi ne se lit pas comme un demi-échec) ;
 *   D. le compteur « runs de la période » de l'accueil ouvre une liste qui rend
 *      EXACTEMENT le nombre annoncé — on part de l'URL, pas du calcul ;
 *   E. `/jobs?run=<id>` rend exactement les jobs de ce run.
 *
 * Isolation. Un seul objet créé, nommable et supprimable : un run sentinelle
 * d'`idempotency_key` préfixée `__test_dash006:` et ses steps. AUCUN projet, aucun
 * job. Nettoyage ENFANTS D'ABORD dans un `finally` : monitoring_steps →
 * monitoring_runs. Un Ctrl-C SAUTE ce nettoyage : chercher alors les
 * `monitoring_runs` dont `idempotency_key LIKE '__test_dash006:%'`.
 *
 * Lancer : npx tsx scripts/dash-006-automations-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { countRuns, listRuns, loadCadenceRows } from '../src/lib/server/automations.js';
import {
	lastDueOccurrence,
	normalizeAutomationFilters
} from '../src/lib/server/automations-state.js';
import { loadProjectScheduleConfig } from '../src/lib/server/scheduler.js';
import { loadHomeCockpit } from '../src/lib/server/home.js';
import { countJobs } from '../src/lib/server/jobs-claim.js';
import { BUSINESS_TIMEZONE, catalogFor } from '../src/lib/server/schedule-state.js';
import { createId } from '../src/lib/server/utils.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

let failures = 0;
let skipped = 0;

function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}
/** Ce qui n'a PAS pu être prouvé faute de donnée. Nommé, jamais compté comme un succès. */
function skip(label: string, why: string): void {
	console.log(`  ⏭️  ${label} — NON PROUVÉ : ${why}`);
	skipped += 1;
}
function section(title: string): void {
	console.log('');
	console.log(title);
}

const SENTINEL_KEY_PREFIX = '__test_dash006:';

async function cleanup(): Promise<void> {
	// ENFANTS D'ABORD : les steps référencent le run.
	await db.execute(sql`
		DELETE FROM "seostats"."monitoring_steps"
		 WHERE run_id IN (
			SELECT id FROM "seostats"."monitoring_runs"
			 WHERE idempotency_key LIKE ${SENTINEL_KEY_PREFIX + '%'}
		 )
	`);
	await db.execute(sql`
		DELETE FROM "seostats"."monitoring_runs"
		 WHERE idempotency_key LIKE ${SENTINEL_KEY_PREFIX + '%'}
	`);
}

async function main(): Promise<void> {
	const now = new Date();
	console.log(`DASH-006 — preuve automatisations · ${now.toISOString()} · TZ ${BUSINESS_TIMEZONE}`);

	// ── A. Le calendrier dit la vérité de la base ────────────────────
	section('A. Créneau calculé ↔ run observé');

	const rows = await loadCadenceRows({ db, now });
	const tracked = rows.filter((r) => r.wired && r.spec.enabled);
	check('des cadences suivies existent', tracked.length > 0, `${tracked.length} lignes`);

	let mismatches = 0;
	for (const row of tracked) {
		if (!row.lastDueSlot) continue;
		const res = await db.execute(sql`
			SELECT count(*)::int AS n
			  FROM "seostats"."monitoring_runs"
			 WHERE project_id = ${row.projectId}
			   AND run_type = ${row.cadence}
			   AND period_end = ${row.lastDueSlot}
		`);
		const inBase = Number((res.rows?.[0] as { n: number }).n) > 0;
		const rendered = row.lastRun !== null;
		if (inBase !== rendered) {
			mismatches += 1;
			console.log(
				`     ↳ ${row.projectSlug}/${row.cadence} @ ${row.lastDueSlot} : base=${inBase} rendu=${rendered}`
			);
		}
		// L'invariant qui porte l'écran : pas de run ⇒ jamais « à l'heure ».
		if (!inBase && row.verdict.health === 'ok') {
			mismatches += 1;
			console.log(`     ↳ ${row.projectSlug}/${row.cadence} : ok SANS run en base`);
		}
	}
	check(
		'chaque verdict correspond à une requête indépendante sur monitoring_runs',
		mismatches === 0,
		`${mismatches} écart(s)`
	);

	const missed = tracked.filter((r) => r.verdict.health === 'missed');
	const late = tracked.filter((r) => r.verdict.health === 'late');
	console.log(
		`     état réel : ${tracked.length - missed.length - late.length} à l'heure · ` +
			`${late.length} en retard · ${missed.length} manqué(s) hors fenêtre`
	);
	for (const row of missed) {
		console.log(`     ↳ MANQUÉ ${row.projectSlug}/${row.cadence} @ ${row.lastDueSlot}`);
	}

	// ── B. Les deux axes ne se confondent pas ────────────────────────
	section('B. Un run ÉCHOUÉ n’est pas un créneau MANQUÉ (contre-épreuve)');

	// Cible : une cadence câblée d'un projet réel dont le dernier créneau dû n'a
	// PAS de run — pour pouvoir en poser un et mesurer la différence.
	const target = tracked.find((r) => r.lastRun === null && r.lastDueSlot !== null);

	if (!target) {
		skip(
			'contre-épreuve run failed / créneau manqué',
			'aucune cadence suivie sans run sur son dernier créneau — la base est à jour'
		);
	} else {
		const config = await loadProjectScheduleConfig(db, target.projectId);
		const due = lastDueOccurrence({
			cadence: target.cadence,
			spec: config[target.cadence],
			now,
			timeZone: BUSINESS_TIMEZONE
		});
		check(
			'le créneau visé est le même que celui rendu par la page',
			due?.localSlot === target.lastDueSlot,
			`${due?.localSlot} vs ${target.lastDueSlot}`
		);

		const before = target.verdict.health;
		check(
			'sans run, la planification est en défaut (late ou missed)',
			before === 'missed' || before === 'late',
			`${target.projectSlug}/${target.cadence} = ${before}`
		);

		const runId = createId();
		await db.execute(sql`
			INSERT INTO "seostats"."monitoring_runs"
				(id, project_id, run_type, period_end, status, idempotency_key, triggered_by, finished_at)
			VALUES (${runId}, ${target.projectId}, ${target.cadence}, ${target.lastDueSlot},
			        'failed', ${SENTINEL_KEY_PREFIX + runId}, 'schedule', ${'2026-01-01 00:00:00'})
		`);

		const after = (await loadCadenceRows({ db, now })).find(
			(r) => r.projectId === target.projectId && r.cadence === target.cadence
		);
		check(
			'le créneau tiré passe la PLANIFICATION à ok — même avec un run échoué',
			after?.verdict.health === 'ok',
			`health=${after?.verdict.health}`
		);
		check(
			'…et l’échec reste visible sur l’axe EXÉCUTION, non fusionné',
			after?.lastRun?.status === 'failed',
			`lastRun=${after?.lastRun?.status}`
		);

		// ── C. Réduction des steps à la dernière tentative ────────────
		section('C. Les steps rendus sont la DERNIÈRE tentative de chaque step_type');

		for (const [attempt, status] of [
			[1, 'failed'],
			[2, 'success']
		] as const) {
			await db.execute(sql`
				INSERT INTO "seostats"."monitoring_steps"
					(id, run_id, step_type, status, attempt)
				VALUES (${createId()}, ${runId}, ${'__test_step'}, ${status}, ${attempt})
			`);
		}

		const listed = await listRuns({
			db,
			filters: normalizeAutomationFilters({ project: target.projectSlug, limit: '200' })
		});
		const sentinel = listed.find((r) => r.id === runId);
		const steps = sentinel?.steps.filter((s) => s.stepType === '__test_step') ?? [];
		check('une seule ligne par step_type', steps.length === 1, `${steps.length} ligne(s)`);
		check(
			'c’est la tentative 2 (réussie), pas la tentative 1 (échouée)',
			steps[0]?.attempt === 2 && steps[0]?.status === 'success',
			`attempt=${steps[0]?.attempt} status=${steps[0]?.status}`
		);

		// Retrait du run sentinelle : la planification doit RETOMBER en défaut.
		await cleanup();
		const restored = (await loadCadenceRows({ db, now })).find(
			(r) => r.projectId === target.projectId && r.cadence === target.cadence
		);
		check(
			'le run retiré, la planification retombe exactement dans son état d’avant',
			restored?.verdict.health === before,
			`${restored?.verdict.health} (attendu ${before})`
		);
	}

	// ── D. Le compteur de l'accueil ouvre SA liste ───────────────────
	section('D. « runs de la période » (accueil) ouvre une liste qui rend le même nombre');

	const cockpit = await loadHomeCockpit({ db, now });
	if (cockpit.runCounters.length === 0) {
		skip('replay du compteur runs_period', 'aucun run sur la période de l’accueil');
	} else {
		for (const counter of cockpit.runCounters) {
			if (!counter.href) {
				check(`compteur « ${counter.label} » sans lien`, false, 'DASH-006 devait lui en donner un');
				continue;
			}
			// On part de l'URL — ce que l'utilisateur ouvrira réellement — et on la
			// relit avec le normaliseur de la page, pas avec le calcul du compteur.
			const url = new URL(counter.href, 'https://x');
			const replayed = await countRuns({
				db,
				filters: normalizeAutomationFilters({
					project: url.searchParams.get('project'),
					status: url.searchParams.get('status'),
					since: url.searchParams.get('since'),
					cadence: url.searchParams.get('cadence')
				})
			});
			check(
				`« ${counter.count} ${counter.label} » ouvre ${replayed} ligne(s)`,
				replayed === counter.count,
				url.pathname + url.search
			);
		}
	}

	// ── E. /jobs?run= rend les jobs de CE run ────────────────────────
	section('E. `/jobs?run=<id>` rend exactement les jobs du run');

	const withJobs = await db.execute(sql`
		SELECT run_id, count(*)::int AS n
		  FROM "seostats"."jobs"
		 WHERE run_id IS NOT NULL
		 GROUP BY run_id
		 ORDER BY n DESC
		 LIMIT 1
	`);
	const top = (withJobs.rows ?? [])[0] as unknown as { run_id: string; n: number } | undefined;

	if (!top) {
		skip('filtre `run` de la console jobs', 'aucun job ne porte de run_id en base');
	} else {
		const filtered = await countJobs({ db, runId: top.run_id });
		check(
			`le run ${top.run_id} porte ${top.n} job(s), le filtre en rend ${filtered}`,
			filtered === top.n
		);
		const unfiltered = await countJobs({ db });
		check(
			'…et le filtre restreint réellement (il ne rend pas toute la file)',
			filtered <= unfiltered,
			`${filtered} ≤ ${unfiltered}`
		);
	}
}

try {
	await main();
} catch (err) {
	failures += 1;
	console.error('\n❌ Exception :', err);
} finally {
	await cleanup();
	await pool.end();
}

console.log('');
console.log(
	failures === 0
		? `✅ DASH-006 — toutes les assertions passent${skipped > 0 ? ` (${skipped} non prouvée(s), voir ci-dessus)` : ''}`
		: `❌ DASH-006 — ${failures} échec(s)`
);
process.exit(failures === 0 ? 0 : 1);
