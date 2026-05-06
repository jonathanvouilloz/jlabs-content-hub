import { and, eq, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import {
	gscQueryPageData,
	gscSnapshots,
	gscWeeklyDiffs,
	indexingCredentials
} from './db/schema.js';
import { getAccessTokenForProject } from './indexing.js';
import { createId } from './utils.js';

const SEARCH_ANALYTICS_BASE = 'https://www.googleapis.com/webmasters/v3/sites';
const WEBMASTERS_SITES_LIST = 'https://www.googleapis.com/webmasters/v3/sites';
const PAGE_SIZE = 25_000;
const GSC_LATENCY_DAYS = 3;

type GscDimension = 'query' | 'page' | 'device' | 'date';

interface GscRow {
	keys: string[];
	clicks: number;
	impressions: number;
	ctr: number;
	position: number;
}

interface SearchAnalyticsResponse {
	rows?: GscRow[];
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

// ── Date helpers ──────────────────────────────────────────────────

/**
 * Returns the Monday (ISO week start) of the week containing `date`, formatted YYYY-MM-DD (UTC).
 */
export function weekStartOf(date: Date): string {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const dow = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
	const diff = (dow + 6) % 7; // days back to Monday
	d.setUTCDate(d.getUTCDate() - diff);
	return d.toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

export function previousWeekStart(weekStart: string): string {
	return addDaysIso(weekStart, -7);
}

export function weekEndOf(weekStart: string): string {
	return addDaysIso(weekStart, 6);
}

/**
 * Most recent fully complete week (Monday-Sunday) accounting for GSC ~3-day latency.
 */
export function latestCompleteWeekStart(now: Date = new Date()): string {
	const ref = new Date(now.getTime() - GSC_LATENCY_DAYS * 24 * 60 * 60 * 1000);
	const thisWeekMonday = weekStartOf(ref);
	return previousWeekStart(thisWeekMonday);
}

// ── List sites accessible to service account ─────────────────────

interface ListSitesResponse {
	siteEntry?: Array<{ siteUrl: string; permissionLevel: string }>;
}

export async function listAccessibleSites(projectId: string): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
	const { token } = await getAccessTokenForProject(projectId);
	const res = await fetch(WEBMASTERS_SITES_LIST, {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GSC sites list ${res.status}: ${text.slice(0, 500)}`);
	}
	const json = (await res.json()) as ListSitesResponse;
	return json.siteEntry ?? [];
}

// ── GSC API call ──────────────────────────────────────────────────

function encodeSiteUrlPath(siteUrl: string): string {
	// GSC API requires `:` in `sc-domain:foo` to NOT be encoded as %3A.
	// encodeURIComponent encodes `:` aggressively — we restore it for path-segment compatibility.
	return encodeURIComponent(siteUrl).replace(/%3A/g, ':');
}

export async function searchAnalyticsQuery(params: {
	projectId: string;
	siteUrl: string;
	startDate: string;
	endDate: string;
	dimensions: GscDimension[];
}): Promise<GscRow[]> {
	const { token } = await getAccessTokenForProject(params.projectId);
	const url = `${SEARCH_ANALYTICS_BASE}/${encodeSiteUrlPath(params.siteUrl)}/searchAnalytics/query`;
	const all: GscRow[] = [];
	let startRow = 0;

	while (true) {
		const body = {
			startDate: params.startDate,
			endDate: params.endDate,
			dimensions: params.dimensions,
			rowLimit: PAGE_SIZE,
			startRow,
			dataState: 'final' as const
		};
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			const text = await res.text();
			let hint = '';
			if (res.status === 404 || res.status === 403) {
				try {
					const sites = await listAccessibleSites(params.projectId);
					if (sites.length === 0) {
						hint = ' [Aucune propriété GSC accessible — vérifie que le service account est bien ajouté en "user" sur la propriété dans Search Console → Settings → Users and permissions.]';
					} else {
						const list = sites.map((s) => s.siteUrl).join(', ');
						hint = ` [Propriétés accessibles par ce service account : ${list}. Mets à jour le siteUrl du projet avec un de ces formats exacts.]`;
					}
				} catch {
					// ignore secondary failure
				}
			}
			throw new Error(`GSC API ${res.status} pour siteUrl="${params.siteUrl}": ${text.slice(0, 200)}${hint}`);
		}
		const json = (await res.json()) as SearchAnalyticsResponse;
		const rows = json.rows ?? [];
		all.push(...rows);
		if (rows.length < PAGE_SIZE) break;
		startRow += rows.length;
	}
	return all;
}

// ── Snapshot orchestration ────────────────────────────────────────

export async function pullWeeklySnapshot(params: {
	projectId: string;
	weekStart: string;
	forceRefresh?: boolean;
}): Promise<{ snapshotId: string; rowCount: number; reused: boolean }> {
	const cred = await db.query.indexingCredentials.findFirst({
		where: eq(indexingCredentials.projectId, params.projectId)
	});
	if (!cred) throw new Error('No indexing credentials configured for this project');
	if (!cred.siteUrl) throw new Error('No siteUrl configured on indexing credentials');

	const weekEnd = weekEndOf(params.weekStart);

	// Idempotence: skip if a successful snapshot already exists, unless forced
	const existing = await db.query.gscSnapshots.findFirst({
		where: and(
			eq(gscSnapshots.projectId, params.projectId),
			eq(gscSnapshots.weekStart, params.weekStart)
		)
	});
	if (existing && existing.status === 'success' && !params.forceRefresh) {
		return { snapshotId: existing.id, rowCount: existing.rowCount, reused: true };
	}

	// Reset existing snapshot if forced or previous failed
	if (existing) {
		await db.delete(gscQueryPageData).where(eq(gscQueryPageData.snapshotId, existing.id));
		await db.delete(gscSnapshots).where(eq(gscSnapshots.id, existing.id));
	}

	const snapshotId = createId();
	await db.insert(gscSnapshots).values({
		id: snapshotId,
		projectId: params.projectId,
		weekStart: params.weekStart,
		weekEnd,
		status: 'pending'
	});

	try {
		const rows = await searchAnalyticsQuery({
			projectId: params.projectId,
			siteUrl: cred.siteUrl,
			startDate: params.weekStart,
			endDate: weekEnd,
			dimensions: ['query', 'page', 'device']
		});

		let totalClicks = 0;
		let totalImpressions = 0;
		let weightedPositionSum = 0;

		// Insert in chunks to avoid SQLite parameter limits (default ~999)
		const CHUNK = 200;
		for (let i = 0; i < rows.length; i += CHUNK) {
			const slice = rows.slice(i, i + CHUNK).map((r) => {
				totalClicks += r.clicks;
				totalImpressions += r.impressions;
				weightedPositionSum += r.position * r.impressions;
				return {
					id: createId(),
					snapshotId,
					projectId: params.projectId,
					weekStart: params.weekStart,
					query: r.keys[0] ?? '',
					page: r.keys[1] ?? '',
					device: r.keys[2] ?? 'UNKNOWN',
					clicks: r.clicks,
					impressions: r.impressions,
					ctr: r.ctr,
					position: r.position
				};
			});
			if (slice.length > 0) {
				await db.insert(gscQueryPageData).values(slice);
			}
		}

		const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
		const avgPosition = totalImpressions > 0 ? weightedPositionSum / totalImpressions : 0;

		await db
			.update(gscSnapshots)
			.set({
				status: 'success',
				totalClicks,
				totalImpressions,
				avgCtr,
				avgPosition,
				rowCount: rows.length,
				errorMessage: null
			})
			.where(eq(gscSnapshots.id, snapshotId));

		return { snapshotId, rowCount: rows.length, reused: false };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await db
			.update(gscSnapshots)
			.set({ status: 'failed', errorMessage: msg.slice(0, 1000) })
			.where(eq(gscSnapshots.id, snapshotId));
		throw err;
	}
}

// ── Diff computation ──────────────────────────────────────────────

interface AggregatedQueryRow {
	query: string;
	clicks: number;
	impressions: number;
	weightedPositionSum: number;
	topPageClicks: number;
	topPage: string;
}

async function aggregateByQuery(
	projectId: string,
	weekStart: string
): Promise<Map<string, AggregatedQueryRow>> {
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

function avgPosition(row: AggregatedQueryRow): number {
	return row.impressions > 0 ? row.weightedPositionSum / row.impressions : 0;
}

function makeEntry(
	query: string,
	curr: AggregatedQueryRow | undefined,
	prev: AggregatedQueryRow | undefined
): BucketEntry {
	const c = curr ?? { query, clicks: 0, impressions: 0, weightedPositionSum: 0, topPage: prev?.topPage ?? '', topPageClicks: 0 };
	const p = prev ?? { query, clicks: 0, impressions: 0, weightedPositionSum: 0, topPage: '', topPageClicks: 0 };
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

export async function computeWeeklyDiff(params: {
	projectId: string;
	weekStart: string;
}): Promise<WeeklyDiffPayload> {
	const prevWeekStart = previousWeekStart(params.weekStart);
	const [currMap, prevMap, currSnap, prevSnap] = await Promise.all([
		aggregateByQuery(params.projectId, params.weekStart),
		aggregateByQuery(params.projectId, prevWeekStart),
		db.query.gscSnapshots.findFirst({
			where: and(
				eq(gscSnapshots.projectId, params.projectId),
				eq(gscSnapshots.weekStart, params.weekStart)
			)
		}),
		db.query.gscSnapshots.findFirst({
			where: and(
				eq(gscSnapshots.projectId, params.projectId),
				eq(gscSnapshots.weekStart, prevWeekStart)
			)
		})
	]);

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

	// Upsert (delete + insert)
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

// ── Backfill ──────────────────────────────────────────────────────

export async function backfillProject(params: {
	projectId: string;
	weeks: number;
	forceRefresh?: boolean;
	onProgress?: (info: { weekStart: string; status: 'success' | 'skipped' | 'failed'; error?: string }) => void;
}): Promise<{ snapshotsCreated: number; snapshotsSkipped: number; errors: Array<{ weekStart: string; error: string }> }> {
	const errors: Array<{ weekStart: string; error: string }> = [];
	let created = 0;
	let skipped = 0;
	const latest = latestCompleteWeekStart();
	for (let i = 0; i < params.weeks; i++) {
		const weekStart = addDaysIso(latest, -7 * i);
		try {
			const res = await pullWeeklySnapshot({
				projectId: params.projectId,
				weekStart,
				forceRefresh: params.forceRefresh
			});
			if (res.reused) {
				skipped++;
				params.onProgress?.({ weekStart, status: 'skipped' });
			} else {
				created++;
				params.onProgress?.({ weekStart, status: 'success' });
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push({ weekStart, error: msg });
			params.onProgress?.({ weekStart, status: 'failed', error: msg });
		}
	}

	// Compute diffs after all snapshots are pulled (need N-1 to compute N's diff).
	// Iterate from oldest to newest so prev exists when we compute curr.
	for (let i = params.weeks - 1; i >= 0; i--) {
		const weekStart = addDaysIso(latest, -7 * i);
		try {
			await computeWeeklyDiff({ projectId: params.projectId, weekStart });
		} catch {
			// Ignore — diff failure shouldn't kill the batch
		}
	}

	return { snapshotsCreated: created, snapshotsSkipped: skipped, errors };
}

// ── Read helpers ──────────────────────────────────────────────────

export async function getSnapshot(projectId: string, weekStart: string) {
	return db.query.gscSnapshots.findFirst({
		where: and(eq(gscSnapshots.projectId, projectId), eq(gscSnapshots.weekStart, weekStart))
	});
}

export async function getDiff(projectId: string, weekStart: string): Promise<WeeklyDiffPayload | null> {
	const row = await db.query.gscWeeklyDiffs.findFirst({
		where: and(eq(gscWeeklyDiffs.projectId, projectId), eq(gscWeeklyDiffs.weekStart, weekStart))
	});
	if (!row) return null;
	return {
		kpis: JSON.parse(row.kpis) as KpiSummary,
		rising: JSON.parse(row.rising) as BucketEntry[],
		falling: JSON.parse(row.falling) as BucketEntry[],
		opportunities: JSON.parse(row.opportunities) as BucketEntry[],
		newKeywords: JSON.parse(row.newKeywords) as BucketEntry[],
		lostKeywords: JSON.parse(row.lostKeywords) as BucketEntry[]
	};
}

export async function listSnapshots(projectId: string, limit = 52) {
	return db
		.select({
			weekStart: gscSnapshots.weekStart,
			weekEnd: gscSnapshots.weekEnd,
			status: gscSnapshots.status,
			totalClicks: gscSnapshots.totalClicks,
			totalImpressions: gscSnapshots.totalImpressions,
			avgCtr: gscSnapshots.avgCtr,
			avgPosition: gscSnapshots.avgPosition,
			rowCount: gscSnapshots.rowCount,
			fetchedAt: gscSnapshots.fetchedAt
		})
		.from(gscSnapshots)
		.where(eq(gscSnapshots.projectId, projectId))
		.orderBy(sql`${gscSnapshots.weekStart} DESC`)
		.limit(limit);
}
