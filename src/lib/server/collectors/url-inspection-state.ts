/**
 * IDX-002 — URL Inspection : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau). `url-inspection.ts` appelle Google et persiste ;
 * ici on décide **ce qu'une réponse d'inspection signifie** et **ce qui va en colonne plutôt
 * qu'en payload**.
 *
 * Les trois acceptations IDX-002 s'appuient sur ce module :
 *
 *   1. « distinguer erreur provider et résultat non indexé » → `InspectionOutcome` est une
 *      **union discriminée** : `{ kind: 'result' }` et `{ kind: 'provider_error' }` ne
 *      partagent AUCUN champ commun exploitable. Aucun appelant ne peut donc les confondre —
 *      là où `indexing.ts:inspectUrl` rendait `unknown` pour les deux, si bien qu'un
 *      credential mort et une page réellement inconnue de Google se lisaient pareil.
 *   2. « chaque inspection possède un historique » / « un rerun ne détruit pas l'état
 *      précédent » → tenu par la clé d'upsert `(project, url, observed_date)` côté
 *      collecteur ; ici on garantit seulement que la MESURE est complète et bornée.
 *   3. « le statut UI est dérivé de champs persistés » → `parseInspectionResult` sépare ce qui
 *      va en COLONNES (interrogeable en SQL) de ce qui va en payload borné.
 */

// ── Ce que `index_observations` sait porter en colonnes ─────────────

export interface NormalizedInspection {
	/** `PASS` | `NEUTRAL` | `FAIL` | `PARTIAL` — le verdict Google. */
	verdict: string | null;
	/** Texte libre côté Google (« Submitted and indexed », « Crawled - currently not indexed »…). */
	coverageState: string | null;
	indexingState: string | null;
	robotsState: string | null;
	googleCanonical: string | null;
	userCanonical: string | null;
	/** `lastCrawlTime` (ISO Google) — stocké tel quel, c'est une donnée du provider. */
	lastCrawlAt: string | null;
}

/**
 * Ce que SPEC §9.2 demande de conserver mais qu'aucune colonne ne porte : `pageFetchState`,
 * `referringUrls`, `sitemap`, mobile usability, rich results, `crawledAs`. Va dans
 * `payload_json`, borné.
 */
export interface InspectionPayload {
	pageFetchState?: string | null;
	crawledAs?: string | null;
	sitemaps?: string[];
	referringUrls?: string[];
	mobileUsability?: unknown;
	richResults?: unknown;
	ampResult?: unknown;
	/** Ce qui a été coupé pour tenir dans le plafond — dit, jamais silencieux. */
	truncated?: { field: string; kept: number; dropped: number }[];
}

export type InspectionOutcome =
	| { kind: 'result'; normalized: NormalizedInspection; payload: InspectionPayload }
	| {
			kind: 'provider_error';
			/** Statut HTTP renvoyé par Google (0 si l'appel n'a pas abouti). */
			status: number;
			/** `reason` du corps Google (`rateLimitExceeded`, `invalid_grant`…), s'il y en a. */
			reason: string | null;
			message: string;
	  };

// ── Bornes du payload ───────────────────────────────────────────────

/**
 * Plafond de listes recopiées dans le payload.
 *
 * `referringUrls` peut compter des centaines d'entrées sur une page bien maillée. Le payload
 * d'observation est plafonné à 32 Ko (`MAX_OBSERVATION_PAYLOAD_BYTES`) et dépasser **jette** :
 * une page très maillée ferait donc échouer sa propre collecte. On coupe, et on DIT qu'on a
 * coupé — un inventaire tronqué en silence se lirait comme complet.
 */
export const MAX_PAYLOAD_LIST_ITEMS = 50;

function pickString(source: Record<string, unknown>, key: string): string | null {
	const v = source[key];
	return typeof v === 'string' && v.length > 0 ? v : null;
}

function capList(
	raw: unknown,
	field: string,
	truncated: { field: string; kept: number; dropped: number }[]
): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const items = raw.filter((x): x is string => typeof x === 'string');
	if (items.length <= MAX_PAYLOAD_LIST_ITEMS) return items;
	truncated.push({
		field,
		kept: MAX_PAYLOAD_LIST_ITEMS,
		dropped: items.length - MAX_PAYLOAD_LIST_ITEMS
	});
	return items.slice(0, MAX_PAYLOAD_LIST_ITEMS);
}

// ── Parsing d'une réponse d'inspection ──────────────────────────────

/**
 * Normalise une réponse `urlInspection/index:inspect`.
 *
 * La forme Google : `{ inspectionResult: { indexStatusResult: {…}, mobileUsabilityResult,
 * richResultsResult, ampResult } }`. On lit défensivement — une clé absente rend `null`, jamais
 * une exception : une réponse partielle est une donnée, pas une panne.
 *
 * ⚠️ Une réponse SANS `inspectionResult` n'est PAS un « résultat vide » : c'est une réponse
 * qu'on n'a pas comprise, et elle rend `null` partout. Le collecteur décide alors de ne rien
 * écrire — écrire des `null` créerait une observation qui se lirait comme « Google ne connaît
 * pas cette page », ce qui est précisément le faux signal à éviter.
 */
export function parseInspectionResult(json: unknown): {
	normalized: NormalizedInspection;
	payload: InspectionPayload;
	/** Faux si la réponse n'a pas la forme attendue (pas de `inspectionResult` exploitable). */
	understood: boolean;
} {
	const empty: NormalizedInspection = {
		verdict: null,
		coverageState: null,
		indexingState: null,
		robotsState: null,
		googleCanonical: null,
		userCanonical: null,
		lastCrawlAt: null
	};
	if (!json || typeof json !== 'object') {
		return { normalized: empty, payload: {}, understood: false };
	}
	const root = json as Record<string, unknown>;
	const result = root.inspectionResult;
	if (!result || typeof result !== 'object') {
		return { normalized: empty, payload: {}, understood: false };
	}
	const r = result as Record<string, unknown>;
	const idx = (typeof r.indexStatusResult === 'object' && r.indexStatusResult !== null
		? r.indexStatusResult
		: {}) as Record<string, unknown>;

	const truncated: { field: string; kept: number; dropped: number }[] = [];
	const payload: InspectionPayload = {
		pageFetchState: pickString(idx, 'pageFetchState'),
		crawledAs: pickString(idx, 'crawledAs'),
		sitemaps: capList(idx.sitemap, 'sitemap', truncated),
		referringUrls: capList(idx.referringUrls, 'referringUrls', truncated),
		mobileUsability: r.mobileUsabilityResult,
		richResults: r.richResultsResult,
		ampResult: r.ampResult
	};
	if (truncated.length > 0) payload.truncated = truncated;

	const normalized: NormalizedInspection = {
		verdict: pickString(idx, 'verdict'),
		coverageState: pickString(idx, 'coverageState'),
		indexingState: pickString(idx, 'indexingState'),
		robotsState: pickString(idx, 'robotsState'),
		googleCanonical: pickString(idx, 'googleCanonical'),
		userCanonical: pickString(idx, 'userCanonical'),
		lastCrawlAt: pickString(idx, 'lastCrawlTime')
	};

	// Une réponse est « comprise » dès qu'elle porte un verdict OU un coverageState : c'est le
	// minimum qui distingue une inspection réelle d'une enveloppe vide.
	const understood = normalized.verdict !== null || normalized.coverageState !== null;
	return { normalized, payload, understood };
}

// ── Classification indexé / non indexé / inconnu ────────────────────

export type IndexedClass = 'indexed' | 'not_indexed' | 'excluded' | 'unknown';

/**
 * Classe un `coverageState` en famille exploitable.
 *
 * `excluded` est une classe À PART, et c'est le point : « Excluded by 'noindex' tag » et
 * « Crawled - currently not indexed » ne demandent PAS le même geste. Le premier est une
 * décision du site qu'on respecte ; le second est un problème à traiter. Le legacy
 * (`indexing.ts:classifyIndexStatus`) les rangeait tous deux du côté « ne pas resoumettre »,
 * ce qui suffisait à son usage (soumission) mais efface la distinction qu'un détecteur
 * d'indexation (IDX-005) a besoin de voir.
 *
 * `unknown` reste `unknown` : ne pas savoir n'est pas « non indexé ».
 */
export function classifyCoverage(coverageState: string | null): IndexedClass {
	if (!coverageState) return 'unknown';
	const cs = coverageState.toLowerCase();
	if (cs.includes('excluded') || cs.includes('noindex') || cs.includes('alternate page')) {
		return 'excluded';
	}
	if (cs.includes('not indexed') || cs.includes('unknown to google') || cs.includes('not found')) {
		return 'not_indexed';
	}
	if (cs.includes('indexed')) return 'indexed';
	return 'unknown';
}

/**
 * Vrai si le canonical choisi par Google diffère de celui déclaré par le site.
 *
 * Matière première du détecteur `canonical_conflict` (SPEC §875), à confronter au
 * `expected_canonical` de l'inventaire IDX-001. Rend `null` quand l'un des deux manque :
 * « on ne peut pas comparer » n'est pas « ils sont d'accord ».
 */
export function canonicalMismatch(input: NormalizedInspection): boolean | null {
	if (!input.googleCanonical || !input.userCanonical) return null;
	return input.googleCanonical !== input.userCanonical;
}

// ── Plafond d'URLs par job ──────────────────────────────────────────

/**
 * Plafond dur d'URLs par job.
 *
 * IDX-002 **ne choisit pas** ses URLs : elles arrivent dans le payload du job. Mais il refuse
 * d'en traiter un nombre non borné — le quota (2 000/jour/propriété) est partagé par 6 projets,
 * et un appel forgé avec 5 000 URLs le brûlerait en un job. La POLITIQUE de sélection (quelles
 * URLs méritent le quota) est le sujet d'IDX-004, pas d'ici : installer une règle implicite
 * (« les N premières du sitemap ») obligerait IDX-004 à la défaire.
 */
export const MAX_URLS_PER_JOB = 200;

export function capUrls(
	urls: string[],
	cap: number = MAX_URLS_PER_JOB
): { kept: string[]; truncated: boolean; dropped: number } {
	const limit = Math.max(1, Math.min(Math.floor(cap), MAX_URLS_PER_JOB));
	// Dédup en conservant l'ordre : deux fois la même URL, c'est deux fois le quota pour la
	// même donnée (et un `ON CONFLICT` qui écrase sa propre ligne).
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const raw of urls) {
		const u = (raw ?? '').trim();
		if (!u || seen.has(u)) continue;
		seen.add(u);
		unique.push(u);
	}
	if (unique.length <= limit) return { kept: unique, truncated: false, dropped: 0 };
	return { kept: unique.slice(0, limit), truncated: true, dropped: unique.length - limit };
}
