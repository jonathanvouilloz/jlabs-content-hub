/**
 * DASH-003 lot 2 — Preuve : la pause entre dans la SANTÉ (sur Neon).
 *
 * Ce que vitest couvre déjà (`home-state.test.ts`, 29 tests neufs) : l'ordre des règles,
 * la dérivation par détecteur, le badge, le rang. Sans base ni horloge.
 *
 * Ce qui ne peut PAS s'y prouver, et se prouve ici :
 *
 *   A. l'état de référence d'un projet AVANT toute pause, lu par le vrai `loadHomeCockpit` ;
 *   B. une pause de PROJET rend le badge `paused` et un pipeline `unknown` — sur la vraie
 *      requête `DISTINCT ON` d'`automation_pauses`, pas sur une Map fabriquée ;
 *   C. la doctrine assertée frontalement : ni `ok` (ce n'est pas sain) ni `broken` (ce n'est
 *      pas une panne) ;
 *   D. **CONTRE-ÉPREUVE** — la reprise rend une carte IDENTIQUE à A, champ par champ. Aucun
 *      état dérivé n'a été stocké en chemin ;
 *   E. **CONTRE-ÉPREUVE** — une pause sur une cadence NON CÂBLÉE (`monthly`) rend une carte
 *      identique à A. Une décision sans effet ne colore rien ;
 *   F. **CONTRE-ÉPREUVE** — une échéance `until` dépassée rend la carte de A, et le nombre de
 *      lignes du journal est INCHANGÉ entre les deux lectures : l'expiration est dérivée ;
 *   G. **NON-RÉGRESSION STRUCTURELLE** — `JSON.stringify(carte accueil) === JSON.stringify(
 *      carte cockpit projet)` PAUSE ACTIVE. L'invariant anti-divergence de DASH-003 lot 1
 *      tient sous le nouveau champ ;
 *   H. l'ordre des règles contre la vraie base : une intégration `revoked` SOUS pause reste
 *      `broken`. Une pause ne répare pas un credential ;
 *   I. le portefeuille compte le suspendu à part et ne vire pas au rouge à cause de lui ;
 *   J. la base est rendue à l'identique (comptée avant/après).
 *
 * Isolation. Projet sentinelle, dispositif repris à l'identique de `dash-006-pause-proof.ts` :
 * le slug est EMPRUNTÉ à `core.entities` (registre canonique possédé par `invoices`, jamais
 * modifié depuis ici — loi n°3) parmi ceux sans projet SEO. Garde : si un projet réel porte
 * déjà ce slug, la preuve S'ARRÊTE. Le nettoyage ne supprime que la ligne créée ici, PAR SON
 * ID, jamais par son slug. Aucune pause n'est posée sur un projet réel : une pause oubliée
 * est un monitoring muet, exactement ce que ce lot combat.
 *
 * ⚠️ Aucune pause PROVIDER ici (contrairement à DASH-006 §C) : elle serait globale, donc
 * visible par les six projets réels le temps de la preuve. Ce chemin est couvert par vitest.
 *
 * Un Ctrl-C saute le `finally` : chercher alors le projet « PREUVE DASH-003 — à supprimer »
 * et les `automation_pauses` d'`actor = 'system:proof-dash003'`.
 *
 * Lancer : npx tsx scripts/dash-003-pause-health-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { recordPauseDecision } from '../src/lib/server/pauses.js';
import { loadHomeCockpit } from '../src/lib/server/home.js';
import { loadProjectCockpit } from '../src/lib/server/project-cockpit.js';
import type { ProjectCard } from '../src/lib/server/home-state.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';
import { createId } from '../src/lib/server/utils.js';
import { SCHEDULE_CATALOG } from '../src/lib/server/schedule-state.js';

/** Les détecteurs ATTENDUS par le cockpit, dérivés du catalogue (jamais recopiés). */
const DETECTORS_EXPECTED = [
	...new Set(
		Object.values(SCHEDULE_CATALOG)
			.flat()
			.map((e) => e.jobType)
			.filter((t) => t.startsWith('detect:'))
	)
];

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

const SENTINEL_NAME = 'PREUVE DASH-003 — à supprimer';
const ACTOR = 'system:proof-dash003';

let SENTINEL_SLUG = '';
let SENTINEL_ID = '';

/** L'instant de LECTURE, figé : deux lectures à des instants différents ne se comparent pas. */
const NOW = new Date();
/** Lecture « plus tard », pour voir expirer une pause sans qu'aucune ligne ne bouge (§F). */
const LATER = new Date(NOW.getTime() + 3_600_000);

async function cleanup(): Promise<void> {
	await db.execute(sql`DELETE FROM "seostats"."automation_pauses" WHERE actor = ${ACTOR}`);
	if (!SENTINEL_ID) return;
	await db.execute(sql`DELETE FROM "seostats"."jobs" WHERE project_id = ${SENTINEL_ID}`);
	await db.execute(
		sql`DELETE FROM "seostats"."project_integrations" WHERE project_id = ${SENTINEL_ID}`
	);
	await db.execute(sql`DELETE FROM "seostats"."automation_pauses" WHERE project_id = ${SENTINEL_ID}`);
	await db.execute(sql`DELETE FROM "seostats"."projects" WHERE id = ${SENTINEL_ID}`);
}

async function countRows(table: string): Promise<number> {
	const res = await db.execute(sql`SELECT count(*)::int AS n FROM "seostats".${sql.raw(`"${table}"`)}`);
	return Number((res.rows?.[0] as { n: number } | undefined)?.n ?? 0);
}

/** La carte du sentinelle, telle que l'ACCUEIL la calcule. `null` si le projet a disparu. */
async function sentinelCard(now: Date = NOW): Promise<ProjectCard | null> {
	const home = await loadHomeCockpit({ db, now });
	return home.projects.find((p) => p.projectId === SENTINEL_ID) ?? null;
}

/**
 * Horodatage de décision, strictement croissant.
 *
 * ⚠️ Nécessaire, et pas cosmétique. `automation_pauses.created_at` est à la SECONDE, et
 * `loadPauseStates` départage les ex æquo par `id DESC` — un ordre reproductible, pas juste
 * (c'est écrit dans `pauses.ts`). Un script qui pose une pause puis sa reprise en moins d'une
 * seconde tire donc son verdict à pile ou face : la première version de cette preuve échouait
 * en §D une fois sur deux, en accusant le code d'un défaut qui n'existe pas. On injecte donc
 * des instants distincts — `recordPauseDecision` accepte `now` exactement pour ça.
 */
let step = 0;
const stamp = () => new Date(NOW.getTime() + ++step * 1000);

/** Pose une décision de pause et rend la carte qui en résulte. */
async function pauseThen(
	target: Parameters<typeof recordPauseDecision>[0]['target'],
	eventType: 'paused' | 'resumed',
	reason: string,
	until: string | null = null,
	now: Date = NOW
): Promise<ProjectCard | null> {
	await recordPauseDecision({ db, target, eventType, reason, actor: ACTOR, until, now: stamp() });
	return sentinelCard(now);
}

async function main(): Promise<void> {
	console.log(`DASH-003 lot 2 — preuve « la pause entre dans la santé » · ${NOW.toISOString()}`);

	const baseline = {
		pauses: await countRows('automation_pauses'),
		projects: await countRows('projects'),
		integrations: await countRows('project_integrations'),
		jobs: await countRows('jobs')
	};

	await db.execute(sql`DELETE FROM "seostats"."automation_pauses" WHERE actor = ${ACTOR}`);
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
				'   écrire des pauses sur un projet réel modifierait sa planification de production.'
		);
		failures += 1;
		return;
	}
	console.log(`  (projet sentinelle sur le slug libre « ${SENTINEL_SLUG} »)`);

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
	const projectId = SENTINEL_ID;

	// Une collecte GSC FRAÎCHE et deux détecteurs passés : sans ça, la carte de référence
	// serait déjà `unknown` (signal absent), et §C ne prouverait plus rien — « ce n'est pas
	// `ok` » serait vrai avant même la pause.
	const fresh = toDbTimestamp(new Date(NOW.getTime() - 3_600_000));
	await db.execute(sql`
		INSERT INTO "seostats"."project_integrations"
		       (id, project_id, provider, enabled, status, health_status, last_success_at, created_at, updated_at)
		VALUES (${createId()}, ${projectId}, 'gsc', true, 'active', 'healthy', ${fresh}, ${fresh}, ${fresh})
	`);
	// ⚠️ La liste est DÉRIVÉE du catalogue, jamais recopiée : un détecteur ajouté
	// (FIND-005 `detect:keyword_decline`) n'a par construction jamais tourné nulle
	// part, donc la couverture du projet sentinelle tomberait à `partial` et la carte
	// de référence ne serait plus `ok` — la preuve échouerait en accusant le code d'un
	// défaut qui n'existe pas. C'est arrivé exactement une fois ; d'où cette dérivation.
	for (const type of DETECTORS_EXPECTED) {
		await db.execute(sql`
			INSERT INTO "seostats"."jobs"
			       (id, project_id, type, status, idempotency_key, priority, created_at, updated_at, finished_at)
			VALUES (${createId()}, ${projectId}, ${type}, 'succeeded',
			        ${`proof-dash003:${type}`}, 5, ${fresh}, ${fresh}, ${fresh})
		`);
	}

	// ── A. L'état de référence ───────────────────────────────────────
	section('A. La carte de référence, AVANT toute pause');

	const cardA = await sentinelCard();
	const A = JSON.stringify(cardA);
	check('le projet sentinelle est bien lu par l’accueil', cardA !== null);
	check(
		'sans pause, il est SAIN (sinon §C ne prouverait rien)',
		cardA?.state === 'ok',
		`state = ${cardA?.state} · pipeline = ${cardA?.pipeline.state} · signal = ${cardA?.signal.state}`
	);
	check('…et ne porte aucune pause', cardA?.pause === null);

	// ── B/C. La pause devient visible, et ne se confond avec rien ────
	section('B/C. Un gel projet : badge `paused`, pipeline `unknown`, ni sain ni cassé');

	const REASON = 'preuve DASH-003 — client en pause de contrat';
	const cardB = await pauseThen({ scope: 'project', projectId }, 'paused', REASON);
	check('le badge devient `paused`', cardB?.state === 'paused', `state = ${cardB?.state}`);
	check(
		'le pipeline devient `unknown` : plus rien n’arrive',
		cardB?.pipeline.state === 'unknown',
		`${cardB?.pipeline.reasons[0] ?? '—'}`
	);
	check('la phrase nomme la RAISON', (cardB?.headline ?? '').includes(REASON));
	check('…et son AUTEUR', (cardB?.headline ?? '').includes(ACTOR));
	check(
		'la portée nommée est celle qu’il faudra lever',
		cardB?.pause?.scope === 'project' && cardB?.pause?.full === true,
		`scope = ${cardB?.pause?.scope} · full = ${cardB?.pause?.full}`
	);
	check(
		'⭐ ni `ok` ni `broken` : une décision n’est ni un bon état, ni une panne',
		cardB?.state !== 'ok' && cardB?.state !== 'broken'
	);
	check(
		'le diagnostic est dit SUSPENDU, pas absent',
		(cardB?.diagnosis.suspended.length ?? 0) > 0 && cardB?.diagnosis.state === 'full',
		`suspended = [${cardB?.diagnosis.suspended.join(', ')}] · state = ${cardB?.diagnosis.state}`
	);
	check(
		'le retard de collecte n’est PAS reproché',
		!(cardB?.pipeline.reasons ?? []).some((r) => r.includes('en retard'))
	);

	// ── G. L'invariant anti-divergence, PAUSE ACTIVE ─────────────────
	section('G. La carte du cockpit projet est la MÊME que celle de l’accueil (pause active)');

	const cockpit = await loadProjectCockpit({ db, projectSlug: SENTINEL_SLUG, now: NOW });
	check(
		'égalité champ par champ (JSON.stringify)',
		JSON.stringify(cockpit?.card) === JSON.stringify(cardB),
		cockpit?.card ? 'identiques' : 'carte du cockpit absente'
	);
	check(
		'…et la pause y est portée sans être recalculée',
		cockpit?.card?.pause?.reason === REASON
	);

	// ── I. Le portefeuille ───────────────────────────────────────────
	section('I. Le portefeuille compte le suspendu à part, et ne rougit pas à cause de lui');

	const home = await loadHomeCockpit({ db, now: NOW });
	check('un projet suspendu est compté comme tel', home.portfolio.byState.paused === 1, `${home.portfolio.byState.paused}`);
	check(
		'il n’entre pas dans « à traiter »',
		!home.needingAction.some((p) => p.projectId === SENTINEL_ID)
	);
	check(
		'le pire état du parc n’est pas devenu `paused` (les autres projets décident)',
		home.portfolio.worst !== 'paused' || home.portfolio.total === 1,
		`worst = ${home.portfolio.worst} sur ${home.portfolio.total} projets`
	);

	// ── H. L'ordre des règles : une pause ne répare rien ─────────────
	section('H. Une intégration révoquée SOUS pause reste `broken`');

	await db.execute(sql`
		UPDATE "seostats"."project_integrations"
		   SET status = 'revoked', last_error_code = 'invalid_grant'
		 WHERE project_id = ${projectId}
	`);
	const cardH = await sentinelCard();
	check(
		'le badge redevient `broken` : le jour où on reprend, la panne est encore là',
		cardH?.state === 'broken',
		`state = ${cardH?.state} · pipeline = ${cardH?.pipeline.state}`
	);
	check('…et la pause reste lisible à côté', cardH?.pause?.full === true);
	await db.execute(sql`
		UPDATE "seostats"."project_integrations"
		   SET status = 'active', last_error_code = NULL
		 WHERE project_id = ${projectId}
	`);

	// ── D. CONTRE-ÉPREUVE : la reprise rend la carte de A ────────────
	section('D. CONTRE-ÉPREUVE — la reprise rend une carte IDENTIQUE à A');

	const cardD = await pauseThen({ scope: 'project', projectId }, 'resumed', 'preuve — reprise');
	check(
		'⭐ carte identique champ par champ : aucun état dérivé n’a été stocké',
		JSON.stringify(cardD) === A,
		cardD?.state === cardA?.state ? '' : `state ${cardA?.state} → ${cardD?.state}`
	);

	// ── E. CONTRE-ÉPREUVE : une décision sans effet ne colore rien ───
	section('E. CONTRE-ÉPREUVE — suspendre une cadence NON CÂBLÉE ne change rien');

	const cardE = await pauseThen(
		{ scope: 'project_cadence', projectId, cadence: 'monthly' },
		'paused',
		'preuve — cadence au catalogue vide'
	);
	check(
		'⭐ carte identique à A : `monthly` n’enfile rien, la suspendre n’arrête rien',
		JSON.stringify(cardE) === A,
		`state = ${cardE?.state}`
	);
	await recordPauseDecision({
		db,
		target: { scope: 'project_cadence', projectId, cadence: 'monthly' },
		eventType: 'resumed',
		reason: 'preuve — nettoyage E',
		actor: ACTOR,
		now: stamp()
	});

	// ── F. CONTRE-ÉPREUVE : l'expiration est DÉRIVÉE ─────────────────
	section('F. CONTRE-ÉPREUVE — une échéance passée lève la pause SANS écrire une ligne');

	// La référence est prise AVANT de poser la pause, et au MÊME instant que la relecture :
	// comparer une lecture décalée d'une heure à la carte A échouerait sur la seule fraîcheur,
	// et ferait échouer une assertion parfaitement vraie.
	const referenceLater = JSON.stringify(await sentinelCard(LATER));

	const until = toDbTimestamp(new Date(NOW.getTime() + 120_000));
	const cardFactive = await pauseThen(
		{ scope: 'project', projectId },
		'paused',
		'preuve — pause à terme',
		until
	);
	check('avant l’échéance, la pause est active', cardFactive?.state === 'paused');

	const journalBefore = await countRows('automation_pauses');
	const cardFexpired = await sentinelCard(LATER);
	const journalAfter = await countRows('automation_pauses');
	check(
		'⭐ après l’échéance, la carte est celle d’avant la pause',
		JSON.stringify(cardFexpired) === referenceLater,
		`state = ${cardFexpired?.state}`
	);
	check(
		'⭐ …et AUCUNE ligne n’a bougé : l’expiration se dérive, elle ne s’écrit pas',
		journalAfter === journalBefore,
		`${journalBefore} → ${journalAfter}`
	);

	// ── J. La base est rendue à l'identique ──────────────────────────
	section('J. La base est rendue à l’identique');

	await cleanup();
	SENTINEL_ID = '';
	const after = {
		pauses: await countRows('automation_pauses'),
		projects: await countRows('projects'),
		integrations: await countRows('project_integrations'),
		jobs: await countRows('jobs')
	};
	for (const key of Object.keys(baseline) as (keyof typeof baseline)[]) {
		check(`${key} : ${baseline[key]} → ${after[key]}`, baseline[key] === after[key]);
	}
}

main()
	.catch((err) => {
		console.error('\n❌ Exception :', err instanceof Error ? err.stack : err);
		failures += 1;
	})
	.finally(async () => {
		await cleanup().catch((err) => console.error('nettoyage :', err));
		console.log('');
		console.log(failures === 0 ? '✅ Toutes les assertions sont vertes.' : `❌ ${failures} assertion(s) en échec.`);
		await pool.end();
		process.exit(failures === 0 ? 0 : 1);
	});
