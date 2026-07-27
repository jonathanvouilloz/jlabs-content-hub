/**
 * REP-003 — Preuve de la publication du rapport du lundi (sur Neon).
 *
 * Les règles du modèle (créneau, échéance, statut, SLO, annonce) sont couvertes par vitest
 * (`report-publication-state.test.ts`, 48 tests). Ce qui ne peut PAS se prouver en vitest, et
 * se prouve ici, c'est ce que fait la BASE :
 *
 *   A. la décision sur le parc RÉEL est dérivée des runs du créneau, et une requête
 *      indépendante la reproduit — la préparation n'est pas une opinion du code ;
 *   B. l'attente est BORNÉE : le même créneau, la même base, deux instants → `wait` avant
 *      l'échéance, `publish partial` après. C'est « attendre les steps obligatoires avec
 *      deadline » vérifié de bout en bout ;
 *   C. **un seul rapport logique par semaine** : republier le même créneau — y compris DEUX
 *      publications concurrentes — laisse exactement une ligne, et rend l'id de la première ;
 *   D. **accessible après restart** : relu par une SECONDE connexion, le payload est
 *      identique au bit près, et sa période est ancrée sur le CRÉNEAU (pas sur l'instant de
 *      publication) ;
 *   E. le SLO se DÉRIVE : aucune colonne de verdict n'existe en base, et un rattrapage tardif
 *      est mesuré au lieu d'être masqué ;
 *   F. le run du créneau fait foi : un run hebdo posé sur `period_end = créneau` fait passer
 *      SON projet de `missing` à `waiting` puis à `ready`, sans toucher aux autres — la
 *      jointure porte bien sur le créneau, pas sur « le dernier run hebdo » ;
 *   G. une PAUSE de cadence sort le projet du dénominateur attendu, sans jamais devenir un
 *      bloquant (la même autorité que le scheduler) ;
 *   H. la base est rendue à l'identique.
 *
 * Isolation. Le parc réel n'est JAMAIS publié : tout passe par des créneaux SYNTHÉTIQUES de
 * 1999 (`slotOverride`), donc supprimables par leur seul `period_slot`. Les runs sentinelles
 * portent une clé d'idempotence préfixée `__test_rep003:`. AUCUN projet n'est créé (la FK
 * cross-schéma `projects.slug → core.entities.slug` appartient à `invoices`). Nettoyage dans
 * un `finally` ; un Ctrl-C le saute — vérifier alors `weekly_reports.period_slot LIKE '1999-%'`
 * et `monitoring_runs.idempotency_key LIKE '__test_rep003:%'`.
 *
 * ⚠️ La preuve écrit une PAUSE réelle (§G) le temps de deux lectures, puis supprime ses
 * événements. Sans risque aujourd'hui : le cron `tick` n'est pas déployé (le cockpit n'est pas
 * en prod), donc aucun scheduler concurrent ne peut la lire entre-temps.
 *
 * Lancer : npx tsx scripts/rep-003-publication-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	loadPublishedReport,
	type PublishedReport,
	loadPublishDeadlineMinutes,
	loadSlotReadiness,
	listPublishedReports,
	publishWeeklyReport
} from '../src/lib/server/report-publication.js';
import {
	DEFAULT_PUBLISH_DEADLINE_MINUTES,
	currentPublicationSlot,
	decidePublication,
	summarizeReadiness
} from '../src/lib/server/report-publication-state.js';
import { SCHEDULE_DEFAULTS } from '../src/lib/server/schedule-state.js';
import { recordPauseDecision } from '../src/lib/server/pauses.js';
import { listSchedulableProjects } from '../src/lib/server/scheduler.js';
import { REPORT_SCHEMA_VERSION } from '../src/lib/server/weekly-report-state.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';
import { createId } from '../src/lib/server/utils.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

/**
 * Le rapport d'une ligne publiée. Ces preuves supposent un détail PRÉSENT : depuis REP-004
 * lot 2, `detail` est une union (un détail purgé n'est pas un rapport vide), et une preuve qui
 * le traiterait comme absent se contenterait de comparer du vide à du vide.
 */
function reportOf(published: PublishedReport) {
	if (published.detail.kind !== 'available') {
		throw new Error(
			`détail purgé (${published.periodSlot} rév. ${published.revision}) : cette preuve exige un rapport complet`
		);
	}
	return published.detail.report;
}


let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}
function section(title: string): void {
	console.log('');
	console.log(title);
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Créneaux synthétiques : trois lundis de janvier 1999, 09:00 CET (= 08:00 UTC). */
const SLOT_DEADLINE = { periodSlot: '1999-01-04T09:00', slotAtMs: Date.parse('1999-01-04T08:00:00Z') };
const SLOT_LATE = { periodSlot: '1999-01-11T09:00', slotAtMs: Date.parse('1999-01-11T08:00:00Z') };
const SLOT_RUN = { periodSlot: '1999-01-18T09:00', slotAtMs: Date.parse('1999-01-18T08:00:00Z') };
const SLOT_PAUSE = { periodSlot: '1999-01-25T09:00', slotAtMs: Date.parse('1999-01-25T08:00:00Z') };

const RUN_KEY = '__test_rep003:run';
const PAUSE_REASON = '__test_rep003 : preuve de publication';

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(q);
	return Number((res.rows?.[0] as { n: number }).n);
}

async function cleanup(): Promise<void> {
	await db.execute(
		sql`DELETE FROM "seostats"."weekly_reports" WHERE period_slot LIKE ${'1999-%'}`
	);
	// Les steps d'abord (aucun n'est écrit ici, mais la FK ne pardonne pas une surprise).
	await db.execute(sql`
		DELETE FROM "seostats"."monitoring_steps"
		 WHERE run_id IN (
			SELECT id FROM "seostats"."monitoring_runs" WHERE idempotency_key LIKE ${'__test_rep003:%'}
		 )
	`);
	await db.execute(
		sql`DELETE FROM "seostats"."monitoring_runs" WHERE idempotency_key LIKE ${'__test_rep003:%'}`
	);
	await db.execute(sql`DELETE FROM "seostats"."automation_pauses" WHERE reason = ${PAUSE_REASON}`);
}

async function main(): Promise<void> {
	await cleanup();

	const reportsBefore = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports"`);
	const runsBefore = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."monitoring_runs"`);
	const pausesBefore = await scalar(
		sql`SELECT count(*)::int AS n FROM "seostats"."automation_pauses"`
	);
	const projects = await listSchedulableProjects(db);

	console.log('REP-003 — preuve de publication (Neon)');
	console.log(
		`  état initial : ${reportsBefore} rapport(s) publié(s) · ${runsBefore} run(s) · ${pausesBefore} pause(s) · ${projects.length} projet(s)`
	);

	// ── A. La décision sur le parc réel ──────────────────────────────
	section('§A — la préparation est DÉRIVÉE des runs du créneau (parc réel, aucune écriture)');

	const now = new Date();
	const realSlot = currentPublicationSlot({ now, spec: SCHEDULE_DEFAULTS.weekly });
	check('un créneau hebdo courant existe', realSlot !== null, realSlot?.localSlot ?? '∅');
	if (!realSlot) throw new Error('aucun créneau : cadence hebdo désactivée ?');

	const readiness = await loadSlotReadiness({ db, periodSlot: realSlot.localSlot, now });
	check(
		'un état par projet non archivé, jamais plus jamais moins',
		readiness.length === projects.length,
		`${readiness.length}/${projects.length}`
	);

	// La contre-lecture : les runs hebdo de CE créneau, comptés en SQL, sans passer par le code.
	const runsForSlot = await db.execute(sql`
		SELECT project_id, status FROM "seostats"."monitoring_runs"
		 WHERE run_type = 'weekly' AND period_end = ${realSlot.localSlot}
	`);
	const sqlRuns = (runsForSlot.rows ?? []) as unknown as Array<{ status: string }>;
	const codeRuns = readiness.filter((r) => r.runStatus !== null);
	check(
		'autant de runs vus par le code que par une requête indépendante',
		codeRuns.length === sqlRuns.length,
		`code ${codeRuns.length} · SQL ${sqlRuns.length}`
	);

	const summary = summarizeReadiness({
		periodSlot: realSlot.localSlot,
		deadlineMinutes: DEFAULT_PUBLISH_DEADLINE_MINUTES,
		projects: readiness
	});
	check(
		'expected + paused = tout le parc (aucun projet perdu en route)',
		summary.expected + summary.paused.length === projects.length,
		`attendus ${summary.expected} · suspendus ${summary.paused.length}`
	);
	check(
		'les bloquants sont exactement les projets waiting + missing',
		summary.blockers.length === summary.waiting + summary.missing,
		`bloquants ${summary.blockers.length}`
	);

	const dry = await publishWeeklyReport({ db, dryRun: true });
	check(
		'un dry-run n’écrit RIEN',
		(await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports"`)) ===
			reportsBefore,
		`action ${dry.action} · raison ${dry.reason}`
	);
	// Aujourd'hui, aucun run hebdo n'existe pour le créneau courant (le tick n'est pas déployé) :
	// la décision attendue est donc « attendre » ou « publier partial », jamais « complete ».
	check(
		'sur un parc sans run du créneau, jamais `complete`',
		dry.status !== 'complete',
		`statut ${dry.status ?? 'aucun (attente)'}`
	);

	const deadlineMinutes = await loadPublishDeadlineMinutes(db);
	check(
		'l’échéance vient de system_settings (défaut si la clé est absente)',
		deadlineMinutes === DEFAULT_PUBLISH_DEADLINE_MINUTES,
		`${deadlineMinutes} min`
	);

	// ── B. L'attente est bornée ──────────────────────────────────────
	section('§B — l’attente est BORNÉE par l’échéance (même créneau, deux instants)');

	const beforeDeadline = await publishWeeklyReport({
		db,
		now: new Date(SLOT_DEADLINE.slotAtMs + 30 * MINUTE),
		slotOverride: SLOT_DEADLINE
	});
	check(
		'30 min après le créneau, avec des steps manquants : ATTENTE',
		beforeDeadline.action === 'wait' && beforeDeadline.reason === 'awaiting_steps',
		`${beforeDeadline.action}/${beforeDeadline.reason} · ${beforeDeadline.readiness?.blockers.length ?? 0} bloquant(s)`
	);
	check(
		'l’attente n’écrit rien',
		(await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports"`)) ===
			reportsBefore
	);

	const atDeadline = await publishWeeklyReport({
		db,
		now: new Date(SLOT_DEADLINE.slotAtMs + 61 * MINUTE),
		slotOverride: SLOT_DEADLINE
	});
	check(
		'passée l’échéance, le rapport PART quand même, en partial',
		atDeadline.action === 'publish' &&
			atDeadline.status === 'partial' &&
			atDeadline.reason === 'deadline_reached',
		`${atDeadline.action}/${atDeadline.status}/${atDeadline.reason}`
	);
	check(
		'due_at = créneau + échéance configurée',
		atDeadline.dueAtDb === toDbTimestamp(new Date(SLOT_DEADLINE.slotAtMs + 60 * MINUTE)),
		`${atDeadline.dueAtDb}`
	);
	check(
		'le SLO est MANQUÉ et chiffré (publié 1 min après l’échéance)',
		atDeadline.slo?.met === false && Math.round((atDeadline.slo?.lateMs ?? 0) / MINUTE) === 1,
		`retard ${Math.round((atDeadline.slo?.lateMs ?? 0) / MINUTE)} min`
	);
	check(
		'l’annonce dit la disponibilité ET les incidents (faute de canal, TEL-001)',
		(atDeadline.announcement?.headline.includes('PARTIAL') ?? false) &&
			atDeadline.announcement?.hasIncidents === true,
		atDeadline.announcement?.headline ?? '∅'
	);

	// ── C. Un seul rapport logique par semaine ───────────────────────
	section('§C — UN SEUL rapport logique par semaine (acceptation 1)');

	const again = await publishWeeklyReport({
		db,
		now: new Date(SLOT_DEADLINE.slotAtMs + 5 * HOUR),
		slotOverride: SLOT_DEADLINE
	});
	check(
		'republier le même créneau ne réécrit rien : already_published',
		again.action === 'already_published' && again.reportId === atDeadline.reportId,
		`${again.action} · id ${again.reportId === atDeadline.reportId ? 'identique' : 'DIFFÉRENT'}`
	);
	check(
		'published_at n’a PAS bougé (un rapport publié est clos)',
		again.publishedAtDb === atDeadline.publishedAtDb,
		`${again.publishedAtDb}`
	);

	// Deux publications CONCURRENTES du même créneau : c'est le cas que deux invocations de
	// cron simultanées produiraient. La contrainte tranche, pas la lecture.
	const concurrent = await Promise.all([
		publishWeeklyReport({
			db,
			now: new Date(SLOT_LATE.slotAtMs + 90 * MINUTE),
			slotOverride: SLOT_LATE
		}),
		publishWeeklyReport({
			db,
			now: new Date(SLOT_LATE.slotAtMs + 90 * MINUTE),
			slotOverride: SLOT_LATE
		})
	]);
	const publishedCount = concurrent.filter((r) => r.action === 'publish').length;
	const rowsForLate = await scalar(
		sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports" WHERE period_slot = ${SLOT_LATE.periodSlot}`
	);
	check(
		'deux publications simultanées → UNE seule ligne',
		rowsForLate === 1,
		`${rowsForLate} ligne(s) · ${publishedCount} publication(s) revendiquée(s)`
	);
	check(
		'et l’autre appel rend already_published (jamais une erreur)',
		concurrent.every((r) => r.action === 'publish' || r.action === 'already_published'),
		concurrent.map((r) => r.action).join(' + ')
	);

	// ── D. Accessible après restart ──────────────────────────────────
	section('§D — accessible après restart (seconde connexion, aucune reconstruction)');

	const otherPool = new Pool({ connectionString: process.env.DATABASE_URL });
	const otherDb = drizzle(otherPool, { schema }) as unknown as AppDb;
	let stored;
	try {
		stored = await loadPublishedReport({ db: otherDb, periodSlot: SLOT_DEADLINE.periodSlot });
	} finally {
		await otherPool.end();
	}
	check('le rapport se relit depuis un autre client', stored !== null, stored?.id ?? '∅');
	if (!stored) throw new Error('rapport publié introuvable');

	const rawPayload = await db.execute(sql`
		SELECT payload_json FROM "seostats"."weekly_reports" WHERE period_slot = ${SLOT_DEADLINE.periodSlot}
	`);
	const raw = (rawPayload.rows?.[0] as unknown as { payload_json: string }).payload_json;
	check(
		'le payload relu est IDENTIQUE à celui stocké (aucune régénération)',
		JSON.stringify(reportOf(stored)) === raw,
		`${raw.length} caractères`
	);
	check(
		'le schéma du rapport est versionné dans la ligne ET dans le payload',
		stored.reportSchemaVersion === REPORT_SCHEMA_VERSION &&
			reportOf(stored).schemaVersion === REPORT_SCHEMA_VERSION,
		`v${stored.reportSchemaVersion}`
	);
	check(
		'⭐ la période est ancrée sur le CRÉNEAU, pas sur l’instant de publication',
		reportOf(stored).period.untilDb === stored.slotAt,
		`until ${reportOf(stored).period.untilDb} · slot ${stored.slotAt} · publié ${stored.publishedAt}`
	);
	check(
		'la préparation est relue telle qu’elle a été écrite',
		stored.readiness?.periodSlot === SLOT_DEADLINE.periodSlot,
		`${stored.readiness?.expected ?? '?'} attendus`
	);

	const listed = await listPublishedReports({ db, limit: 5 });
	check(
		'le listing voit les rapports publiés, sans charger leur payload',
		listed.some((r) => r.periodSlot === SLOT_DEADLINE.periodSlot) &&
			!('report' in (listed[0] as object)),
		`${listed.length} ligne(s)`
	);

	// ── E. Le SLO se dérive ──────────────────────────────────────────
	section('§E — le SLO est MESURÉ, et dérivé (aucune colonne de verdict)');

	// L'ensemble des colonnes est ÉPINGLÉ : aucun verdict ne peut s'y glisser sans faire tomber
	// cette assertion. Un `LIKE '%slo%'` aurait été trompeur — `period_slot` et `slot_at` le
	// satisfont tous les deux.
	const columnsRes = await db.execute(sql`
		SELECT column_name FROM information_schema.columns
		 WHERE table_schema = 'seostats' AND table_name = 'weekly_reports'
		 ORDER BY column_name
	`);
	const columns = ((columnsRes.rows ?? []) as unknown as Array<{ column_name: string }>).map(
		(r) => r.column_name
	);
	// ⚠️ REP-004 lot 1 en a ajouté TROIS (`revision`, `revision_reason`, `supersedes_id`) et le
	// lot 2 CINQ (`payload_bytes`, `payload_digest`, `payload_archived_at`, `payload_archive_ref`,
	// `payload_purged_at`). Ce sont des faits d'histoire et de rétention, pas des verdicts : le
	// SLO continue de se dériver, et l'épingle garde exactement son rôle — la prochaine colonne
	// devra elle aussi passer par ici.
	const EXPECTED_COLUMNS = [
		'created_at',
		'due_at',
		'id',
		'payload_archive_ref',
		'payload_archived_at',
		'payload_bytes',
		'payload_digest',
		'payload_json',
		'payload_purged_at',
		'period_slot',
		'published_at',
		'readiness_json',
		'report_schema_version',
		'revision',
		'revision_reason',
		'schema_version',
		'slot_at',
		'status',
		'supersedes_id'
	];
	check(
		'l’ensemble des colonnes est exactement celui déclaré (19)',
		JSON.stringify(columns) === JSON.stringify(EXPECTED_COLUMNS),
		`${columns.length} colonne(s)`
	);
	const verdictColumns = ['slo_met', 'slo_status', 'sla_met', 'on_time', 'late_ms', 'latency_ms'];
	check(
		'aucune colonne de VERDICT (slo_met, late_ms…) : le SLO se dérive',
		verdictColumns.every((c) => !columns.includes(c)),
		verdictColumns.filter((c) => columns.includes(c)).join(', ') || 'aucune'
	);
	check(
		'le verdict recalculé à la lecture égale celui de la publication',
		stored.slo.met === atDeadline.slo?.met && stored.slo.lateMs === atDeadline.slo?.lateMs,
		`met ${stored.slo.met} · retard ${Math.round(stored.slo.lateMs / MINUTE)} min`
	);

	// Un rattrapage TARDIF (le mercredi, après une panne du cron) : le rapport existe, et son
	// retard est mesuré au lieu d'être invisible.
	const late = await publishWeeklyReport({
		db,
		now: new Date(SLOT_RUN.slotAtMs + 2 * DAY),
		slotOverride: SLOT_RUN
	});
	check(
		'un rattrapage à J+2 publie quand même',
		late.action === 'publish' && late.status === 'partial',
		`${late.action}/${late.status}`
	);
	check(
		'et son retard est mesuré en heures, pas masqué',
		Math.round((late.slo?.lateMs ?? 0) / HOUR) === 47,
		`${Math.round((late.slo?.lateMs ?? 0) / HOUR)} h de retard · latence ${Math.round((late.slo?.latencyMs ?? 0) / HOUR)} h`
	);

	// ── F. Le run du créneau fait foi ────────────────────────────────
	section('§F — le run de CE créneau fait foi (jointure sur period_end)');

	const target = projects[0];
	if (!target) throw new Error('aucun projet : preuve impossible');

	const runId = createId();
	await db.execute(sql`
		INSERT INTO "seostats"."monitoring_runs"
			(id, project_id, run_type, period_end, status, idempotency_key, triggered_by, created_at, updated_at)
		VALUES (${runId}, ${target.id}, 'weekly', ${SLOT_PAUSE.periodSlot}, 'running',
		        ${RUN_KEY}, 'schedule', ${toDbTimestamp()}, ${toDbTimestamp()})
	`);

	const withRunning = await loadSlotReadiness({
		db,
		periodSlot: SLOT_PAUSE.periodSlot,
		now: new Date(SLOT_PAUSE.slotAtMs + 10 * MINUTE)
	});
	const targetState = (rows: typeof withRunning) =>
		rows.find((r) => r.projectSlug === target.slug);
	check(
		'un run `running` sur ce créneau met SON projet en attente',
		targetState(withRunning)?.runStatus === 'running' &&
			targetState(withRunning)?.runId === runId,
		`${targetState(withRunning)?.runStatus}`
	);
	check(
		'les autres projets restent sans run (aucun débordement)',
		withRunning.filter((r) => r.runStatus !== null).length === 1,
		`${withRunning.filter((r) => r.runStatus !== null).length} run(s) vu(s)`
	);

	const runningDecision = decidePublication({
		periodSlot: SLOT_PAUSE.periodSlot,
		slotAtMs: SLOT_PAUSE.slotAtMs,
		now: SLOT_PAUSE.slotAtMs + 10 * MINUTE,
		deadlineMinutes: DEFAULT_PUBLISH_DEADLINE_MINUTES,
		projects: withRunning,
		alreadyPublished: false
	});
	check(
		'la décision attend, et nomme ses bloquants',
		runningDecision.action === 'wait' && runningDecision.readiness.blockers.includes(target.slug),
		`${runningDecision.readiness.blockers.length} bloquant(s)`
	);

	await db.execute(
		sql`UPDATE "seostats"."monitoring_runs" SET status = 'success' WHERE id = ${runId}`
	);
	const withSuccess = await loadSlotReadiness({
		db,
		periodSlot: SLOT_PAUSE.periodSlot,
		now: new Date(SLOT_PAUSE.slotAtMs + 20 * MINUTE)
	});
	check(
		'le run passé en `success` rend le projet prêt — sans une ligne de code de plus',
		targetState(withSuccess)?.runStatus === 'success',
		`${targetState(withSuccess)?.runStatus}`
	);
	// Un run posé sur un AUTRE créneau ne doit pas compter : la preuve en est que le créneau
	// voisin (§B, même projet, même run_type) n'a jamais vu ce run.
	const neighbour = await loadSlotReadiness({
		db,
		periodSlot: SLOT_DEADLINE.periodSlot,
		now: new Date(SLOT_DEADLINE.slotAtMs)
	});
	check(
		'⭐ ce run n’existe PAS pour le créneau voisin (pas de « dernier run hebdo »)',
		neighbour.every((r) => r.runId !== runId),
		`${neighbour.filter((r) => r.runStatus !== null).length} run(s) sur le créneau voisin`
	);

	// ── G. La pause sort du dénominateur ─────────────────────────────
	section('§G — une pause de cadence ÉCARTE du périmètre attendu (jamais un bloquant)');

	const beforePause = summarizeReadiness({
		periodSlot: SLOT_LATE.periodSlot,
		deadlineMinutes: DEFAULT_PUBLISH_DEADLINE_MINUTES,
		projects: await loadSlotReadiness({ db, periodSlot: SLOT_LATE.periodSlot, now: new Date() })
	});

	await recordPauseDecision({
		db,
		target: { scope: 'project_cadence', projectId: target.id, cadence: 'weekly' },
		eventType: 'paused',
		reason: PAUSE_REASON,
		actor: 'system'
	});

	const afterPause = summarizeReadiness({
		periodSlot: SLOT_LATE.periodSlot,
		deadlineMinutes: DEFAULT_PUBLISH_DEADLINE_MINUTES,
		projects: await loadSlotReadiness({ db, periodSlot: SLOT_LATE.periodSlot, now: new Date() })
	});
	check(
		'le projet suspendu quitte le dénominateur attendu',
		afterPause.expected === beforePause.expected - 1,
		`${beforePause.expected} → ${afterPause.expected} attendus`
	);
	check(
		'il est NOMMÉ dans les écartés, et absent des bloquants',
		afterPause.paused.includes(target.slug) && !afterPause.blockers.includes(target.slug),
		`écartés : ${afterPause.paused.join(', ') || '∅'}`
	);
	check(
		'il ne compte pas comme incident (une décision n’est pas une panne)',
		afterPause.incidents.every((i) => i.projectSlug !== target.slug),
		`${afterPause.incidents.length} incident(s)`
	);

	// ── H. Base rendue à l'identique ─────────────────────────────────
	section('§H — la base est rendue à l’identique');

	await cleanup();

	const reportsAfter = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports"`);
	const runsAfter = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."monitoring_runs"`);
	const pausesAfter = await scalar(
		sql`SELECT count(*)::int AS n FROM "seostats"."automation_pauses"`
	);
	const tables = await scalar(sql`
		SELECT count(*)::int AS n FROM information_schema.tables
		 WHERE table_schema = 'seostats' AND table_type = 'BASE TABLE'
	`);

	check('rapports publiés', reportsAfter === reportsBefore, `${reportsBefore} → ${reportsAfter}`);
	check('runs', runsAfter === runsBefore, `${runsBefore} → ${runsAfter}`);
	check('pauses', pausesAfter === pausesBefore, `${pausesBefore} → ${pausesAfter}`);
	check('tables seostats', tables === 61, `${tables}`);
}

main()
	.catch(async (err) => {
		console.error('');
		console.error('Preuve interrompue :', err);
		failures += 1;
	})
	.finally(async () => {
		// Filet : même en cas d'échec au milieu, la base ne garde rien de la preuve.
		await cleanup().catch((err) => {
			console.error('Nettoyage échoué (à faire à la main) :', err);
			failures += 1;
		});
		console.log('');
		console.log(failures === 0 ? '✅ REP-003 : preuve complète.' : `❌ ${failures} échec(s).`);
		await pool.end();
		process.exitCode = failures === 0 ? 0 : 1;
	});
