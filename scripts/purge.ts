/**
 * DATA-008 — Runner de rétention/purge. DRY-RUN par défaut (SPEC §7.11).
 *
 * - Seed idempotent des politiques de rétention (config, non destructif).
 * - Plan de purge : pour chaque type PURGEABLE, compte exactement les lignes et
 *   liste les périodes (mois) qui SERAIENT touchées, et les agrégats à produire
 *   avant purge. Les types protégés (agrégats, findings, décisions, audit, rapports)
 *   sont listés « conservés sans limite » ; l'audit est marqué « suppression = L4 ».
 * - `--execute` : REFUSÉ dans le périmètre expand+dry-run (aucune suppression réelle).
 *   La suppression destructive (agrégation → delete par lots, reprise, L4 pour audit)
 *   sera activée dans une session dédiée avec accès + validation explicites.
 *
 * Lancer (dry-run) : npx tsx scripts/purge.ts
 * Options          : --now=YYYY-MM-DD (fige la date de référence)
 *
 * Invariants (module pur retention-state.ts) : isPurgeable (protégé/infini jamais
 * purgé), requiresL4ForPurge (audit = L4), computeCutoff (fenêtre de rétention).
 */
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import {
	RETENTION_DEFAULTS,
	isPurgeable,
	requiresL4ForPurge,
	computeCutoff
} from '../src/lib/server/retention-state.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const nowArg = args.find((a) => a.startsWith('--now='))?.split('=')[1];
const NOW = nowArg ? `${nowArg}T00:00:00Z` : new Date().toISOString();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seedPolicies() {
	for (const d of RETENTION_DEFAULTS) {
		await pool.query(
			`INSERT INTO "seostats"."retention_policies"
			  (id, data_type, category, retention_days, aggregate_before_purge, requires_l4,
			   protected, source_table, timestamp_column, description, active)
			 VALUES (gen_random_uuid()::text, $1,$2,$3,$4,$5,$6,$7,$8,$9,true)
			 ON CONFLICT (data_type) DO UPDATE SET
			   category=EXCLUDED.category, retention_days=EXCLUDED.retention_days,
			   aggregate_before_purge=EXCLUDED.aggregate_before_purge, requires_l4=EXCLUDED.requires_l4,
			   protected=EXCLUDED.protected, source_table=EXCLUDED.source_table,
			   timestamp_column=EXCLUDED.timestamp_column, description=EXCLUDED.description,
			   updated_at=(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))`,
			[
				d.dataType,
				d.category,
				d.retentionDays,
				d.aggregateBeforePurge,
				d.requiresL4,
				d.protected,
				d.sourceTable,
				d.timestampColumn,
				d.description
			]
		);
	}
	console.log(`Politiques de rétention seedées (${RETENTION_DEFAULTS.length}, idempotent).`);
}

interface PlanRow {
	dataType: string;
	verdict: string;
	rows: number;
	periods: string[];
}

async function planPurgeable(d: (typeof RETENTION_DEFAULTS)[number]): Promise<PlanRow> {
	if (!d.sourceTable || !d.timestampColumn) {
		return { dataType: d.dataType, verdict: 'logique (runner non câblé)', rows: 0, periods: [] };
	}
	const cutoff = computeCutoff(NOW, d.retentionDays as number).slice(0, 10);
	const col = d.timestampColumn;
	const tbl = d.sourceTable;
	// Colonne/table injectées depuis la config interne (jamais l'utilisateur) → sûr.
	const countRes = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM "seostats"."${tbl}" WHERE "${col}" < $1`,
		[cutoff]
	);
	const rows = Number(countRes.rows[0].n);
	const periodRes = await pool.query<{ p: string }>(
		`SELECT DISTINCT substr("${col}", 1, 7) AS p FROM "seostats"."${tbl}"
		  WHERE "${col}" < $1 ORDER BY p`,
		[cutoff]
	);
	const periods = periodRes.rows.map((r) => r.p);
	return {
		dataType: d.dataType,
		verdict: `purge >${cutoff}${d.aggregateBeforePurge ? ' (après agrégation)' : ''}`,
		rows,
		periods
	};
}

async function main() {
	console.log(`\n=== DATA-008 purge — ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} — réf. ${NOW} ===\n`);

	if (EXECUTE) {
		console.error(
			'REFUSÉ : exécution destructive différée (périmètre DATA-008 = expand + dry-run).\n' +
				'La suppression réelle (agrégation → delete par lots, reprise, L4 pour audit) sera\n' +
				'activée dans une session dédiée avec accès et validation explicites.'
		);
		await pool.end();
		process.exit(2);
	}

	await seedPolicies();
	console.log('');

	let totalPurgeable = 0;
	for (const d of RETENTION_DEFAULTS) {
		if (isPurgeable(d)) {
			const plan = await planPurgeable(d);
			totalPurgeable += plan.rows;
			console.log(`• ${plan.dataType} — ${plan.verdict}`);
			console.log(`    lignes touchées : ${plan.rows}`);
			console.log(`    périodes (mois) : ${plan.periods.length ? plan.periods.join(', ') : '∅'}`);
		} else {
			const l4 = requiresL4ForPurge(d) ? ' · suppression = L4' : '';
			console.log(`• ${d.dataType} — CONSERVÉ sans limite (protégé)${l4}`);
		}
	}

	console.log(`\nTotal lignes qui SERAIENT purgées : ${totalPurgeable} (aucune supprimée — dry-run).`);
	await pool.end();
}

main().catch(async (err) => {
	console.error('Plan de purge échoué:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
