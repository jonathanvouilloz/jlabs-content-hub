/**
 * IDX-001 — Inventaire sitemap : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), même paire que `gsc-collector-state.ts` /
 * `gsc-query-page.ts` : ici on décide **ce que contient un sitemap**, **comment une URL se
 * normalise** et **ce qui a changé entre deux inventaires** ; `sitemap-inventory.ts` fetch et
 * persiste.
 *
 * Les trois acceptations IDX-001 vivent ici :
 *
 *   1. « un sitemap diff est reproductible et lié à deux snapshots » → `diffInventories` est
 *      une **fonction pure de deux listes**. Le diff de deux dates ne dépend d'aucun état
 *      accumulé : rejouer le même couple de dates rend le même diff, pour toujours.
 *   2. « redirects et fragments sont normalisés » → `normalizeUrl` est la SEULE porte, et
 *      l'unique d'upsert vise `url_normalized`. Sans ça, `…/page` et `…/page#a` créeraient
 *      deux lignes pour une seule page, et le diff inventerait un ajout à chaque run.
 *   3. « aucune URL supprimée n'est automatiquement désindexée » → conséquence de ce que ce
 *      module NE FAIT PAS : `diffInventories` rend des `removed`, et rien ici ne sait
 *      soumettre quoi que ce soit. Un retrait est un fait, au plus un finding (IDX-005).
 *
 * Ce qu'on remplace, et pourquoi. `indexing.ts:fetchSitemapUrls` (legacy, conservé pour les
 * routes manuelles) : (a) `catch {}` sur chaque sous-sitemap — donc « signaler les sitemaps
 * inaccessibles » y est structurellement impossible ; (b) rend des chaînes, donc perd lastmod
 * et hreflang ; (c) récurse **sans borne** — un index qui se référence lui-même boucle jusqu'au
 * timeout du worker.
 */

// ── Bornes dures ────────────────────────────────────────────────────

/**
 * Profondeur maximale de l'arbre. Un `sitemapindex` peut pointer un autre index (rare mais
 * légal). Au-delà de 3 niveaux, c'est une boucle ou une erreur de génération, pas un site.
 */
export const MAX_SITEMAP_DEPTH = 3;

/** Nombre maximal de fichiers sitemap parcourus par run (index + enfants). */
export const MAX_SITEMAP_FILES = 50;

/**
 * Nombre maximal d'URLs retenues par run. Le standard plafonne un fichier à 50 000 URLs ;
 * on borne l'INVENTAIRE ENTIER pour qu'un site inattendu ne fasse pas exploser un run hebdo.
 */
export const MAX_SITEMAP_URLS = 20_000;

/** Taille maximale d'un fichier sitemap accepté (octets décodés) — au-delà, on ne parse pas. */
export const MAX_SITEMAP_BYTES = 20 * 1024 * 1024;

// ── Erreurs de parsing : rapportées, JAMAIS avalées ─────────────────

export const SITEMAP_ERROR_KINDS = [
	'fetch_failed', // HTTP non-2xx, DNS, timeout
	'not_xml', // corps qui n'est ni sitemapindex ni urlset
	'entry_without_loc', // <url>/<sitemap> sans <loc> exploitable
	'invalid_loc', // <loc> non parsable en URL absolue
	'too_large', // fichier au-delà de MAX_SITEMAP_BYTES
	'depth_exceeded', // index trop profond
	'cycle', // déjà visité dans ce run
	'file_budget_exceeded', // au-delà de MAX_SITEMAP_FILES
	'url_budget_exceeded' // au-delà de MAX_SITEMAP_URLS
] as const;
export type SitemapErrorKind = (typeof SITEMAP_ERROR_KINDS)[number];

export interface SitemapError {
	kind: SitemapErrorKind;
	/** Le fichier concerné (toujours renseigné : une erreur sans cible n'est pas actionnable). */
	sitemapUrl: string;
	/** Détail lisible — code HTTP, `<loc>` fautif, borne atteinte. */
	detail: string;
}

// ── Une entrée d'inventaire ─────────────────────────────────────────

export interface SitemapEntry {
	/** `<loc>` tel qu'écrit dans le fichier (trace de ce que le site déclare). */
	url: string;
	/** Forme canonique de comparaison — c'est ELLE qui porte l'unique d'upsert. */
	urlNormalized: string;
	/** `<lastmod>`, tel quel (`null` si absent). Jamais inventé : « pas de lastmod » ≠ « jamais modifié ». */
	lastmod: string | null;
	/** `hreflang` de l'alternate, ou `null` pour une entrée principale. */
	locale: string | null;
	/**
	 * Le canonical ATTENDU par le site pour cette page : l'URL normalisée absolue. C'est ce
	 * qu'IDX-002 confrontera au `googleCanonical` réel (détecteur `canonical_conflict`, SPEC §875).
	 */
	expectedCanonical: string;
	/**
	 * Vrai pour une URL issue d'un `<xhtml:link rel="alternate">`. Une alternate n'est PAS une
	 * page nouvelle du site : la compter comme telle ferait annoncer autant d'« ajouts » que de
	 * langues au premier run multilingue.
	 */
	isAlternate: boolean;
	/** Le fichier sitemap qui a déclaré cette entrée (traçabilité du diff). */
	sitemapUrl: string;
}

// ── Normalisation d'URL ─────────────────────────────────────────────

export interface NormalizedUrl {
	normalized: string;
	/** `null` si l'URL n'est pas exploitable (relative, schéma non http(s), illisible). */
	ok: boolean;
	reason?: string;
}

/**
 * Forme canonique de comparaison d'une URL.
 *
 * Ce qui est RETIRÉ : le fragment (`#…`, jamais envoyé au serveur, donc jamais une page
 * distincte), le port par défaut, la casse du schéma et de l'hôte (insensibles par RFC).
 *
 * Ce qui est CONSERVÉ, délibérément : le slash final (`/a` et `/a/` peuvent servir deux
 * contenus, et sur les sites générés c'est souvent un canonical distinct) et la query string
 * (`?p=2` est une autre page). Les retirer ferait fusionner deux entrées de sitemap en une, et
 * le diff annoncerait un **retrait** là où le site n'a rien enlevé.
 *
 * Le tri des paramètres n'est PAS fait : deux ordres différents dans un même sitemap sont une
 * anomalie du site, pas quelque chose à masquer — et IDX-005 doit pouvoir la voir.
 */
export function normalizeUrl(raw: string): NormalizedUrl {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) return { normalized: '', ok: false, reason: 'vide' };

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { normalized: trimmed, ok: false, reason: 'URL non absolue ou illisible' };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { normalized: trimmed, ok: false, reason: `schéma non http(s) : ${parsed.protocol}` };
	}

	parsed.hash = '';
	// `new URL` retire déjà le port par défaut et minuscule schéma + hôte ; on s'appuie
	// dessus plutôt que de le refaire à la main (et de s'en écarter).
	return { normalized: parsed.toString(), ok: true };
}

// ── Parsing XML ─────────────────────────────────────────────────────

export type SitemapKind = 'index' | 'urlset' | 'unknown';

export interface ParsedSitemap {
	/** Décidé sur la RACINE réelle, jamais devinée par la présence de `<url>`. */
	kind: SitemapKind;
	/** `<loc>` des sitemaps enfants (vide si `urlset`). */
	children: string[];
	/** Entrées d'URL (vide si `index`). */
	entries: SitemapEntry[];
	errors: SitemapError[];
}

/** Contenu textuel de la première balise `name` d'un fragment (namespace toléré). */
function tagText(fragment: string, name: string): string | null {
	const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${name}>`, 'i');
	const m = re.exec(fragment);
	if (!m) return null;
	return decodeXmlText(m[1]).trim();
}

/** Les 5 entités XML prédéfinies. `&amp;` est traité en DERNIER, sinon `&amp;lt;` deviendrait `<`. */
export function decodeXmlText(raw: string): string {
	return raw
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
		.replace(/&amp;/g, '&');
}

/** Retire commentaires et CDATA-wrappers avant analyse (un `<loc>` commenté n'est pas une URL). */
function stripNoise(xml: string): string {
	return xml
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => inner);
}

function blocksOf(xml: string, name: string): string[] {
	const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${name}>`, 'gi');
	const out: string[] = [];
	for (const m of xml.matchAll(re)) out.push(m[1]);
	return out;
}

/**
 * Les `<xhtml:link rel="alternate" hreflang="…" href="…">` d'un bloc `<url>`.
 *
 * Auto-fermantes, donc invisibles à `blocksOf` : elles se lisent par attributs. Une alternate
 * dont le `href` égale l'URL principale est ignorée (le site se déclare lui-même comme sa
 * propre alternate, cas fréquent et sans information).
 */
export function extractAlternates(urlBlock: string): { href: string; hreflang: string | null }[] {
	const out: { href: string; hreflang: string | null }[] = [];
	const re = /<(?:[A-Za-z0-9_-]+:)?link\b([^>]*)>/gi;
	for (const m of urlBlock.matchAll(re)) {
		const attrs = m[1];
		if (!/rel\s*=\s*["']alternate["']/i.test(attrs)) continue;
		const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
		if (!href) continue;
		const hreflang = /hreflang\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? null;
		out.push({ href: decodeXmlText(href).trim(), hreflang });
	}
	return out;
}

/**
 * Parse un corps de sitemap.
 *
 * TOLÉRANT MAIS BAVARD : un `<url>` sans `<loc>`, un `<loc>` relatif, un corps qui n'est ni
 * `sitemapindex` ni `urlset` produisent une `SitemapError` — jamais un silence. C'est la
 * différence de fond avec le legacy, et ce qui rend l'acceptation « signaler sitemaps
 * invalides » atteignable.
 *
 * `kind` est décidé sur la balise RACINE : un index qui contiendrait par erreur des `<url>`
 * reste un index, et le dire permet de voir l'anomalie plutôt que de la deviner.
 */
export function parseSitemapXml(input: { xml: string; sitemapUrl: string }): ParsedSitemap {
	const errors: SitemapError[] = [];
	const xml = stripNoise(input.xml ?? '');

	const hasIndexRoot = /<(?:[A-Za-z0-9_-]+:)?sitemapindex\b/i.test(xml);
	const hasUrlsetRoot = /<(?:[A-Za-z0-9_-]+:)?urlset\b/i.test(xml);
	const kind: SitemapKind = hasIndexRoot ? 'index' : hasUrlsetRoot ? 'urlset' : 'unknown';

	if (kind === 'unknown') {
		errors.push({
			kind: 'not_xml',
			sitemapUrl: input.sitemapUrl,
			detail: 'ni <sitemapindex> ni <urlset> à la racine'
		});
		return { kind, children: [], entries: [], errors };
	}

	if (kind === 'index') {
		const children: string[] = [];
		for (const block of blocksOf(xml, 'sitemap')) {
			const loc = tagText(block, 'loc');
			if (!loc) {
				errors.push({
					kind: 'entry_without_loc',
					sitemapUrl: input.sitemapUrl,
					detail: '<sitemap> sans <loc>'
				});
				continue;
			}
			const norm = normalizeUrl(loc);
			if (!norm.ok) {
				errors.push({
					kind: 'invalid_loc',
					sitemapUrl: input.sitemapUrl,
					detail: `${loc} (${norm.reason})`
				});
				continue;
			}
			children.push(norm.normalized);
		}
		return { kind, children, entries: [], errors };
	}

	const entries: SitemapEntry[] = [];
	for (const block of blocksOf(xml, 'url')) {
		const loc = tagText(block, 'loc');
		if (!loc) {
			errors.push({
				kind: 'entry_without_loc',
				sitemapUrl: input.sitemapUrl,
				detail: '<url> sans <loc>'
			});
			continue;
		}
		const norm = normalizeUrl(loc);
		if (!norm.ok) {
			errors.push({
				kind: 'invalid_loc',
				sitemapUrl: input.sitemapUrl,
				detail: `${loc} (${norm.reason})`
			});
			continue;
		}
		const lastmod = tagText(block, 'lastmod');
		entries.push({
			url: loc,
			urlNormalized: norm.normalized,
			lastmod: lastmod && lastmod.length > 0 ? lastmod : null,
			locale: null,
			expectedCanonical: norm.normalized,
			isAlternate: false,
			sitemapUrl: input.sitemapUrl
		});

		for (const alt of extractAlternates(block)) {
			const altNorm = normalizeUrl(alt.href);
			if (!altNorm.ok) {
				errors.push({
					kind: 'invalid_loc',
					sitemapUrl: input.sitemapUrl,
					detail: `alternate ${alt.href} (${altNorm.reason})`
				});
				continue;
			}
			// Une page qui se déclare sa propre alternate n'ajoute rien.
			if (altNorm.normalized === norm.normalized) continue;
			entries.push({
				url: alt.href,
				urlNormalized: altNorm.normalized,
				lastmod: lastmod && lastmod.length > 0 ? lastmod : null,
				locale: alt.hreflang,
				expectedCanonical: altNorm.normalized,
				isAlternate: true,
				sitemapUrl: input.sitemapUrl
			});
		}
	}

	return { kind, children: [], entries, errors };
}

// ── Déduplication de l'inventaire ───────────────────────────────────

/**
 * Dédoublonne par `urlNormalized`, **première occurrence gagnante**.
 *
 * Nécessaire même après normalisation : une URL peut être listée par deux sitemaps enfants, ou
 * apparaître à la fois comme entrée principale et comme alternate d'une autre langue. Sans
 * cette passe, l'INSERT groupé se ferait refuser par l'unique — Postgres rejette **tout le
 * lot** sur un doublon de clé (leçon GSC-002 : dédupliquer AVANT l'insert, pas après).
 *
 * Une entrée principale l'emporte sur une alternate portant la même URL : c'est la même page,
 * et la connaître comme principale porte plus d'information.
 */
export function dedupeEntries(entries: SitemapEntry[]): SitemapEntry[] {
	const byUrl = new Map<string, SitemapEntry>();
	for (const e of entries) {
		const existing = byUrl.get(e.urlNormalized);
		if (!existing) {
			byUrl.set(e.urlNormalized, e);
			continue;
		}
		if (existing.isAlternate && !e.isAlternate) byUrl.set(e.urlNormalized, e);
	}
	return [...byUrl.values()];
}

// ── Plan de parcours (bornes + cycles) ──────────────────────────────

export interface CrawlBudget {
	maxDepth?: number;
	maxFiles?: number;
	maxUrls?: number;
}

/**
 * Décide si un fichier peut être visité — bornes et cycles.
 *
 * Sépare le JUGEMENT du parcours (ici, pur et testable) de son EXÉCUTION (le collecteur, qui
 * fetch). Un `visited` transmis explicitement plutôt qu'un état interne : deux runs ne peuvent
 * pas se contaminer, et le test peut poser exactement la situation qu'il veut prouver.
 *
 * Atteindre une borne rend une `SitemapError` : une troncature qui ne se plaint pas se lirait
 * comme un inventaire complet, et le diff du run suivant annoncerait des retraits fantômes.
 */
export function admitSitemap(input: {
	sitemapUrl: string;
	depth: number;
	visited: ReadonlySet<string>;
	filesFetched: number;
	budget?: CrawlBudget;
}): { admit: true } | { admit: false; error: SitemapError } {
	const maxDepth = input.budget?.maxDepth ?? MAX_SITEMAP_DEPTH;
	const maxFiles = input.budget?.maxFiles ?? MAX_SITEMAP_FILES;

	if (input.visited.has(input.sitemapUrl)) {
		return {
			admit: false,
			error: { kind: 'cycle', sitemapUrl: input.sitemapUrl, detail: 'déjà visité dans ce run' }
		};
	}
	if (input.depth > maxDepth) {
		return {
			admit: false,
			error: {
				kind: 'depth_exceeded',
				sitemapUrl: input.sitemapUrl,
				detail: `profondeur ${input.depth} > ${maxDepth}`
			}
		};
	}
	if (input.filesFetched >= maxFiles) {
		return {
			admit: false,
			error: {
				kind: 'file_budget_exceeded',
				sitemapUrl: input.sitemapUrl,
				detail: `${input.filesFetched} fichiers déjà parcourus (max ${maxFiles})`
			}
		};
	}
	return { admit: true };
}

/** Applique le plafond d'URLs et DIT ce qui a été coupé. */
export function capEntries(
	entries: SitemapEntry[],
	maxUrls: number = MAX_SITEMAP_URLS
): { kept: SitemapEntry[]; truncated: boolean; dropped: number } {
	if (entries.length <= maxUrls) return { kept: entries, truncated: false, dropped: 0 };
	return {
		kept: entries.slice(0, maxUrls),
		truncated: true,
		dropped: entries.length - maxUrls
	};
}

// ── Diff de deux inventaires (fonction PURE) ─────────────────────────

/** Ce qu'une ligne persistée rend au diff — volontairement minimal. */
export interface InventoryRow {
	urlNormalized: string;
	lastmod: string | null;
	expectedCanonical: string;
}

export interface ChangedUrl {
	urlNormalized: string;
	/** Champs qui ont bougé — nommés, pas un booléen (« quelque chose a changé » n'est pas actionnable). */
	fields: ('lastmod' | 'expected_canonical')[];
	previous: InventoryRow;
	current: InventoryRow;
}

export interface InventoryDiff {
	added: string[];
	removed: string[];
	changed: ChangedUrl[];
	/** Présentes des deux côtés et strictement identiques. */
	unchanged: number;
}

/**
 * Diff entre deux inventaires — **le cœur de l'acceptation IDX-001**.
 *
 * Fonction PURE de deux listes : aucun état, aucune horloge, aucune base. Rejouer le même
 * couple de snapshots rend donc le même diff, indéfiniment — c'est ce que « reproductible et
 * lié à deux snapshots » exige. Les listes sortent triées pour que deux exécutions rendent
 * aussi le même ORDRE (un diff dont les lignes permutent n'est pas comparable d'un run à
 * l'autre, même s'il contient les mêmes éléments).
 *
 * `changed` compare `lastmod` ET `expected_canonical` : un canonical qui bouge sans que
 * `lastmod` ne change est précisément l'anomalie que le détecteur `canonical_conflict` cherche.
 */
export function diffInventories(previous: InventoryRow[], current: InventoryRow[]): InventoryDiff {
	const prev = new Map(previous.map((r) => [r.urlNormalized, r]));
	const curr = new Map(current.map((r) => [r.urlNormalized, r]));

	const added: string[] = [];
	const removed: string[] = [];
	const changed: ChangedUrl[] = [];
	let unchanged = 0;

	for (const [url, c] of curr) {
		const p = prev.get(url);
		if (!p) {
			added.push(url);
			continue;
		}
		const fields: ('lastmod' | 'expected_canonical')[] = [];
		if ((p.lastmod ?? null) !== (c.lastmod ?? null)) fields.push('lastmod');
		if (p.expectedCanonical !== c.expectedCanonical) fields.push('expected_canonical');
		if (fields.length > 0) changed.push({ urlNormalized: url, fields, previous: p, current: c });
		else unchanged += 1;
	}
	for (const url of prev.keys()) {
		if (!curr.has(url)) removed.push(url);
	}

	added.sort();
	removed.sort();
	changed.sort((a, b) => (a.urlNormalized < b.urlNormalized ? -1 : a.urlNormalized > b.urlNormalized ? 1 : 0));
	return { added, removed, changed, unchanged };
}
