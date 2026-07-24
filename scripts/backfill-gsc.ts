/**
 * GSC-004 — Runner du backfill GSC, borné et REPRENABLE, piloté par la file.
 *
 * N'appelle PAS Google directement : il enfile des jobs `collect:gsc_query_page` pour
 * les semaines manquantes d'une plage, que le tick draine ensuite sous quota et
 * refroidissement (JOB-006). Le compte GSC partagé par les 6 projets n'est donc jamais
 * brûlé six fois d'un coup.
 *
 * REPRENABLE sans checkpoint stocké : `enqueueGscBackfill` ne ré-enfile que les
 * semaines encore absentes des observations. Relancer le runner traite la tranche
 * suivante ; une plage déjà collectée n'enfile rien.
 *
 * Lister (à blanc) : npx tsx scripts/backfill-gsc.ts --project=<slug> --from=2026-01-05 --to=2026-06-29 --dry-run
 * Enfiler          : npx tsx scripts/backfill-gsc.ts --project=<slug> --from=2026-01-05 --to=2026-06-29
 * Tranche          : --batch=8   (défaut 8 semaines par appel)
 * Tous les projets : --project=all
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { listGscProjects } from '../src/lib/server/gsc-auth.js';
import { enqueueGscBackfill } from '../src/lib/server/gsc-windows.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}
if (!process.env.ENCRYPTION_KEY) {
	console.error('ENCRYPTION_KEY absente (.env) : les projets GSC sont illisibles. Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const PROJECT = arg('project') ?? 'all';
const FROM = arg('from');
const TO = arg('to');
const BATCH = Number(arg('batch') ?? '8');

if (!FROM || !TO) {
	console.error('--from=YYYY-MM-DD et --to=YYYY-MM-DD sont requis.');
	process.exit(1);
}

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
		`${targets.length} projet(s) · plage ${FROM} → ${TO} · tranche ${BATCH}${DRY_RUN ? ' · DRY-RUN' : ''}`
	);
	console.log('');

	let totalEnqueued = 0;
	let totalRemaining = 0;

	for (const project of targets) {
		try {
			const res = await enqueueGscBackfill({
				db,
				projectId: project.id,
				fromWeek: FROM as string,
				toWeek: TO as string,
				maxWeeksPerBatch: Number.isFinite(BATCH) ? BATCH : 8,
				dryRun: DRY_RUN
			});
			totalEnqueued += res.enqueued.length;
			totalRemaining += res.remaining;
			console.log(
				`${project.slug.padEnd(16)} ${res.targetWeeks.length} sem. plage · ` +
					`${res.alreadyPresent.length} déjà là · ` +
					`${res.enqueued.length} ${DRY_RUN ? 'à enfiler' : 'enfilée(s)'} · ` +
					`${res.remaining} restante(s)`
			);
			if (res.enqueued.length > 0) {
				console.log(`   → ${res.enqueued.map((e) => e.weekStart).join(', ')}`);
			}
		} catch (err) {
			process.exitCode = 1;
			console.log(`ECHEC ${project.slug.padEnd(16)} ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	console.log('');
	console.log(
		`${DRY_RUN ? '(dry-run) ' : ''}${totalEnqueued} job(s) de collecte ${DRY_RUN ? 'seraient enfilés' : 'enfilés'} · ` +
			`${totalRemaining} semaine(s) restante(s) — relancer pour la tranche suivante.`
	);
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => pool.end());
