/**
 * JOB-006 — Lire et écrire les limites de la file, sans redéploiement.
 *
 * C'est l'outil qui rend l'acceptation « les limites sont configurables sans
 * redéploiement » utilisable par un humain : les plafonds vivent dans
 * `system_settings` (clé `jobs.limits`), le tick les relit à chaque drain, et rien
 * n'exige de repasser par Vercel.
 *
 * DRY-RUN PAR DÉFAUT — comme `jobs-purge-test.ts` et `schedule.ts`. Un réglage de file
 * est une décision d'exploitation : elle se voit avant de s'appliquer.
 *
 * Lancer :
 *   npx tsx scripts/limits.ts                                  # état courant
 *   npx tsx scripts/limits.ts --set globalConcurrency=8        # dry-run
 *   npx tsx scripts/limits.ts --set globalConcurrency=8 --execute
 *   npx tsx scripts/limits.ts --reset --execute                # retour aux défauts du code
 *
 * Clés scalaires : globalConcurrency · perProjectConcurrency · perProjectPerLap ·
 *                  reservedSlots · providerWindowMs · cooldownMs
 * Clés par provider : perProviderConcurrency.gsc=4 · providerWindowBudget.gsc=500
 * Liste : reservedTypes=reviews:sync,alerts:notify
 *
 * Rappel : **`0` vaut « pas de limite »**, jamais « zéro job autorisé ». Une valeur
 * illisible ou hors bornes est IGNORÉE par `resolveLimits`, qui retombe sur le défaut
 * de code — ce script le dit explicitement plutôt que de laisser croire à une prise
 * en compte.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import {
	JOB_PROVIDERS,
	LIMIT_DEFAULTS,
	resolveLimits,
	type JobLimitOverrides,
	type JobLimits
} from '../src/lib/server/job-limits.js';
import {
	SYSTEM_LIMITS_KEY,
	loadSystemLimitOverrides,
	saveSystemLimitOverrides
} from '../src/lib/server/jobs-limits.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const RESET = args.includes('--reset');
const SETS = args.filter((a, i) => args[i - 1] === '--set');

const SCALARS = [
	'globalConcurrency',
	'perProjectConcurrency',
	'perProjectPerLap',
	'reservedSlots',
	'providerWindowMs',
	'cooldownMs'
] as const;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

/**
 * Traduit `clé=valeur` en overrides. Ne VALIDE rien : `resolveLimits` est seule juge,
 * et la comparaison avant/après ci-dessous montrera ce qui a réellement été retenu.
 * Dupliquer la validation ici créerait deux vérités sur ce qu'est une limite légale.
 */
function parseSets(current: JobLimitOverrides): JobLimitOverrides {
	const out: JobLimitOverrides = { ...current };
	for (const pair of SETS) {
		const idx = pair.indexOf('=');
		if (idx < 0) {
			console.error(`Ignoré (pas de « = ») : ${pair}`);
			continue;
		}
		const key = pair.slice(0, idx);
		const raw = pair.slice(idx + 1);

		if (key === 'reservedTypes') {
			out.reservedTypes = raw.split(',').filter(Boolean);
			continue;
		}
		if (key.includes('.')) {
			const [map, provider] = key.split('.');
			if (map !== 'perProviderConcurrency' && map !== 'providerWindowBudget') {
				console.error(`Ignoré (map inconnue) : ${key}`);
				continue;
			}
			if (!(JOB_PROVIDERS as readonly string[]).includes(provider)) {
				console.error(`Ignoré (provider inconnu) : ${provider}`);
				continue;
			}
			const existing = (out[map] as Record<string, unknown> | undefined) ?? {};
			out[map] = { ...existing, [provider]: Number(raw) };
			continue;
		}
		if ((SCALARS as readonly string[]).includes(key)) {
			out[key as (typeof SCALARS)[number]] = Number(raw);
			continue;
		}
		console.error(`Ignoré (clé inconnue) : ${key}`);
	}
	return out;
}

function printLimits(label: string, limits: JobLimits): void {
	console.log(`\n${label}`);
	for (const key of SCALARS) {
		const v = limits[key];
		console.log(`  ${key.padEnd(24)} ${v === 0 ? '0 (pas de limite)' : v}`);
	}
	console.log(
		`  ${'perProviderConcurrency'.padEnd(24)} ` +
			JOB_PROVIDERS.map((p) => `${p}=${limits.perProviderConcurrency[p]}`).join(' · ')
	);
	console.log(
		`  ${'providerWindowBudget'.padEnd(24)} ` +
			JOB_PROVIDERS.map((p) => `${p}=${limits.providerWindowBudget[p]}`).join(' · ')
	);
	console.log(`  ${'reservedTypes'.padEnd(24)} ${limits.reservedTypes.join(', ') || '(aucun)'}`);
}

/** Ce qui DIFFÈRE entre deux résolutions — la seule chose qui compte à la relecture. */
function diff(before: JobLimits, after: JobLimits): string[] {
	const lines: string[] = [];
	for (const key of SCALARS) {
		if (before[key] !== after[key]) lines.push(`  ${key} : ${before[key]} → ${after[key]}`);
	}
	for (const p of JOB_PROVIDERS) {
		if (before.perProviderConcurrency[p] !== after.perProviderConcurrency[p]) {
			lines.push(
				`  perProviderConcurrency.${p} : ${before.perProviderConcurrency[p]} → ${after.perProviderConcurrency[p]}`
			);
		}
		if (before.providerWindowBudget[p] !== after.providerWindowBudget[p]) {
			lines.push(
				`  providerWindowBudget.${p} : ${before.providerWindowBudget[p]} → ${after.providerWindowBudget[p]}`
			);
		}
	}
	if (before.reservedTypes.join(',') !== after.reservedTypes.join(',')) {
		lines.push(
			`  reservedTypes : ${before.reservedTypes.join(',') || '(aucun)'} → ${after.reservedTypes.join(',') || '(aucun)'}`
		);
	}
	return lines;
}

async function main() {
	const stored = await loadSystemLimitOverrides(db);
	const before = resolveLimits(stored);

	console.log(
		`\nSource : ${stored ? `base (clé « ${SYSTEM_LIMITS_KEY} »)` : 'défauts du code (aucun réglage en base)'}`
	);
	printLimits('Limites appliquées aujourd’hui :', before);

	if (RESET) {
		console.log('\n--reset : la clé sera SUPPRIMÉE, la file repassera aux défauts du code.');
		printLimits('Après reset :', resolveLimits(null));
		if (!EXECUTE) {
			console.log('\n(dry-run — ajouter --execute pour appliquer)\n');
			await pool.end();
			return;
		}
		await db.execute(
			sql`DELETE FROM "seostats"."system_settings" WHERE key = ${SYSTEM_LIMITS_KEY}`
		);
		console.log('\nRéglage supprimé. Le prochain tick lira les défauts.\n');
		await pool.end();
		return;
	}

	if (SETS.length === 0) {
		console.log('\n(lecture seule — utiliser --set clé=valeur pour modifier)\n');
		await pool.end();
		return;
	}

	const nextOverrides = parseSets(stored ?? {});
	const after = resolveLimits(nextOverrides);
	const changes = diff(before, after);

	console.log('\nChangements retenus :');
	if (changes.length === 0) {
		// Cas important : une valeur hors bornes ou d'un mauvais type est SILENCIEUSEMENT
		// ignorée par `resolveLimits`. Le dire ici évite de croire un réglage appliqué.
		console.log(
			'  (aucun — les valeurs fournies sont hors bornes, d’un mauvais type, ou identiques à l’existant)'
		);
	} else {
		for (const line of changes) console.log(line);
	}

	if (!EXECUTE) {
		console.log('\n(dry-run — ajouter --execute pour appliquer)\n');
		await pool.end();
		return;
	}
	if (changes.length === 0) {
		console.log('\nRien à écrire.\n');
		await pool.end();
		return;
	}

	await saveSystemLimitOverrides({ db, overrides: nextOverrides });
	const reread = resolveLimits(await loadSystemLimitOverrides(db));
	printLimits('Relu depuis la base :', reread);
	console.log('\nAppliqué. Le prochain tick le lira — aucun redéploiement nécessaire.\n');
	await pool.end();
}

main().catch(async (err) => {
	console.error('Échec:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});

// Référencé pour la lisibilité de l'aide ci-dessus ; les défauts sont dans le module pur.
void LIMIT_DEFAULTS;
