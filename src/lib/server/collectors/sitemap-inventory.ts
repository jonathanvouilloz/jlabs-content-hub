/**
 * IDX-001 — Collecteur d'inventaire sitemap : la LECTURE et la PERSISTANCE.
 *
 * Le jugement pur vit dans `sitemap-state.ts` (testé par vitest) ; ici on fetch l'arbre, on
 * applique les fonctions pures, et on écrit. `fetchImpl` et le client drizzle sont INJECTÉS :
 * l'app passe les siens, les runners `scripts/` passent leur Pool et un fetch de test — c'est
 * ce qui rend ce lot prouvable sur Neon hors runtime SvelteKit (le second blocage d'AGT-000,
 * rencontré à l'identique par GSC-002).
 *
 * **L'invariant qui porte tout le reste : RIEN n'est écrit avant que TOUT l'arbre soit
 * parcouru.** Un upsert n'efface jamais, mais l'inventaire est comparé par DIFF : un
 * inventaire coupé au 2ᵉ sitemap sur 5 se lirait comme complet, et le run suivant annoncerait
 * des dizaines de **retraits fantômes** — le faux signal que GSC-006 interdit, appliqué à
 * l'indexation. On tamponne en mémoire (un site pèse quelques centaines d'URLs, borné à
 * `MAX_SITEMAP_URLS`), puis on écrit.
 *
 * Ce qu'on ne fait PAS, délibérément : rien ici ne soumet, ne notifie, ni ne désindexe. Un
 * retrait d'URL est un FAIT observé — au plus, plus tard, un finding (IDX-005). C'est
 * l'acceptation « aucune URL supprimée n'est automatiquement désindexée », tenue par
 * construction plutôt que par vigilance.
 */
import type { AppDb } from '../db/types.js';
import { log } from '../log.js';
import { upsertSitemapObservation, upsertSitemapUrlObservations } from '../observations.js';
import { loadGscBinding, type GscAuthDeps } from '../gsc-auth.js';
import { indexingCredentials, sitemapUrlObservations } from '../db/schema.js';
import { and, eq, desc } from 'drizzle-orm';
import {
	MAX_SITEMAP_BYTES,
	admitSitemap,
	capEntries,
	dedupeEntries,
	diffInventories,
	normalizeUrl,
	parseSitemapXml,
	type CrawlBudget,
	type InventoryDiff,
	type InventoryRow,
	type SitemapEntry,
	type SitemapError
} from './sitemap-state.js';

const logger = log('collector:sitemap');

/** Un fetch de sitemap ne doit pas retenir un worker : le bail se perd bien avant. */
const FETCH_TIMEOUT_MS = 20_000;

const USER_AGENT = 'seo-stats/sitemap-inventory (+https://jonlabs.ch)';

// ── Un fichier fetché ───────────────────────────────────────────────

interface FetchedSitemap {
	sitemapUrl: string;
	depth: number;
	/** `null` si le fetch a échoué — l'erreur est alors dans `errors`. */
	xml: string | null;
	httpStatus: number;
}

export interface SitemapFileReport {
	sitemapUrl: string;
	kind: 'index' | 'urlset' | 'unknown';
	httpStatus: number;
	/** URLs (ou enfants, pour un index) déclarées par CE fichier. */
	declared: number;
	errors: SitemapError[];
}

export interface CollectSitemapInput {
	projectId: string;
	/** Racine explicite ; sinon `indexing_credentials.sitemap_url`, sinon dérivée de la propriété GSC. */
	rootUrl?: string | null;
	runId?: string | null;
	/** N'écrit rien : sondage et `--dry-run`. */
	dryRun?: boolean;
	budget?: CrawlBudget;
	deps?: GscAuthDeps;
	client?: AppDb;
	now?: Date;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

export interface CollectSitemapResult {
	projectId: string;
	rootUrl: string;
	observedDate: string;
	/** Un rapport par fichier parcouru — c'est là que vit « sitemap invalide ou inaccessible ». */
	files: SitemapFileReport[];
	/** Inventaire final, dédupliqué et plafonné. */
	entries: SitemapEntry[];
	/** Toutes les erreurs du run, tous fichiers confondus. */
	errors: SitemapError[];
	/** Vrai si une borne a été atteinte (URLs, fichiers, profondeur) — jamais silencieux. */
	truncated: boolean;
	/**
	 * Vrai si au moins un fichier a échoué. Le run continue (un enfant mort n'annule pas les
	 * autres) mais le dit : un inventaire partiel n'est pas un inventaire.
	 */
	partial: boolean;
	/** Diff contre le dernier inventaire ANTÉRIEUR présent en base (`null` si c'est le premier). */
	diff: InventoryDiff | null;
	previousDate: string | null;
	dryRun: boolean;
}

// ── Résolution de la racine ─────────────────────────────────────────

/**
 * La racine du sitemap.
 *
 * Ordre : argument explicite → `indexing_credentials.sitemap_url` (déjà renseigné pour les
 * projets suivis) → `{propriété GSC}/sitemap.xml`. La dérivation est un DERNIER recours et
 * reste une convention, pas une découverte : `robots.txt` la porterait mieux, ce que fera
 * IDX-004 quand la sélection d'URLs aura besoin d'un inventaire exhaustif.
 */
export async function resolveSitemapRoot(input: {
	projectId: string;
	explicit?: string | null;
	db: AppDb;
	deps?: GscAuthDeps;
}): Promise<string> {
	if (input.explicit) {
		const norm = normalizeUrl(input.explicit);
		if (!norm.ok) throw new Error(`Racine de sitemap illisible : "${input.explicit}" (${norm.reason})`);
		return norm.normalized;
	}

	const rows = await input.db
		.select({ sitemapUrl: indexingCredentials.sitemapUrl })
		.from(indexingCredentials)
		.where(eq(indexingCredentials.projectId, input.projectId))
		.limit(1);
	const stored = rows[0]?.sitemapUrl;
	if (stored) {
		const norm = normalizeUrl(stored);
		if (norm.ok) return norm.normalized;
		// Une valeur illisible en base est signalée par l'échec, pas contournée en silence.
		throw new Error(`sitemap_url en base illisible pour ${input.projectId} : "${stored}"`);
	}

	const binding = await loadGscBinding(input.projectId, { ...input.deps, client: input.db });
	// Une propriété GSC peut être un préfixe d'URL (`https://x/`) ou un domaine (`sc-domain:x`).
	const site = binding.siteUrl.startsWith('sc-domain:')
		? `https://${binding.siteUrl.slice('sc-domain:'.length)}/`
		: binding.siteUrl;
	const derived = new URL('/sitemap.xml', site).toString();
	logger.info('racine de sitemap dérivée de la propriété GSC', {
		projectId: input.projectId,
		siteUrl: binding.siteUrl,
		derived
	});
	return derived;
}

// ── Fetch d'un fichier ──────────────────────────────────────────────

async function fetchSitemap(input: {
	sitemapUrl: string;
	depth: number;
	fetchImpl: typeof fetch;
	signal?: AbortSignal;
}): Promise<{ file: FetchedSitemap; errors: SitemapError[] }> {
	const errors: SitemapError[] = [];
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	// Le bail du worker ET le timeout : perdre le bail doit interrompre le fetch en cours,
	// sinon on continue à travailler pour un job qu'un autre worker a déjà repris.
	const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

	try {
		const res = await input.fetchImpl(input.sitemapUrl, {
			headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml,text/xml,*/*' },
			signal
		});
		if (!res.ok) {
			errors.push({
				kind: 'fetch_failed',
				sitemapUrl: input.sitemapUrl,
				detail: `HTTP ${res.status}`
			});
			return { file: { ...input, xml: null, httpStatus: res.status }, errors };
		}
		const xml = await res.text();
		const bytes = new TextEncoder().encode(xml).length;
		if (bytes > MAX_SITEMAP_BYTES) {
			errors.push({
				kind: 'too_large',
				sitemapUrl: input.sitemapUrl,
				detail: `${bytes} octets > ${MAX_SITEMAP_BYTES}`
			});
			return { file: { ...input, xml: null, httpStatus: res.status }, errors };
		}
		return { file: { ...input, xml, httpStatus: res.status }, errors };
	} catch (err) {
		errors.push({
			kind: 'fetch_failed',
			sitemapUrl: input.sitemapUrl,
			detail: err instanceof Error ? err.message : String(err)
		});
		return { file: { ...input, xml: null, httpStatus: 0 }, errors };
	}
}

// ── Lecture du dernier inventaire antérieur (pour le diff) ──────────

/**
 * Le dernier inventaire STRICTEMENT ANTÉRIEUR à `observedDate`.
 *
 * Strictement antérieur, et non « le plus récent » : sinon un second run le même jour se
 * comparerait à lui-même (déjà upserté) et rendrait un diff toujours vide, masquant le
 * changement que le premier run du jour avait vu.
 *
 * ⚠️ Deux requêtes bornées, jamais `= ANY` (driver Neon) : d'abord la date, puis ses lignes.
 */
export async function loadPreviousInventory(input: {
	db: AppDb;
	projectId: string;
	beforeDate: string;
}): Promise<{ date: string | null; rows: InventoryRow[] }> {
	const dateRows = await input.db
		.selectDistinct({ observedDate: sitemapUrlObservations.observedDate })
		.from(sitemapUrlObservations)
		.where(eq(sitemapUrlObservations.projectId, input.projectId))
		.orderBy(desc(sitemapUrlObservations.observedDate));
	const previousDate = dateRows.map((r) => r.observedDate).find((d) => d < input.beforeDate) ?? null;
	if (!previousDate) return { date: null, rows: [] };

	const rows = await input.db
		.select({
			urlNormalized: sitemapUrlObservations.urlNormalized,
			lastmod: sitemapUrlObservations.lastmod,
			expectedCanonical: sitemapUrlObservations.expectedCanonical
		})
		.from(sitemapUrlObservations)
		.where(
			and(
				eq(sitemapUrlObservations.projectId, input.projectId),
				eq(sitemapUrlObservations.observedDate, previousDate)
			)
		);
	return {
		date: previousDate,
		rows: rows.map((r) => ({
			urlNormalized: r.urlNormalized,
			lastmod: r.lastmod,
			expectedCanonical: r.expectedCanonical ?? r.urlNormalized
		}))
	};
}

// ── Lectures d'inventaire pour la sélection (IDX-004) ───────────────

/**
 * Une ligne d'inventaire enrichie de ce dont la SÉLECTION a besoin en plus du diff.
 *
 * `diffInventories` ne compare que trois champs, mais IDX-004 doit aussi savoir quelle forme
 * le site déclare (`url`, la trace) et si l'entrée est une alternate — IDX-001 pose qu'« une
 * alternate n'est pas une page nouvelle », et la sélection doit respecter la même règle sous
 * peine d'annoncer autant de pages neuves que de langues au premier run d'un site multilingue.
 */
export interface InventoryUrlRow extends InventoryRow {
	url: string;
	isAlternate: boolean;
}

/** Les lignes d'une date exacte. Égalité stricte, jamais une liste paramétrée (driver Neon). */
async function selectInventoryRows(
	db: AppDb,
	projectId: string,
	date: string
): Promise<InventoryUrlRow[]> {
	const rows = await db
		.select({
			url: sitemapUrlObservations.url,
			urlNormalized: sitemapUrlObservations.urlNormalized,
			lastmod: sitemapUrlObservations.lastmod,
			expectedCanonical: sitemapUrlObservations.expectedCanonical,
			isAlternate: sitemapUrlObservations.isAlternate
		})
		.from(sitemapUrlObservations)
		.where(
			and(
				eq(sitemapUrlObservations.projectId, projectId),
				eq(sitemapUrlObservations.observedDate, date)
			)
		);
	return rows.map((r) => ({
		url: r.url,
		urlNormalized: r.urlNormalized,
		lastmod: r.lastmod,
		expectedCanonical: r.expectedCanonical ?? r.urlNormalized,
		isAlternate: r.isAlternate
	}));
}

/**
 * L'inventaire d'une date EXACTE.
 *
 * `loadPreviousInventory` ne sait rendre que « la dernière date strictement antérieure », ce
 * qui suffit au diff mais pas à IDX-004 : rejouer une sélection contre un snapshot connu
 * suppose de pouvoir demander ce snapshot-là. Une date sans inventaire rend une liste vide —
 * ce n'est pas une erreur, c'est un fait (le collecteur n'a pas tourné ce jour-là).
 */
export async function loadInventoryAt(input: {
	db: AppDb;
	projectId: string;
	date: string;
}): Promise<{ date: string | null; rows: InventoryUrlRow[] }> {
	const rows = await selectInventoryRows(input.db, input.projectId, input.date);
	return { date: rows.length > 0 ? input.date : null, rows };
}

/**
 * Le dernier inventaire disponible À OU AVANT `onOrBefore`.
 *
 * C'est la lecture dont la sélection a besoin, et elle diffère de `loadPreviousInventory` sur
 * un point qui compte : la passe de sélection tourne APRÈS `collect:sitemap` du même jour, et
 * doit voir l'inventaire du jour. Un « strictement antérieur » la ferait travailler sur celui
 * de la semaine passée, donc ignorer les pages parues aujourd'hui — exactement ce que la
 * raison `new` existe pour attraper.
 *
 * Rend `{ date: null, rows: [] }` quand aucun inventaire n'existe : un projet dont le sitemap
 * n'a jamais été collecté n'a pas un inventaire vide, il n'en a pas — et l'appelant doit
 * pouvoir faire la différence.
 */
export async function loadLatestInventory(input: {
	db: AppDb;
	projectId: string;
	onOrBefore: string;
}): Promise<{ date: string | null; rows: InventoryUrlRow[] }> {
	const dateRows = await input.db
		.selectDistinct({ observedDate: sitemapUrlObservations.observedDate })
		.from(sitemapUrlObservations)
		.where(eq(sitemapUrlObservations.projectId, input.projectId))
		.orderBy(desc(sitemapUrlObservations.observedDate));
	const latest = dateRows.map((r) => r.observedDate).find((d) => d <= input.onOrBefore) ?? null;
	if (!latest) return { date: null, rows: [] };
	return { date: latest, rows: await selectInventoryRows(input.db, input.projectId, latest) };
}

// ── Le collecteur ───────────────────────────────────────────────────

/**
 * Parcourt l'arbre de sitemaps d'un projet, écrit l'inventaire du jour, et rend le diff
 * contre le dernier inventaire antérieur.
 *
 * Parcours en LARGEUR avec `visited` : un index qui se référence (directement ou en cycle)
 * s'arrête sur une erreur `cycle` au lieu de tourner jusqu'au timeout du worker — ce que le
 * legacy `fetchSitemapUrls` ne sait pas faire.
 */
export async function collectSitemapInventory(
	input: CollectSitemapInput
): Promise<CollectSitemapResult> {
	const db = input.client ?? (await import('../db/index.js')).db as unknown as AppDb;
	const fetchImpl = input.fetchImpl ?? fetch;
	const now = input.now ?? new Date();
	const observedDate = now.toISOString().slice(0, 10);

	const rootUrl = await resolveSitemapRoot({
		projectId: input.projectId,
		explicit: input.rootUrl,
		db,
		deps: input.deps
	});

	const files: SitemapFileReport[] = [];
	const errors: SitemapError[] = [];
	const collected: SitemapEntry[] = [];
	const visited = new Set<string>();
	let truncated = false;

	// File d'attente en largeur : la racine, puis ses enfants, puis les leurs.
	const queue: { sitemapUrl: string; depth: number }[] = [{ sitemapUrl: rootUrl, depth: 0 }];

	while (queue.length > 0) {
		if (input.signal?.aborted) {
			// Bail perdu : on s'arrête AVANT d'écrire. Un inventaire partiel écrit produirait
			// des retraits fantômes au run suivant — pire que pas d'inventaire du tout.
			throw new Error('Collecte sitemap interrompue (bail perdu ou arrêt demandé) : rien écrit.');
		}
		const next = queue.shift()!;

		const admission = admitSitemap({
			sitemapUrl: next.sitemapUrl,
			depth: next.depth,
			visited,
			filesFetched: visited.size,
			budget: input.budget
		});
		if (!admission.admit) {
			errors.push(admission.error);
			truncated = true;
			continue;
		}
		visited.add(next.sitemapUrl);

		const { file, errors: fetchErrors } = await fetchSitemap({
			sitemapUrl: next.sitemapUrl,
			depth: next.depth,
			fetchImpl,
			signal: input.signal
		});
		errors.push(...fetchErrors);

		if (file.xml === null) {
			// Un fichier mort est un FAIT, pas une exception : il aura sa ligne per-fichier.
			files.push({
				sitemapUrl: next.sitemapUrl,
				kind: 'unknown',
				httpStatus: file.httpStatus,
				declared: 0,
				errors: fetchErrors
			});
			continue;
		}

		const parsed = parseSitemapXml({ xml: file.xml, sitemapUrl: next.sitemapUrl });
		errors.push(...parsed.errors);
		files.push({
			sitemapUrl: next.sitemapUrl,
			kind: parsed.kind,
			httpStatus: file.httpStatus,
			declared: parsed.kind === 'index' ? parsed.children.length : parsed.entries.length,
			errors: parsed.errors
		});

		collected.push(...parsed.entries);
		for (const child of parsed.children) {
			queue.push({ sitemapUrl: child, depth: next.depth + 1 });
		}
	}

	// Dédup AVANT l'insert : une URL listée par deux enfants ferait rejeter TOUT le lot
	// (Postgres refuse deux lignes de même clé dans un même INSERT) — leçon GSC-002.
	const deduped = dedupeEntries(collected);
	const capped = capEntries(deduped, input.budget?.maxUrls);
	if (capped.truncated) {
		truncated = true;
		errors.push({
			kind: 'url_budget_exceeded',
			sitemapUrl: rootUrl,
			detail: `${capped.dropped} URL(s) écartée(s) au-delà du plafond`
		});
	}
	const entries = capped.kept;
	// Toute erreur de fichier a déjà été poussée dans `errors` : une seule source de vérité,
	// sinon `partial` et le rapport par fichier pourraient se contredire.
	const partial = errors.length > 0;

	// Le diff est calculé AVANT l'écriture du jour : après, la lecture « strictement
	// antérieure » resterait juste, mais le calculer avant rend l'ordre indifférent.
	const previous = await loadPreviousInventory({ db, projectId: input.projectId, beforeDate: observedDate });
	const diff = previous.date === null
		? null
		: diffInventories(previous.rows, entries.map((e) => ({
				urlNormalized: e.urlNormalized,
				lastmod: e.lastmod,
				expectedCanonical: e.expectedCanonical
			})));

	if (!input.dryRun) {
		// ── ÉCRITURE, une fois l'arbre entièrement parcouru ──
		for (const f of files) {
			await upsertSitemapObservation(
				{
					projectId: input.projectId,
					observedDate,
					sitemapUrl: f.sitemapUrl,
					submittedUrls: f.declared,
					errors: f.errors.length,
					runId: input.runId ?? null,
					payloadJson: JSON.stringify({
						kind: f.kind,
						httpStatus: f.httpStatus,
						// Les erreurs sont bornées à 20 : un sitemap cassé sur 5 000 lignes ne doit
						// pas faire échouer l'écriture sur le plafond de payload (32 Ko).
						errors: f.errors.slice(0, 20)
					})
				},
				db
			);
		}
		await upsertSitemapUrlObservations(
			entries.map((e) => ({
				projectId: input.projectId,
				observedDate,
				sitemapUrl: e.sitemapUrl,
				url: e.url,
				urlNormalized: e.urlNormalized,
				lastmod: e.lastmod,
				locale: e.locale,
				expectedCanonical: e.expectedCanonical,
				isAlternate: e.isAlternate,
				runId: input.runId ?? null
			})),
			db
		);
	}

	logger.info('inventaire sitemap collecté', {
		projectId: input.projectId,
		rootUrl,
		observedDate,
		files: files.length,
		urls: entries.length,
		errors: errors.length,
		truncated,
		partial,
		added: diff?.added.length ?? null,
		removed: diff?.removed.length ?? null,
		changed: diff?.changed.length ?? null,
		dryRun: input.dryRun === true
	});

	return {
		projectId: input.projectId,
		rootUrl,
		observedDate,
		files,
		entries,
		errors,
		truncated,
		partial,
		diff,
		previousDate: previous.date,
		dryRun: input.dryRun === true
	};
}
