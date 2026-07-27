/**
 * REP-004 lot 2 — Preuve de la rétention du détail (sur Neon).
 *
 * Les règles de décision (l'âge n'autorise rien, l'archive autorise, une valeur illisible
 * conserve) sont couvertes par vitest (`report-retention-state.test.ts`, 17 tests). Ce qui ne
 * peut PAS se prouver en vitest, et se prouve ici, c'est ce que fait la BASE :
 *
 *   A. le CHECK MORD : aucune ligne ne peut perdre son détail sans laisser son adresse, sa date
 *      de purge et son empreinte — y compris par un UPDATE nu, hors de tout code applicatif ;
 *   B. la purge ne SUPPRIME rien : même nombre de lignes, mêmes id, mêmes statuts, même lignage,
 *      `supersedes_id` toujours résolvable — « on purge le détail, jamais la ligne » ;
 *   C. la marque d'archivage est VÉRIFIÉE : un mauvais hash refuse et n'écrit rien ;
 *   D. la purge ré-assert ses conditions EN SQL : un plan périmé ne purge pas ;
 *   E. un détail purgé se LIT comme purgé, jamais comme un rapport vide (union discriminée) ;
 *   F. la comparaison contre un rapport purgé est refusée, et nomme l'archive ;
 *   G. le SLO, la préparation et le lignage survivent intacts à la purge ;
 *   H. la base est rendue à l'identique (rapports, tables, réglage).
 *
 * Isolation. Le rapport réel de la semaine n'est JAMAIS touché : tout passe par des créneaux
 * SYNTHÉTIQUES de 1997 (`slotOverride`), et le plan de purge est explicitement restreint à
 * ceux-là — une preuve qui purgerait une vraie ligne détruirait la donnée qu'elle vérifie.
 * Nettoyage dans un `finally` ; un Ctrl-C le saute — vérifier alors
 * `weekly_reports.period_slot LIKE '1997-%'` et la clé `report.detail_retention_weeks`.
 *
 * ⚠️ **Ne PAS piper ce script dans `head`** : le SIGPIPE tue le process avant le `finally`, et
 * laisse les rapports synthétiques en base. Utiliser `tail`, qui lit tout.
 *
 * Lancer : npx tsx scripts/rep-004-retention-proof.ts
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
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
import {
	confirmReportArchived,
	listArchivableReports,
	listRetentionCandidates,
	loadDetailRetentionWeeks,
	purgeReportDetails,
	saveDetailRetentionWeeks
} from '../src/lib/server/report-retention.js';
import {
	archiveFileName,
	planDetailPurge,
	DETAIL_RETENTION_KEY
} from '../src/lib/server/report-retention-state.js';
import { compareReports } from '../src/lib/server/report-history-state.js';
import { buildPurgedReportView, summarizeReportList } from '../src/lib/server/report-read-state.js';
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
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Deux lundis de janvier 1997, 09:00 CET (= 08:00 UTC) — vieux de ~30 ans, donc purgeables. */
const SLOT_A = { periodSlot: '1997-01-06T09:00', slotAtMs: Date.parse('1997-01-06T08:00:00Z') };
const SLOT_B = { periodSlot: '1997-01-13T09:00', slotAtMs: Date.parse('1997-01-13T08:00:00Z') };
const SYNTHETIC = [SLOT_A.periodSlot, SLOT_B.periodSlot];

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(q);
	return Number((res.rows?.[0] as { n: number }).n);
}

async function cleanup(restoreWeeks: string | null): Promise<void> {
	await db.execute(sql`DELETE FROM "seostats"."weekly_reports" WHERE period_slot LIKE ${'1997-%'}`);
	if (restoreWeeks === null) {
		await db.execute(
			sql`DELETE FROM "seostats"."system_settings" WHERE key = ${DETAIL_RETENTION_KEY}`
		);
	} else {
		await db.execute(sql`
			UPDATE "seostats"."system_settings" SET value = ${restoreWeeks} WHERE key = ${DETAIL_RETENTION_KEY}
		`);
	}
}

/** Le plan, restreint aux créneaux SYNTHÉTIQUES. Une preuve ne purge jamais de vraie donnée. */
async function syntheticPlan(retentionWeeks: number | null) {
	const all = await listRetentionCandidates(db);
	return planDetailPurge({
		candidates: all.filter((c) => SYNTHETIC.includes(c.periodSlot)),
		retentionWeeks,
		nowMs: Date.now(),
		parseMs: dbTimestampToMs
	});
}

async function main(): Promise<void> {
	// L'état initial du réglage, pour le restaurer à l'octet près.
	const settingRes = await db.execute(sql`
		SELECT value FROM "seostats"."system_settings" WHERE key = ${DETAIL_RETENTION_KEY}
	`);
	const initialWeeksRaw = ((settingRes.rows ?? [])[0] as { value: string } | undefined)?.value ?? null;

	await cleanup(initialWeeksRaw);

	const reportsBefore = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports"`);
	const tablesBefore = await scalar(
		sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'seostats'`
	);

	console.log('REP-004 lot 2 — preuve de la rétention du détail (Neon)');
	console.log(`  état initial : ${reportsBefore} rapport(s) publié(s) · ${tablesBefore} tables`);
	console.log(`  réglage initial : ${initialWeeksRaw ?? '∅ (rétention désactivée)'}`);

	// Deux créneaux publiés, dont un révisé : le lignage doit survivre à la purge.
	const pubA = await publishWeeklyReport({
		db,
		now: new Date(SLOT_A.slotAtMs + 61 * MINUTE),
		deadlineMinutes: 60,
		slotOverride: SLOT_A
	});
	if (pubA.action !== 'publish') throw new Error(`créneau A non publié : ${pubA.action}`);
	const pubB = await publishWeeklyReport({
		db,
		now: new Date(SLOT_B.slotAtMs + 61 * MINUTE),
		deadlineMinutes: 60,
		slotOverride: SLOT_B
	});
	if (pubB.action !== 'publish') throw new Error(`créneau B non publié : ${pubB.action}`);
	const revised = await reviseWeeklyReport({
		db,
		periodSlot: SLOT_A.periodSlot,
		reason: 'preuve de rétention : le lignage doit survivre à la purge'
	});
	if (revised.action !== 'revise') throw new Error(`révision refusée : ${revised.action}`);

	// ── A. Le CHECK mord ─────────────────────────────────────────────
	section('§A — la base refuse le détail disparu SANS adresse (le seul état dangereux)');

	const original = await loadPublishedReport({ db, periodSlot: SLOT_A.periodSlot, revision: 1 });
	if (!original) throw new Error('le rapport A rév. 1 ne se relit pas');

	async function refuses(label: string, q: ReturnType<typeof sql>): Promise<void> {
		let refused = false;
		try {
			await db.execute(q);
		} catch {
			refused = true;
		}
		check(label, refused);
	}

	// ⭐ L'UPDATE NU : c'est le geste qu'un humain pressé ferait dans psql. Il doit échouer, sinon
	// la garde ne vit que dans le code applicatif — donc nulle part.
	await refuses(
		'UPDATE nu « payload_json = NULL » refusé (ni purged_at, ni archive)',
		sql`UPDATE "seostats"."weekly_reports" SET payload_json = NULL WHERE id = ${original.id}`
	);
	await refuses(
		'… même avec purged_at, tant qu’il manque l’adresse',
		sql`UPDATE "seostats"."weekly_reports"
		       SET payload_json = NULL, payload_purged_at = ${'1997-02-01 09:00:00'}
		     WHERE id = ${original.id}`
	);
	await refuses(
		'… même avec adresse, tant qu’il manque l’empreinte',
		sql`UPDATE "seostats"."weekly_reports"
		       SET payload_json = NULL,
		           payload_purged_at = ${'1997-02-01 09:00:00'},
		           payload_archived_at = ${'1997-02-01 08:00:00'},
		           payload_archive_ref = ${'00-Inbox/x.md'},
		           payload_digest = NULL
		     WHERE id = ${original.id}`
	);
	const stillThere = await loadPublishedReport({ db, periodSlot: SLOT_A.periodSlot, revision: 1 });
	check('… et le détail est toujours là après ces trois refus', stillThere?.detail.kind === 'available');

	// ── B. L'empreinte publiée ───────────────────────────────────────
	section('§B — l’empreinte est écrite à la publication, sur la chaîne exacte');

	const rawRes = await db.execute(sql`
		SELECT payload_json, payload_digest, payload_bytes
		  FROM "seostats"."weekly_reports" WHERE id = ${original.id}
	`);
	const raw = (rawRes.rows ?? [])[0] as unknown as {
		payload_json: string;
		payload_digest: string;
		payload_bytes: number;
	};
	check(
		'payload_digest = SHA-256 du payload_json tel qu’il est en base',
		raw.payload_digest === sha256(raw.payload_json),
		`${raw.payload_digest.slice(0, 12)}…`
	);
	check(
		'payload_bytes = taille réelle du payload',
		Number(raw.payload_bytes) === Buffer.byteLength(raw.payload_json, 'utf8'),
		`${raw.payload_bytes} octets`
	);

	// ── C. La confirmation d'archivage est vérifiée ──────────────────
	section('§C — « archivé » se PROUVE : un mauvais hash refuse et n’écrit rien');

	const bad = await confirmReportArchived({
		db,
		periodSlot: SLOT_A.periodSlot,
		revision: 1,
		fileDigest: 'f'.repeat(64),
		archiveRef: '00-Inbox/un-autre-rapport.md'
	});
	check('un digest qui ne correspond pas est REFUSÉ', bad.action === 'refused');
	check(
		'… avec la raison exacte (pas une erreur générique)',
		bad.action === 'refused' && bad.reason === 'digest_mismatch'
	);
	const afterBad = await loadPublishedReport({ db, periodSlot: SLOT_A.periodSlot, revision: 1 });
	check(
		'… et RIEN n’a été marqué : la ligne reste « détail en base, jamais archivé »',
		afterBad?.retention.kind === 'stored'
	);

	// Le bon hash : celui du payload en base, comme le CLI le calcule sur le fichier du vault.
	const archivable = await listArchivableReports({ db, onlyUnarchived: true });
	const synthetic = archivable.filter((r) => SYNTHETIC.includes(r.periodSlot));
	check('les 3 révisions synthétiques sont archivables', synthetic.length === 3, `${synthetic.length}`);

	for (const row of synthetic) {
		const digest = sha256(row.payloadJson);
		const ref = `00-Inbox/1997-preuve/${archiveFileName(row.periodSlot, row.revision)}.md`;
		const ok = await confirmReportArchived({
			db,
			periodSlot: row.periodSlot,
			revision: row.revision,
			fileDigest: digest,
			archiveRef: ref
		});
		if (ok.action !== 'confirmed') {
			check(`archivage de ${row.periodSlot} rév.${row.revision}`, false, ok.action);
		}
	}
	const afterArchive = await loadPublishedReport({ db, periodSlot: SLOT_A.periodSlot, revision: 1 });
	check(
		'le bon digest marque la ligne « archivée » sans toucher au détail',
		afterArchive?.retention.kind === 'archived' && afterArchive.detail.kind === 'available'
	);

	// ── D. Le plan et sa ré-assertion ────────────────────────────────
	section('§D — la purge ré-assert ses conditions EN SQL : un plan périmé ne purge pas');

	const plan = await syntheticPlan(4);
	check('les 3 révisions synthétiques sont purgeables (vieilles + archivées)', plan.purge.length === 3, plan.headline);

	// On périme le plan : la ligne cesse d'être archivée APRÈS son calcul. C'est exactement ce
	// qu'une fenêtre de concurrence produit — et la purge doit s'en apercevoir.
	await db.execute(sql`
		UPDATE "seostats"."weekly_reports"
		   SET payload_archived_at = NULL, payload_archive_ref = NULL
		 WHERE period_slot = ${SLOT_B.periodSlot}
	`);
	const stalePurge = await purgeReportDetails({ db, plan, dryRun: false });
	check(
		'la ligne désarchivée entre-temps n’est PAS purgée',
		stalePurge.purged === 2 && stalePurge.skipped === 1,
		`purgées ${stalePurge.purged} · ignorées ${stalePurge.skipped}`
	);
	const survivorB = await loadPublishedReport({ db, periodSlot: SLOT_B.periodSlot });
	check('… et son détail est intact', survivorB?.detail.kind === 'available');

	// ── E. La lecture d'un rapport purgé ─────────────────────────────
	section('§E — un détail purgé se lit comme PURGÉ, jamais comme un rapport vide');

	const purged = await loadPublishedReport({ db, periodSlot: SLOT_A.periodSlot, revision: 1 });
	if (!purged) throw new Error('la ligne purgée a disparu — c’est exactement ce qu’on interdit');
	check('la lecture ne LÈVE pas (rétention ≠ corruption)', true);
	check('detail.kind === "purged"', purged.detail.kind === 'purged');
	check(
		'… et il porte l’adresse de l’archive',
		purged.detail.kind === 'purged' && purged.detail.archiveRef.includes('1997-preuve'),
		purged.detail.kind === 'purged' ? purged.detail.archiveRef : ''
	);

	// ⭐ La vue purgée n'a PAS de champ où un « 0 » pourrait s'écrire.
	const view = buildPurgedReportView({
		periodSlot: purged.periodSlot,
		status: purged.status,
		publishedAt: purged.publishedAt,
		reportSchemaVersion: purged.reportSchemaVersion,
		slo: purged.slo,
		readiness: purged.readiness,
		revision: purged.revision,
		revisionCount: purged.revisionCount,
		retention: purged.retention,
		purgedAt: purged.detail.kind === 'purged' ? purged.detail.purgedAt : '',
		archiveRef: purged.detail.kind === 'purged' ? purged.detail.archiveRef : '',
		bytes: purged.retention.bytes
	});
	const viewKeys = Object.keys(view);
	check(
		'la vue purgée n’a NI sections, NI headline, NI coverage',
		!viewKeys.includes('sections') && !viewKeys.includes('headline') && !viewKeys.includes('coverage'),
		viewKeys.join(', ')
	);
	check('… mais elle garde son statut et son SLO', view.status === purged.status && view.slo.met === purged.slo.met);

	// La LISTE le dit sans charger un seul payload.
	const metas = await listPublishedReports({ db, limit: 50 });
	const rows = summarizeReportList(metas);
	const rowA = rows.find((r) => r.periodSlot === SLOT_A.periodSlot);
	check(
		'la liste annonce « détail archivé » sur le créneau purgé',
		rowA?.detailState === 'purged' && rowA?.detailNote !== null
	);
	const rowB = rows.find((r) => r.periodSlot === SLOT_B.periodSlot);
	check(
		'CONTRE-ÉPREUVE : un créneau au détail présent ne dit rien de particulier',
		rowB?.detailState === 'stored' && rowB?.detailNote === null
	);

	// ── F. La comparaison ────────────────────────────────────────────
	section('§F — comparer contre un rapport purgé est REFUSÉ, jamais rendu vide');

	const headB = await loadPublishedReport({ db, periodSlot: SLOT_B.periodSlot });
	if (!headB) throw new Error('le rapport B ne se relit pas');
	const comparison = compareReports({
		base: {
			periodSlot: purged.periodSlot,
			revision: purged.revision,
			reportSchemaVersion: purged.reportSchemaVersion,
			detail: purged.detail
		},
		head: {
			periodSlot: headB.periodSlot,
			revision: headB.revision,
			reportSchemaVersion: headB.reportSchemaVersion,
			detail: headB.detail
		}
	});
	check('la comparaison est indisponible', comparison.kind === 'unavailable');
	check(
		'… pour la raison « detail_purged », et elle nomme l’archive',
		comparison.kind === 'unavailable' &&
			comparison.reason === 'detail_purged' &&
			comparison.note.includes('1997-preuve')
	);

	// ── G. Ce qui survit ─────────────────────────────────────────────
	section('§G — la purge ne supprime RIEN : lignes, lignage, SLO et préparation intacts');

	const syntheticRows = await scalar(
		sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports" WHERE period_slot LIKE ${'1997-%'}`
	);
	check('les 3 lignes synthétiques sont toujours là', syntheticRows === 3, `${syntheticRows}`);
	check('l’id de la ligne purgée n’a pas changé', purged.id === original.id);
	check('son statut n’a pas changé', purged.status === original.status);
	check(
		'son SLO est identique (dérivé de la PREMIÈRE publication, pas du payload)',
		purged.slo.met === original.slo.met && purged.slo.lateMs === original.slo.lateMs
	);
	check(
		'sa préparation persistée est toujours lisible',
		purged.readiness !== null && purged.readiness.expected === original.readiness?.expected
	);

	const revisions = await listReportRevisions({ db, periodSlot: SLOT_A.periodSlot });
	check('le lignage compte toujours ses 2 révisions', revisions.length === 2);
	check(
		'… et la révision 2 pointe toujours vers la 1 (supersedes_id survit)',
		revisions[1]?.supersedesId === revisions[0]?.id,
		`${revisions[1]?.supersedesId} → ${revisions[0]?.id}`
	);
	check(
		'… avec sa raison de révision intacte',
		revisions[1]?.revisionReason?.startsWith('preuve de rétention') === true
	);

	// ── H. Le réglage, et le refus par défaut ────────────────────────
	section('§H — la fenêtre se règle sans redéploiement, et le défaut ne purge rien');

	const defaultWeeks = await loadDetailRetentionWeeks(db);
	check(
		'sans clé écrite, la rétention est DÉSACTIVÉE (conserver, jamais purger)',
		defaultWeeks === null,
		`${defaultWeeks}`
	);
	const disabledPlan = await syntheticPlan(defaultWeeks);
	check(
		'… donc le plan ne propose RIEN, même sur des créneaux de 1997',
		disabledPlan.purge.length === 0 && disabledPlan.hold.length === 3
	);

	await saveDetailRetentionWeeks({ db, weeks: 52 });
	check('la clé écrite se relit', (await loadDetailRetentionWeeks(db)) === 52);
	await db.execute(sql`
		UPDATE "seostats"."system_settings" SET value = ${'{"weeks":"beaucoup"}'} WHERE key = ${DETAIL_RETENTION_KEY}
	`);
	check(
		'une valeur corrompue retombe sur « conserver », jamais sur une fenêtre courte',
		(await loadDetailRetentionWeeks(db)) === null
	);

	// ── I. Base rendue à l'identique ─────────────────────────────────
	section('§I — la base est rendue à l’identique');

	await cleanup(initialWeeksRaw);
	const reportsAfter = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."weekly_reports"`);
	const tablesAfter = await scalar(
		sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'seostats'`
	);
	const settingAfter = await db.execute(sql`
		SELECT count(*)::int AS n FROM "seostats"."system_settings" WHERE key = ${DETAIL_RETENTION_KEY}
	`);
	check('rapports', reportsAfter === reportsBefore, `${reportsBefore} → ${reportsAfter}`);
	check('tables', tablesAfter === tablesBefore, `${tablesBefore} → ${tablesAfter}`);
	check(
		'réglage restauré',
		Number((settingAfter.rows?.[0] as { n: number }).n) === (initialWeeksRaw === null ? 0 : 1)
	);

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
		// Filet : même en cas d'exception, aucun rapport synthétique ne reste en base.
		await db
			.execute(sql`DELETE FROM "seostats"."weekly_reports" WHERE period_slot LIKE ${'1997-%'}`)
			.catch(() => {});
		await pool.end();
	});
