/**
 * JOB-005 — Preuve du scheduler (sur Neon).
 *
 * Les règles de calendrier sont couvertes par `src/lib/server/schedule-state.test.ts`
 * (38 tests, dont les deux bascules DST). Ce qui ne peut PAS se prouver en vitest,
 * et qui se prouve ici, c'est ce que fait la base :
 *
 *   1. « un restart à 09:00 ne crée qu'un run logique » — deux planifications du
 *      MÊME créneau ne produisent qu'un run et qu'un job, parce que la clé
 *      d'idempotence porte le créneau LOCAL et que l'unique index la fait respecter ;
 *   2. « les deux changements DST » côté données — le même créneau métier
 *      (lundi 09:00) s'écrit à 08:00 UTC en hiver et 07:00 UTC en été, tout en
 *      gardant la MÊME clé logique ;
 *   3. « la prochaine exécution est visible par projet » — `listNextOccurrences`
 *      rend une ligne par projet et par cadence, sans lire aucun état persisté ;
 *   + la chaîne complète : planifier → réclamer → exécuter → `succeeded`.
 *
 * Le catalogue est SUBSTITUÉ par un type `__test_schedule` : la preuve ne doit pas
 * déclencher une vraie détection sur les données de production (barberconcept
 * écrirait 50 findings d'un coup). Nettoyage ENFANTS D'ABORD dans un `finally`
 * (`job_attempts` → `job_effects` → `jobs` → `monitoring_runs` : `jobs.run_id`
 * référence le run, l'ordre inverse violerait la FK).
 *
 * Lancer : npx tsx scripts/job-005-schedule-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { listNextOccurrences, planDueJobs, schedulePostPublish } from '../src/lib/server/scheduler.js';
import {
	BUSINESS_TIMEZONE,
	SCHEDULE_CADENCES,
	SCHEDULE_DEFAULTS,
	type CatalogEntry,
	type ScheduleCadence
} from '../src/lib/server/schedule-state.js';
import { runWorker, type JobHandler } from '../src/lib/server/job-runner.js';
import { deriveWorkerId } from '../src/lib/server/job-state.js';
import { createId } from '../src/lib/server/utils.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

/**
 * Type de test, cloisonné par exécution. Le ciblage du nettoyage passe par les clés
 * d'idempotence préfixées et par `starts_with(type, '__test_')` — jamais par un
 * `LIKE '__test_%'`, où `_` est un JOKER qui matcherait un type métier de 7 lettres.
 */
const RUN_ID = createId();
const TEST_TYPE = `__test_schedule:${RUN_ID}`;

/** Catalogue de substitution : une seule entrée, sans effet de bord. */
const TEST_CATALOG = (cadence: ScheduleCadence): CatalogEntry[] =>
	cadence === 'weekly' ? [{ jobType: TEST_TYPE, priority: 1, payload: { proof: RUN_ID } }] : [];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}

/** Instant UTC d'un lundi 09:00 Europe/Zurich, écrit à la main (pas via le module testé). */
const MONDAY_WINTER = Date.parse('2026-01-05T08:00:00Z'); // lundi 5 janvier, CET (+1)
const MONDAY_SUMMER = Date.parse('2026-07-20T07:00:00Z'); // lundi 20 juillet, CEST (+2)

async function pickProject(): Promise<{ id: string; slug: string }> {
	const rows = await db
		.select({ id: schema.projects.id, slug: schema.projects.slug })
		.from(schema.projects)
		.limit(1);
	if (rows.length === 0) throw new Error('Aucun projet en base : impossible de planifier.');
	return rows[0];
}

async function countRows(table: 'jobs' | 'monitoring_runs', key: string): Promise<number> {
	const res = await db.execute(
		table === 'jobs'
			? sql`SELECT count(*)::int AS n FROM "seostats"."jobs" WHERE idempotency_key = ${key}`
			: sql`SELECT count(*)::int AS n FROM "seostats"."monitoring_runs" WHERE idempotency_key = ${key}`
	);
	return ((res.rows ?? [])[0] as unknown as { n: number }).n;
}

/** Nettoyage ENFANTS D'ABORD. Cible les lignes de CETTE exécution, jamais plus. */
async function cleanup(): Promise<{ jobs: number; attempts: number; runs: number }> {
	const jobIdsRes = await db.execute(
		sql`SELECT id FROM "seostats"."jobs" WHERE starts_with(type, ${'__test_schedule:'}) AND type = ${TEST_TYPE}`
	);
	const jobIds = ((jobIdsRes.rows ?? []) as unknown as { id: string }[]).map((r) => r.id);

	let attempts = 0;
	let jobs = 0;
	if (jobIds.length > 0) {
		const inJobs = sql.join(
			jobIds.map((i) => sql`${i}`),
			sql`, `
		);
		const att = await db.execute(
			sql`DELETE FROM "seostats"."job_attempts" WHERE job_id IN (${inJobs}) RETURNING id`
		);
		await db.execute(sql`DELETE FROM "seostats"."job_effects" WHERE job_id IN (${inJobs})`);
		const jbs = await db.execute(
			sql`DELETE FROM "seostats"."jobs" WHERE id IN (${inJobs}) RETURNING id`
		);
		attempts = att.rows?.length ?? 0;
		jobs = jbs.rows?.length ?? 0;
	}

	// Les runs ouverts par la preuve : reconnaissables à leur clé d'idempotence, qui
	// porte le créneau local des lundis choisis.
	//
	// Ordre imposé par les FK, et il a DEUX niveaux d'enfants, pas un : les jobs
	// (`jobs.run_id`) mais aussi les STEPS (`monitoring_steps.run_id`), que le worker
	// écrit désormais en concluant le run. Oublier les seconds fait échouer le
	// nettoyage APRÈS toutes les vérifications — donc en laissant croire à un succès.
	const runKeys = [
		`weekly:${PROJECT_SLUG}:2026-01-05T09:00:schedule:1`,
		`weekly:${PROJECT_SLUG}:2026-07-20T09:00:schedule:1`
	];
	const runIdsRes = await db.execute(sql`
		SELECT id FROM "seostats"."monitoring_runs"
		 WHERE idempotency_key IN (${sql.join(runKeys.map((k) => sql`${k}`), sql`, `)})
	`);
	const runIds = ((runIdsRes.rows ?? []) as unknown as { id: string }[]).map((r) => r.id);
	if (runIds.length === 0) return { jobs, attempts, runs: 0 };

	const inRuns = sql.join(
		runIds.map((i) => sql`${i}`),
		sql`, `
	);
	await db.execute(sql`DELETE FROM "seostats"."monitoring_steps" WHERE run_id IN (${inRuns})`);
	const runs = await db.execute(
		sql`DELETE FROM "seostats"."monitoring_runs" WHERE id IN (${inRuns}) RETURNING id`
	);

	return { jobs, attempts, runs: runs.rows?.length ?? 0 };
}

let PROJECT_SLUG = '';

async function main() {
	const project = await pickProject();
	PROJECT_SLUG = project.slug;

	console.log(`\n=== JOB-005 — preuve du scheduler (projet « ${project.slug} ») ===\n`);
	console.log(`Type de test : ${TEST_TYPE}\n`);

	try {
		// ── 1. Idempotence : deux planifications du même créneau ─────
		console.log('1. Un restart sur le même créneau ne crée qu’un run logique');

		const first = await planDueJobs({
			db,
			now: MONDAY_SUMMER,
			lookbackMs: 60_000,
			onlyProjectSlug: project.slug,
			catalog: TEST_CATALOG
		});
		check('la planification tire exactement une occurrence', first.counters.occurrences === 1);
		check('le run est CRÉÉ', first.counters.runsCreated === 1, `${first.counters.runsCreated}`);
		check('le job est mis en file', first.counters.jobsCreated === 1);
		const slot = first.occurrences[0]?.localSlot;
		check('le créneau est LOCAL (09:00 Europe/Zurich)', slot === '2026-07-20T09:00', String(slot));
		check(
			'son instant est écrit en UTC (07:00 — heure d’été)',
			first.occurrences[0]?.instantDb === '2026-07-20 07:00:00',
			String(first.occurrences[0]?.instantDb)
		);

		const second = await planDueJobs({
			db,
			now: MONDAY_SUMMER,
			lookbackMs: 60_000,
			onlyProjectSlug: project.slug,
			catalog: TEST_CATALOG
		});
		check('rejouer le tick ne crée AUCUN run de plus', second.counters.runsCreated === 0);
		check('ni aucun job de plus', second.counters.jobsCreated === 0);
		check('le run existant est réutilisé', second.counters.runsReused === 1);
		check(
			'le job est reconnu déjà en file',
			second.counters.jobsReused === 1 && second.occurrences[0]?.jobs[0]?.jobId === first.occurrences[0]?.jobs[0]?.jobId
		);

		const runKey = `weekly:${project.slug}:2026-07-20T09:00:schedule:1`;
		const jobKey = `weekly:${project.slug}:2026-07-20T09:00:${TEST_TYPE}:1`;
		check('en base : UN SEUL run pour ce créneau', (await countRows('monitoring_runs', runKey)) === 1);
		check('en base : UN SEUL job pour ce créneau', (await countRows('jobs', jobKey)) === 1);

		// Un tick légèrement décalé (le cron n'est pas à la seconde) retombe sur le
		// même créneau : c'est le rattrapage, pas un second déclenchement.
		const late = await planDueJobs({
			db,
			now: MONDAY_SUMMER + 47 * 60 * 1000,
			onlyProjectSlug: project.slug,
			catalog: TEST_CATALOG
		});
		check(
			'un tick en retard de 47 min rattrape le MÊME créneau, sans doublon',
			late.counters.occurrences === 1 && late.counters.jobsCreated === 0,
			`${late.counters.occurrences} occurrence(s), ${late.counters.jobsCreated} job(s) créé(s)`
		);

		// ── 2. Les deux régimes DST, écrits en base ──────────────────
		console.log('\n2. Le même créneau métier, de part et d’autre du changement d’heure');

		const winter = await planDueJobs({
			db,
			now: MONDAY_WINTER,
			lookbackMs: 60_000,
			onlyProjectSlug: project.slug,
			catalog: TEST_CATALOG
		});
		check('un créneau d’hiver est planifié', winter.counters.occurrences === 1);
		check(
			'même heure LOCALE qu’en été (09:00)',
			winter.occurrences[0]?.localSlot === '2026-01-05T09:00',
			String(winter.occurrences[0]?.localSlot)
		);
		check(
			'mais instant UTC différent (08:00 en hiver vs 07:00 en été)',
			winter.occurrences[0]?.instantDb === '2026-01-05 08:00:00',
			String(winter.occurrences[0]?.instantDb)
		);
		check(
			'les deux créneaux ont des clés distinctes (aucune collision entre régimes)',
			winter.occurrences[0]?.jobs[0]?.jobId !== first.occurrences[0]?.jobs[0]?.jobId
		);

		// ── 3. La chaîne complète : le job planifié s’exécute ────────
		console.log('\n3. Un job planifié est réclamable et va jusqu’à `succeeded`');

		let handled = 0;
		const handlers = new Map<string, JobHandler>([
			[
				TEST_TYPE,
				async ({ job }) => {
					handled += 1;
					// Le payload du catalogue arrive intact jusqu'au handler.
					const payload = JSON.parse(job.payloadJson ?? '{}') as { proof?: string };
					if (payload.proof !== RUN_ID) throw new Error('payload du catalogue non transmis');
				}
			]
		]);

		const stats = await runWorker({
			db,
			workerId: deriveWorkerId({ host: 'proof', pid: process.pid, nonce: RUN_ID.slice(0, 6) }),
			types: [TEST_TYPE],
			handlers,
			once: true,
			maxJobs: 10,
			reapLimit: 0 // la preuve ne touche pas aux baux des autres jobs
		});
		check('le drain réclame les jobs planifiés', stats.claimed === 2, `${stats.claimed} réclamé(s)`);
		check('ils réussissent', stats.succeeded === 2, `${stats.succeeded} réussi(s)`);
		check('le handler a bien reçu le payload du catalogue', handled === 2, `${handled} exécution(s)`);

		const statuses = await db.execute(sql`
			SELECT status, count(*)::int AS n FROM "seostats"."jobs"
			 WHERE type = ${TEST_TYPE} GROUP BY status
		`);
		const rows = (statuses.rows ?? []) as unknown as { status: string; n: number }[];
		check(
			'en base, tous les jobs de la preuve sont `succeeded`',
			rows.length === 1 && rows[0].status === 'succeeded' && rows[0].n === 2,
			JSON.stringify(rows)
		);

		const attempts = await db.execute(sql`
			SELECT count(*)::int AS n FROM "seostats"."job_attempts" a
			  JOIN "seostats"."jobs" j ON j.id = a.job_id
			 WHERE j.type = ${TEST_TYPE}
		`);
		check(
			'chaque exécution a laissé sa ligne au journal',
			((attempts.rows ?? [])[0] as unknown as { n: number }).n === 2
		);

		// Un tick qui repasse après exécution ne remet PAS le créneau en file : la
		// clé est prise, même par un job terminé. C'est ce qui protège d'un rejeu.
		const afterRun = await planDueJobs({
			db,
			now: MONDAY_SUMMER,
			lookbackMs: 60_000,
			onlyProjectSlug: project.slug,
			catalog: TEST_CATALOG
		});
		check(
			'un tick postérieur ne rejoue pas un créneau déjà exécuté',
			afterRun.counters.jobsCreated === 0,
			`${afterRun.counters.jobsCreated} job(s) créé(s)`
		);

		// ── 4. Prochaine exécution par projet ────────────────────────
		console.log('\n4. La prochaine exécution est visible par projet');

		const next = await listNextOccurrences({ db, now: MONDAY_SUMMER + 60_000 });
		const projectsSeen = new Set(next.map((r) => r.projectSlug));
		check('une ligne par projet et par cadence', next.length === projectsSeen.size * SCHEDULE_CADENCES.length, `${next.length} ligne(s) / ${projectsSeen.size} projet(s)`);

		const weekly = next.find((r) => r.projectSlug === project.slug && r.cadence === 'weekly');
		check(
			'le prochain hebdo est le lundi suivant, 09:00 heure métier',
			weekly?.localSlot === '2026-07-27T09:00',
			String(weekly?.localSlot)
		);
		check(
			'avec son instant UTC (07:00, heure d’été)',
			weekly?.instantDb === '2026-07-27 07:00:00',
			String(weekly?.instantDb)
		);
		check(
			'les cadences non câblées sont marquées comme telles',
			next.filter((r) => r.cadence === 'hourly').every((r) => r.wired === false)
		);
		check(
			'les cadences câblées le sont aussi',
			next.filter((r) => r.cadence === 'weekly').every((r) => r.wired === true)
		);

		// ── 5. Post-publication : trois échéances futures ────────────
		console.log('\n5. Post-publication : les vérifications attendent leur heure en file');

		const contentId = `__test_content_${RUN_ID}`;
		const post = await schedulePostPublish({
			db,
			projectId: project.id,
			projectSlug: project.slug,
			contentId,
			publishedAt: MONDAY_SUMMER
		});
		check('trois échéances posées (J+3, J+7, J+28)', post.scheduled.length === 3);
		check(
			'leurs `available_at` sont dans le futur, échelonnés',
			post.scheduled[0].availableAtDb === '2026-07-23 07:00:00' &&
				post.scheduled[2].availableAtDb === '2026-08-17 07:00:00',
			post.scheduled.map((s) => s.availableAtDb).join(' · ')
		);
		const replay = await schedulePostPublish({
			db,
			projectId: project.id,
			projectSlug: project.slug,
			contentId,
			publishedAt: MONDAY_SUMMER
		});
		check(
			'republier le même contenu ne double pas les échéances',
			replay.scheduled.every((s) => !s.created)
		);
		// Ces jobs-là n'ont pas de handler (E03) : on les retire tout de suite pour ne
		// pas laisser en file trois jobs qui échoueraient en `NoHandlerRegistered`.
		const removed = await db.execute(sql`
			DELETE FROM "seostats"."jobs"
			 WHERE type = ${'post_publish:check'} AND payload_json LIKE ${`%${contentId}%`}
			 RETURNING id
		`);
		check('les jobs post-publication de la preuve sont retirés', (removed.rows?.length ?? 0) === 3, `${removed.rows?.length ?? 0}`);

		// ── 6. Aucune fuite dans la vraie file ───────────────────────
		console.log('\n6. La preuve n’a rien laissé dans la file réelle');

		const strayISO = await db.execute(sql`
			SELECT count(*)::int AS n FROM "seostats"."jobs" WHERE available_at LIKE ${'%T%'}
		`);
		check(
			'aucun horodatage au format ISO dans `jobs`',
			((strayISO.rows ?? [])[0] as unknown as { n: number }).n === 0
		);

		const findings = await db.execute(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`);
		check(
			'les findings existants sont intacts (13 attendus)',
			((findings.rows ?? [])[0] as unknown as { n: number }).n === 13,
			`${((findings.rows ?? [])[0] as unknown as { n: number }).n}`
		);

		console.log(
			failures === 0
				? '\n✅ Toutes les vérifications sont vertes.\n'
				: `\n❌ ${failures} vérification(s) en échec.\n`
		);
	} finally {
		const cleaned = await cleanup();
		console.log(
			`Nettoyage : ${cleaned.jobs} job(s), ${cleaned.attempts} tentative(s), ${cleaned.runs} run(s) supprimés.\n`
		);
		await pool.end();
	}

	if (failures > 0) process.exit(1);
}

// Rappel des défauts, pour que la sortie soit lisible sans ouvrir le code.
console.log(
	`\nDéfauts : hebdo = ${SCHEDULE_DEFAULTS.weekly.hour}:00 le jour ${SCHEDULE_DEFAULTS.weekly.weekday} (${BUSINESS_TIMEZONE}).`
);

main().catch(async (err) => {
	console.error('Preuve en erreur:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
