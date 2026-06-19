import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import {
	gscQueryPageData,
	gscSnapshots,
	gscWeeklyDiffs,
	indexingCredentials,
	trackedKeywords
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

// ── Action recommendations (opportunities + quick wins) ──────────

export interface ActionEntry {
	query: string;
	page: string;
	impressions: number;
	clicks: number;
	ctr: number;
	position: number;
	gainEstimate: number; // estimated weekly clicks gained if action lands
	verdict: string; // human-readable action recommendation
	verdictType: 'create_page' | 'optimize_existing' | 'optimize_meta' | 'expand_content';
}

const TARGET_CTR_TOP5 = 0.10; // industry-ish median CTR for position ~5

function isGenericPage(page: string): boolean {
	if (!page) return true;
	try {
		const u = new URL(page);
		const path = u.pathname.replace(/\/$/, '');
		// Homepage or top-level meta pages — query likely needs its own dedicated page
		return path === '' || /^\/(about|contact|services|home)$/i.test(path);
	} catch {
		return true;
	}
}

function buildOpportunityVerdict(entry: BucketEntry): { verdict: string; verdictType: ActionEntry['verdictType'] } {
	if (isGenericPage(entry.page)) {
		return {
			verdict: `Créer une page dédiée pour "${entry.query}" (page actuelle trop générique : ${entry.page || 'aucune'})`,
			verdictType: 'create_page'
		};
	}
	return {
		verdict: `Optimiser ${entry.page} pour mieux cibler "${entry.query}" (position ${entry.position.toFixed(0)})`,
		verdictType: 'optimize_existing'
	};
}

function buildQuickWinVerdict(row: { position: number; ctr: number }): { verdict: string; verdictType: ActionEntry['verdictType'] } {
	if (row.position < 6 && row.ctr < 0.05) {
		return {
			verdict: 'Optimiser title + meta description (CTR faible pour la position)',
			verdictType: 'optimize_meta'
		};
	}
	return {
		verdict: 'Enrichir le contenu pour passer top 5 (intent + maillage interne)',
		verdictType: 'expand_content'
	};
}

export async function computeActions(params: {
	projectId: string;
	weekStart: string;
	limit?: number;
}): Promise<{ opportunities: ActionEntry[]; quickWins: ActionEntry[] }> {
	const limit = params.limit ?? 5;

	// Opportunities: read from cached weekly diff (already filtered)
	const diff = await getDiff(params.projectId, params.weekStart);
	const oppEntries = diff?.opportunities ?? [];
	const opportunities: ActionEntry[] = oppEntries.slice(0, limit).map((e) => {
		const verdict = buildOpportunityVerdict(e);
		// Gain estimate : if we got to top 10, optimistic CTR ~5% on impressions
		const gainEstimate = Math.round(e.impressions * 0.05);
		return {
			query: e.query,
			page: e.page,
			impressions: e.impressions,
			clicks: e.clicks,
			ctr: e.impressions > 0 ? e.clicks / e.impressions : 0,
			position: e.position,
			gainEstimate,
			verdict: verdict.verdict,
			verdictType: verdict.verdictType
		};
	});

	// Quick wins: compute on-the-fly from raw data
	const aggregated = await aggregateByQuery(params.projectId, params.weekStart);
	const quickWinCandidates: ActionEntry[] = [];
	for (const row of aggregated.values()) {
		const pos = row.impressions > 0 ? row.weightedPositionSum / row.impressions : 0;
		if (pos < 5 || pos > 15) continue;
		if (row.impressions < 30) continue;
		if (row.clicks === 0 && pos > 10) continue; // covered by opportunities
		const ctr = row.impressions > 0 ? row.clicks / row.impressions : 0;
		const ctrGap = Math.max(0, TARGET_CTR_TOP5 - ctr);
		const gainEstimate = Math.round(row.impressions * ctrGap);
		if (gainEstimate < 1) continue;
		const verdict = buildQuickWinVerdict({ position: pos, ctr });
		quickWinCandidates.push({
			query: row.query,
			page: row.topPage,
			impressions: row.impressions,
			clicks: row.clicks,
			ctr,
			position: pos,
			gainEstimate,
			verdict: verdict.verdict,
			verdictType: verdict.verdictType
		});
	}
	const quickWins = quickWinCandidates
		.sort((a, b) => b.gainEstimate - a.gainEstimate)
		.slice(0, limit);

	return { opportunities, quickWins };
}

// ── Keyword position history (watchlist — epic 23) ───────────────

export interface KeywordWeekPoint {
	weekStart: string;
	/**
	 * Meilleure position de la semaine parmi les pages du site qui rankent réellement sur ce mot-clé
	 * (ancres jump-to et variantes www/protocole collapsées, pages sous le plancher anti-fluke écartées).
	 * C'est ce que le client voit en navigation privée. null si aucune donnée cette semaine.
	 */
	position: number | null;
	clicks: number;
	impressions: number;
	ctr: number;
	/** Page (normalisée) qui réalise cette meilleure position, ou null si pas de donnée. */
	topPage: string | null;
	/** Position de la page qui capte le plus de clics (la vraie landing page), ou null. */
	primaryPosition: number | null;
	/** Page (normalisée) qui capte le plus de clics cette semaine, ou null. */
	primaryPage: string | null;
}

/**
 * Builds the N-week position series for a single keyword (exact-match query), aligned on
 * the last N complete weeks. Weeks with no GSC data return position=null (a real gap, never 0).
 *
 * La position rapportée n'est PAS la moyenne pondérée sur toutes les lignes (query×page×device) :
 * ce blend était écrasé par les ancres jump-to mortes d'un article (#section, toutes à pos 9) et
 * par la cannibalisation entre plusieurs URLs du site → un chiffre ne correspondant à aucune page
 * réelle (cf. piège epic 23). On groupe désormais par page normalisée (normalizePageUrl) et on
 * rapporte la MEILLEURE position (headline) + la page principale par clics (primaryPosition).
 */
export async function getKeywordHistory(
	projectId: string,
	keyword: string,
	weeks = 12
): Promise<KeywordWeekPoint[]> {
	const latest = latestCompleteWeekStart();
	// Chronological list of the last `weeks` week-starts (oldest → newest).
	const weekStarts: string[] = [];
	for (let i = weeks - 1; i >= 0; i--) {
		weekStarts.push(addDaysIso(latest, -7 * i));
	}

	const rows = await db
		.select({
			weekStart: gscQueryPageData.weekStart,
			page: gscQueryPageData.page,
			clicks: gscQueryPageData.clicks,
			impressions: gscQueryPageData.impressions,
			position: gscQueryPageData.position
		})
		.from(gscQueryPageData)
		.where(
			and(
				eq(gscQueryPageData.projectId, projectId),
				eq(gscQueryPageData.query, keyword),
				inArray(gscQueryPageData.weekStart, weekStarts)
			)
		);

	interface PageAcc {
		clicks: number;
		impressions: number;
		weightedPositionSum: number;
	}
	// weekStart → (page normalisée → accumulateur). On collapse les ancres jump-to (#section) et les
	// variantes www/protocole AVANT tout calcul (normalizePageUrl), sinon un article et ses ancres
	// mortes à pos 9 noient la vraie landing page.
	const byWeek = new Map<string, Map<string, PageAcc>>();
	for (const r of rows) {
		let pages = byWeek.get(r.weekStart);
		if (!pages) {
			pages = new Map();
			byWeek.set(r.weekStart, pages);
		}
		const pageKey = normalizePageUrl(r.page);
		const acc = pages.get(pageKey);
		if (acc) {
			acc.clicks += r.clicks;
			acc.impressions += r.impressions;
			acc.weightedPositionSum += r.position * r.impressions;
		} else {
			pages.set(pageKey, {
				clicks: r.clicks,
				impressions: r.impressions,
				weightedPositionSum: r.position * r.impressions
			});
		}
	}

	const emptyPoint = (weekStart: string): KeywordWeekPoint => ({
		weekStart,
		position: null,
		clicks: 0,
		impressions: 0,
		ctr: 0,
		topPage: null,
		primaryPosition: null,
		primaryPage: null
	});

	return weekStarts.map((weekStart) => {
		const pages = byWeek.get(weekStart);
		if (!pages || pages.size === 0) return emptyPoint(weekStart);

		const all = [...pages.entries()].map(([page, acc]) => ({
			page,
			clicks: acc.clicks,
			impressions: acc.impressions,
			position: acc.impressions > 0 ? acc.weightedPositionSum / acc.impressions : 0
		}));
		const totalClicks = all.reduce((s, p) => s + p.clicks, 0);
		const totalImpressions = all.reduce((s, p) => s + p.impressions, 0);
		if (totalImpressions === 0) return emptyPoint(weekStart);

		// Plancher anti-fluke relatif au volume du kw : on écarte les pages à très faible exposition
		// (ex. 1 impression desktop à pos 1) qui fausseraient la « meilleure position ». Fallback sur
		// toutes les pages avec impressions si aucune n'atteint le plancher (très longue traîne).
		const floor = Math.max(2, 0.1 * totalImpressions);
		let eligible = all.filter((p) => p.impressions >= floor);
		if (eligible.length === 0) eligible = all.filter((p) => p.impressions > 0);

		// Headline = meilleure position parmi les pages éligibles (≈ ce que voit le client en incognito).
		const best = eligible.reduce((a, b) => (b.position < a.position ? b : a));
		// Page principale = celle qui capte réellement les clics (tie-break : impressions).
		const primary = eligible.reduce((a, b) => {
			if (b.clicks !== a.clicks) return b.clicks > a.clicks ? b : a;
			return b.impressions > a.impressions ? b : a;
		});

		return {
			weekStart,
			position: best.position,
			clicks: totalClicks,
			impressions: totalImpressions,
			ctr: totalClicks / totalImpressions,
			topPage: best.page,
			primaryPosition: primary.position,
			primaryPage: primary.page
		};
	});
}

export interface KeywordTrend {
	/** 'up' = la position s'améliore (baisse), 'down' = se dégrade, 'flat' = stable, 'insufficient' = pas assez de données. */
	verdict: 'up' | 'down' | 'flat' | 'insufficient';
	/** currentPosition - earliestPosition sur la fenêtre (négatif = amélioration). null si insuffisant. */
	deltaPosition: number | null;
	currentPosition: number | null;
	vsTarget?: { targetPosition: number; reached: boolean; gap: number };
}

const TREND_MIN_POINTS = 3;
const TREND_NOISE = 1.0; // positions : delta < 1 rang ⇒ stagne

/**
 * Verdict de tendance sur une série de positions. Une position plus BASSE est meilleure,
 * donc un delta négatif (position qui diminue) = amélioration ('up').
 */
export function computeKeywordTrend(
	series: KeywordWeekPoint[],
	targetPosition?: number | null
): KeywordTrend {
	const points = series.filter((p) => p.position !== null) as Array<KeywordWeekPoint & { position: number }>;
	const currentPosition = points.length > 0 ? points[points.length - 1].position : null;

	const vsTarget =
		targetPosition != null && currentPosition != null
			? {
					targetPosition,
					reached: currentPosition <= targetPosition,
					gap: currentPosition - targetPosition
				}
			: undefined;

	if (points.length < TREND_MIN_POINTS) {
		return { verdict: 'insufficient', deltaPosition: null, currentPosition, vsTarget };
	}

	const earliest = points[0].position;
	const deltaPosition = currentPosition! - earliest;
	let verdict: KeywordTrend['verdict'];
	if (deltaPosition <= -TREND_NOISE) verdict = 'up';
	else if (deltaPosition >= TREND_NOISE) verdict = 'down';
	else verdict = 'flat';

	return { verdict, deltaPosition, currentPosition, vsTarget };
}

// ── Watchlist (série + tendance par mot-clé suivi — epic 23) ─────

export interface WatchlistEntry {
	id: string;
	keyword: string;
	targetUrl: string | null;
	targetPosition: number | null;
	currentPosition: number | null;
	topPage: string | null;
	/** Position de la page qui capte le plus de clics (vraie landing page), dernière semaine avec donnée. */
	primaryPosition: number | null;
	/** URL qui capte le plus de clics, dernière semaine avec donnée. */
	primaryPage: string | null;
	trend: KeywordTrend;
	series: KeywordWeekPoint[];
}

/**
 * Watchlist enrichie d'un projet : pour chaque mot-clé non archivé, la série N semaines,
 * la position courante, la tendance (vs cible) et la page qui ranke.
 * Source unique partagée par l'UI admin, la vue client (?token=), l'export CSV et le digest.
 */
export async function getWatchlistWithSeries(
	projectId: string,
	weeks = 12
): Promise<WatchlistEntry[]> {
	const tracked = await db
		.select()
		.from(trackedKeywords)
		.where(and(eq(trackedKeywords.projectId, projectId), eq(trackedKeywords.archived, false)));

	const entries = await Promise.all(
		tracked.map(async (kw) => {
			const series = await getKeywordHistory(projectId, kw.keyword, weeks);
			const trend = computeKeywordTrend(series, kw.targetPosition);
			const latest = [...series].reverse().find((p) => p.position !== null) ?? null;
			return {
				id: kw.id,
				keyword: kw.keyword,
				targetUrl: kw.targetUrl,
				targetPosition: kw.targetPosition,
				currentPosition: trend.currentPosition,
				topPage: latest?.topPage ?? null,
				primaryPosition: latest?.primaryPosition ?? null,
				primaryPage: latest?.primaryPage ?? null,
				trend,
				series
			};
		})
	);

	// Meilleure position d'abord ; les mots-clés sans donnée en fin de liste.
	return entries.sort((a, b) => {
		if (a.currentPosition == null) return 1;
		if (b.currentPosition == null) return -1;
		return a.currentPosition - b.currentPosition;
	});
}

// ── Position movers (auto-découverte — epic 23) ──────────────────

export interface PositionMover {
	query: string;
	position: number;
	positionPrev: number;
	/** position - positionPrev : négatif = la position s'améliore (gain). */
	deltaPosition: number;
	impressions: number;
	clicks: number;
	topPage: string;
}

/**
 * Plus gros mouvements DE POSITION (gains/pertes) vs semaine N-1, sur tous les mots-clés.
 * Distinct de rising/falling (basés clics). Ne garde que les queries présentes les deux
 * semaines (delta réel) et au-dessus du seuil d'impressions, pour éviter le bruit.
 */
export async function computePositionMovers(params: {
	projectId: string;
	weekStart: string;
	minImpressions?: number;
	limit?: number;
}): Promise<{ gains: PositionMover[]; losses: PositionMover[] }> {
	const minImpressions = params.minImpressions ?? 20;
	const limit = params.limit ?? 10;
	const prevWeekStart = previousWeekStart(params.weekStart);

	const [currMap, prevMap] = await Promise.all([
		aggregateByQuery(params.projectId, params.weekStart),
		aggregateByQuery(params.projectId, prevWeekStart)
	]);

	const movers: PositionMover[] = [];
	for (const [query, curr] of currMap) {
		const prev = prevMap.get(query);
		if (!prev) continue; // pas de delta fiable sans semaine N-1
		if (curr.impressions < minImpressions) continue;
		const position = avgPosition(curr);
		const positionPrev = avgPosition(prev);
		if (position === 0 || positionPrev === 0) continue;
		movers.push({
			query,
			position,
			positionPrev,
			deltaPosition: position - positionPrev,
			impressions: curr.impressions,
			clicks: curr.clicks,
			topPage: curr.topPage
		});
	}

	const gains = movers
		.filter((m) => m.deltaPosition < 0)
		.sort((a, b) => a.deltaPosition - b.deltaPosition)
		.slice(0, limit);
	const losses = movers
		.filter((m) => m.deltaPosition > 0)
		.sort((a, b) => b.deltaPosition - a.deltaPosition)
		.slice(0, limit);

	return { gains, losses };
}

// ── Cannibalisation (plusieurs URLs pour une même requête — epic 23) ──

export interface CannibalPage {
	page: string;
	clicks: number;
	impressions: number;
	position: number;
	/** Part des impressions du conflit captée par cette URL (0..1). */
	share: number;
}

export interface CannibalizationEntry {
	query: string;
	totalImpressions: number;
	totalClicks: number;
	/** max(position) - min(position) entre les URLs en conflit. */
	positionSpread: number;
	/**
	 * Écart = position de la page dominante (le plus d'impressions) − meilleure position du conflit.
	 * > 0 : Google montre surtout une page qui ranke MOINS bien qu'une autre URL du site → cannibalisation
	 * actionnable (ex. un article noie la fiche qui ranke mieux). ≈ 0 : la bonne page est déjà mise en avant.
	 */
	misallocationGap: number;
	/** Nombre d'URLs en conflit positionnées dans le top 20. */
	conflictsInTop20: number;
	severity: 'high' | 'medium';
	/** URLs en conflit, triées par impressions décroissantes. */
	pages: CannibalPage[];
}

/**
 * Normalise une URL de page pour le comptage de cannibalisation : strip du fragment (#ancre),
 * du protocole, du préfixe www et du slash final. GSC remonte `…/article#section`, `http://`,
 * `https://www.` comme des « pages » distinctes — ce sont en réalité la même ressource ; sans ça
 * un seul article (avec ancres jump-to) ou une home en http/https produirait de faux conflits.
 */
function normalizePageUrl(raw: string): string {
	try {
		const u = new URL(raw);
		const host = u.hostname.replace(/^www\./, '');
		let path = u.pathname.replace(/\/+$/, '');
		if (path === '') path = '/';
		return `https://${host}${path}`;
	} catch {
		return raw.split('#')[0];
	}
}

/** Plancher absolu d'impressions/URL pour qu'un conflit compte (anti-bruit longue traîne). */
const CANNIBAL_MIN_FLOOR = 3;
/** Part minimale des impressions du mot-clé qu'une URL doit capter pour être un concurrent réel. */
const CANNIBAL_RELATIVE_SHARE = 0.15;

/**
 * Détecte la cannibalisation SEO d'une semaine : requêtes pour lesquelles ≥2 URLs du site
 * se partagent les impressions. Le seuil de significativité est RELATIF au volume du mot-clé
 * (`max(CANNIBAL_MIN_FLOOR, CANNIBAL_RELATIVE_SHARE × impressions du kw)`) — un seuil absolu masquait
 * toute cannibalisation sur les sites locaux où chaque kw money fait 5–40 imp/sem. `params.minImpressions`,
 * s'il est fourni, surcharge le plancher absolu (rétro-compat de la route).
 * Les devices ET variantes d'une même page (ancre/protocole/www) sont agrégés AVANT comptage
 * (cf. normalizePageUrl, sinon faux positifs). Position pondérée par impressions. `high` = ≥2 URLs en top 20.
 */
export async function computeCannibalization(params: {
	projectId: string;
	weekStart: string;
	minImpressions?: number;
	limit?: number;
}): Promise<CannibalizationEntry[]> {
	const minFloor = params.minImpressions ?? CANNIBAL_MIN_FLOOR;
	const limit = params.limit ?? 15;

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
			and(
				eq(gscQueryPageData.projectId, params.projectId),
				eq(gscQueryPageData.weekStart, params.weekStart)
			)
		);

	// Agrège par (query → page), en collapsant la dimension device.
	interface PageAcc {
		clicks: number;
		impressions: number;
		weightedPositionSum: number;
	}
	const byQuery = new Map<string, Map<string, PageAcc>>();
	for (const r of rows) {
		let pages = byQuery.get(r.query);
		if (!pages) {
			pages = new Map();
			byQuery.set(r.query, pages);
		}
		const pageKey = normalizePageUrl(r.page);
		const acc = pages.get(pageKey);
		if (acc) {
			acc.clicks += r.clicks;
			acc.impressions += r.impressions;
			acc.weightedPositionSum += r.position * r.impressions;
		} else {
			pages.set(pageKey, {
				clicks: r.clicks,
				impressions: r.impressions,
				weightedPositionSum: r.position * r.impressions
			});
		}
	}

	const entries: CannibalizationEntry[] = [];
	for (const [query, pages] of byQuery) {
		const allPages = [...pages.entries()].map(([page, acc]) => ({
			page,
			clicks: acc.clicks,
			impressions: acc.impressions,
			position: acc.impressions > 0 ? acc.weightedPositionSum / acc.impressions : 0
		}));
		// Seuil relatif au volume du mot-clé (+ plancher absolu) : une URL compte si elle capte une
		// part réelle des impressions. Indispensable pour le très local (kw à 5–40 imp/sem).
		const queryTotalImpressions = allPages.reduce((s, p) => s + p.impressions, 0);
		const threshold = Math.max(minFloor, CANNIBAL_RELATIVE_SHARE * queryTotalImpressions);
		const significant = allPages.filter((p) => p.impressions >= threshold && p.impressions > 0);
		if (significant.length < 2) continue; // pas de conflit

		const totalImpressions = significant.reduce((s, p) => s + p.impressions, 0);
		const totalClicks = significant.reduce((s, p) => s + p.clicks, 0);
		const positions = significant.map((p) => p.position);
		const positionSpread = Math.max(...positions) - Math.min(...positions);
		const conflictsInTop20 = significant.filter((p) => p.position <= 20).length;

		const sortedPages: CannibalPage[] = significant
			.map((p) => ({ ...p, share: totalImpressions > 0 ? p.impressions / totalImpressions : 0 }))
			.sort((a, b) => b.impressions - a.impressions);

		// Page dominante = celle qui capte le plus d'impressions (sortedPages[0]). Si elle ranke moins
		// bien que la meilleure URL du conflit, Google met en avant la mauvaise page → conflit actionnable.
		const bestPosition = Math.min(...positions);
		const misallocationGap = sortedPages[0].position - bestPosition;

		entries.push({
			query,
			totalImpressions,
			totalClicks,
			positionSpread,
			misallocationGap,
			conflictsInTop20,
			severity: conflictsInTop20 >= 2 ? 'high' : 'medium',
			pages: sortedPages
		});
	}

	// Priorité aux conflits où Google montre une page moins bien classée que la meilleure URL du site
	// (misallocationGap élevé = action SEO claire). Le volume d'impressions ne départage qu'à gap égal.
	return entries
		.sort((a, b) => b.misallocationGap - a.misallocationGap || b.totalImpressions - a.totalImpressions)
		.slice(0, limit);
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
