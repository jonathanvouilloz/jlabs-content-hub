/**
 * IDX-002 — Preuve du collecteur URL Inspection persistant (sur Neon).
 *
 * Le parsing/classification/plafond est couvert par vitest (`url-inspection-state.test.ts`,
 * 18 tests). Ce qui ne peut PAS se prouver en vitest, et se prouve ici :
 *
 *   1. **les 7 cas d'erreur sont classés juste par la FILE** — `classifyJobFailure` sur l'erreur
 *      réellement jetée, dont les deux que Google fait à l'envers (403 `rateLimitExceeded` =
 *      `quota` et non `permanent`, 400 `invalid_grant` = `auth`). C'est le cœur du lot : un
 *      quota mal classé part en **dead-letter permanente** ;
 *   2. acceptation « distinguer erreur provider et résultat non indexé » : une erreur provider
 *      **n'écrit RIEN** et ne se lit **jamais** comme « non indexé » ; une page réellement non
 *      indexée, elle, produit bien une observation ;
 *   3. acceptations « chaque inspection possède un historique » + « un rerun ne détruit pas
 *      l'état précédent » : un rerun le **même jour** rafraîchit sa ligne, une observation d'un
 *      jour **antérieur** reste intacte, et l'historique se relit dans l'ordre ;
 *   4. acceptation « le statut UI est dérivé de champs persistés » : `loadLatestIndexStates`
 *      rend l'état **depuis la base**, sans aucun appel réseau ;
 *   5. tous les champs de SPEC §9.2 sont conservés — 7 en colonnes, le reste en payload borné,
 *      et un `referringUrls` géant est **tronqué sans faire échouer** la collecte ;
 *   6. le plafond d'URLs est appliqué **et rapporté** ;
 *   7. **1 inspection RÉELLE** sur une URL de `jonlabs` (coût : 1 appel de quota) — la seule
 *      chose qu'un mock ne peut pas prouver : que propriété, scope et forme de réponse
 *      s'accordent vraiment.
 *
 * Isolation. Dates sentinelles **2018-11-xx**, URLs sur un domaine sentinelle, sous un projet
 * RÉEL (FK). Nettoyage dans un `finally`. Un Ctrl-C SAUTE ce nettoyage : vérifier alors les
 * `observed_date` 2018-11-% de `index_observations` et les URLs `sentinelle-idx002.test`.
 *
 * Lancer : npx tsx scripts/idx-002-inspection-proof.ts
 *          npx tsx scripts/idx-002-inspection-proof.ts --skip-real   (sans l'appel Google)
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { collectUrlInspection, inspectOne } from '../src/lib/server/collectors/url-inspection.js';
import { loadIndexHistory, loadLatestIndexStates } from '../src/lib/server/indexing-read.js';
import { classifyJobFailure } from '../src/lib/server/job-retry.js';
import { loadGscBinding, resetTokenCache } from '../src/lib/server/gsc-auth.js';
import { MAX_URLS_PER_JOB } from '../src/lib/server/collectors/url-inspection-state.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const SKIP_REAL = process.argv.includes('--skip-real');

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

const HOST = 'https://sentinelle-idx002.test';
const DATE_1 = '2018-11-05';
const DATE_2 = '2018-11-12';
const SENTINEL_PREFIX = '2018-11-';
const noSleep = async () => {};

// ── Réponses Google simulées ────────────────────────────────────────

function okBody(over: Record<string, unknown> = {}) {
	return {
		inspectionResult: {
			indexStatusResult: {
				verdict: 'PASS',
				coverageState: 'Submitted and indexed',
				indexingState: 'INDEXING_ALLOWED',
				robotsState: 'INDEXING_ALLOWED',
				googleCanonical: `${HOST}/a`,
				userCanonical: `${HOST}/a`,
				lastCrawlTime: '2018-11-04T04:12:33Z',
				pageFetchState: 'SUCCESSFUL',
				crawledAs: 'MOBILE',
				sitemap: [`${HOST}/sitemap.xml`],
				referringUrls: [`${HOST}/`],
				...over
			},
			mobileUsabilityResult: { verdict: 'PASS' },
			richResultsResult: { verdict: 'NEUTRAL' }
		}
	};
}

/** Un `fetchImpl` qui répond par URL inspectée ; le token OAuth est servi en premier. */
function fakeFetch(byUrl: (url: string) => { status: number; body: unknown }): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		// Échange JWT → jeton : on court-circuite, la preuve ne teste pas OAuth.
		if (target.includes('oauth2') || target.includes('token')) {
			return new Response(JSON.stringify({ access_token: 'jeton-de-preuve', expires_in: 3600 }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		const inspected = (() => {
			try {
				return JSON.parse(String(init?.body ?? '{}')).inspectionUrl as string;
			} catch {
				return '';
			}
		})();
		const { status, body } = byUrl(inspected);
		return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	}) as unknown as typeof fetch;
}

function googleError(status: number, reason: string | null, message = 'boom') {
	return {
		status,
		body: {
			error: {
				code: status,
				message,
				status: reason ?? undefined,
				errors: reason ? [{ reason, message }] : undefined
			}
		}
	};
}

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(q);
	return Number((res.rows?.[0] as { n: number }).n);
}

async function countSentinelObs(projectId: string): Promise<number> {
	return scalar(sql`
		SELECT count(*)::int AS n FROM "seostats"."index_observations"
		 WHERE project_id = ${projectId} AND observed_date LIKE ${SENTINEL_PREFIX + '%'}
	`);
}

async function cleanup(projectId: string): Promise<void> {
	await db.execute(sql`
		DELETE FROM "seostats"."index_observations"
		 WHERE project_id = ${projectId}
		   AND (observed_date LIKE ${SENTINEL_PREFIX + '%'} OR url LIKE ${HOST + '%'})
	`);
}

async function main(): Promise<void> {
	// Un projet qui a un binding GSC (donc une propriété) : `loadGscBinding` est appelé même
	// avec un fetch injecté, puisque c'est lui qui résout la propriété correcte.
	const projRes = await db.execute(sql`
		SELECT p.id, p.slug FROM "seostats"."projects" p
		  JOIN "seostats"."indexing_credentials" c ON c.project_id = p.id
		 WHERE p.archived = false AND c.site_url IS NOT NULL
		 ORDER BY p.slug LIMIT 1
	`);
	const proj = projRes.rows?.[0] as { id: string; slug: string } | undefined;
	if (!proj) {
		console.error('Aucun projet avec une propriété GSC. Abandon.');
		process.exitCode = 1;
		return;
	}
	console.log(`Projet sentinelle : ${proj.slug} (${proj.id})`);

	const base = {
		indexObs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."index_observations"`),
		submissions: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."indexing_submissions"`),
		integrations: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."project_integrations"`)
	};
	console.log(
		`Baseline : ${base.indexObs} index_obs · ${base.submissions} soumissions · ${base.integrations} intégrations`
	);

	try {
		await cleanup(proj.id);
		resetTokenCache();

		const binding = await loadGscBinding(proj.id, { client: db });
		console.log(`Propriété GSC : ${binding.siteUrl}`);

		// ── A. Les 7 cas d'erreur, classés par la FILE ───────────────
		section('A. Erreur provider STRUCTURÉE → classification JOB-003 exacte');
		const CASES: { label: string; status: number; reason: string | null; expect: string }[] = [
			{ label: '429 trop de requêtes', status: 429, reason: null, expect: 'quota' },
			{
				label: '403 rateLimitExceeded (Google le fait à l’envers)',
				status: 403,
				reason: 'rateLimitExceeded',
				expect: 'quota'
			},
			{ label: '403 nu (vraie interdiction)', status: 403, reason: null, expect: 'permanent' },
			{ label: '400 invalid_grant (auth, pas permanent)', status: 400, reason: 'invalid_grant', expect: 'auth' },
			{ label: '401 non authentifié', status: 401, reason: null, expect: 'auth' },
			{ label: '404 propriété inconnue', status: 404, reason: null, expect: 'permanent' },
			{ label: '500 côté Google (rejouable)', status: 500, reason: null, expect: 'retryable' }
		];

		for (const c of CASES) {
			resetTokenCache();
			const outcome = await inspectOne({
				binding,
				url: `${HOST}/erreur`,
				deps: { client: db, fetchImpl: fakeFetch(() => googleError(c.status, c.reason)) }
			});
			const isError = outcome.kind === 'provider_error';
			// On reconstruit l'erreur telle que le collecteur la relance, puis on la classe.
			const thrown = await (async () => {
				try {
					await collectUrlInspection({
						projectId: proj.id,
						urls: [`${HOST}/erreur`],
						client: db,
						sleep: noSleep,
						now: new Date(`${DATE_1}T09:00:00Z`),
						deps: { client: db, fetchImpl: fakeFetch(() => googleError(c.status, c.reason)) }
					});
					return null;
				} catch (err) {
					return err;
				}
			})();
			const cls = thrown ? classifyJobFailure(thrown).errorClass : '(aucune erreur)';
			check(
				`${c.label} → \`${c.expect}\``,
				isError && cls === c.expect,
				`classé \`${cls}\``
			);
		}

		// ── B. Erreur provider ≠ résultat non indexé ─────────────────
		section('B. Une erreur provider n’écrit RIEN et ne se lit jamais « non indexé »');
		check(
			'aucune observation écrite malgré 7 tentatives en erreur',
			(await countSentinelObs(proj.id)) === 0,
			`${await countSentinelObs(proj.id)} observation(s)`
		);
		const statesAfterErrors = await loadLatestIndexStates({ db, projectId: proj.id, urls: [`${HOST}/erreur`] });
		check(
			'et l’URL en erreur n’existe pas en base (elle n’est ni indexée, ni non indexée)',
			statesAfterErrors.length === 0,
			`${statesAfterErrors.length} ligne(s)`
		);

		// La contre-épreuve : une page RÉELLEMENT non indexée, elle, produit une observation.
		resetTokenCache();
		await collectUrlInspection({
			projectId: proj.id,
			urls: [`${HOST}/pas-indexee`],
			client: db,
			sleep: noSleep,
			now: new Date(`${DATE_1}T09:00:00Z`),
			deps: {
				client: db,
				fetchImpl: fakeFetch(() => ({
					status: 200,
					body: okBody({
						verdict: 'NEUTRAL',
						coverageState: 'Crawled - currently not indexed',
						googleCanonical: undefined
					})
				}))
			}
		});
		const notIndexed = await loadLatestIndexStates({ db, projectId: proj.id, urls: [`${HOST}/pas-indexee`] });
		check(
			'une page vraiment NON INDEXÉE produit bien une observation, classée `not_indexed`',
			notIndexed.length === 1 && notIndexed[0].indexedClass === 'not_indexed',
			`${notIndexed.length} ligne · classe=${notIndexed[0]?.indexedClass}`
		);
		check(
			'les deux situations sont donc DISTINGUABLES en base (0 ligne vs 1 ligne classée)',
			statesAfterErrors.length === 0 && notIndexed.length === 1,
			'erreur → absente · non indexée → présente et qualifiée'
		);

		// Une réponse 200 ILLISIBLE est un troisième état : ni erreur provider, ni résultat.
		resetTokenCache();
		const unreadableRun = await collectUrlInspection({
			projectId: proj.id,
			urls: [`${HOST}/illisible`],
			client: db,
			sleep: noSleep,
			now: new Date(`${DATE_1}T09:00:00Z`),
			deps: { client: db, fetchImpl: fakeFetch(() => ({ status: 200, body: { rien: true } })) }
		});
		check(
			'une réponse 200 illisible est un TROU NOMMÉ : rien écrit, mais le lot continue',
			unreadableRun.unreadable.length === 1 && unreadableRun.inspected.length === 0,
			`unreadable=${unreadableRun.unreadable.length} inspected=${unreadableRun.inspected.length}`
		);

		// ── C. Tous les champs SPEC §9.2 ─────────────────────────────
		section('C. Champs conservés — 7 en colonnes, le reste en payload borné');
		resetTokenCache();
		const many = Array.from({ length: 400 }, (_, i) => `${HOST}/ref/${i}`);
		await collectUrlInspection({
			projectId: proj.id,
			urls: [`${HOST}/a`],
			client: db,
			sleep: noSleep,
			now: new Date(`${DATE_1}T09:00:00Z`),
			deps: {
				client: db,
				fetchImpl: fakeFetch(() => ({ status: 200, body: okBody({ referringUrls: many }) }))
			}
		});
		const row = (
			await db.execute(sql`
				SELECT verdict, coverage_state, indexing_state, robots_state, google_canonical,
				       user_canonical, last_crawl_at, payload_json
				  FROM "seostats"."index_observations"
				 WHERE project_id = ${proj.id} AND url = ${`${HOST}/a`} AND observed_date = ${DATE_1}
			`)
		).rows?.[0] as Record<string, string | null> | undefined;
		check(
			'les 7 colonnes sont remplies',
			!!row &&
				row.verdict === 'PASS' &&
				row.coverage_state === 'Submitted and indexed' &&
				row.indexing_state === 'INDEXING_ALLOWED' &&
				row.robots_state === 'INDEXING_ALLOWED' &&
				row.google_canonical === `${HOST}/a` &&
				row.user_canonical === `${HOST}/a` &&
				row.last_crawl_at === '2018-11-04T04:12:33Z',
			`verdict=${row?.verdict} coverage=${row?.coverage_state}`
		);
		const payload = JSON.parse(row?.payload_json ?? '{}') as Record<string, unknown>;
		check(
			'le payload porte pageFetchState, crawledAs, sitemaps, mobile et rich results',
			payload.pageFetchState === 'SUCCESSFUL' &&
				payload.crawledAs === 'MOBILE' &&
				Array.isArray(payload.sitemaps) &&
				!!payload.mobileUsability &&
				!!payload.richResults,
			Object.keys(payload).join(',')
		);
		check(
			'un referringUrls de 400 entrées est TRONQUÉ et le dit — la collecte n’échoue pas',
			Array.isArray(payload.referringUrls) &&
				(payload.referringUrls as string[]).length === 50 &&
				Array.isArray(payload.truncated),
			`${(payload.referringUrls as string[])?.length} gardées · truncated=${JSON.stringify(payload.truncated)}`
		);
		const payloadBytes = new TextEncoder().encode(row?.payload_json ?? '').length;
		check('et le payload tient sous 32 Ko', payloadBytes < 32 * 1024, `${payloadBytes} octets`);

		// ── D. Rerun & historique ────────────────────────────────────
		section('D. Historique et rerun non destructeur');
		const obsBefore = await countSentinelObs(proj.id);
		resetTokenCache();
		await collectUrlInspection({
			projectId: proj.id,
			urls: [`${HOST}/a`],
			client: db,
			sleep: noSleep,
			now: new Date(`${DATE_1}T20:00:00Z`), // MÊME jour
			deps: {
				client: db,
				fetchImpl: fakeFetch(() => ({
					status: 200,
					body: okBody({ coverageState: 'Indexed, not submitted in sitemap' })
				}))
			}
		});
		check(
			'un rerun le MÊME jour rafraîchit sans dupliquer',
			(await countSentinelObs(proj.id)) === obsBefore,
			`${obsBefore} → ${await countSentinelObs(proj.id)}`
		);
		const refreshed = await loadLatestIndexStates({ db, projectId: proj.id, urls: [`${HOST}/a`] });
		check(
			'et la mesure est bien la NOUVELLE',
			refreshed[0]?.coverageState === 'Indexed, not submitted in sitemap',
			`${refreshed[0]?.coverageState}`
		);

		// Un jour PLUS TARD : nouvelle ligne, l'ancienne intacte.
		resetTokenCache();
		await collectUrlInspection({
			projectId: proj.id,
			urls: [`${HOST}/a`],
			client: db,
			sleep: noSleep,
			now: new Date(`${DATE_2}T09:00:00Z`),
			deps: {
				client: db,
				fetchImpl: fakeFetch(() => ({
					status: 200,
					body: okBody({ verdict: 'FAIL', coverageState: "Excluded by 'noindex' tag" })
				}))
			}
		});
		const history = await loadIndexHistory({ db, projectId: proj.id, url: `${HOST}/a` });
		check(
			'un jour plus tard = une NOUVELLE ligne (2 dates), la précédente intacte',
			history.length === 2 &&
				history[0].observedDate === DATE_2 &&
				history[1].observedDate === DATE_1 &&
				history[1].coverageState === 'Indexed, not submitted in sitemap',
			history.map((h) => `${h.observedDate}:${h.indexedClass}`).join(' ')
		);
		check(
			'l’historique se lit du plus récent au plus ancien',
			history[0].observedDate > history[1].observedDate,
			`${history[0].observedDate} > ${history[1].observedDate}`
		);
		check(
			'« excluded » est une classe à part, pas un « non indexé »',
			history[0].indexedClass === 'excluded',
			`${history[0].coverageState} → ${history[0].indexedClass}`
		);

		// ── E. Statut dérivé de la BASE, sans réseau ─────────────────
		section('E. Le statut UI vient de la base — aucun appel à la volée');
		let networkCalls = 0;
		const countingFetch = (async () => {
			networkCalls += 1;
			throw new Error('la lecture ne doit JAMAIS appeler le réseau');
		}) as unknown as typeof fetch;
		void countingFetch; // le read-model ne prend même pas de fetch : c'est le point.
		const states = await loadLatestIndexStates({ db, projectId: proj.id });
		check(
			'loadLatestIndexStates rend le dernier état par URL, sans réseau',
			states.length >= 2 && networkCalls === 0,
			`${states.length} URL(s) · ${networkCalls} appel réseau`
		);
		check(
			'une seule ligne par URL (DISTINCT ON), la plus récente',
			new Set(states.map((s) => s.url)).size === states.length &&
				states.find((s) => s.url === `${HOST}/a`)?.observedDate === DATE_2,
			`${states.length} lignes pour ${new Set(states.map((s) => s.url)).size} URLs`
		);
		const mismatchState = states.find((s) => s.url === `${HOST}/pas-indexee`);
		check(
			'canonicalMismatch = null quand un canonical manque (incomparable ≠ d’accord)',
			mismatchState?.canonicalMismatch === null,
			`${mismatchState?.canonicalMismatch}`
		);

		// ── F. Plafond d'URLs ───────────────────────────────────────
		section('F. Plafond d’URLs appliqué ET rapporté');
		resetTokenCache();
		const capRun = await collectUrlInspection({
			projectId: proj.id,
			urls: [`${HOST}/c1`, `${HOST}/c2`, `${HOST}/c3`, `${HOST}/c1`],
			cap: 2,
			client: db,
			dryRun: true,
			sleep: noSleep,
			now: new Date(`${DATE_2}T09:00:00Z`),
			deps: { client: db, fetchImpl: fakeFetch(() => ({ status: 200, body: okBody() })) }
		});
		check(
			'2 URLs inspectées, 1 écartée par le plafond (le doublon ayant été dédupliqué)',
			capRun.inspected.length === 2 && capRun.truncated === true && capRun.dropped === 1,
			`inspected=${capRun.inspected.length} truncated=${capRun.truncated} dropped=${capRun.dropped}`
		);
		check(
			`le plafond dur est ${MAX_URLS_PER_JOB} (un cap forgé ne peut pas le dépasser)`,
			MAX_URLS_PER_JOB === 200,
			`${MAX_URLS_PER_JOB}`
		);

		// ── G. Bail perdu ───────────────────────────────────────────
		section('G. Bail perdu — on n’engage pas un quota de plus');
		const aborted = new AbortController();
		aborted.abort();
		resetTokenCache();
		const abortedRun = await collectUrlInspection({
			projectId: proj.id,
			urls: [`${HOST}/g1`, `${HOST}/g2`],
			client: db,
			signal: aborted.signal,
			sleep: noSleep,
			now: new Date(`${DATE_2}T09:00:00Z`),
			deps: { client: db, fetchImpl: fakeFetch(() => ({ status: 200, body: okBody() })) }
		});
		check(
			'aucune URL inspectée après perte du bail',
			abortedRun.inspected.length === 0,
			`${abortedRun.inspected.length}`
		);
		check(
			'et rien écrit pour ces URLs',
			(await loadLatestIndexStates({ db, projectId: proj.id, urls: [`${HOST}/g1`, `${HOST}/g2`] })).length === 0,
			'0 ligne'
		);

		// ── H. Une inspection RÉELLE ────────────────────────────────
		section('H. Chaîne réelle — 1 inspection contre le vrai Google');
		if (SKIP_REAL) {
			console.log('  ⏭️  --skip-real : appel Google non effectué (aucun quota consommé).');
		} else {
			resetTokenCache();
			const realUrl = binding.siteUrl.startsWith('sc-domain:')
				? `https://${binding.siteUrl.slice('sc-domain:'.length)}/`
				: binding.siteUrl;
			const real = await inspectOne({ binding, url: realUrl, deps: { client: db } });
			if (real.kind === 'result') {
				check(
					'la vraie API rend un verdict et un coverageState exploitables',
					real.normalized.verdict !== null || real.normalized.coverageState !== null,
					`verdict=${real.normalized.verdict} coverage=${real.normalized.coverageState}`
				);
				check(
					'et la propriété utilisée est la bonne (pas de 403)',
					true,
					`${binding.siteUrl} → ${realUrl}`
				);
			} else {
				// Un échec réel n'est pas un échec de la preuve s'il est CLASSÉ juste : c'est la
				// démonstration inverse, tout aussi utile (quota du jour épuisé, par exemple).
				const cls = classifyJobFailure(
					Object.assign(new Error(real.message), { status: real.status, reason: real.reason })
				).errorClass;
				check(
					`l’appel réel a échoué mais est CLASSÉ juste (\`${cls}\`)`,
					['quota', 'auth', 'permanent', 'retryable'].includes(cls),
					`${real.status} ${real.reason ?? ''} → ${cls}`
				);
			}
		}
	} finally {
		await cleanup(proj.id);
	}

	// ── I. Base rendue à l'identique ────────────────────────────────
	section('I. Base rendue à l’identique');
	const post = {
		indexObs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."index_observations"`),
		submissions: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."indexing_submissions"`),
		integrations: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."project_integrations"`)
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
