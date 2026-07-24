/**
 * GSC-004 — Fenêtres de comparaison : la LECTURE et le BACKFILL.
 *
 * Le jugement pur vit dans `gsc-windows-state.ts` (testé par vitest) ; ici on lit le
 * canon `gsc_query_page_observations`, on applique les fonctions pures, et on enfile
 * le backfill dans la file. Le client drizzle est INJECTÉ : l'app passe son `db`, les
 * runners `scripts/` passent leur Pool (cf. `db/types.ts`).
 *
 * ⚠️ Jamais `= ANY($n)` (driver Neon) : les fenêtres se filtrent par bornes
 * `>=`/`<=` sur `period_start`, jamais par liste paramétrée.
 *
 * On lit le CANON (observations), pas les tables legacy : c'est la même source que le
 * détecteur, donc l'écran et le détecteur ne peuvent pas diverger.
 */
import { and, eq, gte, lte, desc, sql } from 'drizzle-orm';
import { gscQueryPageObservations } from './db/schema.js';
import type { AppDb } from './db/types.js';
import type { ObservationRow, ObservationWindow } from './detector-state.js';
import {
	WINDOW_SPANS,
	buildWindowComparison,
	buildYoyComparison,
	computeWindowDelta,
	sumWindow,
	windowCompleteness,
	type WeekBounds,
	type WindowSpan,
	type WindowTotals,
	type WindowDelta,
	type WindowCompleteness
} from './gsc-windows-state.js';
import {
	addDaysIso,
	latestCompleteWeekStart,
	weekEndOf,
	weekStartOf
} from './collectors/gsc-collector-state.js';
import { loadGscLatencyDays } from './gsc-settings.js';
import { enqueueJob } from './monitoring.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Type de job de collecte (miroir de `job-runner.ts`, repris en littéral — ce module ne charge pas le runtime). */
const COLLECT_JOB_TYPE = 'collect:gsc_query_page';

/**
 * Garde-fou de plage : GSC ne retient que ~16 mois, mais une plage forgée pourrait en
 * demander mille. On borne à 10 ans de semaines — atteindre cette borne signifie une
 * erreur d'appel, pas un backfill légitime.
 */
const MAX_BACKFILL_WEEKS = 520;

// ── Lecture du canon ────────────────────────────────────────────────

/** Toutes les semaines distinctes présentes pour un projet (paires period_start/period_end), récentes d'abord. */
export async function loadAvailableWeeks(db: AppDb, projectId: string): Promise<WeekBounds[]> {
	return db
		.selectDistinct({
			periodStart: gscQueryPageObservations.periodStart,
			periodEnd: gscQueryPageObservations.periodEnd
		})
		.from(gscQueryPageObservations)
		.where(eq(gscQueryPageObservations.projectId, projectId))
		.orderBy(desc(gscQueryPageObservations.periodStart));
}

/** Lignes d'observation d'une fenêtre — filtrées par BORNES (jamais `= ANY`). */
export async function loadWindowRows(
	db: AppDb,
	projectId: string,
	window: ObservationWindow
): Promise<ObservationRow[]> {
	return db
		.select({
			id: gscQueryPageObservations.id,
			query: gscQueryPageObservations.query,
			page: gscQueryPageObservations.page,
			clicks: gscQueryPageObservations.clicks,
			impressions: gscQueryPageObservations.impressions,
			position: gscQueryPageObservations.position,
			periodStart: gscQueryPageObservations.periodStart
		})
		.from(gscQueryPageObservations)
		.where(
			and(
				eq(gscQueryPageObservations.projectId, projectId),
				gte(gscQueryPageObservations.periodStart, window.start),
				lte(gscQueryPageObservations.periodStart, window.end)
			)
		);
}

async function totalsFor(
	db: AppDb,
	projectId: string,
	window: ObservationWindow | null
): Promise<WindowTotals | null> {
	if (!window) return null;
	return sumWindow(await loadWindowRows(db, projectId, window));
}

// ── Rapport de fenêtre assemblé ─────────────────────────────────────

export interface WindowReport {
	span: WindowSpan;
	/** Semaines attendues pour ce span (1/4/13). */
	weeks: number;
	comparable: boolean;
	current: WindowTotals | null;
	prior: WindowTotals | null;
	delta: WindowDelta;
	completeness: WindowCompleteness;
	/** Bornes de la fenêtre courante (pour l'affichage) — `null` si aucune donnée. */
	currentWindow: ObservationWindow | null;
	priorWindow: ObservationWindow | null;
}

const EMPTY_TOTALS: WindowTotals = { clicks: 0, impressions: 0, ctr: 0, position: 0, weeksSeen: 0 };

/**
 * Assemble la comparaison d'UN span : découpe (courante/précédente), totaux, delta
 * (sous gate de comparabilité) et complétude (dérivée contre la dernière semaine
 * complète). `latestCompleteWeekEnd` est passé pour que le calcul de fraîcheur vise
 * la même semaine que le collecteur (même latence résolue).
 */
export async function computeWindowedComparison(input: {
	db: AppDb;
	projectId: string;
	span: WindowSpan;
	availableWeeks: WeekBounds[];
	latestCompleteWeekEnd: string;
}): Promise<WindowReport> {
	const cmp = buildWindowComparison(input.availableWeeks, input.span);
	const [current, prior] = await Promise.all([
		totalsFor(input.db, input.projectId, cmp.current),
		totalsFor(input.db, input.projectId, cmp.prior)
	]);
	const delta = computeWindowDelta(current ?? EMPTY_TOTALS, prior ?? EMPTY_TOTALS, cmp.comparable);
	const completeness = windowCompleteness({
		current: cmp.current,
		expectedWeeks: cmp.weeks,
		latestCompleteWeekEnd: input.latestCompleteWeekEnd
	});
	return {
		span: input.span,
		weeks: cmp.weeks,
		comparable: cmp.comparable,
		current,
		prior,
		delta,
		completeness,
		currentWindow: cmp.current,
		priorWindow: cmp.prior
	};
}

/**
 * Comparaison année N-1 pour un span — INERTE tant qu'aucune semaine N-1 n'existe.
 * Ne charge des totaux que si le gate est réellement franchi (donc jamais aujourd'hui).
 */
export type YoyReport =
	| { available: false; span: WindowSpan; reason: 'no_year_ago_data' | 'insufficient_current' }
	| { available: true; span: WindowSpan; weeks: number; current: WindowTotals; yearAgo: WindowTotals };

export async function computeYoyReport(input: {
	db: AppDb;
	projectId: string;
	span: WindowSpan;
	availableWeeks: WeekBounds[];
}): Promise<YoyReport> {
	const yoy = buildYoyComparison(input.availableWeeks, input.span);
	if (!yoy.available) return { available: false, span: input.span, reason: yoy.reason };
	const [current, yearAgo] = await Promise.all([
		loadWindowRows(input.db, input.projectId, yoy.current).then(sumWindow),
		loadWindowRows(input.db, input.projectId, yoy.yearAgo).then(sumWindow)
	]);
	return { available: true, span: yoy.span, weeks: yoy.weeks, current, yearAgo };
}

// ── Rapport complet (les 3 spans + YoY), pour l'endpoint et la page ──

export interface GscWindowsReport {
	projectId: string;
	/** La dernière semaine complète visée (dépend de la latence résolue). */
	latestCompleteWeekStart: string;
	latestCompleteWeekEnd: string;
	latencyDays: number;
	/** Nombre total de semaines présentes (utile pour dire « historique trop court »). */
	weeksAvailable: number;
	windows: WindowReport[];
	yoy: YoyReport[];
}

/**
 * Le rapport complet d'un projet : les 3 fenêtres (7/28/90 j) + les 3 gates YoY. Une
 * seule lecture des semaines disponibles, la latence résolue une fois.
 */
export async function loadGscWindows(input: {
	db: AppDb;
	projectId: string;
	now?: Date;
}): Promise<GscWindowsReport> {
	const latencyDays = await loadGscLatencyDays(input.db);
	const latestStart = latestCompleteWeekStart(input.now ?? new Date(), latencyDays);
	const latestEnd = weekEndOf(latestStart);
	const availableWeeks = await loadAvailableWeeks(input.db, input.projectId);

	const windows = await Promise.all(
		WINDOW_SPANS.map((span) =>
			computeWindowedComparison({
				db: input.db,
				projectId: input.projectId,
				span,
				availableWeeks,
				latestCompleteWeekEnd: latestEnd
			})
		)
	);
	const yoy = await Promise.all(
		WINDOW_SPANS.map((span) =>
			computeYoyReport({ db: input.db, projectId: input.projectId, span, availableWeeks })
		)
	);

	return {
		projectId: input.projectId,
		latestCompleteWeekStart: latestStart,
		latestCompleteWeekEnd: latestEnd,
		latencyDays,
		weeksAvailable: availableWeeks.length,
		windows,
		yoy
	};
}

// ── Backfill borné & reprenable, piloté par la file ─────────────────

export interface EnqueueBackfillInput {
	db: AppDb;
	projectId: string;
	/** Borne basse (incluse), normalisée sur son lundi. */
	fromWeek: string;
	/** Borne haute (incluse), normalisée sur son lundi ; jamais au-delà de la dernière semaine complète. */
	toWeek: string;
	/** Nombre max de semaines enfilées par appel (tranche). Défaut 8. */
	maxWeeksPerBatch?: number;
	now?: Date;
	latencyDays?: number;
	/** N'enfile rien : liste seulement ce qui serait enfilé (runner `--dry-run`). */
	dryRun?: boolean;
	/** Priorité des jobs de backfill : basse, pour ne pas affamer le run hebdo. */
	priority?: number;
}

export interface EnqueueBackfillResult {
	/** Toutes les semaines de la plage (lundis), bornée. */
	targetWeeks: string[];
	/** Semaines déjà collectées (présentes en observations) → sautées. */
	alreadyPresent: string[];
	/** Semaines manquantes enfilées cette tranche. */
	enqueued: { weekStart: string; jobId: string; created: boolean }[];
	/** Semaines manquantes NON enfilées cette tranche (au-delà de `maxWeeksPerBatch`). */
	remaining: number;
	dryRun: boolean;
}

function normalizeMonday(date: string, label: string): string {
	const d = date.trim();
	if (!ISO_DATE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
		throw new Error(`${label} illisible : "${date}" (attendu YYYY-MM-DD).`);
	}
	return weekStartOf(new Date(`${d}T00:00:00Z`));
}

/** Clé d'idempotence d'un job de backfill — distincte du run hebdo, stable par (projet, semaine). */
export function backfillIdempotencyKey(weekStart: string): string {
	return `backfill:${COLLECT_JOB_TYPE}:${weekStart}`;
}

/**
 * Enfile le backfill d'une plage de semaines, par tranches bornées.
 *
 * REPRENABLE SANS CHECKPOINT STOCKÉ : la reprise est DÉRIVÉE de la base — on ne
 * ré-enfile que les semaines qui n'ont encore aucune observation (doctrine « état
 * dérivé, jamais stocké », JOB-004/005). Un checkpoint stocké pourrait mentir (une
 * semaine « faite » dont le job a échoué après) ; la présence réelle d'observations,
 * non. Rappeler la fonction traite la tranche suivante.
 *
 * Chaque semaine devient un job `collect:gsc_query_page` (déjà idempotent, upsert),
 * drainé par le tick sous quota/refroidissement JOB-006 — le compte partagé des 6
 * projets n'est donc jamais brûlé six fois d'un coup.
 */
export async function enqueueGscBackfill(input: EnqueueBackfillInput): Promise<EnqueueBackfillResult> {
	const from = normalizeMonday(input.fromWeek, 'Borne basse');
	let to = normalizeMonday(input.toWeek, 'Borne haute');
	if (from > to) throw new Error(`Plage vide : fromWeek (${from}) > toWeek (${to}).`);

	// Jamais au-delà de la dernière semaine COMPLÈTE : une semaine encore partielle se
	// lirait comme une chute (le faux signal que GSC-006 interdit).
	const latencyDays = input.latencyDays ?? (await loadGscLatencyDays(input.db));
	const latest = latestCompleteWeekStart(input.now ?? new Date(), latencyDays);
	if (to > latest) to = latest;
	if (from > to) {
		return { targetWeeks: [], alreadyPresent: [], enqueued: [], remaining: 0, dryRun: input.dryRun === true };
	}

	// Énumération bornée des lundis [from, to].
	const targetWeeks: string[] = [];
	for (let w = from; w <= to; w = addDaysIso(w, 7)) {
		targetWeeks.push(w);
		if (targetWeeks.length > MAX_BACKFILL_WEEKS) {
			throw new Error(`Plage de backfill trop large (> ${MAX_BACKFILL_WEEKS} semaines).`);
		}
	}

	// Semaines DÉJÀ présentes (observations) dans la plage — dérivation par bornes, jamais `= ANY`.
	const presentRows = await input.db
		.selectDistinct({ periodStart: gscQueryPageObservations.periodStart })
		.from(gscQueryPageObservations)
		.where(
			and(
				eq(gscQueryPageObservations.projectId, input.projectId),
				gte(gscQueryPageObservations.periodStart, from),
				lte(gscQueryPageObservations.periodStart, to)
			)
		);
	const present = new Set(presentRows.map((r) => r.periodStart));
	const alreadyPresent = targetWeeks.filter((w) => present.has(w));
	const missing = targetWeeks.filter((w) => !present.has(w));

	const batchSize = Math.max(1, Math.floor(input.maxWeeksPerBatch ?? 8));
	const batch = missing.slice(0, batchSize);
	const remaining = missing.length - batch.length;
	const priority = input.priority ?? 3;

	if (input.dryRun) {
		return {
			targetWeeks,
			alreadyPresent,
			enqueued: batch.map((weekStart) => ({ weekStart, jobId: '(dry-run)', created: false })),
			remaining,
			dryRun: true
		};
	}

	const enqueued: { weekStart: string; jobId: string; created: boolean }[] = [];
	for (const weekStart of batch) {
		const res = await enqueueJob(
			{
				projectId: input.projectId,
				type: COLLECT_JOB_TYPE,
				idempotencyKey: backfillIdempotencyKey(weekStart),
				priority,
				payloadJson: JSON.stringify({ projectId: input.projectId, weekStart })
			},
			input.db
		);
		enqueued.push({ weekStart, jobId: res.id, created: res.created });
	}

	return { targetWeeks, alreadyPresent, enqueued, remaining, dryRun: false };
}
