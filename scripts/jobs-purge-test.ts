/**
 * Maintenance — purge des lignes de TEST laissées dans la vraie file de jobs.
 *
 * Pourquoi ce script existe : jusqu'au correctif de JOB-003, le nettoyage de
 * `job-claim-concurrency.ts` supprimait les `jobs` SANS supprimer d'abord leurs
 * `job_attempts` — la FK `job_attempts_job_id_fkey` refusait, l'erreur tombait
 * APRÈS toutes les vérifications (donc invisible), et la preuve laissait ses
 * lignes en file à chaque exécution. Le script est corrigé (enfants d'abord +
 * type cloisonné par exécution), mais les lignes déjà écrites sont restées, et
 * la console d'exploitation (JOB-007) est précisément l'écran qui les exposerait.
 *
 * Le même accident peut se reproduire à tout moment : un Ctrl-C au milieu d'une
 * preuve saute son `cleanup()`. D'où un script REJOUABLE plutôt qu'un DELETE
 * ponctuel.
 *
 * DRY-RUN par défaut (même discipline que `scripts/purge.ts`) :
 *   npx tsx scripts/jobs-purge-test.ts             → annonce, n'écrit rien
 *   npx tsx scripts/jobs-purge-test.ts --execute   → supprime
 *
 * Voir ce qui est mort ensuite : npx tsx scripts/jobs-inspect.ts --dead
 */
import 'dotenv/config';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');

/**
 * Préfixe de la famille de test. Toutes les preuves le portent :
 * `__test_claim` (legacy, sans suffixe), `__test_claim:<runId>`,
 * `__test_lease:<label>`, `__test_retry:<label>`, `__test_find003`…
 *
 * ATTENTION — `_` est un JOKER dans `LIKE` : `type LIKE '__test_%'` matcherait
 * `xxtestZ…`, donc potentiellement un type métier. On passe par `starts_with`,
 * qui compare des caractères et non un motif.
 */
const TEST_PREFIX = '__test_';

/** Le prédicat de ciblage, écrit UNE fois : plan et suppression ne peuvent pas diverger. */
const TARGET = `starts_with(type, $1)`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

interface TypeCount {
	type: string;
	status: string;
	n: string;
}

async function plan(): Promise<{ types: TypeCount[]; jobs: number; attempts: number; effects: number }> {
	const byType = await pool.query<TypeCount>(
		`SELECT type, status, count(*)::text AS n
		   FROM "seostats"."jobs"
		  WHERE ${TARGET}
		  GROUP BY type, status
		  ORDER BY type, status`,
		[TEST_PREFIX]
	);

	const totals = await pool.query<{ jobs: string; attempts: string; effects: string }>(
		`SELECT
		   (SELECT count(*) FROM "seostats"."jobs" WHERE ${TARGET})::text AS jobs,
		   (SELECT count(*) FROM "seostats"."job_attempts"
		     WHERE job_id IN (SELECT id FROM "seostats"."jobs" WHERE ${TARGET}))::text AS attempts,
		   (SELECT count(*) FROM "seostats"."job_effects"
		     WHERE job_id IN (SELECT id FROM "seostats"."jobs" WHERE ${TARGET}))::text AS effects`,
		[TEST_PREFIX]
	);

	const t = totals.rows[0];
	return {
		types: byType.rows,
		jobs: Number(t.jobs),
		attempts: Number(t.attempts),
		effects: Number(t.effects)
	};
}

/**
 * Suppression ENFANTS D'ABORD (`job_attempts` → `job_effects` → `jobs`) : c'est
 * exactement l'ordre qui manquait au bug qu'on nettoie. Le tout dans UNE
 * transaction — un job supprimé dont le journal survivrait serait un orphelin
 * impossible à retrouver.
 *
 * Le ciblage se fait par SOUS-REQUÊTE sur le type, jamais par liste d'ids : le
 * plan et l'exécution lisent alors le même prédicat, et rien ne peut se glisser
 * entre les deux (la transaction verrouille les lignes qu'elle supprime).
 */
async function execute(): Promise<{ attempts: number; effects: number; jobs: number }> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const attempts = await client.query(
			`DELETE FROM "seostats"."job_attempts"
			  WHERE job_id IN (SELECT id FROM "seostats"."jobs" WHERE ${TARGET})`,
			[TEST_PREFIX]
		);
		const effects = await client.query(
			`DELETE FROM "seostats"."job_effects"
			  WHERE job_id IN (SELECT id FROM "seostats"."jobs" WHERE ${TARGET})`,
			[TEST_PREFIX]
		);
		const jobs = await client.query(`DELETE FROM "seostats"."jobs" WHERE ${TARGET}`, [TEST_PREFIX]);
		await client.query('COMMIT');
		return {
			attempts: attempts.rowCount ?? 0,
			effects: effects.rowCount ?? 0,
			jobs: jobs.rowCount ?? 0
		};
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		client.release();
	}
}

async function main() {
	console.log(
		`\n=== Purge des jobs de test ${EXECUTE ? '(RÉELLE)' : '(DRY-RUN, aucune écriture)'} ===\n`
	);

	const p = await plan();

	if (p.jobs === 0) {
		console.log(`Aucun job de type « ${TEST_PREFIX}* » en file. Rien à purger.\n`);
		await pool.end();
		return;
	}

	// Les TYPES sont listés avant les comptes : c'est la vérification humaine du
	// ciblage. Si un type métier apparaissait ici, il ne faudrait pas exécuter.
	console.log('Types trouvés (aucun ne doit être un type métier) :\n');
	for (const row of p.types) {
		console.log(`  ${row.type.padEnd(40)} ${row.status.padEnd(10)} ${row.n}`);
	}

	const dead = p.types
		.filter((r) => r.status === 'dead')
		.reduce((sum, r) => sum + Number(r.n), 0);

	console.log(
		`\nTotal : ${p.jobs} job(s) — dont ${dead} en dead-letter · ` +
			`${p.attempts} tentative(s) · ${p.effects} effet(s).\n`
	);

	if (!EXECUTE) {
		console.log(
			'Serait supprimé, enfants d’abord : job_attempts → job_effects → jobs, en une transaction.\n' +
				'\nRien n’a été écrit. Relancer avec --execute pour appliquer.\n'
		);
		await pool.end();
		return;
	}

	const res = await execute();
	console.log(
		`Supprimé : ${res.attempts} tentative(s), ${res.effects} effet(s), ${res.jobs} job(s).\n`
	);

	const after = await plan();
	console.log(
		after.jobs === 0
			? 'Vérification : plus aucun job de test en file.\n'
			: `⚠ Vérification : ${after.jobs} job(s) de test subsistent.\n`
	);

	await pool.end();
}

main().catch(async (err) => {
	console.error('Purge en erreur:', err);
	await pool.end().catch(() => {});
	process.exit(1);
});
