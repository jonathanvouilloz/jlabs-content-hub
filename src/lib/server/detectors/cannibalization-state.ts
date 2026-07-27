/**
 * FIND-008 — Détecteur `cannibalization` : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), comme `detector-state.ts`,
 * `keyword-decline-state.ts`, `query-turnover-state.ts` et `index-transition-state.ts`.
 * `cannibalization.ts` lit la base et écrit ; ici, rien qui touche le monde extérieur.
 *
 * Le parc avait un ÉCRAN de cannibalisation (`gsc-analytics.computeCannibalization`,
 * epic 23) : il lit les tables legacy, n'écrit aucun finding, n'a ni cycle de vie ni
 * preuves, et ne survit pas à la requête qui l'affiche. Ce module en reprend le
 * vocabulaire (dominance, écart de position, mauvais aiguillage) et le porte sur le
 * canon `gsc_query_page_observations`, avec fingerprint, closure, portée et preuves.
 *
 * ── Les six décisions porteuses ───────────────────────────────────────────────
 *
 * 1. **⭐ La normalisation d'URL n'est pas un confort d'affichage : c'est la moitié du
 *    détecteur.** GSC remonte `…/article#section`, `http://`, `https://www.` et
 *    `…/page/` comme des pages DISTINCTES — ce sont la même ressource. Mesuré sur le
 *    parc, à seuils par défaut : sur `barberconcept`, 143 pages brutes se replient en
 *    **51**, et les conflits persistants tombent de **397 à 180** — **217 faux conflits
 *    évités**, dont **220 qui se seraient lus « probables »** : deux ancres d'un même
 *    article se partagent les impressions à parts égales, donc elles prennent
 *    exactement la forme d'une compétition équilibrée (`split` : 299 avant repli,
 *    58 après). C'est le symétrique exact du regroupement de variantes de FIND-006, et
 *    la même asymétrie de coût s'applique : une normalisation trop pauvre FABRIQUE des
 *    conflits, une normalisation trop riche en EFFACE. D'où une règle **fermée**
 *    (cinq gestes, une liste close de paramètres de tracking), **versionnée**
 *    (`URL_NORMALIZATION_RULE`), **publiée** dans les preuves et **rejouable** — et les
 *    formes brutes repliées restent visibles (`rawUrls`), donc le repli est réversible.
 *
 * 2. **⭐ Le grain HEBDO est obligatoire : l'alternance ne s'observe pas sur un
 *    agrégat.** `aggregateWindow` (query×page) collapse les semaines — l'utiliser
 *    « pour réutiliser l'existant » ferait perdre le meilleur discriminant du
 *    détecteur SANS QUE RIEN N'ÉCHOUE. Or l'alternance (l'URL dominante change d'une
 *    semaine à l'autre) est le fait qui distingue « Google hésite entre deux de mes
 *    pages » d'une coexistence stable : mesurée sur **122 des 197** conflits du parc.
 *    D'où `aggregateByQueryUrl`, qui garde la série hebdomadaire par URL.
 *
 * 3. **⭐ La persistance est un gate DUR, pas un plafond de sévérité.** L'acceptation
 *    est littérale : « un conflit n'est créé qu'après persistance minimale ». C'est
 *    l'inverse de FIND-005 (une baisse d'une seule semaine est écrite mais plafonnée)
 *    et d'IDX-005 (une fluctuation isolée est écrite en `pending`). Ici, sous le seuil :
 *    **rien n'est écrit** — mais tout est **compté** (`belowPersistence`), parce qu'une
 *    absence muette se lirait « il n'y a rien ».
 *    Corollaire nommé : deux URLs significatives qui ne se CHEVAUCHENT jamais (A en
 *    semaines 1-2, B en 3-4) sont un **remplacement**, pas une cannibalisation. C'est
 *    le faux positif structurel du détecteur, et il est refusé par construction.
 *
 * 4. **⭐ La forme mécanique n'est PAS un gate d'écriture, c'est un plafond de
 *    sévérité.** Le fingerprint est la requête (décision n°5) et la forme bouge d'une
 *    semaine à l'autre : gater dessus ferait clignoter les findings (écrit →
 *    auto-résolu à la 2ᵉ absence → réouvert → re-résolu), exactement le churn que le
 *    fingerprint cherche à éviter, déplacé d'un cran. Donc la forme est **écrite dans
 *    les preuves**, elle **plafonne** (`!probable` ⇒ jamais au-dessus de `low`) et elle
 *    **trie** ; c'est `maxCandidates` qui supprime, déterministiquement, pendant que la
 *    closure reste complète.
 *    ⚠️ Et il faut le dire franchement : cette règle mécanique n'écarte que **11
 *    conflits sur 197** dans le parc réel. Elle n'EST PAS la classification — SPEC §10.5
 *    réserve le verdict (mot-clé exact / même intention / proximité sémantique légitime
 *    / triade SERP / variante technique-canonical / mauvais mapping) au skill
 *    `seo-cannibalisation`. Ce module nomme ce qu'il a VU, jamais ce que ça VEUT DIRE.
 *
 * 5. **On ne regroupe PAS les variantes de requêtes — inversion explicite de la
 *    doctrine FIND-006.** Là-bas, fusionner « coiffeur genève » et « genève coiffeur »
 *    empêche deux faux signaux ; ici, la même fusion en FABRIQUERAIT un : deux
 *    orthographes qui sortent légitimement sur deux pages différentes deviendraient un
 *    conflit qui n'a jamais eu lieu. L'entité est donc la requête BRUTE, partout —
 *    fingerprint compris. Risque résiduel assumé : si Google éclate l'orthographe et
 *    que les deux formes montrent les mêmes deux URLs, deux findings sortent pour un
 *    conflit (aucun cas trouvé dans le parc). `urlSetKey` est posé dans les preuves
 *    pour rendre un dédoublonnage futur possible SANS toucher au fingerprint.
 *
 * 6. **⭐ « merge, redirect et canonical restent L4 » n'est pas une consigne, c'est
 *    l'absence d'un chemin d'écriture.** `buildProposals` (`proposer-state.ts`) rend
 *    `[]` pour tout type autre que `keyword_opportunity` : ce détecteur ne peut
 *    structurellement produire aucune proposition. Et le skill recommandé,
 *    `seo-cannibalisation`, est un skill d'ANALYSE — il classe et recommande, il
 *    n'exécute rien. SPEC §10.5 : « aucune redirection n'est proposée sans métriques
 *    des deux pages, analyse d'intention et validation humaine ».
 */
import { isExcludedQuery, MAX_EVIDENCE_IDS, type ObservationRow } from '../detector-state.js';
import { clampScore, PRIORITY_WEIGHTS, type FindingSeverity } from '../finding-state.js';
import type { WindowCompleteness } from '../gsc-windows-state.js';

// ── Identité du détecteur ───────────────────────────────────────────

/**
 * Version stockée dans `findings.detector_version`. À incrémenter dès que la sélection
 * ou le scoring change (acceptation FIND-001 : deux versions restent comparables sur un
 * même jeu d'observations).
 */
export const DETECTOR_CANNIBALIZATION = 'cannibalization@1';

/** Type de finding produit (catalogue §10.4 — déjà au vocabulaire `FINDING_TYPES`). */
export const CANNIBALIZATION_TYPE = 'cannibalization';

/**
 * §10.4 : `seo-cannibalisation`. Skill d'ANALYSE — il classe le conflit (A/B/C, triade
 * SERP, variante technique, mauvais mapping) et recommande ; il n'exécute rien.
 * Décision porteuse n°6.
 */
export const CANNIBALIZATION_SKILL = 'seo-cannibalisation';

/**
 * Identifiant de la règle de repli d'URL, PUBLIÉ dans chaque preuve.
 *
 * ⚠️ Toute évolution de `normalizePageUrl` incrémente cet identifiant **ET**
 * `DETECTOR_CANNIBALIZATION` : un regroupement d'URLs qui change en silence rendrait
 * deux semaines de findings incomparables, sans que rien ne le signale.
 */
export const URL_NORMALIZATION_RULE = 'gsc_page_url@1';

// ── Normalisation d'URL (décision porteuse n°1) ─────────────────────

/**
 * Paramètres de tracking retirés de la query string. Liste FERMÉE, jamais devinée par
 * heuristique : un paramètre inconnu peut être un vrai discriminant de ressource
 * (`?page=4`), et le retirer fusionnerait deux pages distinctes.
 */
export const TRACKING_PARAMS: readonly string[] = [
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_term',
	'utm_content',
	'utm_id',
	'gclid',
	'gbraid',
	'wbraid',
	'fbclid',
	'msclkid',
	'mc_cid',
	'mc_eid',
	'ref',
	'dpl'
];

const TRACKING_SET = new Set(TRACKING_PARAMS);

/**
 * Normalise une URL de page GSC. Cinq gestes, et pas un de plus :
 *
 *   1. fragment (`#ancre`) SUPPRIMÉ — **50 % des faux conflits du parc** (GSC remonte
 *      les jump-to links d'un même article comme des pages distinctes) ;
 *   2. protocole forcé à `https` — quelques URLs du parc traînent en `http://` ;
 *   3. préfixe `www.` retiré — `jonlabs.ch` et `www.jonlabs.ch` sont la même page ;
 *   4. slash final retiré, sauf la racine qui reste `/` ;
 *   5. query string **CONSERVÉE**, paramètres de tracking retirés, clés TRIÉES.
 *
 * ⚠️ Le geste 5 est le point où l'on s'écarte du legacy (`gsc-analytics.ts`), qui jette
 * la query string entière. Le parc porte `https://www.barberconcept.ch/?f9688240_page=4` :
 * une page 4 de listing est une ressource DIFFÉRENTE de la racine, et les fusionner
 * fabriquerait un conflit entre la home et sa propre pagination — sur la page la plus
 * stratégique du site. Le coût de la conservation est nul (une poignée d'URLs), celui de
 * la fusion est un faux positif là où il fait le plus de dégâts.
 *
 * Le percent-encoding est DÉPLIÉ (`decodeURIComponent` sous garde) : GSC mélange
 * `/blog/coupe-%C3%A9t%C3%A9` et `/blog/coupe-été`, qui sont la même page. La casse de
 * l'hôte est abaissée ; **celle du chemin est préservée** (un serveur peut la
 * distinguer, et présumer l'inverse fusionnerait deux vraies pages).
 *
 * Un `raw` non parsable retombe sur `raw.split('#')[0]` : jamais une exception, jamais
 * un regroupement muet.
 */
export function normalizePageUrl(raw: string): string {
	try {
		const u = new URL(raw);
		const host = u.hostname.toLowerCase().replace(/^www\./, '');

		let path = u.pathname.replace(/\/+$/, '');
		if (path === '') path = '/';
		path = decodePathSafely(path);

		const params = [...u.searchParams.entries()]
			.filter(([k]) => !TRACKING_SET.has(k.toLowerCase()))
			.sort((a, b) => (a[0] === b[0] ? cmp(a[1], b[1]) : cmp(a[0], b[0])));
		const qs = params.length > 0 ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';

		return `https://${host}${path}${qs}`;
	} catch {
		return raw.split('#')[0];
	}
}

/** `decodeURIComponent` échoue sur un `%` isolé : on garde alors la forme brute. */
function decodePathSafely(path: string): string {
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

// ── Seuils (configurables par projet) ───────────────────────────────

export interface CannibalizationThresholds {
	/**
	 * Plancher ABSOLU d'impressions par URL sur la fenêtre pour qu'elle compte dans le
	 * conflit. Bas par construction : un plancher haut masquerait toute cannibalisation
	 * sur les sites locaux, où un mot-clé money pèse 20–160 impressions sur 4 semaines.
	 */
	minUrlImpressions: number;
	/**
	 * Part MINIMALE des impressions de la requête qu'une URL doit capter. C'est ce seuil
	 * RELATIF qui fait le travail sur les grosses requêtes, là où le plancher absolu ne
	 * discrimine plus rien.
	 */
	relativeShare: number;
	/** Impressions minimales de la REQUÊTE sur la fenêtre — gate anti-longue-traîne. */
	minQueryImpressions: number;
	/**
	 * Semaines de CHEVAUCHEMENT exigées. Le gate dur de l'acceptation (décision n°3) :
	 * une seule semaine est le motif d'échantillonnage de GSC, pas un conflit.
	 */
	minOverlapWeeks: number;
	/**
	 * Part au-delà de laquelle une URL « possède » la requête : la seconde est un écho,
	 * pas une concurrente. Sert à la FORME (`dominant`), jamais à écarter.
	 */
	dominanceCeiling: number;
	/**
	 * Écart de position au-delà duquel deux URLs ne se disputent pas le même slot
	 * (`stacked`). Une page de SERP d'écart : ce n'est plus la même bataille.
	 */
	maxPositionSpread: number;
	/**
	 * Écart de position minimal pour parler de MAUVAIS AIGUILLAGE (l'URL mise en avant
	 * ranke moins bien qu'une autre des tiennes). Plus petit écart qui survive à une
	 * moyenne pondérée sur 4 semaines.
	 */
	minMisallocation: number;
	/**
	 * ⚠️ **Pas un gate : un tripwire.** Au-delà, caveat de confiance, plafond de
	 * sévérité et compteur `suspiciousUrlCount` — jamais un silence, jamais un rejet.
	 *
	 * ⚠️ Et il faut savoir ce qu'il garde VRAIMENT : `relativeShare` borne déjà le
	 * nombre d'URLs significatives à `⌊1/relativeShare⌋`, soit **6 au défaut** — la
	 * somme des parts ne peut pas dépasser 1. Le tripwire est donc **mathématiquement
	 * inatteignable tant que `relativeShare` vaut son défaut** (le maximum observé sur
	 * le parc est 4). Il ne surveille pas la normalisation : il surveille un projet qui
	 * ABAISSE sa part de significativité, seul chemin par lequel une requête peut se
	 * retrouver avec dix concurrentes.
	 */
	maxUrls: number;
	/** Position au-delà de laquelle un conflit interne n'est plus ton problème. */
	positionHorizon: number;
	/** Volume d'impressions sous lequel la sévérité est plafonnée (§10.3 / FIND-002). */
	lowVolumeImpressions: number;
	/** Nombre maximal de findings écrits par run et par projet. */
	maxCandidates: number;
	/** Bruit configuré à exclure (marque, navigationnel) — jamais deviné. */
	excludeQueryPatterns: string[];
}

/**
 * Défauts MESURÉS sur le parc réel (9 projets, 4 dernières semaines), pas devinés.
 *
 * - `minUrlImpressions: 5` — le genou de la courbe. Plancher 3 → 5 → 8 → 10 donne
 *   `barberconcept` 352 → 279 → 173 → 123 candidats et `lecureux` 7 → 3 → 2 → 1 : à 3
 *   on ramasse des URLs vues une seule fois, à 8 on tue deux des trois conflits réels
 *   de `lecureux`.
 * - `relativeShare: 0.15` — hérité du legacy et validé. Les deux seuils se RELAIENT :
 *   une requête à 3 152 impressions exige 473 impressions par URL ; une requête à 24
 *   exige 3,6, donc le plancher absolu reprend la main. C'est pour ça qu'ils coexistent.
 * - `minQueryImpressions: 24` (≈ 6/semaine) — écarte 56 candidats sur `barberconcept`,
 *   et **zéro** sur `lecureux`, `barbermedia` et `physiopommier` : il coupe la queue du
 *   gros site, il ne touche pas les petits. Raison de fond : sous ce volume, chaque URL
 *   pèse ~5 impressions et deux impressions d'écart retournent la dominance — la
 *   grandeur n'est plus mesurable.
 * - `minOverlapWeeks: 2` — l'acceptation littérale, au minimum qui la rende vraie.
 * - `dominanceCeiling: 0.80` — au-delà, la seconde URL capte moins d'un cinquième.
 * - `maxCandidates: 25` — les frères sont à 50 ; un conflit de cannibalisation est une
 *   ANALYSE L4, plus lourde à traiter par unité qu'une opportunité. `barberconcept`
 *   annonce `totalMatched: 180, truncated: true`, et la closure porte les 180.
 */
export const CANNIBALIZATION_DEFAULTS: CannibalizationThresholds = {
	minUrlImpressions: 5,
	relativeShare: 0.15,
	minQueryImpressions: 24,
	minOverlapWeeks: 2,
	dominanceCeiling: 0.8,
	maxPositionSpread: 20,
	minMisallocation: 2,
	maxUrls: 6,
	positionHorizon: 30,
	lowVolumeImpressions: 100,
	maxCandidates: 25,
	excludeQueryPatterns: []
};

/** Seuils exprimés en PART, qui doivent rester dans `]0,1]`. */
const RATIO_KEYS: readonly (keyof CannibalizationThresholds)[] = ['relativeShare', 'dominanceCeiling'];

/**
 * Fusionne des overrides projet aux défauts. Même discipline que les frères : toute
 * valeur non finie ou négative est ignorée silencieusement — un override corrompu ne
 * doit jamais DÉSACTIVER un seuil.
 *
 * ⚠️ Avec un clamp de plus, propre à ce détecteur : `relativeShare` et
 * `dominanceCeiling` sont bornés dans `]0,1]`. La discipline maison ignore les
 * négatifs mais **accepte `0`**, et `relativeShare = 0` est le seul override du parc
 * capable de désactiver complètement la significativité (`θ = max(5, 0) = 5`) : sur
 * `barberconcept`, ~2 000 « conflits » d'un coup.
 */
export function resolveCannibalizationThresholds(
	overrides?: Partial<CannibalizationThresholds> | null
): CannibalizationThresholds {
	const out = { ...CANNIBALIZATION_DEFAULTS };
	if (!overrides) return out;

	for (const key of Object.keys(CANNIBALIZATION_DEFAULTS) as (keyof CannibalizationThresholds)[]) {
		if (key === 'excludeQueryPatterns') continue;
		const v = overrides[key];
		if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
		if (RATIO_KEYS.includes(key) && (v <= 0 || v > 1)) continue;
		(out[key] as number) = v;
	}

	if (Array.isArray(overrides.excludeQueryPatterns)) {
		out.excludeQueryPatterns = overrides.excludeQueryPatterns
			.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
			.map((p) => p.trim().toLowerCase());
	}
	return out;
}

// ── Agrégation query × URL × SEMAINE (décision porteuse n°2) ────────

/** Ce qu'une URL normalisée pèse sur la fenêtre, pour une requête donnée. */
export interface UrlSide {
	/** URL NORMALISÉE — la clé de regroupement. */
	url: string;
	/** Formes BRUTES repliées sous cette clé, triées : le repli est réversible. */
	rawUrls: string[];
	clicks: number;
	impressions: number;
	ctr: number;
	/** Position moyenne PONDÉRÉE par les impressions (même règle que partout ailleurs). */
	position: number;
	/** Semaines distinctes où l'URL apparaît. */
	weeksSeen: number;
	/** Impressions par semaine (clé = `period_start`) — base de la dominance hebdo. */
	weekly: Map<string, number>;
	observationIds: string[];
}

interface UrlAccumulator {
	url: string;
	rawUrls: Set<string>;
	clicks: number;
	impressions: number;
	positionWeighted: number;
	weekly: Map<string, number>;
	observationIds: string[];
}

/**
 * Agrège les observations `query×page×device` d'une fenêtre en `query → URL normalisée`,
 * **en conservant la série hebdomadaire**.
 *
 * ⚠️ `aggregateWindow` (`detector-state.ts`) est un FAUX AMI ici : elle agrège aussi par
 * query×page, mais elle collapse les semaines. Sans la série hebdo, l'alternance —
 * le meilleur discriminant du détecteur (décision porteuse n°2) — devient inobservable,
 * et rien n'échouerait pour le signaler.
 */
export function aggregateByQueryUrl(rows: ObservationRow[]): Map<string, Map<string, UrlSide>> {
	const acc = new Map<string, Map<string, UrlAccumulator>>();

	for (const r of rows) {
		let urls = acc.get(r.query);
		if (!urls) {
			urls = new Map();
			acc.set(r.query, urls);
		}
		const key = normalizePageUrl(r.page);
		let entry = urls.get(key);
		if (!entry) {
			entry = {
				url: key,
				rawUrls: new Set(),
				clicks: 0,
				impressions: 0,
				positionWeighted: 0,
				weekly: new Map(),
				observationIds: []
			};
			urls.set(key, entry);
		}
		entry.rawUrls.add(r.page);
		entry.clicks += r.clicks;
		entry.impressions += r.impressions;
		entry.positionWeighted += r.position * r.impressions;
		entry.weekly.set(r.periodStart, (entry.weekly.get(r.periodStart) ?? 0) + r.impressions);
		entry.observationIds.push(r.id);
	}

	const out = new Map<string, Map<string, UrlSide>>();
	for (const [query, urls] of acc) {
		const sides = new Map<string, UrlSide>();
		for (const [key, e] of urls) {
			sides.set(key, {
				url: e.url,
				rawUrls: [...e.rawUrls].sort(cmp),
				clicks: e.clicks,
				impressions: e.impressions,
				ctr: e.impressions > 0 ? e.clicks / e.impressions : 0,
				position: e.impressions > 0 ? e.positionWeighted / e.impressions : 0,
				weeksSeen: e.weekly.size,
				weekly: e.weekly,
				observationIds: [...e.observationIds].sort(cmp)
			});
		}
		out.set(query, sides);
	}
	return out;
}

// ── Les quatre grandeurs du ticket ──────────────────────────────────

/**
 * FORME MÉCANIQUE du conflit — ce que la machine a OBSERVÉ, jamais ce que ça VEUT DIRE
 * (décision porteuse n°4). Quatre valeurs, évaluées dans l'ordre de `classifyShape`.
 */
export type ConflictShape =
	/** L'URL dominante a changé au moins une fois : Google hésite. */
	| 'alternating'
	/** Dominante stable, poids comparables, même bande de position. */
	| 'split'
	/** Une URL capte ≥ `dominanceCeiling` : la seconde est un écho persistant. */
	| 'dominant'
	/** Écart de position ≥ `maxPositionSpread` : ce n'est pas la même bataille. */
	| 'stacked';

/** Les quatre grandeurs du ticket, plus les auxiliaires héritées du legacy. */
export interface ConflictMetrics {
	/** T(q) — impressions de la requête, TOUTES URLs, avant significativité. */
	queryImpressions: number;
	/** S(q) — impressions des seules URLs significatives. Dénominateur des parts. */
	conflictImpressions: number;
	conflictClicks: number;
	/** Le seuil de significativité EFFECTIF, publié pour être rejoué. */
	significanceThreshold: number;
	/** |Sig(q)|. */
	urlCount: number;
	/** URLs normalisées vues, significatives ou non. */
	observedUrlCount: number;
	/** URLs BRUTES vues — la mesure du repli. */
	rawUrlCount: number;
	/** DOMINANCE — concentration du volume sur une URL, ∈ [1/|Sig|, 1). */
	dominance: number;
	/** ALTERNANCE — part de bascules du meneur, ∈ [0,1]. */
	alternation: number;
	/** Nombre de bascules du meneur sur la sous-suite de chevauchement. */
	switches: number;
	/** DURÉE — semaines de chevauchement. C'est là-dessus que porte le gate. */
	overlapWeeks: number;
	/** CHEVAUCHEMENT — `overlapWeeks / semaines de la fenêtre`, ∈ [0,1]. */
	overlapRatio: number;
	/** Plus longue série de semaines CONTIGUËS de chevauchement (preuves seulement). */
	longestStreak: number;
	/** Le conflit est vivant dans la DERNIÈRE semaine de la fenêtre (preuves seulement). */
	currentlyOverlapping: boolean;
	/** Meilleure position parmi les URLs significatives. */
	bestPosition: number;
	/** max(position) − min(position). */
	positionSpread: number;
	/** POS(dominante) − bestPosition, borné ≥ 0 : le MAUVAIS AIGUILLAGE. */
	misallocation: number;
}

/** Le meneur d'une semaine de chevauchement. */
export interface WeekLeader {
	week: string;
	url: string;
	impressions: number;
}

/** L'unité écrivable : un conflit sur une requête. */
export interface CannibalizationUnit {
	/** Requête BRUTE. Aucune normalisation de requête nulle part (décision n°5). */
	query: string;
	/** URLs significatives, part décroissante. `urls[0]` = la dominante. */
	urls: UrlSide[];
	/** URLs normalisées vues mais SOUS le seuil de significativité (comptées, pas tues). */
	marginalUrlCount: number;
	metrics: ConflictMetrics;
	shape: ConflictShape;
	/** Vrai si le conflit est mécaniquement PROBABLE (`isProbableConflict`). */
	probable: boolean;
	/** Semaines de chevauchement, chronologiques, avec le meneur de chacune. */
	leaders: WeekLeader[];
}

/** Clé d'unité, pour un tri 100 % reproductible. */
export function unitKey(unit: CannibalizationUnit): string {
	return `${CANNIBALIZATION_TYPE}:${unit.query}`;
}

/**
 * Clé de l'ENSEMBLE d'URLs en conflit (normalisées, triées). Publiée dans les preuves
 * pour rendre un dédoublonnage inter-orthographes possible plus tard **sans toucher au
 * fingerprint**, qui reste la requête (décision porteuse n°5).
 */
export function urlSetKey(urls: UrlSide[]): string {
	return urls
		.map((u) => u.url)
		.sort(cmp)
		.join(' | ');
}

/**
 * Seuil de significativité d'une URL : `max(plancher absolu, part × impressions de la
 * requête)`. Les deux se relaient — le plancher tient les petites requêtes locales, la
 * part tient les grosses.
 */
export function significanceThreshold(
	queryImpressions: number,
	thresholds: CannibalizationThresholds
): number {
	return Math.max(thresholds.minUrlImpressions, thresholds.relativeShare * queryImpressions);
}

/**
 * Semaines où AU MOINS DEUX URLs significatives ont des impressions — le CHEVAUCHEMENT.
 *
 * C'est la grandeur qui distingue un conflit d'un simple REMPLACEMENT : l'URL A en
 * semaines 1-2 puis l'URL B en 3-4 donne deux URLs significatives et un chevauchement
 * VIDE. Google n'a jamais hésité, il a changé d'avis une fois. Rien n'est écrit.
 */
export function overlapWeeksOf(urls: UrlSide[], windowWeeks: string[]): string[] {
	const out: string[] = [];
	for (const week of windowWeeks) {
		let live = 0;
		for (const u of urls) {
			if ((u.weekly.get(week) ?? 0) > 0) live += 1;
			if (live >= 2) break;
		}
		if (live >= 2) out.push(week);
	}
	return out;
}

/**
 * Meneur de chaque semaine de chevauchement : l'URL qui capte le plus d'impressions.
 * Égalité départagée par l'ordre lexicographique de l'URL — un départage arbitraire mais
 * DÉTERMINISTE vaut mieux qu'une alternance qui dépendrait de l'ordre d'arrivée des lignes.
 */
export function weekLeaders(urls: UrlSide[], overlap: string[]): WeekLeader[] {
	return overlap.map((week) => {
		let leader = urls[0];
		let best = leader.weekly.get(week) ?? 0;
		for (const u of urls.slice(1)) {
			const imp = u.weekly.get(week) ?? 0;
			if (imp > best || (imp === best && cmp(u.url, leader.url) < 0)) {
				best = imp;
				leader = u;
			}
		}
		return { week, url: leader.url, impressions: best };
	});
}

/**
 * ALTERNANCE — nombre de fois où le meneur change, sur la sous-suite de chevauchement.
 *
 * ⚠️ La contiguïté est celle de `overlap`, **pas** celle de la fenêtre. Deux semaines de
 * chevauchement séparées par une semaine sans conflit comptent comme consécutives : on
 * compare les choix de Google **sur les semaines où il avait un choix à faire**. Exiger
 * la contiguïté dans la fenêtre ferait dépendre l'alternance d'une semaine de collecte
 * manquante — le faux signal que GSC-004 interdit.
 */
export function countSwitches(leaders: WeekLeader[]): number {
	let switches = 0;
	for (let i = 1; i < leaders.length; i += 1) {
		if (leaders[i].url !== leaders[i - 1].url) switches += 1;
	}
	return switches;
}

/** Plus longue série de semaines CONTIGUËS de chevauchement, au sens de la fenêtre. */
export function longestStreakOf(overlap: string[], windowWeeks: string[]): number {
	const marks = windowWeeks.map((w) => overlap.includes(w));
	let best = 0;
	let run = 0;
	for (const m of marks) {
		run = m ? run + 1 : 0;
		if (run > best) best = run;
	}
	return best;
}

/** Assemble les quatre grandeurs et leurs auxiliaires pour une requête candidate. */
export function computeConflictMetrics(input: {
	significant: UrlSide[];
	allUrls: UrlSide[];
	queryImpressions: number;
	threshold: number;
	overlap: string[];
	leaders: WeekLeader[];
	windowWeeks: string[];
}): ConflictMetrics {
	const { significant, allUrls, queryImpressions, threshold, overlap, leaders, windowWeeks } = input;

	// ⚠️ Dénominateur des parts : S(q), les URLs SIGNIFICATIVES — jamais T(q). Avec T,
	// une longue traîne d'URLs marginales ferait chuter la dominance artificiellement,
	// donc tout deviendrait `split`, donc tout deviendrait `probable`.
	const conflictImpressions = significant.reduce((s, u) => s + u.impressions, 0);
	const conflictClicks = significant.reduce((s, u) => s + u.clicks, 0);
	const maxImpressions = significant.reduce((m, u) => Math.max(m, u.impressions), 0);

	const positions = significant.map((u) => u.position);
	const bestPosition = Math.min(...positions);
	const positionSpread = Math.max(...positions) - bestPosition;
	const leaderUrl = significant.reduce((b, u) => (u.impressions > b.impressions ? u : b));

	const weeks = Math.max(1, windowWeeks.length);
	const switches = countSwitches(leaders);

	return {
		queryImpressions,
		conflictImpressions,
		conflictClicks,
		significanceThreshold: threshold,
		urlCount: significant.length,
		observedUrlCount: allUrls.length,
		rawUrlCount: allUrls.reduce((s, u) => s + u.rawUrls.length, 0),
		dominance: conflictImpressions > 0 ? maxImpressions / conflictImpressions : 0,
		alternation: switches / Math.max(1, leaders.length - 1),
		switches,
		overlapWeeks: overlap.length,
		overlapRatio: overlap.length / weeks,
		longestStreak: longestStreakOf(overlap, windowWeeks),
		currentlyOverlapping:
			windowWeeks.length > 0 && overlap.includes(windowWeeks[windowWeeks.length - 1]),
		bestPosition,
		positionSpread,
		misallocation: Math.max(0, leaderUrl.position - bestPosition)
	};
}

// ── Forme mécanique et « conflit probable » (décision porteuse n°4) ──

/**
 * Ordre d'évaluation STRICT : la première branche qui matche gagne.
 *
 * `alternating` passe avant tout le reste : si le meneur change, ni les parts ni les
 * positions ne sont stables, et le changement est le fait dominant.
 */
export function classifyShape(
	m: ConflictMetrics,
	t: CannibalizationThresholds
): ConflictShape {
	if (m.switches >= 1) return 'alternating';
	if (m.positionSpread >= t.maxPositionSpread) return 'stacked';
	if (m.dominance >= t.dominanceCeiling) return 'dominant';
	return 'split';
}

/**
 * PROBABLE = deux formes mécaniquement contestées, OU un fait de mauvais aiguillage
 * quelle que soit la forme.
 *
 * `misallocation` déborde la forme parce qu'une URL dominante qui ranke deux positions
 * sous sa voisine est un problème même sans alternance : Google a fait un choix, et
 * c'est le mauvais. C'est un FAIT mesuré, pas une interprétation — donc admissible dans
 * un détecteur déterministe (SPEC §3.3).
 */
export function isProbableConflict(
	shape: ConflictShape,
	m: ConflictMetrics,
	t: CannibalizationThresholds
): boolean {
	if (shape === 'alternating' || shape === 'split') return true;
	return m.misallocation >= t.minMisallocation;
}

// ── Passe pure ──────────────────────────────────────────────────────

export interface CannibalizationSelection {
	/** Les unités écrites, triées, tronquées à `maxCandidates`. */
	units: CannibalizationUnit[];
	/** TOUTES les unités retenues AVANT troncature — la closure FIND-003. */
	matched: CannibalizationUnit[];
	totalMatched: number;
	truncated: boolean;
}

export interface CannibalizationPassInput {
	/** Lignes de la fenêtre courante. Aucune fenêtre de comparaison (décision n°1 du plan). */
	rows: ObservationRow[];
	/** Semaines RÉELLEMENT présentes dans la fenêtre, triées croissant. */
	windowWeeks: string[];
	thresholds: CannibalizationThresholds;
}

export interface CannibalizationPassResult {
	selection: CannibalizationSelection;
	/**
	 * PORTÉE de la réconciliation : requêtes présentes dans la fenêtre ET au-dessus du
	 * plancher de volume — c'est-à-dire MESURABLES. Calculée avant le gate de
	 * significativité, sinon une requête revenue à une seule URL (la guérison même)
	 * sortirait de la portée et ne pourrait jamais résoudre son finding.
	 */
	measurableQueries: Set<string>;
	/** Requêtes n'ayant jamais eu 2 URLs significatives — le cas normal. */
	singleUrl: number;
	/** Candidats écartés faute de volume de requête. */
	belowVolume: number;
	/** ⭐ Candidats écartés faute de PERSISTANCE — le gate dur de l'acceptation. */
	belowPersistence: number;
	/** Dont ceux qui n'ont JAMAIS chevauché : des remplacements, pas des conflits. */
	replacements: number;
	/** Conflits retenus dont la forme n'est pas probable (écrits, mais plafonnés `low`). */
	legitimate: number;
	/** URLs BRUTES repliées par la normalisation — la preuve que la règle sert. */
	urlVariantsCollapsed: number;
	/** Requêtes écartées par le bruit configuré. */
	excludedByNoise: number;
	/** Conflits à plus de `maxUrls` URLs : tripwire de normalisation, jamais silencieux. */
	suspiciousUrlCount: number;
	skippedReason: string | null;
}

/**
 * La passe complète : agrège, filtre, mesure, classe, trie, plafonne.
 *
 * Chaîne de gates, dans cet ordre (l'ordre compte : chaque compteur ne doit décrire
 * qu'une seule raison d'écarter) :
 *   bruit configuré → volume de la requête → significativité (≥ 2 URLs) → persistance.
 */
export function runCannibalizationPass(
	input: CannibalizationPassInput
): CannibalizationPassResult {
	const { rows, windowWeeks, thresholds } = input;

	const empty: CannibalizationSelection = {
		units: [],
		matched: [],
		totalMatched: 0,
		truncated: false
	};

	if (windowWeeks.length < Math.max(1, Math.floor(thresholds.minOverlapWeeks))) {
		return {
			selection: empty,
			measurableQueries: new Set(),
			singleUrl: 0,
			belowVolume: 0,
			belowPersistence: 0,
			replacements: 0,
			legitimate: 0,
			urlVariantsCollapsed: 0,
			excludedByNoise: 0,
			suspiciousUrlCount: 0,
			skippedReason:
				`fenêtre trop courte pour observer une persistance ` +
				`(${windowWeeks.length} semaine(s) < ${thresholds.minOverlapWeeks})`
		};
	}

	const byQuery = aggregateByQueryUrl(rows);

	const measurableQueries = new Set<string>();
	const matched: CannibalizationUnit[] = [];
	let singleUrl = 0;
	let belowVolume = 0;
	let belowPersistence = 0;
	let replacements = 0;
	let legitimate = 0;
	let urlVariantsCollapsed = 0;
	let excludedByNoise = 0;
	let suspiciousUrlCount = 0;

	for (const [query, urlMap] of byQuery) {
		if (isExcludedQuery(query, thresholds.excludeQueryPatterns)) {
			excludedByNoise += 1;
			continue;
		}

		const allUrls = [...urlMap.values()];
		urlVariantsCollapsed += allUrls.reduce((s, u) => s + Math.max(0, u.rawUrls.length - 1), 0);

		const queryImpressions = allUrls.reduce((s, u) => s + u.impressions, 0);

		// PORTÉE : mesurable = présente et au-dessus du plancher de volume. Une requête
		// sous le plancher n'est pas « guérie », elle est immesurable (décision n°6 du plan).
		const measurable = queryImpressions >= thresholds.minQueryImpressions;
		if (measurable) measurableQueries.add(query);

		const threshold = significanceThreshold(queryImpressions, thresholds);
		const significant = allUrls
			.filter((u) => u.impressions > 0 && u.impressions >= threshold)
			.sort((a, b) => (b.impressions !== a.impressions ? b.impressions - a.impressions : cmp(a.url, b.url)));

		if (significant.length < 2) {
			singleUrl += 1;
			continue;
		}
		if (!measurable) {
			belowVolume += 1;
			continue;
		}

		const overlap = overlapWeeksOf(significant, windowWeeks);
		if (overlap.length === 0) replacements += 1;
		if (overlap.length < Math.max(1, Math.floor(thresholds.minOverlapWeeks))) {
			belowPersistence += 1;
			continue;
		}

		const leaders = weekLeaders(significant, overlap);
		const metrics = computeConflictMetrics({
			significant,
			allUrls,
			queryImpressions,
			threshold,
			overlap,
			leaders,
			windowWeeks
		});
		const shape = classifyShape(metrics, thresholds);
		const probable = isProbableConflict(shape, metrics, thresholds);
		if (!probable) legitimate += 1;
		if (metrics.urlCount > thresholds.maxUrls) suspiciousUrlCount += 1;

		matched.push({
			query,
			urls: significant,
			marginalUrlCount: allUrls.length - significant.length,
			metrics,
			shape,
			probable,
			leaders
		});
	}

	return {
		selection: select(matched, thresholds),
		measurableQueries,
		singleUrl,
		belowVolume,
		belowPersistence,
		replacements,
		legitimate,
		urlVariantsCollapsed,
		excludedByNoise,
		suspiciousUrlCount,
		// Une fenêtre valide qui ne trouve rien n'est PAS un run sauté : c'est un run qui
		// a regardé et n'a rien vu. Confondre les deux ferait lire « rien à signaler » là
		// où personne n'a rien pu juger (règle DASH-002 portée jusqu'ici).
		skippedReason: null
	};
}

/**
 * Ordonne et plafonne.
 *
 * ⚠️ `probable` est la clé PRIMAIRE, et c'est délibéré : la forme mécanique ne gate pas
 * l'écriture (elle clignoterait, décision porteuse n°4), elle fait descendre les cas
 * faibles dans la pile. La troncature est REPORTÉE (`truncated`), jamais silencieuse, et
 * elle porte sur `units` seulement — `matched` reste la closure complète, donc rien ne
 * s'auto-résout du seul fait d'avoir été tronqué.
 */
function select(
	units: CannibalizationUnit[],
	thresholds: CannibalizationThresholds
): CannibalizationSelection {
	const matched = [...units].sort((a, b) => {
		if (a.probable !== b.probable) return a.probable ? -1 : 1;
		if (b.metrics.conflictClicks !== a.metrics.conflictClicks) {
			return b.metrics.conflictClicks - a.metrics.conflictClicks;
		}
		if (b.metrics.conflictImpressions !== a.metrics.conflictImpressions) {
			return b.metrics.conflictImpressions - a.metrics.conflictImpressions;
		}
		if (b.metrics.overlapWeeks !== a.metrics.overlapWeeks) {
			return b.metrics.overlapWeeks - a.metrics.overlapWeeks;
		}
		return cmp(unitKey(a), unitKey(b));
	});
	const cap = Math.max(0, Math.floor(thresholds.maxCandidates));
	return {
		units: matched.slice(0, cap),
		matched,
		totalMatched: matched.length,
		truncated: matched.length > cap
	};
}

// ── Scoring (barème §10.2) ──────────────────────────────────────────

export interface CannibalizationScore {
	impact: number;
	urgency: number;
	confidence: number;
	strategicFit: number;
	confidenceScore: number;
	confidenceCaveats: string[];
}

/** Qualification du signal par forme — entre dans la confiance, jamais dans l'impact. */
const SHAPE_QUALIFICATION: Record<ConflictShape, number> = {
	alternating: 1,
	split: 0.9,
	dominant: 0.6,
	stacked: 0.5
};

/**
 * Les 4 composantes du barème §10.2 (sommées par `computePriorityScore`, jamais
 * réimplémentées ici).
 *
 * ⚠️ L'impact se mesure en clics CONTESTÉS, jamais en impressions. « Beaucoup vue, peu
 * cliquée » est déjà le métier de `keyword_opportunity` (impressions + position
 * exploitable + écart de CTR) ; le doubler ici ferait remonter deux fois le même signal
 * dans l'inbox — la faute que FIND-006 a explicitement refusé de commettre.
 *
 * Le facteur `(1 − dominance)` est la moitié du raisonnement : un conflit dominé à 95 %
 * ne disperse presque rien, même sur une grosse requête. Conséquence assumée et mesurée :
 * une majorité des conflits de `barberconcept` n'ont AUCUN clic sur 4 semaines, donc
 * `impact = 0`. C'est correct — SPEC §10.5 : « aucune redirection n'est proposée sans
 * métriques des deux pages », et une page sans clic n'a pas de métrique à arbitrer.
 */
export function scoreCannibalization(
	unit: CannibalizationUnit,
	context: {
		thresholds: CannibalizationThresholds;
		completeness: WindowCompleteness;
		weeks: number;
	}
): CannibalizationScore {
	const { thresholds, completeness, weeks } = context;
	const m = unit.metrics;
	const caveats: string[] = [];

	const contestedPerWeek = (m.conflictClicks / Math.max(1, weeks)) * (1 - m.dominance);
	const impact = clampScore(
		(contestedPerWeek / 10) * PRIORITY_WEIGHTS.impact,
		0,
		PRIORITY_WEIGHTS.impact
	);

	// urgency — la MEILLEURE de tes pages, pas la dominante : un conflit en position 4
	// est urgent parce qu'un seul slot te sépare de la victoire, et que c'est précisément
	// la dispersion qui t'en empêche.
	const horizon = Math.max(1, thresholds.positionHorizon);
	const closeness =
		m.bestPosition > 0 ? Math.max(0, Math.min(1, (horizon - m.bestPosition) / horizon)) : 0;
	const misfactor = Math.max(0, Math.min(1, m.misallocation / 10));
	const urgency = clampScore(
		(0.7 * closeness + 0.3 * misfactor) * PRIORITY_WEIGHTS.urgency,
		0,
		PRIORITY_WEIGHTS.urgency
	);

	// confidence — couverture de fenêtre × persistance × qualification de la forme.
	if (completeness.caveats.length > 0) caveats.push(...completeness.caveats);
	const persistence = Math.max(0, Math.min(1, m.overlapWeeks / Math.max(1, weeks)));
	if (m.overlapWeeks < weeks) {
		caveats.push(`conflit observé sur ${m.overlapWeeks}/${weeks} semaines de la fenêtre`);
	}
	if (!m.currentlyOverlapping) {
		caveats.push('conflit absent de la dernière semaine collectée');
	}
	if (unit.shape === 'dominant') {
		caveats.push(
			`forme « dominant » : une URL capte ${Math.round(m.dominance * 100)} % du volume, ` +
				`la seconde peut être un écho légitime`
		);
	}
	if (unit.shape === 'stacked') {
		caveats.push(
			`forme « stacked » : ${m.positionSpread.toFixed(1)} positions d'écart, ` +
				`les URLs ne se disputent pas le même slot`
		);
	}
	if (m.queryImpressions < thresholds.lowVolumeImpressions) {
		caveats.push(`faible volume (${m.queryImpressions} impressions)`);
	}
	if (m.urlCount > thresholds.maxUrls) {
		caveats.push(
			`${m.urlCount} URLs significatives (> ${thresholds.maxUrls}) : ` +
				`requête navigationnelle ou normalisation à vérifier`
		);
	}
	if (m.rawUrlCount > m.observedUrlCount) {
		caveats.push(
			`${m.rawUrlCount - m.observedUrlCount} variante(s) d'URL repliée(s) ` +
				`par la règle ${URL_NORMALIZATION_RULE}`
		);
	}

	const confidence = clampScore(
		completeness.coverage * persistence * SHAPE_QUALIFICATION[unit.shape] * PRIORITY_WEIGHTS.confidence,
		0,
		PRIORITY_WEIGHTS.confidence
	);

	const hasClicks = m.conflictClicks > 0 ? 0.5 : 0;
	const volumeFit = Math.min(
		0.5,
		(m.queryImpressions / Math.max(1, thresholds.lowVolumeImpressions)) * 0.5
	);
	const strategicFit = clampScore(
		(hasClicks + volumeFit) * PRIORITY_WEIGHTS.strategicFit,
		0,
		PRIORITY_WEIGHTS.strategicFit
	);

	return {
		impact,
		urgency,
		confidence,
		strategicFit,
		confidenceScore: clampScore((confidence / PRIORITY_WEIGHTS.confidence) * 100),
		confidenceCaveats: caveats
	};
}

// ── Sévérité (plafonds FIND-002 + un plafond propre) ────────────────

/**
 * Traduit un score en sévérité, avec DEUX plafonds.
 *
 * ⭐ Le premier est propre à FIND-008 : une coexistence que la MACHINE ne sait pas
 * distinguer d'un conflit ne doit jamais devancer un conflit mesuré. §10.5 réserve le
 * verdict à l'agent ; le détecteur, lui, doute par défaut — d'où `!probable ⇒ low`,
 * quel que soit le score.
 *
 * Le second est le plafond commun FIND-002 : faible volume, confiance dégradée, ou
 * nombre d'URLs au-delà du tripwire ne dépassent jamais `medium`.
 */
export function deriveCannibalizationSeverity(input: {
	priorityScore: number;
	impressions: number;
	thresholds: CannibalizationThresholds;
	confidenceScore: number;
	probable: boolean;
	urlCount: number;
}): FindingSeverity {
	const base: FindingSeverity =
		input.priorityScore >= 80
			? 'critical'
			: input.priorityScore >= 60
				? 'high'
				: input.priorityScore >= 40
					? 'medium'
					: input.priorityScore >= 20
						? 'low'
						: 'info';

	if (!input.probable) return base === 'info' ? 'info' : 'low';

	const underpowered =
		input.impressions < input.thresholds.lowVolumeImpressions ||
		input.confidenceScore < 50 ||
		input.urlCount > input.thresholds.maxUrls;
	if (!underpowered) return base;
	return base === 'critical' || base === 'high' ? 'medium' : base;
}

// ── Preuves = POINTEURS (piège DATA-005) ────────────────────────────

/** Plafond d'URLs détaillées dans les preuves. */
export const MAX_EVIDENCE_CONFLICT_URLS = 10;
/**
 * Plafond de formes BRUTES par URL normalisée. À 4, un conflit à 10 URLs tient sous les
 * 32 Ko d'`assertBoundedPayload` même avec des URLs à ancre percent-encodée de 110
 * caractères. Ne pas relever sans re-mesurer.
 */
export const MAX_EVIDENCE_RAW_URLS = 4;

export interface CannibalizationEvidence {
	detector: string;
	/** Requête BRUTE. Aucune clé normalisée de requête nulle part (décision n°5). */
	query: string;
	/** ⭐ La règle de repli d'URL, pour que le regroupement soit REJOUABLE. */
	urlNormalization: string;
	shape: ConflictShape;
	probable: boolean;
	window: { start: string; end: string; weeks: number } | null;
	metrics: ConflictMetrics;
	/** « Les URLs, métriques […] sont visibles » — acceptation, mot pour mot. */
	urls: {
		url: string;
		rawUrls: string[];
		rawUrlCount: number;
		clicks: number;
		impressions: number;
		ctr: number;
		position: number;
		/** Part des impressions du CONFLIT (dénominateur S(q)). */
		share: number;
		weeksSeen: number;
		/** La série hebdo : c'est elle qui rend dominance et alternance VÉRIFIABLES. */
		weekly: { week: string; impressions: number }[];
	}[];
	urlCount: number;
	marginalUrlCount: number;
	/** Ensemble d'URLs en conflit — graine d'un dédoublonnage futur (décision n°5). */
	urlSetKey: string;
	/** ⭐ « … et les alternances » — l'acceptation, rendue lisible semaine par semaine. */
	leaders: WeekLeader[];
	observationIds: string[];
	observationCount: number;
	scoreBreakdown: { impact: number; urgency: number; confidence: number; strategicFit: number };
	confidenceCaveats: string[];
}

export function buildCannibalizationEvidence(input: {
	unit: CannibalizationUnit;
	score: CannibalizationScore;
	window: CannibalizationEvidence['window'];
}): CannibalizationEvidence {
	const { unit, score, window } = input;
	const m = unit.metrics;

	const allIds = unit.urls.flatMap((u) => u.observationIds).sort(cmp);

	return {
		detector: DETECTOR_CANNIBALIZATION,
		query: unit.query,
		urlNormalization: URL_NORMALIZATION_RULE,
		shape: unit.shape,
		probable: unit.probable,
		window,
		metrics: m,
		urls: unit.urls.slice(0, MAX_EVIDENCE_CONFLICT_URLS).map((u) => ({
			url: u.url,
			rawUrls: u.rawUrls.slice(0, MAX_EVIDENCE_RAW_URLS),
			rawUrlCount: u.rawUrls.length,
			clicks: u.clicks,
			impressions: u.impressions,
			ctr: u.ctr,
			position: u.position,
			share: m.conflictImpressions > 0 ? u.impressions / m.conflictImpressions : 0,
			weeksSeen: u.weeksSeen,
			weekly: [...u.weekly.entries()]
				.sort((a, b) => cmp(a[0], b[0]))
				.map(([week, impressions]) => ({ week, impressions }))
		})),
		urlCount: unit.urls.length,
		marginalUrlCount: unit.marginalUrlCount,
		urlSetKey: urlSetKey(unit.urls),
		leaders: unit.leaders,
		observationIds: allIds.slice(0, MAX_EVIDENCE_IDS),
		observationCount: allIds.length,
		scoreBreakdown: {
			impact: score.impact,
			urgency: score.urgency,
			confidence: score.confidence,
			strategicFit: score.strategicFit
		},
		confidenceCaveats: score.confidenceCaveats
	};
}

// ── Titre et raison lisibles ────────────────────────────────────────

/**
 * Titre STABLE : aucune date dedans (il est réécrit à chaque re-détection, une date
 * ferait « bouger » un finding qui n'a pas changé de nature). La requête est le terme
 * BRUT ; les URLs affichées sont les NORMALISÉES, parce que c'est sur elles que le
 * conflit se mesure — les formes brutes vivent dans les preuves.
 */
export function buildCannibalizationTitle(unit: CannibalizationUnit): string {
	const m = unit.metrics;
	const dominance = `${Math.round(m.dominance * 100)} %`;
	const shape =
		m.switches > 0
			? `alternance sur ${m.overlapWeeks} semaine(s), ${m.switches} bascule(s)`
			: `chevauchement sur ${m.overlapWeeks} semaine(s)`;
	return `Cannibalisation "${unit.query}" — ${m.urlCount} URLs, dominance ${dominance}, ${shape}`;
}

/** Cause lisible, journalisée dans `finding_events.reason`. */
export function buildCannibalizationReason(
	unit: CannibalizationUnit,
	thresholds: CannibalizationThresholds
): string {
	const m = unit.metrics;
	const parts: string[] = [];

	parts.push(
		`${m.urlCount} URLs significatives (seuil effectif ${round1(m.significanceThreshold)} impressions ` +
			`= max(${thresholds.minUrlImpressions}, ${Math.round(thresholds.relativeShare * 100)} % × ${m.queryImpressions}))`
	);
	parts.push(
		`chevauchement sur ${m.overlapWeeks} semaine(s) ≥ persistance minimale ${thresholds.minOverlapWeeks}`
	);
	if (m.switches > 0) {
		const first = unit.leaders[0]?.url ?? '';
		const last = unit.leaders[unit.leaders.length - 1]?.url ?? '';
		parts.push(`l'URL dominante a changé ${m.switches} fois (${first} ↔ ${last})`);
	} else {
		parts.push(`l'URL dominante n'a jamais changé`);
	}
	parts.push(`dominance ${Math.round(m.dominance * 100)} %`);
	if (m.misallocation > 0) {
		parts.push(
			`la page mise en avant ranke ${round1(m.misallocation)} positions sous la meilleure`
		);
	}
	if (m.rawUrlCount > m.observedUrlCount) {
		parts.push(
			`${m.rawUrlCount - m.observedUrlCount} variante(s) d'URL repliée(s) (${URL_NORMALIZATION_RULE})`
		);
	}

	const verdict = unit.probable ? 'conflit probable' : 'coexistence : forme non contestée';
	return `${parts.join(', ')} — forme mécanique « ${unit.shape} », ${verdict}`;
}

// ── Utilitaires ─────────────────────────────────────────────────────

function round1(v: number): number {
	return Math.round(v * 10) / 10;
}

function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
