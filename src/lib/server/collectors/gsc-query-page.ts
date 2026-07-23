/**
 * GSC-002 — Collecteur `query × page × device` (BACKLOG GSC-002, SPEC §9.1).
 *
 * **Ce qui manquait.** Depuis JOB-001→007 la file sait tout faire, et depuis
 * FIND-004/AGT-000 la chaîne `observations → findings → propositions` tourne. Mais
 * les observations avaient été peuplées UNE fois — par le backfill du 2026-07-21 —
 * et plus personne n'y écrivait : `observations.ts` n'était importé par aucun
 * appelant. Pendant ce temps le cron legacy `/api/cron/gsc-snapshot` pullait GSC
 * dans une boucle `for` HORS de la file : sans `run_id`, sans classe d'erreur,
 * sans plafond, sans refroidissement. Les deux séries étaient à égalité par
 * coïncidence (semaine `2026-07-06` des deux côtés) et allaient diverger au
 * lundi suivant — le détecteur décidant alors sur des mesures d'une semaine de
 * plus chaque semaine, en silence.
 *
 * Ce collecteur est **l'unique lecteur GSC** du système, et il est gouverné par la
 * file : réclamable sous plafond (JOB-006), prérequis obligatoire du détecteur
 * (JOB-004), erreurs classées (JOB-003).
 *
 * **Deux invariants qui portent tout le reste :**
 *
 *   1. **RIEN n'est écrit avant la fin de la pagination.** Un upsert n'efface
 *      jamais : une collecte coupée à la page 3/5 laisserait une semaine tronquée
 *      qui se LIT comme complète, et le détecteur y verrait une chute. C'est
 *      précisément le faux signal que GSC-006 interdit. On tamponne en mémoire —
 *      une semaine × un projet pèse quelques milliers de lignes — puis on écrit.
 *   2. **Un seul fetch, double écriture** (décision produit). Le même tampon
 *      alimente les observations (canon, lues par le détecteur) ET les tables
 *      legacy (`gsc_snapshots` / `gsc_query_page_data`, lues par le dashboard et
 *      les skills `/seo-weekly` · `/seo-actions`). Deux pulls de la même semaine
 *      consommeraient deux fois le quota d'un compte que **les 6 projets
 *      partagent**. La double écriture est une dette assumée : elle disparaît
 *      quand l'écran lira les observations (E06/GSC-003).
 */
import { and, eq } from 'drizzle-orm';
import { gscQueryPageData, gscSnapshots } from '../db/schema.js';
import type { AppDb } from '../db/types.js';
import { createId } from '../utils.js';
import { log } from '../log.js';
import { recordStep } from '../monitoring.js';
import {
	upsertGscPageObservations,
	upsertGscQueryPageObservations,
	type UpsertGscQueryPageInput
} from '../observations.js';
import { rollupPagesFromQueryPage } from '../observation-backfill.js';
import { computeWeeklyDiff } from '../gsc-weekly-diff.js';
import {
	GscApiError,
	loadGscBinding,
	searchAnalyticsPage,
	syncGscIntegration,
	type GscAuthDeps,
	type GscBinding
} from '../gsc-auth.js';
import {
	GSC_PAGE_SIZE,
	assertPageBudget,
	computeTotals,
	hasMorePages,
	normalizeRows,
	resolveCollectionWeek,
	type NormalizedGscRow
} from './gsc-collector-state.js';

const logger = log('collector:gsc');

/** Dimensions collectées — l'ordre définit `keys[0..2]` dans la réponse. */
const DIMENSIONS = ['query', 'page', 'device'];

/** Lot d'insertion des lignes legacy (17 colonnes → 4000 dépasserait le plafond bind). */
const LEGACY_CHUNK = 2000;

export interface CollectGscInput {
	projectId: string;
	/** Semaine explicite (`YYYY-MM-DD`, normalisée sur son lundi) ; sinon la dernière complète. */
	weekStart?: string | null;
	runId?: string | null;
	/** N'écrit rien : sert au sondage et au `--dry-run` du runner. */
	dryRun?: boolean;
	/** Coupe la double écriture legacy (preuves : on n'écrit pas dans les tables de l'écran). */
	skipLegacy?: boolean;
	deps?: GscAuthDeps;
	client?: AppDb;
	now?: Date;
	signal?: AbortSignal;
}

export interface CollectGscResult {
	projectId: string;
	siteUrl: string;
	weekStart: string;
	weekEnd: string;
	pages: number;
	/** Lignes rendues par l'API, avant déduplication. */
	fetched: number;
	/** Lignes distinctes écrites (clé query×page×device). */
	rows: number;
	duplicates: number;
	skipped: number;
	pageRows: number;
	totals: ReturnType<typeof computeTotals>;
	durationMs: number;
	dryRun: boolean;
	legacyWritten: boolean;
}

/**
 * Collecte une semaine pour un projet.
 *
 * Le `signal` est celui du bail (JOB-002) : un collecteur qui a perdu son bail
 * doit s'arrêter AVANT d'écrire, sinon deux workers écrivent la même semaine.
 * Il est vérifié entre chaque page — le seul endroit où l'attente est longue.
 */
export async function collectGscQueryPage(input: CollectGscInput): Promise<CollectGscResult> {
	const startedAtMs = Date.now();
	const deps: GscAuthDeps = { ...input.deps, client: input.deps?.client ?? input.client };
	const { weekStart, weekEnd } = resolveCollectionWeek({
		requested: input.weekStart,
		now: input.now
	});

	const binding = await loadGscBinding(input.projectId, deps);

	let raw: Awaited<ReturnType<typeof searchAnalyticsPage>>['rows'] = [];
	let pages = 0;

	try {
		// ── Phase 1 : lire TOUT, n'écrire RIEN ──────────────────────────
		let startRow = 0;
		for (;;) {
			input.signal?.throwIfAborted();
			assertPageBudget(pages);
			const page = await searchAnalyticsPage(
				{
					binding,
					startDate: weekStart,
					endDate: weekEnd,
					dimensions: DIMENSIONS,
					rowLimit: GSC_PAGE_SIZE,
					startRow
				},
				deps
			);
			pages++;
			raw = raw.concat(page.rows);
			if (!hasMorePages(page.rows.length)) break;
			startRow += page.rows.length;
		}
	} catch (err) {
		// La fraîcheur de l'intégration doit refléter l'échec AVANT que l'erreur ne
		// remonte au worker : c'est le seul endroit qui sait quel projet a échoué et
		// pourquoi. On ne masque jamais l'erreur — la file en a besoin pour classer.
		await recordIntegrationOutcome(binding, err, deps);
		throw err;
	}

	const { rows, duplicates, skipped } = normalizeRows(raw);
	const totals = computeTotals(rows);

	if (input.dryRun) {
		return {
			projectId: input.projectId,
			siteUrl: binding.siteUrl,
			weekStart,
			weekEnd,
			pages,
			fetched: raw.length,
			rows: rows.length,
			duplicates,
			skipped,
			pageRows: 0,
			totals,
			durationMs: Date.now() - startedAtMs,
			dryRun: true,
			legacyWritten: false
		};
	}

	// ── Phase 2 : écrire, la pagination étant close ─────────────────
	input.signal?.throwIfAborted();

	const observationInputs: UpsertGscQueryPageInput[] = rows.map((r) => ({
		projectId: input.projectId,
		periodStart: weekStart,
		periodEnd: weekEnd,
		query: r.query,
		page: r.page,
		device: r.device,
		clicks: r.clicks,
		impressions: r.impressions,
		ctr: r.ctr,
		position: r.position,
		runId: input.runId ?? null,
		// Le brut n'apporte rien de plus que la série normalisée, et 73 k payloads
		// coûteraient du stockage pour une information déjà en colonnes.
		payloadJson: null
	}));

	await upsertGscQueryPageObservations(observationInputs, input.client);

	// Rollup page×device : agrégation PURE déjà testée (position pondérée par
	// impressions), la même qui a produit les lignes du backfill.
	const pageInputs = rollupPagesFromQueryPage(
		rows.map((r) => ({
			projectId: input.projectId,
			weekStart,
			weekEnd,
			query: r.query,
			page: r.page,
			device: r.device,
			clicks: r.clicks,
			impressions: r.impressions,
			ctr: r.ctr,
			position: r.position
		}))
	).map((p) => ({ ...p, runId: input.runId ?? null }));

	await upsertGscPageObservations(pageInputs, input.client);

	let legacyWritten = false;
	if (!input.skipLegacy) {
		await writeLegacySnapshot(
			{ projectId: input.projectId, weekStart, weekEnd, rows, totals },
			input.client
		);
		// Le diff DOIT suivre l'écriture legacy dans la même foulée : des KPI figés
		// au-dessus de données fraîches, c'est le pire des deux mondes — l'écran
		// affirmerait une stabilité que les lignes en dessous démentent.
		await computeWeeklyDiff({ projectId: input.projectId, weekStart }, input.client);
		legacyWritten = true;
	}

	await recordIntegrationOutcome(binding, null, deps);

	const durationMs = Date.now() - startedAtMs;

	if (input.runId) {
		await recordStep(
			{
				runId: input.runId,
				stepType: 'collect:gsc_query_page',
				provider: 'gsc',
				status: 'succeeded',
				durationMs,
				metadataJson: JSON.stringify({
					projectId: input.projectId,
					siteUrl: binding.siteUrl,
					weekStart,
					pages,
					rows: rows.length,
					pageRows: pageInputs.length
				})
			},
			input.client
		);
	}

	logger.info('collecte GSC terminée', {
		projectId: input.projectId,
		siteUrl: binding.siteUrl,
		weekStart,
		pages,
		rows: rows.length,
		duplicates,
		durationMs
	});

	return {
		projectId: input.projectId,
		siteUrl: binding.siteUrl,
		weekStart,
		weekEnd,
		pages,
		fetched: raw.length,
		rows: rows.length,
		duplicates,
		skipped,
		pageRows: pageInputs.length,
		totals,
		durationMs,
		dryRun: false,
		legacyWritten
	};
}

/**
 * Reflète l'issue dans `project_integrations`.
 *
 * Ne lève JAMAIS : un échec d'écriture de fraîcheur ne doit ni masquer l'erreur de
 * collecte (que la file a besoin de classer), ni faire échouer une collecte qui a
 * réussi. Même principe que la passe de reaper — non bloquante par construction.
 */
async function recordIntegrationOutcome(
	binding: GscBinding,
	err: unknown,
	deps: GscAuthDeps
): Promise<void> {
	try {
		if (err === null) {
			await syncGscIntegration({ binding, outcome: 'success' }, deps);
			return;
		}
		const code =
			err instanceof GscApiError
				? `${err.status}${err.reason ? `:${err.reason}` : ''}`
				: err instanceof Error
					? err.name
					: 'UnknownError';
		await syncGscIntegration({ binding, outcome: 'error', errorCode: code }, deps);
	} catch (syncErr) {
		logger.warn("fraîcheur d'intégration non enregistrée", {
			projectId: binding.projectId,
			error: syncErr instanceof Error ? syncErr.message : String(syncErr)
		});
	}
}

/**
 * Double écriture legacy — `gsc_snapshots` + `gsc_query_page_data`.
 *
 * Remplacement complet de la semaine (delete + insert) et non upsert : c'est la
 * sémantique historique de `pullWeeklySnapshot`, et `gsc_query_page_data` n'a
 * **aucun index unique** sur lesquels un upsert pourrait s'appuyer. Le risque du
 * delete (perdre la semaine si l'insert échoue) est borné par la transaction, et
 * surtout par l'invariant n°1 : on n'arrive ici qu'avec la semaine complète en
 * mémoire.
 */
async function writeLegacySnapshot(
	input: {
		projectId: string;
		weekStart: string;
		weekEnd: string;
		rows: NormalizedGscRow[];
		totals: ReturnType<typeof computeTotals>;
	},
	client?: AppDb
): Promise<void> {
	const db = client ?? ((await import('../db/index.js')).db as unknown as AppDb);

	await db.transaction(async (tx) => {
		const existing = await tx
			.select({ id: gscSnapshots.id })
			.from(gscSnapshots)
			.where(
				and(
					eq(gscSnapshots.projectId, input.projectId),
					eq(gscSnapshots.weekStart, input.weekStart)
				)
			)
			.limit(1);

		if (existing[0]) {
			await tx.delete(gscQueryPageData).where(eq(gscQueryPageData.snapshotId, existing[0].id));
			await tx.delete(gscSnapshots).where(eq(gscSnapshots.id, existing[0].id));
		}

		const snapshotId = createId();
		await tx.insert(gscSnapshots).values({
			id: snapshotId,
			projectId: input.projectId,
			weekStart: input.weekStart,
			weekEnd: input.weekEnd,
			status: 'success',
			totalClicks: input.totals.totalClicks,
			totalImpressions: input.totals.totalImpressions,
			avgCtr: input.totals.avgCtr,
			avgPosition: input.totals.avgPosition,
			rowCount: input.totals.rowCount,
			errorMessage: null
		});

		for (let i = 0; i < input.rows.length; i += LEGACY_CHUNK) {
			const slice = input.rows.slice(i, i + LEGACY_CHUNK).map((r) => ({
				id: createId(),
				snapshotId,
				projectId: input.projectId,
				weekStart: input.weekStart,
				query: r.query,
				page: r.page,
				device: r.device,
				clicks: r.clicks,
				impressions: r.impressions,
				ctr: r.ctr,
				position: r.position
			}));
			if (slice.length > 0) await tx.insert(gscQueryPageData).values(slice);
		}
	});
}
