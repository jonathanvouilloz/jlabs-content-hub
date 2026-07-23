/**
 * Diff hebdomadaire legacy (KPI + buckets rising/falling/opportunités), extrait de
 * `gsc-analytics.ts` par GSC-002 — comportement inchangé, client INJECTÉ.
 *
 * Pourquoi l'extraction. Le collecteur doit recalculer ce diff après sa double
 * écriture legacy, sinon le dashboard affiche des KPI figés au-dessus de données
 * fraîches — le pire des deux mondes. Or `gsc-analytics.ts` importe `db`
 * STATIQUEMENT : l'importer depuis le collecteur (même dynamiquement) rendrait ce
 * dernier inchargeable hors runtime SvelteKit, ce qu'on vient précisément de
 * gagner. Le diff vit donc ici, avec `resolveDb`, et `gsc-analytics.ts` le
 * réexporte pour ses appelants historiques.
 *
 * Ce module reste du LEGACY : il lit `gsc_query_page_data`, pas les observations.
 * Il disparaîtra quand l'écran lira les observations (E06/GSC-003) — c'est la
 * dette nommée de la décision « un seul fetch, double écriture ».
 */
import { and, eq } from 'drizzle-orm';
import { gscQueryPageData, gscSnapshots, gscWeeklyDiffs } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { createId } from './utils.js';
import { previousWeekStart } from './collectors/gsc-collector-state.js';

async function resolveDb(client?: AppDb): Promise<AppDb> {
	if (client) return client;
	const mod = await import('./db/index.js');
	return mod.db as unknown as AppDb;
}

export interface BucketEntry {
	query: string;
	page: string;
	clicks: number;
	clicksPrev: number;
	deltaClicks: number;
	impressions: number;
	impressionsPrev: number;
	deltaImpressions: number;
	position: number;
	positionPrev: number;
	deltaPosition: number;
}

export interface KpiSummary {
	clicks: { curr: number; prev: number; deltaAbs: number; deltaPct: number };
	impressions: { curr: number; prev: number; deltaAbs: number; deltaPct: number };
	ctr: { curr: number; prev: number; deltaAbs: number };
	position: { curr: number; prev: number; deltaAbs: number };
}

export interface WeeklyDiffPayload {
	kpis: KpiSummary;
	rising: BucketEntry[];
	falling: BucketEntry[];
	opportunities: BucketEntry[];
	newKeywords: BucketEntry[];
	lostKeywords: BucketEntry[];
}

export interface AggregatedQueryRow {
	query: string;
	clicks: number;
	impressions: number;
	weightedPositionSum: number;
	topPageClicks: number;
	topPage: string;
}

/**
 * Agrégation par requête d'une semaine legacy. Exportée : `computeActions` et
 * `computePositionMovers` (`gsc-analytics.ts`) s'en servent aussi, et deux
 * agrégations d'une même donnée finiraient par ne plus dire la même chose.
 */
export async function aggregateByQuery(
	projectId: string,
	weekStart: string,
	client?: AppDb
): Promise<Map<string, AggregatedQueryRow>> {
	const db = await resolveDb(client);
	const rows = await db
		.select({
			query: gscQueryPageData.query,
			page: gscQueryPageData.page,
			clicks: gscQueryPageData.clicks,
			impressions: gscQueryPageData.impressions,
			position: gscQueryPageData.position
		})
		.from(gscQueryPageData)
		.where(
			and(eq(gscQueryPageData.projectId, projectId), eq(gscQueryPageData.weekStart, weekStart))
		);

	const map = new Map<string, AggregatedQueryRow>();
	for (const r of rows) {
		const existing = map.get(r.query);
		if (existing) {
			existing.clicks += r.clicks;
			existing.impressions += r.impressions;
			existing.weightedPositionSum += r.position * r.impressions;
			if (r.clicks > existing.topPageClicks) {
				existing.topPageClicks = r.clicks;
				existing.topPage = r.page;
			}
		} else {
			map.set(r.query, {
				query: r.query,
				clicks: r.clicks,
				impressions: r.impressions,
				weightedPositionSum: r.position * r.impressions,
				topPageClicks: r.clicks,
				topPage: r.page
			});
		}
	}
	return map;
}

/** Position moyenne pondérée par les impressions (cf. `computeTotals`). */
export function avgPosition(row: AggregatedQueryRow): number {
	return row.impressions > 0 ? row.weightedPositionSum / row.impressions : 0;
}

function makeEntry(
	query: string,
	curr: AggregatedQueryRow | undefined,
	prev: AggregatedQueryRow | undefined
): BucketEntry {
	const c = curr ?? {
		query,
		clicks: 0,
		impressions: 0,
		weightedPositionSum: 0,
		topPage: prev?.topPage ?? '',
		topPageClicks: 0
	};
	const p = prev ?? {
		query,
		clicks: 0,
		impressions: 0,
		weightedPositionSum: 0,
		topPage: '',
		topPageClicks: 0
	};
	return {
		query,
		page: c.topPage || p.topPage || '',
		clicks: c.clicks,
		clicksPrev: p.clicks,
		deltaClicks: c.clicks - p.clicks,
		impressions: c.impressions,
		impressionsPrev: p.impressions,
		deltaImpressions: c.impressions - p.impressions,
		position: avgPosition(c),
		positionPrev: avgPosition(p),
		deltaPosition: avgPosition(c) - avgPosition(p)
	};
}

export async function computeWeeklyDiff(
	params: { projectId: string; weekStart: string },
	client?: AppDb
): Promise<WeeklyDiffPayload> {
	const db = await resolveDb(client);
	const prevWeekStart = previousWeekStart(params.weekStart);
	const [currMap, prevMap, currSnapRows, prevSnapRows] = await Promise.all([
		aggregateByQuery(params.projectId, params.weekStart, db),
		aggregateByQuery(params.projectId, prevWeekStart, db),
		db
			.select()
			.from(gscSnapshots)
			.where(
				and(
					eq(gscSnapshots.projectId, params.projectId),
					eq(gscSnapshots.weekStart, params.weekStart)
				)
			)
			.limit(1),
		db
			.select()
			.from(gscSnapshots)
			.where(
				and(eq(gscSnapshots.projectId, params.projectId), eq(gscSnapshots.weekStart, prevWeekStart))
			)
			.limit(1)
	]);
	const currSnap = currSnapRows[0];
	const prevSnap = prevSnapRows[0];

	const allKeys = new Set<string>([...currMap.keys(), ...prevMap.keys()]);
	const entries: BucketEntry[] = [];
	for (const k of allKeys) {
		entries.push(makeEntry(k, currMap.get(k), prevMap.get(k)));
	}

	const rising = entries
		.filter((e) => e.deltaClicks > 0)
		.sort((a, b) => b.deltaClicks - a.deltaClicks)
		.slice(0, 10);

	const falling = entries
		.filter((e) => e.deltaClicks < 0)
		.sort((a, b) => a.deltaClicks - b.deltaClicks)
		.slice(0, 10);

	const opportunities = entries
		.filter((e) => e.impressions >= 10 && e.clicks === 0 && e.position > 20)
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, 10);

	const newKeywords = entries
		.filter((e) => e.clicksPrev === 0 && e.impressionsPrev === 0 && e.impressions > 0)
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, 10);

	const lostKeywords = entries
		.filter((e) => e.clicks === 0 && e.impressions === 0 && e.impressionsPrev > 0)
		.sort((a, b) => b.impressionsPrev - a.impressionsPrev)
		.slice(0, 10);

	const currClicks = currSnap?.totalClicks ?? 0;
	const prevClicks = prevSnap?.totalClicks ?? 0;
	const currImpressions = currSnap?.totalImpressions ?? 0;
	const prevImpressions = prevSnap?.totalImpressions ?? 0;
	const currCtr = currSnap?.avgCtr ?? 0;
	const prevCtr = prevSnap?.avgCtr ?? 0;
	const currPosition = currSnap?.avgPosition ?? 0;
	const prevPosition = prevSnap?.avgPosition ?? 0;

	const pct = (curr: number, prev: number) => {
		if (prev === 0) return curr === 0 ? 0 : 100;
		return ((curr - prev) / prev) * 100;
	};

	const kpis: KpiSummary = {
		clicks: {
			curr: currClicks,
			prev: prevClicks,
			deltaAbs: currClicks - prevClicks,
			deltaPct: pct(currClicks, prevClicks)
		},
		impressions: {
			curr: currImpressions,
			prev: prevImpressions,
			deltaAbs: currImpressions - prevImpressions,
			deltaPct: pct(currImpressions, prevImpressions)
		},
		ctr: { curr: currCtr, prev: prevCtr, deltaAbs: currCtr - prevCtr },
		position: { curr: currPosition, prev: prevPosition, deltaAbs: currPosition - prevPosition }
	};

	const payload: WeeklyDiffPayload = {
		kpis,
		rising,
		falling,
		opportunities,
		newKeywords,
		lostKeywords
	};

	// Upsert (delete + insert) — `gsc_weekly_diffs` n'a pas d'unique sur
	// (project, week) sur lequel un ON CONFLICT pourrait s'appuyer.
	await db
		.delete(gscWeeklyDiffs)
		.where(
			and(
				eq(gscWeeklyDiffs.projectId, params.projectId),
				eq(gscWeeklyDiffs.weekStart, params.weekStart)
			)
		);
	await db.insert(gscWeeklyDiffs).values({
		id: createId(),
		projectId: params.projectId,
		weekStart: params.weekStart,
		kpis: JSON.stringify(kpis),
		rising: JSON.stringify(rising),
		falling: JSON.stringify(falling),
		opportunities: JSON.stringify(opportunities),
		newKeywords: JSON.stringify(newKeywords),
		lostKeywords: JSON.stringify(lostKeywords)
	});

	return payload;
}
