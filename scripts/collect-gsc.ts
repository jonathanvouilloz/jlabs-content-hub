/**
 * GSC-001/GSC-002 — Runner du collecteur GSC `query × page × device`.
 *
 * Appelle l'API Search Analytics pour UNE semaine et écrit les observations
 * (DATA-004) + les tables legacy + le diff hebdo. Idempotent : rejouer la même
 * semaine rafraîchit les mêmes lignes (unique projet+période+dimensions), il n'en
 * crée aucune.
 *
 * Pattern runner (cf. detect.ts / backfill-observations.ts) : Pool propre + drizzle
 * autonome, injecté dans les modules serveur. Toute la logique de jugement vit dans
 * le module PUR src/lib/server/collectors/gsc-collector-state.ts (vitest).
 *
 * ⚠️ Ce runner CONSOMME du quota GSC réel, sur un compte que les 6 projets
 * partagent. `--dry-run` lit sans écrire (le quota est consommé quand même) ;
 * `--test-access` ne consomme presque rien et ne collecte pas.
 *
 * Diagnostic seul  : npx tsx scripts/collect-gsc.ts --project=<slug> --test-access
 * Lancer (à blanc) : npx tsx scripts/collect-gsc.ts --project=<slug> --dry-run
 * Lancer (réel)    : npx tsx scripts/collect-gsc.ts --project=<slug>
 * Tous les projets : npx tsx scripts/collect-gsc.ts --project=all
 * Options          : --week=YYYY-MM-DD  --skip-legacy
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { collectGscQueryPage } from '../src/lib/server/collectors/gsc-query-page.js';
import { listGscProjects, testGscAccess } from '../src/lib/server/gsc-auth.js';
import { classifyJobFailure } from '../src/lib/server/job-retry.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}
if (!process.env.ENCRYPTION_KEY) {
	console.error('ENCRYPTION_KEY absente (.env) : les service accounts sont illisibles. Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TEST_ACCESS = args.includes('--test-access');
const SKIP_LEGACY = args.includes('--skip-legacy');
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const PROJECT = arg('project') ?? 'all';
const WEEK = arg('week') ?? null;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

async function main(): Promise<void> {
	const all = await listGscProjects({ client: db });
	const targets = PROJECT === 'all' ? all : all.filter((p) => p.slug === PROJECT);

	if (targets.length === 0) {
		console.error(
			PROJECT === 'all'
				? 'Aucun projet actif avec une propriété GSC configurée.'
				: `Projet "${PROJECT}" introuvable, archivé, ou sans site_url.`
		);
		process.exitCode = 1;
		return;
	}

	console.log(
		`${targets.length} projet(s) · semaine ${WEEK ?? '(dernière complète)'}` +
			`${DRY_RUN ? ' · DRY-RUN' : ''}${SKIP_LEGACY ? ' · sans legacy' : ''}`
	);
	console.log('');

	let failed = 0;

	for (const project of targets) {
		if (TEST_ACCESS) {
			const res = await testGscAccess(project.id, { client: db });
			const mark = res.ok ? 'OK  ' : 'ECHEC';
			console.log(`${mark} ${project.slug.padEnd(16)} ${res.reason.padEnd(16)} ${res.message}`);
			if (!res.ok) failed++;
			continue;
		}

		try {
			const res = await collectGscQueryPage({
				projectId: project.id,
				weekStart: WEEK,
				dryRun: DRY_RUN,
				skipLegacy: SKIP_LEGACY,
				client: db,
				deps: { client: db }
			});
			console.log(
				`OK   ${project.slug.padEnd(16)} ${res.weekStart} · ${res.pages} page(s) · ` +
					`${res.rows} ligne(s)${res.duplicates ? ` (${res.duplicates} dédup.)` : ''} · ` +
					`${res.totals.totalClicks} clics / ${res.totals.totalImpressions} impressions · ` +
					`${res.pageRows} page-obs · ${res.durationMs} ms`
			);
		} catch (err) {
			failed++;
			// La CLASSE est ce qui compte : c'est ce que la file lira pour décider de
			// rejouer, de reporter ou de condamner. L'afficher ici évite de
			// diagnostiquer sur le seul texte du message.
			const c = classifyJobFailure(err);
			console.log(
				`ECHEC ${project.slug.padEnd(16)} [${c.errorClass}] ${c.code} — ${c.message.slice(0, 160)}`
			);
		}
	}

	console.log('');
	console.log(failed === 0 ? 'Terminé sans échec.' : `Terminé avec ${failed} échec(s).`);
	if (failed > 0) process.exitCode = 1;
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => pool.end());
