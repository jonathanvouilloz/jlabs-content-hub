/**
 * GMB-002 — Lancer la collecte d'avis à la main, projet par projet.
 *
 * DRY-RUN PAR DÉFAUT, comme `limits.ts`, `pauses.ts` et `rep-004-archive.ts` : la première
 * collecte réconciliante touche l'historique complet de fiches réelles, elle se lit avant de
 * s'écrire. En dry-run, les appels Google partent bel et bien (c'est ce qu'on veut mesurer)
 * mais AUCUNE ligne n'est écrite.
 *
 * Lancer :
 *   npx tsx scripts/collect-reviews.ts                       # dry-run, tous les projets
 *   npx tsx scripts/collect-reviews.ts --project lecureux    # dry-run, un projet
 *   npx tsx scripts/collect-reviews.ts --execute             # écrit
 *
 * ⚠️ Le `.env` local pointe la base de PROD. Sans `--dry-run`, ce script écrit dans la vraie
 *    base — et consomme le quota du compte Google réel dans les deux cas.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { asc, eq } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import { projects } from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { collectGmbReviews } from '../src/lib/server/collectors/gmb-reviews.js';
import { gmbReviewDeps } from '../src/lib/server/gmb-auth.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const option = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};
const ONLY = option('project');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

async function main() {
	const rows = await db
		.select({ id: projects.id, slug: projects.slug })
		.from(projects)
		.where(eq(projects.archived, false))
		.orderBy(asc(projects.slug));

	const targets = ONLY ? rows.filter((r) => r.slug === ONLY) : rows;
	if (targets.length === 0) {
		console.error(`Projet inconnu ou archivé : « ${ONLY} ». Abandon.`);
		await pool.end();
		process.exit(1);
	}

	console.log(`\nMode : ${EXECUTE ? 'ÉCRITURE' : 'DRY-RUN (aucune écriture)'}`);
	console.log(`Projets : ${targets.length}\n`);

	// `persist: false` — un outil de diagnostic lancé à la main n'a pas à faire une course en
	// écriture avec le tick sur l'unique ligne de credential Google.
	const deps = gmbReviewDeps(db, { persist: false });
	let totalSeen = 0;
	let totalInserted = 0;
	let totalUpdated = 0;
	let failures = 0;

	for (const p of targets) {
		try {
			const res = await collectGmbReviews({
				projectId: p.id,
				deps,
				client: db,
				dryRun: !EXECUTE
			});
			if (res.skippedReason === 'no_gmb_location') {
				console.log(`  ${p.slug.padEnd(16)} —  (aucune fiche GMB)`);
				continue;
			}
			const s = res.summary;
			totalSeen += s.seen;
			totalInserted += s.inserted;
			totalUpdated += s.updated;
			console.log(
				`  ${p.slug.padEnd(16)} ${String(s.locations).padStart(2)} fiche(s) · ` +
					`${String(s.seen).padStart(4)} avis vus · +${s.inserted} nouveaux · ` +
					`~${s.updated} réconciliés · =${s.unchanged} inchangés` +
					(s.failed > 0 ? ` · ⚠️ ${s.failed} fiche(s) en échec` : '') +
					(s.unreadable > 0 ? ` · ${s.unreadable} illisibles` : '') +
					(s.truncated ? ' · ⚠️ TRONQUÉ' : '')
			);
			for (const l of res.locations) {
				if (l.status === 'error') console.log(`      ❌ ${l.locationLabel} : ${l.error}`);
			}
		} catch (err) {
			failures += 1;
			console.log(`  ${p.slug.padEnd(16)} ❌ ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	console.log(
		`\nTotal : ${totalSeen} avis vus · ${totalInserted} nouveaux · ${totalUpdated} réconciliés` +
			(failures > 0 ? ` · ${failures} projet(s) en échec` : '')
	);
	if (!EXECUTE) console.log('(dry-run — ajouter --execute pour écrire)\n');

	await pool.end();
	if (failures > 0) process.exitCode = 1;
}

main().catch(async (err) => {
	console.error(err instanceof Error ? err.message : String(err));
	await pool.end().catch(() => {});
	process.exit(1);
});
