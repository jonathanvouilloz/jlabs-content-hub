/**
 * IDX-001 — Preuve de l'inventaire sitemap (sur Neon).
 *
 * Les règles de parsing/normalisation/diff sont couvertes par vitest
 * (`sitemap-state.test.ts`, 31 tests). Ce qui ne peut PAS se prouver en vitest, et se prouve
 * ici, c'est ce que fait la BASE et ce que fait le PARCOURS RÉEL :
 *
 *   1. l'arbre est découvert (index → enfants) et persisté : 1 ligne par fichier + 1 par URL ;
 *   2. acceptation « un sitemap diff est reproductible et lié à deux snapshots » : deux dates
 *      en base, un diff exact, et **rejouer le même couple rend le même diff** ;
 *   3. acceptation « redirects et fragments sont normalisés » : `…/a` et `…/a#top` ne créent
 *      **jamais** deux lignes, et un 2ᵉ run avec fragments ne produit **aucun faux ajout** ;
 *   4. acceptation « aucune URL supprimée n'est automatiquement désindexée » : une URL retirée
 *      du sitemap apparaît en `removed` et **rien** n'est soumis (`indexing_submissions`
 *      inchangée), aucune notification, aucun effet de bord ;
 *   5. un sitemap **inaccessible** (404) est un FAIT persisté (`errors > 0` sur sa ligne
 *      per-fichier) et n'empêche **pas** les autres enfants — là où le legacy `catch {}` le
 *      rendait invisible ;
 *   6. un index **cyclique** s'arrête et se déclare tronqué ;
 *   7. un bail perdu (`signal` aborté) n'écrit **RIEN** — un inventaire partiel produirait des
 *      retraits fantômes au run suivant.
 *
 * `fetchImpl` est INJECTÉ : aucun réseau, aucun quota, et des cas (404, cycle) qu'on ne peut
 * pas provoquer à la demande sur un vrai site.
 *
 * Isolation. Dates sentinelles **2018-11-xx** (le premier inventaire réel n'existe pas encore)
 * sous un projet RÉEL (FK), URLs sur un domaine sentinelle. Nettoyage dans un `finally`.
 * Un Ctrl-C SAUTE ce nettoyage : vérifier alors les `observed_date` 2018-11-% de
 * `sitemap_url_observations` et `sitemap_observations`.
 *
 * Lancer : npx tsx scripts/idx-001-sitemap-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	collectSitemapInventory,
	loadPreviousInventory
} from '../src/lib/server/collectors/sitemap-inventory.js';
import { diffInventories } from '../src/lib/server/collectors/sitemap-state.js';

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

// ── Arbre XML sentinelle ────────────────────────────────────────────

const HOST = 'https://sentinelle-idx001.test';
const ROOT = `${HOST}/sitemap.xml`;
const CHILD_OK = `${HOST}/sitemap-pages.xml`;
const CHILD_404 = `${HOST}/sitemap-mort.xml`;
const CHILD_I18N = `${HOST}/sitemap-i18n.xml`;

const SENTINEL_DATE_1 = '2018-11-05';
const SENTINEL_DATE_2 = '2018-11-12';
const SENTINEL_PREFIX = '2018-11-';

function indexXml(children: string[]): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${children.map((c) => `  <sitemap><loc>${c}</loc></sitemap>`).join('\n')}
</sitemapindex>`;
}

function urlsetXml(entries: { loc: string; lastmod?: string }[]): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
	.map(
		(e) =>
			`  <url><loc>${e.loc}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}</url>`
	)
	.join('\n')}
</urlset>`;
}

const I18N_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>${HOST}/fr/contact</loc>
    <lastmod>2018-11-01</lastmod>
    <xhtml:link rel="alternate" hreflang="fr" href="${HOST}/fr/contact"/>
    <xhtml:link rel="alternate" hreflang="de" href="${HOST}/de/kontakt"/>
  </url>
  <url><lastmod>2018-11-01</lastmod></url>
</urlset>`;

/** Un `fetchImpl` qui sert l'arbre voulu ; toute URL non prévue rend 404. */
function fakeFetch(bodies: Record<string, string>): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		const body = bodies[url];
		if (body === undefined) {
			return new Response('nope', { status: 404, statusText: 'Not Found' });
		}
		return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
	}) as unknown as typeof fetch;
}

// ── Aides base ──────────────────────────────────────────────────────

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(q);
	return Number((res.rows?.[0] as { n: number }).n);
}

async function countUrlRows(projectId: string, date: string): Promise<number> {
	return scalar(sql`
		SELECT count(*)::int AS n FROM "seostats"."sitemap_url_observations"
		 WHERE project_id = ${projectId} AND observed_date = ${date}
	`);
}

async function countFileRows(projectId: string, date: string): Promise<number> {
	return scalar(sql`
		SELECT count(*)::int AS n FROM "seostats"."sitemap_observations"
		 WHERE project_id = ${projectId} AND observed_date = ${date}
	`);
}

async function cleanup(projectId: string): Promise<void> {
	await db.execute(sql`
		DELETE FROM "seostats"."sitemap_url_observations"
		 WHERE project_id = ${projectId} AND observed_date LIKE ${SENTINEL_PREFIX + '%'}
	`);
	await db.execute(sql`
		DELETE FROM "seostats"."sitemap_observations"
		 WHERE project_id = ${projectId} AND observed_date LIKE ${SENTINEL_PREFIX + '%'}
	`);
}

async function main(): Promise<void> {
	const projRes = await db.execute(
		sql`SELECT id, slug FROM "seostats"."projects" WHERE archived = false ORDER BY slug LIMIT 1`
	);
	const proj = (projRes.rows?.[0] as { id: string; slug: string } | undefined) ?? undefined;
	if (!proj) {
		console.error('Aucun projet actif en base. Abandon.');
		process.exitCode = 1;
		return;
	}
	console.log(`Projet sentinelle : ${proj.slug} (${proj.id})`);

	const base = {
		urlObs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."sitemap_url_observations"`),
		fileObs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."sitemap_observations"`),
		submissions: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."indexing_submissions"`),
		findings: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`),
		jobs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."jobs"`)
	};
	console.log(
		`Baseline : ${base.urlObs} url_obs · ${base.fileObs} file_obs · ${base.submissions} soumissions · ` +
			`${base.findings} findings · ${base.jobs} jobs`
	);

	try {
		await cleanup(proj.id);

		// ── A. Parcours de l'arbre, avec un enfant MORT ──────────────
		section('A. Découverte de l’arbre — index, enfants, et un 404 qui ne casse rien');
		const run1Bodies: Record<string, string> = {
			[ROOT]: indexXml([CHILD_OK, CHILD_404, CHILD_I18N]),
			[CHILD_OK]: urlsetXml([
				{ loc: `${HOST}/`, lastmod: '2018-11-01' },
				{ loc: `${HOST}/services`, lastmod: '2018-11-01' },
				{ loc: `${HOST}/blog/a`, lastmod: '2018-11-02' },
				// Même page que /services, avec fragment : ne doit JAMAIS créer une 2ᵉ ligne.
				{ loc: `${HOST}/services#top`, lastmod: '2018-11-01' }
			]),
			[CHILD_I18N]: I18N_XML
			// CHILD_404 volontairement absent → 404.
		};

		const run1 = await collectSitemapInventory({
			projectId: proj.id,
			rootUrl: ROOT,
			client: db,
			fetchImpl: fakeFetch(run1Bodies),
			now: new Date(`${SENTINEL_DATE_1}T09:00:00Z`)
		});

		check(
			'4 fichiers parcourus (racine + 3 enfants)',
			run1.files.length === 4,
			run1.files.map((f) => `${f.sitemapUrl.split('/').pop()}:${f.kind}`).join(' ')
		);
		const deadFile = run1.files.find((f) => f.sitemapUrl === CHILD_404);
		check(
			'l’enfant 404 est un FAIT persisté, avec son statut HTTP',
			!!deadFile && deadFile.httpStatus === 404 && deadFile.errors.length === 1,
			`http=${deadFile?.httpStatus} erreurs=${deadFile?.errors.length}`
		);
		check(
			'le run est marqué PARTIAL (un inventaire incomplet ne se lit pas comme complet)',
			run1.partial === true,
			`partial=${run1.partial} · ${run1.errors.length} erreur(s)`
		);
		check(
			'les autres enfants ont bien été parcourus malgré le 404',
			run1.files.filter((f) => f.kind === 'urlset').length === 2,
			`${run1.files.filter((f) => f.kind === 'urlset').length} urlset`
		);
		// /, /services, /blog/a (le #top est le même que /services) + /fr/contact + /de/kontakt = 5
		check(
			'5 URLs distinctes après normalisation et dédup',
			run1.entries.length === 5,
			run1.entries.map((e) => e.urlNormalized.replace(HOST, '')).sort().join(' ')
		);
		check(
			'le <url> sans <loc> du sitemap i18n est signalé',
			run1.errors.some((e) => e.kind === 'entry_without_loc'),
			run1.errors.map((e) => e.kind).join(',')
		);
		check(
			'l’alternate `de` est marquée comme telle, avec sa locale',
			run1.entries.some((e) => e.urlNormalized === `${HOST}/de/kontakt` && e.isAlternate && e.locale === 'de'),
			run1.entries.filter((e) => e.isAlternate).map((e) => `${e.locale}`).join(',')
		);
		check(
			'aucun diff au premier inventaire (pas de snapshot antérieur)',
			run1.diff === null && run1.previousDate === null,
			`diff=${run1.diff === null ? 'null' : 'présent'}`
		);

		// ── B. Ce qui est réellement en base ────────────────────────
		section('B. Persistance');
		check('5 lignes par-URL écrites', (await countUrlRows(proj.id, SENTINEL_DATE_1)) === 5, `${await countUrlRows(proj.id, SENTINEL_DATE_1)}`);
		check('4 lignes par-fichier écrites', (await countFileRows(proj.id, SENTINEL_DATE_1)) === 4, `${await countFileRows(proj.id, SENTINEL_DATE_1)}`);
		// L'enfant 404 NOMMÉMENT — et non « une ligne en erreur » : le sitemap i18n en porte
		// une aussi (son `<url>` sans `<loc>`), et confondre les deux ne prouverait pas que
		// l'inaccessible est bien celui qu'on croit.
		const deadRow = await scalar(sql`
			SELECT count(*)::int AS n FROM "seostats"."sitemap_observations"
			 WHERE project_id = ${proj.id} AND observed_date = ${SENTINEL_DATE_1}
			   AND sitemap_url = ${CHILD_404} AND errors > 0
		`);
		check(
			'le sitemap INACCESSIBLE porte errors > 0 en base (interrogeable, pas juste loggé)',
			deadRow === 1,
			`${deadRow} ligne pour ${CHILD_404.split('/').pop()}`
		);
		const anyErrorRows = await scalar(sql`
			SELECT count(*)::int AS n FROM "seostats"."sitemap_observations"
			 WHERE project_id = ${proj.id} AND observed_date = ${SENTINEL_DATE_1} AND errors > 0
		`);
		check(
			'2 fichiers en erreur au total : l’inaccessible ET le malformé, comptés séparément',
			anyErrorRows === 2,
			`${anyErrorRows} (404 + <url> sans <loc>)`
		);
		const fragmentRows = await scalar(sql`
			SELECT count(*)::int AS n FROM "seostats"."sitemap_url_observations"
			 WHERE project_id = ${proj.id} AND observed_date = ${SENTINEL_DATE_1}
			   AND url_normalized LIKE ${'%#%'}
		`);
		check('aucune URL normalisée ne contient de fragment', fragmentRows === 0, `${fragmentRows}`);

		// ── C. Rerun du MÊME jour : idempotent ──────────────────────
		section('C. Rerun le même jour — upsert, pas duplication');
		await collectSitemapInventory({
			projectId: proj.id,
			rootUrl: ROOT,
			client: db,
			fetchImpl: fakeFetch(run1Bodies),
			now: new Date(`${SENTINEL_DATE_1}T18:00:00Z`)
		});
		check(
			'toujours 5 lignes par-URL (0 doublon)',
			(await countUrlRows(proj.id, SENTINEL_DATE_1)) === 5,
			`${await countUrlRows(proj.id, SENTINEL_DATE_1)}`
		);
		check(
			'toujours 4 lignes par-fichier',
			(await countFileRows(proj.id, SENTINEL_DATE_1)) === 4,
			`${await countFileRows(proj.id, SENTINEL_DATE_1)}`
		);

		// ── D. Deuxième date : le DIFF ───────────────────────────────
		section('D. Diff entre deux snapshots (acceptation IDX-001)');
		const run2Bodies: Record<string, string> = {
			[ROOT]: indexXml([CHILD_OK, CHILD_I18N]), // l'enfant mort a disparu de l'index
			[CHILD_OK]: urlsetXml([
				{ loc: `${HOST}/`, lastmod: '2018-11-01' }, // inchangée
				{ loc: `${HOST}/services`, lastmod: '2018-11-10' }, // lastmod bougé
				// /blog/a RETIRÉE  ·  /blog/b AJOUTÉE
				{ loc: `${HOST}/blog/b`, lastmod: '2018-11-09' },
				// Et cette fois avec un fragment sur une URL déjà connue : aucun faux ajout attendu.
				{ loc: `${HOST}/#accueil`, lastmod: '2018-11-01' }
			]),
			[CHILD_I18N]: I18N_XML
		};
		const run2 = await collectSitemapInventory({
			projectId: proj.id,
			rootUrl: ROOT,
			client: db,
			fetchImpl: fakeFetch(run2Bodies),
			now: new Date(`${SENTINEL_DATE_2}T09:00:00Z`)
		});

		check(
			'le diff se lie au snapshot ANTÉRIEUR, nommément',
			run2.previousDate === SENTINEL_DATE_1,
			`previousDate=${run2.previousDate}`
		);
		check(
			'1 ajout : /blog/b',
			run2.diff?.added.length === 1 && run2.diff.added[0] === `${HOST}/blog/b`,
			(run2.diff?.added ?? []).join(',')
		);
		check(
			'1 retrait : /blog/a',
			run2.diff?.removed.length === 1 && run2.diff.removed[0] === `${HOST}/blog/a`,
			(run2.diff?.removed ?? []).join(',')
		);
		check(
			'1 changement : /services (lastmod)',
			run2.diff?.changed.length === 1 &&
				run2.diff.changed[0].urlNormalized === `${HOST}/services` &&
				run2.diff.changed[0].fields.join(',') === 'lastmod',
			(run2.diff?.changed ?? []).map((c) => `${c.urlNormalized.replace(HOST, '')}:${c.fields}`).join(' ')
		);
		check(
			'le fragment sur / ne crée AUCUN faux ajout',
			!(run2.diff?.added ?? []).some((u) => u === `${HOST}/` || u.includes('#')),
			(run2.diff?.added ?? []).join(',')
		);
		// L'enfant mort a disparu de l'index → plus AUCUN `fetch_failed`. Mais le sitemap i18n
		// garde son `<url>` sans `<loc>`, donc le run reste `partial` : les deux natures de
		// problème (injoignable vs malformé) ne se compensent ni ne se confondent.
		check(
			'plus aucun fetch_failed au run 2 (l’enfant mort a quitté l’index)',
			!run2.errors.some((e) => e.kind === 'fetch_failed'),
			run2.errors.map((e) => e.kind).join(',') || '(aucune)'
		);
		check(
			'mais le run reste PARTIAL à cause du fichier malformé — un problème ne masque pas l’autre',
			run2.partial === true && run2.errors.every((e) => e.kind === 'entry_without_loc'),
			`partial=${run2.partial} · ${run2.errors.map((e) => e.kind).join(',')}`
		);

		// REPRODUCTIBILITÉ : le diff est une fonction PURE de deux snapshots en base.
		const snap1 = await loadPreviousInventory({ db, projectId: proj.id, beforeDate: SENTINEL_DATE_2 });
		const snap2 = await loadPreviousInventory({ db, projectId: proj.id, beforeDate: '2018-11-19' });
		const rejoue = diffInventories(snap1.rows, snap2.rows);
		check(
			'REJOUER le même couple de dates rend le MÊME diff (reproductible)',
			JSON.stringify({ a: rejoue.added, r: rejoue.removed, c: rejoue.changed.map((c) => c.urlNormalized) }) ===
				JSON.stringify({
					a: run2.diff?.added,
					r: run2.diff?.removed,
					c: run2.diff?.changed.map((c) => c.urlNormalized)
				}),
			`rejoué: +${rejoue.added.length}/-${rejoue.removed.length}/~${rejoue.changed.length}`
		);
		check(
			'et une seconde fois, à l’identique',
			JSON.stringify(diffInventories(snap1.rows, snap2.rows)) === JSON.stringify(rejoue),
			'stable'
		);

		// ── E. Aucune URL retirée n'est désindexée ───────────────────
		section('E. Une URL retirée n’est JAMAIS désindexée automatiquement');
		const submissionsNow = await scalar(
			sql`SELECT count(*)::int AS n FROM "seostats"."indexing_submissions"`
		);
		check(
			'un retrait détecté n’a soumis AUCUNE URL à Google',
			submissionsNow === base.submissions,
			`${base.submissions} → ${submissionsNow} (1 retrait détecté)`
		);
		const findingsNow = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`);
		check(
			'et n’a créé aucun finding de son propre chef (c’est IDX-005 qui décidera)',
			findingsNow === base.findings,
			`${base.findings} → ${findingsNow}`
		);

		// ── F. Cycle d'index : borné, et déclaré ─────────────────────
		section('F. Un index cyclique s’arrête et le DIT');
		const cyclic = await collectSitemapInventory({
			projectId: proj.id,
			rootUrl: ROOT,
			client: db,
			dryRun: true, // on ne veut pas écrire cette forme dégénérée
			fetchImpl: fakeFetch({
				[ROOT]: indexXml([CHILD_OK, ROOT]), // l'index se référence lui-même
				[CHILD_OK]: urlsetXml([{ loc: `${HOST}/` }])
			}),
			now: new Date(`${SENTINEL_DATE_2}T10:00:00Z`)
		});
		check(
			'le cycle est détecté et rapporté',
			cyclic.errors.some((e) => e.kind === 'cycle'),
			cyclic.errors.map((e) => e.kind).join(',')
		);
		check('le run se déclare tronqué', cyclic.truncated === true, `truncated=${cyclic.truncated}`);
		check(
			'et il n’a rien écrit (dry-run)',
			(await countUrlRows(proj.id, SENTINEL_DATE_2)) === 5,
			`${await countUrlRows(proj.id, SENTINEL_DATE_2)} lignes au ${SENTINEL_DATE_2}`
		);
		// LA RAISON D'ÊTRE DE LA GARDE D'ÉCRITURE, mesurée : ce run tronqué n'a vu qu'1 URL,
		// et son diff annonce donc 4 RETRAITS qui n'ont jamais eu lieu. Si un inventaire
		// partiel était écrit, c'est ce faux signal que le run suivant lirait comme réel.
		check(
			'un inventaire tronqué PRODUIT bien des retraits fantômes (d’où la garde d’écriture)',
			(cyclic.diff?.removed.length ?? 0) === 4 && cyclic.entries.length === 1,
			`${cyclic.entries.length} URL vue → ${cyclic.diff?.removed.length} retraits annoncés, jamais écrits`
		);

		// ── G. Bail perdu : RIEN n'est écrit ────────────────────────
		section('G. Bail perdu en cours de parcours — rien n’est écrit');
		const ABORT_DATE = '2018-11-26';
		const beforeAbort = await countUrlRows(proj.id, ABORT_DATE);
		check(`aucune ligne au ${ABORT_DATE} avant l’essai`, beforeAbort === 0, `${beforeAbort}`);

		// Signal aborté AVANT l'appel : la première itération de la boucle doit s'arrêter net,
		// donc avant tout fetch et surtout avant toute écriture.
		const aborted = new AbortController();
		aborted.abort();
		const abortMessage = await (async () => {
			try {
				await collectSitemapInventory({
					projectId: proj.id,
					rootUrl: ROOT,
					client: db,
					signal: aborted.signal,
					fetchImpl: fakeFetch({
						[ROOT]: indexXml([CHILD_OK]),
						[CHILD_OK]: urlsetXml([{ loc: `${HOST}/` }])
					}),
					now: new Date(`${ABORT_DATE}T09:00:00Z`)
				});
				return '(aucune erreur — la collecte a abouti)';
			} catch (err) {
				return err instanceof Error ? err.message : String(err);
			}
		})();
		check(
			'un bail perdu fait ÉCHOUER la collecte au lieu d’écrire un inventaire partiel',
			abortMessage.includes('interrompue'),
			abortMessage.slice(0, 90)
		);
		const afterAbort = await countUrlRows(proj.id, ABORT_DATE);
		check(
			'aucune ligne par-URL écrite pour cette date',
			afterAbort === 0,
			`${beforeAbort} → ${afterAbort}`
		);
		check(
			'aucune ligne par-fichier écrite non plus',
			(await countFileRows(proj.id, ABORT_DATE)) === 0,
			`${await countFileRows(proj.id, ABORT_DATE)}`
		);
	} finally {
		await cleanup(proj.id);
	}

	// ── H. Base rendue à l'identique ────────────────────────────────
	section('H. Base rendue à l’identique');
	const post = {
		urlObs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."sitemap_url_observations"`),
		fileObs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."sitemap_observations"`),
		submissions: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."indexing_submissions"`),
		findings: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`),
		jobs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."jobs"`)
	};
	for (const key of Object.keys(base) as (keyof typeof base)[]) {
		check(`${key} inchangé`, base[key] === post[key], `${base[key]} → ${post[key]}`);
	}

	section(failures === 0 ? '✅ Toutes les vérifications passent.' : `❌ ${failures} échec(s).`);
	if (failures > 0) process.exitCode = 1;
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => pool.end());
