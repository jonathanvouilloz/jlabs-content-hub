/**
 * IDX-005 — Preuve du détecteur de transitions d'indexation (sur Neon).
 *
 * Le jugement (confirmation, `unknown` neutre, `excluded` non-drop, plafonds, score) est couvert
 * par vitest (`index-transition-state.test.ts`, 42 tests). Ce qui ne peut PAS se prouver en vitest,
 * et se prouve ici, contre la vraie base :
 *
 *   A. acceptation « une transition stable crée un événement unique » : trois runs consécutifs sur
 *      la même désindexation → **1 seul finding**, **1 seul événement `created`**, et
 *      `occurrence_count` qui monte (le problème est le même, il est juste toujours là) ;
 *   B. acceptation « une fluctuation isolée baisse la confiance ou attend confirmation » : une
 *      bascule unique écrit un finding **`pending`**, sévérité **plafonnée** et confiance dégradée ;
 *      la confirmation arrivée, la sévérité monte et l'événement `aggravated` est journalisé ;
 *   C. **LE point du lot** : une URL **non ré-inspectée** n'est **jamais auto-résolue**, même après
 *      N runs. Contre-épreuve incluse — la MÊME scène sans `scope` la résout, ce qui mesure le
 *      faux signal que la garde évite ;
 *   D. acceptation « la résolution conserve l'historique complet » : une page réparée est
 *      auto-résolue après 2 absences CONSTATÉES, puis sa récidive la **rouvre** — et le journal
 *      porte toute la chaîne (`created` → `resolved` → `reopened`) ;
 *   E. §14.3 : une désindexation confirmée d'une page **stratégique** sort `critical` et
 *      **notifiable** ; la même page non stratégique, non ; le canal reste TEL-002 ;
 *   F. `excluded` (noindex du site) et `unknown` (inspection illisible) n'écrivent **aucun**
 *      finding — les deux pièges que la lecture naïve d'un `coverage_state` produirait.
 *
 * Isolation. Dates sentinelles **2018-11-xx**, URLs sur un domaine sentinelle, sous un projet RÉEL
 * (FK). Nettoyage dans un `finally`. Un Ctrl-C SAUTE ce nettoyage : vérifier alors les
 * `observed_date` 2018-11-% de `index_observations`, et les findings/finding_events dont
 * `entity_key` commence par `https://sentinelle-idx005.test` (**enfants d'abord**).
 *
 * Lancer : npx tsx scripts/idx-005-transition-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { runIndexTransitionDetector } from '../src/lib/server/detectors/index-transition.js';
import { reconcileDetectionRun } from '../src/lib/server/findings.js';
import { deriveFindingFingerprint } from '../src/lib/server/finding-state.js';
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

const HOST = 'https://sentinelle-idx005.test';
const SENTINEL_PREFIX = '2018-11-';
/** Toutes les inspections simulées tombent avant cette date : `now` du détecteur. */
const NOW = '2018-11-30';

const INDEXED = 'Submitted and indexed';
const CRAWLED = 'Crawled - currently not indexed';
const DISCOVERED = 'Discovered - currently not indexed';
const NOINDEX = "Excluded by 'noindex' tag";

/** Un jour sentinelle : 1 → 2018-11-01. */
function day(n: number): string {
	return `${SENTINEL_PREFIX}${String(n).padStart(2, '0')}`;
}

// ── Helpers base ────────────────────────────────────────────────────

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(q);
	return Number((res.rows?.[0] as { n: number }).n);
}

/** Pose (ou remplace) l'état d'une URL à une date : l'unique est `(projet, url, date)`. */
async function seedObservation(
	projectId: string,
	url: string,
	dayN: number,
	coverageState: string | null
): Promise<void> {
	await db.execute(sql`
		INSERT INTO "seostats"."index_observations"
			(id, project_id, provider, schema_version, observed_date, url, coverage_state, verdict)
		VALUES (${createId()}, ${projectId}, 'indexing', 1, ${day(dayN)}, ${url},
			${coverageState}, ${coverageState === INDEXED ? 'PASS' : 'NEUTRAL'})
		ON CONFLICT (project_id, url, observed_date)
		DO UPDATE SET coverage_state = EXCLUDED.coverage_state, verdict = EXCLUDED.verdict
	`);
}

/** Efface les observations d'une URL — c'est ainsi qu'on simule « non ré-inspectée ». */
async function forgetObservations(projectId: string, url: string): Promise<void> {
	await db.execute(sql`
		DELETE FROM "seostats"."index_observations"
		 WHERE project_id = ${projectId} AND url = ${url}
	`);
}

interface FindingRow {
	id: string;
	status: string;
	severity: string;
	confidence_score: number;
	occurrence_count: number;
	consecutive_misses: number;
	evidence_json: string | null;
}

async function findingFor(projectId: string, url: string, type: string) {
	const res = await db.execute(sql`
		SELECT id, status, severity, confidence_score, occurrence_count, consecutive_misses, evidence_json
		  FROM "seostats"."findings"
		 WHERE project_id = ${projectId} AND type = ${type} AND entity_key = ${url}
	`);
	return (res.rows?.[0] as unknown as FindingRow | undefined) ?? null;
}

async function eventsFor(findingId: string): Promise<string[]> {
	const res = await db.execute(sql`
		SELECT event_type FROM "seostats"."finding_events"
		 WHERE finding_id = ${findingId} ORDER BY created_at, id
	`);
	return (res.rows ?? []).map((r) => String((r as { event_type: string }).event_type));
}

async function countSentinelFindings(projectId: string): Promise<number> {
	return scalar(sql`
		SELECT count(*)::int AS n FROM "seostats"."findings"
		 WHERE project_id = ${projectId} AND entity_key LIKE ${HOST + '%'}
	`);
}

/** Enfants d'abord : `finding_events` porte une FK vers `findings`. */
async function cleanup(projectId: string): Promise<void> {
	await db.execute(sql`
		DELETE FROM "seostats"."finding_events"
		 WHERE finding_id IN (
			SELECT id FROM "seostats"."findings"
			 WHERE project_id = ${projectId} AND entity_key LIKE ${HOST + '%'}
		 )
	`);
	await db.execute(sql`
		DELETE FROM "seostats"."findings"
		 WHERE project_id = ${projectId} AND entity_key LIKE ${HOST + '%'}
	`);
	await db.execute(sql`
		DELETE FROM "seostats"."index_observations"
		 WHERE project_id = ${projectId}
		   AND (observed_date LIKE ${SENTINEL_PREFIX + '%'} OR url LIKE ${HOST + '%'})
	`);
}

/** Un run du détecteur, toujours à la même date de référence. */
function run(projectId: string, over: { strategicPages?: string[] } = {}) {
	return runIndexTransitionDetector({
		db,
		projectId,
		now: NOW,
		lookbackDays: 365 * 20, // les dates sentinelles sont anciennes : la fenêtre doit les couvrir
		config: {
			// Le contexte GSC réel du projet ne doit pas décider à la place de la preuve : on
			// déclare explicitement ce qui est stratégique, et rien d'autre ne l'est.
			strategicMinClicks: 1_000_000,
			strategicPages: over.strategicPages ?? []
		}
	});
}

// ── Preuve ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const projRes = await db.execute(sql`
		SELECT id, slug FROM "seostats"."projects"
		 WHERE archived = false ORDER BY slug LIMIT 1
	`);
	const proj = projRes.rows?.[0] as { id: string; slug: string } | undefined;
	if (!proj) {
		console.error('Aucun projet actif. Abandon.');
		process.exitCode = 1;
		return;
	}
	console.log(`Projet sentinelle : ${proj.slug} (${proj.id})`);

	const base = {
		findings: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`),
		events: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."finding_events"`),
		indexObs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."index_observations"`)
	};
	console.log(
		`Baseline : ${base.findings} findings · ${base.events} events · ${base.indexObs} index_obs`
	);

	try {
		await cleanup(proj.id);

		// ── A. Une transition STABLE = un seul événement ─────────────
		section('A. Transition stable → 1 finding, 1 seul `created` (acceptation 1)');
		const stable = `${HOST}/stable`;
		await seedObservation(proj.id, stable, 1, INDEXED);
		await seedObservation(proj.id, stable, 8, CRAWLED);
		await seedObservation(proj.id, stable, 15, CRAWLED);

		const r1 = await run(proj.id);
		check('1er run : le finding est créé', r1.counts.created === 1, `created=${r1.counts.created}`);
		const f1 = await findingFor(proj.id, stable, 'index_drop');
		check('type index_drop, statut open', f1?.status === 'open', `statut=${f1?.status}`);
		check('confirmé → severity `high` (page non stratégique)', f1?.severity === 'high', `severity=${f1?.severity}`);

		// Deux runs de plus, sans qu'aucune donnée ne change.
		await run(proj.id);
		const r3 = await run(proj.id);
		const f1b = await findingFor(proj.id, stable, 'index_drop');
		const ev1 = await eventsFor(f1b!.id);
		check(
			'3 runs → toujours UN seul finding',
			(await countSentinelFindings(proj.id)) === 1,
			`findings sentinelles=${await countSentinelFindings(proj.id)}`
		);
		check(
			'UN seul événement au journal, et c’est `created`',
			ev1.length === 1 && ev1[0] === 'created',
			`journal=[${ev1.join(', ')}]`
		);
		check(
			'occurrence_count monte : le problème est le MÊME, toujours là',
			f1b!.occurrence_count === 3,
			`occurrence_count=${f1b!.occurrence_count}`
		);
		check('runs 2 et 3 comptés `refreshed`', r3.counts.refreshed === 1, `refreshed=${r3.counts.refreshed}`);

		// ── B. Fluctuation isolée : attendre, pas crier ──────────────
		section('B. Fluctuation isolée → `pending`, sévérité plafonnée (acceptation 2)');
		const flappy = `${HOST}/flappy`;
		await seedObservation(proj.id, flappy, 1, INDEXED);
		await seedObservation(proj.id, flappy, 8, INDEXED);
		await seedObservation(proj.id, flappy, 15, CRAWLED); // une seule bascule
		const rB1 = await run(proj.id, { strategicPages: [flappy] });
		const fB1 = await findingFor(proj.id, flappy, 'index_drop');
		const detB1 = rB1.transitions.find((t) => t.url === flappy)!;
		check('le fait est ÉCRIT (on ne le cache pas)', fB1 !== null);
		check('mais NON confirmé', detB1.status === 'pending', `status=${detB1.status}`);
		check(
			'sévérité PLAFONNÉE à medium malgré une page stratégique',
			fB1?.severity === 'medium',
			`severity=${fB1?.severity}`
		);
		check(
			'jamais notifiable tant que non confirmé (§14.3)',
			detB1.notifyImmediately === false && rB1.notifiable === 0,
			`notifiable=${rB1.notifiable}`
		);
		const confB1 = fB1!.confidence_score;

		// La confirmation arrive : le même finding monte, et l'aggravation est journalisée.
		await seedObservation(proj.id, flappy, 22, CRAWLED);
		const rB2 = await run(proj.id, { strategicPages: [flappy] });
		const fB2 = await findingFor(proj.id, flappy, 'index_drop');
		const evB = await eventsFor(fB2!.id);
		check(
			'confirmé → la sévérité monte à critical (drop + stratégique)',
			fB2?.severity === 'critical',
			`severity=${fB2?.severity}`
		);
		check(
			'la confiance monte avec la confirmation',
			fB2!.confidence_score > confB1,
			`${confB1} → ${fB2!.confidence_score}`
		);
		check(
			'l’aggravation est journalisée — et le finding reste le MÊME',
			evB.join(',') === 'created,aggravated' && fB2!.id === fB1!.id,
			`journal=[${evB.join(', ')}]`
		);
		check(
			'devenu notifiable §14.3 (le SIGNAL ; le canal reste TEL-002)',
			rB2.notifiable === 1 && JSON.parse(fB2!.evidence_json!).notifyImmediately === true,
			`notifiable=${rB2.notifiable}`
		);

		// ── C. Hors portée : une URL non ré-inspectée n'est PAS guérie ─
		section('C. Une URL NON ré-inspectée n’est jamais auto-résolue (le `scope`)');
		// `stable` a toujours son finding `open`. On efface ses observations : le détecteur ne
		// « voit » plus cette page — exactement ce qui arrive quand IDX-004 ne l'a pas sélectionnée.
		await forgetObservations(proj.id, stable);
		const rC1 = await run(proj.id);
		const rC2 = await run(proj.id);
		const fC = await findingFor(proj.id, stable, 'index_drop');
		check(
			'après 2 runs sans inspection : le finding est INTACT',
			fC?.status === 'open',
			`statut=${fC?.status}`
		);
		check(
			'`consecutive_misses` n’a même pas bougé : un manque de mesure n’est pas une absence',
			fC?.consecutive_misses === 0,
			`consecutive_misses=${fC?.consecutive_misses}`
		);
		check(
			'le run le DIT (`outOfScope`), il ne se tait pas',
			rC1.lifecycle.outOfScope >= 1 && rC2.lifecycle.outOfScope >= 1,
			`outOfScope=${rC1.lifecycle.outOfScope}/${rC2.lifecycle.outOfScope}`
		);

		// Contre-épreuve : la MÊME scène sans `scope` auto-résout. C'est le faux signal évité.
		section('C-bis. Contre-épreuve : sans `scope`, la même scène résout à tort');
		const beforeStatus = fC!.status;
		for (let i = 0; i < 2; i += 1) {
			await reconcileDetectionRun(
				{
					projectId: proj.id,
					type: 'index_drop',
					closure: new Set<string>(), // rien vu ce tour-ci
					// scope ABSENT : le run se croit autoritaire sur tout le projet.
					detectorVersion: 'contre-epreuve@0'
				},
				db
			);
		}
		const fCbis = await findingFor(proj.id, stable, 'index_drop');
		check(
			'sans la garde, une page jamais ré-inspectée passe `resolved` — le faux signal MESURÉ',
			beforeStatus === 'open' && fCbis?.status === 'resolved',
			`${beforeStatus} → ${fCbis?.status}`
		);

		// ── D. Résolution sur absence CONSTATÉE ─────────────────────
		section('D. Une page RÉPARÉE se résout — mais seulement après 2 absences CONSTATÉES');
		// La différence avec C est entière : ici la page EST ré-inspectée, et ce qu'on voit est
		// qu'elle va bien. C'est une absence de signal, pas une absence de mesure.
		const repaired = `${HOST}/reparee`;
		await seedObservation(proj.id, repaired, 1, INDEXED);
		await seedObservation(proj.id, repaired, 8, CRAWLED);
		await seedObservation(proj.id, repaired, 15, CRAWLED);
		await run(proj.id);
		check(
			'le problème existe d’abord',
			(await findingFor(proj.id, repaired, 'index_drop'))?.status === 'open'
		);

		await seedObservation(proj.id, repaired, 22, INDEXED);
		await seedObservation(proj.id, repaired, 23, INDEXED);
		const rD1 = await run(proj.id);
		const fD1 = await findingFor(proj.id, repaired, 'index_drop');
		check(
			'1re absence constatée : COMPTÉE, jamais résolue d’un coup',
			fD1?.status === 'open' && fD1?.consecutive_misses === 1,
			`statut=${fD1?.status}, misses=${fD1?.consecutive_misses}`
		);
		check('le run le dit (`missed`)', rD1.lifecycle.missed === 1, `missed=${rD1.lifecycle.missed}`);

		const rD2 = await run(proj.id);
		const fD2r = await findingFor(proj.id, repaired, 'index_drop');
		check(
			'2e absence constatée → auto-résolu (seuil FIND-003)',
			fD2r?.status === 'resolved' && rD2.lifecycle.autoResolved === 1,
			`statut=${fD2r?.status}, autoResolved=${rD2.lifecycle.autoResolved}`
		);
		const evD1 = await eventsFor(fD2r!.id);
		check(
			'la résolution est journalisée, elle ne se devine pas',
			evD1.join(',') === 'created,resolved',
			`journal=[${evD1.join(', ')}]`
		);

		// ── D-bis. Récidive → réouverture, historique intact ─────────
		section('D-bis. Récidive → réouverture du MÊME finding, historique complet (acceptation 3)');
		// La page réparée retombe — et de façon confirmée. Son historique porte toujours l'état
		// indexé, donc c'est bien le MÊME problème qui revient, pas un autre.
		await seedObservation(proj.id, repaired, 24, CRAWLED);
		await seedObservation(proj.id, repaired, 25, CRAWLED);
		await run(proj.id);
		const fD2 = await findingFor(proj.id, repaired, 'index_drop');
		const evD = await eventsFor(fD2!.id);
		check(
			'la récidive ROUVRE le finding d’origine (pas un nouveau)',
			fD2?.status === 'reopened' && fD2!.id === fD2r!.id,
			`statut=${fD2?.status}`
		);
		check(
			'le journal porte toute la chaîne : created → resolved → reopened',
			evD.includes('created') && evD.includes('resolved') && evD.includes('reopened'),
			`journal=[${evD.join(', ')}]`
		);
		check(
			'l’historique complet est conservé (aucun événement effacé)',
			evD.length >= 3,
			`${evD.length} événements`
		);

		// ── E. Les autres types, et les deux silences ────────────────
		section('E. Les deux autres types §10.4 naissent bien, chacun le sien');
		const never = `${HOST}/jamais-indexee`;
		await seedObservation(proj.id, never, 8, DISCOVERED);
		await seedObservation(proj.id, never, 15, DISCOVERED);
		await run(proj.id);
		check(
			'jamais indexée + découverte → `discovered_not_indexed`, pas `index_drop`',
			(await findingFor(proj.id, never, 'discovered_not_indexed')) !== null &&
				(await findingFor(proj.id, never, 'index_drop')) === null
		);

		section('F. Les deux silences : `excluded` et `unknown` n’écrivent RIEN');
		const noindex = `${HOST}/noindex`;
		await seedObservation(proj.id, noindex, 8, INDEXED);
		await seedObservation(proj.id, noindex, 15, NOINDEX);
		await seedObservation(proj.id, noindex, 22, NOINDEX);
		const illisible = `${HOST}/illisible`;
		await seedObservation(proj.id, illisible, 8, null);
		await seedObservation(proj.id, illisible, 15, null);
		await run(proj.id);
		check(
			'`indexed → noindex` : décision du site, respectée, aucun finding',
			(await findingFor(proj.id, noindex, 'index_drop')) === null
		);
		check(
			'inspection illisible : ne pas savoir n’est pas « non indexé », aucun finding',
			(await findingFor(proj.id, illisible, 'index_drop')) === null &&
				(await findingFor(proj.id, illisible, 'crawled_not_indexed')) === null
		);

		// ── G. Le fingerprint ne dépend d'aucune valeur mouvante ─────
		section('G. Le fingerprint est STABLE : c’est ce qui rend l’acceptation 1 vraie');
		const fp = deriveFindingFingerprint({
			type: 'index_drop',
			entityType: 'page',
			entityKey: repaired
		});
		const fpRow = await db.execute(sql`
			SELECT fingerprint FROM "seostats"."findings" WHERE id = ${fD2!.id}
		`);
		check(
			'le fingerprint persisté = (type, page, url), rien d’autre',
			String((fpRow.rows?.[0] as { fingerprint: string }).fingerprint) === fp
		);
	} finally {
		await cleanup(proj.id);
		const after = {
			findings: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`),
			events: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."finding_events"`),
			indexObs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."index_observations"`)
		};
		section('Nettoyage — la base doit être rendue à l’identique');
		check(
			'findings',
			after.findings === base.findings,
			`${base.findings} → ${after.findings}`
		);
		check('finding_events', after.events === base.events, `${base.events} → ${after.events}`);
		check(
			'index_observations',
			after.indexObs === base.indexObs,
			`${base.indexObs} → ${after.indexObs}`
		);
		console.log('');
		console.log(failures === 0 ? '✅ Toutes les vérifications passent.' : `❌ ${failures} échec(s).`);
		await pool.end();
		if (failures > 0) process.exitCode = 1;
	}
}

main().catch(async (err) => {
	console.error('Preuve IDX-005 échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
