/**
 * DATA (migrate) — Transforms PURS pour le backfill des observations.
 *
 * Zéro import runtime (ni db, ni `$env` : les interfaces d'input sont importées
 * en `import type` → élidées à la compilation) → testables en isolation par vitest.
 *
 * Portent la logique DÉRIVÉE de la phase migrate :
 *   - rollup page-level = agrégation query→page (position pondérée par impressions,
 *     miroir de la moyenne pondérée attendue côté série page) ;
 *   - keyword rank = ligne REPRÉSENTATIVE (impressions max) par (keyword, device,
 *     semaine), restreint à la watchlist `tracked_keywords` (sémantique epic-23).
 *
 * Backfill legacy : `run_id = null` (aucun run collecteur), `schema_version = 1`,
 * `payload_json = null` (la série normalisée suffit ; le brut legacy n'a pas de
 * valeur). La normalisation reste l'IDENTITÉ — on reflète les lignes déjà stockées.
 */
import type {
	UpsertGscQueryPageInput,
	UpsertGscPageInput,
	UpsertGmbInsightInput,
	UpsertKeywordRankInput
} from './observations.js';

const BACKFILL_DEFAULTS = { runId: null, schemaVersion: 1, payloadJson: null } as const;

// ── Lignes sources (formes legacy normalisées) ──────────────────────

/** Ligne `gsc_query_page_data` + `week_end` joint depuis `gsc_snapshots`. */
export interface GscQueryPageSourceRow {
	projectId: string;
	weekStart: string;
	weekEnd: string;
	query: string;
	page: string;
	device: string;
	clicks: number;
	impressions: number;
	ctr: number;
	position: number;
}

/** Ligne `gmb_insights_daily`. */
export interface GmbInsightSourceRow {
	projectId: string;
	date: string;
	gmbLocationId: string;
	metric: string;
	value: number;
}

/**
 * Ligne candidate pour le rang d'un mot-clé suivi : une ligne `gsc_query_page_data`
 * dont `query` matche un `tracked_keywords.keyword` non archivé.
 */
export interface KeywordRankSourceRow {
	projectId: string;
	weekStart: string;
	keyword: string;
	device: string;
	page: string;
	clicks: number;
	impressions: number;
	ctr: number;
	position: number;
}

// ── 1. GSC query×page (1:1) ─────────────────────────────────────────

export function toGscQueryPageInput(row: GscQueryPageSourceRow): UpsertGscQueryPageInput {
	return {
		projectId: row.projectId,
		periodStart: row.weekStart,
		periodEnd: row.weekEnd,
		query: row.query,
		page: row.page,
		device: row.device ?? '',
		clicks: row.clicks,
		impressions: row.impressions,
		ctr: row.ctr,
		position: row.position,
		...BACKFILL_DEFAULTS
	};
}

// ── 2. GSC agrégat page (rollup dérivé) ─────────────────────────────

/**
 * Position agrégée d'un ensemble de lignes : moyenne PONDÉRÉE par impressions
 * (une page vue 1000× à la position 3 pèse plus qu'une vue 1× à la position 50).
 * Total d'impressions nul → 0 (aucune position à représenter).
 */
export function weightedPosition(rows: Array<{ position: number; impressions: number }>): number {
	let num = 0;
	let den = 0;
	for (const r of rows) {
		num += r.position * r.impressions;
		den += r.impressions;
	}
	return den > 0 ? num / den : 0;
}

/**
 * Agrège les lignes query×page en lignes page×device : somme clicks/impressions,
 * `ctr = clicks / impressions` (0 si aucune impression), position pondérée. Groupé
 * par (projet, semaine, page, device). Appelé par le runner PAR (projet, semaine)
 * → l'entrée reste une petite tranche, jamais les 73k lignes d'un coup.
 */
export function rollupPagesFromQueryPage(rows: GscQueryPageSourceRow[]): UpsertGscPageInput[] {
	const groups = new Map<string, GscQueryPageSourceRow[]>();
	for (const r of rows) {
		// séparateur 0x1F : jamais présent dans une URL/device légitime.
		const key = [r.projectId, r.weekStart, r.page, r.device ?? ''].join('\x1f');
		const g = groups.get(key);
		if (g) g.push(r);
		else groups.set(key, [r]);
	}
	const out: UpsertGscPageInput[] = [];
	for (const g of groups.values()) {
		const first = g[0];
		const clicks = g.reduce((s, r) => s + r.clicks, 0);
		const impressions = g.reduce((s, r) => s + r.impressions, 0);
		out.push({
			projectId: first.projectId,
			periodStart: first.weekStart,
			periodEnd: first.weekEnd,
			page: first.page,
			device: first.device ?? '',
			clicks,
			impressions,
			ctr: impressions > 0 ? clicks / impressions : 0,
			position: weightedPosition(g),
			...BACKFILL_DEFAULTS
		});
	}
	return out;
}

// ── 3. GMB insight (1:1) ────────────────────────────────────────────

export function toGmbInsightInput(row: GmbInsightSourceRow): UpsertGmbInsightInput {
	return {
		projectId: row.projectId,
		observedDate: row.date,
		locationId: row.gmbLocationId,
		metric: row.metric,
		value: row.value,
		...BACKFILL_DEFAULTS
	};
}

// ── 4. Keyword rank (dérivé, watchlist seulement) ───────────────────

/**
 * Ligne représentative d'un (keyword, device, semaine) quand plusieurs pages
 * rankent : celle à IMPRESSIONS max. Départage : position la plus basse (meilleur
 * rang), puis `page` croissante → sélection 100 % déterministe (pas de dépendance
 * à l'ordre d'arrivée). L'entrée ne doit jamais être vide.
 */
export function pickKeywordRankRow(rows: KeywordRankSourceRow[]): KeywordRankSourceRow {
	if (rows.length === 0) {
		throw new Error('pickKeywordRankRow : aucune ligne candidate.');
	}
	return rows.reduce((best, r) => {
		if (r.impressions !== best.impressions) return r.impressions > best.impressions ? r : best;
		if (r.position !== best.position) return r.position < best.position ? r : best;
		return r.page < best.page ? r : best;
	});
}

export function toKeywordRankInput(row: KeywordRankSourceRow): UpsertKeywordRankInput {
	return {
		projectId: row.projectId,
		observedDate: row.weekStart,
		keyword: row.keyword,
		device: row.device ?? '',
		page: row.page ?? null,
		position: row.position,
		clicks: row.clicks,
		impressions: row.impressions,
		ctr: row.ctr,
		...BACKFILL_DEFAULTS
	};
}

/**
 * Construit les inputs keyword_rank depuis toutes les lignes candidates (tracked ×
 * gsc_query_page_data) : groupe par (projet, keyword, device, semaine), retient la
 * représentative, mappe. Une ligne par clé d'upsert `keyword_rank_obs_unique`.
 */
export function buildKeywordRankInputs(rows: KeywordRankSourceRow[]): UpsertKeywordRankInput[] {
	const groups = new Map<string, KeywordRankSourceRow[]>();
	for (const r of rows) {
		const key = [r.projectId, r.keyword, r.device ?? '', r.weekStart].join('\x1f');
		const g = groups.get(key);
		if (g) g.push(r);
		else groups.set(key, [r]);
	}
	const out: UpsertKeywordRankInput[] = [];
	for (const g of groups.values()) {
		out.push(toKeywordRankInput(pickKeywordRankRow(g)));
	}
	return out;
}
