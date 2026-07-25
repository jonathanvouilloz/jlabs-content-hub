/**
 * IDX-004 — Preuve de la politique de sélection d'inspection (sur Neon).
 *
 * Le jugement (plafond d'échantillon, ordre des familles, déduplication, échéances) est
 * couvert par vitest (`index-selection-state.test.ts`, 59 tests). Ce qui ne peut PAS se
 * prouver en vitest, et se prouve ici, contre la vraie base :
 *
 *   A. acceptation « le quota ne peut pas être consommé entièrement par l'échantillon » :
 *      vérifiée EN SQL sur `index_selection.bucket`, pas sur la valeur de retour du module ;
 *   B. acceptation « chaque sélection expose sa raison » : chaque ligne écrite porte une
 *      raison du vocabulaire fermé ET le détail qui la prouve ;
 *   C. **LE point du lot** — acceptation « une inspection manquée est replanifiée sans
 *      duplication » : une collecte interrompue laisse ses intentions non honorées, le run
 *      suivant reprend EXACTEMENT celles-là, et `count(*)` ne bouge pas. Contre-épreuve
 *      incluse (C-bis) : sans la persistance AVANT collecte, la même scène ne replanifie
 *      RIEN — ce qui mesure le quota qu'on perdrait ;
 *   D. sémantique J+N : une observation à J+4 n'honore pas une échéance J+7 ;
 *   E. réserve urgente cross-projet : à pool presque plein, `full` obtient 0 et `due` non ;
 *   F. abandon borné : une échéance trop vieille est écartée ET comptée ;
 *   G. non-régression IDX-002 : le mode `explicit` n'écrit aucune ligne de sélection ;
 *   H. la forme envoyée à Google est la forme NORMALISÉE, donc une seule série par page.
 *
 * ZÉRO appel Google : la sélection est entièrement en base. Aucun quota n'est consommé.
 *
 * Isolation. Dates sentinelles **2018-11-xx**, URLs sur `https://sentinelle-idx004.test`,
 * sous un projet RÉEL (contrainte FK). Le réglage `indexing.selection` est sauvegardé puis
 * RESTAURÉ à l'identique (supprimé s'il n'existait pas). Nettoyage dans un `finally`.
 * Un Ctrl-C SAUTE ce nettoyage : vérifier alors les `observed_date` / `due_date` **2018-11-%**
 * de `index_selection`, `index_observations` et `sitemap_url_observations`, les
 * findings/`finding_events` dont `entity_key` commence par `https://sentinelle-idx004.test`
 * (**enfants d'abord**), et la clé `indexing.selection` de `system_settings`.
 *
 * Lancer : npx tsx scripts/idx-004-selection-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { createId } from '../src/lib/server/utils.js';
import { upsertFinding } from '../src/lib/server/findings.js';
import {
	SELECTION_SETTINGS_KEY,
	loadDueSelections,
	planInspectionSelection,
	saveSelectionSettings
} from '../src/lib/server/collectors/index-selection.js';
import { defaultHandlers } from '../src/lib/server/job-runner.js';

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

const HOST = 'https://sentinelle-idx004.test';
const SENTINEL_PREFIX = '2018-11-';
/** Le « aujourd'hui » de toutes les sélections. */
const TODAY = '2018-11-30';
const NOW = new Date(`${TODAY}T12:00:00Z`);
const INDEXED = 'Submitted and indexed';

/** Réglages déterministes de la preuve — petits, pour que les plafonds mordent visiblement. */
const PROOF_CONFIG = {
	dailyPoolTotal: 500,
	poolUrgentReserve: 100,
	dailyBudgetPerProject: 40,
	samplePctMax: 40,
	sampleIntervalDays: 14,
	maxAgeDays: 14,
	jobCap: 200
};

/** Un jour sentinelle : 1 → 2018-11-01. */
function day(n: number): string {
	return `${SENTINEL_PREFIX}${String(n).padStart(2, '0')}`;
}

// ── Helpers base ────────────────────────────────────────────────────

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(q);
	return Number((res.rows?.[0] as { n: number }).n);
}

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
	const res = await db.execute(q);
	return (res.rows ?? []) as unknown as T[];
}

/** Pose N URLs dans l'inventaire sitemap d'une date. */
async function seedInventory(
	projectId: string,
	dayN: number,
	entries: { path: string; lastmod?: string | null; isAlternate?: boolean }[]
): Promise<void> {
	if (entries.length === 0) return;
	await db
		.insert(schema.sitemapUrlObservations)
		.values(
			entries.map((e) => ({
				id: createId(),
				projectId,
				provider: 'gsc',
				schemaVersion: 1,
				observedDate: day(dayN),
				sitemapUrl: `${HOST}/sitemap.xml`,
				url: `${HOST}${e.path}`,
				urlNormalized: `${HOST}${e.path}`,
				lastmod: e.lastmod ?? null,
				locale: null,
				expectedCanonical: `${HOST}${e.path}`,
				isAlternate: e.isAlternate ?? false
			}))
		)
		.onConflictDoNothing();
}

/** Pose une observation d'indexation (c'est ce qui HONORE une échéance). */
async function seedObservation(projectId: string, url: string, dayN: number): Promise<void> {
	await db.execute(sql`
		INSERT INTO "seostats"."index_observations"
			(id, project_id, provider, schema_version, observed_date, url, coverage_state, verdict)
		VALUES (${createId()}, ${projectId}, 'indexing', 1, ${day(dayN)}, ${url}, ${INDEXED}, 'PASS')
		ON CONFLICT (project_id, url, observed_date) DO NOTHING
	`);
}

async function countSelections(projectId: string): Promise<number> {
	return scalar(sql`
		SELECT count(*)::int AS n FROM "seostats"."index_selection"
		 WHERE project_id = ${projectId} AND url_normalized LIKE ${HOST + '%'}
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
		DELETE FROM "seostats"."index_selection"
		 WHERE project_id = ${projectId}
		   AND (url_normalized LIKE ${HOST + '%'} OR due_date LIKE ${SENTINEL_PREFIX + '%'})
	`);
	await db.execute(sql`
		DELETE FROM "seostats"."index_observations"
		 WHERE project_id = ${projectId}
		   AND (observed_date LIKE ${SENTINEL_PREFIX + '%'} OR url LIKE ${HOST + '%'})
	`);
	await db.execute(sql`
		DELETE FROM "seostats"."sitemap_url_observations"
		 WHERE project_id = ${projectId}
		   AND (observed_date LIKE ${SENTINEL_PREFIX + '%'} OR url LIKE ${HOST + '%'})
	`);
}

async function plan(projectId: string, scope: 'due' | 'full', over: { dryRun?: boolean } = {}) {
	return planInspectionSelection({
		db,
		projectId,
		now: NOW,
		scope,
		dryRun: over.dryRun,
		runId: null
	});
}

// ── Sauvegarde / restauration du réglage système ────────────────────

let previousSetting: string | null | undefined;

async function saveSettingSnapshot(): Promise<void> {
	const found = await rows<{ value: string }>(sql`
		SELECT value FROM "seostats"."system_settings" WHERE key = ${SELECTION_SETTINGS_KEY}
	`);
	previousSetting = found[0]?.value ?? null;
}

async function restoreSetting(): Promise<void> {
	if (previousSetting === undefined) return;
	if (previousSetting === null) {
		await db.execute(sql`
			DELETE FROM "seostats"."system_settings" WHERE key = ${SELECTION_SETTINGS_KEY}
		`);
		return;
	}
	await db.execute(sql`
		UPDATE "seostats"."system_settings" SET value = ${previousSetting}
		 WHERE key = ${SELECTION_SETTINGS_KEY}
	`);
}

// ── La preuve ───────────────────────────────────────────────────────

async function main(): Promise<void> {
	const projRes = await rows<{ id: string; slug: string }>(sql`
		SELECT id, slug FROM "seostats"."projects" WHERE archived = false ORDER BY slug LIMIT 1
	`);
	const proj = projRes[0];
	if (!proj) {
		console.error('Aucun projet actif. Abandon.');
		process.exitCode = 1;
		return;
	}
	console.log(`Projet sentinelle : ${proj.slug} (${proj.id})`);
	console.log(
		`Réglages de la preuve : pool ${PROOF_CONFIG.dailyPoolTotal} (réserve ${PROOF_CONFIG.poolUrgentReserve}) · ` +
			`budget projet ${PROOF_CONFIG.dailyBudgetPerProject} · échantillon ≤ ${PROOF_CONFIG.samplePctMax} %`
	);

	const base = {
		selections: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."index_selection"`),
		indexObs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."index_observations"`),
		sitemapObs: await scalar(
			sql`SELECT count(*)::int AS n FROM "seostats"."sitemap_url_observations"`
		),
		findings: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`),
		events: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."finding_events"`),
		settings: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."system_settings"`)
	};
	console.log(
		`Baseline : ${base.selections} sélections · ${base.indexObs} index_obs · ${base.sitemapObs} sitemap_obs · ` +
			`${base.findings} findings · ${base.events} events · ${base.settings} réglages`
	);

	await saveSettingSnapshot();

	try {
		await cleanup(proj.id);
		await saveSelectionSettings({ db, config: PROOF_CONFIG, now: NOW });

		// ── A ───────────────────────────────────────────────────────
		section('A. ACCEPTATION 1 — l’échantillon ne peut pas manger le quota (vérifié EN SQL)');
		// 200 pages jamais inspectées : autant de candidats `sample`, et rien d'autre.
		await seedInventory(
			proj.id,
			25,
			Array.from({ length: 200 }, (_, i) => ({ path: `/s/${String(i).padStart(3, '0')}` }))
		);
		const pA = await plan(proj.id, 'full');
		const bucketsA = await rows<{ bucket: string; n: number }>(sql`
			SELECT bucket, count(*)::int AS n FROM "seostats"."index_selection"
			 WHERE project_id = ${proj.id} AND url_normalized LIKE ${HOST + '%'}
			 GROUP BY bucket ORDER BY bucket
		`);
		const sampleRows = bucketsA.find((b) => b.bucket === 'sample')?.n ?? 0;
		const expectedCap = Math.floor(
			(PROOF_CONFIG.dailyBudgetPerProject * PROOF_CONFIG.samplePctMax) / 100
		);
		check(
			`200 candidats d’échantillon, budget ${PROOF_CONFIG.dailyBudgetPerProject} → au plus ${expectedCap} en base`,
			sampleRows === expectedCap,
			`bucket sample = ${sampleRows}`
		);
		check(
			'et JAMAIS le budget entier : la garde vit dans le module, pas dans l’appelant',
			sampleRows < PROOF_CONFIG.dailyBudgetPerProject,
			`${sampleRows} < ${PROOF_CONFIG.dailyBudgetPerProject}`
		);
		check(
			'le plafond atteint se DIT (`sample_capped`), il ne se devine pas',
			pA.guards.includes('sample_capped'),
			`guards=[${pA.guards.join(', ')}]`
		);
		check(
			'les URLs rendues au collecteur sont exactement les lignes écrites',
			pA.urls.length === (await countSelections(proj.id)),
			`${pA.urls.length} URLs / ${await countSelections(proj.id)} lignes`
		);

		// ── A-bis ───────────────────────────────────────────────────
		section('A-bis. Contre-épreuve : sans le plafond, l’échantillon prend tout et l’urgent saute');
		await cleanup(proj.id);
		await saveSelectionSettings({ db, config: { ...PROOF_CONFIG, samplePctMax: 0 }, now: NOW });
		await seedInventory(
			proj.id,
			25,
			Array.from({ length: 200 }, (_, i) => ({ path: `/s/${String(i).padStart(3, '0')}` }))
		);
		const pAbis = await plan(proj.id, 'full');
		check(
			'à 0 %, l’échantillon ne prend RIEN : le plafond est bien le seul levier',
			(pAbis.byBucket.sample ?? 0) === 0,
			`sample=${pAbis.byBucket.sample}`
		);
		// Et l'inverse : à 100 % (clampé à 60), il prendrait 24 des 40 slots — jamais 40.
		await cleanup(proj.id);
		await saveSelectionSettings({ db, config: { ...PROOF_CONFIG, samplePctMax: 100 }, now: NOW });
		await seedInventory(
			proj.id,
			25,
			Array.from({ length: 200 }, (_, i) => ({ path: `/s/${String(i).padStart(3, '0')}` }))
		);
		const pAter = await plan(proj.id, 'full');
		check(
			'un réglage forgé à 100 % retombe à 60 % : la garde n’est pas désactivable',
			(pAter.byBucket.sample ?? 0) === 24,
			`sample=${pAter.byBucket.sample} (24 attendu, soit 60 % de 40 — et non 40)`
		);
		await saveSelectionSettings({ db, config: PROOF_CONFIG, now: NOW });

		// ── B ───────────────────────────────────────────────────────
		section('B. ACCEPTATION 2 — chaque ligne porte sa raison ET la preuve de sa raison');
		await cleanup(proj.id);
		// Un inventaire antérieur, puis un inventaire du jour qui ajoute et modifie.
		await seedInventory(proj.id, 20, [
			{ path: '/stable', lastmod: '2018-10-01' },
			{ path: '/bouge', lastmod: '2018-10-01' }
		]);
		await seedInventory(proj.id, 25, [
			{ path: '/stable', lastmod: '2018-10-01' },
			{ path: '/bouge', lastmod: '2018-11-20' },
			{ path: '/toute-neuve' }
		]);
		await upsertFinding(
			{
				projectId: proj.id,
				type: 'index_drop',
				entityType: 'page',
				entityKey: `${HOST}/en-panne`,
				title: 'sentinelle IDX-004',
				severity: 'high',
				priorityScore: 90
			},
			db
		);
		const pB = await plan(proj.id, 'full');
		const linesB = await rows<{ reason: string; reason_detail: string | null; url_normalized: string }>(sql`
			SELECT reason, reason_detail, url_normalized FROM "seostats"."index_selection"
			 WHERE project_id = ${proj.id} AND url_normalized LIKE ${HOST + '%'}
			 ORDER BY reason, url_normalized
		`);
		const VOCAB = ['manual', 'post_publish', 'finding', 'strategic', 'new', 'changed', 'sample'];
		check(
			'toutes les raisons écrites appartiennent au vocabulaire fermé',
			linesB.every((l) => VOCAB.includes(l.reason)),
			`raisons=[${[...new Set(linesB.map((l) => l.reason))].sort().join(', ')}]`
		);
		const byReason = new Map(linesB.map((l) => [l.reason, l]));
		check(
			'`finding` prouve sa raison en citant le finding',
			(() => {
				const d = byReason.get('finding')?.reason_detail;
				return !!d && typeof (JSON.parse(d) as { findingId?: string }).findingId === 'string';
			})(),
			byReason.get('finding')?.reason_detail ?? '∅'
		);
		check(
			'`new` cite le snapshot depuis lequel la page est nouvelle',
			(() => {
				const d = byReason.get('new')?.reason_detail;
				return !!d && (JSON.parse(d) as { since?: string }).since === day(20);
			})(),
			byReason.get('new')?.reason_detail ?? '∅'
		);
		check(
			'`changed` cite le `lastmod` avant ET après — une affirmation aurait suffi à personne',
			(() => {
				const d = byReason.get('changed')?.reason_detail;
				if (!d) return false;
				const parsed = JSON.parse(d) as { lastmodFrom?: string; lastmodTo?: string };
				return parsed.lastmodFrom === '2018-10-01' && parsed.lastmodTo === '2018-11-20';
			})(),
			byReason.get('changed')?.reason_detail ?? '∅'
		);
		check(
			'`sample` cite la dernière observation (ici : aucune)',
			(() => {
				const d = byReason.get('sample')?.reason_detail;
				return !!d && (JSON.parse(d) as { lastObservedDate?: string | null }).lastObservedDate === null;
			})(),
			byReason.get('sample')?.reason_detail ?? '∅'
		);
		check(
			'le finding passe devant tout le reste (famille urgente servie en premier)',
			pB.urls[0] === `${HOST}/en-panne`,
			`1re URL = ${pB.urls[0]}`
		);
		console.log(
			'  ℹ `strategic` demande des clics GSC ou une déclaration projet, `manual`/`post_publish` ' +
				'n’ont pas de producteur avant le lot 2 : non couverts ici, et c’est dit.'
		);

		// ── C ───────────────────────────────────────────────────────
		section('C. ACCEPTATION 3 — une inspection manquée est replanifiée SANS duplication');
		await cleanup(proj.id);
		await seedInventory(
			proj.id,
			25,
			Array.from({ length: 10 }, (_, i) => ({ path: `/c/${i}` }))
		);
		const pC1 = await plan(proj.id, 'full');
		const afterFirst = await countSelections(proj.id);
		check('10 pages sélectionnées et inscrites', afterFirst === 10, `${afterFirst} lignes`);

		// La collecte part, et meurt au 3ᵉ appel (429). Trois faits acquis, sept intentions
		// en suspens — exactement ce que l'écriture AVANT collecte préserve.
		for (const url of pC1.urls.slice(0, 3)) await seedObservation(proj.id, url, 30);
		const due = await loadDueSelections({ db, projectId: proj.id, today: TODAY });
		check(
			'7 intentions restent dues : « payé sans résultat » ne se lit pas « fait »',
			due.rows.length === 7,
			`${due.rows.length} dues`
		);
		check(
			'et ce sont EXACTEMENT les 7 non observées',
			due.rows.every((r) => !pC1.urls.slice(0, 3).includes(r.urlNormalized)),
			`dues=[${due.rows.length}] ∩ honorées=[0]`
		);

		const pC2 = await plan(proj.id, 'full');
		const afterSecond = await countSelections(proj.id);
		check(
			'le run suivant reprend les 7, et n’écrit AUCUNE ligne de plus',
			afterSecond === afterFirst,
			`${afterFirst} → ${afterSecond}`
		);
		check(
			'les 3 honorées ne reviennent pas',
			pC1.urls.slice(0, 3).every((u) => !pC2.urls.includes(u)),
			`reprises = ${pC2.urls.length}`
		);
		check(
			'les 7 dues sont bien en tête de la reprise',
			due.rows.every((r) => pC2.urls.includes(r.urlNormalized)),
			`${due.rows.filter((r) => pC2.urls.includes(r.urlNormalized)).length}/7`
		);

		// ── C-bis ───────────────────────────────────────────────────
		section('C-bis. Contre-épreuve : sans persistance AVANT collecte, la reprise ne reprend RIEN');
		// On efface les intentions en gardant les 3 faits : c'est exactement l'état qu'aurait
		// laissé un code qui persiste APRÈS la collecte et meurt au 3ᵉ appel.
		await db.execute(sql`
			DELETE FROM "seostats"."index_selection"
			 WHERE project_id = ${proj.id} AND url_normalized LIKE ${HOST + '%'}
		`);
		const dueBis = await loadDueSelections({ db, projectId: proj.id, today: TODAY });
		check(
			'0 échéance due : les 7 URLs payées sans résultat sont devenues INVISIBLES',
			dueBis.rows.length === 0,
			`${due.rows.length} dues → ${dueBis.rows.length}`
		);
		const pCbis = await plan(proj.id, 'full');
		const reFound = pCbis.urls.filter((u) => due.rows.some((r) => r.urlNormalized === u)).length;
		check(
			'la reprise les retrouve par HASARD (échantillon), pas parce qu’elle sait qu’elles étaient dues',
			pCbis.byReason.sample !== undefined && pCbis.byReason.due === undefined,
			`raisons=[${Object.keys(pCbis.byReason).join(', ')}] · ${reFound}/7 recroisées par l’échantillon`
		);
		console.log(
			'  ℹ Sur un site de 200 pages plutôt que 10, l’échantillon ne les recroiserait qu’au ' +
				'bout de plusieurs semaines. C’est le quota que la persistance-avant fait économiser.'
		);

		// ── D ───────────────────────────────────────────────────────
		section('D. Sémantique J+N — une inspection à J+4 n’honore pas une échéance J+7');
		await cleanup(proj.id);
		const urlD = `${HOST}/jplusn`;
		await db.insert(schema.indexSelection).values({
			id: createId(),
			projectId: proj.id,
			schemaVersion: 1,
			dueDate: day(27),
			url: urlD,
			urlNormalized: urlD,
			reason: 'post_publish',
			reasonDetail: JSON.stringify({ offsetDays: 7 }),
			bucket: 'priority',
			rank: 0,
			selectorVersion: 'index_selection@1'
		});
		await seedObservation(proj.id, urlD, 24);
		const dueD1 = await loadDueSelections({ db, projectId: proj.id, today: TODAY });
		check(
			'une observation ANTÉRIEURE à l’échéance ne l’honore pas',
			dueD1.rows.length === 1,
			`obs ${day(24)} < due ${day(27)} → ${dueD1.rows.length} due`
		);
		await seedObservation(proj.id, urlD, 27);
		const dueD2 = await loadDueSelections({ db, projectId: proj.id, today: TODAY });
		check(
			'une observation À la date de l’échéance l’honore',
			dueD2.rows.length === 0,
			`obs ${day(27)} >= due ${day(27)} → ${dueD2.rows.length} due`
		);

		// ── E ───────────────────────────────────────────────────────
		section('E. Réserve urgente CROSS-PROJET — `full` est refusé, `due` passe');
		await cleanup(proj.id);
		// On remplit le pool du jour jusqu'à ne laisser que la réserve.
		const toBurn = PROOF_CONFIG.dailyPoolTotal - PROOF_CONFIG.poolUrgentReserve;
		await db.insert(schema.indexObservations).values(
			Array.from({ length: toBurn }, (_, i) => ({
				id: createId(),
				projectId: proj.id,
				provider: 'indexing',
				schemaVersion: 1,
				observedDate: TODAY,
				url: `${HOST}/pool/${i}`,
				coverageState: INDEXED,
				verdict: 'PASS'
			}))
		);
		await seedInventory(
			proj.id,
			25,
			Array.from({ length: 20 }, (_, i) => ({ path: `/e/${i}` }))
		);
		const urlE = `${HOST}/e/urgent`;
		await db.insert(schema.indexSelection).values({
			id: createId(),
			projectId: proj.id,
			schemaVersion: 1,
			dueDate: day(29),
			url: urlE,
			urlNormalized: urlE,
			reason: 'finding',
			reasonDetail: JSON.stringify({ findingId: 'sentinelle' }),
			bucket: 'priority',
			rank: 0,
			selectorVersion: 'index_selection@1'
		});
		const pEfull = await plan(proj.id, 'full', { dryRun: true });
		check(
			'`full` n’obtient RIEN : la réserve n’est pas dépensable par la routine',
			pEfull.budget === 0 && pEfull.urls.length === 0,
			`budget=${pEfull.budget} · guards=[${pEfull.guards.join(', ')}]`
		);
		check(
			'et la cause est NOMMÉE, pas déduite d’un zéro',
			pEfull.guards.includes('urgent_reserve'),
			`guards=[${pEfull.guards.join(', ')}]`
		);
		const pEdue = await plan(proj.id, 'due', { dryRun: true });
		check(
			'`due` y a accès et sert l’échéance : le projet qui tire le lundi ne prive personne',
			pEdue.budget > 0 && pEdue.urls.includes(urlE),
			`budget=${pEdue.budget} · urls=${pEdue.urls.length}`
		);
		check(
			'`scope: due` n’ouvre PAS la routine : aucune page d’inventaire ne s’y glisse',
			pEdue.urls.every((u) => u === urlE),
			`urls=[${pEdue.urls.join(', ')}]`
		);
		check(
			'dry-run : rien n’a été écrit malgré une sélection non vide',
			(await countSelections(proj.id)) === 1,
			`1 ligne (l’échéance semée), aucune de plus`
		);

		// ── F ───────────────────────────────────────────────────────
		section('F. Abandon borné — une échéance trop vieille est écartée ET comptée');
		await cleanup(proj.id);
		const urlF = `${HOST}/perimee`;
		await db.insert(schema.indexSelection).values({
			id: createId(),
			projectId: proj.id,
			schemaVersion: 1,
			// 15 jours avant TODAY, pour un `maxAgeDays` de 14.
			dueDate: day(15),
			url: urlF,
			urlNormalized: urlF,
			reason: 'post_publish',
			reasonDetail: JSON.stringify({ offsetDays: 3 }),
			bucket: 'priority',
			rank: 0,
			selectorVersion: 'index_selection@1'
		});
		const pF = await plan(proj.id, 'due', { dryRun: true });
		check(
			'l’échéance périmée n’est pas inspectée',
			!pF.urls.includes(urlF),
			`urls=${pF.urls.length}`
		);
		check(
			'mais elle est COMPTÉE : un abandon silencieux se lirait comme une inspection réussie',
			pF.expired === 1,
			`expired=${pF.expired}`
		);
		check(
			'et la ligne reste en base — c’est une trace d’audit, pas un brouillon',
			(await countSelections(proj.id)) === 1,
			`${await countSelections(proj.id)} ligne`
		);

		// ── G ───────────────────────────────────────────────────────
		section('G. Non-régression IDX-002 — le mode `explicit` n’écrit aucune sélection');
		await cleanup(proj.id);
		const handler = defaultHandlers().get('collect:url_inspection');
		check('le handler est bien enregistré', !!handler, handler ? 'présent' : 'ABSENT');
		if (handler) {
			// Payload SANS `mode` : c'est le chemin d'IDX-002. Une liste vide court-circuite
			// avant tout appel réseau — ce qui prouve que le défaut ne passe pas par la politique.
			await handler({
				db,
				job: {
					id: 'sentinelle-idx004',
					projectId: proj.id,
					runId: null,
					type: 'collect:url_inspection',
					payloadJson: JSON.stringify({ urls: [] }),
					attempts: 1,
					maxAttempts: 3,
					deferrals: 0,
					idempotencyKey: null,
					leaseOwner: 'preuve',
					leaseUntil: null
				} as unknown as Parameters<NonNullable<typeof handler>>[0]['job'],
				signal: new AbortController().signal
			});
			check(
				'aucune ligne de sélection écrite : le défaut ne touche pas la politique',
				(await countSelections(proj.id)) === 0,
				`${await countSelections(proj.id)} ligne`
			);
		}

		// ── H ───────────────────────────────────────────────────────
		section('H. La forme envoyée à Google est la forme NORMALISÉE — une page, une série');
		await cleanup(proj.id);
		await db.insert(schema.sitemapUrlObservations).values({
			id: createId(),
			projectId: proj.id,
			provider: 'gsc',
			schemaVersion: 1,
			observedDate: day(25),
			sitemapUrl: `${HOST}/sitemap.xml`,
			// Le site déclare un fragment ; IDX-001 a normalisé la colonne de comparaison.
			url: `${HOST}/ancre#top`,
			urlNormalized: `${HOST}/ancre`,
			expectedCanonical: `${HOST}/ancre`,
			isAlternate: false
		});
		const pH = await plan(proj.id, 'full');
		check(
			'l’URL rendue au collecteur ne porte pas le fragment',
			pH.urls.includes(`${HOST}/ancre`) && !pH.urls.some((u) => u.includes('#')),
			`urls=[${pH.urls.join(', ')}]`
		);
		const lineH = await rows<{ url: string; url_normalized: string }>(sql`
			SELECT url, url_normalized FROM "seostats"."index_selection"
			 WHERE project_id = ${proj.id} AND url_normalized = ${`${HOST}/ancre`}
		`);
		check(
			'la base garde la forme SOURCE en trace, et compare sur la forme normalisée',
			lineH[0]?.url === `${HOST}/ancre#top` && lineH[0]?.url_normalized === `${HOST}/ancre`,
			`url=${lineH[0]?.url} · url_normalized=${lineH[0]?.url_normalized}`
		);
		// Et c'est ce qui garantit une SEULE série côté IDX-005 : la mesure sera écrite sous
		// `url = url_normalized`, donc retrouvable par la jointure « honorée ».
		await seedObservation(proj.id, `${HOST}/ancre`, 30);
		const dueH = await loadDueSelections({ db, projectId: proj.id, today: TODAY });
		check(
			'la mesure retrouve son intention : la jointure « honorée » ferme la boucle',
			dueH.rows.length === 0,
			`${dueH.rows.length} due après observation`
		);
	} finally {
		await cleanup(proj.id);
		await restoreSetting();
	}

	// ── Base rendue à l'identique ───────────────────────────────────
	section('I. Base rendue à l’identique');
	const post = {
		selections: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."index_selection"`),
		indexObs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."index_observations"`),
		sitemapObs: await scalar(
			sql`SELECT count(*)::int AS n FROM "seostats"."sitemap_url_observations"`
		),
		findings: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`),
		events: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."finding_events"`),
		settings: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."system_settings"`)
	};
	for (const key of Object.keys(base) as (keyof typeof base)[]) {
		check(`${key} inchangé`, base[key] === post[key], `${base[key]} → ${post[key]}`);
	}
	const leftover = await rows<{ value: string }>(sql`
		SELECT value FROM "seostats"."system_settings" WHERE key = ${SELECTION_SETTINGS_KEY}
	`);
	check(
		'le réglage `indexing.selection` est rendu à son état d’origine',
		(leftover[0]?.value ?? null) === (previousSetting ?? null),
		previousSetting === null ? 'absent avant, absent après' : 'restauré'
	);

	section(failures === 0 ? '✅ Toutes les vérifications passent.' : `❌ ${failures} échec(s).`);
	if (failures > 0) process.exitCode = 1;
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => pool.end());
