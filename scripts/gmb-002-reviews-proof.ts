/**
 * GMB-002 — Preuve du collecteur d'avis réconciliant (sur Neon).
 *
 * Le jugement (parsing d'erreur, normalisation, diff, bornes) est couvert par vitest
 * (`gmb-reviews-state.test.ts`, 40 tests). Ce qui ne peut PAS se prouver en vitest, et se
 * prouve ici contre la vraie base :
 *
 *   P1. la **pagination** ramène toutes les pages, l'écriture pose `last_seen_at` sur chaque
 *       avis et `last_sync_at`/`last_sync_status='success'` sur l'établissement ;
 *   P2. acceptation « deux syncs ne créent pas deux avis » — et elle n'est plus GRATUITE :
 *       le chemin fait désormais des `UPDATE` (`onConflictDoUpdate`), là où l'ancien
 *       `onConflictDoNothing` la garantissait sans rien faire. Une charge identique doit
 *       produire **0 insert, 0 update**, et rafraîchir `last_seen_at` malgré tout ;
 *   P3. **LE point du lot** : acceptation « une réponse faite manuellement chez Google est
 *       importée ». Et sa contre-épreuve indissociable — `draft_reply` et `replied_at`, qui
 *       sont LOCALES, doivent rester **intactes au caractère près**. Un `SET` généreux
 *       effacerait des mois de brouillons au premier passage ;
 *   P4. un avis **omis** par Google n'est pas supprimé : la ligne reste, son `last_seen_at`
 *       devient antérieur au `last_sync_at` de sa location — la disparition devient un fait
 *       DÉRIVABLE (matière du lot 2), jamais un DELETE ;
 *   P5. un **429** produit une `GmbApiError` structurée que `classifyJobFailure` classe
 *       `quota` (donc refroidissement JOB-006), et l'établissement porte
 *       `last_sync_status='error'` + `last_sync_error` — la fin du `catch {}` anonyme ;
 *   P6. un avis dont la **note change** invalide son brouillon (GMB-002), alors qu'une
 *       simple réponse distante ne l'invalide pas ;
 *   P7. un projet **sans fiche GMB** réussit avec un motif NOMMÉ (5 des 9 projets).
 *
 * ⚠️ AUCUNE REQUÊTE RÉSEAU NE PART. Le collecteur reçoit `deps.fetchImpl`, un faux `fetch`
 *    qui rend des enveloppes GBP v4 canoniques. C'est ce qui rend la preuve rejouable sans
 *    toucher au compte Google réel ni brûler de quota — et ce qui permet de fabriquer un 429
 *    à la demande, chose qu'un vrai appel ne saurait pas produire volontairement.
 *
 * Isolation. Établissement sentinelle `locations/SENTINELLE-GMB002`, `review_id` préfixés
 * `sentinelle-gmb002-`, dates **2018-11-xx**, sous un projet RÉEL (contrainte FK). Nettoyage
 * dans un `finally`, enfants d'abord, avec comparaison à la BASELINE comptée avant.
 * Un Ctrl-C SAUTE ce nettoyage : supprimer alors les lignes de `seostats.gmb_reviews` dont
 * `review_id LIKE 'sentinelle-gmb002-%'`, puis celle de `seostats.project_gmb_locations`
 * dont `gmb_location_id = 'locations/SENTINELLE-GMB002'`.
 *
 * ⚠️ LE PROJET PORTEUR DOIT N'AVOIR AUCUNE FICHE RÉELLE, et le script le VÉRIFIE avant
 *    d'écrire quoi que ce soit. La raison a été apprise à la dure : la première version
 *    prenait le premier projet actif par ordre alphabétique (`barberconcept`, 6 fiches). Le
 *    collecteur parcourant TOUS les établissements de son projet, il a écrit un
 *    `last_sync_at` de 2018 et un `last_sync_status='success'` sur six fiches de production
 *    — six faits FAUX dans la colonne même qui sert de `scope` au détecteur du lot 2. Les
 *    avis, eux, n'ont jamais été touchés (le faux `fetch` ne rend que des sentinelles), et
 *    les six lignes ont été remises à NULL. Un projet sans fiche rend la scène étanche :
 *    la sentinelle est alors le SEUL établissement que le collecteur peut voir.
 *
 * Lancer : npx tsx scripts/gmb-002-reviews-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { collectGmbReviews } from '../src/lib/server/collectors/gmb-reviews.js';
import { GmbApiError } from '../src/lib/server/collectors/gmb-reviews-state.js';
import { classifyJobFailure } from '../src/lib/server/job-retry.js';
import { createId } from '../src/lib/server/utils.js';

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

const SENTINEL_LOCATION = 'locations/SENTINELLE-GMB002';
const SENTINEL_LABEL = 'Sentinelle GMB-002';
const KEY_PREFIX = 'sentinelle-gmb002-';
const ACCOUNT_ID = '000000000000000000';

/** Une enveloppe d'avis GBP v4, telle que Google la renvoie. */
function review(input: {
	n: number;
	rating?: string;
	comment?: string;
	reply?: { comment: string; updateTime: string } | null;
	createTime?: string;
	updateTime?: string;
}) {
	return {
		name: `accounts/${ACCOUNT_ID}/locations/SENTINELLE-GMB002/reviews/${KEY_PREFIX}${input.n}`,
		reviewer: { displayName: `Client ${input.n}` },
		starRating: input.rating ?? 'FIVE',
		comment: input.comment ?? `Commentaire ${input.n}`,
		createTime: input.createTime ?? `2018-11-0${input.n}T10:00:00.000000Z`,
		updateTime: input.updateTime ?? `2018-11-0${input.n}T10:00:00.000000Z`,
		...(input.reply ? { reviewReply: input.reply } : {})
	};
}

/**
 * Faux `fetch` : rend les pages fournies, dans l'ordre, en chaînant `nextPageToken`.
 * `status` non nul force une erreur HTTP avec un corps Google canonique.
 */
function fakeFetch(pages: unknown[][], fail?: { status: number; body: string }): typeof fetch {
	return (async (url: string | URL) => {
		if (fail) {
			return new Response(fail.body, {
				status: fail.status,
				headers: { 'retry-after': '90' }
			});
		}
		const token = new URL(String(url)).searchParams.get('pageToken');
		const idx = token ? Number(token) : 0;
		const body = {
			reviews: pages[idx] ?? [],
			...(idx + 1 < pages.length ? { nextPageToken: String(idx + 1) } : {})
		};
		return new Response(JSON.stringify(body), { status: 200 });
	}) as unknown as typeof fetch;
}

const DEPS = (pages: unknown[][], fail?: { status: number; body: string }) => ({
	getAccessToken: async () => 'faux-jeton',
	getAccountId: async () => ACCOUNT_ID,
	fetchImpl: fakeFetch(pages, fail)
});

/** L'état d'un avis sentinelle, tel que la base le garde. */
async function readReview(n: number) {
	const { rows } = await pool.query<{
		rating: number;
		comment: string;
		draft_reply: string | null;
		replied_at: string | null;
		remote_reply_text: string | null;
		remote_reply_at: string | null;
		remote_update_at: string | null;
		last_seen_at: string | null;
	}>(
		`SELECT rating, comment, draft_reply, replied_at, remote_reply_text, remote_reply_at,
		        remote_update_at, last_seen_at
		   FROM "seostats"."gmb_reviews" WHERE review_id = $1`,
		[`${KEY_PREFIX}${n}`]
	);
	return rows[0] ?? null;
}

async function readLocation() {
	const { rows } = await pool.query<{
		last_sync_at: string | null;
		last_sync_status: string | null;
		last_sync_error: string | null;
	}>(
		`SELECT last_sync_at, last_sync_status, last_sync_error
		   FROM "seostats"."project_gmb_locations" WHERE gmb_location_id = $1`,
		[SENTINEL_LOCATION]
	);
	return rows[0] ?? null;
}

async function countSentinelReviews(): Promise<number> {
	const { rows } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM "seostats"."gmb_reviews" WHERE review_id LIKE $1`,
		[`${KEY_PREFIX}%`]
	);
	return Number(rows[0]?.n ?? '0');
}

async function baselineReviews(): Promise<number> {
	const { rows } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM "seostats"."gmb_reviews"`
	);
	return Number(rows[0]?.n ?? '0');
}

async function cleanup(locationRowId: string | null): Promise<void> {
	await pool.query(`DELETE FROM "seostats"."gmb_reviews" WHERE review_id LIKE $1`, [
		`${KEY_PREFIX}%`
	]);
	if (locationRowId) {
		await pool.query(`DELETE FROM "seostats"."project_gmb_locations" WHERE id = $1`, [
			locationRowId
		]);
	}
}

async function main() {
	console.log('Preuve GMB-002 — collecteur d’avis réconciliant\n');

	// Un projet SANS aucune fiche réelle : le collecteur parcourt tous les établissements de
	// son projet, donc n'importe quel projet équipé ferait écrire de faux `last_sync_*` sur
	// des fiches de production — la colonne même qui servira de `scope` au lot 2.
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
			'Aucun projet actif SANS fiche GMB : la scène ne peut pas être étanche. Abandon ' +
				'plutôt que d’écrire de faux faits de synchro sur des fiches de production.'
		);
	}
	console.log(`Projet porteur (FK, sans fiche réelle) : ${project.slug}`);

	// Garde de dernière seconde : si une fiche apparaissait entre la requête et l'insertion,
	// la scène ne serait plus étanche.
	const { rows: guardRows } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM "seostats"."project_gmb_locations" WHERE project_id = $1`,
		[project.id]
	);
	if (guardRows[0]?.n !== '0') {
		throw new Error(`Le projet ${project.slug} porte ${guardRows[0]?.n} fiche(s). Abandon.`);
	}

	const baseline = await baselineReviews();
	console.log(`Baseline gmb_reviews : ${baseline} lignes`);

	let locationRowId: string | null = null;

	try {
		locationRowId = createId();
		await pool.query(
			`INSERT INTO "seostats"."project_gmb_locations" (id, project_id, gmb_location_id, label)
			 VALUES ($1, $2, $3, $4)`,
			[locationRowId, project.id, SENTINEL_LOCATION, SENTINEL_LABEL]
		);

		// ── P1 — pagination et faits de synchro ──────────────────────────────────────────
		section('P1. Pagination complète, last_seen_at et last_sync_* écrits');
		const p1 = await collectGmbReviews({
			projectId: project.id,
			deps: DEPS([
				[review({ n: 1 }), review({ n: 2 })],
				[review({ n: 3, rating: 'TWO', comment: 'Déçu' }), review({ n: 4 })]
			]),
			client: db
		});
		check('4 avis vus sur 2 pages', p1.summary.seen === 4, `seen=${p1.summary.seen}`);
		check('4 insérés', p1.summary.inserted === 4, `inserted=${p1.summary.inserted}`);
		check('aucune troncature', p1.summary.truncated === false);
		check('aucun motif d’abandon', p1.skippedReason === null, String(p1.skippedReason));
		const r1 = await readReview(1);
		check('last_seen_at posé sur l’avis', r1?.last_seen_at === p1.syncedAt, String(r1?.last_seen_at));
		const loc1 = await readLocation();
		check(
			'établissement en succès, sans message d’erreur',
			loc1?.last_sync_status === 'success' && loc1?.last_sync_error === null,
			`${loc1?.last_sync_status} / ${loc1?.last_sync_error ?? '∅'}`
		);
		check('last_sync_at écrit', loc1?.last_sync_at === p1.syncedAt, String(loc1?.last_sync_at));

		// On pose des données LOCALES, celles que la réconciliation ne doit jamais toucher.
		await pool.query(
			`UPDATE "seostats"."gmb_reviews"
			    SET draft_reply = $1, replied_at = $2, mentioned_employees = $3
			  WHERE review_id = $4`,
			['Brouillon écrit à la main', '2018-11-05 09:00:00', '[{"name":"Léa"}]', `${KEY_PREFIX}1`]
		);

		// ── P2 — idempotence sur un chemin qui fait des UPDATE ───────────────────────────
		section('P2. Charge IDENTIQUE : aucune écriture de contenu, last_seen_at rafraîchi');
		const p2 = await collectGmbReviews({
			projectId: project.id,
			deps: DEPS([
				[review({ n: 1 }), review({ n: 2 })],
				[review({ n: 3, rating: 'TWO', comment: 'Déçu' }), review({ n: 4 })]
			]),
			client: db,
			now: new Date('2018-11-20T12:00:00Z')
		});
		check('0 inséré', p2.summary.inserted === 0, `inserted=${p2.summary.inserted}`);
		check('0 modifié', p2.summary.updated === 0, `updated=${p2.summary.updated}`);
		check('4 inchangés', p2.summary.unchanged === 4, `unchanged=${p2.summary.unchanged}`);
		check('toujours 4 lignes (aucun doublon)', (await countSentinelReviews()) === 4);
		const r1b = await readReview(1);
		check(
			'last_seen_at RAFRAÎCHI malgré l’absence de changement',
			r1b?.last_seen_at === '2018-11-20 12:00:00',
			String(r1b?.last_seen_at)
		);
		check(
			'« j’ai regardé et c’est identique » ≠ « je n’ai pas regardé »',
			r1b?.last_seen_at !== r1?.last_seen_at
		);

		// ── P3 — LE point du lot ────────────────────────────────────────────────────────
		section('P3. Réponse faite chez Google importée — colonnes LOCALES intactes');
		const p3 = await collectGmbReviews({
			projectId: project.id,
			deps: DEPS([
				[
					review({
						n: 1,
						reply: { comment: 'Merci beaucoup !', updateTime: '2018-11-21T08:30:00Z' }
					}),
					review({ n: 2 })
				],
				[review({ n: 3, rating: 'TWO', comment: 'Déçu' }), review({ n: 4 })]
			]),
			client: db,
			now: new Date('2018-11-21T12:00:00Z')
		});
		check('1 modifié', p3.summary.updated === 1, `updated=${p3.summary.updated}`);
		const r1c = await readReview(1);
		check(
			'la réponse distante est importée',
			r1c?.remote_reply_text === 'Merci beaucoup !',
			String(r1c?.remote_reply_text)
		);
		check(
			'remote_reply_at au format DB (comparable lexicalement)',
			r1c?.remote_reply_at === '2018-11-21 08:30:00',
			String(r1c?.remote_reply_at)
		);
		// La contre-épreuve indissociable : un SET généreux aurait effacé les trois.
		check(
			'draft_reply INTACT au caractère près',
			r1c?.draft_reply === 'Brouillon écrit à la main',
			String(r1c?.draft_reply)
		);
		check('replied_at INTACT', r1c?.replied_at === '2018-11-05 09:00:00', String(r1c?.replied_at));
		check('aucun brouillon invalidé (la note n’a pas bougé)', p3.draftsInvalidated === 0);

		// ── P4 — la disparition est un fait, pas un DELETE ───────────────────────────────
		section('P4. Avis OMIS par Google : la ligne reste, le fait devient dérivable');
		const p4 = await collectGmbReviews({
			projectId: project.id,
			deps: DEPS([[review({ n: 1, reply: { comment: 'Merci beaucoup !', updateTime: '2018-11-21T08:30:00Z' } })]]),
			client: db,
			now: new Date('2018-11-22T12:00:00Z')
		});
		check('1 seul avis vu', p4.summary.seen === 1, `seen=${p4.summary.seen}`);
		check('les 4 lignes sont TOUJOURS là', (await countSentinelReviews()) === 4);
		const r4 = await readReview(4);
		const loc4 = await readLocation();
		check(
			'l’avis omis garde son ancien last_seen_at',
			r4?.last_seen_at === '2018-11-21 12:00:00',
			String(r4?.last_seen_at)
		);
		check(
			'last_seen_at ANTÉRIEUR au last_sync_at réussi ⇒ disparition dérivable',
			Boolean(r4?.last_seen_at && loc4?.last_sync_at && r4.last_seen_at < loc4.last_sync_at),
			`${r4?.last_seen_at} < ${loc4?.last_sync_at}`
		);

		// ── P5 — la fin du catch {} ─────────────────────────────────────────────────────
		section('P5. 429 : erreur STRUCTURÉE, classée quota, écrite sur l’établissement');
		let caught: unknown = null;
		try {
			await collectGmbReviews({
				projectId: project.id,
				deps: DEPS([], {
					status: 429,
					body: JSON.stringify({
						error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' }
					})
				}),
				client: db,
				now: new Date('2018-11-23T12:00:00Z')
			});
		} catch (err) {
			caught = err;
		}
		check('l’erreur remonte (elle n’est pas avalée)', caught !== null);
		check('c’est une GmbApiError', caught instanceof GmbApiError);
		check(
			'status et reason sont STRUCTURÉS',
			caught instanceof GmbApiError &&
				caught.status === 429 &&
				caught.reason === 'RESOURCE_EXHAUSTED',
			caught instanceof GmbApiError ? `${caught.status} / ${caught.reason}` : '—'
		);
		const classified = classifyJobFailure(caught);
		check(
			'classifyJobFailure rend « quota » ⇒ refroidissement JOB-006',
			classified.errorClass === 'quota',
			classified.errorClass
		);
		check(
			'Retry-After honoré (90 s)',
			classified.retryAfterMs === 90_000,
			String(classified.retryAfterMs)
		);
		const loc5 = await readLocation();
		check(
			'l’établissement porte son échec en base',
			loc5?.last_sync_status === 'error' && Boolean(loc5?.last_sync_error),
			`${loc5?.last_sync_status} / ${loc5?.last_sync_error?.slice(0, 60) ?? '∅'}`
		);
		check(
			'le message d’erreur nomme le statut ET la raison',
			Boolean(loc5?.last_sync_error?.includes('429') && loc5.last_sync_error.includes('RESOURCE_EXHAUSTED')),
			loc5?.last_sync_error?.slice(0, 80) ?? '∅'
		);

		// ── P6 — un avis modifié invalide son brouillon ──────────────────────────────────
		section('P6. Note modifiée ⇒ brouillon invalidé (GMB-002)');
		await pool.query(`UPDATE "seostats"."gmb_reviews" SET draft_reply = $1 WHERE review_id = $2`, [
			'Merci pour ces 5 étoiles !',
			`${KEY_PREFIX}2`
		]);
		const p6 = await collectGmbReviews({
			projectId: project.id,
			deps: DEPS([[review({ n: 2, rating: 'ONE', comment: 'Finalement très déçu' })]]),
			client: db,
			now: new Date('2018-11-24T12:00:00Z')
		});
		const r2 = await readReview(2);
		check('1 brouillon invalidé', p6.draftsInvalidated === 1, String(p6.draftsInvalidated));
		check('le brouillon est effacé', r2?.draft_reply === null, String(r2?.draft_reply));
		check('la nouvelle note est écrite', r2?.rating === 1, String(r2?.rating));
		// Répondre « merci pour ces 5 étoiles » à un avis devenu 1★ serait pire que se taire.
		const r1d = await readReview(1);
		check(
			'le brouillon d’un avis NON modifié survit',
			r1d?.draft_reply === 'Brouillon écrit à la main',
			String(r1d?.draft_reply)
		);

		// ── P7 — projet sans fiche ──────────────────────────────────────────────────────
		section('P7. Projet SANS fiche GMB : succès avec un motif NOMMÉ');
		const { rows: bareRows } = await pool.query<{ id: string; slug: string }>(
			`SELECT p.id, p.slug FROM "seostats"."projects" p
			  WHERE p.archived = false
			    AND NOT EXISTS (SELECT 1 FROM "seostats"."project_gmb_locations" l
			                     WHERE l.project_id = p.id)
			  ORDER BY p.slug LIMIT 1`
		);
		if (bareRows[0]) {
			const p7 = await collectGmbReviews({
				projectId: bareRows[0].id,
				deps: DEPS([]),
				client: db
			});
			check(
				`« ${bareRows[0].slug} » : motif nommé, pas un silence`,
				p7.skippedReason === 'no_gmb_location',
				String(p7.skippedReason)
			);
			check('0 établissement, et ce n’est PAS un échec', p7.summary.allFailed === false);
		} else {
			check('aucun projet sans fiche à tester (ignoré)', true);
		}
	} finally {
		section('Nettoyage');
		await cleanup(locationRowId);
		const after = await baselineReviews();
		check(
			'la base est rendue à l’identique',
			after === baseline,
			`${baseline} avant / ${after} après`
		);
		const { rows: locLeft } = await pool.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM "seostats"."project_gmb_locations" WHERE gmb_location_id = $1`,
			[SENTINEL_LOCATION]
		);
		check('établissement sentinelle supprimé', locLeft[0]?.n === '0');

		// La garde qui a manqué à la première version : AUCUNE fiche de production ne doit
		// porter une date sentinelle. Une seule suffirait à mentir au `scope` du lot 2.
		const { rows: polluted } = await pool.query<{ n: string; labels: string | null }>(
			`SELECT count(*)::text AS n, string_agg(label, ', ') AS labels
			   FROM "seostats"."project_gmb_locations"
			  WHERE last_sync_at LIKE '2018-%'`
		);
		check(
			'aucune fiche de production polluée par une date sentinelle',
			polluted[0]?.n === '0',
			polluted[0]?.labels ?? '∅'
		);

		// Et aucun avis réel ne doit porter la marque du faux collecteur.
		const { rows: touched } = await pool.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM "seostats"."gmb_reviews" WHERE last_seen_at LIKE '2018-%'`
		);
		check('aucun avis de production marqué par la sentinelle', touched[0]?.n === '0');
		await pool.end();
	}

	console.log('');
	if (failures > 0) {
		console.error(`❌ Preuve GMB-002 : ${failures} vérification(s) en échec.`);
		process.exitCode = 1;
	} else {
		console.log('✅ Preuve GMB-002 : toutes les vérifications passent.');
	}
}

main().catch(async (err) => {
	console.error('Preuve GMB-002 échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
