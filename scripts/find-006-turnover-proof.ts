/**
 * FIND-006 — Preuve du détecteur `new_query` / `lost_query` sur une VRAIE base.
 *
 * Ce que vitest ne peut PAS montrer, et qui est prouvé ici :
 *   - la durée de vie par requête calculée sur l'historique RÉEL (68 semaines et
 *     707 requêtes distinctes pour `lecureux`) : c'est elle qui distingue une
 *     découverte d'un RETOUR, ce qu'une comparaison de deux fenêtres ne sait pas faire ;
 *   - les deux faux signaux SYMÉTRIQUES que le regroupement de variantes empêche,
 *     joués sur les mêmes semaines réelles ;
 *   - la portée (`scope`) des pertes : un finding que le run ne peut plus MESURER
 *     reste strictement intact, alors qu'un retour effectif le fait résoudre ;
 *   - deux closures distinctes sur un seul job.
 *
 * ── ISOLATION (lire avant de modifier ce script) ────────────────────────────────
 *
 * Le détecteur travaille sur TOUT le projet : lancé tel quel sur un projet réel, il
 * écrirait de VRAIS findings (44 apparues et 87 disparues par fenêtre sur `lecureux`).
 * L'isolation repose sur les TROIS gates de volume poussés à 500 000 alors que
 * l'observation la plus grosse du parc pèse 7 904 impressions. Les trois, parce que
 * `minGrowthImpressions` est une SECONDE porte d'entrée : la laisser à son défaut
 * ferait entrer de vraies requêtes en croissance. §K le VÉRIFIE : tout finding
 * `new_query`/`lost_query` créé pendant le run doit porter le marqueur, sinon la
 * preuve échoue et nettoie quand même.
 *
 * ⚠️ La PROD écrit dans la même base (snapshot GSC legacy de `main`). Ce script
 * n'assert donc JAMAIS un total d'observations projet « rendu à l'identique » : il
 * compte ses PROPRES lignes (marqueur) et les ramène à zéro. Les findings, eux, ne
 * sont écrits par personne en prod (`main` n'a aucun détecteur) : leur total est,
 * lui, assertable.
 *
 * Lancer : npx tsx scripts/find-006-turnover-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { createId } from '../src/lib/server/utils.js';
import { runQueryTurnoverDetector } from '../src/lib/server/detectors/query-turnover.js';
import {
	TURNOVER_DEFAULTS,
	normalizeQueryKey
} from '../src/lib/server/detectors/query-turnover-state.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

/** Marqueur exclusif : aucune requête réelle ne commence par cette chaîne. */
const MARK = '__test_find006';
/** Alphanumérique : il doit SURVIVRE à `normalizeQueryKey` pour servir de garde §K. */
const RUN_KEY = createId().replace(/[^a-z0-9]/gi, '').slice(0, 8);
const q = (name: string) => `${MARK} ${RUN_KEY} ${name}`;
const pg = (name: string) => `https://${MARK}.test/${RUN_KEY}/${name}`;

/** Seuil d'isolation : 63× la plus grosse observation du parc. */
const ISOLATION = 500_000;
/**
 * Les gates portent sur le TOTAL de la fenêtre (4 semaines), jamais sur une semaine :
 * `BIG` × 4 le franchit largement, `SMALL` × 4 reste dessous. Confondre les deux,
 * c'était la première assertion en échec — le code avait raison, la donnée de test
 * comptait par semaine ce que le détecteur compte par fenêtre.
 */
const BIG = 600_000;
/** Moitié de `BIG` : assez pour peser dans un groupe, jamais pour le dominer. */
const MEDIUM = 300_000;
/** Sous le seuil même sommé sur 4 semaines : présent en base, jamais un finding. */
const SMALL = 100_000;

const THRESHOLDS = {
	...TURNOVER_DEFAULTS,
	minNewImpressions: ISOLATION,
	minGrowthImpressions: ISOLATION,
	minLostImpressions: ISOLATION
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

async function dropQuery(projectId: string, query: string): Promise<void> {
	await db
		.delete(schema.gscQueryPageObservations)
		.where(
			and(
				eq(schema.gscQueryPageObservations.projectId, projectId),
				eq(schema.gscQueryPageObservations.query, query)
			)
		);
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

async function turnoverFindings(projectId: string) {
	return db
		.select({
			id: schema.findings.id,
			type: schema.findings.type,
			fingerprint: schema.findings.fingerprint,
			entityType: schema.findings.entityType,
			entityKey: schema.findings.entityKey,
			status: schema.findings.status,
			severity: schema.findings.severity,
			occurrenceCount: schema.findings.occurrenceCount,
			consecutiveMisses: schema.findings.consecutiveMisses,
			recommendedSkill: schema.findings.recommendedSkill,
			evidenceJson: schema.findings.evidenceJson,
			title: schema.findings.title
		})
		.from(schema.findings)
		.where(
			and(
				eq(schema.findings.projectId, projectId),
				inArray(schema.findings.type, ['new_query', 'lost_query'])
			)
		);
}

async function countAllFindings(projectId: string): Promise<number> {
	const rows = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(schema.findings)
		.where(eq(schema.findings.projectId, projectId));
	return rows[0].n;
}

async function countIndexObservations(projectId: string): Promise<number> {
	const rows = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(schema.indexObservations)
		.where(eq(schema.indexObservations.projectId, projectId));
	return rows[0].n;
}

function run(projectId: string, over?: { dryRun?: boolean }) {
	return runQueryTurnoverDetector({
		db,
		projectId,
		thresholds: THRESHOLDS,
		dryRun: over?.dryRun,
		now: new Date()
	});
}

const byKey = (rows: Awaited<ReturnType<typeof turnoverFindings>>, type: string, key: string) =>
	rows.find((f) => f.type === type && f.entityKey === key);

// ── Protocole ───────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log(`FIND-006 — preuve détecteur nouvelles/perdues (run ${RUN_KEY})`);

	const target = await projectBySlug('lecureux');
	const short = await projectBySlug('spinlink');

	const baselineFindings = await countAllFindings(target.id);
	const baselineMarked = await countMarkedObservations(target.id);
	const baselineIndexObs = await countIndexObservations(target.id);
	console.log(
		`  cible: ${target.slug} · findings projet: ${baselineFindings} · observations marquées: ${baselineMarked} · index_observations: ${baselineIndexObs}`
	);
	if (baselineMarked !== 0) {
		console.error('Des observations marquées traînent déjà : run précédent mal nettoyé. Abandon.');
		process.exit(1);
	}

	// 8 semaines réelles : w[0] = la plus récente. current = w0..w3, prior = w4..w7.
	const weeks = await recentWeeks(target.id, 40);
	if (weeks.length < 8) throw new Error(`Historique trop court (${weeks.length} semaines).`);
	const cur = weeks.slice(0, 4);
	const pri = weeks.slice(4, 8);
	/** Une semaine BIEN antérieure aux deux fenêtres : le passé que seul l'agrégat voit. */
	const ancient = weeks[30];

	// ── Injection des cas ────────────────────────────────────────────
	section('Injection des cas de test');

	// 1. DÉCOUVERTE franche : absente de tout l'historique, au-dessus du gate.
	for (const w of cur) await put(target.id, w, q('decouverte'), pg('a'), 100, BIG);

	// 2. Découverte SOUS le gate : présente, mais jamais écrite.
	for (const w of cur) await put(target.id, w, q('petite'), pg('a'), 0, SMALL);

	// 3. ⭐ RETOUR : vue il y a 30 semaines, absente des deux fenêtres, de retour
	//    maintenant. Une comparaison de deux fenêtres la déclarerait NEUVE.
	await put(target.id, ancient, q('retour'), pg('b'), 50, BIG);
	for (const w of cur) await put(target.id, w, q('retour'), pg('b'), 50, BIG);

	// 4. ⭐ VARIANTE SYMÉTRIQUE : « alpha beta » avant, « beta alpha » maintenant.
	//    Ni une découverte, ni une perte : Google a réécrit la requête.
	for (const w of pri) await put(target.id, w, q('alpha beta'), pg('c'), 80, BIG);
	for (const w of cur) await put(target.id, w, q('beta alpha'), pg('c'), 80, BIG);

	// 5. ⭐ DEUX VARIANTES NEUVES ensemble : un seul finding, deux termes bruts.
	// Le dominant est celui qui PÈSE le plus, pas le premier alphabétiquement.
	for (const w of cur) {
		await put(target.id, w, q('gamma delta'), pg('d'), 30, BIG);
		await put(target.id, w, q('delta gamma'), pg('d'), 10, MEDIUM);
	}

	// 6. PERTE : présente sur les 4 semaines précédentes, absente maintenant.
	for (const w of pri) await put(target.id, w, q('perdue'), pg('e'), 120, BIG);

	// 7. PERTE dont la page n'est plus indexable : appartient à IDX-005, pas ici.
	for (const w of pri) await put(target.id, w, q('perdue desindexee'), pg('f'), 90, BIG);
	const indexObsId = createId();
	await db.insert(schema.indexObservations).values({
		id: indexObsId,
		projectId: target.id,
		provider: 'indexing',
		observedDate: new Date().toISOString().slice(0, 10),
		url: pg('f'),
		coverageState: 'Crawled - currently not indexed',
		verdict: 'NEUTRAL'
	});

	console.log('  7 cas injectés sur les 8 semaines réelles les plus récentes + 1 semaine ancienne.');

	// ── §A — découvertes ─────────────────────────────────────────────
	section('§A — découvertes : le gate de volume, et rien d’autre');
	const r1 = await run(target.id);
	check('la fenêtre 4 semaines est comparable sur 68 semaines réelles',
		r1.windows.current !== null && r1.windows.prior !== null && r1.skippedReason === null,
		`${r1.weeksAvailable} semaines · ${r1.queriesKnown} requêtes connues`);
	check('la découverte franche est écrite',
		r1.newQueries.some((n) => n.label === q('decouverte')));
	check('⭐ la découverte sous le gate ne l’est PAS',
		!r1.newQueries.some((n) => n.label === q('petite')) && r1.newBelowThreshold > 0,
		`newBelowThreshold=${r1.newBelowThreshold}`);

	// ── §B — le retour n'est pas une découverte ──────────────────────
	section('§B — ⭐ un RETOUR n’est pas une découverte (la durée de vie tranche)');
	check('la requête revenue après 30 semaines n’est pas écrite',
		!r1.newQueries.some((n) => n.label === q('retour')));
	check('… et elle est COMPTÉE comme retour, pas tue',
		r1.returning >= 1, `returning=${r1.returning}`);

	// ── §C — les deux faux signaux symétriques ───────────────────────
	section('§C — ⭐ la variante réécrite n’est NI une découverte NI une perte');
	const keyAlpha = normalizeQueryKey(q('alpha beta'));
	check('« beta alpha » n’est pas une découverte',
		!r1.newQueries.some((n) => n.variantKey === keyAlpha));
	check('« alpha beta » n’est pas une perte',
		!r1.lostQueries.some((l) => l.variantKey === keyAlpha));
	check('… et les deux écarts sont comptés',
		r1.variantOfKnown >= 1 && r1.variantSurvived >= 1,
		`variantOfKnown=${r1.variantOfKnown} · variantSurvived=${r1.variantSurvived}`);
	check('les deux orthographes portent bien la MÊME clé de variante',
		normalizeQueryKey(q('beta alpha')) === keyAlpha);

	// ── §D — regroupement réversible et inspectable ──────────────────
	section('§D — le regroupement est réversible et inspectable');
	const grouped = r1.newQueries.find((n) => n.variantKey === normalizeQueryKey(q('gamma delta')));
	check('deux variantes neuves font UN seul finding',
		grouped !== undefined && grouped.variantCount === 2,
		`variantCount=${grouped?.variantCount}`);
	check('… nommé par le terme BRUT dominant, jamais par la clé normalisée',
		grouped?.label === q('gamma delta') && !grouped.title.includes(grouped.variantKey),
		grouped?.title ?? '');
	const groupedRow = byKey(await turnoverFindings(target.id), 'new_query', grouped?.variantKey ?? '');
	const groupedEvidence = JSON.parse(groupedRow?.evidenceJson ?? '{}');
	check('… et les preuves portent les DEUX termes bruts',
		(groupedEvidence.variants ?? []).map((v: { query: string }) => v.query).sort().join('|') ===
			[q('gamma delta'), q('delta gamma')].sort().join('|'));
	check('⭐ les preuves portent la première ET la dernière apparition',
		typeof groupedEvidence.firstSeen === 'string' &&
			groupedEvidence.firstSeen === cur[3].start &&
			groupedEvidence.lastSeen === cur[0].start,
		`${groupedEvidence.firstSeen} → ${groupedEvidence.lastSeen}`);
	check('… et la clé de variante, rejouable par `normalizeQueryKey`',
		groupedEvidence.variantKey === normalizeQueryKey(q('delta gamma')));

	// ── §E — pertes et confirmation §10.4 ────────────────────────────
	section('§E — pertes : la page indexable est une CONDITION, pas un commentaire');
	check('la perte est écrite', r1.lostQueries.some((l) => l.label === q('perdue')));
	check('⭐ la perte dont la page n’est plus indexée ne l’est PAS',
		!r1.lostQueries.some((l) => l.label === q('perdue desindexee')) &&
			r1.attributedToIndexing >= 1,
		`attributedToIndexing=${r1.attributedToIndexing}`);
	check('… et l’état d’indexation a bien été lu depuis la base',
		r1.indexationKnown >= 1, `${r1.indexationKnown} URL(s) connue(s)`);
	const lostRow = byKey(
		await turnoverFindings(target.id),
		'lost_query',
		normalizeQueryKey(q('perdue'))
	);
	check('une perte à l’indexation INCONNUE route vers le diagnostic d’indexation',
		lostRow?.recommendedSkill === 'seo-index-diagnose', lostRow?.recommendedSkill ?? '');

	// ── §F — deux closures sur un seul job ───────────────────────────
	section('§F — un seul job, DEUX closures');
	check('la closure des découvertes ne contient que des découvertes',
		r1.lifecycle.closureNew === r1.totalMatchedNew,
		`${r1.lifecycle.closureNew} = ${r1.totalMatchedNew}`);
	check('la closure des pertes ne contient que des pertes',
		r1.lifecycle.closureLost === r1.totalMatchedLost,
		`${r1.lifecycle.closureLost} = ${r1.totalMatchedLost}`);
	check('⭐ la PORTÉE des pertes est plus large que leur closure',
		r1.lifecycle.scopeLost > r1.lifecycle.closureLost,
		`scope=${r1.lifecycle.scopeLost} > closure=${r1.lifecycle.closureLost}`);

	// ── §G — idempotence ─────────────────────────────────────────────
	section('§G — rejouer le même run ne crée rien');
	const beforeReplay = (await turnoverFindings(target.id)).length;
	const r2 = await run(target.id);
	const afterReplay = await turnoverFindings(target.id);
	check('aucun finding supplémentaire',
		afterReplay.length === beforeReplay, `${beforeReplay} → ${afterReplay.length}`);
	check('… tous rafraîchis, aucun créé',
		r2.counts.created === 0 && r2.counts.refreshed > 0,
		`created=${r2.counts.created} refreshed=${r2.counts.refreshed}`);

	// ── §H — la portée protège une perte devenue immesurable ─────────
	section('§H — ⭐ une perte que le run ne peut plus MESURER reste intacte');
	// La fenêtre de référence d'une perte glisse d'une semaine à chaque run. On simule
	// ce glissement en retirant ses observations : le groupe n'est plus ni dans la
	// closure (plus rien à mesurer) ni parmi les présents (toujours absent).
	await dropQuery(target.id, q('perdue'));
	const r3 = await run(target.id);
	const stillLost = byKey(
		await turnoverFindings(target.id),
		'lost_query',
		normalizeQueryKey(q('perdue'))
	);
	check('le finding n’est PAS auto-résolu',
		stillLost?.status !== 'resolved', `status=${stillLost?.status}`);
	check('⭐ … et son compteur d’absences n’a même pas bougé',
		(stillLost?.consecutiveMisses ?? -1) === 0, `misses=${stillLost?.consecutiveMisses}`);
	check('… le run le DIT (hors portée, pas guéri)',
		r3.lifecycle.outOfScope >= 1, `outOfScope=${r3.lifecycle.outOfScope}`);

	// ── §I — le retour effectif, lui, résout ─────────────────────────
	section('§I — un RETOUR effectif fait résoudre la perte');
	// Réinjectée dans la fenêtre COURANTE, sous le gate : présente (donc dans la
	// portée), sans pour autant devenir une découverte.
	for (const w of cur) await put(target.id, w, q('perdue'), pg('e'), 10, SMALL);
	const r4 = await run(target.id);
	const returned1 = byKey(
		await turnoverFindings(target.id),
		'lost_query',
		normalizeQueryKey(q('perdue'))
	);
	check('la 1ʳᵉ absence de la closure ne résout RIEN',
		returned1?.status !== 'resolved', `status=${returned1?.status}`);
	check('… mais elle est comptée',
		(returned1?.consecutiveMisses ?? 0) === 1, `misses=${returned1?.consecutiveMisses}`);
	check('la réconciliation a bien tourné', r4.lifecycle.reconciled === true);

	await run(target.id);
	const returned2 = byKey(
		await turnoverFindings(target.id),
		'lost_query',
		normalizeQueryKey(q('perdue'))
	);
	check('⭐ à la 2ᵉ absence consécutive, la perte est auto-résolue',
		returned2?.status === 'resolved', `status=${returned2?.status}`);

	// ── §J — dry-run, historique court, projet fantôme ───────────────
	section('§J — dry-run, historique court, projet fantôme');
	const before = (await turnoverFindings(target.id))
		.map((f) => `${f.id}:${f.occurrenceCount}:${f.status}`)
		.sort();
	const rDry = await run(target.id, { dryRun: true });
	const after = (await turnoverFindings(target.id))
		.map((f) => `${f.id}:${f.occurrenceCount}:${f.status}`)
		.sort();
	check('le dry-run annonce ce qu’il aurait écrit',
		rDry.newQueries.length + rDry.lostQueries.length > 0,
		`${rDry.newQueries.length} nouvelles · ${rDry.lostQueries.length} perdues`);
	check('… sans aucun findingId',
		[...rDry.newQueries, ...rDry.lostQueries].every((d) => d.findingId === null));
	check('⭐ … et la base est strictement inchangée',
		JSON.stringify(before) === JSON.stringify(after));
	check('… la réconciliation ne tourne pas non plus', rDry.lifecycle.reconciled === false);

	const rShort = await run(short.id);
	check('⭐ spinlink (6 semaines) : aucune fenêtre comparable, donc RIEN',
		rShort.skippedReason !== null && rShort.newQueries.length === 0 && rShort.lostQueries.length === 0,
		rShort.skippedReason ?? '');

	const rGhost = await run('projet-inexistant-find006');
	check('un projet sans observation le DIT au lieu de rendre un vide muet',
		rGhost.skippedReason === 'aucune observation GSC pour ce projet', rGhost.skippedReason ?? '');

	// ── §K — garde d'isolation ───────────────────────────────────────
	section('§K — aucun finding RÉEL n’a été créé');
	const all = await turnoverFindings(target.id);
	// ⚠️ L'`entity_key` d'un finding de turnover est la clé NORMALISÉE : le marqueur y
	// est déplié et ses mots triés (`__test_find006` devient `find006 test`). C'est la
	// clé de run — alphanumérique, donc intacte à la normalisation — qui sert de garde.
	const foreign = all.filter((f) => !f.entityKey.includes(RUN_KEY));
	check('⭐ tout finding new_query/lost_query porte le marqueur de test',
		foreign.length === 0,
		foreign.length > 0
			? `FUITE : ${foreign.map((f) => f.entityKey).join(', ')}`
			: `${all.length} marqués`);

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
	await db.delete(schema.indexObservations).where(eq(schema.indexObservations.id, indexObsId));

	const finalMarked = await countMarkedObservations(target.id);
	const finalFindings = await countAllFindings(target.id);
	const finalIndexObs = await countIndexObservations(target.id);
	check('observations marquées supprimées', finalMarked === 0, `${finalMarked}`);
	check('index_observations rendues à l’identique',
		finalIndexObs === baselineIndexObs, `${baselineIndexObs} → ${finalIndexObs}`);
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
