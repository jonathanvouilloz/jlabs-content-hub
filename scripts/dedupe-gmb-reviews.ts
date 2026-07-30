/**
 * GMB-002 — Dédupliquer `gmb_reviews` avant de normaliser `review_id`.
 *
 * DRY-RUN PAR DÉFAUT, comme `collect-reviews.ts`, `limits.ts` et `pauses.ts`.
 *
 *   npx tsx scripts/dedupe-gmb-reviews.ts             # cartographie, n'écrit rien
 *   npx tsx scripts/dedupe-gmb-reviews.ts --execute   # supprime les doublons dominés, puis normalise
 *
 * ⚠️ Le `.env` local pointe la base de PROD.
 *
 * LE SUJET. `drizzle/manual-gmb-002.sql` §4 normalise `review_id` (path complet → dernier
 * segment) sous la garde `LIKE '%/%'`, ce qui la rend idempotente. Mais la prod exécute encore
 * `/api/cron/gmb-reviews` (le commit qui le retire de `vercel.json` n'est pas déployé), et cet
 * ANCIEN collecteur écrit toujours le path complet. Depuis le 2026-07-28 il a donc réinséré des
 * lignes en ancien format À CÔTÉ de leur version normalisée : le même avis existe deux fois,
 * sous deux clés. Réappliquer §4 telle quelle échoue désormais sur
 * `gmb_reviews_review_id_unique` — le garde-fou fait son travail, mais il faut retirer les
 * doublons avant de pouvoir normaliser.
 *
 * LA RÈGLE DE SÛRETÉ. Une ligne en ancien format n'est supprimée que si son jumeau normalisé
 * la DOMINE : pour chaque colonne de contenu, soit les deux portent la même valeur, soit
 * l'ancienne est nulle. Une ancienne ligne qui porte quoi que ce soit que sa jumelle n'a pas
 * (un `draft_reply` rédigé, des `mentioned_employees`, une réponse distante lue) n'est PAS
 * supprimée : elle est signalée, et le script REFUSE d'écrire tant qu'il en reste une. Perdre
 * un brouillon de réponse écrit à la main est exactement le genre de dégât qu'une
 * déduplication automatique ne doit jamais pouvoir causer.
 *
 * `last_seen_at` est exclue de la comparaison : elle dit quand la ligne a été VUE, pas ce
 * qu'elle porte. Les lignes de l'ancien collecteur l'ont toutes à NULL par construction (il
 * ne l'écrit pas), et c'est précisément la marque « état distant jamais lu » du lot GMB-002.
 */
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

const EXECUTE = process.argv.includes('--execute');

/** Colonnes de CONTENU. `id`, `review_id` et `last_seen_at` en sont volontairement absentes. */
const CONTENT_COLUMNS = [
	'project_id',
	'location_id',
	'location_label',
	'author_name',
	'rating',
	'comment',
	'create_time',
	'draft_reply',
	'mentioned_employees',
	'replied_at',
	'remote_reply_text',
	'remote_reply_at',
	'remote_update_at'
] as const;

type Row = Record<string, unknown>;

function compare(oldRow: Row, newRow: Row) {
	const identical: string[] = [];
	const onlyOld: string[] = [];
	const conflicting: string[] = [];
	for (const c of CONTENT_COLUMNS) {
		const a = oldRow[c];
		const b = newRow[c];
		if (a === null || a === undefined) continue;
		if (b === null || b === undefined) onlyOld.push(c);
		else if (String(a) === String(b)) identical.push(c);
		else conflicting.push(c);
	}
	return { identical, onlyOld, conflicting };
}

async function main() {
	const pool = new Pool({ connectionString: process.env.DATABASE_URL });
	const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

	const [totals] = await q(`
		SELECT count(*)::int AS total,
		       count(*) FILTER (WHERE review_id LIKE '%/%')::int AS ancien_format,
		       count(*) FILTER (WHERE last_seen_at IS NULL)::int AS jamais_vues
		FROM seostats.gmb_reviews
	`);
	console.log(`\n=== ÉTAT — ${EXECUTE ? 'EXÉCUTION' : 'DRY-RUN'} ===`);
	console.log(
		`${totals.total} avis · ${totals.ancien_format} en ancien format · ${totals.jamais_vues} jamais vues par le nouveau collecteur`
	);

	const byProject = await q(`
		SELECT p.slug, count(*)::int AS n, min(r.create_time) AS plus_ancien, max(r.create_time) AS plus_recent
		FROM seostats.gmb_reviews r JOIN seostats.projects p ON p.id = r.project_id
		WHERE r.review_id LIKE '%/%'
		GROUP BY p.slug ORDER BY n DESC
	`);
	for (const p of byProject)
		console.log(`  ${p.slug} : ${p.n} (${p.plus_ancien} → ${p.plus_recent})`);

	// Deux lignes en ancien format qui se normaliseraient sur la même clé : la normalisation
	// échouerait ensuite sur l'unique. Aucun cas connu ; on le vérifie plutôt que de l'espérer.
	const selfCollide = await q(`
		SELECT split_part(review_id, '/', -1) AS cle, count(*)::int AS n
		FROM seostats.gmb_reviews WHERE review_id LIKE '%/%'
		GROUP BY 1 HAVING count(*) > 1
	`);
	if (selfCollide.length) {
		console.error(`\n⛔ ${selfCollide.length} clés portées par PLUSIEURS lignes en ancien format :`);
		for (const c of selfCollide) console.error(`   ${c.cle} × ${c.n}`);
	}

	const cols = ['id', 'review_id', 'last_seen_at', ...CONTENT_COLUMNS];
	const oldCols = cols.map((c) => `o.${c} AS "o_${c}"`).join(', ');
	const newCols = cols.map((c) => `n.${c} AS "n_${c}"`).join(', ');
	const pairs = await q(`
		SELECT ${oldCols}, ${newCols}
		FROM seostats.gmb_reviews o
		JOIN seostats.gmb_reviews n
		  ON n.review_id = split_part(o.review_id, '/', -1) AND n.id <> o.id
		WHERE o.review_id LIKE '%/%'
		ORDER BY o.create_time DESC
	`);

	const dominated: string[] = [];
	const retained: Array<{ oldId: string; newId: string; onlyOld: string[]; conflicting: string[] }> =
		[];

	console.log(`\n=== JUMEAUX : ${pairs.length} paire(s) ===`);
	for (const p of pairs) {
		const oldRow: Row = {};
		const newRow: Row = {};
		for (const c of cols) {
			oldRow[c] = p[`o_${c}`];
			newRow[c] = p[`n_${c}`];
		}
		const { onlyOld, conflicting } = compare(oldRow, newRow);
		const key = String(newRow.review_id);
		const head = `${key} · ${newRow.create_time} · ${newRow.rating}★ · ${newRow.location_label}`;
		if (onlyOld.length === 0 && conflicting.length === 0) {
			dominated.push(String(oldRow.id));
			console.log(`  ✔ dominé   ${head}`);
		} else {
			retained.push({
				oldId: String(oldRow.id),
				newId: String(newRow.id),
				onlyOld,
				conflicting
			});
			console.log(`  ⛔ RETENU  ${head}`);
			if (onlyOld.length)
				console.log(
					`       porté par l'ancienne seule : ${onlyOld.map((c) => `${c}=${JSON.stringify(oldRow[c])}`).join(', ')}`
				);
			for (const c of conflicting)
				console.log(
					`       divergent ${c} : ancienne=${JSON.stringify(oldRow[c])} · nouvelle=${JSON.stringify(newRow[c])}`
				);
		}
	}

	const orphans = await q(`
		SELECT o.id, o.review_id, o.create_time, o.rating, o.location_label,
		       o.draft_reply IS NOT NULL AS a_brouillon,
		       o.mentioned_employees IS NOT NULL AS a_mentions
		FROM seostats.gmb_reviews o
		WHERE o.review_id LIKE '%/%'
		  AND NOT EXISTS (
			SELECT 1 FROM seostats.gmb_reviews n
			WHERE n.review_id = split_part(o.review_id, '/', -1) AND n.id <> o.id
		  )
		ORDER BY o.create_time DESC
	`);
	console.log(`\n=== SANS JUMEAU : ${orphans.length} ligne(s) — à NORMALISER, jamais à supprimer ===`);
	for (const o of orphans)
		console.log(
			`  ${split(o.review_id)} · ${o.create_time} · ${o.rating}★ · ${o.location_label}` +
				`${o.a_brouillon ? ' · brouillon' : ''}${o.a_mentions ? ' · mentions' : ''}`
		);

	console.log(`\n=== PLAN ===`);
	console.log(`  supprimer  ${dominated.length} ligne(s) en ancien format dominées par leur jumelle`);
	console.log(`  normaliser ${orphans.length} ligne(s) sans jumelle (§4 de manual-gmb-002.sql)`);
	console.log(`  retenues   ${retained.length} ligne(s) — décision humaine`);

	const blocked = retained.length > 0 || selfCollide.length > 0;
	if (blocked) {
		console.error(
			`\n⛔ REFUS D'ÉCRIRE : ${retained.length} jumelle(s) non dominée(s), ${selfCollide.length} collision(s).` +
				`\n   Trancher ligne par ligne avant de relancer — rien n'a été touché.`
		);
		await pool.end();
		process.exit(1);
	}

	if (!EXECUTE) {
		console.log(`\nDRY-RUN — rien n'a été écrit. Relancer avec --execute.`);
		await pool.end();
		return;
	}

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		let deleted = 0;
		if (dominated.length) {
			const r = await client.query(
				`DELETE FROM seostats.gmb_reviews WHERE id = ANY($1::text[]) AND review_id LIKE '%/%'`,
				[dominated]
			);
			deleted = r.rowCount ?? 0;
		}
		// §4 de manual-gmb-002.sql, mot pour mot. Idempotente par sa garde.
		const upd = await client.query(`
			UPDATE seostats.gmb_reviews
			SET review_id = split_part(review_id, '/', -1)
			WHERE review_id LIKE '%/%'
			  AND split_part(review_id, '/', -1) <> ''
		`);
		const [after] = (
			await client.query(
				`SELECT count(*)::int AS total, count(*) FILTER (WHERE review_id LIKE '%/%')::int AS ancien_format
				 FROM seostats.gmb_reviews`
			)
		).rows;
		if (after.ancien_format !== 0) throw new Error(`${after.ancien_format} ligne(s) toujours en ancien format`);
		await client.query('COMMIT');
		console.log(
			`\n✅ ${deleted} supprimée(s), ${upd.rowCount} normalisée(s). Reste ${after.total} avis, 0 en ancien format.`
		);
	} catch (e) {
		await client.query('ROLLBACK');
		console.error('\n⛔ ROLLBACK —', e);
		process.exitCode = 1;
	} finally {
		client.release();
		await pool.end();
	}
}

function split(v: unknown) {
	const s = String(v);
	const i = s.lastIndexOf('/');
	return i === -1 ? s : s.slice(i + 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
