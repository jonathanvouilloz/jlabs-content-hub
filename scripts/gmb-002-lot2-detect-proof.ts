/**
 * GMB-002 lot 2 — Preuve du détecteur d'avis sans réponse (sur Neon).
 *
 * Le jugement (seuils, horodatage, portée, closure, tour d'équité, score, preuves) est couvert
 * par vitest (`review-pending-state.test.ts`, 57 tests). Ce qui ne peut PAS s'y prouver — parce
 * que ça vit dans l'unique `(project_id, fingerprint)`, dans `consecutive_misses`, ou dans
 * `reconcileDetectionRun` — se prouve ici contre la vraie base :
 *
 *   P1.  idempotence : deux runs ⇒ `occurrence_count = 2`, UNE ligne, UN seul `created` ;
 *   P2.  coexistence : un 2★ en retard ⇒ DEUX lignes, même `entity_key`, deux types, aucune
 *        collision d'unicité ;
 *   P3.  **le scope PROTÈGE** : fiche passée en `error`, deux runs ⇒ finding toujours `open`,
 *        `consecutive_misses` INCHANGÉ, compté `outOfScope`. C'est la garde qui empêche une
 *        fiche en panne de se lire comme une fiche assainie ;
 *   P4.  auto-résolution quand la réponse arrive, puis RÉOUVERTURE si elle disparaît ;
 *   P5.  **le glissement de fenêtre NE RÉSOUT PAS** : un avis sorti de la fenêtre SLA est laissé
 *        strictement intact. Sans cette symétrie scope/closure, 332 avis toujours sans réponse
 *        s'auto-résoudraient sur `barberconcept` ;
 *   P6.  `last_seen_at IS NULL` (les lignes héritées du backfill) ⇒ 0 finding, 0 portée ;
 *   P7.  **format mixte de `create_time`** : deux avis du même jour, l'un en ISO, l'autre au
 *        format DB, avec un seuil qui tombe entre les deux ⇒ EXACTEMENT un retenu, le bon ;
 *   P8.  projet sans fiche ⇒ `no_gmb_location`, `reconciled: false`, aucune écriture ;
 *   P9.  la TRONCATURE n'auto-résout pas : 40 avis, plafond 5 ⇒ 5 écrits, closure 40, et au run
 *        suivant aucun des 35 non écrits n'est résolu ;
 *   P10. **tour d'équité par fiche** : une fiche à 30 avis et une à 3, plafond 10 ⇒ la petite
 *        garde au moins une place ;
 *   P11. `evidence_json` ne porte NI le nom de l'auteur NI le texte de l'avis — le journal
 *        `finding_events` est append-only, ce qu'on y écrit ne s'efface plus ;
 *   P12. dry-run : `findings` et `finding_events` identiques avant/après ;
 *   P13. divergence GMB-007 (`replied_at` sans `remote_reply_at`) ⇒ comptée, JAMAIS un finding :
 *        rouvrir la file produirait une seconde réponse au même client.
 *
 * ⚠️ AUCUNE REQUÊTE RÉSEAU NE PART : ce détecteur ne sort pas de Postgres.
 *
 * Isolation. Deux établissements sentinelles `locations/SENTINELLE-GMB002-LOT2{,-B}`,
 * `review_id` préfixés `sentinelle-gmb002-lot2-`, instant de référence FIGÉ. Nettoyage dans un
 * `finally`, enfants d'abord (`finding_events` → `findings` → `gmb_reviews` →
 * `project_gmb_locations`), avec comparaison aux BASELINES comptées avant.
 * Un Ctrl-C SAUTE ce nettoyage : supprimer alors, dans cet ordre, les lignes de
 * `seostats.finding_events` puis `seostats.findings` dont le `fingerprint` contient
 * `sentinelle-gmb002-lot2-`, celles de `seostats.gmb_reviews` dont `review_id LIKE
 * 'sentinelle-gmb002-lot2-%'`, puis celles de `seostats.project_gmb_locations` dont
 * `gmb_location_id LIKE 'locations/SENTINELLE-GMB002-LOT2%'`.
 *
 * ⚠️ LE PROJET PORTEUR DOIT ÊTRE VIERGE SUR TROIS POINTS, et le script les VÉRIFIE avant
 *    d'écrire :
 *      1. **aucune fiche GMB réelle** — leçon du lot 1 : le collecteur avait écrit de faux
 *         `last_sync_*` sur six fiches de production, la colonne même qui sert de `scope` ici ;
 *      2. **aucun finding `review_pending_sla` ni `negative_review`** — `reconcileDetectionRun`
 *         travaille à l'échelle du PROJET : un finding de production y serait auto-résolu ;
 *      3. **aucun finding en veille** — `expireSnoozes({ projectId })` réveille TOUS les types.
 *
 * Lancer : npx tsx scripts/gmb-002-lot2-detect-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { runReviewPendingDetector } from '../src/lib/server/detectors/review-pending.js';
import {
	NEGATIVE_REVIEW_TYPE,
	REVIEW_PENDING_SLA_TYPE
} from '../src/lib/server/detectors/review-pending-state.js';
import { createId } from '../src/lib/server/utils.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';

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

const LOC_A = 'locations/SENTINELLE-GMB002-LOT2';
const LOC_B = 'locations/SENTINELLE-GMB002-LOT2-B';
const LABEL_A = 'Sentinelle Lot2 A';
const LABEL_B = 'Sentinelle Lot2 B';
const KEY_PREFIX = 'sentinelle-gmb002-lot2-';
/** Instant de référence FIGÉ : la preuve doit rendre le même verdict demain. */
const NOW = new Date('2026-07-28T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
/** Chaînes distinctives, cherchées telles quelles dans `evidence_json` (P11). */
const SENTINEL_AUTHOR = 'ZzAuteurSentinelleLot2';
const SENTINEL_COMMENT = 'ZzCommentaireSentinelleLot2';

function daysAgoIso(days: number, hour = 10): string {
	const d = new Date(NOW.getTime() - days * DAY);
	d.setUTCHours(hour, 0, 0, 0);
	return d.toISOString();
}
function daysAgoDb(days: number, hours = 0): string {
	return toDbTimestamp(new Date(NOW.getTime() - days * DAY - hours * 3_600_000));
}

let projectId = '';

async function seedLocation(gmbLocationId: string, label: string, status = 'success'): Promise<void> {
	await pool.query(
		`INSERT INTO "seostats"."project_gmb_locations"
		   (id, project_id, gmb_location_id, label, last_sync_at, last_sync_status)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		[createId(), projectId, gmbLocationId, label, daysAgoDb(0, 1), status]
	);
}

async function seedReview(input: {
	key: string;
	rating: number;
	createTime: string;
	locationId?: string;
	repliedAt?: string | null;
	remoteReplyAt?: string | null;
	lastSeenAt?: string | null;
	draftReply?: string | null;
}): Promise<void> {
	const locationId = input.locationId ?? LOC_A;
	await pool.query(
		`INSERT INTO "seostats"."gmb_reviews"
		   (id, project_id, location_id, location_label, review_id, author_name, rating, comment,
		    create_time, replied_at, remote_reply_at, last_seen_at, draft_reply)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		[
			createId(),
			projectId,
			locationId,
			locationId === LOC_B ? LABEL_B : LABEL_A,
			`${KEY_PREFIX}${input.key}`,
			SENTINEL_AUTHOR,
			input.rating,
			SENTINEL_COMMENT,
			input.createTime,
			input.repliedAt ?? null,
			input.remoteReplyAt ?? null,
			input.lastSeenAt === undefined ? daysAgoDb(0, 0.5) : input.lastSeenAt,
			input.draftReply ?? null
		]
	);
}

type FindingRow = {
	id: string;
	type: string;
	entity_key: string;
	status: string;
	severity: string;
	occurrence_count: number;
	consecutive_misses: number;
	reopen_count: number;
	evidence_json: string | null;
	recommended_skill: string | null;
};

async function sentinelFindings(): Promise<FindingRow[]> {
	const { rows } = await pool.query<FindingRow>(
		`SELECT id, type, entity_key, status, severity, occurrence_count, consecutive_misses,
		        reopen_count, evidence_json, recommended_skill
		   FROM "seostats"."findings"
		  WHERE project_id = $1 AND fingerprint LIKE $2
		  ORDER BY type, entity_key`,
		[projectId, `%${KEY_PREFIX}%`]
	);
	return rows;
}

async function sentinelEvents(): Promise<{ event_type: string; finding_id: string }[]> {
	const { rows } = await pool.query<{ event_type: string; finding_id: string }>(
		`SELECT e.event_type, e.finding_id
		   FROM "seostats"."finding_events" e
		   JOIN "seostats"."findings" f ON f.id = e.finding_id
		  WHERE f.project_id = $1 AND f.fingerprint LIKE $2
		  ORDER BY e.created_at`,
		[projectId, `%${KEY_PREFIX}%`]
	);
	return rows;
}

async function countAll(table: string): Promise<number> {
	const { rows } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM "seostats"."${table}"`
	);
	return Number(rows[0]?.n ?? '0');
}

/** Efface la scène (findings + avis), garde les fiches. Chaque preuve part d'une base nette. */
async function resetScene(): Promise<void> {
	await pool.query(
		`DELETE FROM "seostats"."finding_events" e
		  USING "seostats"."findings" f
		  WHERE e.finding_id = f.id AND f.project_id = $1 AND f.fingerprint LIKE $2`,
		[projectId, `%${KEY_PREFIX}%`]
	);
	await pool.query(
		`DELETE FROM "seostats"."findings" WHERE project_id = $1 AND fingerprint LIKE $2`,
		[projectId, `%${KEY_PREFIX}%`]
	);
	await pool.query(`DELETE FROM "seostats"."gmb_reviews" WHERE review_id LIKE $1`, [
		`${KEY_PREFIX}%`
	]);
}

async function cleanup(): Promise<void> {
	await resetScene();
	await pool.query(
		`DELETE FROM "seostats"."project_gmb_locations" WHERE gmb_location_id LIKE $1`,
		[`${LOC_A}%`]
	);
}

type RunOverrides = Partial<
	Omit<Parameters<typeof runReviewPendingDetector>[0], 'db' | 'projectId' | 'now'>
>;

/** Un run du détecteur sur la scène, à l'instant FIGÉ. */
const run = (over: RunOverrides = {}) =>
	runReviewPendingDetector({ db, projectId, now: NOW, ...over });

async function main() {
	console.log('Preuve GMB-002 lot 2 — détecteur d’avis sans réponse\n');

	// ── Garde 1 : un projet SANS fiche réelle ────────────────────────
	const { rows: projectRows } = await pool.query<{ id: string; slug: string }>(
		`SELECT p.id, p.slug FROM "seostats"."projects" p
		  WHERE p.archived = false
		    AND NOT EXISTS (SELECT 1 FROM "seostats"."project_gmb_locations" l
		                     WHERE l.project_id = p.id)
		  ORDER BY p.slug LIMIT 1`
	);
	const project = projectRows[0];
	if (!project) {
		throw new Error(
			'Aucun projet actif SANS fiche GMB : la scène ne peut pas être étanche. Abandon plutôt ' +
				'que d’écrire de faux faits de synchro sur des fiches de production.'
		);
	}
	projectId = project.id;
	console.log(`Projet porteur (FK, sans fiche réelle) : ${project.slug}`);

	// ── Gardes 2 et 3 : ni finding d'avis, ni finding en veille ──────
	// `reconcileDetectionRun` et `expireSnoozes` travaillent à l'échelle du PROJET : un finding
	// de production y serait auto-résolu ou réveillé par cette preuve.
	const { rows: existing } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM "seostats"."findings"
		  WHERE project_id = $1 AND type IN ($2, $3)`,
		[projectId, REVIEW_PENDING_SLA_TYPE, NEGATIVE_REVIEW_TYPE]
	);
	if (existing[0]?.n !== '0') {
		throw new Error(
			`${project.slug} porte déjà ${existing[0]?.n} finding(s) d’avis : la réconciliation ` +
				'les toucherait. Abandon.'
		);
	}
	const { rows: snoozed } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM "seostats"."findings"
		  WHERE project_id = $1 AND status = 'snoozed'`,
		[projectId]
	);
	if (snoozed[0]?.n !== '0') {
		throw new Error(
			`${project.slug} porte ${snoozed[0]?.n} finding(s) en veille : \`expireSnoozes\` les ` +
				'réveillerait. Abandon.'
		);
	}

	const baseReviews = await countAll('gmb_reviews');
	const baseFindings = await countAll('findings');
	const baseEvents = await countAll('finding_events');
	const baseLocations = await countAll('project_gmb_locations');
	console.log(
		`Baselines : ${baseReviews} avis · ${baseFindings} findings · ${baseEvents} événements · ` +
			`${baseLocations} fiches`
	);

	try {
		// ── P8 — avant toute fiche : un projet sans fiche ────────────
		section('P8. Un projet sans fiche GMB réussit avec un motif NOMMÉ, sans rien écrire');
		const p8 = await run();
		check('skippedReason = no_gmb_location', p8.skippedReason === 'no_gmb_location', String(p8.skippedReason));
		check('cycle de vie NON réconcilié — rien n’a été conclu', p8.lifecycle.reconciled === false);
		check('aucun finding écrit', (await countAll('findings')) === baseFindings);

		await seedLocation(LOC_A, LABEL_A);
		await seedLocation(LOC_B, LABEL_B);

		// ── P1 — idempotence ─────────────────────────────────────────
		section('P1. Deux runs sur le même avis : une ligne, deux occurrences, un seul « created »');
		await seedReview({ key: 'p1', rating: 5, createTime: daysAgoIso(20) });
		await run();
		const p1b = await run();
		const f1 = await sentinelFindings();
		const e1 = await sentinelEvents();
		check('une seule ligne findings', f1.length === 1, `${f1.length}`);
		check('occurrence_count = 2', f1[0]?.occurrence_count === 2, String(f1[0]?.occurrence_count));
		check('un seul événement, et c’est `created`', e1.length === 1 && e1[0].event_type === 'created', JSON.stringify(e1.map((e) => e.event_type)));
		check('le second run compte un `refreshed`', p1b.counts.refreshed === 1, JSON.stringify(p1b.counts));
		check('le skill §10.4 est posé sur le SLA', f1[0]?.recommended_skill === 'gmb-review-responder', String(f1[0]?.recommended_skill));

		// ── P2 — coexistence des deux types ──────────────────────────
		await resetScene();
		section('P2. Un 2★ en retard produit DEUX findings, sans collision d’unicité');
		await seedReview({ key: 'p2', rating: 2, createTime: daysAgoIso(20) });
		await run();
		const f2 = await sentinelFindings();
		check('deux lignes findings', f2.length === 2, `${f2.length}`);
		check('même entity_key', new Set(f2.map((f) => f.entity_key)).size === 1);
		check(
			'les deux types §10.4',
			new Set(f2.map((f) => f.type)).size === 2 &&
				f2.some((f) => f.type === REVIEW_PENDING_SLA_TYPE) &&
				f2.some((f) => f.type === NEGATIVE_REVIEW_TYPE)
		);
		const negative = f2.find((f) => f.type === NEGATIVE_REVIEW_TYPE)!;
		check('l’avis négatif est `critical`', negative.severity === 'critical', negative.severity);
		check(
			'l’avis négatif n’a AUCUN skill (escalade humaine, §10.4)',
			negative.recommended_skill === null,
			String(negative.recommended_skill)
		);

		// ── P11 — aucune PII dans les preuves ────────────────────────
		section('P11. Les preuves ne portent ni le nom de l’auteur ni le texte de l’avis');
		const evidence = f2.map((f) => f.evidence_json ?? '').join('');
		check('pas de nom d’auteur', !evidence.includes(SENTINEL_AUTHOR));
		check('pas de texte d’avis', !evidence.includes(SENTINEL_COMMENT));
		check('l’arriéré par fiche est bien là', evidence.includes('locationBacklog'));
		check('le signal §14.3 est bien là', evidence.includes('"notifyImmediately":true'));

		// ── P3 — le scope protège ────────────────────────────────────
		section('P3. Une fiche passée en erreur laisse ses findings STRICTEMENT intacts');
		await pool.query(
			`UPDATE "seostats"."project_gmb_locations" SET last_sync_status = 'error' WHERE gmb_location_id = $1`,
			[LOC_A]
		);
		const p3a = await run();
		const p3b = await run();
		const f3 = await sentinelFindings();
		check(
			'les deux findings restent ouverts',
			f3.length === 2 && f3.every((f) => f.status === 'open'),
			f3.map((f) => f.status).join(',')
		);
		check(
			'consecutive_misses INCHANGÉ (0) — l’absence de mesure n’est pas une guérison',
			f3.every((f) => f.consecutive_misses === 0),
			f3.map((f) => f.consecutive_misses).join(',')
		);
		check(
			'comptés hors portée aux deux runs',
			p3a.lifecycle.outOfScope >= 2 && p3b.lifecycle.outOfScope >= 2,
			`${p3a.lifecycle.outOfScope} puis ${p3b.lifecycle.outOfScope}`
		);
		check('la fiche est comptée hors portée', p3b.locationsStale >= 1, `${p3b.locationsStale}`);
		await pool.query(
			`UPDATE "seostats"."project_gmb_locations" SET last_sync_status = 'success' WHERE gmb_location_id = $1`,
			[LOC_A]
		);

		// ── P5 — le glissement de fenêtre ne résout pas ──────────────
		await resetScene();
		section('P5. Un avis sorti de la fenêtre est laissé intact, jamais auto-résolu');
		await seedReview({ key: 'p5', rating: 5, createTime: daysAgoIso(20) });
		await run();
		const before5 = await sentinelFindings();
		check('le finding SLA existe', before5.length === 1, `${before5.length}`);
		// Fenêtre resserrée à 10 j : l'avis de 20 j en sort — mais il est TOUJOURS sans réponse.
		const p5a = await run({ thresholds: { slaLookbackDays: 10 } });
		const p5b = await run({ thresholds: { slaLookbackDays: 10 } });
		const after5 = await sentinelFindings();
		check(
			'toujours ouvert après DEUX runs hors fenêtre',
			after5.length === 1 && after5[0].status === 'open',
			after5[0]?.status
		);
		check('consecutive_misses INCHANGÉ', after5[0]?.consecutive_misses === 0, String(after5[0]?.consecutive_misses));
		check('rien d’auto-résolu', p5a.lifecycle.autoResolved === 0 && p5b.lifecycle.autoResolved === 0);
		check('compté hors portée', p5b.lifecycle.outOfScope >= 1, `${p5b.lifecycle.outOfScope}`);

		// ── P4 — auto-résolution puis réouverture ────────────────────
		await resetScene();
		section('P4. La réponse résout après deux absences, sa disparition rouvre');
		await seedReview({ key: 'p4', rating: 5, createTime: daysAgoIso(20) });
		await run();
		await pool.query(`UPDATE "seostats"."gmb_reviews" SET remote_reply_at = $1 WHERE review_id = $2`, [
			daysAgoDb(0, 2),
			`${KEY_PREFIX}p4`
		]);
		const p4a = await run();
		const mid = await sentinelFindings();
		check('première absence : comptée, pas résolue', p4a.lifecycle.missed === 1 && mid[0].status === 'open', `${p4a.lifecycle.missed}/${mid[0]?.status}`);
		check('consecutive_misses = 1', mid[0]?.consecutive_misses === 1, String(mid[0]?.consecutive_misses));
		const p4b = await run();
		const resolved = await sentinelFindings();
		check('seconde absence : auto-résolu', p4b.lifecycle.autoResolved === 1 && resolved[0].status === 'resolved', resolved[0]?.status);
		await pool.query(`UPDATE "seostats"."gmb_reviews" SET remote_reply_at = NULL WHERE review_id = $1`, [
			`${KEY_PREFIX}p4`
		]);
		const p4c = await run();
		const reopened = await sentinelFindings();
		check('la réponse effacée rouvre', p4c.lifecycle.reopened === 1 && reopened[0].status === 'reopened', reopened[0]?.status);
		check('reopen_count = 1', reopened[0]?.reopen_count === 1, String(reopened[0]?.reopen_count));

		// ── P13 — divergence GMB-007 ─────────────────────────────────
		await resetScene();
		section('P13. La divergence hub↔Google est comptée, JAMAIS transformée en finding');
		await seedReview({
			key: 'p13',
			rating: 1,
			createTime: daysAgoIso(30),
			repliedAt: daysAgoDb(25)
		});
		const p13 = await run();
		check('aucun finding', (await sentinelFindings()).length === 0);
		check('comptée `divergent`', p13.excluded.divergent === 1, String(p13.excluded.divergent));
		check('comptée `answered`', p13.excluded.answered === 1, String(p13.excluded.answered));

		// ── P6 — jamais vu chez Google ───────────────────────────────
		await resetScene();
		section('P6. Une ligne héritée du backfill (`last_seen_at IS NULL`) est hors portée');
		await seedReview({ key: 'p6', rating: 1, createTime: daysAgoIso(30), lastSeenAt: null });
		const p6 = await run();
		check('aucun finding', (await sentinelFindings()).length === 0);
		check('comptée `neverSeen`', p6.excluded.neverSeen === 1, String(p6.excluded.neverSeen));
		check('aucune portée', p6.lifecycle.scopeSla === 0 && p6.lifecycle.scopeNegative === 0);

		// ── P7 — format mixte de create_time ─────────────────────────
		await resetScene();
		section('P7. ISO et format DB le même jour : le seuil tombe entre les deux, un seul passe');
		// Comparés lexicalement, 'T' (0x54) > ' ' (0x20) ferait passer l'ISO quoi qu'il arrive.
		await seedReview({ key: 'p7-iso', rating: 5, createTime: '2026-07-25T23:00:00.000000Z' });
		await seedReview({ key: 'p7-db', rating: 5, createTime: '2026-07-25 03:00:00' });
		const p7 = await run({ thresholds: { slaDays: 2 } });
		const f7 = await sentinelFindings();
		check('exactement un finding', f7.length === 1, `${f7.length}`);
		check(
			'et c’est celui du MATIN (le plus vieux), pas celui du soir',
			f7[0]?.entity_key === `${KEY_PREFIX}p7-db`,
			String(f7[0]?.entity_key)
		);
		check('les deux avis étaient dans la portée', p7.inScopeSla === 2, String(p7.inScopeSla));

		// ── P9 — la troncature n'auto-résout pas ─────────────────────
		await resetScene();
		section('P9. Plafond 5 sur 40 candidats : 5 écrits, closure 40, aucune auto-résolution');
		for (let i = 0; i < 40; i += 1) {
			await seedReview({ key: `p9-${String(i).padStart(2, '0')}`, rating: 5, createTime: daysAgoIso(10 + i) });
		}
		const p9a = await run({ thresholds: { maxCandidates: 5 } });
		check('5 findings écrits', (await sentinelFindings()).length === 5, `${(await sentinelFindings()).length}`);
		check('closure = 40 (avant plafond)', p9a.lifecycle.closureSla === 40, String(p9a.lifecycle.closureSla));
		check('la troncature est annoncée', p9a.truncated === true);
		const p9b = await run({ thresholds: { maxCandidates: 5 } });
		const f9 = await sentinelFindings();
		check(
			'au run suivant, aucun des non-écrits n’est auto-résolu',
			p9b.lifecycle.autoResolved === 0 && f9.every((f) => f.status === 'open'),
			`${p9b.lifecycle.autoResolved}`
		);

		// ── P10 — tour d'équité par fiche ────────────────────────────
		await resetScene();
		section('P10. La petite fiche garde une place face à une fiche 10× plus grosse');
		for (let i = 0; i < 30; i += 1) {
			await seedReview({ key: `p10a-${String(i).padStart(2, '0')}`, rating: 1, createTime: daysAgoIso(10 + i), locationId: LOC_A });
		}
		for (let i = 0; i < 3; i += 1) {
			await seedReview({ key: `p10b-${i}`, rating: 5, createTime: daysAgoIso(5 + i), locationId: LOC_B });
		}
		await run({ thresholds: { maxCandidates: 10 } });
		const f10 = await sentinelFindings();
		const smallShare = f10.filter((f) => f.entity_key.startsWith(`${KEY_PREFIX}p10b-`)).length;
		check(
			'la petite fiche a au moins un finding',
			smallShare >= 1,
			`${smallShare} sur ${f10.length} findings`
		);

		// ── P12 — le dry-run n'écrit rien ────────────────────────────
		await resetScene();
		section('P12. Le dry-run laisse findings et journal au bit près');
		await seedReview({ key: 'p12', rating: 1, createTime: daysAgoIso(30) });
		const beforeF = await countAll('findings');
		const beforeE = await countAll('finding_events');
		const p12 = await run({ dryRun: true });
		check('des candidats ont bien été trouvés', p12.reviews.length === 2, `${p12.reviews.length}`);
		check('aucun finding écrit', (await countAll('findings')) === beforeF);
		check('aucun événement écrit', (await countAll('finding_events')) === beforeE);
		check('cycle de vie NON réconcilié en dry-run', p12.lifecycle.reconciled === false);
	} finally {
		section('Nettoyage');
		await cleanup();
		const afterReviews = await countAll('gmb_reviews');
		const afterFindings = await countAll('findings');
		const afterEvents = await countAll('finding_events');
		const afterLocations = await countAll('project_gmb_locations');
		check('gmb_reviews rendue à l’identique', afterReviews === baseReviews, `${afterReviews} / ${baseReviews}`);
		check('findings rendue à l’identique', afterFindings === baseFindings, `${afterFindings} / ${baseFindings}`);
		check('finding_events rendue à l’identique', afterEvents === baseEvents, `${afterEvents} / ${baseEvents}`);
		check('project_gmb_locations rendue à l’identique', afterLocations === baseLocations, `${afterLocations} / ${baseLocations}`);

		// Gardes anti-pollution : aucune trace sentinelle nulle part en production.
		const { rows: pollutedLoc } = await pool.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM "seostats"."project_gmb_locations" WHERE label LIKE 'Sentinelle Lot2%'`
		);
		check('aucune fiche de production marquée', pollutedLoc[0]?.n === '0', pollutedLoc[0]?.n);
		const { rows: pollutedRev } = await pool.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM "seostats"."gmb_reviews" WHERE author_name = $1`,
			[SENTINEL_AUTHOR]
		);
		check('aucun avis de production marqué', pollutedRev[0]?.n === '0', pollutedRev[0]?.n);
		const { rows: pollutedFind } = await pool.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM "seostats"."findings" WHERE fingerprint LIKE $1`,
			[`%${KEY_PREFIX}%`]
		);
		check('aucun finding sentinelle résiduel', pollutedFind[0]?.n === '0', pollutedFind[0]?.n);
	}

	console.log('');
	if (failures > 0) {
		console.error(`❌ ${failures} vérification(s) en échec.`);
		process.exitCode = 1;
	} else {
		console.log('✅ Toutes les vérifications passent (P1 à P13).');
	}
	await pool.end();
}

main().catch(async (err) => {
	console.error('Preuve échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
