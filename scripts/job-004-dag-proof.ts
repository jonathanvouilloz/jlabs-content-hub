/**
 * JOB-004 — Preuve des dépendances entre jobs (sur Neon).
 *
 * Les règles de décision sont couvertes par `src/lib/server/job-graph.test.ts`
 * (38 tests : optionnel mort → ready, obligatoire mort → skip, cascade, cycle…).
 * Ce qui ne peut PAS se prouver en vitest, et qui se prouve ici, c'est ce que fait
 * la base :
 *
 *   1. « un collecteur échoué bloque les détecteurs qui en dépendent » — le
 *      dépendant n'est PAS réclamable tant que son prérequis n'a pas abouti, et la
 *      garde est dans la réclamation elle-même, pas dans le worker ;
 *   2. « Plausible indisponible ne bloque pas un rapport GSC » — un prérequis
 *      OPTIONNEL mort laisse le dépendant s'exécuter ;
 *   3. « le rapport indique précisément les données manquantes » — un prérequis
 *      obligatoire mort fait passer le dépendant en `skipped`, écrit son step, et le
 *      run vaut `partial` avec la cause nommée ;
 *   + l'idempotence de la passe, et la chaîne complète planifier → drainer.
 *
 * Le catalogue est SUBSTITUÉ par des types `__test_dag:<runId>` : la preuve ne doit
 * pas déclencher de vraie détection sur les données de production (barberconcept
 * écrirait 50 findings d'un coup). Nettoyage ENFANTS D'ABORD dans un `finally`
 * (`job_attempts` → `job_effects` → `jobs` → `monitoring_steps` → `monitoring_runs` :
 * `jobs.run_id` ET `monitoring_steps.run_id` référencent le run — oublier les steps
 * fait échouer le nettoyage APRÈS les vérifications, donc en laissant croire à un
 * succès).
 *
 * Lancer : npx tsx scripts/job-004-dag-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { planDueJobs } from '../src/lib/server/scheduler.js';
import type { CatalogEntry, ScheduleCadence } from '../src/lib/server/schedule-state.js';
import { claimJob, releaseJob } from '../src/lib/server/jobs-claim.js';
import { settleBlockedJobs } from '../src/lib/server/jobs-graph.js';
import { runWorker, type JobHandler } from '../src/lib/server/job-runner.js';
import { deriveWorkerId } from '../src/lib/server/job-state.js';
import { createId } from '../src/lib/server/utils.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

/**
 * Types de test, cloisonnés par exécution : sans ce cloisonnement, un run
 * réclamerait les jobs du run précédent et la preuve mesurerait autre chose
 * (leçon JOB-003). Le ciblage du nettoyage passe par `starts_with`, JAMAIS par
 * `LIKE '__test_%'` — où `_` est un JOKER qui matcherait un type métier.
 */
const RUN_ID = createId();
const PREFIX = '__test_dag:';
const T_ROOT = `${PREFIX}root:${RUN_ID}`; // le prérequis
const T_REQUIRED = `${PREFIX}required:${RUN_ID}`; // dépendant OBLIGATOIRE
const T_OPTIONAL = `${PREFIX}optional:${RUN_ID}`; // dépendant OPTIONNEL

/** Catalogue de substitution : la chaîne exacte que le hebdo réel décrit. */
const TEST_CATALOG = (cadence: ScheduleCadence): CatalogEntry[] =>
	cadence === 'weekly'
		? [
				{ jobType: T_ROOT, priority: 10 },
				{ jobType: T_REQUIRED, priority: 8, dependsOn: [{ jobType: T_ROOT }] },
				{ jobType: T_OPTIONAL, priority: 8, dependsOn: [{ jobType: T_ROOT, required: false }] }
			]
		: [];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}

/** Lundi 09:00 Europe/Zurich, écrit à la main (pas via le module testé). */
const MONDAY = Date.parse('2026-07-20T07:00:00Z');
const SLOT = '2026-07-20T09:00';

let PROJECT_SLUG = '';

async function pickProject(): Promise<{ id: string; slug: string }> {
	const rows = await db
		.select({ id: schema.projects.id, slug: schema.projects.slug })
		.from(schema.projects)
		.limit(1);
	if (rows.length === 0) throw new Error('Aucun projet en base : impossible de planifier.');
	return rows[0];
}

async function statusOf(jobId: string): Promise<string | null> {
	const res = await db.execute(
		sql`SELECT status FROM "seostats"."jobs" WHERE id = ${jobId}`
	);
	return ((res.rows ?? [])[0] as unknown as { status: string } | undefined)?.status ?? null;
}

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(query);
	return Number(((res.rows ?? [])[0] as unknown as { n: number } | undefined)?.n ?? 0);
}

async function runStatus(runId: string): Promise<string | null> {
	const res = await db.execute(
		sql`SELECT status FROM "seostats"."monitoring_runs" WHERE id = ${runId}`
	);
	return ((res.rows ?? [])[0] as unknown as { status: string } | undefined)?.status ?? null;
}

/** Nettoyage ENFANTS D'ABORD. Cible les lignes de CETTE exécution, jamais plus. */
async function cleanup(): Promise<{ jobs: number; attempts: number; steps: number; runs: number }> {
	const jobIdsRes = await db.execute(sql`
		SELECT id FROM "seostats"."jobs"
		 WHERE starts_with(type, ${PREFIX}) AND type IN (${T_ROOT}, ${T_REQUIRED}, ${T_OPTIONAL})
	`);
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

	// Le run de la preuve, reconnaissable à sa clé d'idempotence. DEUX niveaux
	// d'enfants : les jobs (ci-dessus) et les STEPS, écrits en concluant le run.
	const runKey = `weekly:${PROJECT_SLUG}:${SLOT}:schedule:1`;
	const runIdsRes = await db.execute(
		sql`SELECT id FROM "seostats"."monitoring_runs" WHERE idempotency_key = ${runKey}`
	);
	const runIds = ((runIdsRes.rows ?? []) as unknown as { id: string }[]).map((r) => r.id);
	if (runIds.length === 0) return { jobs, attempts, steps: 0, runs: 0 };

	const inRuns = sql.join(
		runIds.map((i) => sql`${i}`),
		sql`, `
	);
	const stp = await db.execute(
		sql`DELETE FROM "seostats"."monitoring_steps" WHERE run_id IN (${inRuns}) RETURNING id`
	);
	const runs = await db.execute(
		sql`DELETE FROM "seostats"."monitoring_runs" WHERE id IN (${inRuns}) RETURNING id`
	);
	return { jobs, attempts, steps: stp.rows?.length ?? 0, runs: runs.rows?.length ?? 0 };
}

/**
 * Handlers de test : aucun effet de bord, et un compteur pour savoir qui a tourné.
 *
 * Le prérequis ÉCHOUE, et il échoue par le chemin réel — un 403 nu, que JOB-003
 * classe `permanent` et envoie en dead-letter dès la première tentative. Passer par
 * `failJob` à la main aurait sauté `concludeRunStep`, donc le step du prérequis, donc
 * le `partial` du run : la preuve aurait mesuré son propre raccourci.
 */
function testHandlers(ran: string[]): Map<string, JobHandler> {
	const noop: JobHandler = async ({ job }) => {
		ran.push(job.type);
	};
	return new Map<string, JobHandler>([
		[
			T_ROOT,
			async ({ job }) => {
				ran.push(job.type);
				throw { status: 403, message: 'the caller does not have permission' };
			}
		],
		[T_REQUIRED, noop],
		[T_OPTIONAL, noop]
	]);
}

async function plan(project: { id: string; slug: string }) {
	return planDueJobs({
		db,
		now: MONDAY,
		lookbackMs: 60_000,
		onlyProjectSlug: project.slug,
		catalog: TEST_CATALOG
	});
}

async function main() {
	const project = await pickProject();
	PROJECT_SLUG = project.slug;

	console.log(`\n=== JOB-004 — preuve des dépendances (projet « ${project.slug} ») ===\n`);
	console.log(`Types de test : ${T_ROOT}\n                ${T_REQUIRED}\n                ${T_OPTIONAL}\n`);

	try {
		// ── 1. Les arêtes sont écrites, et pointent de vrais ids ─────
		console.log('1. La planification écrit les arêtes du catalogue');

		const planned = await plan(project);
		check('une occurrence est due', planned.counters.occurrences === 1);
		check('trois jobs sont mis en file', planned.counters.jobsCreated === 3, `${planned.counters.jobsCreated}`);

		const jobsByType = new Map(planned.occurrences[0].jobs.map((j) => [j.jobType, j.jobId]));
		const rootId = jobsByType.get(T_ROOT)!;
		const requiredId = jobsByType.get(T_REQUIRED)!;
		const optionalId = jobsByType.get(T_OPTIONAL)!;
		const runId = planned.occurrences[0].runId!;

		const depsRes = await db.execute(
			sql`SELECT depends_on FROM "seostats"."jobs" WHERE id = ${requiredId}`
		);
		const depsRaw = ((depsRes.rows ?? [])[0] as unknown as { depends_on: string | null }).depends_on;
		const deps = JSON.parse(depsRaw ?? '[]') as Array<Record<string, unknown>>;
		check('le dépendant porte UNE arête', deps.length === 1, `${deps.length}`);
		check('elle pointe l’id RÉEL du prérequis', deps[0]?.jobId === rootId);
		check('elle nomme aussi son type (lisible sans requête)', deps[0]?.jobType === T_ROOT);
		check('elle est OBLIGATOIRE par défaut', deps[0]?.required === true);

		const rootDeps = await db.execute(
			sql`SELECT depends_on FROM "seostats"."jobs" WHERE id = ${rootId}`
		);
		check(
			'le prérequis, lui, n’a AUCUNE arête (colonne NULL — la garde court-circuite)',
			((rootDeps.rows ?? [])[0] as unknown as { depends_on: string | null }).depends_on === null
		);

		// ── 2. La garde retient le dépendant ─────────────────────────
		console.log('\n2. Un dépendant n’est PAS réclamable tant que son prérequis n’a pas abouti');

		const workerId = deriveWorkerId({ host: 'proof', pid: process.pid, nonce: RUN_ID.slice(-6) });
		const first = await claimJob({ db, types: [T_REQUIRED, T_OPTIONAL], workerId });
		check(
			'aucun des deux dépendants n’est réclamable (le prérequis est encore `queued`)',
			first === null,
			first ? `réclamé : ${first.type}` : ''
		);

		const claimedRoot = await claimJob({ db, types: [T_ROOT, T_REQUIRED, T_OPTIONAL], workerId });
		check('le prérequis, lui, est réclamable', claimedRoot?.id === rootId, claimedRoot?.type ?? 'null');

		const whileRunning = await claimJob({ db, types: [T_REQUIRED, T_OPTIONAL], workerId });
		check(
			'toujours rien pendant que le prérequis TOURNE (`running`)',
			whileRunning === null,
			whileRunning ? `réclamé : ${whileRunning.type}` : ''
		);

		// Rendu à la file (JOB-001 : la tentative est rendue avec) pour que la suite
		// se joue entièrement par le chemin réel du worker.
		const released = await releaseJob({ db, jobId: rootId, workerId });
		check('le prérequis est rendu à la file pour la suite', released);

		// ── 3. Prérequis MORT : obligatoire sauté, optionnel exécuté ──
		console.log('\n3. Le prérequis meurt : l’obligatoire est sauté, l’OPTIONNEL passe quand même');

		// UN SEUL drain, sur les trois types : c'est la chaîne réelle d'un tick.
		// Le prérequis part d'abord (priority 10), meurt en `permanent` → dead-letter
		// immédiat ; l'optionnel devient réclamable et tourne ; l'obligatoire ne l'est
		// jamais, et c'est la passe du tour à vide qui le conclut.
		const ran: string[] = [];
		const stats = await runWorker({
			db,
			workerId,
			types: [T_ROOT, T_REQUIRED, T_OPTIONAL],
			handlers: testHandlers(ran),
			once: true,
			maxJobs: 5
		});
		check('le prérequis a bien été tenté, puis est mort', (await statusOf(rootId)) === 'dead', String(await statusOf(rootId)));
		check('sa mort est immédiate (403 nu = `permanent`)', stats.deadLettered === 1, `${stats.deadLettered}`);
		check(
			'le dépendant OPTIONNEL s’exécute (« Plausible indisponible ne bloque pas GSC »)',
			ran.includes(T_OPTIONAL),
			ran.join(', ') || 'aucun'
		);
		check('le dépendant OBLIGATOIRE, lui, n’a jamais tourné', !ran.includes(T_REQUIRED));
		check('le worker le compte comme sauté', stats.skipped === 1, `${stats.skipped}`);

		check('l’optionnel est `succeeded`', (await statusOf(optionalId)) === 'succeeded');
		const reqStatus = await statusOf(requiredId);
		check('l’obligatoire est `skipped`', reqStatus === 'skipped', String(reqStatus));

		const skipRow = await db.execute(sql`
			SELECT attempts, last_error_code, last_error_message, finished_at
			  FROM "seostats"."jobs" WHERE id = ${requiredId}
		`);
		const skip = (skipRow.rows ?? [])[0] as unknown as {
			attempts: number;
			last_error_code: string;
			last_error_message: string;
			finished_at: string | null;
		};
		check('il n’a consommé AUCUNE tentative', Number(skip.attempts) === 0, `${skip.attempts}`);
		check('sa cause est filtrable', skip.last_error_code === 'DependencySkipped', skip.last_error_code);
		check(
			'sa raison NOMME le prérequis manquant et son état',
			skip.last_error_message?.includes(T_ROOT) && skip.last_error_message?.includes('dead'),
			skip.last_error_message
		);
		check('il est bien terminé (finished_at renseigné)', skip.finished_at !== null);

		// ── 4. L'audit : le journal porte la décision ────────────────
		console.log('\n4. Le skip est AUDITÉ (journal append-only)');

		const journal = await db.execute(sql`
			SELECT outcome, worker_id, attempt_no, metadata_json
			  FROM "seostats"."job_attempts" WHERE job_id = ${requiredId}
		`);
		const lines = (journal.rows ?? []) as unknown as Array<{
			outcome: string;
			worker_id: string;
			attempt_no: number;
			metadata_json: string | null;
		}>;
		check('une ligne, et une seule', lines.length === 1, `${lines.length}`);
		check('son issue est `skipped`', lines[0]?.outcome === 'skipped', lines[0]?.outcome);
		check(
			'son auteur est le système, jamais un humain',
			lines[0]?.worker_id === 'system:dependency',
			lines[0]?.worker_id
		);
		check('elle ne compte aucune tentative', Number(lines[0]?.attempt_no) === 0);
		check(
			'elle conserve les arêtes qui ont motivé la décision',
			(lines[0]?.metadata_json ?? '').includes(T_ROOT)
		);

		// ── 5. Le run le dit : `partial` ─────────────────────────────
		console.log('\n5. Le run distingue ce qui a réussi de ce qui manque');

		const steps = await db.execute(sql`
			SELECT step_type, status, error_code FROM "seostats"."monitoring_steps"
			 WHERE run_id = ${runId} ORDER BY step_type
		`);
		const stepRows = (steps.rows ?? []) as unknown as Array<{
			step_type: string;
			status: string;
			error_code: string | null;
		}>;
		const byType = new Map(stepRows.map((s) => [s.step_type, s]));
		check('le prérequis mort a un step `failed`', byType.get(T_ROOT)?.status === 'failed', byType.get(T_ROOT)?.status);
		check('l’optionnel a un step `success`', byType.get(T_OPTIONAL)?.status === 'success', byType.get(T_OPTIONAL)?.status);
		check(
			'le sauté a un step `skipped` (vocabulaire DATA-003, jamais écrit avant ce lot)',
			byType.get(T_REQUIRED)?.status === 'skipped',
			byType.get(T_REQUIRED)?.status
		);
		check(
			'le step sauté porte la cause (« les données manquantes » sont nommées)',
			byType.get(T_REQUIRED)?.error_code === 'DependencySkipped'
		);
		const rs = await runStatus(runId);
		check('le run vaut `partial` — ni un succès, ni un échec total', rs === 'partial', String(rs));

		// ── 6. Rejouer la passe ne refait rien ───────────────────────
		console.log('\n6. La passe de résolution est REJOUABLE');

		const before = await scalar(
			sql`SELECT count(*)::int AS n FROM "seostats"."job_attempts" WHERE job_id = ${requiredId}`
		);
		const again = await settleBlockedJobs({ db });
		check('aucun nouveau skip', again.skipped.length === 0, `${again.skipped.length}`);
		const after = await scalar(
			sql`SELECT count(*)::int AS n FROM "seostats"."job_attempts" WHERE job_id = ${requiredId}`
		);
		check('aucune ligne de journal de plus', before === after, `${before} → ${after}`);
		check('le statut ne bouge pas', (await statusOf(requiredId)) === 'skipped');
		const rs2 = await runStatus(runId);
		check('le statut du run ne bouge pas non plus', rs2 === 'partial', String(rs2));

		// ── 7. Replanifier ne duplique ni job ni arête ───────────────
		console.log('\n7. Replanifier le même créneau ne recrée rien');

		const replan = await plan(project);
		check('aucun job créé', replan.counters.jobsCreated === 0, `${replan.counters.jobsCreated}`);
		check('les trois sont réutilisés', replan.counters.jobsReused === 3, `${replan.counters.jobsReused}`);
		check('le run est réutilisé', replan.counters.runsCreated === 0);
		const total = await scalar(sql`
			SELECT count(*)::int AS n FROM "seostats"."jobs"
			 WHERE type IN (${T_ROOT}, ${T_REQUIRED}, ${T_OPTIONAL})
		`);
		check('toujours 3 jobs en base', total === 3, `${total}`);

		// ── 8. Rien n'a fui dans la file réelle ──────────────────────
		console.log('\n8. La preuve n’a rien laissé derrière elle');

		const strayISO = await scalar(sql`
			SELECT count(*)::int AS n FROM "seostats"."jobs" WHERE available_at LIKE ${'%T%'}
		`);
		check('aucun horodatage ISO dans `jobs`', strayISO === 0, `${strayISO}`);
		const strayAttempts = await scalar(sql`
			SELECT count(*)::int AS n FROM "seostats"."job_attempts" WHERE started_at LIKE ${'%T%'}
		`);
		check('aucun horodatage ISO dans `job_attempts`', strayAttempts === 0, `${strayAttempts}`);
		// Les steps ÉCRITS PAR CE LOT doivent être au format DB : c'est `finished_at`
		// que `latestAttemptPerStep` compare pour décider du dernier verdict d'un step.
		const stepsISO = await scalar(sql`
			SELECT count(*)::int AS n FROM "seostats"."monitoring_steps"
			 WHERE run_id = ${runId} AND finished_at LIKE ${'%T%'}
		`);
		check('aucun horodatage ISO dans les steps de la preuve', stepsISO === 0, `${stepsISO}`);

		// Une ligne HÉRITÉE traîne en base (run manuel de `detect.ts` d'avant sa
		// correction). Inoffensive : `compareFinishedAt` normalise le séparateur avant
		// toute comparaison — c'est précisément le piège `'T'` (0x54) > `' '` (0x20).
		// Nommée, pas corrigée : supprimer une ligne d'un vrai run est une décision.
		const legacyISO = await scalar(sql`
			SELECT count(*)::int AS n FROM "seostats"."monitoring_steps"
			 WHERE finished_at LIKE ${'%T%'}
		`);
		console.log(`  ℹ️  steps hérités au format ISO en base : ${legacyISO} (dette nommée, neutralisée à la lecture)`);

		const findings = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`);
		check('les findings existants sont intacts (13 attendus)', findings === 13, `${findings}`);

		const realBlocked = await scalar(sql`
			SELECT count(*)::int AS n FROM "seostats"."jobs"
			 WHERE depends_on IS NOT NULL AND NOT starts_with(type, ${PREFIX})
		`);
		console.log(`  ℹ️  jobs métier porteurs d’arêtes en base : ${realBlocked}`);

		console.log(
			failures === 0
				? '\n✅ Toutes les vérifications sont vertes.\n'
				: `\n❌ ${failures} vérification(s) en échec.\n`
		);
	} finally {
		const cleaned = await cleanup();
		console.log(
			`Nettoyage : ${cleaned.jobs} job(s), ${cleaned.attempts} tentative(s), ` +
				`${cleaned.steps} step(s), ${cleaned.runs} run(s) supprimés.\n`
		);
		await pool.end();
	}

	if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
	console.error('Preuve en erreur:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
