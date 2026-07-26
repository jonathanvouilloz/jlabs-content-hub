/**
 * DASH-003 lot 2 chantier 2 — Preuve : l'onglet Indexation, sur Neon.
 *
 * Ce que vitest couvre déjà (`project-indexing-state.test.ts`, 25 tests) : le vocabulaire des
 * filtres, « jamais inspecté » ≠ « 0 h », « premier inventaire » ≠ « diff vide », l'ordre des
 * familles, « au plus » ≠ « il reste », `null` canonical = incomparable. Sans base ni horloge.
 *
 * Ce qui ne peut PAS s'y prouver, et se prouve ici :
 *
 *   A. **ANTI-DIVERGENCE** — sur un projet RÉEL et au même instant,
 *      `JSON.stringify(loadProjectIndexing().panel)` === celui du panneau `indexing` de
 *      `loadProjectCockpit()`, et `.indexation` idem. C'est l'équivalent de l'égalité §A du
 *      lot 1 : deux taux de couverture à un onglet d'écart, personne ne saurait lequel croire.
 *      ⚠️ Le chemin de lecture N'EST PAS le même — l'onglet passe par `loadInspectionFreshness`
 *      (qui n'avait aucun appelant), la vue d'ensemble par son `max(observed_date)` local. C'est
 *      précisément ce que cette égalité a besoin de vérifier ;
 *   B. la couverture sur des observations réelles : `excluded` HORS dénominateur, et chaque
 *      compteur de classe porte l'URL qui le reproduit ;
 *   C. **CONTRE-ÉPREUVE** — un seul inventaire sitemap ne rend pas un diff vide ; le second
 *      snapshot, lui, rend `added`/`removed` réels sur la vraie fonction pure `diffInventories` ;
 *   D. **⭐ « honorée » se DÉRIVE** — une intention due sans observation compte ; l'observation
 *      posée à la date d'échéance la fait disparaître **sans qu'une ligne d'`index_selection`
 *      ne bouge** (comptée avant/après) ;
 *   E. une `reason` hors vocabulaire est ÉCARTÉE et COMPTÉE (`unreadable`), jamais réinterprétée
 *      ni glissée dans une famille ;
 *   F. un fichier sitemap en erreur est un fait interrogeable (`filesWithErrors`), pas un silence ;
 *   G. le filtre `?class=` ne rend que sa classe, et la troncature est dite avec le total réel ;
 *   H. **CONTRE-ÉPREUVE** — un projet sans aucune observation rend `never` / `coverageRate: null`,
 *      jamais « 0 % » ni « 0 h » ;
 *   I. la base est rendue à l'identique (comptée avant/après).
 *
 * Isolation. Projet sentinelle, dispositif repris de `dash-003-pause-health-proof.ts` : le slug
 * est EMPRUNTÉ à `core.entities` (registre canonique possédé par `invoices`, jamais modifié
 * depuis ici — loi n°3) parmi ceux sans projet SEO. Aucune écriture sur un projet réel : §A ne
 * fait que LIRE. Le nettoyage supprime par ID, jamais par slug.
 *
 * ⚠️ **Zéro appel réseau** : aucun collecteur n'est lancé, les observations sont injectées à la
 * main. Dépenser du quota d'URL Inspection pour prouver un écran serait absurde — le compte est
 * partagé par les six projets.
 *
 * Un Ctrl-C saute le `finally` : chercher alors le projet « PREUVE DASH-003 IDX — à supprimer ».
 *
 * Lancer : npx tsx scripts/dash-003-indexing-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { loadProjectCockpit } from '../src/lib/server/project-cockpit.js';
import { loadProjectIndexing } from '../src/lib/server/project-indexing.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';
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

const SENTINEL_NAME = 'PREUVE DASH-003 IDX — à supprimer';

let SENTINEL_SLUG = '';
let SENTINEL_ID = '';

/** L'instant de LECTURE, figé : deux lectures à des instants différents ne se comparent pas. */
const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const dayBefore = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

async function cleanup(): Promise<void> {
	if (!SENTINEL_ID) return;
	for (const t of [
		'index_observations',
		'index_selection',
		'sitemap_url_observations',
		'sitemap_observations',
		'project_integrations'
	]) {
		await db.execute(
			sql`DELETE FROM "seostats".${sql.raw(`"${t}"`)} WHERE project_id = ${SENTINEL_ID}`
		);
	}
	await db.execute(sql`DELETE FROM "seostats"."projects" WHERE id = ${SENTINEL_ID}`);
}

async function countRows(table: string): Promise<number> {
	const res = await db.execute(sql`SELECT count(*)::int AS n FROM "seostats".${sql.raw(`"${table}"`)}`);
	return Number((res.rows?.[0] as { n: number } | undefined)?.n ?? 0);
}

async function countSelection(): Promise<number> {
	const res = await db.execute(sql`
		SELECT count(*)::int AS n FROM "seostats"."index_selection" WHERE project_id = ${SENTINEL_ID}
	`);
	return Number((res.rows?.[0] as { n: number } | undefined)?.n ?? 0);
}

async function insertObservation(input: {
	url: string;
	observedDate: string;
	coverageState: string | null;
	googleCanonical?: string | null;
	userCanonical?: string | null;
}): Promise<void> {
	await db.execute(sql`
		INSERT INTO "seostats"."index_observations"
		       (id, project_id, provider, observed_date, url, coverage_state, verdict,
		        google_canonical, user_canonical, fetched_at)
		VALUES (${createId()}, ${SENTINEL_ID}, 'indexing', ${input.observedDate}, ${input.url},
		        ${input.coverageState}, 'NEUTRAL', ${input.googleCanonical ?? null},
		        ${input.userCanonical ?? null}, ${toDbTimestamp(NOW)})
	`);
}

async function insertSelection(input: {
	url: string;
	dueDate: string;
	reason: string;
	bucket: string;
}): Promise<void> {
	await db.execute(sql`
		INSERT INTO "seostats"."index_selection"
		       (id, project_id, due_date, url, url_normalized, reason, bucket, rank,
		        selector_version, created_at)
		VALUES (${createId()}, ${SENTINEL_ID}, ${input.dueDate}, ${input.url}, ${input.url},
		        ${input.reason}, ${input.bucket}, 0, 'index_selection@1', ${toDbTimestamp(NOW)})
	`);
}

async function insertSitemapUrl(input: {
	url: string;
	observedDate: string;
	lastmod: string | null;
	isAlternate?: boolean;
}): Promise<void> {
	await db.execute(sql`
		INSERT INTO "seostats"."sitemap_url_observations"
		       (id, project_id, provider, observed_date, sitemap_url, url, url_normalized,
		        lastmod, expected_canonical, is_alternate, fetched_at)
		VALUES (${createId()}, ${SENTINEL_ID}, 'gsc', ${input.observedDate},
		        'https://proof.test/sitemap.xml', ${input.url}, ${input.url}, ${input.lastmod},
		        ${input.url}, ${input.isAlternate ?? false}, ${toDbTimestamp(NOW)})
	`);
}

async function insertSitemapFile(input: {
	sitemapUrl: string;
	observedDate: string;
	errors: number;
}): Promise<void> {
	await db.execute(sql`
		INSERT INTO "seostats"."sitemap_observations"
		       (id, project_id, provider, observed_date, sitemap_url, submitted_urls, errors, fetched_at)
		VALUES (${createId()}, ${SENTINEL_ID}, 'gsc', ${input.observedDate}, ${input.sitemapUrl},
		        3, ${input.errors}, ${toDbTimestamp(NOW)})
	`);
}

/** L'onglet du sentinelle, tel que la route le charge. */
async function tab(opts: { activeClass?: 'indexed' | 'not_indexed' | 'excluded' | 'unknown' | null; urlLimit?: number } = {}) {
	const r = await loadProjectIndexing({
		db,
		projectSlug: SENTINEL_SLUG,
		now: NOW,
		activeClass: opts.activeClass ?? null,
		urlLimit: opts.urlLimit
	});
	if (!r) throw new Error('projet sentinelle introuvable');
	return r;
}

async function main(): Promise<void> {
	console.log(`DASH-003 lot 2 chantier 2 — preuve « l'onglet Indexation » · ${NOW.toISOString()}`);

	const baseline = {
		observations: await countRows('index_observations'),
		selection: await countRows('index_selection'),
		sitemapUrls: await countRows('sitemap_url_observations'),
		sitemapFiles: await countRows('sitemap_observations'),
		projects: await countRows('projects')
	};

	// ── A. Anti-divergence, sur un projet RÉEL (lecture seule) ───────
	section('A. ⭐ Le panneau et le résumé sont IDENTIQUES à ceux de la vue d’ensemble');

	const realRow = await db.execute(sql`
		SELECT slug FROM "seostats"."projects" WHERE archived = false ORDER BY slug LIMIT 1
	`);
	const realSlug = (realRow.rows?.[0] as { slug: string } | undefined)?.slug ?? '';
	if (!realSlug) {
		check('un projet réel existe pour l’égalité §A', false);
	} else {
		const [cockpit, indexing] = await Promise.all([
			loadProjectCockpit({ db, projectSlug: realSlug, now: NOW }),
			loadProjectIndexing({ db, projectSlug: realSlug, now: NOW })
		]);
		const cockpitPanel = cockpit?.panels.find((p) => p.key === 'indexing') ?? null;
		console.log(`  (projet réel « ${realSlug} »)`);
		check(
			'le panneau `indexing` de l’onglet === celui de la vue d’ensemble, champ par champ',
			JSON.stringify(indexing?.panel) === JSON.stringify(cockpitPanel),
			`onglet = ${JSON.stringify(indexing?.panel?.state)} · vue = ${JSON.stringify(cockpitPanel?.state)}`
		);
		check(
			'…et le résumé de couverture aussi (le taux ne peut pas différer d’un onglet à l’autre)',
			JSON.stringify(indexing?.indexation) === JSON.stringify(cockpit?.indexation)
		);
		check(
			'⭐ …alors que la fraîcheur passe par DEUX chemins de lecture différents',
			JSON.stringify(indexing?.panel.provenance.freshness) ===
				JSON.stringify(cockpitPanel?.provenance.freshness),
			`loadInspectionFreshness vs max(observed_date) local`
		);
	}

	// ── Le sentinelle ───────────────────────────────────────────────
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
			'\n❌ Aucun slug libre dans `core.entities`. Cette preuve a besoin d’un projet À PART :\n' +
				'   injecter des observations sur un projet réel fausserait ses compteurs de couverture.'
		);
		failures += 1;
		return;
	}
	console.log(`\n  (projet sentinelle sur le slug libre « ${SENTINEL_SLUG} »)`);

	SENTINEL_ID = createId();
	try {
		await db.execute(sql`
			INSERT INTO "seostats"."projects" (id, name, slug, color, access_token, archived, created_at)
			VALUES (${SENTINEL_ID}, ${SENTINEL_NAME}, ${SENTINEL_SLUG}, '#000000',
			        ${createId()}, false, ${toDbTimestamp(new Date(NOW.getTime() - 90 * 86_400_000))})
		`);
	} catch (err) {
		SENTINEL_ID = '';
		console.error('\n❌ Création du projet sentinelle impossible :', err instanceof Error ? err.message : err);
		failures += 1;
		return;
	}

	// ── H. Rien du tout : ni « 0 % », ni « 0 h », ni une panne ───────
	section('H. CONTRE-ÉPREUVE — un projet sans observation ne dit ni « 0 % », ni « 0 h »');

	const empty = await tab();
	check(
		'sans intégration déclarée ET sans donnée, le panneau est `inactive` — pas `broken`',
		empty.panel.state === 'inactive',
		`state = ${empty.panel.state} · ${empty.panel.note}`
	);
	check(
		'⭐ le taux de couverture est `null`, jamais 0',
		empty.indexation.coverageRate === null,
		`coverageRate = ${JSON.stringify(empty.indexation.coverageRate)}`
	);
	check(
		'la fraîcheur se dit « jamais inspecté » et n’écrit aucune heure',
		empty.freshnessNote.toLowerCase().includes('jamais inspecté') &&
			!empty.freshnessNote.includes('0 h'),
		empty.freshnessNote
	);
	check('l’inventaire sitemap est ABSENT, pas vide', empty.sitemap.date === null);

	// ⭐ La distinction que `derivePanelState` porte, et que l'onglet doit rendre : « rien à
	// brancher » et « branché, rien collecté » demandent deux gestes opposés. Les confondre
	// enverrait vers une page de réglages déjà remplie — ou ferait attendre une collecte qui
	// n'a aucune raison de partir.
	await db.execute(sql`
		INSERT INTO "seostats"."project_integrations"
		       (id, project_id, provider, enabled, status, health_status, created_at, updated_at)
		VALUES (${createId()}, ${SENTINEL_ID}, 'indexing', true, 'active', 'healthy',
		        ${toDbTimestamp(NOW)}, ${toDbTimestamp(NOW)})
	`);
	const declared = await tab();
	check(
		'⭐ CONTRE-ÉPREUVE : la MÊME absence de donnée, intégration déclarée, devient `never`',
		declared.panel.state === 'never',
		`state = ${declared.panel.state} · ${declared.panel.note}`
	);
	check(
		'…et ne devient toujours pas `ok` : brancher n’est pas collecter',
		declared.panel.state !== 'ok' && declared.indexation.coverageRate === null
	);

	// ── B. La couverture sur des observations réelles ────────────────
	section('B. La couverture : `excluded` hors dénominateur, et chaque compteur porte son lien');

	await insertObservation({ url: 'https://proof.test/a', observedDate: TODAY, coverageState: 'Submitted and indexed' });
	await insertObservation({ url: 'https://proof.test/b', observedDate: TODAY, coverageState: 'Submitted and indexed' });
	await insertObservation({ url: 'https://proof.test/c', observedDate: TODAY, coverageState: 'Crawled - currently not indexed' });
	await insertObservation({ url: 'https://proof.test/d', observedDate: TODAY, coverageState: 'Excluded by ‘noindex’ tag' });
	await insertObservation({ url: 'https://proof.test/e', observedDate: TODAY, coverageState: null });

	const withData = await tab();
	check(
		'les cinq URLs sont observées et classées',
		withData.indexation.urlsObserved === 5,
		`classes = ${JSON.stringify(withData.indexation.classes)}`
	);
	check(
		'⭐ le taux est 2/3 (les exclues ne sont PAS au dénominateur)',
		withData.indexation.coverageRate !== null &&
			Math.abs(withData.indexation.coverageRate - 2 / 3) < 1e-9,
		`coverageRate = ${withData.indexation.coverageRate}`
	);
	const notIndexedFilter = withData.classFilters.find((f) => f.value === 'not_indexed');
	check(
		'le compteur `not_indexed` porte l’URL qui le reproduit',
		notIndexedFilter?.count === 1 &&
			notIndexedFilter?.href === `/projects/${SENTINEL_SLUG}/indexing?class=not_indexed`,
		`${notIndexedFilter?.count} → ${notIndexedFilter?.href}`
	);
	check('le panneau passe à `ok` (donnée fraîche du jour)', withData.panel.state === 'ok');

	// ── G. Le filtre et la troncature ────────────────────────────────
	section('G. Le filtre `?class=` ne rend que sa classe, et la troncature est dite');

	const excludedOnly = await tab({ activeClass: 'excluded' });
	check(
		'la liste filtrée ne contient que la classe demandée',
		excludedOnly.urls.length === 1 && excludedOnly.urls.every((u) => u.indexedClass === 'excluded'),
		`${excludedOnly.urls.length} ligne(s)`
	);
	check(
		'le total de la classe correspond au compteur du filtre',
		excludedOnly.urlsTotal === excludedOnly.classFilters.find((f) => f.value === 'excluded')?.count
	);
	const truncated = await tab({ urlLimit: 2 });
	check(
		'un plafond atteint est DIT avec le total réel',
		truncated.urlsTruncated && truncated.urls.length === 2 && truncated.urlsTotal === 5,
		`${truncated.urls.length}/${truncated.urlsTotal}`
	);

	// ── C. Le sitemap : un snapshot n'est pas un diff vide ───────────
	section('C. CONTRE-ÉPREUVE — un seul inventaire ne rend pas un diff vide');

	const D1 = dayBefore(7);
	for (const u of ['https://proof.test/a', 'https://proof.test/b', 'https://proof.test/c']) {
		await insertSitemapUrl({ url: u, observedDate: D1, lastmod: '2026-07-01' });
	}
	await insertSitemapUrl({ url: 'https://proof.test/a?lang=de', observedDate: D1, lastmod: null, isAlternate: true });
	await insertSitemapFile({ sitemapUrl: 'https://proof.test/sitemap.xml', observedDate: D1, errors: 0 });

	const oneSnapshot = await tab();
	check(
		'⭐ le premier inventaire annonce qu’il n’a rien à quoi se comparer',
		oneSnapshot.sitemap.diff === null && /premier inventaire/i.test(oneSnapshot.sitemap.note),
		oneSnapshot.sitemap.note
	);
	check(
		'une alternate n’est pas comptée comme une page',
		oneSnapshot.sitemap.urls === 3 && oneSnapshot.sitemap.alternates === 1,
		`${oneSnapshot.sitemap.urls} URLs · ${oneSnapshot.sitemap.alternates} alternate(s)`
	);

	// Second snapshot : `c` disparaît, `d` apparaît, `a` change de lastmod.
	await insertSitemapUrl({ url: 'https://proof.test/a', observedDate: TODAY, lastmod: '2026-07-20' });
	await insertSitemapUrl({ url: 'https://proof.test/b', observedDate: TODAY, lastmod: '2026-07-01' });
	await insertSitemapUrl({ url: 'https://proof.test/d', observedDate: TODAY, lastmod: '2026-07-15' });
	await insertSitemapFile({ sitemapUrl: 'https://proof.test/sitemap.xml', observedDate: TODAY, errors: 0 });

	const twoSnapshots = await tab();
	check(
		'le second snapshot rend un diff réel (fonction pure `diffInventories`)',
		twoSnapshots.sitemap.diff !== null && twoSnapshots.sitemap.previousDate === D1,
		`previousDate = ${twoSnapshots.sitemap.previousDate}`
	);
	check(
		'…une page ajoutée, une retirée, une modifiée',
		twoSnapshots.sitemap.diff?.added.length === 1 &&
			twoSnapshots.sitemap.diff?.removed.length === 2 &&
			twoSnapshots.sitemap.diff?.changed.length === 1,
		`+${twoSnapshots.sitemap.diff?.added.length} −${twoSnapshots.sitemap.diff?.removed.length} ~${twoSnapshots.sitemap.diff?.changed.length}`
	);
	check(
		'la note ne dit plus « premier inventaire »',
		!/premier inventaire/i.test(twoSnapshots.sitemap.note),
		twoSnapshots.sitemap.note
	);

	// ── F. Un fichier en erreur est un fait ─────────────────────────
	section('F. Un sitemap injoignable ou malformé est un fait interrogeable');

	await insertSitemapFile({ sitemapUrl: 'https://proof.test/sitemap-2.xml', observedDate: TODAY, errors: 3 });
	const withError = await tab();
	check(
		'le fichier en erreur est compté à part, pas absorbé dans le total',
		withError.sitemap.files === 2 && withError.sitemap.filesWithErrors === 1,
		`${withError.sitemap.filesWithErrors}/${withError.sitemap.files} fichier(s)`
	);

	// ── D. « Honorée » se DÉRIVE ────────────────────────────────────
	section('D. ⭐ « Honorée » se dérive : l’observation efface l’échéance sans qu’une ligne bouge');

	const DUE = dayBefore(3);
	await insertSelection({ url: 'https://proof.test/z', dueDate: DUE, reason: 'finding', bucket: 'priority' });
	await insertSelection({ url: 'https://proof.test/y', dueDate: dayBefore(30), reason: 'sample', bucket: 'sample' });

	const beforeHonor = await tab();
	const selectionRowsBefore = await countSelection();
	check(
		'les deux intentions sont dues et non honorées',
		beforeHonor.quota.dueNow === 2,
		`dueNow = ${beforeHonor.quota.dueNow}`
	);
	check(
		'l’échéance la plus ancienne est nommée',
		beforeHonor.quota.oldestDueDate === dayBefore(30),
		`${beforeHonor.quota.oldestDueDate}`
	);
	check(
		'les familles sortent dans l’ordre de service, sans famille vide',
		JSON.stringify(beforeHonor.quota.byFamily.map((f) => f.key)) === JSON.stringify(['urgent', 'sample']),
		`${beforeHonor.quota.byFamily.map((f) => `${f.key}=${f.count}`).join(' ')}`
	);
	check(
		'l’échéance de 30 j est comptée comme abandonnée (maxAgeDays dépassé)',
		beforeHonor.quota.expired === 1,
		`expired = ${beforeHonor.quota.expired}`
	);

	// L'observation est posée À la date d'échéance : `observed_date >= due_date` porte toute la
	// sémantique J+N. Une inspection ANTÉRIEURE n'honorerait pas l'échéance.
	await insertObservation({ url: 'https://proof.test/z', observedDate: DUE, coverageState: 'Submitted and indexed' });
	const afterHonor = await tab();
	const selectionRowsAfter = await countSelection();
	check(
		'l’intention honorée disparaît de la file',
		afterHonor.quota.dueNow === 1,
		`dueNow = ${afterHonor.quota.dueNow}`
	);
	check(
		'⭐ …sans qu’aucune ligne d’`index_selection` n’ait été écrite ou supprimée',
		selectionRowsBefore === selectionRowsAfter,
		`${selectionRowsBefore} → ${selectionRowsAfter}`
	);
	check(
		'le pool du jour est dit « au plus », jamais « il reste »',
		/au plus/i.test(afterHonor.quota.poolNote) && !/il reste/i.test(afterHonor.quota.poolNote),
		afterHonor.quota.poolNote.slice(0, 60) + '…'
	);

	// ── E. Une raison hors vocabulaire ──────────────────────────────
	section('E. Une raison inconnue est écartée et COMPTÉE, jamais réinterprétée');

	await insertSelection({
		url: 'https://proof.test/x',
		dueDate: dayBefore(1),
		reason: 'invented_by_a_future_version',
		bucket: 'priority'
	});
	const withUnreadable = await tab();
	check(
		'la ligne illisible est comptée à part',
		withUnreadable.quota.unreadable === 1,
		`unreadable = ${withUnreadable.quota.unreadable}`
	);
	check(
		'⭐ …et n’a rejoint AUCUNE famille (deviner une raison serait inventer un diagnostic)',
		withUnreadable.quota.byFamily.reduce((n, f) => n + f.count, 0) === withUnreadable.quota.dueNow,
		`familles = ${withUnreadable.quota.byFamily.reduce((n, f) => n + f.count, 0)} · dueNow = ${withUnreadable.quota.dueNow}`
	);

	// ── L'historique d'une URL ──────────────────────────────────────
	section('Historique — `?url=` rend la série, et un canonical incomparable ne dit pas « accord »');

	await insertObservation({
		url: 'https://proof.test/a',
		observedDate: dayBefore(14),
		coverageState: 'Crawled - currently not indexed',
		googleCanonical: 'https://proof.test/a',
		userCanonical: 'https://proof.test/a-other'
	});
	const focused = await loadProjectIndexing({
		db,
		projectSlug: SENTINEL_SLUG,
		now: NOW,
		focusUrl: 'https://proof.test/a'
	});
	check(
		'l’historique rend les deux observations, la plus récente d’abord',
		focused?.focusHistory.length === 2 && focused?.focusHistory[0]?.observedDate === TODAY,
		`${focused?.focusHistory.map((h) => h.observedDate).join(' · ')}`
	);
	check(
		'un désaccord de canonical est vu comme tel',
		focused?.focusHistory.find((h) => h.observedDate === dayBefore(14))?.canonicalMismatch === true
	);
	check(
		'⭐ deux canonicals absents rendent `null` (incomparable), jamais `false` (accord)',
		focused?.focusHistory.find((h) => h.observedDate === TODAY)?.canonicalMismatch === null
	);
	const noFocus = await loadProjectIndexing({
		db,
		projectSlug: SENTINEL_SLUG,
		now: NOW,
		focusUrl: 'https://proof.test/inexistante'
	});
	check('une URL sans historique ne prétend pas en avoir un', noFocus?.focusUrl === null);

	// ── I. La base rendue à l'identique ─────────────────────────────
	section('I. La base est rendue à l’identique');

	await cleanup();
	SENTINEL_ID = '';
	const after = {
		observations: await countRows('index_observations'),
		selection: await countRows('index_selection'),
		sitemapUrls: await countRows('sitemap_url_observations'),
		sitemapFiles: await countRows('sitemap_observations'),
		projects: await countRows('projects')
	};
	for (const key of Object.keys(baseline) as (keyof typeof baseline)[]) {
		check(`${key} : ${baseline[key]} → ${after[key]}`, baseline[key] === after[key]);
	}
}

main()
	.catch((err) => {
		console.error('\n❌ Preuve interrompue :', err instanceof Error ? err.stack : err);
		failures += 1;
	})
	.finally(async () => {
		await cleanup().catch(() => {});
		await pool.end();
		console.log('');
		console.log(failures === 0 ? '✅ Preuve complète — 0 échec.' : `❌ ${failures} échec(s).`);
		process.exit(failures === 0 ? 0 : 1);
	});
