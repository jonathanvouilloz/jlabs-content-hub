/**
 * FIND-008 — Preuve du détecteur `cannibalization` sur une VRAIE base.
 *
 * Ce que vitest ne peut PAS montrer, et qui est prouvé ici :
 *   - le repli d'URL joué sur de vraies lignes GSC : la même page sous quatre formes
 *     (`#ancre`, `http://`, `www.`, slash final) ne fabrique AUCUN conflit, et la clé
 *     publiée dans les preuves se rejoue avec `normalizePageUrl` ;
 *   - le gate dur de persistance et son cas le plus trompeur (le REMPLACEMENT) ;
 *   - la portée : un conflit devenu immesurable reste strictement intact, alors qu'une
 *     guérison effective compte ses absences puis résout ;
 *   - « merge, redirect et canonical restent L4 » : zéro ligne dans `action_proposals`
 *     après un run, et `mapFindingToActions` qui rend `[]` sur un finding réel ;
 *   - la fenêtre unique : `spinlink` (6 semaines) PRODUIT, là où FIND-005/006
 *     s'arrêtent faute de fenêtre comparable.
 *
 * ── ISOLATION (lire avant de modifier ce script) ────────────────────────────────
 *
 * Le détecteur travaille sur TOUT le projet : lancé tel quel sur un projet réel, il
 * écrirait de VRAIS findings. L'isolation repose sur DEUX gates poussés à l'absurde —
 * `minUrlImpressions = 500 000` et `minQueryImpressions = 2 000 000` — alors que
 * l'observation la plus grosse du parc pèse 7 904 impressions.
 *
 * Les deux, parce que `relativeShare` ne borne RIEN : c'est une PART, pas un plancher.
 * Une requête réelle à 40 impressions partagée 50/50 franchirait allègrement un seuil
 * relatif ; seul un plancher absolu la tient. Et `minQueryImpressions` seul ne
 * suffirait pas non plus : il écarte le candidat mais après le comptage. §L le
 * VÉRIFIE : tout finding `cannibalization` du projet doit porter le marqueur, sinon la
 * preuve échoue et nettoie quand même.
 *
 * ⚠️ La PROD écrit dans la même base. Ce script n'assert donc JAMAIS un total
 * d'observations projet « rendu à l'identique » : il compte ses PROPRES lignes
 * (marqueur) et les ramène à zéro. Les findings, eux, ne sont écrits par personne en
 * prod (`main` n'a aucun détecteur) : leur total est, lui, assertable.
 *
 * Lancer : npx tsx scripts/find-008-cannibalization-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { createId } from '../src/lib/server/utils.js';
import {
	runCannibalizationDetector,
	normalizePageUrl
} from '../src/lib/server/detectors/cannibalization.js';
import {
	CANNIBALIZATION_DEFAULTS,
	URL_NORMALIZATION_RULE,
	type CannibalizationEvidence
} from '../src/lib/server/detectors/cannibalization-state.js';
import {
	mapFindingToActions,
	readFindingSignals,
	resolveProposerConfig,
	type ProposableFinding
} from '../src/lib/server/proposer-state.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

/** Marqueur exclusif : aucune requête réelle ne commence par cette chaîne. */
const MARK = '__test_find008';
const RUN_KEY = createId().replace(/[^a-z0-9]/gi, '').slice(0, 8);
/** L'entité d'un finding est la requête BRUTE : le marqueur y survit tel quel (§L). */
const q = (name: string) => `${MARK} ${RUN_KEY} ${name}`;

const HOST = `${MARK}-${RUN_KEY}.test`;
const pg = (name: string) => `https://${HOST}/${name}`;

/** Seuils d'isolation : 63× et 253× la plus grosse observation du parc. */
const ISOLATION_URL = 500_000;
const ISOLATION_QUERY = 2_000_000;

/**
 * Les gates portent sur le TOTAL de la fenêtre (4 semaines), jamais sur une semaine.
 * `BIG` × 4 = 2,4 M franchit tout ; `SMALL` × 4 = 400 k reste sous le plancher d'URL
 * même quand la requête, elle, est bien au-dessus.
 */
const BIG = 600_000;
const MEDIUM = 300_000;
const SMALL = 100_000;
/** Deux URLs à ce niveau : significatives chacune, mais la REQUÊTE reste sous 2 M. */
const THIN = 200_000;

const THRESHOLDS = {
	...CANNIBALIZATION_DEFAULTS,
	minUrlImpressions: ISOLATION_URL,
	minQueryImpressions: ISOLATION_QUERY
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

/** Les N semaines les plus récentes réellement présentes pour le projet, triées. */
async function recentWeeks(projectId: string, n: number): Promise<{ start: string; end: string }[]> {
	const rows = await db
		.selectDistinct({
			start: schema.gscQueryPageObservations.periodStart,
			end: schema.gscQueryPageObservations.periodEnd
		})
		.from(schema.gscQueryPageObservations)
		.where(eq(schema.gscQueryPageObservations.projectId, projectId));
	return rows
		.sort((a, b) => (a.start < b.start ? 1 : -1))
		.slice(0, n)
		.sort((a, b) => (a.start < b.start ? -1 : 1));
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

/** Étale un couple query×page sur les semaines données (0 ⇒ aucune ligne, comme GSC). */
async function spread(
	projectId: string,
	weeks: { start: string; end: string }[],
	query: string,
	page: string,
	perWeek: number[],
	over: { clicks?: number; position?: number } = {}
): Promise<void> {
	for (let i = 0; i < weeks.length; i += 1) {
		const impressions = perWeek[i] ?? 0;
		if (impressions <= 0) continue;
		await put(
			projectId,
			weeks[i],
			query,
			page,
			i === 0 ? (over.clicks ?? 0) : 0,
			impressions,
			over.position ?? 8
		);
	}
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

async function dropPage(projectId: string, query: string, page: string): Promise<void> {
	await db
		.delete(schema.gscQueryPageObservations)
		.where(
			and(
				eq(schema.gscQueryPageObservations.projectId, projectId),
				eq(schema.gscQueryPageObservations.query, query),
				eq(schema.gscQueryPageObservations.page, page)
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

async function cannibalFindings(projectId: string) {
	return db
		.select({
			id: schema.findings.id,
			type: schema.findings.type,
			fingerprint: schema.findings.fingerprint,
			entityType: schema.findings.entityType,
			entityKey: schema.findings.entityKey,
			status: schema.findings.status,
			severity: schema.findings.severity,
			priorityScore: schema.findings.priorityScore,
			confidenceScore: schema.findings.confidenceScore,
			occurrenceCount: schema.findings.occurrenceCount,
			consecutiveMisses: schema.findings.consecutiveMisses,
			recommendedSkill: schema.findings.recommendedSkill,
			impactEstimateJson: schema.findings.impactEstimateJson,
			evidenceJson: schema.findings.evidenceJson,
			title: schema.findings.title
		})
		.from(schema.findings)
		.where(
			and(eq(schema.findings.projectId, projectId), eq(schema.findings.type, 'cannibalization'))
		);
}

async function countAllFindings(projectId: string): Promise<number> {
	const rows = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(schema.findings)
		.where(eq(schema.findings.projectId, projectId));
	return rows[0].n;
}

async function countProposalsFor(findingIds: string[]): Promise<number> {
	if (findingIds.length === 0) return 0;
	const rows = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(schema.actionProposals)
		.where(inArray(schema.actionProposals.findingId, findingIds));
	return rows[0].n;
}

function run(projectId: string, over?: { dryRun?: boolean }) {
	return runCannibalizationDetector({
		db,
		projectId,
		thresholds: THRESHOLDS,
		dryRun: over?.dryRun,
		now: new Date()
	});
}

const byKey = (rows: Awaited<ReturnType<typeof cannibalFindings>>, key: string) =>
	rows.find((f) => f.entityKey === key);

const evidenceOf = (row: { evidenceJson: string | null }): CannibalizationEvidence =>
	JSON.parse(row.evidenceJson ?? '{}') as CannibalizationEvidence;

// ── Protocole ───────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log(`FIND-008 — preuve détecteur cannibalisation (run ${RUN_KEY})`);

	const target = await projectBySlug('lecureux');
	const short = await projectBySlug('spinlink');

	const baselineFindings = await countAllFindings(target.id);
	const baselineShortFindings = await countAllFindings(short.id);
	const leftovers = (await countMarkedObservations(target.id)) + (await countMarkedObservations(short.id));
	if (leftovers > 0) {
		console.error(`\n❌ ${leftovers} observation(s) marquée(s) déjà en base : run précédent mal nettoyé. Abandon.`);
		failures += 1;
		return;
	}

	const weeks = await recentWeeks(target.id, 4);
	if (weeks.length < 4) throw new Error(`lecureux n'a que ${weeks.length} semaines.`);
	console.log(`  fenêtre réelle : ${weeks[0].start} → ${weeks[3].end}`);

	// ── §A — le conflit franc est écrit, le sous-volume ne l'est pas ──
	section('§A — un conflit franc est écrit ; sous le volume de requête, rien');

	const FRANC = q('franc');
	await spread(target.id, weeks, FRANC, pg('a'), [BIG, BIG, BIG, BIG], { clicks: 400, position: 4 });
	await spread(target.id, weeks, FRANC, pg('b'), [MEDIUM, MEDIUM, MEDIUM, MEDIUM], {
		clicks: 90,
		position: 7
	});

	// Deux URLs significatives (200 k × 4 = 800 k ≥ plancher 500 k) mais une requête à
	// 1,6 M < 2 M : le candidat est vu, mesuré, et écarté par le VOLUME — pas confondu
	// avec une requête mono-URL.
	const MINCE = q('mince');
	await spread(target.id, weeks, MINCE, pg('c'), [THIN, THIN, THIN, THIN]);
	await spread(target.id, weeks, MINCE, pg('d'), [THIN, THIN, THIN, THIN]);

	// Une URL franche + une marginale : un seul concurrent significatif.
	const SOLO = q('solo');
	await spread(target.id, weeks, SOLO, pg('e'), [BIG, BIG, BIG, BIG]);
	await spread(target.id, weeks, SOLO, pg('f'), [SMALL, SMALL, SMALL, SMALL]);

	// Une troisième URL sous le seuil dans le conflit franc : vue, écartée, COMPTÉE.
	await spread(target.id, weeks, FRANC, pg('marginale'), [SMALL, SMALL, SMALL, SMALL]);

	const rA = await run(target.id);
	const fA = await cannibalFindings(target.id);
	check('le conflit franc produit un finding', byKey(fA, FRANC) !== undefined);
	check('… avec 2 URLs significatives', evidenceOf(byKey(fA, FRANC)!).urlCount === 2);
	check(
		'la requête sous le plancher de volume est ÉCARTÉE et COMPTÉE',
		byKey(fA, MINCE) === undefined && rA.belowVolume >= 1,
		`belowVolume=${rA.belowVolume}`
	);
	check(
		'une URL marginale ne fait pas un conflit — elle est comptée à part',
		byKey(fA, SOLO) === undefined && rA.singleUrl >= 1,
		`singleUrl=${rA.singleUrl}`
	);
	check(
		'une URL sous le seuil est vue, écartée du conflit, et COMPTÉE',
		evidenceOf(byKey(fA, FRANC)!).marginalUrlCount === 1,
		`marginalUrlCount=${evidenceOf(byKey(fA, FRANC)!).marginalUrlCount}`
	);

	// ── §B — ⭐ la normalisation EMPÊCHE un faux conflit ──────────────
	section('§B — ⭐ le repli d’URL empêche un faux conflit (le point du lot)');

	// La MÊME page sous quatre formes que GSC remonte séparément.
	const ANCRES = q('ancres');
	const FORMS = [
		`https://${HOST}/article`,
		`https://${HOST}/article#section-2`,
		`http://www.${HOST}/article`,
		`https://${HOST}/article/`
	];
	// ⚠️ MEDIUM et non BIG : la part de significativité est RELATIVE, donc une page
	// repliée trop lourde écraserait la seconde sous le seuil et le §B2 ne prouverait
	// plus rien. Les quatre formes pèsent 4,8 M, la vraie seconde page 2,4 M — soit
	// 33 % du total, très au-dessus des 15 % exigés.
	for (const form of FORMS) {
		await spread(target.id, weeks, ANCRES, form, [MEDIUM, MEDIUM, MEDIUM, MEDIUM]);
	}

	const rB1 = await run(target.id);
	const fB1 = await cannibalFindings(target.id);
	check(
		'⭐ quatre formes de la MÊME page ne produisent AUCUN conflit',
		byKey(fB1, ANCRES) === undefined,
		`4 formes × ${BIG} imp/sem, requête à ${4 * 4 * BIG} imp`
	);
	check(
		'… et le repli est compté, pas tu',
		rB1.urlVariantsCollapsed >= 3,
		`urlVariantsCollapsed=${rB1.urlVariantsCollapsed}`
	);

	// Les mêmes quatre formes + une vraie seconde page : un conflit, à DEUX URLs.
	await spread(target.id, weeks, ANCRES, pg('autre'), [BIG, BIG, BIG, BIG]);
	await run(target.id);
	const fB2 = await cannibalFindings(target.id);
	const evB = byKey(fB2, ANCRES) ? evidenceOf(byKey(fB2, ANCRES)!) : null;
	check('… ajouter une VRAIE seconde page produit bien un conflit', evB !== null);
	check(
		'⭐ … à DEUX URLs, pas cinq',
		evB?.urlCount === 2,
		`urlCount=${evB?.urlCount}`
	);
	const folded = evB?.urls.find((u) => u.url === `https://${HOST}/article`);
	check(
		'… la forme repliée annonce ses 4 formes brutes',
		folded?.rawUrlCount === 4,
		`rawUrlCount=${folded?.rawUrlCount}`
	);
	check(
		'⭐ … et la règle publiée se REJOUE : chaque forme brute rend la clé publiée',
		folded !== undefined && FORMS.every((f) => normalizePageUrl(f) === folded.url),
		`${evB?.urlNormalization}`
	);
	check(
		'… la règle est nommée dans les preuves',
		evB?.urlNormalization === URL_NORMALIZATION_RULE
	);

	await dropQuery(target.id, ANCRES);

	// ── §C — ⭐ une seule semaine de chevauchement ne crée RIEN ───────
	section('§C — ⭐ la persistance est un gate DUR (acceptation littérale)');

	const BREF = q('bref');
	await spread(target.id, weeks, BREF, pg('g'), [0, 0, 0, BIG * 4]);
	await spread(target.id, weeks, BREF, pg('h'), [0, 0, 0, BIG * 4]);

	const rC1 = await run(target.id);
	check(
		'⭐ une seule semaine de chevauchement n’écrit RIEN',
		byKey(await cannibalFindings(target.id), BREF) === undefined
	);
	check(
		'… et l’écart est COMPTÉ, pas silencieux',
		rC1.belowPersistence >= 1,
		`belowPersistence=${rC1.belowPersistence}`
	);

	// La même chose étendue à deux semaines : le finding apparaît.
	await spread(target.id, weeks, BREF, pg('g'), [0, 0, BIG * 2, BIG * 2]);
	await spread(target.id, weeks, BREF, pg('h'), [0, 0, BIG * 2, BIG * 2]);
	await run(target.id);
	const fC2 = byKey(await cannibalFindings(target.id), BREF);
	check('… deux semaines suffisent', fC2 !== undefined);
	check(
		'… et le finding annonce sa durée exacte',
		fC2 !== undefined && evidenceOf(fC2).metrics.overlapWeeks === 2,
		`overlapWeeks=${fC2 ? evidenceOf(fC2).metrics.overlapWeeks : '—'}`
	);

	await dropQuery(target.id, BREF);

	// ── §D — ⭐ le REMPLACEMENT n'est pas une cannibalisation ─────────
	section('§D — ⭐ un remplacement d’URL n’est pas un conflit');

	const RELAIS = q('relais');
	await spread(target.id, weeks, RELAIS, pg('vieille'), [BIG * 2, BIG * 2, 0, 0]);
	await spread(target.id, weeks, RELAIS, pg('neuve'), [0, 0, BIG * 2, BIG * 2]);

	const rD = await run(target.id);
	check(
		'⭐ deux URLs significatives qui ne se croisent JAMAIS ne produisent rien',
		byKey(await cannibalFindings(target.id), RELAIS) === undefined
	);
	check(
		'… et le cas est nommé pour ce qu’il est (remplacement)',
		rD.replacements >= 1,
		`replacements=${rD.replacements}`
	);

	await dropQuery(target.id, RELAIS);

	// ── §E — ⭐ les variantes de REQUÊTE ne sont pas regroupées ───────
	section('§E — ⭐ inversion de la doctrine FIND-006 : aucune fusion de requêtes');

	const V1 = q('alpha beta');
	const V2 = q('beta alpha');
	await spread(target.id, weeks, V1, pg('i'), [BIG, BIG, BIG, BIG]);
	await spread(target.id, weeks, V2, pg('j'), [BIG, BIG, BIG, BIG]);

	await run(target.id);
	const fE = await cannibalFindings(target.id);
	check(
		'⭐ deux orthographes mono-URL ne fabriquent AUCUN conflit',
		byKey(fE, V1) === undefined && byKey(fE, V2) === undefined
	);
	check(
		'l’entité d’un finding est la requête BRUTE, jamais une clé normalisée',
		byKey(fE, FRANC)?.entityKey === FRANC && byKey(fE, FRANC)?.entityType === 'query',
		`entityKey="${byKey(fE, FRANC)?.entityKey}"`
	);

	await dropQuery(target.id, V1);
	await dropQuery(target.id, V2);

	// ── §F — les quatre grandeurs sont visibles et exactes ───────────
	section('§F — dominance, alternance, durée et chevauchement sont VISIBLES');

	const BASCULE = q('bascule');
	await spread(target.id, weeks, BASCULE, pg('k'), [BIG, MEDIUM, BIG, MEDIUM], { position: 5 });
	await spread(target.id, weeks, BASCULE, pg('l'), [MEDIUM, BIG, MEDIUM, BIG], { position: 6 });

	await run(target.id);
	const fF = byKey(await cannibalFindings(target.id), BASCULE);
	const evF = fF ? evidenceOf(fF) : null;
	check('le conflit alterné est écrit', evF !== null);
	check(
		'⭐ l’alternance est exacte : 4 semaines, 3 bascules',
		evF?.metrics.switches === 3 && evF?.metrics.alternation === 1,
		`switches=${evF?.metrics.switches} alternation=${evF?.metrics.alternation}`
	);
	check(
		'… la durée et le chevauchement aussi',
		evF?.metrics.overlapWeeks === 4 && evF?.metrics.overlapRatio === 1
	);
	check(
		'… la forme mécanique est « alternating »',
		evF?.shape === 'alternating' && evF?.probable === true
	);
	check(
		'⭐ les meneurs sont lisibles SEMAINE PAR SEMAINE',
		evF?.leaders.length === 4 &&
			evF.leaders.map((l) => l.week).join(',') === weeks.map((w) => w.start).join(',') &&
			new Set(evF.leaders.map((l) => l.url)).size === 2,
		evF ? evF.leaders.map((l) => `${l.week}:${l.url.split('/').pop()}`).join(' ') : ''
	);
	// La dominance se recalcule à la main depuis les URLs publiées : rien n'est opaque.
	if (evF) {
		const total = evF.urls.reduce((s, u) => s + u.impressions, 0);
		const recomputed = Math.max(...evF.urls.map((u) => u.impressions)) / total;
		check(
			'⭐ la dominance se REVÉRIFIE depuis les preuves seules',
			Math.abs(recomputed - evF.metrics.dominance) < 1e-9,
			`${recomputed.toFixed(6)} vs ${evF.metrics.dominance.toFixed(6)}`
		);
		check(
			'… et la série hebdo somme aux totaux annoncés',
			evF.urls.every((u) => u.weekly.reduce((s, w) => s + w.impressions, 0) === u.impressions)
		);
	}

	// ── §G — ⭐ merge / redirect / canonical restent L4 ───────────────
	section('§G — ⭐ aucune décision destructive : L4 prouvé, pas affirmé');

	const fG = await cannibalFindings(target.id);
	check(
		'le skill recommandé est un skill d’ANALYSE',
		fG.every((f) => f.recommendedSkill === 'seo-cannibalisation'),
		[...new Set(fG.map((f) => f.recommendedSkill))].join(', ')
	);
	const proposalCount = await countProposalsFor(fG.map((f) => f.id));
	check(
		'⭐ aucune proposition n’a été créée pour ces findings',
		proposalCount === 0,
		`action_proposals=${proposalCount}`
	);
	// Et la garde est STRUCTURELLE : le producteur lui-même n'en tire rien.
	const sample = byKey(fG, FRANC)!;
	const proposable: ProposableFinding = {
		id: sample.id,
		type: sample.type,
		fingerprint: sample.fingerprint,
		entityType: sample.entityType,
		entityKey: sample.entityKey,
		title: sample.title,
		status: sample.status,
		severity: sample.severity,
		priorityScore: sample.priorityScore,
		confidenceScore: sample.confidenceScore,
		impactEstimateJson: sample.impactEstimateJson,
		evidenceJson: sample.evidenceJson,
		recommendedSkill: sample.recommendedSkill
	};
	const actions = mapFindingToActions(
		proposable,
		readFindingSignals(proposable),
		resolveProposerConfig()
	);
	check(
		'⭐ le producteur AGT-000 ne tire aucune action d’un conflit',
		actions.length === 0,
		`${actions.length} action(s)`
	);

	// ── §H — idempotence ─────────────────────────────────────────────
	section('§H — rejouer le même run ne crée rien');

	const beforeH = (await cannibalFindings(target.id)).length;
	const rH = await run(target.id);
	const afterH = (await cannibalFindings(target.id)).length;
	check('aucun finding créé au second run', rH.counts.created === 0, `created=${rH.counts.created}`);
	check('… mais les existants sont rafraîchis', rH.counts.refreshed > 0, `refreshed=${rH.counts.refreshed}`);
	check('… et le compte est stable', beforeH === afterH, `${beforeH} → ${afterH}`);

	// ── §I — ⭐ hors portée ≠ guéri ──────────────────────────────────
	section('§I — ⭐ un conflit devenu IMMESURABLE reste strictement intact');

	const missesBefore = byKey(await cannibalFindings(target.id), FRANC)?.consecutiveMisses ?? -1;
	// La requête disparaît entièrement : le run ne peut plus rien en dire.
	await dropQuery(target.id, FRANC);
	const rI = await run(target.id);
	const fI = byKey(await cannibalFindings(target.id), FRANC);
	check(
		'⭐ le finding n’est ni résolu ni compté absent',
		fI?.status === 'open' && fI?.consecutiveMisses === missesBefore,
		`status=${fI?.status} misses=${fI?.consecutiveMisses} (avant ${missesBefore})`
	);
	check(
		'… et l’absence de mesure est COMPTÉE',
		rI.lifecycle.outOfScope >= 1,
		`outOfScope=${rI.lifecycle.outOfScope}`
	);

	// §I′ — la guérison, elle, doit bien résoudre. La requête revient au-dessus du
	// plancher, mais avec UNE SEULE URL : mesurable, et sans conflit.
	section('§I′ — … alors qu’une guérison EFFECTIVE compte ses absences puis résout');
	await spread(target.id, weeks, FRANC, pg('a'), [BIG, BIG, BIG, BIG], { clicks: 400, position: 4 });
	const rI1 = await run(target.id);
	const fI1 = byKey(await cannibalFindings(target.id), FRANC);
	check(
		'1ʳᵉ absence mesurable : comptée, pas résolue',
		fI1?.status === 'open' && fI1?.consecutiveMisses === 1,
		`status=${fI1?.status} misses=${fI1?.consecutiveMisses} missed=${rI1.lifecycle.missed}`
	);
	const rI2 = await run(target.id);
	const fI2 = byKey(await cannibalFindings(target.id), FRANC);
	check(
		'2ᵉ absence : résolu',
		fI2?.status === 'resolved',
		`status=${fI2?.status} autoResolved=${rI2.lifecycle.autoResolved}`
	);

	// ── §J — closure ⊋ écrits, portée ⊋ closure ──────────────────────
	section('§J — la closure porte TOUT ce qui matche, la portée porte davantage');

	// Trois conflits francs, plafond à 2 : deux écrits, trois dans la closure.
	const CAPPED = ['cap1', 'cap2', 'cap3'].map((n) => q(n));
	for (const name of CAPPED) {
		await spread(target.id, weeks, name, pg(`${name.split(' ').pop()}-x`), [BIG, BIG, BIG, BIG], {
			clicks: 50
		});
		await spread(target.id, weeks, name, pg(`${name.split(' ').pop()}-y`), [
			MEDIUM,
			MEDIUM,
			MEDIUM,
			MEDIUM
		]);
	}
	const rJ = await runCannibalizationDetector({
		db,
		projectId: target.id,
		thresholds: { ...THRESHOLDS, maxCandidates: 2 },
		now: new Date()
	});
	check(
		'⭐ la troncature écrit moins que la closure',
		rJ.conflicts.length === 2 && rJ.totalMatched > rJ.conflicts.length && rJ.truncated,
		`écrits=${rJ.conflicts.length} matched=${rJ.totalMatched}`
	);
	check(
		'… la closure porte TOUS les conflits (rien ne s’auto-résout par troncature)',
		rJ.lifecycle.closure === rJ.totalMatched,
		`closure=${rJ.lifecycle.closure}`
	);
	check(
		'… et la portée est strictement plus large que la closure',
		rJ.lifecycle.scope > rJ.lifecycle.closure,
		`scope=${rJ.lifecycle.scope} > closure=${rJ.lifecycle.closure}`
	);

	// ── §K — dry-run, fenêtre courte, projet fantôme ─────────────────
	section('§K — dry-run, projet à historique court, projet fantôme');

	const beforeK = (await cannibalFindings(target.id))
		.map((f) => `${f.id}:${f.occurrenceCount}:${f.status}`)
		.sort();
	const rDry = await run(target.id, { dryRun: true });
	const afterK = (await cannibalFindings(target.id))
		.map((f) => `${f.id}:${f.occurrenceCount}:${f.status}`)
		.sort();
	check('le dry-run annonce ce qu’il aurait écrit', rDry.conflicts.length > 0, `${rDry.conflicts.length} conflits`);
	check('… sans aucun findingId', rDry.conflicts.every((c) => c.findingId === null));
	check('⭐ … et la base est strictement inchangée', JSON.stringify(beforeK) === JSON.stringify(afterK));
	check('… la réconciliation ne tourne pas non plus', rDry.lifecycle.reconciled === false);

	// ⭐ La décision de la fenêtre unique : `spinlink` (6 semaines) n'a PAS de fenêtre
	// comparable — FIND-005 et FIND-006 s'y arrêtent. Ici, la persistance se lit DANS la
	// fenêtre, donc le détecteur produit.
	const shortWeeks = await recentWeeks(short.id, 4);
	const SPIN = q('court');
	await spread(short.id, shortWeeks, SPIN, `https://${HOST}/s1`, [BIG, BIG, BIG, BIG], { clicks: 20 });
	await spread(short.id, shortWeeks, SPIN, `https://${HOST}/s2`, [MEDIUM, MEDIUM, MEDIUM, MEDIUM]);
	const rShort = await run(short.id);
	check(
		'⭐ spinlink (6 semaines) PRODUIT — la cannibalisation n’a pas besoin de deux fenêtres',
		rShort.skippedReason === null && rShort.conflicts.length === 1,
		`skipped=${rShort.skippedReason ?? 'null'} conflits=${rShort.conflicts.length} semaines=${rShort.weeksAvailable}`
	);

	const rGhost = await run('projet-inexistant-find008');
	check(
		'un projet sans observation le DIT au lieu de rendre un vide muet',
		rGhost.skippedReason === 'aucune observation GSC pour ce projet',
		rGhost.skippedReason ?? ''
	);

	// ── §L — garde d'isolation + nettoyage ───────────────────────────
	section('§L — aucun finding RÉEL n’a été créé');

	const allTarget = await cannibalFindings(target.id);
	const allShort = await cannibalFindings(short.id);
	const foreign = [...allTarget, ...allShort].filter((f) => !f.entityKey.startsWith(MARK));
	check(
		'⭐ tout finding de cannibalisation porte le marqueur de test',
		foreign.length === 0,
		foreign.length > 0
			? `FUITE : ${foreign.map((f) => f.entityKey).join(', ')}`
			: `${allTarget.length + allShort.length} marqués`
	);

	section('Nettoyage');
	const ids = [...allTarget, ...allShort].map((f) => f.id);
	if (ids.length > 0) {
		await db.delete(schema.findingEvents).where(inArray(schema.findingEvents.findingId, ids));
		await db.delete(schema.findings).where(inArray(schema.findings.id, ids));
	}
	for (const projectId of [target.id, short.id]) {
		await db
			.delete(schema.gscQueryPageObservations)
			.where(
				and(
					eq(schema.gscQueryPageObservations.projectId, projectId),
					like(schema.gscQueryPageObservations.query, `${MARK}%`)
				)
			);
	}

	const finalMarked =
		(await countMarkedObservations(target.id)) + (await countMarkedObservations(short.id));
	const finalFindings = await countAllFindings(target.id);
	const finalShortFindings = await countAllFindings(short.id);
	check('observations marquées supprimées', finalMarked === 0, `${finalMarked}`);
	check(
		'findings de lecureux rendus à l’identique',
		finalFindings === baselineFindings,
		`${baselineFindings} → ${finalFindings}`
	);
	check(
		'findings de spinlink rendus à l’identique',
		finalShortFindings === baselineShortFindings,
		`${baselineShortFindings} → ${finalShortFindings}`
	);

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
