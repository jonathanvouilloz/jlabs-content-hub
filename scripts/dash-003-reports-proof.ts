/**
 * DASH-003 lot 2 chantier 3 — Preuve de l'écran Rapports (sur Neon).
 *
 * Les règles de projection (absence vs zéro, troncature, créneau local, angles morts) sont
 * couvertes par vitest (`report-read-state.test.ts`, 24 tests). Ce qui ne peut PAS se prouver
 * en vitest, et se prouve ici, c'est ce que fait la BASE :
 *
 *   A. l'écran ne RECONSTRUIT rien : la vue rendue est identique au `payload_json` archivé,
 *      relu par une seconde connexion — et deux lectures à deux instants rendent la même vue ;
 *   B. **« absent » n'est pas « zéro »** sur un rapport RÉEL : les sections que le parc ne peut
 *      pas remplir n'ont aucun champ où un `0` pourrait vivre. Contre-épreuve incluse ;
 *   C. le SLO se DÉRIVE : aucune colonne de verdict n'existe en base, et deux créneaux publiés
 *      avec deux échéances différentes rendent deux verdicts pour le même retard ;
 *   D. la troncature est DITE avec le total réel, et seulement quand il y a troncature ;
 *   E. un créneau inconnu rend `null` (donc 404) — jamais une page vide ;
 *   F. la liste ne charge AUCUN payload (douze rapports complets pour douze dates) ;
 *   G. la liste et le détail s'accordent : une seule autorité (`toMeta`) sur statut et SLO ;
 *   H. « aucun rapport publié » est un ÉTAT, distinct d'une liste vide ;
 *   I. la base est rendue à l'identique.
 *
 * Isolation. Le rapport réel de la semaine n'est JAMAIS publié : tout passe par des créneaux
 * SYNTHÉTIQUES de 1998 (`slotOverride`), supprimables par leur seul `period_slot`. Aucun projet,
 * aucun run, aucune pause n'est créé. Nettoyage dans un `finally` ; un Ctrl-C le saute — vérifier
 * alors `weekly_reports.period_slot LIKE '1998-%'`.
 *
 * ⚠️ **Ne PAS piper ce script dans `head`** : le SIGPIPE tue le process avant le `finally`, et
 * laisse les rapports synthétiques en base. Utiliser `tail`, qui lit tout.
 *
 * Lancer : npx tsx scripts/dash-003-reports-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	listPublishedReports,
	loadPublishedReport,
	publishWeeklyReport
} from '../src/lib/server/report-publication.js';
import {
	buildReportView,
	describeReportsFreshness,
	summarizeReportList
} from '../src/lib/server/report-read-state.js';
import { dbTimestampToMs } from '../src/lib/server/timestamps.js';

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

const MINUTE = 60 * 1000;

/** Créneaux synthétiques : deux lundis de janvier 1998, 09:00 CET (= 08:00 UTC). */
const SLOT_A = { periodSlot: '1998-01-05T09:00', slotAtMs: Date.parse('1998-01-05T08:00:00Z') };
const SLOT_B = { periodSlot: '1998-01-12T09:00', slotAtMs: Date.parse('1998-01-12T08:00:00Z') };
const SLOT_ABSENT = '1998-12-28T09:00';

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(q);
	return Number((res.rows?.[0] as { n: number }).n);
}

async function cleanup(): Promise<void> {
	await db.execute(sql`DELETE FROM "seostats"."weekly_reports" WHERE period_slot LIKE ${'1998-%'}`);
}

async function main(): Promise<void> {
	await cleanup();

	const reportsBefore = await scalar(
		sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports"`
	);
	const tablesBefore = await scalar(
		sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'seostats'`
	);

	console.log('DASH-003 lot 2 ch.3 — preuve de l’écran Rapports (Neon)');
	console.log(`  état initial : ${reportsBefore} rapport(s) publié(s) · ${tablesBefore} tables`);

	// Un rapport réel, publié sur un créneau synthétique : le CONTENU vient du parc (REP-001
	// construit sur les vraies observations), seule sa date de créneau est fabriquée.
	//
	// ⚠️ Publié APRÈS l'échéance, et il ne peut pas en être autrement : aucun projet n'a de run
	// hebdo sur un créneau de 1998, donc les neuf sont bloquants et la publication attend jusqu'à
	// `deadline_reached`. Le rapport part alors en `partial` — c'est le chemin nominal de REP-003
	// sur un parc dont la collecte n'a pas tourné, pas un artefact de la preuve.
	const publishedA = await publishWeeklyReport({
		db,
		now: new Date(SLOT_A.slotAtMs + 61 * MINUTE),
		deadlineMinutes: 60,
		slotOverride: SLOT_A
	});
	if (publishedA.action !== 'publish') {
		throw new Error(`le créneau synthétique n’a pas publié : ${publishedA.action}/${publishedA.reason}`);
	}

	// ── A. Aucune reconstruction ─────────────────────────────────────
	section('§A — l’écran ne RECONSTRUIT rien : la vue est le payload archivé');

	const loaded = await loadPublishedReport({ db, periodSlot: SLOT_A.periodSlot });
	check('le rapport publié se relit', loaded !== null, loaded?.periodSlot ?? '∅');
	if (!loaded) throw new Error('rapport introuvable après publication');

	// Le JSON brut, lu SANS passer par le code de lecture : c'est la référence.
	const rawRow = await db.execute(sql`
		SELECT payload_json FROM "seostats"."weekly_reports" WHERE period_slot = ${SLOT_A.periodSlot}
	`);
	const rawPayload = (rawRow.rows?.[0] as { payload_json: string }).payload_json;
	const rawReport = JSON.parse(rawPayload) as { sections: Array<{ key: string }>; headline: string };

	const view = buildReportView({
		periodSlot: loaded.periodSlot,
		status: loaded.status,
		publishedAt: loaded.publishedAt,
		reportSchemaVersion: loaded.reportSchemaVersion,
		slo: loaded.slo,
		readiness: loaded.readiness,
		report: loaded.report
	});

	check(
		'les sections de la vue sont celles du JSON, DANS SON ORDRE',
		JSON.stringify(view.sections.map((s) => s.key)) ===
			JSON.stringify(rawReport.sections.map((s) => s.key)),
		`${view.sections.length} sections`
	);
	check('la phrase d’en-tête est recopiée, jamais réécrite', view.headline === rawReport.headline);

	// Le déterminisme : la vue ne dépend d'aucune horloge. Deux constructions à deux instants
	// (et depuis deux lectures distinctes) doivent être identiques au bit près — sans quoi
	// « accessible après restart » ne voudrait rien dire.
	const reloaded = await loadPublishedReport({ db, periodSlot: SLOT_A.periodSlot });
	const view2 = buildReportView({
		periodSlot: reloaded!.periodSlot,
		status: reloaded!.status,
		publishedAt: reloaded!.publishedAt,
		reportSchemaVersion: reloaded!.reportSchemaVersion,
		slo: reloaded!.slo,
		readiness: reloaded!.readiness,
		report: reloaded!.report
	});
	check(
		'deux lectures rendent la MÊME vue (aucune horloge, aucun recalcul)',
		JSON.stringify(view) === JSON.stringify(view2)
	);

	// ── B. Absent n'est pas zéro ─────────────────────────────────────
	section('§B — « absent » n’est pas « zéro », sur un rapport RÉEL');

	const absentSections = view.sections.filter((s) => s.kind === 'absent');
	const presentSections = view.sections.filter((s) => s.kind === 'present');
	check(
		'le parc produit au moins une section ABSENTE (indexation / trafic aujourd’hui)',
		absentSections.length > 0,
		absentSections.map((s) => `${s.key}:${s.kind === 'absent' ? s.reason : ''}`).join(' · ')
	);
	check(
		'⭐ aucune section absente ne porte de compteur — il n’existe aucun champ où loger un 0',
		absentSections.every(
			(s) => !('items' in s) && !('metrics' in s) && !('truncated' in s) && !('isEmpty' in s)
		)
	);
	check(
		'chaque absence porte sa RAISON dans le vocabulaire fermé',
		absentSections.every(
			(s) =>
				s.kind === 'absent' &&
				['not_wired', 'never_collected', 'not_examined'].includes(s.reason) &&
				s.detail.length > 0 &&
				s.note.length > 0
		)
	);

	// CONTRE-ÉPREUVE : une section PRÉSENTE et vide dit « j'ai regardé, il n'y a rien ». Elle
	// porte donc bien un compteur — c'est exactement ce que l'absence, elle, n'a pas.
	const emptyPresent = presentSections.filter((s) => s.kind === 'present' && s.isEmpty);
	check(
		'CONTRE-ÉPREUVE : une section présente et vide EXISTE et porte ses champs',
		emptyPresent.length === 0 ||
			emptyPresent.every((s) => s.kind === 'present' && Array.isArray(s.items)),
		emptyPresent.length === 0
			? 'aucune section vide sur ce rapport (rien à contredire)'
			: `${emptyPresent.length} section(s) vide(s) : ${emptyPresent.map((s) => s.key).join(', ')}`
	);
	check(
		'les deux familles sont DISJOINTES et couvrent tout le rapport',
		absentSections.length + presentSections.length === view.sections.length,
		`${absentSections.length} absentes · ${presentSections.length} présentes`
	);

	// ── C. Le SLO se dérive ──────────────────────────────────────────
	section('§C — le SLO se DÉRIVE : aucune colonne de verdict en base');

	const verdictColumns = await db.execute(sql`
		SELECT column_name FROM information_schema.columns
		 WHERE table_schema = 'seostats' AND table_name = 'weekly_reports'
	`);
	const columnNames = (verdictColumns.rows ?? []).map((r) =>
		String((r as { column_name: string }).column_name)
	);
	// ⚠️ Liste FERMÉE, pas une regex : `/slo/` matche `slot_at`, qui est un fait (l'instant du
	// créneau), pas un verdict. La garde échouait en ayant raison.
	const FORBIDDEN_VERDICT_COLUMNS = ['slo_met', 'slo_status', 'on_time', 'late_ms', 'is_late', 'met'];
	check(
		'aucune colonne de verdict : le SLO n’est pas stocké, il se recalcule à chaque lecture',
		!columnNames.some((c) => FORBIDDEN_VERDICT_COLUMNS.includes(c)),
		columnNames.join(', ')
	);
	check(
		'les trois FAITS dont il se dérive sont là, eux',
		['slot_at', 'due_at', 'published_at'].every((c) => columnNames.includes(c))
	);

	// Deux créneaux publiés au MÊME instant relatif (créneau + 61 min), deux échéances : le
	// retard mesuré doit différer, parce que `due_at` — le seul terme réglable — a bougé. C'est
	// ce que « échéance réglable sans redéploiement » veut dire, vu depuis l'écran.
	const publishedB = await publishWeeklyReport({
		db,
		now: new Date(SLOT_B.slotAtMs + 61 * MINUTE),
		deadlineMinutes: 15,
		slotOverride: SLOT_B
	});
	check(
		'échéance 60 min, publié à +61 ⇒ 1 min de retard',
		publishedA.slo?.met === false && Math.round((publishedA.slo?.lateMs ?? 0) / MINUTE) === 1,
		`retard ${Math.round((publishedA.slo?.lateMs ?? 0) / MINUTE)} min`
	);
	check(
		'échéance 15 min, publié à +61 ⇒ 46 min de retard (même publication, autre échéance)',
		publishedB.slo?.met === false && Math.round((publishedB.slo?.lateMs ?? 0) / MINUTE) === 46,
		`retard ${Math.round((publishedB.slo?.lateMs ?? 0) / MINUTE)} min`
	);

	const rowsForSlo = await listPublishedReports({ db, limit: 12 });
	const listA = summarizeReportList(rowsForSlo).find((r) => r.periodSlot === SLOT_A.periodSlot);
	const listB = summarizeReportList(rowsForSlo).find((r) => r.periodSlot === SLOT_B.periodSlot);
	check(
		'l’écran chiffre chaque retard avec SON échéance, pas avec celle d’aujourd’hui',
		listA?.sloLabel === 'SLO manqué de 1 min' && listB?.sloLabel === 'SLO manqué de 46 min',
		`${listA?.sloLabel} | ${listB?.sloLabel}`
	);

	// ⭐ Le verdict d'une ligne EXISTANTE ne se recalcule pas avec l'échéance du jour. Republier
	// le créneau A sous une échéance de 5 min doit rendre le verdict d'origine (1 min de retard),
	// pas un verdict rétroactif — et n'écrire strictement rien. Sans ça, changer un réglage
	// réécrirait l'histoire de tous les rapports déjà publiés.
	const republish = await publishWeeklyReport({
		db,
		now: new Date(SLOT_A.slotAtMs + 61 * MINUTE),
		deadlineMinutes: 5,
		slotOverride: SLOT_A
	});
	check(
		'republier sous une autre échéance rend le verdict D’ORIGINE',
		republish.action === 'already_published' &&
			Math.round((republish.slo?.lateMs ?? 0) / MINUTE) === 1,
		`${republish.action} · retard ${Math.round((republish.slo?.lateMs ?? 0) / MINUTE)} min`
	);
	check(
		'… et n’écrit aucune ligne de plus',
		(await scalar(
			sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports" WHERE period_slot LIKE ${'1998-%'}`
		)) === 2
	);

	// ── D. La troncature ─────────────────────────────────────────────
	section('§D — la troncature est DITE avec le total réel');

	const truncated = presentSections.filter((s) => s.kind === 'present' && s.truncated > 0);
	check(
		'une note de troncature existe SSI des items ont été écartés',
		presentSections.every(
			(s) => s.kind === 'present' && (s.truncated > 0) === (s.truncationNote !== null)
		),
		truncated.length === 0
			? 'aucune section tronquée sur ce rapport (biconditionnelle vérifiée à vide)'
			: `${truncated.length} section(s) tronquée(s)`
	);
	check(
		'chaque note tronquée reconstitue le total (affichés + écartés)',
		truncated.every(
			(s) =>
				s.kind === 'present' &&
				(s.truncationNote ?? '').includes(String(s.items.length + s.truncated))
		)
	);

	// ── E. Créneau inconnu ───────────────────────────────────────────
	section('§E — un créneau inconnu rend `null` (donc 404), jamais une page vide');

	const missing = await loadPublishedReport({ db, periodSlot: SLOT_ABSENT });
	check('aucun rapport pour un créneau jamais publié', missing === null, SLOT_ABSENT);
	check('… alors que le créneau publié, lui, se relit', (await loadPublishedReport({ db, periodSlot: SLOT_A.periodSlot })) !== null);

	// ── F. La liste ne charge aucun payload ──────────────────────────
	section('§F — la liste ne charge AUCUN payload');

	const metas = await listPublishedReports({ db, limit: 12 });
	check(
		'aucune méta ne porte le rapport lui-même',
		metas.every((m) => !('report' in m) && !('payloadJson' in m)),
		`${metas.length} méta(s)`
	);
	check(
		'chaque méta porte en revanche ce que la liste affiche',
		metas.every(
			(m) => typeof m.periodSlot === 'string' && typeof m.status === 'string' && m.slo !== undefined
		)
	);
	console.log(
		`     (payload du créneau A : ${Math.round(rawPayload.length / 1024)} kio — × ${metas.length} lignes si la liste le chargeait)`
	);

	// ── G. Liste et détail s'accordent ───────────────────────────────
	section('§G — la liste et le détail s’accordent (une seule autorité : `toMeta`)');

	const rowA = summarizeReportList(metas).find((r) => r.periodSlot === SLOT_A.periodSlot);
	check('même statut des deux côtés', rowA?.status === view.status, `${rowA?.status} / ${view.status}`);
	check('même verdict SLO des deux côtés', rowA?.sloLabel === view.sloLabel, view.sloLabel);
	check(
		'le lien de la liste mène au créneau du détail',
		rowA?.href === `/reports/${encodeURIComponent(view.periodSlot)}`,
		rowA?.href ?? '∅'
	);

	// ── H. « Jamais publié » est un état ─────────────────────────────
	section('§H — « aucun rapport publié » est un ÉTAT, pas une liste vide');

	const freshness = describeReportsFreshness({
		entries: metas.map((m) => ({ periodSlot: m.periodSlot, slotAt: m.slotAt })),
		nowMs: Date.now(),
		parseMs: dbTimestampToMs
	});
	check(
		'avec des rapports en base, l’état n’est jamais `never`',
		freshness.state !== 'never',
		`${freshness.state} · ${freshness.note}`
	);
	const emptyFreshness = describeReportsFreshness({
		entries: [],
		nowMs: Date.now(),
		parseMs: dbTimestampToMs
	});
	check(
		'sans aucun rapport, l’état est `never` et l’âge reste `null`',
		emptyFreshness.state === 'never' && emptyFreshness.ageDays === null,
		emptyFreshness.note
	);
	check(
		'l’âge se compte sur `slot_at` (UTC), pas sur le créneau local',
		freshness.ageDays !== null && freshness.ageDays > 9000,
		`créneau 1998 ⇒ ${freshness.ageDays} j`
	);

	// ── I. La base est rendue à l'identique ──────────────────────────
	section('§I — la base est rendue à l’identique');

	await cleanup();
	const reportsAfter = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports"`);
	const tablesAfter = await scalar(
		sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'seostats'`
	);
	check('rapports publiés : inchangés', reportsAfter === reportsBefore, `${reportsBefore} → ${reportsAfter}`);
	check('tables : inchangées (ZÉRO DDL)', tablesAfter === tablesBefore, `${tablesBefore} → ${tablesAfter}`);
}

main()
	.then(() => {
		console.log('');
		console.log(failures === 0 ? '✅ Toutes les vérifications passent.' : `❌ ${failures} échec(s).`);
	})
	.catch((err) => {
		console.error('');
		console.error('❌ Erreur :', err instanceof Error ? err.message : err);
		failures += 1;
	})
	.finally(async () => {
		await cleanup().catch(() => {});
		await pool.end();
		process.exit(failures === 0 ? 0 : 1);
	});
