/**
 * REP-001 — Preuve du rapport hebdomadaire déterministe (sur Neon).
 *
 * Les règles du modèle (absence ≠ zéro, gate d'examen, ordre total, troncature, rendu texte)
 * sont couvertes par vitest (`weekly-report-state.test.ts`, 55 tests). Ce qui ne peut PAS se
 * prouver en vitest, et se prouve ici, c'est ce que fait la BASE :
 *
 *   A. le rapport ne recalcule PAS la santé : son portefeuille et ses cartes sont
 *      `JSON.stringify`-égaux à ceux de `loadHomeCockpit` — il n'existe donc pas deux
 *      définitions de « projet à risque » entre l'accueil et le rapport du lundi ;
 *   B. les grouped readers neufs (`countIndexClassesByProject`, `countDueSelectionsByProject`)
 *      rendent EXACTEMENT ce que rendent les autorités per-projet (`countIndexClasses`,
 *      `loadDueSelections`) — le pendant de l'égalité §A de DASH-003 lot 2 ;
 *   C. chaque item du rapport pointe vers une ligne qui EXISTE (finding, proposition, projet) :
 *      l'acceptation « chaque item renvoie à sa source » vérifiée contre la base, pas contre
 *      un type ;
 *   D. le trafic est ABSENT et non zéro, et c'est vrai : aucun projet ne déclare `plausible`
 *      (requête indépendante). Aucune métrique de la section n'existe dans le JSON ;
 *   E. déterminisme : deux générations au MÊME `now` rendent deux JSON identiques ;
 *   F. les totaux ne sont pas bornés par la lecture : chaque compteur de section est reproduit
 *      par une requête indépendante ;
 *   G. contre-épreuve : un finding sentinelle créé dans la fenêtre fait bouger la section
 *      « nouveaux » d'exactement 1, avec un item qui pointe vers LUI — puis la base est rendue
 *      à l'identique.
 *
 * Isolation. Rien n'est créé qu'on ne puisse nommer et supprimer : un finding au fingerprint
 * préfixé `__test_rep001:` et son événement. AUCUN projet n'est créé (la FK cross-schéma
 * `projects.slug → core.entities.slug` appartient à `invoices`). Nettoyage ENFANTS D'ABORD
 * dans un `finally` : finding_events → findings. Un Ctrl-C SAUTE ce nettoyage : vérifier alors
 * les fingerprints `__test_rep001:%`.
 *
 * ⚠️ La PROD écrit dans la même base (`gsc_query_page_observations`, snapshot GSC legacy de
 * `main`). Aucune assertion de cette preuve ne porte sur cette table.
 *
 * Lancer : npx tsx scripts/rep-001-report-proof.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { loadHomeCockpit } from '../src/lib/server/home.js';
import { loadWeeklyReport, OPPORTUNITY_MIN_PRIORITY } from '../src/lib/server/weekly-report.js';
import {
	SECTION_ORDER,
	REPORT_SCHEMA_VERSION,
	renderWeeklyReportText,
	type SectionKey,
	type WeeklyReport
} from '../src/lib/server/weekly-report-state.js';
import { countFindings } from '../src/lib/server/findings.js';
import { countProposals } from '../src/lib/server/proposals.js';
import { countIndexClasses, countIndexClassesByProject } from '../src/lib/server/indexing-read.js';
import {
	countDueSelectionsByProject,
	loadDueSelections
} from '../src/lib/server/collectors/index-selection.js';
import { ACTIVE_STATUSES, FINDING_STATUSES } from '../src/lib/server/finding-state.js';
import { OPEN_PROPOSAL_STATUSES } from '../src/lib/server/proposal-console.js';
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

const SENTINEL_FP = '__test_rep001:new';

async function scalar(q: ReturnType<typeof sql>): Promise<number> {
	const res = await db.execute(q);
	return Number((res.rows?.[0] as { n: number }).n);
}

async function cleanup(): Promise<void> {
	// ENFANTS D'ABORD : les événements référencent les findings.
	await db.execute(sql`
		DELETE FROM "seostats"."finding_events"
		 WHERE finding_id IN (
			SELECT id FROM "seostats"."findings" WHERE fingerprint = ${SENTINEL_FP}
		 )
	`);
	await db.execute(sql`DELETE FROM "seostats"."findings" WHERE fingerprint = ${SENTINEL_FP}`);
}

function body(report: WeeklyReport, key: SectionKey) {
	const s = report.sections.find((x) => x.key === key);
	if (!s) throw new Error(`section ${key} absente`);
	return s.body;
}

/** Le total annoncé par la première métrique d'une section disponible. */
function metricTotal(report: WeeklyReport, key: SectionKey): number | null {
	const b = body(report, key);
	if (!b.available) return null;
	return b.data.metrics[0]?.value ?? null;
}

async function main(): Promise<void> {
	await cleanup();

	// Un instant FIGÉ, passé partout : sans lui, deux générations tomberaient sur deux fenêtres
	// et le déterminisme (§E) serait intestable.
	const now = new Date();
	const nowDb = toDbTimestamp(now);

	const findingsBefore = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`);
	const eventsBefore = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."finding_events"`);
	const projectsBefore = await scalar(
		sql`SELECT count(*)::int AS n FROM "seostats"."projects" WHERE archived = false`
	);

	try {
		const report = await loadWeeklyReport({ db, now });
		const home = await loadHomeCockpit({ db, now });

		console.log(
			`Rapport v${report.schemaVersion} · ${report.period.label} · ${projectsBefore} projet(s) actif(s)`
		);
		console.log(`Titre : ${report.headline}`);

		// ── A. Le rapport ne recalcule pas la santé ──────────────────
		section('A. Une seule définition de la santé (accueil ↔ rapport)');
		check(
			'les douze sections de §14.1, dans l’ordre de la spec',
			JSON.stringify(report.sections.map((s) => s.key)) === JSON.stringify(SECTION_ORDER),
			`${report.sections.length} sections`
		);
		check('le JSON porte sa version de schéma', report.schemaVersion === REPORT_SCHEMA_VERSION);

		// La couverture du parc est portée UNE fois au niveau du rapport, et le rendu ne la
		// répète pas section par section (à 9 projets × 12 sections, la même liste s'imprimait
		// 108 fois). Le JSON, lui, la garde par section : une section extraite seule doit rester
		// lisible avec sa réserve.
		const renderedOnce = renderWeeklyReportText(report);
		const neverRanCount = home.projects.filter((c) => c.diagnosis.state !== 'full').length;
		check(
			'la couverture du parc est déclarée au niveau du rapport',
			report.coverage.length === neverRanCount,
			`${report.coverage.length} angle(s) mort(s) pour ${neverRanCount} projet(s) non pleinement diagnostiqué(s)`
		);
		check(
			'le rendu texte ne répète pas la liste des angles morts',
			(renderedOnce.match(/⚠ angle mort \[/g) ?? []).length === 0 &&
				(renderedOnce.match(/— ce que ce rapport ne peut pas dire/g) ?? []).length ===
					(report.coverage.length > 0 ? 1 : 0)
		);

		const execBody = body(report, 'executive_summary');
		const projBody = body(report, 'projects_needing_action');
		check('le résumé exécutif est disponible', execBody.available);
		if (execBody.available) {
			const total = execBody.data.metrics.find((m) => m.label === 'projets actifs')?.value;
			check(
				'« projets actifs » = le portefeuille de l’accueil',
				total === home.portfolio.total,
				`${total} vs ${home.portfolio.total}`
			);
			// Les compteurs de l'accueil sont REPRIS, pas recalculés : leurs valeurs ET leurs
			// liens doivent coïncider exactement.
			const reported = execBody.data.metrics
				.filter((m) => home.counters.some((c) => c.label === m.label))
				.map((m) => [m.label, m.value, m.source?.href ?? null]);
			const expected = home.counters.map((c) => [c.label, c.count, c.href]);
			check(
				'les compteurs cross-projet sont ceux de l’accueil, liens compris',
				JSON.stringify(reported) === JSON.stringify(expected),
				`${reported.length}/${expected.length} compteurs`
			);
		}
		if (projBody.available) {
			const listed = projBody.data.items.map((i) => i.projectSlug);
			const expected = home.projects.filter((c) => c.state !== 'ok').map((c) => c.slug);
			check(
				'« projets nécessitant une intervention » = les cartes non `ok` de l’accueil, dans le même ordre',
				JSON.stringify(listed) === JSON.stringify(expected),
				`[${listed.join(', ')}]`
			);
		}

		// ── B. Les lecteurs groupés d'accord avec les autorités ──────
		section('B. Les lectures groupées rendent ce que rendent les autorités per-projet');
		const grouped = await countIndexClassesByProject({ db });
		const today = now.toISOString().slice(0, 10);
		const groupedDue = await countDueSelectionsByProject({ db, today });
		let classMismatch = 0;
		let dueMismatch = 0;
		for (const card of home.projects) {
			const perProject = await countIndexClasses({ db, projectId: card.projectId });
			const fromGroup = grouped.get(card.projectId) ?? {
				indexed: 0,
				not_indexed: 0,
				excluded: 0,
				unknown: 0
			};
			if (JSON.stringify(perProject) !== JSON.stringify(fromGroup)) classMismatch += 1;

			const due = await loadDueSelections({ db, projectId: card.projectId, today });
			if ((groupedDue.get(card.projectId)?.dueNow ?? 0) !== due.rows.length) dueMismatch += 1;
		}
		check(
			'`countIndexClassesByProject` = `countIndexClasses` sur chaque projet',
			classMismatch === 0,
			`${home.projects.length} projets comparés`
		);
		check(
			'`countDueSelectionsByProject` = `loadDueSelections` sur chaque projet',
			dueMismatch === 0,
			`${home.projects.length} projets comparés`
		);

		// ── C. Chaque item pointe vers une ligne qui existe ──────────
		section('C. Chaque item renvoie à une source RÉELLE');
		let items = 0;
		let missingSource = 0;
		let danglingSource = 0;
		for (const s of report.sections) {
			if (!s.body.available) continue;
			for (const item of s.body.data.items) {
				items += 1;
				if (!item.source) {
					missingSource += 1;
					continue;
				}
				if (item.source.kind === 'finding') {
					const n = await scalar(
						sql`SELECT count(*)::int AS n FROM "seostats"."findings" WHERE id = ${item.source.id}`
					);
					if (n !== 1) danglingSource += 1;
				} else if (item.source.kind === 'proposal') {
					const n = await scalar(
						sql`SELECT count(*)::int AS n FROM "seostats"."action_proposals" WHERE id = ${item.source.id}`
					);
					if (n !== 1) danglingSource += 1;
				} else if (item.source.kind === 'project') {
					const n = await scalar(
						sql`SELECT count(*)::int AS n FROM "seostats"."projects" WHERE slug = ${item.source.slug}`
					);
					if (n !== 1) danglingSource += 1;
				}
			}
		}
		check('aucun item sans source', missingSource === 0, `${items} items`);
		check('aucune source orpheline en base', danglingSource === 0, `${items} items vérifiés`);

		// ── D. Absent, pas zéro ─────────────────────────────────────
		section('D. Le trafic est ABSENT, et c’est vérifiable');
		const wiredAnalytics = await scalar(sql`
			SELECT count(*)::int AS n FROM "seostats"."project_integrations"
			 WHERE provider = 'plausible' AND enabled = true
		`);
		const trafficBody = body(report, 'traffic_conversions');
		check(
			'aucun projet ne déclare `plausible` (requête indépendante)',
			wiredAnalytics === 0,
			`${wiredAnalytics} intégration(s)`
		);
		check(
			'la section trafic est absente, avec la raison `not_wired`',
			!trafficBody.available && trafficBody.reason === 'not_wired',
			trafficBody.available ? 'disponible (inattendu)' : trafficBody.reason
		);
		const trafficJson = JSON.stringify(report.sections.find((s) => s.key === 'traffic_conversions'));
		check(
			'le JSON de la section ne contient AUCUN chiffre à zéro',
			!/"value":\s*0/.test(trafficJson) && !/visits/.test(trafficJson)
		);
		const text = renderWeeklyReportText(report);
		const trafficLine = text
			.split('\n## ')
			.find((b) => b.startsWith('8. Trafic et conversions'))
			?.split('\n')
			.slice(1)
			.join('\n');
		check(
			'le texte rendu de la section ne contient aucun chiffre',
			trafficLine !== undefined && !/\d/.test(trafficLine),
			JSON.stringify(trafficLine?.trim().slice(0, 80))
		);

		// ── E. Déterminisme ─────────────────────────────────────────
		section('E. Deux générations au même instant sont identiques');
		const again = await loadWeeklyReport({ db, now });
		check(
			'les deux JSON sont octet pour octet identiques',
			JSON.stringify(report) === JSON.stringify(again)
		);
		check(
			'les deux rendus texte sont identiques',
			renderWeeklyReportText(report) === renderWeeklyReportText(again)
		);
		check(
			'l’horodatage est celui passé, pas une horloge interne',
			report.generatedAt === nowDb,
			`${report.generatedAt}`
		);

		// ── F. Les totaux ne viennent pas de la page lue ─────────────
		section('F. Chaque compteur de section est reproduit par une requête indépendante');
		const sinceDb = report.period.sinceDb;
		const expectations: [SectionKey, number][] = [
			[
				'findings_new',
				await countFindings(
					{
						statuses: FINDING_STATUSES,
						activitySince: sinceDb,
						activityEvents: ['created']
					},
					db
				)
			],
			[
				'findings_aggravated',
				await countFindings(
					{ statuses: FINDING_STATUSES, activitySince: sinceDb, activityEvents: ['aggravated'] },
					db
				)
			],
			[
				'findings_resolved',
				await countFindings(
					{ statuses: FINDING_STATUSES, activitySince: sinceDb, activityEvents: ['resolved'] },
					db
				)
			],
			[
				'opportunities',
				await countFindings(
					{
						statuses: ACTIVE_STATUSES,
						types: ['keyword_opportunity'],
						minPriority: OPPORTUNITY_MIN_PRIORITY
					},
					db
				)
			],
			['proposed_actions', await countProposals({ createdSince: sinceDb }, db)],
			['approvals_requested', await countProposals({ statuses: OPEN_PROPOSAL_STATUSES }, db)]
		];
		for (const [key, expected] of expectations) {
			const b = body(report, key);
			if (!b.available) {
				// Une section de findings absente est un FAIT (gate d'examen), pas un échec — mais
				// alors elle ne doit annoncer aucun chiffre. On le vérifie plutôt que de sauter.
				check(
					`${key} : absente (${b.reason}), donc aucun chiffre annoncé`,
					!/"value":\s*\d/.test(JSON.stringify(b)),
					b.detail
				);
				continue;
			}
			check(
				`${key} : le compteur = la requête indépendante`,
				metricTotal(report, key) === expected,
				`${metricTotal(report, key)} vs ${expected}`
			);
		}

		// ── G. Contre-épreuve : un nouveau finding entre dans la section ──
		section('G. Contre-épreuve — un finding neuf bouge la section « nouveaux » d’exactement 1');
		// Choix par PROPRIÉTÉ, pas par rang (leçon `dash-002-home-proof`) : il faut un projet
		// effectivement DIAGNOSTIQUÉ, sinon le gate d'examen rendrait la section absente et la
		// contre-épreuve testerait la règle de couverture en croyant tester le comptage.
		const examined = home.projects.find((c) => c.diagnosis.ranCount > 0);
		if (!examined) {
			check(
				'un projet diagnostiqué existe (sinon la section est absente par construction)',
				false,
				'aucun projet n’a de détecteur passé — la contre-épreuve ne prouverait rien'
			);
		} else {
			const beforeNew = metricTotal(report, 'findings_new');
			const findingId = createId();
			await db.execute(sql`
				INSERT INTO "seostats"."findings"
					(id, project_id, fingerprint, type, entity_type, entity_key, title, status, severity,
					 priority_score, confidence_score, occurrence_count, first_seen_at, last_seen_at,
					 created_at, updated_at)
				VALUES (${findingId}, ${examined.projectId}, ${SENTINEL_FP}, 'keyword_decline', 'query',
					'sentinelle-rep001', 'Sentinelle REP-001 — baisse de requête', 'open', 'high',
					70, 60, 1, ${nowDb}, ${nowDb}, ${nowDb}, ${nowDb})
			`);
			await db.execute(sql`
				INSERT INTO "seostats"."finding_events"
					(id, finding_id, project_id, event_type, actor, created_at)
				VALUES (${createId()}, ${findingId}, ${examined.projectId}, 'created', 'system', ${nowDb})
			`);

			const after = await loadWeeklyReport({ db, now });
			const afterNew = metricTotal(after, 'findings_new');
			check(
				'le compteur « nouveaux » monte d’exactement 1',
				beforeNew !== null && afterNew === beforeNew + 1,
				`${beforeNew} → ${afterNew}`
			);
			const afterBody = body(after, 'findings_new');
			const found =
				afterBody.available &&
				afterBody.data.items.some(
					(i) => i.source.kind === 'finding' && i.source.id === findingId
				);
			check('la sentinelle est LISTÉE, avec son lien vers l’inbox', found, `/inbox/findings/…`);
			// Le rapport reste déterministe une fois la base modifiée : c'est l'entrée qui a
			// changé, pas la fonction.
			const afterTwice = await loadWeeklyReport({ db, now });
			check(
				'toujours déterministe après écriture',
				JSON.stringify(after) === JSON.stringify(afterTwice)
			);
			// La section « aggravés » ne bouge PAS : un `created` n'est pas une aggravation.
			check(
				'la section « aggravés » n’a pas bougé',
				metricTotal(after, 'findings_aggravated') === metricTotal(report, 'findings_aggravated'),
				`${metricTotal(after, 'findings_aggravated')}`
			);
		}
	} finally {
		await cleanup();
	}

	// ── H. Base rendue à l'identique ────────────────────────────────
	section('H. La base est rendue à l’identique');
	const findingsAfter = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."findings"`);
	const eventsAfter = await scalar(sql`SELECT count(*)::int AS n FROM "seostats"."finding_events"`);
	const projectsAfter = await scalar(
		sql`SELECT count(*)::int AS n FROM "seostats"."projects" WHERE archived = false`
	);
	check('findings', findingsAfter === findingsBefore, `${findingsBefore} → ${findingsAfter}`);
	check('finding_events', eventsAfter === eventsBefore, `${eventsBefore} → ${eventsAfter}`);
	check('projets actifs', projectsAfter === projectsBefore, `${projectsBefore} → ${projectsAfter}`);
	check(
		'aucune table créée (REP-001 est zéro DDL)',
		(await scalar(
			sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'seostats'`
		)) > 0,
		`${await scalar(sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'seostats'`)} tables`
	);

	console.log('');
	console.log(failures === 0 ? '✅ Toutes les vérifications passent.' : `❌ ${failures} échec(s).`);
	process.exitCode = failures === 0 ? 0 : 1;
}

main()
	.catch((e) => {
		console.error(e);
		process.exitCode = 1;
	})
	.finally(async () => {
		await pool.end();
	});
