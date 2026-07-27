/**
 * IDX-002 — Lecture de l'état d'indexation : DEPUIS LA BASE, jamais un appel à la volée.
 *
 * C'est l'acceptation « le statut UI est dérivé de champs persistés, pas d'un appel à la
 * volée ». Elle n'est pas une préférence de performance : un écran qui appelle l'URL
 * Inspection API au rendu consomme du quota **à chaque rafraîchissement**, sur un compte que
 * les 6 projets partagent, et affiche un état qu'on ne peut pas comparer à hier — puisque rien
 * n'a été gardé. La page `/projects/[slug]/seo-data` du legacy fait exactement ça.
 *
 * ⚠️ Jamais `= ANY($n)` (driver Neon) : on filtre par égalité de date et, pour restreindre à
 * une liste d'URLs, par `inArray` (un `IN (…)` paramétré classique).
 *
 * Client drizzle INJECTÉ, comme partout depuis GSC-002 : ce module reste chargeable dans un
 * runner `tsx` (contrairement à `indexing.ts`, qui importe `db` statiquement).
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { indexObservations, projects } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { classifyCoverage, type IndexedClass } from './collectors/url-inspection-state.js';

export interface IndexStateRow {
	url: string;
	observedDate: string;
	verdict: string | null;
	coverageState: string | null;
	indexingState: string | null;
	robotsState: string | null;
	googleCanonical: string | null;
	userCanonical: string | null;
	lastCrawlAt: string | null;
	/** DÉRIVÉ à la lecture, jamais stocké (doctrine JOB-004/005). */
	indexedClass: IndexedClass;
	/**
	 * Google et le site ne sont pas d'accord sur le canonical. `null` = incomparable (l'un des
	 * deux manque) — « on ne peut pas comparer » n'est pas « ils sont d'accord ».
	 */
	canonicalMismatch: boolean | null;
}

/**
 * Le DERNIER état connu par URL pour un projet.
 *
 * `DISTINCT ON (url) … ORDER BY url, observed_date DESC` : une seule requête, la ligne la plus
 * récente de chaque URL. Sans `DISTINCT ON`, il faudrait charger tout l'historique et filtrer
 * en mémoire — ce qui ferait grossir la page avec l'ancienneté du projet.
 *
 * `since` borne l'historique consulté : une observation vieille de six mois n'est pas un
 * « état courant », c'est une archive. Sans borne, une page supprimée depuis longtemps
 * continuerait de figurer comme si son statut était d'actualité.
 */
export async function loadLatestIndexStates(input: {
	db: AppDb;
	projectId: string;
	/** Restreint à ces URLs (facultatif). */
	urls?: readonly string[];
	/** Borne basse d'`observed_date` (`YYYY-MM-DD`) — au-delà, c'est de l'archive. */
	since?: string | null;
	limit?: number;
}): Promise<IndexStateRow[]> {
	const filters = [eq(indexObservations.projectId, input.projectId)];
	if (input.since) filters.push(gte(indexObservations.observedDate, input.since));
	if (input.urls && input.urls.length > 0) {
		filters.push(inArray(indexObservations.url, [...input.urls]));
	}

	const rows = await input.db
		.selectDistinctOn([indexObservations.url], {
			url: indexObservations.url,
			observedDate: indexObservations.observedDate,
			verdict: indexObservations.verdict,
			coverageState: indexObservations.coverageState,
			indexingState: indexObservations.indexingState,
			robotsState: indexObservations.robotsState,
			googleCanonical: indexObservations.googleCanonical,
			userCanonical: indexObservations.userCanonical,
			lastCrawlAt: indexObservations.lastCrawlAt
		})
		.from(indexObservations)
		.where(and(...filters))
		.orderBy(indexObservations.url, desc(indexObservations.observedDate))
		.limit(Math.max(1, Math.floor(input.limit ?? 1000)));

	return rows.map((r) => ({
		...r,
		indexedClass: classifyCoverage(r.coverageState),
		canonicalMismatch:
			r.googleCanonical && r.userCanonical ? r.googleCanonical !== r.userCanonical : null
	}));
}

/**
 * L'HISTORIQUE d'une URL — l'acceptation « chaque inspection possède un historique ».
 *
 * Du plus récent au plus ancien : on vient chercher « qu'est-ce qui a changé », et la réponse
 * commence par l'état actuel.
 */
export async function loadIndexHistory(input: {
	db: AppDb;
	projectId: string;
	url: string;
	limit?: number;
}): Promise<IndexStateRow[]> {
	const rows = await input.db
		.select({
			url: indexObservations.url,
			observedDate: indexObservations.observedDate,
			verdict: indexObservations.verdict,
			coverageState: indexObservations.coverageState,
			indexingState: indexObservations.indexingState,
			robotsState: indexObservations.robotsState,
			googleCanonical: indexObservations.googleCanonical,
			userCanonical: indexObservations.userCanonical,
			lastCrawlAt: indexObservations.lastCrawlAt
		})
		.from(indexObservations)
		.where(
			and(eq(indexObservations.projectId, input.projectId), eq(indexObservations.url, input.url))
		)
		.orderBy(desc(indexObservations.observedDate))
		.limit(Math.max(1, Math.floor(input.limit ?? 90)));

	return rows.map((r) => ({
		...r,
		indexedClass: classifyCoverage(r.coverageState),
		canonicalMismatch:
			r.googleCanonical && r.userCanonical ? r.googleCanonical !== r.userCanonical : null
	}));
}

/**
 * IDX-005 — L'historique de TOUTES les URLs sur une fenêtre bornée.
 *
 * Ni `loadIndexHistory` (une seule URL) ni `loadLatestIndexStates` (le dernier état) ne peuvent
 * nourrir une comparaison d'états consécutifs à l'échelle d'un projet : le détecteur de transitions
 * a besoin de la SÉRIE. La lire ici, à côté des deux autres, garde `indexing-read.ts` comme unique
 * porte de lecture de l'indexation — un détecteur qui écrirait son propre SQL finirait par
 * diverger de l'écran qui affiche le même état.
 *
 * `since` n'est pas un confort : sans borne, la série d'un projet ancien grossirait indéfiniment et
 * un état vieux de deux ans pèserait autant qu'hier dans la décision. `limit` borne le reste.
 *
 * L'ordre `(url, observed_date)` est rendu par SQL **et** re-imposé par `buildStateSeries` : la
 * fonction pure ne doit dépendre d'aucune promesse de la requête pour rester rejouable.
 */
export async function loadIndexSeries(input: {
	db: AppDb;
	projectId: string;
	/** Borne basse d'`observed_date` (`YYYY-MM-DD`). */
	since?: string | null;
	urls?: readonly string[];
	limit?: number;
}): Promise<(IndexStateRow & { observationId: string })[]> {
	const filters = [eq(indexObservations.projectId, input.projectId)];
	if (input.since) filters.push(gte(indexObservations.observedDate, input.since));
	if (input.urls && input.urls.length > 0) {
		filters.push(inArray(indexObservations.url, [...input.urls]));
	}

	const rows = await input.db
		.select({
			observationId: indexObservations.id,
			url: indexObservations.url,
			observedDate: indexObservations.observedDate,
			verdict: indexObservations.verdict,
			coverageState: indexObservations.coverageState,
			indexingState: indexObservations.indexingState,
			robotsState: indexObservations.robotsState,
			googleCanonical: indexObservations.googleCanonical,
			userCanonical: indexObservations.userCanonical,
			lastCrawlAt: indexObservations.lastCrawlAt
		})
		.from(indexObservations)
		.where(and(...filters))
		.orderBy(indexObservations.url, indexObservations.observedDate)
		.limit(Math.max(1, Math.floor(input.limit ?? 20000)));

	return rows.map((r) => ({
		...r,
		indexedClass: classifyCoverage(r.coverageState),
		canonicalMismatch:
			r.googleCanonical && r.userCanonical ? r.googleCanonical !== r.userCanonical : null
	}));
}

/**
 * Répartition par classe d'indexation, cross-projet — de quoi alimenter un compteur d'accueil.
 *
 * L'agrégation se fait EN MÉMOIRE sur les derniers états, et non en SQL sur `coverage_state` :
 * la classification (`classifyCoverage`) vit dans le module pur et doit rester la SEULE
 * autorité. Une reproduction en SQL divergerait au premier libellé nouveau de Google — et
 * l'écran annoncerait alors une répartition que le détecteur ne reconnaîtrait pas.
 */
export async function countIndexClasses(input: {
	db: AppDb;
	projectId: string;
	since?: string | null;
}): Promise<Record<IndexedClass, number>> {
	const rows = await loadLatestIndexStates({ ...input, limit: 5000 });
	const out: Record<IndexedClass, number> = { indexed: 0, not_indexed: 0, excluded: 0, unknown: 0 };
	for (const r of rows) out[r.indexedClass] += 1;
	return out;
}

/**
 * REP-001 — La même répartition, pour TOUS les projets en une requête.
 *
 * `countIndexClasses` est per-projet : un rapport cross-projet l'appellerait dans une boucle
 * (neuf allers-retours pour neuf répartitions). Ici, un seul `DISTINCT ON (project_id, url)`.
 *
 * ⚠️ Ce n'est PAS une seconde autorité de classification : la classe sort de `classifyCoverage`,
 * **la même fonction**, appliquée en mémoire aux mêmes derniers états. Seule la CLÉ de
 * dédoublonnage change (le couple projet+url au lieu de l'url seule). Un `group by
 * coverage_state` en SQL, lui, aurait bien créé une seconde autorité — et il divergerait au
 * premier libellé nouveau de Google, l'écran annonçant alors une répartition que le détecteur
 * ne reconnaîtrait pas.
 */
export async function countIndexClassesByProject(input: {
	db: AppDb;
	since?: string | null;
	limit?: number;
}): Promise<Map<string, Record<IndexedClass, number>>> {
	const filters = input.since ? [gte(indexObservations.observedDate, input.since)] : [];

	const rows = await input.db
		.selectDistinctOn([indexObservations.projectId, indexObservations.url], {
			projectId: indexObservations.projectId,
			url: indexObservations.url,
			coverageState: indexObservations.coverageState
		})
		.from(indexObservations)
		.where(filters.length > 0 ? and(...filters) : undefined)
		.orderBy(
			indexObservations.projectId,
			indexObservations.url,
			desc(indexObservations.observedDate)
		)
		.limit(Math.max(1, Math.floor(input.limit ?? 20000)));

	const out = new Map<string, Record<IndexedClass, number>>();
	for (const r of rows) {
		const bucket = out.get(r.projectId) ?? {
			indexed: 0,
			not_indexed: 0,
			excluded: 0,
			unknown: 0
		};
		bucket[classifyCoverage(r.coverageState)] += 1;
		out.set(r.projectId, bucket);
	}
	return out;
}

/**
 * Fraîcheur de l'inspection par projet : la date de la dernière observation d'indexation.
 *
 * `null` = jamais inspecté, et c'est un état À PART (jamais « aujourd'hui », jamais 0) — même
 * règle que la fraîcheur de DASH-002.
 */
export async function loadInspectionFreshness(input: {
	db: AppDb;
	projectSlug?: string | null;
}): Promise<{ projectId: string; projectSlug: string | null; lastObservedDate: string | null }[]> {
	const rows = await input.db
		.select({
			projectId: projects.id,
			projectSlug: projects.slug,
			lastObservedDate: sql<string | null>`max(${indexObservations.observedDate})`
		})
		.from(projects)
		.leftJoin(indexObservations, eq(indexObservations.projectId, projects.id))
		.where(input.projectSlug ? eq(projects.slug, input.projectSlug) : eq(projects.archived, false))
		.groupBy(projects.id, projects.slug)
		.orderBy(projects.slug);
	return rows;
}
