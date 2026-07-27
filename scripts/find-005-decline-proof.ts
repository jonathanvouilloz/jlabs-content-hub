/**
 * FIND-005 — Preuve du détecteur de baisses sur une VRAIE base.
 *
 * Ce que vitest ne peut PAS montrer, et qui est prouvé ici :
 *   - le découpage des fenêtres sur les semaines RÉELLES d'un projet réel
 *     (68 semaines pour `lecureux`, 6 pour `spinlink` : la même fonction rend deux
 *     verdicts opposés sur la comparabilité du 4 semaines) ;
 *   - l'upsert idempotent sur l'unique `(project_id, fingerprint)` ;
 *   - la réconciliation FIND-003 réelle : une récupération sort de la closure, compte
 *     ses absences, et n'auto-résout qu'au seuil — jamais à la première.
 *
 * ── ISOLATION (lire avant de modifier ce script) ────────────────────────────────
 *
 * Le détecteur travaille sur TOUT le projet : lancé tel quel sur un projet réel, il
 * écrirait de VRAIS findings. L'isolation repose sur `minPriorImpressions` poussé à
 * 500 000 alors que l'observation la plus grosse du parc pèse 7 904 impressions :
 * aucun couple réel ne peut franchir le seuil, seuls les couples injectés le peuvent.
 * Ce n'est pas une supposition — §G le VÉRIFIE : tout finding `keyword_decline` créé
 * pendant le run doit porter le marqueur, sinon la preuve échoue et nettoie quand même.
 *
 * ⚠️ La PROD écrit dans la même base (snapshot GSC legacy de `main`). Ce script
 * n'assert donc JAMAIS un total d'observations projet « rendu à l'identique » : il
 * compte ses PROPRES lignes (marqueur) et les ramène à zéro. Les findings, eux, ne
 * sont écrits par personne en prod (`main` n'a aucun détecteur) : leur total est,
 * lui, assertable.
 *
 * Lancer : npx tsx scripts/find-005-decline-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { createId } from '../src/lib/server/utils.js';
import { runKeywordDeclineDetector } from '../src/lib/server/detectors/keyword-decline.js';
import { DECLINE_DEFAULTS } from '../src/lib/server/detectors/keyword-decline-state.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

/** Marqueur exclusif : aucun couple réel ne commence par cette chaîne. */
const MARK = '__test_find005';
const RUN_KEY = createId().slice(0, 8);
const q = (name: string) => `${MARK}:${RUN_KEY}:${name}`;
const pg = (name: string) => `https://${MARK}.test/${RUN_KEY}/${name}`;

/**
 * Seuil d'isolation : 63× la plus grosse observation du parc. Descendre cette valeur
 * fait entrer de vrais couples dans la détection — et §G le fera échouer.
 */
const ISOLATION_MIN_IMPRESSIONS = 500_000;
const WEEK_IMPRESSIONS = 600_000;

const THRESHOLDS = {
	...DECLINE_DEFAULTS,
	minPriorImpressions: ISOLATION_MIN_IMPRESSIONS
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}
function section(title: string): void {
	console.log(`\n${title}`);
}

// ── Helpers base ────────────────────────────────────────────────────

async function projectBySlug(slug: string): Promise<{ id: string; slug: string }> {
	const rows = await db
		.select({ id: schema.projects.id, slug: schema.projects.slug })
		.from(schema.projects)
		.where(eq(schema.projects.slug, slug));
	if (rows.length === 0) throw new Error(`Projet "${slug}" absent.`);
	return rows[0];
}

/** Les N semaines les plus récentes réellement présentes pour le projet. */
async function recentWeeks(projectId: string, n: number): Promise<{ start: string; end: string }[]> {
	const rows = await db
		.selectDistinct({
			start: schema.gscQueryPageObservations.periodStart,
			end: schema.gscQueryPageObservations.periodEnd
		})
		.from(schema.gscQueryPageObservations)
		.where(eq(schema.gscQueryPageObservations.projectId, projectId));
	return rows.sort((a, b) => (a.start < b.start ? 1 : -1)).slice(0, n);
}

/** Injecte (ou remplace) un couple sur une semaine donnée. */
async function put(
	projectId: string,
	week: { start: string; end: string },
	query: string,
	page: string,
	clicks: number,
	impressions: number,
	position = 8
): Promise<void> {
	await db
		.insert(schema.gscQueryPageObservations)
		.values({
			id: createId(),
			projectId,
			provider: 'gsc',
			periodStart: week.start,
			periodEnd: week.end,
			query,
			page,
			device: '',
			clicks,
			impressions,
			ctr: impressions > 0 ? clicks / impressions : 0,
			position
		})
		.onConflictDoUpdate({
			target: [
				schema.gscQueryPageObservations.projectId,
				schema.gscQueryPageObservations.periodStart,
				schema.gscQueryPageObservations.query,
				schema.gscQueryPageObservations.page,
				schema.gscQueryPageObservations.device
			],
			set: { clicks, impressions, position, ctr: impressions > 0 ? clicks / impressions : 0 }
		});
}

async function countMarkedObservations(projectId: string): Promise<number> {
	const rows = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(schema.gscQueryPageObservations)
		.where(
			and(
				eq(schema.gscQueryPageObservations.projectId, projectId),
				like(schema.gscQueryPageObservations.query, `${MARK}%`)
			)
		);
	return rows[0].n;
}

async function declineFindings(projectId: string) {
	return db
		.select({
			id: schema.findings.id,
			fingerprint: schema.findings.fingerprint,
			entityType: schema.findings.entityType,
			entityKey: schema.findings.entityKey,
			status: schema.findings.status,
			severity: schema.findings.severity,
			occurrenceCount: schema.findings.occurrenceCount,
			consecutiveMisses: schema.findings.consecutiveMisses,
			title: schema.findings.title
		})
		.from(schema.findings)
		.where(
			and(eq(schema.findings.projectId, projectId), eq(schema.findings.type, 'keyword_decline'))
		);
}

async function countAllFindings(projectId: string): Promise<number> {
	const rows = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(schema.findings)
		.where(eq(schema.findings.projectId, projectId));
	return rows[0].n;
}

function run(projectId: string, over?: { dryRun?: boolean }) {
	return runKeywordDeclineDetector({
		db,
		projectId,
		thresholds: THRESHOLDS,
		dryRun: over?.dryRun,
		now: new Date()
	});
}

// ── Protocole ───────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log(`FIND-005 — preuve détecteur de baisses (run ${RUN_KEY})`);

	const target = await projectBySlug('lecureux');
	const short = await projectBySlug('spinlink');

	const baselineFindings = await countAllFindings(target.id);
	const baselineMarked = await countMarkedObservations(target.id);
	console.log(
		`  cible: ${target.slug} · findings projet: ${baselineFindings} · observations marquées: ${baselineMarked}`
	);
	if (baselineMarked !== 0) {
		console.error('Des observations marquées traînent déjà : run précédent mal nettoyé. Abandon.');
		process.exit(1);
	}

	// 8 semaines réelles : w[0] = la plus récente. current = w0..w3, prior = w4..w7.
	const weeks = await recentWeeks(target.id, 8);
	if (weeks.length < 8) throw new Error(`Historique trop court (${weeks.length} semaines).`);
	const cur = weeks.slice(0, 4);
	const pri = weeks.slice(4, 8);

	// ── Injection des cas ────────────────────────────────────────────
	section('Injection des couples de test');

	// 1. baisse CONFIRMÉE : la chute se creuse ENCORE d'une semaine sur l'autre.
	//    4 semaines : 1600 → 620 (−61 %) ✓ · 1 semaine : w1=100 → w0=20 (−80 %) ✓.
	//    ⚠️ La fenêtre récente compare w0 à w1 — PAS à la période d'avant. Un palier bas
	//    et stable ne la fait donc pas tomber : c'est `sustained` (cas 1 bis), pas
	//    `confirmed`. Confondre les deux, c'était la seule assertion en échec au premier
	//    passage — le code avait raison, la donnée de test était fausse.
	for (const w of pri) await put(target.id, w, q('confirmed'), pg('a'), 400, WEEK_IMPRESSIONS);
	const slope = [20, 100, 200, 300]; // cur[0] = la plus récente
	for (let i = 0; i < cur.length; i++) {
		await put(target.id, cur[i], q('confirmed'), pg('a'), slope[i], WEEK_IMPRESSIONS);
	}

	// 1 bis. baisse INSTALLÉE : effondrement ancien, palier bas et stable depuis.
	//    4 semaines : 1600 → 80 (−95 %) ✓ · 1 semaine : w1=20 → w0=20 (rien) ⇒ `sustained`.
	for (const w of pri) await put(target.id, w, q('sustained'), pg('a2'), 400, WEEK_IMPRESSIONS);
	for (const w of cur) await put(target.id, w, q('sustained'), pg('a2'), 20, WEEK_IMPRESSIONS);

	// 2. baisse ÉMERGENTE : seule la semaine la plus récente s'effondre.
	//    4 semaines : 400×4=1600 → 400×3+0=1200, soit −25 % (< 30 %, seuil non franchi).
	//    1 semaine  : 400 → 0, soit −100 % (franchi). ⇒ `emerging`, plafonné à `medium`.
	for (const w of pri) await put(target.id, w, q('emerging'), pg('b'), 400, WEEK_IMPRESSIONS);
	for (const w of cur.slice(1)) await put(target.id, w, q('emerging'), pg('b'), 400, WEEK_IMPRESSIONS);
	await put(target.id, cur[0], q('emerging'), pg('b'), 0, WEEK_IMPRESSIONS);

	// 3. STABLE : rien ne bouge (contre-épreuve).
	for (const w of [...pri, ...cur]) await put(target.id, w, q('stable'), pg('c'), 400, WEEK_IMPRESSIONS);

	// 4. DISPARU : présent avant, absent maintenant. Ne doit produire AUCUN finding.
	for (const w of pri) await put(target.id, w, q('vanished'), pg('d'), 900, WEEK_IMPRESSIONS);

	// 5. PAGE qui décroche : 3 requêtes en baisse sur la même page ⇒ 1 seul finding.
	for (const n of ['g1', 'g2', 'g3']) {
		for (const w of pri) await put(target.id, w, q(n), pg('group'), 400, WEEK_IMPRESSIONS);
		for (const w of cur) await put(target.id, w, q(n), pg('group'), 20, WEEK_IMPRESSIONS);
	}

	// 6. PAGE qui se RECOMPOSE : 3 requêtes en baisse + 1 qui explose ⇒ 3 findings, pas 1.
	for (const n of ['s1', 's2', 's3']) {
		for (const w of pri) await put(target.id, w, q(n), pg('mixed'), 400, WEEK_IMPRESSIONS);
		for (const w of cur) await put(target.id, w, q(n), pg('mixed'), 20, WEEK_IMPRESSIONS);
	}
	for (const w of pri) await put(target.id, w, q('boom'), pg('mixed'), 10, WEEK_IMPRESSIONS);
	for (const w of cur) await put(target.id, w, q('boom'), pg('mixed'), 4000, WEEK_IMPRESSIONS * 4);

	const injected = await countMarkedObservations(target.id);
	check('observations injectées', injected > 0, `${injected} lignes`);

	// ── §A — la détection ────────────────────────────────────────────
	section('§A — détection sur fenêtres réelles');
	const r1 = await run(target.id);

	check('les deux fenêtres sont comparables (68 semaines réelles)',
		r1.windows.primary !== null && r1.windows.recent !== null,
		`primary=${r1.windows.primary ? `${r1.windows.primary.weeks} sem.` : 'null'} · recent=${r1.windows.recent ? `${r1.windows.recent.weeks} sem.` : 'null'}`);
	check('aucune raison de saut : la fenêtre a pu juger', r1.skippedReason === null);

	const byKey = new Map(r1.declines.map((d) => [d.query ?? `page:${d.page}`, d]));
	check('la baisse confirmée est détectée', byKey.has(q('confirmed')));
	check("une chute qui se creuse encore est 'confirmed'",
		byKey.get(q('confirmed'))?.confirmation === 'confirmed',
		byKey.get(q('confirmed'))?.confirmation);
	check('⭐ … tandis qu’un palier bas et STABLE est `sustained`, pas `confirmed`',
		byKey.get(q('sustained'))?.confirmation === 'sustained',
		byKey.get(q('sustained'))?.confirmation);

	const emerging = byKey.get(q('emerging'));
	check('⭐ une chute d’une seule semaine est écrite, mais `emerging`',
		emerging?.confirmation === 'emerging', emerging?.confirmation);
	check('⭐ … et PLAFONNÉE à `medium` quelle que soit l’ampleur',
		emerging !== undefined && emerging.severity !== 'high' && emerging.severity !== 'critical',
		`severity=${emerging?.severity}`);

	check('⭐ un couple STABLE ne produit rien', !byKey.has(q('stable')));
	check('⭐ un couple DISPARU ne produit rien (ce n’est pas une baisse de −100 %)',
		!byKey.has(q('vanished')));
	check('… et il est COMPTÉ comme hors périmètre', r1.vanished >= 1, `vanished=${r1.vanished}`);

	// ── §B — regroupement de page ────────────────────────────────────
	section('§B — une page qui décroche est UN problème, pas N');
	const groupFinding = r1.declines.find((d) => d.granularity === 'page' && d.page === pg('group'));
	check('la page en décrochage rend UN finding de page', groupFinding !== undefined);
	check('… et aucun finding de requête pour cette page',
		r1.declines.filter((d) => d.granularity === 'query' && d.page === pg('group')).length === 0);
	check('groupsFormed le dit', r1.groupsFormed >= 1, `groupsFormed=${r1.groupsFormed}`);

	const mixedQueries = r1.declines.filter((d) => d.granularity === 'query' && d.page === pg('mixed'));
	check('⭐ une page qui se RECOMPOSE reste N findings de requête',
		mixedQueries.length === 3, `${mixedQueries.length} findings`);
	check('… et aucun finding de page pour elle',
		!r1.declines.some((d) => d.granularity === 'page' && d.page === pg('mixed')));
	check('pagesStable le dit', r1.pagesStable >= 1, `pagesStable=${r1.pagesStable}`);

	// ── §C — écriture, idempotence ───────────────────────────────────
	section('§C — persistance et idempotence');
	const written1 = await declineFindings(target.id);
	check('les findings sont en base', written1.length === r1.declines.length,
		`${written1.length} lignes / ${r1.declines.length} détectés`);
	check('toutes les occurrences sont à 1 au premier run',
		written1.every((f) => f.occurrenceCount === 1));

	const r2 = await run(target.id);
	const written2 = await declineFindings(target.id);
	check('⭐ un second run n’ajoute AUCUNE ligne',
		written2.length === written1.length, `${written1.length} → ${written2.length}`);
	check('… et incrémente occurrence_count',
		written2.every((f) => f.occurrenceCount === 2));
	check('… sans rien recréer', r2.counts.created === 0, `created=${r2.counts.created}`);

	// ── §D — une récupération résout le finding ──────────────────────
	section('§D — une récupération résout (jamais à la première absence)');
	// La baisse confirmée se répare : la fenêtre courante retrouve son niveau.
	for (const w of cur) await put(target.id, w, q('confirmed'), pg('a'), 400, WEEK_IMPRESSIONS);

	const r3 = await run(target.id);
	const afterFirstMiss = (await declineFindings(target.id)).find(
		(f) => f.entityKey === q('confirmed')
	);
	check('⭐ une seule absence ne résout RIEN',
		afterFirstMiss?.status !== 'resolved', `status=${afterFirstMiss?.status}`);
	check('… mais elle est comptée',
		(afterFirstMiss?.consecutiveMisses ?? 0) === 1, `misses=${afterFirstMiss?.consecutiveMisses}`);
	check('la réconciliation a bien tourné', r3.lifecycle.reconciled === true);

	await run(target.id);
	const afterSecondMiss = (await declineFindings(target.id)).find(
		(f) => f.entityKey === q('confirmed')
	);
	check('⭐ à la 2ᵉ absence consécutive, le finding est auto-résolu',
		afterSecondMiss?.status === 'resolved', `status=${afterSecondMiss?.status}`);
	check('… et les autres findings ne bougent pas',
		(await declineFindings(target.id)).filter((f) => f.status === 'resolved').length === 1);

	// ── §E — dry-run n'écrit rien ────────────────────────────────────
	section('§E — le dry-run n’écrit rien');
	const beforeDry = (await declineFindings(target.id)).map((f) => `${f.id}:${f.occurrenceCount}`).sort();
	const rDry = await run(target.id, { dryRun: true });
	const afterDry = (await declineFindings(target.id)).map((f) => `${f.id}:${f.occurrenceCount}`).sort();
	check('le dry-run annonce ce qu’il aurait écrit', rDry.declines.length > 0,
		`${rDry.declines.length} unités`);
	check('… sans aucun findingId', rDry.declines.every((d) => d.findingId === null));
	check('⭐ … et la base est strictement inchangée',
		JSON.stringify(beforeDry) === JSON.stringify(afterDry));
	check('… la réconciliation ne tourne pas non plus', rDry.lifecycle.reconciled === false);

	// ── §F — contre-épreuve sur données réelles ──────────────────────
	section('§F — 6 semaines réelles : le 4 semaines n’est PAS comparable');
	const rShort = await run(short.id);
	check('⭐ spinlink (6 semaines) : aucune fenêtre 4 semaines',
		rShort.windows.primary === null, `primary=${rShort.windows.primary ? 'présent' : 'null'}`);
	check('… mais la fenêtre 1 semaine, elle, existe',
		rShort.windows.recent !== null);
	check('… et rien n’a été écrit pour ce projet (seuil d’isolation)',
		rShort.declines.length === 0, `${rShort.declines.length} findings`);

	section('§F bis — un projet sans aucune observation');
	const rGhost = await run('projet-inexistant-find005');
	check('un projet sans observation le DIT au lieu de rendre un vide muet',
		rGhost.skippedReason === 'aucune observation GSC pour ce projet', rGhost.skippedReason ?? '');
	check('… et n’écrit rien', rGhost.declines.length === 0);

	// ── §G — garde d'isolation ───────────────────────────────────────
	section('§G — aucun finding RÉEL n’a été créé');
	const all = await declineFindings(target.id);
	const foreign = all.filter((f) => !f.entityKey.includes(MARK) && !f.fingerprint.includes(MARK));
	check('⭐ tout finding keyword_decline porte le marqueur de test',
		foreign.length === 0,
		foreign.length > 0 ? `FUITE : ${foreign.map((f) => f.entityKey).join(', ')}` : `${all.length} marqués`);

	// ── Nettoyage ────────────────────────────────────────────────────
	section('Nettoyage');
	const ids = all.map((f) => f.id);
	if (ids.length > 0) {
		await db.delete(schema.findingEvents).where(inArray(schema.findingEvents.findingId, ids));
		await db.delete(schema.findings).where(inArray(schema.findings.id, ids));
	}
	await db
		.delete(schema.gscQueryPageObservations)
		.where(
			and(
				eq(schema.gscQueryPageObservations.projectId, target.id),
				like(schema.gscQueryPageObservations.query, `${MARK}%`)
			)
		);

	const finalMarked = await countMarkedObservations(target.id);
	const finalFindings = await countAllFindings(target.id);
	check('observations marquées supprimées', finalMarked === 0, `${finalMarked}`);
	check('findings du projet rendus à l’identique',
		finalFindings === baselineFindings, `${baselineFindings} → ${finalFindings}`);

	console.log(
		`\n${failures === 0 ? '✅' : '❌'} ${failures === 0 ? 'Toutes les assertions passent' : `${failures} assertion(s) en échec`}`
	);
}

main()
	.catch((err) => {
		console.error('\n❌ Erreur :', err);
		failures += 1;
	})
	.finally(async () => {
		await pool.end();
		process.exit(failures === 0 ? 0 : 1);
	});
