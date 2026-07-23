/**
 * GSC-002 — Le JUGEMENT du collecteur GSC (BACKLOG GSC-002, SPEC §9.1).
 *
 * Module PUR (zéro import db/`$env`/réseau), dans la lignée de `job-limits.ts` et
 * `job-graph.ts` : il décide **quelle semaine collecter** et **quelles lignes en
 * tirer** ; `collectors/gsc-query-page.ts` exécute.
 *
 * Les helpers de semaine vivaient dans `gsc-analytics.ts`, qui importe `db`
 * statiquement — donc inatteignables par vitest et par tout runner hors runtime
 * SvelteKit. Ils sont ici, et `gsc-analytics.ts` les réimporte : une seule
 * définition de « dernière semaine complète » dans le repo. Deux auraient dérivé,
 * et un collecteur qui ne collecte pas la semaine que l'écran affiche est un bug
 * dont personne ne voit la cause.
 */

/** Latence de consolidation GSC. Une semaine plus fraîche renverrait du partiel. */
export const GSC_LATENCY_DAYS = 3;

/** Plafond de lignes par appel imposé par l'API Search Analytics. */
export const GSC_PAGE_SIZE = 25_000;

/**
 * Garde-fou de pagination. À 25 000 lignes la page, 40 pages = 1 000 000 de lignes
 * pour UNE semaine d'UN projet — le parc entier en compte 73 009 toutes semaines
 * confondues. Atteindre cette borne signifie que quelque chose ne va pas (boucle
 * qui ne progresse pas, propriété inattendue) : mieux vaut échouer fort que
 * paginer sans fin dans un budget de drain de 240 s.
 */
export const MAX_PAGES = 40;

// ── Semaines ────────────────────────────────────────────────────────

/** Lundi (début de semaine ISO) de la semaine contenant `date`, en UTC. */
export function weekStartOf(date: Date): string {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const dow = d.getUTCDay(); // 0 = dimanche
	d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
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

/** Dernière semaine lundi→dimanche entièrement consolidée. */
export function latestCompleteWeekStart(now: Date = new Date()): string {
	const ref = new Date(now.getTime() - GSC_LATENCY_DAYS * 24 * 60 * 60 * 1000);
	return previousWeekStart(weekStartOf(ref));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Semaine à collecter : celle demandée, à défaut la dernière complète.
 *
 * Une semaine demandée est **normalisée sur son lundi**. Sans ça, `--week
 * 2026-07-08` (un mercredi) écrirait des observations dont la `period_start` ne
 * tombe sur celle d'aucune autre semaine : elles seraient invisibles du détecteur
 * (qui groupe par `period_start`) tout en occupant la base. Une date illisible
 * **lève** — deviner une semaine serait pire que refuser.
 */
export function resolveCollectionWeek(input: {
	requested?: string | null;
	now?: Date;
}): { weekStart: string; weekEnd: string; requested: boolean } {
	const requested = input.requested?.trim();
	if (requested) {
		if (!ISO_DATE.test(requested) || Number.isNaN(Date.parse(`${requested}T00:00:00Z`))) {
			throw new Error(`Semaine demandée illisible : "${requested}" (attendu YYYY-MM-DD).`);
		}
		const weekStart = weekStartOf(new Date(`${requested}T00:00:00Z`));
		return { weekStart, weekEnd: weekEndOf(weekStart), requested: true };
	}
	const weekStart = latestCompleteWeekStart(input.now ?? new Date());
	return { weekStart, weekEnd: weekEndOf(weekStart), requested: false };
}

// ── Normalisation des lignes ────────────────────────────────────────

/**
 * Device manquant → `'UNKNOWN'`.
 *
 * Valeur reprise du chemin legacy (`pullWeeklySnapshot`) À DESSEIN : le device
 * fait partie de la clé unique des observations. Choisir `''` ici ferait de la
 * même mesure une ligne DIFFÉRENTE des 73 009 déjà en base, donc un doublon
 * silencieux au lieu d'une mise à jour. Mesuré : la base ne contient que
 * MOBILE / DESKTOP / TABLET, mais la garde reste — l'API peut omettre la clé.
 */
export function normalizeDevice(raw: string | undefined | null): string {
	const v = (raw ?? '').trim();
	return v === '' ? 'UNKNOWN' : v.toUpperCase();
}

export interface RawGscRow {
	keys?: string[];
	clicks?: number;
	impressions?: number;
	ctr?: number;
	position?: number;
}

export interface NormalizedGscRow {
	query: string;
	page: string;
	device: string;
	clicks: number;
	impressions: number;
	ctr: number;
	position: number;
}

/** Clé unique d'une observation query×page×device (miroir de `gsc_qp_obs_unique`). */
export function rowKey(row: { query: string; page: string; device: string }): string {
	// `\x1f` (unit separator) : un séparateur qui ne peut pas apparaître dans une
	// requête ni dans une URL, donc deux clés distinctes ne peuvent pas collisionner.
	return [row.query, row.page, row.device].join('\x1f');
}

/**
 * Normalise et DÉDUPLIQUE les lignes brutes d'une collecte.
 *
 * La déduplication n'est pas cosmétique : Postgres refuse deux lignes de même clé
 * dans un même `INSERT ... ON CONFLICT DO UPDATE` (« cannot affect row a second
 * time »), donc un doublon ferait échouer **tout le lot**. Deux lignes de même clé
 * peuvent apparaître si la casse du device diffère, ou à la frontière de deux
 * pages de pagination.
 *
 * **L'URL de page est laissée BRUTE**, telle que le provider la rend. La
 * normaliser ici (trailing slash, fragment, casse) ferait diverger la clé unique
 * des lignes déjà posées → des doublons que rien ne signale. La normalisation est
 * une affaire de LECTURE (`normalizePageUrl`, `gsc-analytics.ts`).
 */
export function normalizeRows(rows: RawGscRow[]): {
	rows: NormalizedGscRow[];
	duplicates: number;
	skipped: number;
} {
	const byKey = new Map<string, NormalizedGscRow>();
	let duplicates = 0;
	let skipped = 0;

	for (const raw of rows) {
		const keys = raw.keys ?? [];
		const query = keys[0] ?? '';
		const page = keys[1] ?? '';
		// Une ligne sans requête ET sans page ne désigne aucun fait : la garder
		// créerait une observation dont la clé est vide, que rien ne peut relire.
		if (query === '' && page === '') {
			skipped++;
			continue;
		}
		const row: NormalizedGscRow = {
			query,
			page,
			device: normalizeDevice(keys[2]),
			clicks: raw.clicks ?? 0,
			impressions: raw.impressions ?? 0,
			ctr: raw.ctr ?? 0,
			position: raw.position ?? 0
		};
		const key = rowKey(row);
		if (byKey.has(key)) {
			duplicates++;
			// La dernière gagne : GSC rend ses lignes triées par clics décroissants,
			// et un doublon de frontière de page porte la même mesure.
			byKey.set(key, row);
			continue;
		}
		byKey.set(key, row);
	}

	return { rows: [...byKey.values()], duplicates, skipped };
}

// ── Totaux ──────────────────────────────────────────────────────────

export interface CollectionTotals {
	rowCount: number;
	totalClicks: number;
	totalImpressions: number;
	avgCtr: number;
	avgPosition: number;
}

/**
 * Totaux d'une semaine, avec la MÊME arithmétique que le chemin legacy : CTR et
 * position moyens pondérés par les **impressions**. Une moyenne arithmétique de
 * positions donnerait le même poids à une requête vue 3 fois et à une vue 3 000
 * fois — et ferait diverger le chiffre affiché de celui déjà en base.
 */
export function computeTotals(rows: NormalizedGscRow[]): CollectionTotals {
	let totalClicks = 0;
	let totalImpressions = 0;
	let weightedPositionSum = 0;
	for (const r of rows) {
		totalClicks += r.clicks;
		totalImpressions += r.impressions;
		weightedPositionSum += r.position * r.impressions;
	}
	return {
		rowCount: rows.length,
		totalClicks,
		totalImpressions,
		avgCtr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
		avgPosition: totalImpressions > 0 ? weightedPositionSum / totalImpressions : 0
	};
}

// ── Pagination ──────────────────────────────────────────────────────

/**
 * Faut-il demander une page de plus ?
 *
 * Une page **pleine** signifie « il y a probablement une suite » ; une page
 * incomplète clôt la pagination. La borne `MAX_PAGES` est un garde-fou, pas une
 * troncature attendue : l'atteindre doit ÉCHOUER (cf. `assertPageBudget`), jamais
 * rendre une semaine silencieusement partielle.
 */
export function hasMorePages(lastPageSize: number, pageSize: number = GSC_PAGE_SIZE): boolean {
	return lastPageSize >= pageSize;
}

export function assertPageBudget(pagesFetched: number): void {
	if (pagesFetched >= MAX_PAGES) {
		throw new Error(
			`Pagination GSC anormale : ${pagesFetched} pages atteintes (borne ${MAX_PAGES}). ` +
				'Collecte interrompue sans écriture.'
		);
	}
}
