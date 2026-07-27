/**
 * REP-004 lot 1 — Preuve de la révision et de la comparaison (sur Neon).
 *
 * Les règles de comparaison (disponibilité ≠ écart, identité ≠ prose, activité ≠ état, plafond
 * incomparable) sont couvertes par vitest (`report-history-state.test.ts`, 35 tests). Ce qui ne
 * peut PAS se prouver en vitest, et se prouve ici, c'est ce que fait la BASE :
 *
 *   A. **l'original SURVIT** : réviser INSÈRE, ne met à jour ni ne supprime rien. La ligne
 *      d'origine garde son id, son statut, son heure et son payload, octet pour octet ;
 *   B. l'unique porte sur (period_slot, revision) : deux révisions coexistent, deux révisions
 *      du MÊME numéro ne peuvent pas — et le chemin AUTOMATIQUE reste exactement-une-fois ;
 *   C. une révision sans raison est refusée par le modèle **et** par la contrainte de base ;
 *   D. le SLO du créneau ne bouge PAS quand on révise : il mesure la première publication ;
 *   E. la comparaison de deux rapports RÉELS ne fabrique aucun écart là où une section a
 *      changé de disponibilité, et l'axe « révision » compare bien la même période ;
 *   F. la lecture rend la révision COURANTE par défaut, l'ancienne restant atteignable ;
 *   G. la base est rendue à l'identique.
 *
 * Isolation. Le rapport réel de la semaine n'est JAMAIS publié : tout passe par des créneaux
 * SYNTHÉTIQUES de 1997 (`slotOverride`), supprimables par leur seul `period_slot`. Aucun projet,
 * aucun run, aucune pause n'est créé. Nettoyage dans un `finally` ; un Ctrl-C le saute — vérifier
 * alors `weekly_reports.period_slot LIKE '1997-%'`.
 *
 * ⚠️ **Ne PAS piper ce script dans `head`** : le SIGPIPE tue le process avant le `finally`, et
 * laisse les rapports synthétiques en base. Utiliser `tail`, qui lit tout.
 *
 * Lancer : npx tsx scripts/rep-004-history-proof.ts
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
	listReportRevisions,
	loadPublishedReport,
	publishWeeklyReport,
	reviseWeeklyReport
} from '../src/lib/server/report-publication.js';
import { compareReports } from '../src/lib/server/report-history-state.js';
import { summarizeReportList } from '../src/lib/server/report-read-state.js';

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
const HOUR = 60 * MINUTE;

/** Créneaux synthétiques : deux lundis de janvier 1997, 09:00 CET (= 08:00 UTC). */
const SLOT_A = { periodSlot: '1997-01-06T09:00', slotAtMs: Date.parse('1997-01-06T08:00:00Z') };
const SLOT_B = { periodSlot: '1997-01-13T09:00', slotAtMs: Date.parse('1997-01-13T08:00:00Z') };

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(q);
	return Number((res.rows?.[0] as { n: number }).n);
}

async function cleanup(): Promise<void> {
	await db.execute(sql`DELETE FROM "seostats"."weekly_reports" WHERE period_slot LIKE ${'1997-%'}`);
}

async function main(): Promise<void> {
	await cleanup();

	const reportsBefore = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports"`);
	const tablesBefore = await scalar(
		sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'seostats'`
	);

	console.log('REP-004 lot 1 — preuve de la révision et de la comparaison (Neon)');
	console.log(`  état initial : ${reportsBefore} rapport(s) publié(s) · ${tablesBefore} tables`);

	// Deux créneaux réels publiés sur des dates synthétiques. Le CONTENU vient du parc (REP-001
	// construit sur les vraies observations) ; seule la date du créneau est fabriquée.
	//
	// ⚠️ Publiés APRÈS l'échéance, et il ne peut pas en être autrement : aucun projet n'a de run
	// hebdo sur un créneau de 1997, donc tous sont bloquants et la publication attend
	// `deadline_reached`. Le rapport part en `partial` — le chemin nominal de REP-003 sur un parc
	// dont la collecte n'a pas tourné, et précisément le cas que la révision existe pour traiter.
	const pubA = await publishWeeklyReport({
		db,
		now: new Date(SLOT_A.slotAtMs + 61 * MINUTE),
		deadlineMinutes: 60,
		slotOverride: SLOT_A
	});
	if (pubA.action !== 'publish') {
		throw new Error(`le créneau synthétique A n’a pas publié : ${pubA.action}/${pubA.reason}`);
	}
	const pubB = await publishWeeklyReport({
		db,
		now: new Date(SLOT_B.slotAtMs + 61 * MINUTE),
		deadlineMinutes: 60,
		slotOverride: SLOT_B
	});
	if (pubB.action !== 'publish') {
		throw new Error(`le créneau synthétique B n’a pas publié : ${pubB.action}/${pubB.reason}`);
	}

	const originalA = await loadPublishedReport({ db, periodSlot: SLOT_A.periodSlot });
	if (!originalA) throw new Error('le rapport A ne se relit pas');
	const originalPayload = JSON.stringify(originalA.report);
	const originalSlo = { ...originalA.slo };

	// ── A. L'original survit ─────────────────────────────────────────
	section('§A — réviser INSÈRE : l’original n’est ni modifié ni supprimé');

	const revised = await reviseWeeklyReport({
		db,
		periodSlot: SLOT_A.periodSlot,
		reason: 'la collecte hebdomadaire a fini d’arriver',
		now: new Date(SLOT_A.slotAtMs + 30 * HOUR)
	});
	check('la révision est écrite', revised.action === 'revise' && revised.revision === 2, `${revised.action} · rév. ${revised.revision}`);
	check(
		'elle pointe la ligne qu’elle remplace (lignage)',
		revised.supersedesId === originalA.id,
		`${revised.supersedesId ?? '∅'} = ${originalA.id}`
	);

	const revisions = await listReportRevisions({ db, periodSlot: SLOT_A.periodSlot });
	check('le créneau porte DEUX lignes', revisions.length === 2, `${revisions.length}`);

	const survivor = await loadPublishedReport({ db, periodSlot: SLOT_A.periodSlot, revision: 1 });
	check('la révision 1 se relit toujours', survivor !== null);
	check(
		'… avec le MÊME id, le même statut et la même heure qu’à la publication',
		survivor?.id === originalA.id &&
			survivor?.status === originalA.status &&
			survivor?.publishedAt === originalA.publishedAt,
		`${survivor?.id === originalA.id} · ${survivor?.status} · ${survivor?.publishedAt}`
	);
	// ⭐ L'acceptation, littéralement : le payload d'origine est intact, octet pour octet.
	check(
		'… et son payload est intact, octet pour octet',
		JSON.stringify(survivor?.report) === originalPayload,
		`${originalPayload.length} caractères`
	);

	// ── B. L'unique et l'exactement-une-fois du tick ─────────────────
	section('§B — l’unique porte sur (créneau, révision), le tick n’écrit que la révision 1');

	const idx = await db.execute(sql`
		SELECT indexname FROM pg_indexes
		 WHERE schemaname = 'seostats' AND tablename = 'weekly_reports'
	`);
	const indexNames = (idx.rows ?? []).map((r) => (r as unknown as { indexname: string }).indexname);
	check(
		'l’ancien unique sur le seul créneau a disparu',
		!indexNames.includes('weekly_reports_period_unique'),
		indexNames.join(', ')
	);
	check(
		'le nouvel unique porte le couple',
		indexNames.includes('weekly_reports_period_revision_unique')
	);

	// Le tick repasse : il ne doit RIEN écrire, malgré l'existence d'une révision 2.
	const tickAgain = await publishWeeklyReport({
		db,
		now: new Date(SLOT_A.slotAtMs + 40 * HOUR),
		deadlineMinutes: 60,
		slotOverride: SLOT_A
	});
	check(
		'un tick qui repasse voit le créneau publié et n’écrit rien',
		tickAgain.action === 'already_published',
		`${tickAgain.action}`
	);
	check(
		'… le nombre de lignes du créneau est inchangé',
		(await scalar(
			sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports" WHERE period_slot = ${SLOT_A.periodSlot}`
		)) === 2
	);

	// Deux révisions concurrentes : la contrainte tranche, la seconde n'écrit rien.
	const [r3a, r3b] = await Promise.all([
		reviseWeeklyReport({ db, periodSlot: SLOT_A.periodSlot, reason: 'course A', now: new Date(SLOT_A.slotAtMs + 50 * HOUR) }),
		reviseWeeklyReport({ db, periodSlot: SLOT_A.periodSlot, reason: 'course B', now: new Date(SLOT_A.slotAtMs + 50 * HOUR) })
	]);
	const wrote = [r3a, r3b].filter((r) => r.action === 'revise').length;
	check(
		'deux révisions concurrentes : UNE seule écrit',
		wrote === 1,
		`${r3a.action} / ${r3b.action}`
	);
	check(
		'… le créneau porte exactement 3 lignes',
		(await scalar(
			sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports" WHERE period_slot = ${SLOT_A.periodSlot}`
		)) === 3
	);

	// ── C. Une révision porte toujours sa raison ─────────────────────
	section('§C — une révision sans raison est refusée (modèle ET base)');

	const refused = await reviseWeeklyReport({ db, periodSlot: SLOT_A.periodSlot, reason: '   ' });
	check(
		'le modèle refuse avant d’écrire, et avant de reconstruire le rapport',
		refused.action === 'refuse' && refused.refusal === 'reason_required',
		`${refused.action}/${refused.refusal}`
	);
	const refusedUnknown = await reviseWeeklyReport({
		db,
		periodSlot: '1997-12-29T09:00',
		reason: 'peu importe'
	});
	check(
		'réviser un créneau jamais publié est refusé (ce serait une publication)',
		refusedUnknown.action === 'refuse' && refusedUnknown.refusal === 'no_original',
		`${refusedUnknown.action}/${refusedUnknown.refusal}`
	);

	// CONTRE-ÉPREUVE en base : la contrainte refuse aussi une révision muette insérée à la main.
	let dbRefused = false;
	try {
		await db.execute(sql`
			INSERT INTO "seostats"."weekly_reports"
				(id, period_slot, status, schema_version, report_schema_version, slot_at, due_at,
				 published_at, readiness_json, payload_json, revision, revision_reason)
			VALUES ('proof_rep004_silent', ${SLOT_A.periodSlot}, 'partial', 1, 2, '1997-01-06 08:00:00',
			        '1997-01-06 09:00:00', '1997-01-08 10:00:00', '{}', '{}', 9, NULL)
		`);
	} catch {
		dbRefused = true;
	}
	check('la contrainte de base refuse une révision >= 2 sans raison', dbRefused);
	check(
		'… et rien n’a été inséré',
		(await scalar(
			sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports" WHERE id = ${'proof_rep004_silent'}`
		)) === 0
	);

	// ── D. Le SLO du créneau ne bouge pas ────────────────────────────
	section('§D — réviser ne réécrit pas la ponctualité du créneau');

	const list = summarizeReportList(await listPublishedReports({ db, limit: 12 }));
	const rowA = list.find((r) => r.periodSlot === SLOT_A.periodSlot);
	check(
		'la liste montre la révision COURANTE du créneau',
		rowA?.revision === 3 && rowA?.revisionCount === 3,
		`rév. ${rowA?.revision}/${rowA?.revisionCount}`
	);
	// ⭐ La révision a été écrite 30 h après le créneau. Si le SLO se dérivait de SA date, il
	// afficherait ~30 h de retard au lieu d'une minute — une correction volontaire dégraderait
	// après coup la ponctualité du cron.
	check(
		'le SLO reste celui de la PREMIÈRE publication (1 min de retard)',
		rowA?.slo.met === false && Math.round((rowA?.slo.lateMs ?? 0) / MINUTE) === 1,
		`retard ${Math.round((rowA?.slo.lateMs ?? 0) / MINUTE)} min · original ${Math.round(originalSlo.lateMs / MINUTE)} min`
	);
	check(
		'… et la phrase le NOMME sur un créneau révisé',
		(rowA?.sloLabel ?? '').includes('publication d’origine'),
		rowA?.sloLabel ?? '∅'
	);
	// CONTRE-ÉPREUVE : un créneau jamais révisé ne qualifie pas son SLO.
	const rowB = list.find((r) => r.periodSlot === SLOT_B.periodSlot);
	check(
		'un créneau jamais révisé ne parle pas de « publication d’origine »',
		rowB !== undefined && !rowB.sloLabel.includes('origine') && rowB.revisionCount === 1,
		rowB?.sloLabel ?? '∅'
	);

	// ── E. La comparaison sur des rapports RÉELS ─────────────────────
	section('§E — la comparaison ne fabrique aucun écart');

	const headB = await loadPublishedReport({ db, periodSlot: SLOT_B.periodSlot });
	const currentA = await loadPublishedReport({ db, periodSlot: SLOT_A.periodSlot });
	if (!headB || !currentA) throw new Error('rapports introuvables');

	const slotDiff = compareReports({
		base: {
			periodSlot: currentA.periodSlot,
			revision: currentA.revision,
			reportSchemaVersion: currentA.reportSchemaVersion,
			report: currentA.report
		},
		head: {
			periodSlot: headB.periodSlot,
			revision: headB.revision,
			reportSchemaVersion: headB.reportSchemaVersion,
			report: headB.report
		}
	});
	check('deux créneaux se comparent sur l’axe « slot »', slotDiff.kind === 'available' && slotDiff.axis === 'slot');
	if (slotDiff.kind !== 'available') throw new Error('comparaison indisponible');
	check(
		'aucun blocage : même schéma, même longueur de fenêtre',
		slotDiff.blocks.length === 0,
		slotDiff.blocks.map((b) => b.reason).join(', ') || 'aucun'
	);

	// ⭐ Sur le parc réel, `indexation` et `traffic_conversions` sont ABSENTES des deux côtés
	// (aucune observation d'indexation, aucun provider analytics). Elles doivent sortir
	// `both_absent` SANS le moindre champ chiffré — pas « 0 → 0 ».
	const absentBoth = slotDiff.sections.filter((s) => s.kind === 'both_absent');
	check(
		'les sections absentes des deux côtés sont NOMMÉES telles quelles',
		absentBoth.length > 0,
		absentBoth.map((s) => s.key).join(', ') || 'aucune'
	);
	check(
		'… et aucune ne porte de métriques, d’items ni de delta',
		absentBoth.every(
			(s) => !('metrics' in s) && !('items' in s) && !JSON.stringify(s).includes('delta')
		)
	);

	// CONTRE-ÉPREUVE : les sections présentes des deux côtés portent bien leurs métriques.
	const comparableSections = slotDiff.sections.filter((s) => s.kind === 'comparable');
	check(
		'les sections présentes des deux côtés portent bien leurs métriques',
		comparableSections.length > 0 &&
			comparableSections.every((s) => s.kind === 'comparable' && Array.isArray(s.metrics)),
		`${comparableSections.length} section(s) comparable(s)`
	);

	// L'axe RÉVISION : deux révisions du même créneau couvrent la MÊME période. C'est ce qui
	// rend l'audit d'une régénération lisible — tout écart vient de la collecte, pas du calendrier.
	const revDiff = compareReports({
		base: {
			periodSlot: SLOT_A.periodSlot,
			revision: 1,
			reportSchemaVersion: originalA.reportSchemaVersion,
			report: originalA.report
		},
		head: {
			periodSlot: currentA.periodSlot,
			revision: currentA.revision,
			reportSchemaVersion: currentA.reportSchemaVersion,
			report: currentA.report
		}
	});
	check('deux révisions se comparent sur l’axe « revision »', revDiff.kind === 'available' && revDiff.axis === 'revision');
	if (revDiff.kind !== 'available') throw new Error('comparaison de révisions indisponible');
	check(
		'⭐ la révision couvre EXACTEMENT la même période que l’original',
		revDiff.base.periodLabel === revDiff.head.periodLabel,
		`${revDiff.base.periodLabel} = ${revDiff.head.periodLabel}`
	);
	check(
		'… donc aucune section ne devient disponible ni absente entre deux révisions du même parc',
		revDiff.summary.becameAvailable.length === 0 && revDiff.summary.becameAbsent.length === 0
	);

	// ── F. Lecture par défaut vs lecture d'archive ───────────────────
	section('§F — la lecture rend la révision courante, l’ancienne restant atteignable');

	check(
		'sans numéro : la révision la plus haute',
		currentA.revision === 3,
		`rév. ${currentA.revision}`
	);
	check('avec numéro : l’originale', survivor?.revision === 1);
	const absentRevision = await loadPublishedReport({ db, periodSlot: SLOT_A.periodSlot, revision: 99 });
	check('une révision inexistante rend `null` (donc 404), jamais la courante', absentRevision === null);
	check(
		'la liste ne porte qu’UNE ligne par créneau, même révisé',
		list.filter((r) => r.periodSlot.startsWith('1997-')).length === 2,
		`${list.filter((r) => r.periodSlot.startsWith('1997-')).length} ligne(s) pour 2 créneaux et 4 révisions`
	);

	// ── G. La base est rendue à l'identique ──────────────────────────
	section('§G — la base est rendue à l’identique');

	await cleanup();
	const reportsAfter = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports"`);
	const tablesAfter = await scalar(
		sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'seostats'`
	);
	check('aucun rapport laissé derrière', reportsAfter === reportsBefore, `${reportsBefore} → ${reportsAfter}`);
	check('aucune table créée par ce lot', tablesAfter === tablesBefore, `${tablesBefore} → ${tablesAfter}`);

	console.log('');
	console.log(failures === 0 ? '✅ Toutes les vérifications passent.' : `❌ ${failures} échec(s).`);
	if (failures > 0) process.exitCode = 1;
}

main()
	.catch((e) => {
		console.error(e);
		process.exitCode = 1;
	})
	.finally(async () => {
		await cleanup().catch(() => {});
		await pool.end();
	});
