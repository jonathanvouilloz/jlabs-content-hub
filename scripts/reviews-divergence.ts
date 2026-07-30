/**
 * GMB-007 — « Le hub croit avoir répondu, Google ne le confirme pas » : combien, et lesquels ?
 *
 * LECTURE SEULE. N'écrit jamais, n'a pas de `--execute`.
 *
 *   npx tsx scripts/reviews-divergence.ts            # partition depuis la base
 *   npx tsx scripts/reviews-divergence.ts --probe    # + interroge Google pour trancher
 *
 * POURQUOI CE SCRIPT EXISTE. Le prédicat `replied_at IS NOT NULL AND remote_reply_at IS NULL`
 * se tape en une ligne de SQL et se lit « divergence ». Il a produit un chiffre de 88 dans un
 * audit du 2026-07-30, et ce chiffre était FAUX : les 88 lignes avaient `last_seen_at IS NULL`,
 * c'est-à-dire que Google n'avait JAMAIS été lu pour elles. « Je n'ai pas regardé » se lisait
 * « Google dit non ». C'est la règle « absent ≠ zéro » (REP-001) appliquée à une colonne, et
 * c'est exactement la garde que le détecteur porte déjà (`review-pending-state.ts` : `!lastSeenAt
 * ⇒ neverSeen, continue`, AVANT le compteur `divergent`).
 *
 * Ce script rend la partition du détecteur interrogeable en dehors d'un run, pour qu'un audit
 * n'ait plus à retaper le prédicat nu. Les quatre classes ne se recouvrent pas :
 *
 *   RÉELLE   fiche fraîche + en succès, ligne vue à la dernière synchro, aucune réponse
 *            distante ⇒ le hub et Google se contredisent VRAIMENT. C'est le seul cas GMB-007.
 *   DISPARUE vue, mais avant la dernière synchro réussie ⇒ Google ne renvoie plus cet avis.
 *   NON LUE  `last_seen_at IS NULL` ⇒ état distant jamais lu. Indécidable, et c'est un fait,
 *            pas une absence de fait.
 *   HORS     la fiche elle-même n'est ni fraîche ni en succès ⇒ rien n'est jugeable.
 *
 * `--probe` tranche le cas NON LUE en demandant à Google, sans rien écrire : une ligne absente
 * de la réponse de Google n'est pas une divergence, c'est un avis qui n'existe plus.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { getGmbAccessToken, getGmbAccountId } from '../src/lib/server/gmb-auth.js';

neonConfig.webSocketConstructor = ws;

const PROBE = process.argv.includes('--probe');
const projectArg = (() => {
	const i = process.argv.indexOf('--project');
	return i === -1 ? null : (process.argv[i + 1] ?? null);
})();

/** Même seuil que le détecteur : au-delà, une fiche n'est plus « fraîche ». */
const SYNC_FRESHNESS_HOURS = 48;

async function main() {
	const pool = new Pool({ connectionString: process.env.DATABASE_URL });
	const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

	const rows = await q(
		`
		SELECT p.slug, r.review_id, r.location_id, r.location_label, r.rating, r.create_time,
		       r.replied_at, r.last_seen_at, l.last_sync_at, l.last_sync_status
		FROM seostats.gmb_reviews r
		JOIN seostats.projects p ON p.id = r.project_id
		LEFT JOIN seostats.project_gmb_locations l
		       ON l.gmb_location_id = r.location_id AND l.project_id = r.project_id
		WHERE r.replied_at IS NOT NULL AND r.remote_reply_at IS NULL
		  AND ($1::text IS NULL OR p.slug = $1)
		ORDER BY p.slug, r.location_label, r.create_time DESC
	`,
		[projectArg]
	);

	const nowMs = Date.now();
	const classes = { reelle: [] as any[], disparue: [] as any[], nonLue: [] as any[], hors: [] as any[] };

	for (const r of rows) {
		const syncMs = r.last_sync_at ? Date.parse(String(r.last_sync_at).replace(' ', 'T') + 'Z') : NaN;
		const fresh =
			r.last_sync_status === 'success' &&
			Number.isFinite(syncMs) &&
			(nowMs - syncMs) / 3_600_000 <= SYNC_FRESHNESS_HOURS;
		if (!fresh) classes.hors.push(r);
		else if (!r.last_seen_at) classes.nonLue.push(r);
		else {
			const seenMs = Date.parse(String(r.last_seen_at).replace(' ', 'T') + 'Z');
			if (Number.isFinite(seenMs) && Number.isFinite(syncMs) && seenMs < syncMs)
				classes.disparue.push(r);
			else classes.reelle.push(r);
		}
	}

	console.log(`\n=== replied_at renseigné, remote_reply_at vide : ${rows.length} ligne(s) ===`);
	console.log(`  RÉELLE   ${classes.reelle.length}\tdivergence GMB-007 — le hub et Google se contredisent`);
	console.log(`  DISPARUE ${classes.disparue.length}\tGoogle ne renvoie plus cet avis`);
	console.log(`  NON LUE  ${classes.nonLue.length}\tétat distant jamais lu — indécidable sans --probe`);
	console.log(`  HORS     ${classes.hors.length}\tfiche ni fraîche ni en succès — rien n'est jugeable`);

	for (const r of classes.reelle)
		console.log(
			`  ⚠️ RÉELLE ${r.slug} · ${r.location_label} · ${r.review_id} · répondu ${r.replied_at}`
		);

	// Les deux classes que la base ne peut pas trancher : jamais lue, ou fiche pas à jour.
	// `--probe` les traite ensemble — demander à Google remplace le savoir local manquant,
	// que le manque vienne de la ligne ou de la fraîcheur de sa fiche.
	const indecidables = [...classes.nonLue, ...classes.hors];
	if (!PROBE || indecidables.length === 0) {
		if (indecidables.length)
			console.log(`\nRelancer avec --probe pour trancher les ${indecidables.length} indécidable(s).`);
		await pool.end();
		return;
	}

	// ── --probe : demander à Google, sans rien écrire ────────────────────────────────────
	const db = drizzle(pool, { schema }) as unknown as AppDb;
	const token = await getGmbAccessToken(db);
	const accountId = await getGmbAccountId(db);
	const byLocation = new Map<string, any[]>();
	for (const r of indecidables) {
		const list = byLocation.get(r.location_id) ?? [];
		list.push(r);
		byLocation.set(r.location_id, list);
	}

	let absents = 0;
	let presents = 0;
	console.log(`\n=== --probe : ${byLocation.size} fiche(s) interrogée(s) chez Google ===`);
	for (const [locationId, list] of byLocation) {
		const locId = locationId.replace(/^locations\//, '');
		const keys = new Set<string>();
		let pageToken: string | undefined;
		let pages = 0;
		do {
			const params = new URLSearchParams({ pageSize: '50' });
			if (pageToken) params.set('pageToken', pageToken);
			const res = await fetch(
				`https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locId}/reviews?${params}`,
				{ headers: { Authorization: `Bearer ${token}` } }
			);
			if (!res.ok) {
				console.error(`  ${list[0].location_label} : HTTP ${res.status} — fiche non tranchée`);
				keys.clear();
				break;
			}
			const data = (await res.json()) as { reviews?: Array<{ name?: string }>; nextPageToken?: string };
			for (const rev of data.reviews ?? []) {
				const name = String(rev.name ?? '');
				const key = name.slice(name.lastIndexOf('/') + 1);
				if (key) keys.add(key);
			}
			pageToken = data.nextPageToken;
			pages += 1;
		} while (pageToken && pages < 200);

		if (keys.size === 0) continue;
		const encore = list.filter((r) => keys.has(r.review_id));
		absents += list.length - encore.length;
		presents += encore.length;
		console.log(
			`  ${list[0].location_label} : ${keys.size} avis chez Google · ${list.length - encore.length} disparu(s) · ${encore.length} encore présent(s)`
		);
		for (const r of encore)
			console.log(`    ⚠️ ENCORE CHEZ GOOGLE, sans réponse distante : ${r.review_id}`);
	}

	console.log(
		`\n${absents} ligne(s) tranchée(s) en « l'avis n'existe plus chez Google » — pas une divergence.` +
			`\n${presents} ligne(s) restent une divergence à instruire.`
	);
	await pool.end();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
