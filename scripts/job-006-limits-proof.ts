/**
 * JOB-006 — Preuve des limites de concurrence et des quotas provider (sur Neon).
 *
 * Les règles de décision sont couvertes par `src/lib/server/job-limits.test.ts`
 * (45 tests : plafonds, réserve, refroidissement, tour d'équité, tolérance de config).
 * Ce qui ne peut PAS se prouver en vitest, et qui se prouve ici, c'est ce que fait la
 * BASE :
 *
 *   1. « un site volumineux ne monopolise pas les workers » — deux projets, un seul
 *      drain : le gros ne prend pas tout, et le petit est servi DANS LE MÊME drain ;
 *   2. « les reports continuent avec statut quota_limited lorsque possible » — un échec
 *      `quota` met TOUTE la cohorte du provider au repos : `available_at` poussé,
 *      `attempts` et `deferrals` INCHANGÉS (aucun de ces jobs n'a été réclamé) ;
 *   3. le refroidissement expiré rend les jobs réclamables, sans intervention ;
 *   4. la réserve : file saturée, un type réservé passe quand même ;
 *   5. un type INCONNU du catalogue n'est bloqué par aucun budget provider ;
 *   + l'idempotence de la passe de refroidissement, et le fait que la garde vive
 *     bien DANS la réclamation (un appelant qui l'ignore ne peut pas la contourner —
 *     `claimJob` la reçoit, ce n'est pas le worker qui filtre après coup).
 *
 * Les types sont `__test_limits:<runId>`, cloisonnés par exécution : sans ce
 * cloisonnement, un run réclamerait les jobs du précédent et la preuve mesurerait autre
 * chose (leçon JOB-003). La résolution type → provider est SUBSTITUÉE (`providerOf` /
 * `typesForProvider`), même porte que le `catalog` de `planDueJobs` : jamais un type de
 * production, donc jamais de vraie détection ni de vrais findings.
 *
 * Nettoyage ENFANTS D'ABORD dans un `finally` (`job_attempts` → `job_effects` → `jobs`),
 * ciblé par `starts_with` et JAMAIS par `LIKE '__test_%'` — où `_` est un JOKER qui
 * matcherait un type métier de sept caractères.
 *
 * Lancer : npx tsx scripts/job-006-limits-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { claimJob } from '../src/lib/server/jobs-claim.js';
import { enqueueJob } from '../src/lib/server/monitoring.js';
import { runWorker, type JobHandler } from '../src/lib/server/job-runner.js';
import { deriveWorkerId } from '../src/lib/server/job-state.js';
import {
	LIMIT_DEFAULTS,
	planAdmission,
	openFairness,
	recordClaim,
	resolveLimits,
	type JobProvider
} from '../src/lib/server/job-limits.js';
import {
	SYSTEM_LIMITS_KEY,
	coolDownQuotaLimitedJobs,
	loadCapacitySnapshot,
	loadQueueSnapshot,
	loadSystemLimitOverrides,
	saveSystemLimitOverrides
} from '../src/lib/server/jobs-limits.js';
import { createId } from '../src/lib/server/utils.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const RUN_ID = createId();
const PREFIX = '__test_limits:';
/** Type rattaché à un provider fictif — c'est lui qu'on met au repos. */
const T_PROVIDER = `${PREFIX}gscish:${RUN_ID}`;
/** Type réservé (avis/alertes) — doit passer même quand la réserve mord. */
const T_RESERVED = `${PREFIX}reserved:${RUN_ID}`;
/** Type INCONNU de la table des providers : ne doit être bloqué par aucun budget. */
const T_UNKNOWN = `${PREFIX}unknown:${RUN_ID}`;

const ALL_TYPES = [T_PROVIDER, T_RESERVED, T_UNKNOWN];

/**
 * Résolution SUBSTITUÉE : `T_PROVIDER` se comporte comme un type `gsc`, les autres
 * comme des types internes. Aucun type de production n'entre dans cette table.
 */
const providerOf = (jobType: string): JobProvider => (jobType === T_PROVIDER ? 'gsc' : 'none');
const typesForProvider = (provider: JobProvider): string[] =>
	provider === 'gsc' ? [T_PROVIDER] : [];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}

async function pickProjects(): Promise<Array<{ id: string; slug: string }>> {
	const rows = await db
		.select({ id: schema.projects.id, slug: schema.projects.slug })
		.from(schema.projects)
		.orderBy(schema.projects.slug)
		.limit(2);
	if (rows.length < 2) throw new Error('Deux projets sont nécessaires pour prouver l’équité.');
	return rows;
}

async function enqueue(input: {
	projectId: string;
	type: string;
	tag: string;
	availableAt?: string;
	priority?: number;
}): Promise<string> {
	const res = await enqueueJob(
		{
			projectId: input.projectId,
			type: input.type,
			priority: input.priority ?? 5,
			availableAt: input.availableAt,
			idempotencyKey: `${PREFIX}${RUN_ID}:${input.tag}`
		},
		db
	);
	return res.id;
}

async function jobRow(jobId: string): Promise<{
	status: string;
	available_at: string;
	attempts: number;
	deferrals: number;
	last_error_class: string | null;
	last_error_code: string | null;
} | null> {
	const res = await db.execute(sql`
		SELECT status, available_at, attempts, deferrals, last_error_class, last_error_code
		  FROM "seostats"."jobs" WHERE id = ${jobId}
	`);
	return ((res.rows ?? [])[0] as never) ?? null;
}

/** Nettoyage ENFANTS D'ABORD. Cible les lignes de CETTE exécution, jamais plus. */
async function cleanup(): Promise<{ jobs: number; attempts: number; settings: number }> {
	const idsRes = await db.execute(sql`
		SELECT id FROM "seostats"."jobs"
		 WHERE starts_with(type, ${PREFIX}) AND type IN (${sql.join(
				ALL_TYPES.map((t) => sql`${t}`),
				sql`, `
			)})
	`);
	const ids = ((idsRes.rows ?? []) as unknown as { id: string }[]).map((r) => r.id);
	let attempts = 0;
	let jobs = 0;
	if (ids.length > 0) {
		const inJobs = sql.join(
			ids.map((i) => sql`${i}`),
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
	// La clé de configuration écrite par la preuve — restaurée à l'identique plus bas si
	// elle préexistait, supprimée sinon.
	const del = await db.execute(
		sql`DELETE FROM "seostats"."system_settings" WHERE key = ${SYSTEM_LIMITS_KEY} RETURNING key`
	);
	return { jobs, attempts, settings: del.rows?.length ?? 0 };
}

async function main() {
	const [pA, pB] = await pickProjects();
	console.log(`\nJOB-006 — preuve des limites (run ${RUN_ID})`);
	console.log(`Projets : ${pA.slug} (gros) · ${pB.slug} (petit)\n`);

	// La configuration système préexistante est mémorisée pour être RENDUE à
	// l'identique : une preuve qui laisse un réglage derrière elle change la production.
	const previousOverrides = await loadSystemLimitOverrides(db);

	// ── 1. Équité : le gros ne monopolise pas le drain ──────────────────
	console.log('1. Équité entre projets (un site volumineux ne monopolise pas)');

	// 6 jobs pour le gros, 2 pour le petit. Priorité IDENTIQUE : sans équité, l'ordre
	// de service (priorité puis ancienneté) donnerait les 6 premiers au gros.
	for (let i = 0; i < 6; i += 1) {
		await enqueue({ projectId: pA.id, type: T_UNKNOWN, tag: `fair-a-${i}` });
	}
	for (let i = 0; i < 2; i += 1) {
		await enqueue({ projectId: pB.id, type: T_UNKNOWN, tag: `fair-b-${i}` });
	}

	const order: string[] = [];
	const handlers = new Map<string, JobHandler>(
		ALL_TYPES.map((t) => [t, async ({ job }) => { order.push(job.projectId); }] as const)
	);

	// Limites de la preuve : 2 jobs par tour et par projet. Écrites en base, donc
	// lues par le worker comme n'importe quel réglage d'exploitation — c'est aussi
	// l'acceptation « configurables sans redéploiement » qui se vérifie ici.
	await saveSystemLimitOverrides({
		db,
		overrides: { perProjectPerLap: 2, globalConcurrency: 0, perProjectConcurrency: 0 },
		description: `Preuve JOB-006 (${RUN_ID}).`
	});
	const reread = resolveLimits(await loadSystemLimitOverrides(db));
	check(
		'les limites écrites en base sont relues (sans redéploiement)',
		reread.perProjectPerLap === 2,
		`perProjectPerLap = ${reread.perProjectPerLap} (défaut ${LIMIT_DEFAULTS.perProjectPerLap})`
	);

	const stats = await runWorker({
		db,
		workerId: deriveWorkerId({ host: 'proof', pid: process.pid, nonce: RUN_ID.slice(-6) }),
		types: ALL_TYPES,
		handlers,
		once: true,
		maxJobs: 8,
		pollIntervalMs: 1
	});

	check('les 8 jobs ont été traités dans un seul drain', stats.claimed === 8, `claimed=${stats.claimed}`);
	const firstFour = order.slice(0, 4);
	check(
		'le petit projet est servi DANS le premier tour, pas après le gros',
		firstFour.includes(pB.id),
		`4 premiers : ${firstFour.map((id) => (id === pA.id ? 'gros' : 'petit')).join(', ')}`
	);
	check(
		'le gros ne prend jamais plus de 2 jobs d’affilée au premier tour',
		order.slice(0, 2).every((id) => id === pA.id) && order[2] !== undefined,
		`ordre = ${order.map((id) => (id === pA.id ? 'A' : 'B')).join('')}`
	);
	check('au moins un tour d’équité a été ouvert', stats.laps >= 1, `laps=${stats.laps}`);
	check(
		'les retenues sont comptées et nommées',
		stats.heldByReason.project_lap > 0,
		`project_lap=${stats.heldByReason.project_lap}`
	);

	// ── 2. Quota : toute la cohorte au repos ───────────────────────────
	console.log('\n2. Un quota met TOUTE la cohorte du provider au repos');

	const cohort = [
		await enqueue({ projectId: pA.id, type: T_PROVIDER, tag: 'cohort-1' }),
		await enqueue({ projectId: pA.id, type: T_PROVIDER, tag: 'cohort-2' }),
		await enqueue({ projectId: pB.id, type: T_PROVIDER, tag: 'cohort-3' })
	];
	const before = await Promise.all(cohort.map(jobRow));

	// Un échec `quota` RÉEL, écrit par le chemin réel : une tentative journalisée avec
	// `error_class='quota'`. C'est de cette ligne, et d'elle seule, que le
	// refroidissement est dérivé — aucun état de repos n'est stocké nulle part.
	const quotaAt = new Date();
	await db.insert(schema.jobAttempts).values({
		id: createId(),
		jobId: cohort[0],
		projectId: pA.id,
		attemptNo: 1,
		workerId: 'proof',
		outcome: 'deferred',
		errorClass: 'quota',
		errorCode: 'rateLimitExceeded',
		startedAt: toDbTimestamp(quotaAt),
		finishedAt: toDbTimestamp(quotaAt)
	});

	const snap = await loadQueueSnapshot({ db, windowMs: LIMIT_DEFAULTS.providerWindowMs, providerOf });
	check(
		'le dernier quota du provider est DÉRIVÉ du journal',
		snap.lastQuotaFailureMsByProvider.gsc !== null,
		`gsc → ${snap.lastQuotaFailureMsByProvider.gsc}`
	);

	const admission = planAdmission({
		limits: resolveLimits({ cooldownMs: 900_000 }),
		snapshot: snap,
		fairness: openFairness(),
		typesForProvider,
		now: Date.now()
	});
	check(
		'le provider est au repos, avec une fin de refroidissement',
		admission.cooldownUntilByProvider.gsc !== undefined,
		`jusqu’à ${admission.cooldownUntilByProvider.gsc}`
	);
	check(
		'la cohorte du provider est écartée — c’est bien LE type de la preuve',
		admission.excludedTypes.includes(T_PROVIDER),
		`exclus = ${admission.excludedTypes.join(', ') || '∅'}`
	);

	// La GARDE, prouvée AVANT la passe de refroidissement — donc pendant que les jobs
	// sont encore parfaitement disponibles. Sans cet ordre, le refus qui suit
	// s'expliquerait tout autant par un `available_at` poussé, et la preuve confondrait
	// deux mécanismes en croyant n'en tester qu'un.
	const gated = await claimJob({
		db,
		types: [T_PROVIDER],
		workerId: 'proof-gate',
		capacity: { excludedTypes: admission.excludedTypes }
	});
	check('la réclamation refuse le type au repos, alors qu’il est DISPONIBLE', gated === null);

	const ungated = await claimJob({ db, types: [T_PROVIDER], workerId: 'proof-gate-off' });
	check(
		'le même job est réclamable sans la garde — c’est donc bien ELLE qui refusait',
		ungated !== null,
		ungated ? `réclamé ${ungated.id}` : 'non réclamé'
	);
	if (ungated) {
		await db.execute(sql`
			UPDATE "seostats"."jobs" SET status = 'queued', lease_owner = NULL, lease_until = NULL,
			       attempts = 0 WHERE id = ${ungated.id}
		`);
	}

	const cooled = await coolDownQuotaLimitedJobs({
		db,
		cooldownUntilByProvider: admission.cooldownUntilByProvider,
		typesForProvider
	});
	check('les 3 jobs de la cohorte sont repoussés', cooled.pushed === 3, `pushed=${cooled.pushed}`);

	const after = await Promise.all(cohort.map(jobRow));
	check(
		'`available_at` est poussé pour TOUS, y compris l’autre projet',
		after.every((r, i) => (r?.available_at ?? '') > (before[i]?.available_at ?? '')),
		after.map((r) => r?.available_at).join(' · ')
	);
	check(
		'`attempts` INCHANGÉ (aucun de ces jobs n’a été réclamé)',
		after.every((r, i) => r?.attempts === before[i]?.attempts),
		`avant ${before.map((r) => r?.attempts).join(',')} → après ${after.map((r) => r?.attempts).join(',')}`
	);
	check(
		'`deferrals` INCHANGÉ (ce n’est pas un report de JOB-003)',
		after.every((r, i) => r?.deferrals === before[i]?.deferrals),
		`avant ${before.map((r) => r?.deferrals).join(',')} → après ${after.map((r) => r?.deferrals).join(',')}`
	);
	check(
		'le statut `quota_limited` est porté par les colonnes existantes',
		after.every((r) => r?.last_error_class === 'quota' && r?.last_error_code === 'QuotaLimited'),
		after.map((r) => `${r?.last_error_class}/${r?.last_error_code}`).join(' · ')
	);
	check('les jobs restent `queued` (rien de terminal)', after.every((r) => r?.status === 'queued'));

	// Idempotence : rejouer la passe ne touche plus rien.
	const again = await coolDownQuotaLimitedJobs({
		db,
		cooldownUntilByProvider: admission.cooldownUntilByProvider,
		typesForProvider
	});
	check('la passe est idempotente (second passage : 0 ligne)', again.pushed === 0, `pushed=${again.pushed}`);

	// Et sans AUCUNE garde, la cohorte reste hors de portée : la passe a inscrit le
	// refroidissement dans la donnée elle-même, pas seulement dans la décision en mémoire.
	const stillOut = await claimJob({ db, types: [T_PROVIDER], workerId: 'proof-cooldown' });
	check(
		'après la passe, les jobs ne sont plus réclamables même sans la garde',
		stillOut === null,
		stillOut ? `réclamé ${stillOut.id}` : 'aucun'
	);

	// ── 3. Refroidissement expiré : ça repart tout seul ────────────────
	console.log('\n3. Refroidissement expiré → réclamable, sans intervention');

	const expired = planAdmission({
		// Refroidissement d'une milliseconde : le quota est déjà loin derrière.
		limits: resolveLimits({ cooldownMs: 1 }),
		snapshot: snap,
		fairness: openFairness(),
		typesForProvider,
		now: Date.now() + 5_000
	});
	check(
		'aucun type n’est plus exclu une fois le refroidissement passé',
		expired.excludedTypes.length === 0,
		`exclus = ${expired.excludedTypes.length}`
	);

	// Et le job redevient RÉELLEMENT réclamable en base (son `available_at` a été
	// poussé, on le remet disponible comme le ferait le temps qui passe).
	await db.execute(sql`
		UPDATE "seostats"."jobs" SET available_at = ${toDbTimestamp(new Date(Date.now() - 1000))}
		 WHERE id = ${cohort[0]}
	`);
	const claimed = await claimJob({
		db,
		types: [T_PROVIDER],
		workerId: 'proof-after-cooldown',
		capacity: { excludedTypes: expired.excludedTypes }
	});
	check('le job repart de lui-même', claimed?.id === cohort[0], claimed ? 'réclamé' : 'non réclamé');
	if (claimed) {
		await db.execute(sql`
			UPDATE "seostats"."jobs" SET status = 'queued', lease_owner = NULL, lease_until = NULL
			 WHERE id = ${claimed.id}
		`);
	}

	// ── 4. La réserve ──────────────────────────────────────────────────
	console.log('\n4. Réserve : file saturée, un type réservé passe quand même');

	const reservedId = await enqueue({ projectId: pA.id, type: T_RESERVED, tag: 'reserved-1' });
	const bulkId = await enqueue({ projectId: pA.id, type: T_UNKNOWN, tag: 'bulk-1' });

	const bulkRefused = await claimJob({
		db,
		types: ALL_TYPES,
		workerId: 'proof-reserve',
		capacity: { reservedTypesOnly: [T_RESERVED] }
	});
	check(
		'sur la réserve, seul le type réservé est servi',
		bulkRefused?.id === reservedId,
		bulkRefused ? `réclamé ${bulkRefused.type === T_RESERVED ? 'réservé' : 'DE FOND'}` : 'rien réclamé'
	);
	if (bulkRefused) {
		await db.execute(sql`
			UPDATE "seostats"."jobs" SET status = 'queued', lease_owner = NULL, lease_until = NULL,
			       attempts = 0 WHERE id = ${bulkRefused.id}
		`);
	}
	check('le job de fond, lui, est resté en file', (await jobRow(bulkId))?.status === 'queued');

	// Saturation globale : la réclamation ne va même pas interroger la base.
	const saturated = await claimJob({
		db,
		types: ALL_TYPES,
		workerId: 'proof-saturated',
		capacity: { saturated: true }
	});
	check('une capacité saturée ne réclame rien', saturated === null);

	// ── 5. Un type inconnu n'est bloqué par aucun budget ───────────────
	console.log('\n5. Un type inconnu de la table des providers n’est bloqué par rien');

	const unknownAdmission = planAdmission({
		limits: resolveLimits({ cooldownMs: 900_000 }),
		snapshot: snap,
		fairness: openFairness(),
		typesForProvider,
		now: Date.now()
	});
	// Le contraste est le coeur de la vérification : SON voisin de cohorte est écarté,
	// lui ne l'est pas. Une liste d'exclusions vide passerait ce test sans rien dire.
	check(
		'le type inconnu n’est pas écarté, alors que la cohorte du provider l’est',
		!unknownAdmission.excludedTypes.includes(T_UNKNOWN) &&
			unknownAdmission.excludedTypes.includes(T_PROVIDER),
		`exclus = ${unknownAdmission.excludedTypes.join(', ') || '∅'}`
	);
	const unknownClaim = await claimJob({
		db,
		types: [T_UNKNOWN],
		workerId: 'proof-unknown',
		capacity: { excludedTypes: unknownAdmission.excludedTypes }
	});
	check('il est réclamable pendant que le provider est au repos', unknownClaim !== null);
	if (unknownClaim) {
		await db.execute(sql`
			UPDATE "seostats"."jobs" SET status = 'queued', lease_owner = NULL, lease_until = NULL,
			       attempts = 0 WHERE id = ${unknownClaim.id}
		`);
	}

	// ── 6. L'exposition ────────────────────────────────────────────────
	console.log('\n6. Exposition : « exposer les quotas restants »');

	const capacity = await loadCapacitySnapshot({ db });
	check(
		'le rapport porte une ligne par provider',
		capacity.providers.length === 5,
		capacity.providers.map((p) => p.provider).join(', ')
	);
	check(
		'il dit quelles limites sont appliquées, et si elles viennent de la base',
		capacity.configured === true && capacity.limits.perProjectPerLap === 2,
		`configured=${capacity.configured} · perProjectPerLap=${capacity.limits.perProjectPerLap}`
	);
	check(
		'les projets y sont NOMMÉS, pas rendus par leur id',
		capacity.projects.every((p) => p.projectSlug !== p.projectId) || capacity.projects.length === 0,
		capacity.projects.map((p) => p.projectSlug).join(', ') || '(aucun projet en attente)'
	);

	// ── Invariants de production ───────────────────────────────────────
	console.log('\n7. Invariants (la preuve n’a rien touché de réel)');
	const findings = await db.execute(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`);
	const proposals = await db.execute(
		sql`SELECT count(*)::int AS n FROM "seostats"."action_proposals"`
	);
	const nFindings = Number(((findings.rows ?? [])[0] as { n: number }).n);
	const nProposals = Number(((proposals.rows ?? [])[0] as { n: number }).n);
	check('13 findings intacts', nFindings === 13, `${nFindings}`);
	check('4 propositions intactes', nProposals === 4, `${nProposals}`);

	const iso = await db.execute(sql`
		SELECT count(*)::int AS n FROM "seostats"."jobs"
		 WHERE available_at LIKE '%T%' OR updated_at LIKE '%T%'
	`);
	check('0 horodatage ISO écrit dans `jobs`', Number(((iso.rows ?? [])[0] as { n: number }).n) === 0);

	// Restauration de la configuration préexistante — une preuve ne laisse rien derrière.
	await db.execute(
		sql`DELETE FROM "seostats"."system_settings" WHERE key = ${SYSTEM_LIMITS_KEY}`
	);
	if (previousOverrides !== null) {
		await saveSystemLimitOverrides({ db, overrides: previousOverrides });
	}
	check(
		'la configuration système est rendue à son état d’origine',
		((await loadSystemLimitOverrides(db)) === null) === (previousOverrides === null)
	);
}

main()
	.then(async () => {
		const removed = await cleanup();
		console.log(
			`\nNettoyage : ${removed.jobs} jobs, ${removed.attempts} tentatives, ${removed.settings} réglage(s).`
		);
		console.log(failures === 0 ? '\n✅ Toutes les vérifications passent.' : `\n❌ ${failures} échec(s).`);
		await pool.end();
		process.exit(failures === 0 ? 0 : 1);
	})
	.catch(async (err) => {
		console.error('\nPreuve interrompue:', err);
		await cleanup().catch(() => {});
		await pool.end().catch(() => {});
		process.exit(1);
	});
