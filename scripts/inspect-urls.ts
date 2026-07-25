/**
 * IDX-004 lot 2 — audit manuel BORNÉ d'indexation.
 *
 * Inspecte à la main une poignée d'URLs, **sous exactement le même budget que la politique**
 * (`selectManualUrls` → `resolveBudget` : plafond projet, pool cross-projet, `jobCap`,
 * `MAX_URLS_PER_JOB`). C'est tout l'intérêt du mot « borné » : sans lui, coller 500 URLs dans
 * un terminal viderait le pool des six projets pour la journée, et les échéances J+3 du
 * lendemain partiraient dans un `pool_exhausted` que personne n'aurait décidé.
 *
 * ⚠️ **Dry-run par DÉFAUT.** L'inverse du reste de l'outillage (`--dry-run` ailleurs), et c'est
 * délibéré : les autres runners écrivent en base, celui-ci dépense un quota externe payant.
 * L'oubli d'un drapeau doit coûter zéro appel, pas quarante. `--execute` pour écrire et
 * inspecter réellement.
 *
 * Pattern runner (cf. detect-index.ts) : Pool Neon propre + drizzle autonome, injecté dans les
 * modules serveur (qui acceptent un client). Aucune logique de décision ici — elle vit dans
 * `index-selection.ts` / `index-selection-state.ts`.
 *
 * À blanc (défaut) : npx tsx scripts/inspect-urls.ts --project=<slug> --url=https://…
 * Réel            : npx tsx scripts/inspect-urls.ts --project=<slug> --url=https://… --execute
 * Depuis un fichier : npx tsx scripts/inspect-urls.ts --project=<slug> --file=urls.txt
 * Options         : --limit=N  --now=YYYY-MM-DD  --note="pourquoi"
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { eq } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '../src/lib/server/db/schema.js';
import type { AppDb } from '../src/lib/server/db/types.js';
import { selectManualUrls } from '../src/lib/server/collectors/index-selection.js';
import { collectUrlInspection } from '../src/lib/server/collectors/url-inspection.js';
import { createRun, recordStep, recomputeRunStatus } from '../src/lib/server/monitoring.js';
import { deriveIdempotencyKey, normalizeError } from '../src/lib/server/monitoring-state.js';
import { toDbTimestamp } from '../src/lib/server/timestamps.js';

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL absent (.env). Abandon.');
	process.exit(1);
}

const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const all = (name: string) =>
	args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

const PROJECT = arg('project');
const EXECUTE = args.includes('--execute');
const LIMIT = arg('limit') ? Number(arg('limit')) : null;
const NOW = arg('now');
const NOTE = arg('note') ?? null;
const FILE = arg('file');

const STEP_TYPE = 'collect:url_inspection';

if (!PROJECT) {
	console.error('--project=<slug> est requis.');
	process.exit(1);
}

/** URLs de l'entrée : `--url=` répétable et/ou `--file=` (une par ligne, `#` = commentaire). */
function readUrls(): string[] {
	const inline = all('url');
	const fromFile = FILE
		? readFileSync(FILE, 'utf8')
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => l !== '' && !l.startsWith('#'))
		: [];
	return [...inline, ...fromFile];
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as AppDb;

async function main(): Promise<void> {
	const urls = readUrls();
	if (urls.length === 0) {
		console.error('Aucune URL. Utiliser --url=… (répétable) ou --file=chemin.');
		process.exit(1);
	}

	const rows = await db
		.select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name })
		.from(schema.projects)
		.where(eq(schema.projects.slug, PROJECT!));
	if (rows.length === 0) throw new Error(`Projet "${PROJECT}" introuvable.`);
	const project = rows[0];

	const now = NOW ? new Date(`${NOW}T12:00:00Z`) : new Date();
	if (Number.isNaN(now.getTime())) throw new Error(`--now invalide : ${NOW}`);
	const today = now.toISOString().slice(0, 10);

	console.log(`\n── ${project.name} (${project.slug}) ─────────────────────────`);
	console.log(`  ${urls.length} URL(s) en entrée · jour ${today}`);

	// Sélection : même budget que la politique, dry-run inclus (elle n'écrit rien alors).
	const plan = await selectManualUrls({
		db,
		projectId: project.id,
		urls,
		now,
		budget: LIMIT,
		dryRun: !EXECUTE,
		note: NOTE
	});

	console.log(
		`  budget ${plan.budget} · pool consommé aujourd'hui ≥ ${plan.poolUsed} ` +
			`(au plus ${plan.poolAvailable} restants)` +
			(plan.guards.length ? ` · gardes : ${plan.guards.join(', ')}` : '')
	);
	// Rien de coupé en silence : chaque écart a sa cause et sa liste.
	if (plan.merged > 0) console.log(`  ${plan.merged} doublon(s) fusionné(s) avant comptage.`);
	if (plan.unnormalizable.length > 0) {
		console.log(
			`  ⚠ ${plan.unnormalizable.length} URL(s) non normalisable(s), écartée(s) : ` +
				plan.unnormalizable.slice(0, 5).join(', ') +
				(plan.unnormalizable.length > 5 ? ' …' : '')
		);
	}
	if (plan.truncated.length > 0) {
		console.log(
			`  ⚠ ${plan.truncated.length} URL(s) coupée(s) par le budget (bas de liste) : ` +
				plan.truncated.slice(0, 5).join(', ') +
				(plan.truncated.length > 5 ? ' …' : '')
		);
	}
	if (plan.skippedReason) {
		console.log(`  ⏭  ${plan.skippedReason}`);
		return;
	}

	console.log(`\n  ${plan.urls.length} URL(s) retenue(s) :`);
	for (const url of plan.urls) console.log(`   • ${url}`);

	if (!EXECUTE) {
		console.log(
			`\n  DRY-RUN : aucune intention écrite, aucun appel Google, aucun quota consommé.` +
				`\n  Relancer avec --execute pour inspecter.`
		);
		return;
	}

	console.log(`\n  ${plan.persisted} intention(s) écrite(s) (reason=manual).`);

	const run = await createRun(
		{
			projectId: project.id,
			runType: 'manual',
			idempotencyKey: deriveIdempotencyKey({
				runType: 'manual',
				projectSlug: project.slug,
				periodEnd: today,
				stepType: STEP_TYPE,
				schemaVersion: 1
			}),
			triggeredBy: 'user',
			periodEnd: today
		},
		db
	);
	if (!run.created) console.log(`  (run existant réutilisé — même clé d'idempotence)`);

	const startedAt = toDbTimestamp();
	const t0 = Date.now();
	try {
		const res = await collectUrlInspection({
			projectId: project.id,
			// La forme NORMALISÉE, celle qui a été inscrite : sinon la jointure « honorée »
			// (observed_date >= due_date sur url = url_normalized) ne retrouverait jamais sa mesure.
			urls: plan.urls,
			runId: run.id,
			client: db,
			// MÊME `now` que la sélection : un run à cheval sur minuit UTC inscrirait sinon
			// l'intention au jour J et l'observation au jour J+1.
			now
		});
		await recordStep(
			{
				runId: run.id,
				stepType: STEP_TYPE,
				status: 'success',
				startedAt,
				finishedAt: toDbTimestamp(),
				durationMs: Date.now() - t0,
				metadataJson: JSON.stringify({
					source: 'manual-cli',
					requested: urls.length,
					selected: plan.urls.length,
					inspected: res.inspected.length,
					unreadable: res.unreadable.length,
					guards: plan.guards
				})
			},
			db
		);
		await recomputeRunStatus(run.id, db);

		console.log(`\n  ${res.inspected.length} inspection(s) persistée(s) :`);
		for (const i of res.inspected) {
			console.log(
				`   • [${i.indexedClass.padEnd(14)}] ${i.url}` +
					(i.normalized.coverageState ? ` — « ${i.normalized.coverageState} »` : '')
			);
		}
		// Une réponse incomprise n'est PAS « non indexé » : rien n'a été écrit pour elle.
		if (res.unreadable.length > 0) {
			console.log(
				`  ⚠ ${res.unreadable.length} réponse(s) illisible(s) — rien écrit, ` +
					`ces URLs restent dues : ${res.unreadable.join(', ')}`
			);
		}
	} catch (err) {
		const e = normalizeError(err);
		await recordStep(
			{
				runId: run.id,
				stepType: STEP_TYPE,
				status: 'failed',
				startedAt,
				finishedAt: toDbTimestamp(),
				durationMs: Date.now() - t0,
				errorCode: e.code,
				errorMessage: e.message
			},
			db
		);
		await recomputeRunStatus(run.id, db);
		// Les intentions restent DUES : la passe quotidienne `scope: 'due'` les reprendra
		// sans qu'aucune ligne ne soit dupliquée. C'est le point du lot 1.
		console.error(`\n  ✗ inspection interrompue (${e.code}) — les URLs non observées restent dues.`);
		throw err;
	}
}

main()
	.then(async () => {
		await pool.end();
		process.exit(0);
	})
	.catch(async (err) => {
		console.error(err);
		await pool.end();
		process.exit(1);
	});
