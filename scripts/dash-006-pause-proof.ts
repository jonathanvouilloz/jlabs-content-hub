/**
 * DASH-006 lot 2 — Preuve des pauses d'automatisation (sur Neon).
 *
 * Les règles de dérivation sont couvertes par vitest (`pause-state.test.ts`, 40 tests,
 * `automations-state.test.ts` et `job-limits.test.ts` pour le verdict et la garde —
 * sans base ni horloge). Ce qui ne peut PAS s'y prouver, et se prouve ici, c'est ce que
 * fait la BASE :
 *
 *   A. le journal est APPEND-ONLY et l'idempotence vit dans la transaction : deux gestes
 *      identiques n'écrivent qu'une ligne, et le second se déclare `idempotent` ;
 *   B. une pause de cadence empêche RÉELLEMENT `planDueJobs` d'ouvrir le run du créneau.
 *      **Contre-épreuve** : la reprise le fait repartir, sur le même créneau, sans qu'une
 *      ligne de journal de plus soit nécessaire ;
 *   C. **LE point du lot** : une pause `provider=gsc` fait sauter les collecteurs GSC ET
 *      leurs dépendants OBLIGATOIRES, mais LAISSE PARTIR ce qui n'en dépend pas
 *      (`findings:lifecycle`, `propose:actions`). Le run vaut `partial`, pas `failed` ;
 *   D. une échéance ÉCHUE lève la pause sans qu'AUCUNE ligne ne soit écrite — l'expiration
 *      est dérivée, pas un état à réconcilier (compté avant/après) ;
 *   E. une pause de PROJET n'est pas levée par la reprise d'une de ses cadences, et
 *      l'écran nomme la bonne cause (`pauseScope = 'project'`).
 *
 * Isolation. Un projet sentinelle est créé, avec ses runs, ses jobs et ses lignes de
 * journal — un projet À PART parce que les pauses écrites sur un projet réel modifieraient
 * sa planification de production, et qu'une pause oubliée est un monitoring muet, exactement
 * ce que ce lot combat.
 *
 * ⚠️ Son slug ne peut PAS être inventé : `projects.slug` porte une FK cross-schéma vers
 * `core.entities.slug`, registre canonique possédé par `invoices` — que seo-stats ne modifie
 * jamais (loi n°3). On EMPRUNTE donc un slug déjà déclaré dans `core` mais sans projet SEO
 * (il en existe trois : des clients facturés sans suivi SEO). Garde : si un projet réel porte
 * déjà ce slug, la preuve S'ARRÊTE au lieu d'y toucher — et le nettoyage ne supprime que la
 * ligne créée ici, par son id, jamais par son slug.
 *
 * Nettoyage ENFANTS D'ABORD dans un `finally` : job_attempts → monitoring_steps → jobs →
 * monitoring_runs → automation_pauses → projects. Un Ctrl-C SAUTE ce nettoyage : chercher
 * alors le projet nommé « PREUVE DASH-006 — à supprimer », et les `automation_pauses`
 * d'`actor = 'system:proof'`.
 *
 * ⚠️ Les pauses PROVIDER sont globales par nature : la section C en pose une vraie sur
 * `gsc`, et la lève systématiquement — y compris en cas d'exception (`finally`). Elle est
 * posée sur une fenêtre de quelques secondes, hors des heures de tick (le cron est de
 * toute façon absent de `main`, cf. cutover Phase 5A).
 *
 * Lancer : npx tsx scripts/dash-006-pause-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { loadPauseStates, listPauseJournal, recordPauseDecision } from '../src/lib/server/pauses.js';
import { resolveCadencePause, resolveJobPause } from '../src/lib/server/pause-state.js';
import { settlePausedJobs } from '../src/lib/server/jobs-pause.js';
import { settleBlockedJobs } from '../src/lib/server/jobs-graph.js';
import { planDueJobs } from '../src/lib/server/scheduler.js';
import { loadCadenceRows } from '../src/lib/server/automations.js';
import { classifyRunOutcome } from '../src/lib/server/monitoring-state.js';
import { BUSINESS_TIMEZONE } from '../src/lib/server/schedule-state.js';
import { toDbTimestamp, toDbTimestampPlus } from '../src/lib/server/timestamps.js';
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
function skip(label: string, why: string): void {
	console.log(`  ⏭️  ${label} — NON PROUVÉ : ${why}`);
	skipped += 1;
}
function section(title: string): void {
	console.log('');
	console.log(title);
}

/** Nom sans ambiguïté : s'il survit à un Ctrl-C, il se dénonce lui-même. */
const SENTINEL_NAME = 'PREUVE DASH-006 — à supprimer';
const ACTOR = 'system:proof';

/** Renseigné au démarrage : un slug de `core.entities` sans projet SEO. */
let SENTINEL_SLUG = '';
/** Id de la ligne créée ICI. Le nettoyage ne touche QUE celle-là. */
let SENTINEL_ID = '';

/**
 * Catalogue de substitution : la chaîne GSC en miniature, sans toucher la production.
 *
 * ⚠️ UNIQUEMENT sur `weekly`. Le câbler sur toutes les cadences enfilerait aussi les
 * créneaux horaires de la fenêtre de rattrapage — 200 occurrences pour une preuve qui en
 * veut une, et surtout des occurrences NON suspendues qui feraient échouer l'assertion B
 * en ayant parfaitement raison.
 */
const PROOF_CATALOG = [
	{ jobType: 'collect:gsc_query_page', priority: 12 },
	// Dépendant OBLIGATOIRE du collecteur : c'est lui qui doit sauter par propagation.
	{ jobType: 'detect:keyword_opportunity', priority: 10, dependsOn: [{ jobType: 'collect:gsc_query_page' }] },
	// Provider `none` : il ne dépend d'aucun réseau et doit rester INTACT.
	{ jobType: 'findings:lifecycle', priority: 5 }
];

const proofCatalog = (cadence: string) => (cadence === 'weekly' ? PROOF_CATALOG : []);

/**
 * Nettoyage. Scopé par l'ID créé ici, JAMAIS par le slug : le slug est emprunté au registre
 * canonique, et un `DELETE … WHERE slug = …` effacerait le projet d'un vrai client si
 * quelqu'un l'avait créé entre-temps.
 *
 * Les pauses sont en revanche supprimées par `actor` : la pause PROVIDER de la section C
 * n'appartient à aucun projet (c'est tout son objet), et n'a donc pas d'autre prise.
 */
async function cleanup(): Promise<void> {
	// Les pauses d'abord : elles ne dépendent pas du projet, et ce sont elles qui, oubliées,
	// feraient le plus de dégâts (un provider suspendu coupe tous les projets).
	await db.execute(sql`DELETE FROM "seostats"."automation_pauses" WHERE actor = ${ACTOR}`);
	if (!SENTINEL_ID) return;

	// Puis les ENFANTS D'ABORD.
	await db.execute(sql`
		DELETE FROM "seostats"."job_attempts" WHERE project_id = ${SENTINEL_ID}
	`);
	await db.execute(sql`
		DELETE FROM "seostats"."monitoring_steps"
		 WHERE run_id IN (
			SELECT id FROM "seostats"."monitoring_runs" WHERE project_id = ${SENTINEL_ID}
		 )
	`);
	await db.execute(sql`DELETE FROM "seostats"."jobs" WHERE project_id = ${SENTINEL_ID}`);
	await db.execute(sql`
		DELETE FROM "seostats"."monitoring_runs" WHERE project_id = ${SENTINEL_ID}
	`);
	await db.execute(sql`
		DELETE FROM "seostats"."automation_pauses" WHERE project_id = ${SENTINEL_ID}
	`);
	await db.execute(sql`DELETE FROM "seostats"."projects" WHERE id = ${SENTINEL_ID}`);
}

/** Compte les lignes du journal — sert aux assertions « rien n'a été écrit ». */
async function journalCount(): Promise<number> {
	const res = await db.execute(sql`
		SELECT count(*)::int AS n FROM "seostats"."automation_pauses" WHERE actor = ${ACTOR}
	`);
	return Number((res.rows?.[0] as { n: number } | undefined)?.n ?? 0);
}

async function jobStatus(projectId: string, type: string): Promise<string | null> {
	const res = await db.execute(sql`
		SELECT status FROM "seostats"."jobs"
		 WHERE project_id = ${projectId} AND type = ${type}
		 ORDER BY created_at DESC LIMIT 1
	`);
	return ((res.rows?.[0] as { status: string } | undefined)?.status) ?? null;
}

async function main(): Promise<void> {
	const now = new Date();
	console.log(`DASH-006 lot 2 — preuve pauses · ${now.toISOString()} · TZ ${BUSINESS_TIMEZONE}`);

	// Projet sentinelle. Le slug est EMPRUNTÉ à `core.entities` (registre possédé par
	// `invoices`, jamais modifié depuis ici) parmi ceux qui n'ont pas encore de projet SEO.
	await db.execute(sql`DELETE FROM "seostats"."automation_pauses" WHERE actor = ${ACTOR}`);
	const free = await db.execute(sql`
		SELECT e.slug
		  FROM "core"."entities" e
		  LEFT JOIN "seostats"."projects" p ON p.slug = e.slug
		 WHERE p.id IS NULL
		 ORDER BY e.slug
		 LIMIT 1
	`);
	SENTINEL_SLUG = ((free.rows?.[0] as { slug: string } | undefined)?.slug) ?? '';
	if (!SENTINEL_SLUG) {
		console.error(
			'\n❌ Aucun slug libre dans `core.entities` : tous ont déjà un projet SEO.\n' +
				'   Cette preuve a besoin d’un projet À PART — écrire des pauses sur un projet réel\n' +
				'   modifierait sa planification de production.'
		);
		failures += 1;
		return;
	}
	console.log(`  (projet sentinelle sur le slug libre « ${SENTINEL_SLUG} »)`);

	SENTINEL_ID = createId();
	try {
		await db.execute(sql`
			INSERT INTO "seostats"."projects" (id, name, slug, color, access_token, archived, created_at)
			VALUES (${SENTINEL_ID}, ${SENTINEL_NAME}, ${SENTINEL_SLUG}, '#000000',
			        ${createId()}, false, ${toDbTimestamp(new Date(Date.now() - 90 * 24 * 3600_000))})
		`);
	} catch (err) {
		SENTINEL_ID = ''; // rien créé : le nettoyage ne doit toucher à rien.
		console.error(
			'\n❌ Création du projet sentinelle impossible :',
			err instanceof Error ? err.message : err
		);
		failures += 1;
		return;
	}
	const projectId = SENTINEL_ID;

	// ── A. Journal append-only & idempotence transactionnelle ────────
	section('A. Le journal est append-only, l’idempotence vit dans la transaction');

	const before = await journalCount();
	const first = await recordPauseDecision({
		db,
		target: { scope: 'project_cadence', projectId, cadence: 'weekly' },
		eventType: 'paused',
		reason: 'preuve A — première décision',
		actor: ACTOR
	});
	const second = await recordPauseDecision({
		db,
		target: { scope: 'project_cadence', projectId, cadence: 'weekly' },
		eventType: 'paused',
		reason: 'preuve A — geste répété',
		actor: ACTOR
	});
	const afterTwo = await journalCount();

	check('la première décision écrit une ligne', first.idempotent === false);
	check(
		'la seconde est un NON-ÉVÉNEMENT (pas une erreur)',
		second.idempotent === true,
		`eventId rendu : ${second.eventId === first.eventId ? 'celui de la décision en vigueur' : 'AUTRE'}`
	);
	check(
		'…et rien de plus n’est écrit : double clic = 1 seule ligne d’audit',
		afterTwo - before === 1,
		`${afterTwo - before} ligne(s)`
	);

	const journal = await listPauseJournal({ db, projectId, limit: 10 });
	check(
		'la ligne porte sa cause et son auteur',
		journal[0]?.reason === 'preuve A — première décision' && journal[0]?.actor === ACTOR,
		`${journal[0]?.actor} — « ${journal[0]?.reason} »`
	);

	// ── B. La pause éteint la planification, la reprise la rallume ───
	section('B. Une cadence suspendue n’ouvre plus son run (contre-épreuve : la reprise)');

	const pausedPlan = await planDueJobs({
		db,
		now,
		onlyProjectSlug: SENTINEL_SLUG,
		catalog: proofCatalog,
		lookbackMs: 8 * 24 * 3600_000 // large : le créneau hebdo tombe forcément dedans.
	});
	check(
		'aucune occurrence planifiée pendant la pause',
		pausedPlan.counters.occurrences === 0,
		`${pausedPlan.counters.occurrences} occurrence(s)`
	);
	check(
		'…et la cadence est ANNONCÉE écartée, jamais tue',
		pausedPlan.pausedCadences.some((c) => c.slug === SENTINEL_SLUG && c.cadence === 'weekly'),
		JSON.stringify(pausedPlan.pausedCadences.map((c) => `${c.slug}/${c.cadence}`))
	);

	const rowsPaused = await loadCadenceRows({ db, now, projectSlug: SENTINEL_SLUG });
	const weeklyPaused = rowsPaused.find((r) => r.cadence === 'weekly');
	check(
		'l’écran la lit « paused », et pas « missed »',
		weeklyPaused?.verdict.health === 'paused',
		String(weeklyPaused?.verdict.health)
	);
	check(
		'…et n’annonce AUCUNE prochaine exécution',
		weeklyPaused?.nextSlot === null,
		String(weeklyPaused?.nextSlot)
	);

	await recordPauseDecision({
		db,
		target: { scope: 'project_cadence', projectId, cadence: 'weekly' },
		eventType: 'resumed',
		reason: 'preuve B — contre-épreuve',
		actor: ACTOR
	});
	const resumedPlan = await planDueJobs({
		db,
		now,
		onlyProjectSlug: SENTINEL_SLUG,
		catalog: proofCatalog,
		lookbackMs: 8 * 24 * 3600_000
	});
	check(
		'CONTRE-ÉPREUVE : après reprise, le créneau repart',
		resumedPlan.counters.occurrences > 0 && resumedPlan.counters.runsCreated > 0,
		`${resumedPlan.counters.occurrences} occurrence(s), ${resumedPlan.counters.jobsCreated} job(s)`
	);

	// ── C. LE point du lot : provider suspendu ≠ run annulé ──────────
	section('C. Une pause provider saute ses jobs — et LAISSE PARTIR les autres steps');

	if (resumedPlan.counters.jobsCreated === 0) {
		skip('propagation du skip', 'aucun job n’a été mis en file par la section B');
	} else {
		await recordPauseDecision({
			db,
			target: { scope: 'provider', provider: 'gsc' },
			eventType: 'paused',
			reason: 'preuve C — coupure provider',
			actor: ACTOR
		});

		try {
			const states = await loadPauseStates(db, now);
			check(
				'le collecteur GSC est jugé suspendu',
				resolveJobPause({ states, projectId, jobType: 'collect:gsc_query_page', runType: 'weekly' })
					.paused === true
			);
			check(
				'…mais `findings:lifecycle` ne l’est PAS (provider `none`)',
				resolveJobPause({ states, projectId, jobType: 'findings:lifecycle', runType: 'weekly' })
					.paused === false
			);
			check(
				'…et la CADENCE, elle, reste planifiable : une pause provider ne suspend aucun cadran',
				resolveCadencePause({ states, projectId, cadence: 'weekly' }).paused === false
			);

			// La passe de pause, puis celle des dépendances — dans l'ordre du worker.
			const pauseRes = await settlePausedJobs({ db, limit: 50, now });
			const settleRes = await settleBlockedJobs({ db, limit: 50, now });

			const collectStatus = await jobStatus(projectId, 'collect:gsc_query_page');
			const detectStatus = await jobStatus(projectId, 'detect:keyword_opportunity');
			const lifecycleStatus = await jobStatus(projectId, 'findings:lifecycle');

			check(
				'le collecteur GSC est CONCLU (skipped), pas laissé en file',
				collectStatus === 'skipped',
				`statut ${collectStatus} · ${pauseRes.skipped.length} job(s) sautés par la passe`
			);
			check(
				'son dépendant OBLIGATOIRE saute par propagation JOB-004',
				detectStatus === 'skipped',
				`statut ${detectStatus} · ${settleRes.skipped.length} propagé(s)`
			);
			check(
				'⭐ `findings:lifecycle` reste INTACT — l’acceptation du lot, littéralement',
				lifecycleStatus === 'queued',
				`statut ${lifecycleStatus}`
			);

			// La trace : un job sauté sans ligne de journal serait un trou dans l'audit.
			const attempts = await db.execute(sql`
				SELECT count(*)::int AS n FROM "seostats"."job_attempts"
				 WHERE project_id = ${projectId} AND error_code = 'PausedByOperator'
			`);
			check(
				'chaque skip laisse sa trace dans `job_attempts`',
				Number((attempts.rows?.[0] as { n: number } | undefined)?.n ?? 0) >= 1,
				`${(attempts.rows?.[0] as { n: number } | undefined)?.n} ligne(s)`
			);

			// Le run : `partial`, jamais `failed`. Un skip n'est pas un échec.
			const steps = await db.execute(sql`
				SELECT s.status FROM "seostats"."monitoring_steps" s
				  JOIN "seostats"."monitoring_runs" r ON r.id = s.run_id
				 WHERE r.project_id = ${projectId}
			`);
			const statuses = ((steps.rows ?? []) as unknown as Array<{ status: string }>).map(
				(s) => s.status
			);
			const outcome = classifyRunOutcome(statuses);
			// L'affirmation honnête : une pause ne peut pas transformer un run en ÉCHEC.
			// Elle n'a rien raté — on lui a retiré l'autorisation de partir.
			check(
				'le run n’est JAMAIS `failed` : une décision n’est pas une panne',
				outcome !== 'failed',
				`steps ${JSON.stringify(statuses)} → ${outcome}`
			);

			// Rejouable : une seconde passe ne réécrit rien.
			const replay = await settlePausedJobs({ db, limit: 50, now });
			check(
				'la passe est REJOUABLE : au second tour, plus rien à conclure',
				replay.skipped.length === 0,
				`${replay.skipped.length} skip(s)`
			);
		} finally {
			// La pause provider est GLOBALE : elle est levée quoi qu'il arrive.
			await recordPauseDecision({
				db,
				target: { scope: 'provider', provider: 'gsc' },
				eventType: 'resumed',
				reason: 'preuve C — fin de preuve, provider rendu',
				actor: ACTOR
			});
			const after = await loadPauseStates(db, new Date());
			check(
				'le provider est bien rendu à la fin de la section',
				resolveJobPause({ states: after, projectId, jobType: 'collect:gsc_query_page' }).paused ===
					false
			);
		}
	}

	// ── D. L'expiration est DÉRIVÉE, pas écrite ──────────────────────
	section('D. Une échéance échue lève la pause sans qu’aucune ligne ne bouge');

	await recordPauseDecision({
		db,
		target: { scope: 'project_cadence', projectId, cadence: 'daily' },
		eventType: 'paused',
		reason: 'preuve D — pause à échéance',
		until: toDbTimestampPlus(60_000), // +1 min : future à la pose…
		actor: ACTOR
	});
	const countBeforeExpiry = await journalCount();

	const duringStates = await loadPauseStates(db, now);
	check(
		'avant l’échéance, la cadence est suspendue',
		resolveCadencePause({ states: duringStates, projectId, cadence: 'daily' }).paused === true
	);

	// … et périmée si on lit une minute plus tard. Aucune horloge n'est avancée : c'est le
	// `now` de LECTURE qui change, ce qui est précisément le point.
	const laterStates = await loadPauseStates(db, new Date(Date.now() + 120_000));
	const countAfterExpiry = await journalCount();
	check(
		'passé l’échéance, elle ne l’est plus',
		resolveCadencePause({ states: laterStates, projectId, cadence: 'daily' }).paused === false
	);
	check(
		'⭐ …et AUCUNE ligne n’a été écrite pour ça : l’expiration est dérivée',
		countAfterExpiry === countBeforeExpiry,
		`${countBeforeExpiry} → ${countAfterExpiry}`
	);

	// ── E. Portées : une reprise ne lève que la sienne ───────────────
	section('E. Reprendre une cadence ne dégèle pas le projet');

	await recordPauseDecision({
		db,
		target: { scope: 'project_cadence', projectId, cadence: 'weekly' },
		eventType: 'paused',
		reason: 'preuve E — pause fine',
		actor: ACTOR
	});
	await recordPauseDecision({
		db,
		target: { scope: 'project', projectId },
		eventType: 'paused',
		reason: 'preuve E — gel du projet',
		actor: ACTOR
	});
	await recordPauseDecision({
		db,
		target: { scope: 'project_cadence', projectId, cadence: 'weekly' },
		eventType: 'resumed',
		reason: 'preuve E — on lève la fine seulement',
		actor: ACTOR
	});

	const scopedStates = await loadPauseStates(db, new Date());
	const verdict = resolveCadencePause({ states: scopedStates, projectId, cadence: 'weekly' });
	check('la cadence reste suspendue', verdict.paused === true);
	check(
		'⭐ …et la cause NOMMÉE est le gel du projet, pas la pause levée',
		verdict.by?.target.scope === 'project',
		`scope ${verdict.by?.target.scope} — « ${verdict.by?.reason} »`
	);

	const rowsScoped = await loadCadenceRows({ db, now: new Date(), projectSlug: SENTINEL_SLUG });
	const weeklyScoped = rowsScoped.find((r) => r.cadence === 'weekly');
	check(
		'l’écran le sait aussi : `pauseScope = project` (donc pas de bouton « Reprendre » ici)',
		weeklyScoped?.pauseScope === 'project',
		String(weeklyScoped?.pauseScope)
	);
	check(
		'toutes les cadences du projet sont couvertes par le gel',
		rowsScoped.filter((r) => r.wired && r.spec.enabled).every((r) => r.verdict.health === 'paused'),
		rowsScoped.map((r) => `${r.cadence}:${r.verdict.health}`).join(' ')
	);
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
		? `✅ DASH-006 lot 2 — toutes les assertions passent${skipped > 0 ? ` (${skipped} non prouvée(s), voir ci-dessus)` : ''}`
		: `❌ DASH-006 lot 2 — ${failures} échec(s)`
);
process.exit(failures === 0 ? 0 : 1);
