/**
 * IDX-004 lot 2 — Preuve des échéances post-publication et de l'audit manuel (sur Neon).
 *
 * Le jugement (dates J+N, dédup, coupe au budget, ordre) est couvert par vitest
 * (`index-selection-state.test.ts`). Ce qui ne peut PAS se prouver en vitest, et se prouve ici
 * contre la vraie base :
 *
 *   A. `scheduleIndexChecks` écrit **trois** lignes pour une page — là où la dédup de
 *      l'allocation n'en garderait qu'une. La clé `(url_normalized, due_date)` les sépare ;
 *   B. **LE point du lot** — une seule échéance est honorée à J+3 : la passe `scope: 'due'`
 *      du jour rend 1 URL, pas 3. Les deux autres restent dues, intactes ;
 *   C. idempotence par les DATES : rejouer la même publication n'écrit rien de plus
 *      (`count(*)` inchangé) ; **republier** (publishedAt plus récent) pose bien de nouvelles
 *      échéances — ce que la clé de `schedulePostPublish` (sans `publishedAt`) ne sait pas
 *      faire, et la raison pour laquelle ce lot ne la réutilise pas ;
 *   D. l'observation HONORE l'échéance : après inspection, la ligne cesse d'être due, et une
 *      observation trop tôt n'honore pas une échéance plus lointaine (sémantique `>=`) ;
 *   E. une échéance abandonnée (au-delà de `maxAgeDays`) est écartée ET comptée, jamais tue ;
 *   F. la passe quotidienne `scope: 'due'` n'inspecte QUE des échéances : aucune ligne de
 *      routine ni d'échantillon n'apparaît, même avec un inventaire plein de pages neuves ;
 *   G. l'audit manuel est BORNÉ par le même budget que la politique, et sa coupe se dit.
 *
 * ZÉRO appel Google : tout est en base. Aucun quota consommé.
 *
 * Isolation. Dates sentinelles **2018-11-xx**, URLs sur `https://sentinelle-idx004.test`,
 * sous un projet RÉEL (contrainte FK). Le réglage `indexing.selection` est sauvegardé puis
 * RESTAURÉ à l'identique. Nettoyage dans un `finally` — un Ctrl-C le SAUTE : vérifier alors
 * les `due_date`/`observed_date` **2018-11-%** de `index_selection`, `index_observations` et
 * `sitemap_url_observations`, et la clé `indexing.selection` de `system_settings`.
 *
 * Lancer : npx tsx scripts/idx-004-lot2-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { createId } from '../src/lib/server/utils.js';
import {
	SELECTION_SETTINGS_KEY,
	loadDueSelections,
	planInspectionSelection,
	saveSelectionSettings,
	scheduleIndexChecks,
	selectManualUrls
} from '../src/lib/server/collectors/index-selection.js';
import { POST_PUBLISH_OFFSETS_DAYS, catalogFor } from '../src/lib/server/schedule-state.js';

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
const INDEXED = 'Submitted and indexed';
/** Publication le 2018-11-01 ⇒ échéances 11-04, 11-08, 11-29. */
const PUBLISHED = '2018-11-01';
const ARTICLE = `${HOST}/blog/lot2`;

const PROOF_CONFIG = {
	dailyPoolTotal: 500,
	poolUrgentReserve: 100,
	dailyBudgetPerProject: 40,
	samplePctMax: 40,
	sampleIntervalDays: 14,
	maxAgeDays: 14,
	jobCap: 200
};

function day(n: number): string {
	return `${SENTINEL_PREFIX}${String(n).padStart(2, '0')}`;
}
function at(dayN: number): Date {
	return new Date(`${day(dayN)}T12:00:00Z`);
}

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(q);
	return Number((res.rows?.[0] as { n: number }).n);
}
async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
	const res = await db.execute(q);
	return (res.rows ?? []) as unknown as T[];
}

async function seedObservation(projectId: string, url: string, dayN: number): Promise<void> {
	await db.execute(sql`
		INSERT INTO "seostats"."index_observations"
			(id, project_id, provider, schema_version, observed_date, url, coverage_state, verdict)
		VALUES (${createId()}, ${projectId}, 'indexing', 1, ${day(dayN)}, ${url}, ${INDEXED}, 'PASS')
		ON CONFLICT (project_id, url, observed_date) DO NOTHING
	`);
}

async function seedInventory(
	projectId: string,
	dayN: number,
	paths: string[]
): Promise<void> {
	if (paths.length === 0) return;
	await db
		.insert(schema.sitemapUrlObservations)
		.values(
			paths.map((p) => ({
				id: createId(),
				projectId,
				provider: 'gsc',
				schemaVersion: 1,
				observedDate: day(dayN),
				sitemapUrl: `${HOST}/sitemap.xml`,
				url: `${HOST}${p}`,
				urlNormalized: `${HOST}${p}`,
				lastmod: null,
				locale: null,
				expectedCanonical: `${HOST}${p}`,
				isAlternate: false
			}))
		)
		.onConflictDoNothing();
}

async function countSelections(projectId: string): Promise<number> {
	return scalar(sql`
		SELECT count(*)::int AS n FROM "seostats"."index_selection"
		 WHERE project_id = ${projectId} AND url_normalized LIKE ${HOST + '%'}
	`);
}

async function dueDates(projectId: string): Promise<string[]> {
	const r = await rows<{ due_date: string }>(sql`
		SELECT due_date FROM "seostats"."index_selection"
		 WHERE project_id = ${projectId} AND url_normalized = ${ARTICLE}
		 ORDER BY due_date
	`);
	return r.map((x) => x.due_date);
}

async function cleanup(projectId: string): Promise<void> {
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

/** Publie l'article sentinelle — exactement ce que fait la route de publication. */
async function publish(projectId: string, publishedAt = PUBLISHED) {
	return scheduleIndexChecks({
		db,
		projectId,
		url: ARTICLE,
		publishedAt: new Date(`${publishedAt}T09:00:00Z`),
		contentId: 'ct_sentinelle'
	});
}

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
	console.log(`Publication ${PUBLISHED} · offsets [${POST_PUBLISH_OFFSETS_DAYS.join(', ')}]`);

	const base = {
		selections: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."index_selection"`),
		indexObs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."index_observations"`),
		sitemapObs: await scalar(
			sql`SELECT count(*)::int AS n FROM "seostats"."sitemap_url_observations"`
		),
		settings: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."system_settings"`)
	};
	console.log(
		`Baseline : ${base.selections} sélections · ${base.indexObs} index_obs · ` +
			`${base.sitemapObs} sitemap_obs · ${base.settings} réglages`
	);

	await saveSettingSnapshot();

	try {
		await cleanup(proj.id);
		await saveSelectionSettings({ db, config: PROOF_CONFIG, now: at(1) });

		// ── A ───────────────────────────────────────────────────────
		section('A. Une publication pose TROIS rendez-vous, pas un');
		const a = await publish(proj.id);
		check('trois échéances écrites', a.scheduled === 3, `scheduled=${a.scheduled}`);
		check(
			'datées depuis la PUBLICATION (J+3 / J+7 / J+28)',
			JSON.stringify(await dueDates(proj.id)) ===
				JSON.stringify([day(4), day(8), day(29)]),
			(await dueDates(proj.id)).join(' · ')
		);
		const reasons = await rows<{ reason: string; n: number }>(sql`
			SELECT reason, count(*)::int AS n FROM "seostats"."index_selection"
			 WHERE project_id = ${proj.id} AND url_normalized = ${ARTICLE}
			 GROUP BY reason
		`);
		check(
			'toutes de raison `post_publish`, du vocabulaire fermé',
			reasons.length === 1 && reasons[0].reason === 'post_publish' && reasons[0].n === 3,
			reasons.map((r) => `${r.reason}=${r.n}`).join(', ')
		);
		const detail = await rows<{ reason_detail: string }>(sql`
			SELECT reason_detail FROM "seostats"."index_selection"
			 WHERE project_id = ${proj.id} AND url_normalized = ${ARTICLE} AND due_date = ${day(4)}
		`);
		const parsed = JSON.parse(detail[0]?.reason_detail ?? '{}');
		check(
			'chaque échéance porte de quoi se justifier (contenu, publication, offset)',
			parsed.contentId === 'ct_sentinelle' &&
				parsed.publishedAt === PUBLISHED &&
				parsed.offsetDays === 3,
			detail[0]?.reason_detail ?? '(vide)'
		);

		// ── B ───────────────────────────────────────────────────────
		section('B. LE POINT — au jour J+3, UNE seule échéance est due, pas trois');
		// La passe quotidienne du 2018-11-04 : `due_date <= today` ne prend que la première.
		const p4 = await planInspectionSelection({
			db,
			projectId: proj.id,
			now: at(4),
			scope: 'due',
			dryRun: true
		});
		check(
			'la passe du jour rend 1 URL (le J+3), pas les 3',
			p4.urls.length === 1 && p4.urls[0] === ARTICLE,
			`urls=${p4.urls.length}`
		);
		check(
			'et elle la dit due pour la bonne raison',
			p4.byReason.post_publish === 1,
			JSON.stringify(p4.byReason)
		);
		const due4 = await loadDueSelections({ db, projectId: proj.id, today: day(4) });
		check(
			'les deux autres restent dues plus tard, INTACTES',
			due4.rows.length === 1 && (await countSelections(proj.id)) === 3,
			`${due4.rows.length} due(s) au ${day(4)} · ${await countSelections(proj.id)} lignes`
		);
		const p8 = await planInspectionSelection({
			db,
			projectId: proj.id,
			now: at(8),
			scope: 'due',
			dryRun: true
		});
		// ⚠️ Une seule URL rendue au J+8 aussi : deux échéances de la MÊME page ne se paient pas
		// deux fois le même jour — c'est la dédup de l'allocation qui joue là, et elle a raison.
		check(
			'au J+7, la page est de nouveau due — une fois, pas deux',
			p8.urls.length === 1,
			`urls=${p8.urls.length}`
		);

		// ── C ───────────────────────────────────────────────────────
		section('C. Idempotence par les DATES : rejouer n’écrit rien, republier écrit');
		const again = await publish(proj.id);
		check(
			'la même publication rejouée n’ajoute AUCUNE ligne',
			(await countSelections(proj.id)) === 3,
			`count=${await countSelections(proj.id)} (scheduled annoncé ${again.scheduled}, ON CONFLICT)`
		);
		const republished = await publish(proj.id, day(10));
		check(
			'republier (publishedAt plus récent) pose de NOUVELLES échéances',
			(await countSelections(proj.id)) === 6,
			`count=${await countSelections(proj.id)} · nouvelles ${republished.dueDates.join(', ')}`
		);
		// C'est l'argument qui a fait rejeter le réemploi de `schedulePostPublish` : sa clé
		// d'idempotence est `${contentId}:J+${offsetDays}`, sans `publishedAt` — elle aurait
		// silencieusement refusé les trois échéances de la republication.
		await cleanup(proj.id);

		// ── D ───────────────────────────────────────────────────────
		section('D. L’observation HONORE l’échéance — et le `>=` porte la sémantique J+N');
		await publish(proj.id);
		// Une inspection au J+2 : trop tôt pour l'échéance J+3.
		await seedObservation(proj.id, ARTICLE, 3);
		const dueEarly = await loadDueSelections({ db, projectId: proj.id, today: day(4) });
		check(
			'une observation au J+2 n’honore PAS l’échéance J+3',
			dueEarly.rows.length === 1 && dueEarly.rows[0].dueDate === day(4),
			`${dueEarly.rows.length} due(s), première ${dueEarly.rows[0]?.dueDate}`
		);
		await seedObservation(proj.id, ARTICLE, 4);
		const dueAfter = await loadDueSelections({ db, projectId: proj.id, today: day(4) });
		check(
			'une observation AU jour de l’échéance l’honore',
			dueAfter.rows.length === 0,
			`${dueAfter.rows.length} due(s) restante(s) au ${day(4)}`
		);
		check(
			'et rien n’a été supprimé : l’intention reste au registre d’audit',
			(await countSelections(proj.id)) === 3,
			`count=${await countSelections(proj.id)}`
		);

		// ── E ───────────────────────────────────────────────────────
		section('E. Une échéance abandonnée est écartée ET comptée');
		// maxAgeDays = 14 : au 2018-11-25, l'échéance du 11-08 a 17 jours.
		const pLate = await planInspectionSelection({
			db,
			projectId: proj.id,
			now: at(25),
			scope: 'due',
			dryRun: true
		});
		check(
			'l’échéance J+7 trop vieille est abandonnée, jamais en silence',
			pLate.expired >= 1,
			`expired=${pLate.expired} · retenues=${pLate.urls.length}`
		);

		// ── F ───────────────────────────────────────────────────────
		section('F. La passe quotidienne n’inspecte QUE des échéances');
		await cleanup(proj.id);
		// 200 pages neuves dans l'inventaire : autant de candidats `new`/`sample` en `full`…
		await seedInventory(
			proj.id,
			3,
			Array.from({ length: 200 }, (_, i) => `/f/${String(i).padStart(3, '0')}`)
		);
		await publish(proj.id);
		const pDue = await planInspectionSelection({
			db,
			projectId: proj.id,
			now: at(4),
			scope: 'due',
			dryRun: true
		});
		check(
			'…et pourtant `scope: due` ne rend QUE l’échéance : 1 URL',
			pDue.urls.length === 1 && pDue.urls[0] === ARTICLE,
			`urls=${pDue.urls.length}`
		);
		check(
			'aucune routine, aucun échantillon — la réserve n’est pas désarmable par réglage',
			(pDue.byBucket.sample ?? 0) === 0 && Object.keys(pDue.byReason).join() === 'post_publish',
			`byReason=${JSON.stringify(pDue.byReason)}`
		);
		const pFull = await planInspectionSelection({
			db,
			projectId: proj.id,
			now: at(4),
			scope: 'full',
			dryRun: true
		});
		check(
			'la contre-épreuve : en `full`, le même état rend tout le budget',
			pFull.urls.length > 1,
			`urls=${pFull.urls.length} (budget ${pFull.budget})`
		);

		// ── G ───────────────────────────────────────────────────────
		section('G. L’audit manuel est BORNÉ par le même budget que la politique');
		await cleanup(proj.id);
		const manyUrls = Array.from({ length: 120 }, (_, i) => `${HOST}/audit/${i}`);
		const gDry = await selectManualUrls({
			db,
			projectId: proj.id,
			urls: manyUrls,
			now: at(5),
			dryRun: true,
			note: 'preuve'
		});
		check(
			'dry-run : coupé au budget projet, et RIEN écrit',
			gDry.urls.length === PROOF_CONFIG.dailyBudgetPerProject &&
				(await countSelections(proj.id)) === 0,
			`retenues=${gDry.urls.length} · lignes=${await countSelections(proj.id)}`
		);
		check(
			'la coupe se DIT, avec la liste de ce qui est tombé',
			gDry.truncated.length === 120 - PROOF_CONFIG.dailyBudgetPerProject,
			`truncated=${gDry.truncated.length}`
		);
		const gRun = await selectManualUrls({
			db,
			projectId: proj.id,
			urls: manyUrls,
			now: at(5),
			budget: 5
		});
		check(
			'`--limit` resserre encore, et n’écrit que ça',
			gRun.persisted === 5 && (await countSelections(proj.id)) === 5,
			`persisted=${gRun.persisted} · lignes=${await countSelections(proj.id)}`
		);
		const gZero = await selectManualUrls({
			db,
			projectId: proj.id,
			urls: manyUrls,
			now: at(5),
			budget: 0
		});
		check(
			'`0` veut dire ZÉRO — l’inverse de job-limits.ts',
			gZero.urls.length === 0 && (await countSelections(proj.id)) === 5,
			`retenues=${gZero.urls.length} · lignes inchangées=${await countSelections(proj.id)}`
		);
		const manualDue = await loadDueSelections({ db, projectId: proj.id, today: day(5) });
		check(
			'les intentions manuelles sont dues le jour même',
			manualDue.rows.length === 5,
			`${manualDue.rows.length} due(s)`
		);

		// ── H ───────────────────────────────────────────────────────
		section('H. Le catalogue quotidien honore ces échéances sans qu’on le lui demande');
		const daily = catalogFor('daily');
		const insp = daily.find((e) => e.jobType === 'collect:url_inspection');
		check(
			'`collect:url_inspection` est au catalogue quotidien, en `scope: due`',
			JSON.stringify(insp?.payload) === JSON.stringify({ mode: 'policy', scope: 'due' }),
			JSON.stringify(insp?.payload)
		);
		const det = daily.find((e) => e.jobType === 'detect:index_transition');
		check(
			'et la détection en dépend OBLIGATOIREMENT (pas de détection sur du périmé)',
			JSON.stringify(det?.dependsOn) === JSON.stringify([{ jobType: 'collect:url_inspection' }]),
			JSON.stringify(det?.dependsOn)
		);
	} finally {
		await cleanup(proj.id);
		await restoreSetting();
	}

	section('I. Base rendue à l’identique');
	const post = {
		selections: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."index_selection"`),
		indexObs: await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."index_observations"`),
		sitemapObs: await scalar(
			sql`SELECT count(*)::int AS n FROM "seostats"."sitemap_url_observations"`
		),
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
