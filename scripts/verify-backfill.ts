/**
 * DATA (migrate) — Vérification READ-ONLY du backfill des observations.
 *
 * 100 % SELECT. Contrôle les invariants du backfill (cf. backfill-observations.ts) :
 *   A. #gsc_query_page_observations == #(clés d'upsert distinctes) en source
 *   B. Σ impressions page == Σ impressions query_page (le rollup conserve la masse)
 *   C. #gmb_insight_observations == #(location,date,metric) distincts en source
 *   D. keyword_rank_observations ⊆ tracked_keywords non archivés (zéro orphelin)
 *      ET #keyword_rank_observations == #(clés candidates distinctes)
 *
 * Lancer : npx tsx scripts/verify-backfill.ts   (exit 1 si un invariant échoue)
 */
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let failed = false;
function check(label: string, pass: boolean, detail: string): void {
	console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label} — ${detail}`);
	if (!pass) failed = true;
}
const n = (v: unknown) => Number(v ?? 0);

async function main() {
	// A. query_page
	const a = (
		await pool.query(
			`SELECT
			   (SELECT count(*) FROM seostats.gsc_query_page_data) AS src_rows,
			   (SELECT count(*) FROM (SELECT DISTINCT project_id, week_start, query, page, device
			                            FROM seostats.gsc_query_page_data) d) AS src_distinct,
			   (SELECT count(*) FROM seostats.gsc_query_page_observations) AS obs`
		)
	).rows[0];
	check(
		'A gsc_query_page',
		n(a.obs) === n(a.src_distinct),
		`obs=${n(a.obs)} · clés distinctes=${n(a.src_distinct)} · lignes source=${n(a.src_rows)} (doublons dédupliqués=${n(a.src_rows) - n(a.src_distinct)})`
	);

	// B. rollup page conserve la masse d'impressions
	const b = (
		await pool.query(
			`SELECT
			   (SELECT coalesce(sum(impressions),0) FROM seostats.gsc_query_page_observations) AS qp_imp,
			   (SELECT coalesce(sum(impressions),0) FROM seostats.gsc_page_observations) AS page_imp`
		)
	).rows[0];
	check(
		'B gsc_page rollup',
		n(b.qp_imp) === n(b.page_imp),
		`Σ impressions query_page=${n(b.qp_imp)} · Σ impressions page=${n(b.page_imp)}`
	);

	// C. gmb_insight
	const c = (
		await pool.query(
			`SELECT
			   (SELECT count(*) FROM (SELECT DISTINCT gmb_location_id, date, metric
			                            FROM seostats.gmb_insights_daily) d) AS src_distinct,
			   (SELECT count(*) FROM seostats.gmb_insight_observations) AS obs`
		)
	).rows[0];
	check(
		'C gmb_insight',
		n(c.obs) === n(c.src_distinct),
		`obs=${n(c.obs)} · clés distinctes source=${n(c.src_distinct)}`
	);

	// D. keyword_rank : sous-ensemble tracked + comptage attendu
	const d = (
		await pool.query(
			`SELECT
			   (SELECT count(*) FROM seostats.keyword_rank_observations) AS obs,
			   (SELECT count(*) FROM seostats.keyword_rank_observations kro
			      WHERE NOT EXISTS (
			        SELECT 1 FROM seostats.tracked_keywords tk
			         WHERE tk.project_id = kro.project_id AND tk.keyword = kro.keyword
			           AND tk.archived = false)) AS orphans,
			   (SELECT count(*) FROM (
			      SELECT DISTINCT gqp.project_id, tk.keyword, gqp.device, gqp.week_start
			        FROM seostats.tracked_keywords tk
			        JOIN seostats.gsc_query_page_data gqp
			          ON gqp.project_id = tk.project_id AND gqp.query = tk.keyword
			       WHERE tk.archived = false) d) AS expected`
		)
	).rows[0];
	check('D keyword_rank orphans', n(d.orphans) === 0, `orphelins hors watchlist=${n(d.orphans)}`);
	check(
		'D keyword_rank count',
		n(d.obs) === n(d.expected),
		`obs=${n(d.obs)} · clés candidates distinctes=${n(d.expected)}`
	);

	console.log(failed ? '\nVérification : ÉCHEC (voir FAIL ci-dessus).' : '\nVérification : OK.');
	await pool.end();
	if (failed) process.exitCode = 1;
}

main().catch(async (err) => {
	console.error('Vérification échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
