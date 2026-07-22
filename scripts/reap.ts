/**
 * JOB-002 — Reaper manuel : remise en file des baux morts.
 *
 * Le worker fait déjà cette passe au démarrage et sur ses tours à vide ; ce
 * script sert à l'inspecter ou à la déclencher sans lancer de worker (après un
 * crash, une machine éteinte, un déploiement interrompu).
 *
 * Lancer (annonce)   : npx tsx scripts/reap.ts --dry-run
 * Lancer (réel)      : npx tsx scripts/reap.ts [--limit=20] [--types=a,b]
 *
 * `--dry-run` lit sans rien écrire : il dit exactement ce qui serait repris, de
 * quoi le worker est mort, et où chaque job irait (remise en file ou dead-letter).
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { reclaimExpiredLeases } from '../src/lib/server/jobs-lease.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const DRY_RUN = args.includes('--dry-run');
const LIMIT = Number(arg('limit') ?? 20);
const TYPES = arg('types')?.split(',').filter(Boolean);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

const KIND_LABEL: Record<string, string> = {
	worker_death: 'worker mort',
	lease_stall: 'worker bloqué'
};

async function main() {
	console.log(
		`\n=== JOB-002 — reaper ${DRY_RUN ? '(DRY-RUN, aucune écriture)' : '(réel)'} · ` +
			`limite ${LIMIT}${TYPES ? ` · types ${TYPES.join(',')}` : ''} ===\n`
	);

	const res = await reclaimExpiredLeases({ db, limit: LIMIT, types: TYPES, dryRun: DRY_RUN });

	if (res.reclaimed.length === 0) {
		console.log('Aucun bail mort : tous les jobs `running` ont un bail valide.\n');
		await pool.end();
		return;
	}

	for (const r of res.reclaimed) {
		const destin =
			r.outcome === 'dead'
				? 'DEAD-LETTER (plafond de tentatives atteint)'
				: `remis en file dans ${Math.round(r.backoffMs / 1000)} s (${r.availableAt})`;
		console.log(
			`  ${r.jobId}  ${r.type}\n` +
				`    tentative #${r.attemptNo} de ${r.workerId}\n` +
				`    cause : ${KIND_LABEL[r.kind] ?? r.kind}\n` +
				`    → ${destin}\n`
		);
	}

	console.log(
		`${res.reclaimed.length} bail(s) mort(s) ${DRY_RUN ? 'détecté(s)' : 'repris'} · ` +
			`${res.requeued} remis en file · ${res.deadLettered} en dead-letter · ` +
			`${res.byKind.worker_death} worker mort / ${res.byKind.lease_stall} bloqué` +
			(res.skipped > 0 ? ` · ${res.skipped} ignoré(s) (bail renouvelé entre-temps)` : '')
	);
	if (DRY_RUN) console.log('\nRien n’a été écrit. Relancer sans --dry-run pour appliquer.');
	console.log('');

	await pool.end();
}

main().catch(async (err) => {
	console.error('Reaper en erreur:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
