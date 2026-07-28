/**
 * GMB-002 — Application déterministe du DDL additif (drizzle/manual-gmb-002.sql).
 *
 * Ajoute 4 colonnes à `seostats.gmb_reviews` (l'état DISTANT d'un avis) et 3 à
 * `seostats.project_gmb_locations` (la santé de la synchro), plus 2 index. Aucune table
 * créée, aucun DROP, aucune donnée réécrite : les colonnes naissent NULL partout, ce qui est
 * exactement l'état « jamais lu chez Google ». Appliquer ce DDL ne change donc aucun
 * comportement — c'est le collecteur (T4) qui commence à les écrire, et le détecteur du lot 2
 * qui commence à les lire.
 *
 * Lancer : npx tsx scripts/apply-gmb-002.ts
 * Vérif  : npx tsx scripts/data-001-cartography.ts post-gmb-002   (attendu 61 tables)
 *
 * ⚠ L'introspection reste à 61 tables `seostats`. Un écart ici serait une erreur, pas un
 *   effet attendu. Rappel de la convention (DECISIONS.md, DATA-002) : SQL additif idempotent
 *   + ce script, JAMAIS `db:push` (interactif et moins déterministe sous Windows).
 *
 * ⚠ Ce script VÉRIFIE que les colonnes sont bien nullables et sans DEFAULT. Ce n'est pas du
 *   zèle : un DEFAULT sur `last_seen_at` ferait croire au détecteur du lot 2 que chaque ligne
 *   héritée a été observée, et il jugerait l'état distant d'avis dont personne n'a jamais lu
 *   l'état distant. La garde vaut mieux en base qu'en commentaire.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Colonnes ajoutées par ce lot, par table. Toutes doivent être nullables et sans DEFAULT. */
const ADDED: Record<string, string[]> = {
	gmb_reviews: ['last_seen_at', 'remote_reply_at', 'remote_reply_text', 'remote_update_at'],
	project_gmb_locations: ['last_sync_at', 'last_sync_error', 'last_sync_status']
};

/** Compte total attendu APRÈS application (13 + 4, et 6 + 3). */
const EXPECTED_TOTAL: Record<string, number> = {
	gmb_reviews: 17,
	project_gmb_locations: 9
};

const EXPECTED_INDEXES = [
	'idx_gmb_reviews_project_last_seen',
	'idx_gmb_reviews_project_rating_created'
];

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures += 1;
}

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, '..', 'drizzle', 'manual-gmb-002.sql');
	const sql = readFileSync(sqlPath, 'utf8');

	console.log(`Application de ${sqlPath} …`);
	await pool.query(sql);
	console.log('DDL GMB-002 appliqué (idempotent).\n');

	for (const [table, added] of Object.entries(ADDED)) {
		console.log(`Table ${table} :`);
		const { rows } = await pool.query<{
			column_name: string;
			is_nullable: string;
			column_default: string | null;
		}>(
			`SELECT column_name, is_nullable, column_default FROM information_schema.columns
			  WHERE table_schema = 'seostats' AND table_name = $1
			  ORDER BY column_name`,
			[table]
		);
		const present = rows.map((r) => r.column_name);
		check(
			`${rows.length} colonnes (${EXPECTED_TOTAL[table]} attendues)`,
			rows.length === EXPECTED_TOTAL[table],
			present.join(', ')
		);

		for (const col of added) {
			const row = rows.find((r) => r.column_name === col);
			if (!row) {
				check(`${col} présente`, false);
				continue;
			}
			// Nullable ET sans DEFAULT : NULL doit rester un état atteignable et signifiant.
			check(
				`${col} nullable et sans DEFAULT`,
				row.is_nullable === 'YES' && row.column_default === null,
				`nullable=${row.is_nullable} default=${row.column_default ?? '∅'}`
			);
		}
		console.log('');
	}

	const { rows: idxRows } = await pool.query<{ indexname: string }>(
		`SELECT indexname FROM pg_indexes
		  WHERE schemaname = 'seostats' AND tablename = 'gmb_reviews'
		  ORDER BY indexname`
	);
	const idx = idxRows.map((r) => r.indexname);
	console.log(`Index gmb_reviews : ${idx.join(', ') || '∅'}`);
	for (const want of EXPECTED_INDEXES) check(want, idx.includes(want));

	// Aucune table créée : l'écart d'introspection doit être NUL.
	const { rows: tableRows } = await pool.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM information_schema.tables
		  WHERE table_schema = 'seostats' AND table_type = 'BASE TABLE'`
	);
	console.log('');
	check(`61 tables seostats (aucune créée)`, tableRows[0]?.n === '61', `trouvé ${tableRows[0]?.n}`);

	// La normalisation de `review_id` est la SEULE écriture du DDL, et la seule chose qui
	// empêche la première collecte d'insérer 382 doublons au lieu de réconcilier.
	const { rows: keyRows } = await pool.query<{ paths: string; total: string; distincts: string }>(
		`SELECT count(*) FILTER (WHERE review_id LIKE '%/%')::text AS paths,
		        count(*)::text AS total,
		        count(DISTINCT review_id)::text AS distincts
		   FROM "seostats"."gmb_reviews"`
	);
	const k = keyRows[0];
	console.log('');
	check(
		'review_id normalisé (aucun path résiduel)',
		k?.paths === '0',
		`${k?.paths ?? '?'} path(s) sur ${k?.total ?? '?'} lignes`
	);
	// Une collision aurait fait échouer l'UPDATE (unique global) — cette égalité le confirme
	// après coup plutôt que de le supposer.
	check(
		'aucune collision de clé',
		k?.total === k?.distincts,
		`${k?.total ?? '?'} lignes / ${k?.distincts ?? '?'} clés distinctes`
	);

	// Les colonnes naissent VIDES. Un contenu non nul ici voudrait dire que le collecteur a
	// déjà tourné (réapplication) — pas une erreur, mais ça doit se voir.
	const { rows: fillRows } = await pool.query<{ seen: string; remote: string; total: string }>(
		`SELECT count(*) FILTER (WHERE last_seen_at IS NOT NULL)::text AS seen,
		        count(*) FILTER (WHERE remote_reply_at IS NOT NULL)::text AS remote,
		        count(*)::text AS total
		   FROM "seostats"."gmb_reviews"`
	);
	const f = fillRows[0];
	console.log(
		`\n  gmb_reviews : ${f?.total ?? '?'} lignes · last_seen_at renseigné ${f?.seen ?? '?'} · ` +
			`remote_reply_at renseigné ${f?.remote ?? '?'} (0 et 0 attendus à la première application)`
	);

	await pool.end();
	if (failures > 0) {
		console.error(`\n${failures} vérification(s) en échec.`);
		process.exitCode = 1;
	} else {
		console.log('\nToutes les vérifications passent.');
	}
}

main().catch(async (err) => {
	console.error('Application échouée:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
