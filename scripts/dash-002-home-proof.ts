/**
 * DASH-002 — Preuve de l'accueil cross-projet (sur Neon).
 *
 * Les règles de classification/priorisation/gate sont couvertes par vitest
 * (`home-state.test.ts`, 37 tests). Ce qui ne peut PAS se prouver en vitest, et se prouve
 * ici, c'est ce que fait la BASE :
 *
 *   1. `loadHomeCockpit` lit les VRAIS domaines et ses cumuls sont d'accord avec des
 *      requêtes indépendantes (aucun compteur ne dérive de sa source) ;
 *   2. acceptation « une intégration cassée est distincte d'une baisse de performance » :
 *      une intégration sentinelle en erreur fait passer un projet réel en `broken` avec un
 *      signal `unknown` — et NON en `ok` malgré 0 finding, pendant qu'un autre projet reste
 *      jugé sur sa performance ;
 *   3. acceptation « chaque compteur ouvre une liste filtrée cohérente » : pour chaque
 *      compteur qui porte un lien, on REJOUE le filtre encodé dans l'URL et on vérifie que
 *      la liste rend exactement le nombre annoncé — c'est le seul test qui attrape une URL
 *      qui pointerait vers un autre ensemble ;
 *   4. acceptation « identifier en moins d'une minute les projets nécessitant une action » :
 *      l'ordre rendu est l'ordre d'urgence, et il est STABLE d'un appel à l'autre ;
 *   5. le filtre d'activité de l'inbox (`?event=` + `?since=`) écarte les valeurs inventées
 *      au lieu de laisser tout passer.
 *
 * Isolation. Rien n'est créé qu'on ne puisse nommer et supprimer : un provider
 * d'intégration sentinelle (`__test_dash002`), des findings au fingerprint préfixé
 * `__test_dash002:` et leurs événements. AUCUN projet n'est créé (la FK cross-schéma
 * `projects.slug → core.entities.slug` appartient à `invoices`). Nettoyage ENFANTS
 * D'ABORD dans un `finally` : finding_events → findings → project_integrations.
 * Un Ctrl-C SAUTE ce nettoyage : vérifier alors le provider `__test_dash002` et les
 * fingerprints `__test_dash002:%`.
 *
 * Lancer : npx tsx scripts/dash-002-home-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { loadHomeCockpit } from '../src/lib/server/home.js';
import {
	ACTIVITY_EVENTS,
	normalizeWindowDays,
	parseDbTimestampMs
} from '../src/lib/server/home-state.js';
import { countFindings } from '../src/lib/server/findings.js';
import { countProposals } from '../src/lib/server/proposals.js';
import { ACTIVE_STATUSES } from '../src/lib/server/finding-state.js';
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

const SENTINEL_PROVIDER = '__test_dash002';
const SENTINEL_FP_PREFIX = '__test_dash002:';

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(q);
	return Number((res.rows?.[0] as { n: number }).n);
}

async function cleanup(): Promise<void> {
	// ENFANTS D'ABORD : les événements référencent les findings.
	await db.execute(sql`
		DELETE FROM "seostats"."finding_events"
		 WHERE finding_id IN (
			SELECT id FROM "seostats"."findings" WHERE fingerprint LIKE ${SENTINEL_FP_PREFIX + '%'}
		 )
	`);
	await db.execute(sql`
		DELETE FROM "seostats"."findings" WHERE fingerprint LIKE ${SENTINEL_FP_PREFIX + '%'}
	`);
	await db.execute(sql`
		DELETE FROM "seostats"."project_integrations" WHERE provider = ${SENTINEL_PROVIDER}
	`);
}

/**
 * Rejoue le filtre encodé dans l'URL d'un compteur, EXACTEMENT comme le loader de l'inbox
 * le ferait, et rend le total de la liste correspondante.
 *
 * C'est le cœur de l'acceptation « chaque compteur ouvre une liste filtrée cohérente » :
 * on ne compare pas deux nombres calculés par le même code, on part de l'URL (ce que
 * l'utilisateur va réellement ouvrir) et on la relit.
 */
async function replayCounterHref(href: string): Promise<number> {
	const url = new URL(href, 'https://x');
	const projectSlug = url.searchParams.get('project');

	if (url.pathname === '/inbox' && url.searchParams.get('tab') === 'findings') {
		const rawStatuses = (url.searchParams.get('fstatus') ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const rawEvents = (url.searchParams.get('event') ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter((s) => (ACTIVITY_EVENTS as readonly string[]).includes(s));
		const rawSince = (url.searchParams.get('since') ?? '').trim();
		const activitySince =
			rawEvents.length > 0 && rawSince && parseDbTimestampMs(rawSince) !== null ? rawSince : null;

		return countFindings(
			{
				projectSlug,
				statuses: rawStatuses.length === 0 ? ACTIVE_STATUSES : rawStatuses,
				activityEvents: activitySince ? rawEvents : undefined,
				activitySince
			},
			db
		);
	}

	if (url.pathname === '/inbox') {
		// Onglet propositions : `?status=proposed`.
		const status = url.searchParams.get('status');
		return countProposals({ statuses: status ? [status] : undefined, projectSlug }, db);
	}

	if (url.pathname === '/jobs') {
		const status = url.searchParams.get('status') ?? 'dead';
		const res = await db.execute(sql`
			SELECT count(*)::int AS n FROM "seostats"."jobs" j
			  LEFT JOIN "seostats"."projects" p ON p.id = j.project_id
			 WHERE j.status = ${status}
			   ${projectSlug ? sql`AND p.slug = ${projectSlug}` : sql``}
		`);
		return Number((res.rows?.[0] as { n: number }).n);
	}

	if (url.pathname.startsWith('/projects/') && url.pathname.endsWith('/reviews')) {
		const slug = url.pathname.split('/')[2];
		const res = await db.execute(sql`
			SELECT count(*)::int AS n FROM "seostats"."gmb_reviews" r
			  JOIN "seostats"."projects" p ON p.id = r.project_id
			 WHERE r.replied_at IS NULL AND p.slug = ${slug}
		`);
		return Number((res.rows?.[0] as { n: number }).n);
	}

	throw new Error(`URL de compteur non rejouable : ${href}`);
}

async function main(): Promise<void> {
	// ⚠️ Le projet « baisse de performance » ne peut PAS être choisi par position.
	//
	// Il l'était (`projectRows[1]`), et la preuve a fini par échouer sans qu'une ligne de code
	// applicatif change : le parc a grandi, la 2ᵉ place a glissé sur un projet qu'aucun détecteur
	// n'a jamais examiné. DASH-002 rend alors son signal `unknown` — « jamais regardé » n'est pas
	// « rien à signaler » — et `unknown` prime sur `at_risk`. La preuve testait donc la règle de
	// couverture en croyant tester la distinction panne/baisse.
	//
	// D'où un choix par PROPRIÉTÉ, pas par rang : un projet dont au moins un détecteur a tourné.
	// Sans lui, la section B ne prouve rien de ce qu'elle annonce.
	const projRes = await db.execute(sql`
		SELECT p.id, p.slug, p.name,
		       count(j.id) FILTER (WHERE j.type LIKE 'detect:%' AND j.status = 'succeeded') AS detects
		  FROM "seostats"."projects" p
		  LEFT JOIN "seostats"."jobs" j ON j.project_id = p.id
		 WHERE p.archived = false
		 GROUP BY p.id, p.slug, p.name
		 ORDER BY p.slug
	`);
	const projectRows = (projRes.rows ?? []) as unknown as {
		id: string;
		slug: string;
		name: string;
		detects: number | string;
	}[];
	if (projectRows.length < 2) {
		console.error('Moins de 2 projets actifs en base : la preuve a besoin de deux cibles. Abandon.');
		process.exitCode = 1;
		return;
	}
	// Deux projets RÉELS distincts : l'un recevra une panne d'intégration, l'autre une
	// baisse de performance. C'est la contre-épreuve de l'acceptation n°3.
	const diagnosed = projectRows.filter((p) => Number(p.detects) > 0);
	if (diagnosed.length === 0) {
		console.error(
			'Aucun projet n’a jamais eu de détecteur réussi : la section B testerait la règle de\n' +
				'couverture (`signal = unknown`) au lieu de la distinction panne / baisse. Abandon.'
		);
		process.exitCode = 1;
		return;
	}
	const perfProj = diagnosed[0];
	const brokenProj = projectRows.find((p) => p.id !== perfProj.id)!;
	console.log(
		`Projets : panne → ${brokenProj.slug} · performance → ${perfProj.slug} (${perfProj.detects} détecteur(s) passé(s))`
	);

	// Baselines à rendre à l'identique.
	const base = {
		findings: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`),
		events: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."finding_events"`),
		proposals: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."action_proposals"`),
		integrations: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."project_integrations"`),
		jobs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."jobs"`),
		observations: await scalar(
			sql`SELECT count(*)::int AS n FROM "seostats"."gsc_query_page_observations"`
		)
	};
	console.log(
		`Baseline : ${base.findings} findings · ${base.events} events · ${base.proposals} propositions · ` +
			`${base.integrations} intégrations · ${base.jobs} jobs · ${base.observations} observations`
	);

	try {
		// Filet : purge d'un run précédent interrompu.
		await cleanup();

		// ── A. L'accueil lit la vraie base ───────────────────────────
		section('A. Lecture réelle du portefeuille');
		const before = await loadHomeCockpit({ db });
		check(
			`${before.projects.length} carte(s) pour ${projectRows.length} projet(s) actif(s)`,
			before.projects.length === projectRows.length,
			`${before.projects.length}/${projectRows.length}`
		);
		check(
			'la fenêtre par défaut est 7 jours glissants',
			before.windowDays === 7,
			`${before.windowDays} j depuis ${before.sinceDb}`
		);
		check(
			'la borne de période est un horodatage au format DB lisible',
			parseDbTimestampMs(before.sinceDb) !== null && !before.sinceDb.includes('T'),
			before.sinceDb
		);
		// Cumul vs requête indépendante : aucun compteur ne doit dériver de sa source.
		const openIndependent = await scalar(sql`
			SELECT count(*)::int AS n FROM "seostats"."findings"
			 WHERE status IN ('open','reopened','acknowledged','planned','in_progress')
		`);
		const openFromCards = before.projects.reduce((a, c) => a + c.openTotal, 0);
		check(
			'le total « findings ouverts » égale une requête indépendante',
			openFromCards === openIndependent,
			`cartes=${openFromCards} vs SQL=${openIndependent}`
		);
		check(
			'les coûts sont annoncés NON INSTRUMENTÉS (pas un zéro)',
			before.costs.instrumented === false,
			before.costs.instrumented === false ? before.costs.reason : 'instrumenté'
		);
		check(
			'la capacité est exposée (dérivée JOB-006)',
			typeof before.capacity.global.running === 'number' && Array.isArray(before.capacity.providers),
			`global ${before.capacity.global.running}/${before.capacity.global.limit} · ${before.capacity.providers.length} providers`
		);

		// ── B. Acceptation : panne ≠ baisse de performance ───────────
		section('B. Une intégration cassée est distincte d’une baisse de performance');

		// Panne : une intégration sentinelle en erreur sur un projet réel.
		const nowDb = toDbTimestamp(new Date());
		await db.execute(sql`
			INSERT INTO "seostats"."project_integrations"
				(id, project_id, provider, resource_key, enabled, status, health_status,
				 last_error_at, last_error_code, created_at, updated_at)
			VALUES (${createId()}, ${brokenProj.id}, ${SENTINEL_PROVIDER}, ${''}, true, 'error', 'down',
				${nowDb}, 'invalid_grant', ${nowDb}, ${nowDb})
		`);

		// Baisse de performance : un finding critique + une aggravation dans la période.
		const findingId = createId();
		await db.execute(sql`
			INSERT INTO "seostats"."findings"
				(id, project_id, fingerprint, type, entity_type, entity_key, title, status, severity,
				 priority_score, confidence_score, occurrence_count, first_seen_at, last_seen_at,
				 created_at, updated_at)
			VALUES (${findingId}, ${perfProj.id}, ${SENTINEL_FP_PREFIX + 'perf'}, 'ctr_gap', 'query',
				'sentinelle', 'Sentinelle DASH-002 — chute de CTR', 'open', 'critical',
				90, 80, 1, ${nowDb}, ${nowDb}, ${nowDb}, ${nowDb})
		`);
		for (const eventType of ['created', 'aggravated']) {
			await db.execute(sql`
				INSERT INTO "seostats"."finding_events"
					(id, finding_id, project_id, event_type, actor, created_at)
				VALUES (${createId()}, ${findingId}, ${perfProj.id}, ${eventType}, 'system', ${nowDb})
			`);
		}

		const after = await loadHomeCockpit({ db });
		const brokenCard = after.projects.find((c) => c.slug === brokenProj.slug)!;
		const perfCard = after.projects.find((c) => c.slug === perfProj.slug)!;

		check(
			'le projet en panne est classé « broken »',
			brokenCard.state === 'broken',
			`state=${brokenCard.state} · pipeline=${brokenCard.pipeline.state}`
		);
		check(
			'sa panne nomme le code d’erreur (actionnable)',
			brokenCard.pipeline.reasons.some((r) => r.includes('invalid_grant')),
			brokenCard.pipeline.reasons[0] ?? '(aucune raison)'
		);
		check(
			'son SIGNAL devient « unknown », JAMAIS « ok » (le silence n’est pas la santé)',
			brokenCard.signal.state === 'unknown',
			`signal=${brokenCard.signal.state}`
		);
		check(
			'sa phrase parle de COLLECTE',
			brokenCard.headline.toLowerCase().includes('collecte'),
			brokenCard.headline
		);
		check(
			'le projet en baisse est classé « at_risk » avec un pipeline SAIN',
			perfCard.state === 'at_risk' && perfCard.pipeline.state !== 'broken',
			`state=${perfCard.state} · pipeline=${perfCard.pipeline.state}`
		);
		check(
			'sa phrase parle de PERFORMANCE',
			perfCard.headline.toLowerCase().includes('performance'),
			perfCard.headline
		);
		check(
			'les deux verdicts ne se confondent ni en état ni en phrase',
			brokenCard.state !== perfCard.state && brokenCard.headline !== perfCard.headline,
			`${brokenCard.state} ≠ ${perfCard.state}`
		);
		check(
			'l’activité de la période remonte l’aggravation sentinelle',
			perfCard.activity.aggravated >= 1 && perfCard.activity.created >= 1,
			`created=${perfCard.activity.created} aggravated=${perfCard.activity.aggravated}`
		);

		// ── B-bis. Deux aggravations d'un MÊME finding = UN problème ──
		// Régression trouvée en écrivant cette preuve : un `count(*)` sur le journal
		// annoncerait 2 là où la liste liée (dédoublonnée par finding) montrerait 1. Le cas
		// est RÉEL — `reconcileDetectionRun` écrit un `aggravated` par run, donc toute
		// fenêtre de 28/90 j le rencontre.
		section('B-bis. Le compteur compte des PROBLÈMES, pas des lignes de journal');
		await db.execute(sql`
			INSERT INTO "seostats"."finding_events"
				(id, finding_id, project_id, event_type, actor, created_at)
			VALUES (${createId()}, ${findingId}, ${perfProj.id}, 'aggravated', 'system', ${nowDb})
		`);
		const twice = await loadHomeCockpit({ db });
		const twiceCard = twice.projects.find((c) => c.slug === perfProj.slug)!;
		const twiceEvents = await scalar(sql`
			SELECT count(*)::int AS n FROM "seostats"."finding_events"
			 WHERE finding_id = ${findingId} AND event_type = 'aggravated'
		`);
		check(
			'2 événements `aggravated` sur le même finding sont bien en base',
			twiceEvents === 2,
			`${twiceEvents} événements`
		);
		check(
			'le compteur « aggravés » reste à 1 (un finding, pas deux lignes)',
			twiceCard.activity.aggravated === 1,
			`aggravated=${twiceCard.activity.aggravated}`
		);
		const twiceHref = twiceCard.counters.find((c) => c.label === 'aggravés')!.href!;
		check(
			'et la liste liée rend le même 1 (compteur ≡ liste, quelle que soit la fenêtre)',
			(await replayCounterHref(twiceHref)) === 1,
			`liste=${await replayCounterHref(twiceHref)}`
		);

		// ── B-ter. Un projet jamais diagnostiqué ne se lit pas « sain » ──
		// Ce que vitest ne peut PAS prouver : que la couverture lue en base correspond aux
		// détecteurs réellement passés. Le bug d'origine (`barberconcept` affiché « Sain »
		// sans avoir jamais été détecté) venait de là — le module pur n'avait simplement
		// jamais reçu l'information.
		section('B-ter. « Jamais diagnostiqué » ne se lit pas « sain »');
		const cockpit = await loadHomeCockpit({ db });
		check(
			'aucune carte ne se dit « ok » sans couverture complète',
			cockpit.projects.every((c) => c.state !== 'ok' || c.diagnosis.state === 'full'),
			cockpit.projects.map((c) => `${c.slug}:${c.state}/${c.diagnosis.state}`).join(' · ')
		);
		for (const card of cockpit.projects) {
			// La couverture rendue doit correspondre aux jobs détecteurs RÉELLEMENT réussis.
			const ran = await scalar(sql`
				SELECT count(DISTINCT type)::int AS n FROM "seostats"."jobs"
				 WHERE project_id = ${card.projectId} AND status = 'succeeded' AND type LIKE 'detect:%'
			`);
			check(
				`[${card.slug}] la couverture reflète les détecteurs réellement passés`,
				card.diagnosis.ranCount === Math.min(ran, card.diagnosis.expectedCount),
				`base=${ran} · carte=${card.diagnosis.ranCount}/${card.diagnosis.expectedCount} → ${card.diagnosis.state}`
			);
		}
		const jamais = cockpit.projects.filter((c) => c.diagnosis.state === 'none');
		check(
			'un projet sans aucun détecteur passé vaut « unknown », jamais « ok »',
			jamais.every((c) => c.signal.state === 'unknown'),
			jamais.map((c) => `${c.slug}:${c.signal.state}`).join(' · ') || '(aucun projet dans ce cas)'
		);
		// Et l'inconnu vient bien du DIAGNOSTIC, pas de la collecte : sur les projets dont le
		// pipeline est sain, la phrase doit nommer le diagnostic absent. Sans ce contrôle,
		// l'assertion ci-dessus passerait aussi bien si le signal était `unknown` pour une
		// tout autre raison — et l'intégration sentinelle de la section B en fabrique une.
		const jamaisPipelineSain = jamais.filter(
			(c) => c.pipeline.state === 'ok' || c.pipeline.state === 'degraded'
		);
		check(
			'sur un pipeline sain, l’inconnu est imputé au diagnostic (pas à la collecte)',
			jamaisPipelineSain.length > 0 &&
				jamaisPipelineSain.every((c) => /diagnostic/.test(c.signal.reasons[0] ?? '')),
			jamaisPipelineSain.map((c) => `${c.slug}: ${c.signal.reasons[0]}`).join(' · ') ||
				'(aucun projet à pipeline sain jamais diagnostiqué)'
		);
		const partiels = cockpit.projects.filter((c) => c.diagnosis.state === 'partial');
		check(
			'un diagnostic partiel reste DISTINCT de « rien examiné » (pas le même badge)',
			partiels.every((c) => c.state !== 'unknown' && c.state !== 'ok'),
			partiels.map((c) => `${c.slug}:${c.state}`).join(' · ') || '(aucun projet dans ce cas)'
		);

		// ── C. Acceptation : chaque compteur ouvre une liste cohérente ─
		section('C. Chaque compteur ouvre une liste filtrée cohérente');
		let linked = 0;
		let mute = 0;
		for (const c of after.counters) {
			if (!c.href) {
				mute += 1;
				check(`« ${c.label} » sans liste cohérente → aucun lien (assumé)`, true, `${c.count}`);
				continue;
			}
			linked += 1;
			const replayed = await replayCounterHref(c.href);
			check(
				`« ${c.label} » : la liste rend exactement le compteur`,
				replayed === c.count,
				`compteur=${c.count} · liste=${replayed} · ${c.href}`
			);
		}
		check('au moins un compteur cross-projet porte un lien', linked > 0, `${linked} liés, ${mute} muets`);

		// Et les compteurs de la carte du projet en baisse (portée projet).
		for (const c of perfCard.counters) {
			if (!c.href) continue;
			const replayed = await replayCounterHref(c.href);
			check(
				`[${perfCard.slug}] « ${c.label} » : liste cohérente`,
				replayed === c.count,
				`compteur=${c.count} · liste=${replayed}`
			);
		}

		// ── D. Acceptation : priorisation lisible et STABLE ──────────
		section('D. Priorisation : ordre d’urgence, stable d’un appel à l’autre');
		check(
			'le projet en panne passe AVANT le projet en baisse',
			after.projects.findIndex((c) => c.slug === brokenProj.slug) <
				after.projects.findIndex((c) => c.slug === perfProj.slug),
			after.projects.map((c) => `${c.slug}:${c.state}`).join(' → ')
		);
		check(
			'les deux projets sont dans « à traiter »',
			after.needingAction.some((c) => c.slug === brokenProj.slug) &&
				after.needingAction.some((c) => c.slug === perfProj.slug),
			`${after.needingAction.length} à traiter sur ${after.projects.length}`
		);
		check(
			'la santé du portefeuille vaut le PIRE état représenté',
			after.portfolio.worst === 'broken',
			`worst=${after.portfolio.worst}`
		);
		const again = await loadHomeCockpit({ db });
		check(
			'deux lectures consécutives rendent le MÊME ordre (ordre total)',
			JSON.stringify(again.projects.map((c) => c.slug)) ===
				JSON.stringify(after.projects.map((c) => c.slug)),
			again.projects.map((c) => c.slug).join(',')
		);

		// ── E. Le filtre d'activité écarte l'invention ───────────────
		section('E. Un filtre inventé est écarté, jamais transmis');
		const bogusEvent = await replayCounterHref(
			`/inbox?tab=findings&event=bogus&since=${encodeURIComponent(after.sinceDb)}&fstatus=open`
		);
		const openOnly = await countFindings({ statuses: ['open'] }, db);
		check(
			'un `event` hors catalogue rend le filtre INERTE (pas une clause vide qui laisse tout passer)',
			bogusEvent === openOnly,
			`bogus=${bogusEvent} vs open=${openOnly}`
		);
		const bogusSince = await replayCounterHref(
			'/inbox?tab=findings&event=created&since=pas-une-date&fstatus=open'
		);
		check(
			'une borne illisible est ignorée au lieu de partir dans une comparaison',
			bogusSince === openOnly,
			`bogusSince=${bogusSince} vs open=${openOnly}`
		);
		check(
			'la fenêtre demandée est bornée (0 → 1, 9999 → 90)',
			normalizeWindowDays('0') === 1 && normalizeWindowDays('9999') === 90,
			`${normalizeWindowDays('0')} / ${normalizeWindowDays('9999')}`
		);
		// Une fenêtre plus large ne peut pas voir MOINS d'activité qu'une plus étroite.
		const wide = await loadHomeCockpit({ db, windowDays: 90 });
		check(
			'une fenêtre de 90 j ne voit pas moins d’activité que 7 j (monotonie)',
			wide.activity.created >= after.activity.created &&
				wide.activity.aggravated >= after.activity.aggravated,
			`7j: ${after.activity.created}/${after.activity.aggravated} · 90j: ${wide.activity.created}/${wide.activity.aggravated}`
		);
	} finally {
		await cleanup();
	}

	// ── F. Base rendue à l'identique ────────────────────────────────
	section('F. Base rendue à l’identique');
	const post = {
		findings: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`),
		events: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."finding_events"`),
		proposals: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."action_proposals"`),
		integrations: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."project_integrations"`),
		jobs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."jobs"`),
		observations: await scalar(
			sql`SELECT count(*)::int AS n FROM "seostats"."gsc_query_page_observations"`
		)
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
