/**
 * FIND-006 — Détecteur `new_query` / `lost_query` : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), comme `detector-state.ts`,
 * `keyword-decline-state.ts` et `index-transition-state.ts`. `query-turnover.ts` lit
 * la base et écrit ; ici, rien qui touche le monde extérieur → testable par vitest.
 *
 * Ce détecteur ramasse ce que FIND-005 a explicitement REFUSÉ de traiter : les couples
 * `vanished` (107 cas réels sur `lecureux`), écartés là-bas parce qu'une disparition
 * n'est pas une baisse — c'est un signal d'un autre type, avec ses propres garde-fous
 * de volume. Il les traite ici, plus les apparitions symétriques.
 *
 * ── Les cinq décisions porteuses ──────────────────────────────────────────────
 *
 * 1. **⭐ Le regroupement de variantes n'est pas un confort d'affichage : il empêche
 *    deux faux signaux SYMÉTRIQUES.** Google réordonne et réécrit les requêtes ;
 *    « coiffeur genève » et « genève coiffeur » sont la même demande. Sans
 *    regroupement, la seconde apparaîtrait comme une DÉCOUVERTE le jour où la
 *    première devient une PERTE — deux findings, deux fois faux, pour un événement
 *    qui n'a pas eu lieu. D'où la règle des deux côtés :
 *      - un groupe n'est `new` que si **TOUS** ses membres sont neufs (sinon la
 *        « nouveauté » n'est qu'une orthographe d'une requête déjà connue) ;
 *      - un groupe n'est `lost` que si **TOUS** ses membres ont disparu (sinon la
 *        « perte » n'est qu'un déplacement d'orthographe).
 *    Les deux cas sont COMPTÉS (`variantOfKnown`, `variantSurvived`), jamais tus.
 *    La normalisation (accents, casse, ponctuation, ordre des mots) est
 *    volontairement pauvre : aucun stemming, aucune synonymie — deux termes ne se
 *    rejoignent que s'ils portent exactement les mêmes mots. Et elle ne sert JAMAIS
 *    à l'affichage : les preuves portent chaque terme brut (« réversible et
 *    inspectable », acceptation FIND-006).
 *
 * 2. **« Nouvelle » se juge sur TOUT l'historique, pas sur la fenêtre précédente.**
 *    Une requête vue il y a six mois et revenue n'est pas une découverte, c'est un
 *    retour. La fenêtre précédente seule la déclarerait neuve. `firstSeen` vient donc
 *    d'un agrégat sur toutes les observations du projet — celui-là même qui porte la
 *    « première/dernière apparition » exigée par l'acceptation. Corollaire : sur un
 *    projet dont l'historique ne remplit pas deux fenêtres, RIEN n'est nouveau (gate
 *    `comparable`) — sans quoi le corpus entier serait « découvert » le jour où la
 *    collecte démarre.
 *
 * 3. **Le volume se mesure sur le GROUPE, et du bon côté de la fenêtre.** Une
 *    nouveauté se juge sur ce qu'elle pèse MAINTENANT ; une perte sur ce qu'elle
 *    pesait AVANT (on ne perd que ce qu'on avait — même raisonnement que
 *    `minPriorImpressions` dans FIND-005, et la même valeur, parce que c'est la même
 *    fenêtre). Le gate passe APRÈS le regroupement : trois variantes à 20 impressions
 *    sont un signal à 60, pas trois signaux sous le seuil.
 *
 * 4. **La croissance répétée est une porte d'entrée, pas une dispense de plancher.**
 *    Le ticket dit « volume minimal OU croissance répétée ». Une requête vue deux
 *    semaines et qui monte entre alors même qu'elle n'atteint pas le seuil de volume
 *    — mais un plancher subsiste, et il est là pour l'acceptation littérale :
 *    « une requête à une impression ne pollue pas le rapport par défaut ». Un
 *    candidat entré par cette porte est `emerging` et **plafonné à `medium`**, comme
 *    une baisse vue sur une seule semaine (FIND-005) ou une fluctuation isolée
 *    (IDX-005).
 *
 * 5. **Une perte dont la page n'est plus indexable n'est pas un finding de requête.**
 *    C'est la colonne « Confirmation » de SPEC §10.4 (`page toujours indexable`), et
 *    c'est aussi une garde anti-doublon : IDX-005 possède déjà ce problème
 *    (`index_drop`), et deux vues du même incident dans l'inbox valent moins qu'une.
 *    Attention au sens de la garde : seul un `not_indexed`/`excluded` EXPLICITE
 *    supprime. `unknown` — le cas de tous les projets jamais inspectés — ne bloque
 *    rien, il fait BAISSER la confiance et change le skill recommandé (aller vérifier
 *    l'indexation devient le premier geste). Exiger la preuve d'indexabilité rendrait
 *    le détecteur inerte sur tout le parc.
 */
import { isExcludedQuery, MAX_EVIDENCE_IDS, type ObservationRow } from '../detector-state.js';
import { clampScore, PRIORITY_WEIGHTS, type FindingSeverity } from '../finding-state.js';
import type { WindowCompleteness } from '../gsc-windows-state.js';

// ── Identité du détecteur ───────────────────────────────────────────

/**
 * Version stockée dans `findings.detector_version`. À incrémenter dès que la
 * sélection ou le scoring change (acceptation FIND-001 : deux versions restent
 * comparables sur un même jeu d'observations).
 *
 * UNE version pour DEUX types de findings : les deux sortent de la même passe, sur
 * les mêmes fenêtres, avec la même normalisation. Les versionner séparément
 * laisserait croire qu'on peut faire évoluer l'un sans l'autre.
 */
export const DETECTOR_QUERY_TURNOVER = 'query_turnover@1';

/** Types de finding produits (catalogue §10.4 — déjà au vocabulaire `FINDING_TYPES`). */
export const NEW_QUERY_TYPE = 'new_query';
export const LOST_QUERY_TYPE = 'lost_query';

/**
 * Skill recommandé pour une découverte : §10.4 dit « analyse/gatekeeper ». Une
 * requête neuve ne se corrige pas, elle se QUALIFIE (intention, valeur commerciale,
 * page cible) — c'est le rôle du gatekeeper, et c'est le « router vers analyse
 * d'intention » du ticket.
 */
export const NEW_QUERY_SKILL = 'seo-gatekeeper';

/**
 * Skill recommandé pour une perte : §10.4 dit « diagnostic page ». Lequel dépend de
 * ce qu'on sait déjà de la page — et c'est déterministe, pas un choix d'humeur :
 * tant que l'indexation n'a jamais été inspectée, le premier geste est de vérifier
 * qu'elle est encore indexable (la confirmation que le détecteur, lui, n'a PAS pu
 * faire) ; une fois la page connue indexée, la cause est ailleurs et c'est un refresh.
 */
export const LOST_QUERY_SKILL_UNVERIFIED = 'seo-index-diagnose';
export const LOST_QUERY_SKILL_INDEXED = 'seo-refresh';

// ── Seuils (configurables par projet) ───────────────────────────────

export interface TurnoverThresholds {
	/** Impressions minimales du GROUPE sur la fenêtre courante pour qu'il soit une découverte. */
	minNewImpressions: number;
	/**
	 * Plancher de la porte « croissance répétée ». Plus bas que `minNewImpressions`,
	 * jamais nul : c'est lui qui tient l'acceptation « une requête à une impression ne
	 * pollue pas le rapport par défaut ».
	 */
	minGrowthImpressions: number;
	/** Semaines distinctes exigées pour parler de croissance (une seule ne montre rien). */
	minGrowthWeeks: number;
	/**
	 * Impressions minimales du GROUPE sur la fenêtre PRÉCÉDENTE pour qu'une
	 * disparition soit une perte. Même valeur et même côté que `minPriorImpressions`
	 * de FIND-005 : on ne perd que ce qu'on avait, et c'est la même fenêtre.
	 */
	minLostImpressions: number;
	/**
	 * Semaines distinctes exigées avant la perte. Une requête vue une seule semaine
	 * puis disparue est du bruit de longue traîne, pas une perte.
	 */
	minLostWeeksSeen: number;
	/** Volume d'impressions sous lequel la sévérité est plafonnée (§10.3 / FIND-002). */
	lowVolumeImpressions: number;
	/** Nombre maximal de findings écrits par run, par projet et PAR TYPE. */
	maxCandidates: number;
	/** Bruit configuré à exclure (marque, navigationnel) — jamais deviné. */
	excludeQueryPatterns: string[];
}

/**
 * Défauts calibrés sur le parc réel (sites locaux à faible volume). `lecureux` :
 * 707 requêtes distinctes sur 68 semaines, 31 impressions hebdo au maximum sur la
 * dernière semaine, 87 requêtes disparues et 44 apparues entre deux fenêtres de
 * 4 semaines. Sans gate de volume, ce seul projet écrirait 131 findings par semaine
 * de pure longue traîne.
 */
export const TURNOVER_DEFAULTS: TurnoverThresholds = {
	minNewImpressions: 30,
	minGrowthImpressions: 10,
	minGrowthWeeks: 2,
	minLostImpressions: 50,
	minLostWeeksSeen: 2,
	lowVolumeImpressions: 100,
	maxCandidates: 50,
	excludeQueryPatterns: []
};

/**
 * Fusionne des overrides projet aux défauts. Même discipline que
 * `resolveThresholds`/`resolveDeclineThresholds` : toute valeur non finie ou négative
 * est ignorée silencieusement — un override corrompu ne doit jamais DÉSACTIVER un
 * seuil, ce qui produirait un flot de faux positifs au lieu d'une erreur visible.
 */
export function resolveTurnoverThresholds(
	overrides?: Partial<TurnoverThresholds> | null
): TurnoverThresholds {
	const out = { ...TURNOVER_DEFAULTS };
	if (!overrides) return out;
	for (const key of Object.keys(TURNOVER_DEFAULTS) as (keyof TurnoverThresholds)[]) {
		if (key === 'excludeQueryPatterns') continue;
		const v = overrides[key];
		if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
			(out[key] as number) = v;
		}
	}
	if (Array.isArray(overrides.excludeQueryPatterns)) {
		out.excludeQueryPatterns = overrides.excludeQueryPatterns
			.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
			.map((p) => p.trim().toLowerCase());
	}
	return out;
}

// ── Normalisation de variantes (décision porteuse n°1) ──────────────

/**
 * Clé de variante d'une requête : minuscules, accents dépliés, ponctuation réduite à
 * des espaces, mots TRIÉS puis rejoints.
 *
 * Délibérément pauvre. Pas de stemming, pas de pluriels, pas de synonymes : deux
 * requêtes ne se rejoignent que si elles portent exactement les mêmes mots. Une
 * normalisation plus ambitieuse fusionnerait des intentions distinctes (« coiffeur
 * homme » / « coiffeur femme » partagent un radical, pas une demande) — et le coût
 * d'une fusion abusive est bien pire que celui d'un groupe manqué : elle FABRIQUE une
 * perte ou une nouveauté qui n'existe pas.
 *
 * ⚠️ Cette clé ne s'affiche JAMAIS. Elle sert de fingerprint et de clé de groupe ;
 * les termes bruts vivent dans le titre et dans les preuves.
 */
export function normalizeQueryKey(query: string): string {
	return query
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.split(' ')
		.filter((t) => t.length > 0)
		.sort()
		.join(' ');
}

// ── Agrégation par requête (avec la série hebdo, pour la croissance) ──

/** Ce qu'une requête pèse sur une fenêtre. */
export interface QuerySide {
	clicks: number;
	impressions: number;
	ctr: number;
	/** Position moyenne PONDÉRÉE par les impressions (même règle que partout ailleurs). */
	position: number;
	/** Semaines distinctes où la requête apparaît dans la fenêtre. */
	weeksSeen: number;
	/** Impressions par semaine (clé = `period_start`) — base de la croissance répétée. */
	weekly: Map<string, number>;
	/** Pages sur lesquelles la requête est sortie, avec leurs impressions. */
	pages: Map<string, number>;
	observationIds: string[];
}

function emptySide(): QuerySide {
	return {
		clicks: 0,
		impressions: 0,
		ctr: 0,
		position: 0,
		weeksSeen: 0,
		weekly: new Map(),
		pages: new Map(),
		observationIds: []
	};
}

/**
 * Agrège les observations `query×page×device` d'une fenêtre PAR REQUÊTE.
 *
 * Volontairement plus grossier que `aggregateWindow` (query×page) : ici l'entité est
 * la requête. Une requête neuve qui sort sur deux pages est UNE découverte, pas deux
 * — et le jour où elle en sort sur trois, c'est de la cannibalisation (FIND-008), pas
 * une nouveauté supplémentaire. Les pages restent dans les preuves : elles routent le
 * diagnostic sans découper le signal.
 */
export function aggregateByQuery(rows: ObservationRow[]): Map<string, QuerySide> {
	const acc = new Map<string, { side: QuerySide; positionWeighted: number; weeks: Set<string> }>();

	for (const r of rows) {
		let entry = acc.get(r.query);
		if (!entry) {
			entry = { side: emptySide(), positionWeighted: 0, weeks: new Set() };
			acc.set(r.query, entry);
		}
		entry.side.clicks += r.clicks;
		entry.side.impressions += r.impressions;
		entry.positionWeighted += r.position * r.impressions;
		entry.weeks.add(r.periodStart);
		entry.side.weekly.set(r.periodStart, (entry.side.weekly.get(r.periodStart) ?? 0) + r.impressions);
		entry.side.pages.set(r.page, (entry.side.pages.get(r.page) ?? 0) + r.impressions);
		entry.side.observationIds.push(r.id);
	}

	const out = new Map<string, QuerySide>();
	for (const [query, entry] of acc) {
		const side = entry.side;
		side.weeksSeen = entry.weeks.size;
		side.ctr = side.impressions > 0 ? side.clicks / side.impressions : 0;
		side.position = side.impressions > 0 ? entry.positionWeighted / side.impressions : 0;
		side.observationIds = [...side.observationIds].sort();
		out.set(query, side);
	}
	return out;
}

/** Somme deux côtés (fusion des membres d'un groupe de variantes). */
function mergeSides(sides: QuerySide[]): QuerySide {
	const merged = emptySide();
	let positionWeighted = 0;
	const weeks = new Set<string>();
	for (const s of sides) {
		merged.clicks += s.clicks;
		merged.impressions += s.impressions;
		positionWeighted += s.position * s.impressions;
		for (const [week, imp] of s.weekly) {
			merged.weekly.set(week, (merged.weekly.get(week) ?? 0) + imp);
			weeks.add(week);
		}
		for (const [page, imp] of s.pages) {
			merged.pages.set(page, (merged.pages.get(page) ?? 0) + imp);
		}
		merged.observationIds.push(...s.observationIds);
	}
	merged.weeksSeen = weeks.size;
	merged.ctr = merged.impressions > 0 ? merged.clicks / merged.impressions : 0;
	merged.position = merged.impressions > 0 ? positionWeighted / merged.impressions : 0;
	merged.observationIds = [...new Set(merged.observationIds)].sort();
	return merged;
}

// ── Durée de vie d'une requête (première/dernière apparition) ────────

/**
 * Ce que l'historique COMPLET du projet dit d'une requête. C'est la seule source qui
 * puisse distinguer une découverte d'un retour, et c'est elle qui porte la
 * « première/dernière apparition » exigée par l'acceptation FIND-006.
 */
export interface QueryLifespan {
	query: string;
	/** `period_start` de la première semaine où la requête apparaît (YYYY-MM-DD). */
	firstSeen: string;
	/** `period_start` de la dernière semaine où elle apparaît. */
	lastSeen: string;
	/** Semaines distinctes où elle apparaît, sur tout l'historique. */
	weeksSeen: number;
}

// ── Classification (décision porteuse n°1 : tout le groupe, ou rien) ──

/** Comment un groupe est entré : par le volume, ou par la croissance répétée. */
export type NewConfirmation = 'established' | 'emerging';

/** Ce que l'on sait de l'indexation des pages d'une requête perdue. */
export type PageIndexation = 'indexed' | 'not_indexed' | 'unknown';

/** Un groupe de variantes candidat, avant les gates de volume. */
export interface VariantGroup {
	/** Clé normalisée — fingerprint et clé de groupe, JAMAIS affichée. */
	key: string;
	/** Les termes bruts du groupe, triés par impressions décroissantes. */
	members: { query: string; impressions: number; clicks: number; firstSeen: string; lastSeen: string }[];
	/** Le terme dominant : celui qui pèse le plus. C'est lui qui nomme le finding. */
	label: string;
	side: QuerySide;
	firstSeen: string;
	lastSeen: string;
}

function buildGroup(
	key: string,
	queries: string[],
	sides: Map<string, QuerySide>,
	lifespans: Map<string, QueryLifespan>
): VariantGroup {
	const members = queries
		.map((query) => {
			const side = sides.get(query) ?? emptySide();
			const life = lifespans.get(query);
			return {
				query,
				impressions: side.impressions,
				clicks: side.clicks,
				firstSeen: life?.firstSeen ?? '',
				lastSeen: life?.lastSeen ?? ''
			};
		})
		.sort((a, b) =>
			b.impressions !== a.impressions ? b.impressions - a.impressions : cmp(a.query, b.query)
		);

	const firstSeen = members.reduce(
		(min, m) => (m.firstSeen && (!min || m.firstSeen < min) ? m.firstSeen : min),
		''
	);
	const lastSeen = members.reduce((max, m) => (m.lastSeen > max ? m.lastSeen : max), '');

	return {
		key,
		members,
		label: members[0]?.query ?? key,
		side: mergeSides(queries.map((q) => sides.get(q) ?? emptySide())),
		firstSeen,
		lastSeen
	};
}

function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Croissance répétée : la requête est vue sur au moins `minGrowthWeeks` semaines de la
 * fenêtre, et la dernière pèse plus que la première.
 *
 * Volontairement grossier — début vs fin, pas une régression. Sur quatre points au
 * plus, une pente ajusterait du bruit et donnerait une fausse impression de rigueur.
 */
export function hasRepeatedGrowth(side: QuerySide, thresholds: TurnoverThresholds): boolean {
	const weeks = [...side.weekly.keys()].sort();
	if (weeks.length < Math.max(2, Math.floor(thresholds.minGrowthWeeks))) return false;
	const first = side.weekly.get(weeks[0]) ?? 0;
	const last = side.weekly.get(weeks[weeks.length - 1]) ?? 0;
	return last > first;
}

// ── Les deux unités écrivables ──────────────────────────────────────

export interface NewQueryUnit {
	kind: 'new';
	group: VariantGroup;
	confirmation: NewConfirmation;
}

export interface LostQueryUnit {
	kind: 'lost';
	group: VariantGroup;
	/** Ce que l'on sait de l'indexation des pages qui portaient la requête. */
	pageIndexation: PageIndexation;
}

export type TurnoverUnit = NewQueryUnit | LostQueryUnit;

/** Clé de tri stable et lisible (jamais un fingerprint : ce n'est pas une identité DB). */
export function unitKey(unit: TurnoverUnit): string {
	return `${unit.kind}:${unit.group.key}`;
}

// ── Passe complète (pure) ───────────────────────────────────────────

export interface TurnoverPassInput {
	/** Lignes d'observation de la fenêtre courante (vide si indisponible). */
	currentRows: ObservationRow[];
	/** Lignes d'observation de la fenêtre précédente. */
	priorRows: ObservationRow[];
	/** Vrai si les deux fenêtres couvrent le même nombre de semaines (GSC-004). */
	comparable: boolean;
	/** `period_start` de la fenêtre courante — la borne qui fait qu'une requête est neuve. */
	currentWindowStart: string;
	/** Durée de vie de CHAQUE requête du projet, sur tout l'historique. */
	lifespans: QueryLifespan[];
	/**
	 * Dernier état d'indexation connu, par URL de page. Une page absente de la carte
	 * est `unknown` — jamais `indexed` par défaut : « je n'ai pas regardé » ne se lit
	 * pas « tout va bien ».
	 */
	indexation: Map<string, PageIndexation>;
	thresholds: TurnoverThresholds;
}

export interface TurnoverSelection {
	/** Unités écrites, éventuellement tronquées à `maxCandidates`. */
	units: TurnoverUnit[];
	/** TOUTES les unités franchissant les gates, AVANT troncature — base de la closure FIND-003. */
	matched: TurnoverUnit[];
	totalMatched: number;
	truncated: boolean;
}

export interface TurnoverPassResult {
	newQueries: TurnoverSelection;
	lostQueries: TurnoverSelection;
	/**
	 * Groupes présents dans la fenêtre courante — la PORTÉE de la réconciliation des
	 * pertes (décision de lot). Un groupe absent d'ici n'a pas été observé revenir :
	 * son finding de perte doit rester INTACT, jamais auto-résolu.
	 */
	presentKeys: Set<string>;
	/** Groupes candidats à la nouveauté écartés parce qu'un membre était déjà connu. */
	variantOfKnown: number;
	/** Groupes candidats à la perte écartés parce qu'une variante survit. */
	variantSurvived: number;
	/** Requêtes apparues qui étaient déjà connues avant la fenêtre courante (retours). */
	returning: number;
	/** Groupes disparus dont la page n'est plus indexable : c'est `index_drop`, pas une perte de requête. */
	attributedToIndexing: number;
	/** Groupes disparus sous le gate de volume ou de persistance. */
	lostBelowThreshold: number;
	/** Groupes neufs sous les deux portes d'entrée. */
	newBelowThreshold: number;
	/** Requêtes écartées par le bruit configuré (marque, navigationnel). */
	excludedByNoise: number;
	/** Renseigné quand aucune détection n'était possible : jamais un résultat vide muet. */
	skippedReason: string | null;
}

function emptySelection(): TurnoverSelection {
	return { units: [], matched: [], totalMatched: 0, truncated: false };
}

/** Regroupe des requêtes par clé de variante, en préservant l'ordre déterministe. */
function groupKeys(queries: Iterable<string>): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const query of queries) {
		const key = normalizeQueryKey(query);
		if (key.length === 0) continue;
		const list = out.get(key);
		if (list) list.push(query);
		else out.set(key, [query]);
	}
	for (const list of out.values()) list.sort(cmp);
	return out;
}

/**
 * L'indexation d'un groupe, dérivée de celle de ses pages.
 *
 * `indexed` dès qu'UNE page est connue indexée (la requête aurait pu continuer d'y
 * sortir) ; `not_indexed` seulement si toutes les pages connues ne le sont plus ET
 * qu'au moins une l'est vraiment ; `unknown` sinon. L'asymétrie est voulue : la
 * suppression d'un finding demande une preuve, son maintien n'en demande pas.
 */
export function resolveGroupIndexation(
	pages: Iterable<string>,
	indexation: Map<string, PageIndexation>
): PageIndexation {
	let known = 0;
	let notIndexed = 0;
	for (const page of pages) {
		const state = indexation.get(page);
		if (!state || state === 'unknown') continue;
		known += 1;
		if (state === 'indexed') return 'indexed';
		notIndexed += 1;
	}
	return known > 0 && notIndexed === known ? 'not_indexed' : 'unknown';
}

/**
 * Enchaîne agrégation → regroupement de variantes → classification → gates → tri et
 * plafond, sans jamais toucher la base.
 *
 * Porte l'invariant d'acceptation le plus important, hérité de FIND-005 : **si les
 * deux fenêtres ne sont pas comparables, il ne sort RIEN**. Une fenêtre incomplète ne
 * produit pas une découverte à faible confiance ni une perte incertaine — elle ne
 * produit rien du tout, parce qu'une requête absente d'une semaine non collectée est
 * indiscernable d'une requête réellement disparue.
 */
export function runTurnoverPass(input: TurnoverPassInput): TurnoverPassResult {
	const { thresholds } = input;

	const base: TurnoverPassResult = {
		newQueries: emptySelection(),
		lostQueries: emptySelection(),
		presentKeys: new Set(),
		variantOfKnown: 0,
		variantSurvived: 0,
		returning: 0,
		attributedToIndexing: 0,
		lostBelowThreshold: 0,
		newBelowThreshold: 0,
		excludedByNoise: 0,
		skippedReason: null
	};

	if (!input.comparable) {
		return {
			...base,
			skippedReason:
				'aucune fenêtre comparable (historique insuffisant pour comparer deux périodes de même longueur)'
		};
	}

	const lifespans = new Map(input.lifespans.map((l) => [l.query, l]));
	const current = aggregateByQuery(input.currentRows);
	const prior = aggregateByQuery(input.priorRows);

	// Le bruit configuré sort AVANT tout : une requête de marque exclue ne doit ni
	// former un groupe, ni empêcher un groupe de se former.
	// Une requête présente des deux côtés ne compte qu'UNE fois : ce compteur dit
	// combien de requêtes le bruit configuré écarte, pas combien de fois il a filtré.
	const excluded = new Set<string>();
	const keep = (query: string): boolean => {
		if (isExcludedQuery(query, thresholds.excludeQueryPatterns)) {
			excluded.add(query);
			return false;
		}
		return true;
	};
	const currentQueries = [...current.keys()].filter(keep);
	const priorQueries = [...prior.keys()].filter(keep);

	const currentGroups = groupKeys(currentQueries);
	const priorGroups = groupKeys(priorQueries);
	const presentKeys = new Set(currentGroups.keys());

	// ── Découvertes ──────────────────────────────────────────────────
	const newMatched: TurnoverUnit[] = [];
	let variantOfKnown = 0;
	let returning = 0;
	let newBelowThreshold = 0;

	for (const [key, queries] of currentGroups) {
		// Décision porteuse n°2 : « neuve » se juge sur TOUT l'historique. Une requête
		// sans durée de vie connue est traitée comme neuve (elle n'existe nulle part
		// ailleurs que dans cette fenêtre).
		const isNew = (q: string): boolean => {
			const life = lifespans.get(q);
			return !life || life.firstSeen >= input.currentWindowStart;
		};
		const newCount = queries.filter(isNew).length;
		if (newCount === 0) {
			// Requête connue, absente de la fenêtre précédente, revenue : un RETOUR. Ce
			// n'est ni une découverte (elle a un passé) ni une perte (elle est là) — c'est
			// le troisième cas, et le taire ferait lire un portefeuille plus renouvelé
			// qu'il ne l'est.
			if (!priorGroups.has(key)) returning += 1;
			continue;
		}

		// Décision porteuse n°1 : tout le groupe, ou rien. Deux formes de la même erreur :
		// un membre déjà connu DANS la fenêtre courante, ou la même clé déjà vue dans la
		// fenêtre précédente sous une autre orthographe. Dans les deux cas la
		// « nouveauté » n'est qu'un mot réécrit par Google.
		if (newCount < queries.length || priorGroups.has(key)) {
			variantOfKnown += 1;
			continue;
		}

		const group = buildGroup(key, queries, current, lifespans);
		const confirmation = classifyNewGroup(group, thresholds);
		if (!confirmation) {
			newBelowThreshold += 1;
			continue;
		}
		newMatched.push({ kind: 'new', group, confirmation });
	}

	// ── Pertes ───────────────────────────────────────────────────────
	const lostMatched: TurnoverUnit[] = [];
	let variantSurvived = 0;
	let attributedToIndexing = 0;
	let lostBelowThreshold = 0;

	for (const [key, queries] of priorGroups) {
		if (presentKeys.has(key)) {
			// Au moins une variante du groupe est encore là : la requête n'est pas perdue,
			// son orthographe a bougé. Ne le compter que si des membres ont VRAIMENT disparu.
			const survivors = new Set(currentGroups.get(key) ?? []);
			if (queries.some((q) => !survivors.has(q))) variantSurvived += 1;
			continue;
		}

		const group = buildGroup(key, queries, prior, lifespans);

		if (
			group.side.impressions < thresholds.minLostImpressions ||
			group.side.weeksSeen < Math.max(1, Math.floor(thresholds.minLostWeeksSeen))
		) {
			lostBelowThreshold += 1;
			continue;
		}

		// Décision porteuse n°5 : une perte dont la page n'est plus indexable appartient
		// à IDX-005, pas ici.
		const pageIndexation = resolveGroupIndexation(group.side.pages.keys(), input.indexation);
		if (pageIndexation === 'not_indexed') {
			attributedToIndexing += 1;
			continue;
		}

		lostMatched.push({ kind: 'lost', group, pageIndexation });
	}

	return {
		newQueries: select(newMatched, thresholds),
		lostQueries: select(lostMatched, thresholds),
		presentKeys,
		variantOfKnown,
		variantSurvived,
		returning,
		attributedToIndexing,
		lostBelowThreshold,
		newBelowThreshold,
		excludedByNoise: excluded.size,
		// Deux fenêtres comparables qui ne trouvent rien ne sont PAS un run sauté :
		// c'est un run qui a regardé et n'a rien vu. Confondre les deux ferait lire
		// « rien à signaler » là où personne n'a rien pu juger.
		skippedReason: null
	};
}

/**
 * Les deux portes d'entrée d'une découverte (décisions porteuses n°3 et 4). Rend
 * `null` quand le groupe n'en franchit aucune.
 */
export function classifyNewGroup(
	group: VariantGroup,
	thresholds: TurnoverThresholds
): NewConfirmation | null {
	if (group.side.impressions >= thresholds.minNewImpressions) return 'established';
	if (
		group.side.impressions >= Math.max(1, thresholds.minGrowthImpressions) &&
		hasRepeatedGrowth(group.side, thresholds)
	) {
		return 'emerging';
	}
	return null;
}

/**
 * Ordonne et plafonne. Le tri est par clics (ce qui se gagne ou se perd VRAIMENT),
 * puis impressions, puis clé — ordre 100 % reproductible. La troncature est REPORTÉE,
 * jamais silencieuse.
 */
function select(units: TurnoverUnit[], thresholds: TurnoverThresholds): TurnoverSelection {
	const matched = [...units].sort((a, b) => {
		if (b.group.side.clicks !== a.group.side.clicks) return b.group.side.clicks - a.group.side.clicks;
		if (b.group.side.impressions !== a.group.side.impressions) {
			return b.group.side.impressions - a.group.side.impressions;
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

export interface TurnoverScore {
	impact: number;
	urgency: number;
	confidence: number;
	strategicFit: number;
	confidenceScore: number;
	confidenceCaveats: string[];
}

/** Position au-delà de laquelle une requête n'était de toute façon presque pas là. */
const POSITION_HORIZON = 50;

/**
 * Les 4 composantes du barème §10.2 (sommées par `computePriorityScore`, jamais
 * réimplémentées ici).
 *
 * ⚠️ L'impact d'une DÉCOUVERTE se mesure en clics, jamais en impressions — même quand
 * la requête en a beaucoup. Le potentiel d'une requête très vue et peu cliquée est
 * déjà le métier de `keyword_opportunity` (impressions + position exploitable + écart
 * de CTR) ; le doubler ici ferait remonter deux fois le même signal dans l'inbox. Une
 * découverte sans clic reste donc informative, et c'est exact.
 */
export function scoreTurnover(
	unit: TurnoverUnit,
	context: {
		thresholds: TurnoverThresholds;
		completeness: WindowCompleteness;
		weeks: number;
	}
): TurnoverScore {
	const { thresholds, completeness, weeks } = context;
	const side = unit.group.side;
	const caveats: string[] = [];

	const perWeek = side.clicks / Math.max(1, weeks);
	const impact = clampScore((perWeek / 10) * PRIORITY_WEIGHTS.impact, 0, PRIORITY_WEIGHTS.impact);

	// urgency — plus la requête sortait haut, plus l'événement compte : une découverte
	// déjà en page 1 est à sécuriser, une perte depuis la position 80 n'était presque
	// rien. Une position nulle (aucune impression) vaut 0, jamais le maximum.
	const closeness =
		side.position > 0
			? Math.max(0, Math.min(1, (POSITION_HORIZON - side.position) / POSITION_HORIZON))
			: 0;
	const urgency = clampScore(closeness * PRIORITY_WEIGHTS.urgency, 0, PRIORITY_WEIGHTS.urgency);

	// confidence — couverture de fenêtre × persistance × qualification du signal.
	if (completeness.caveats.length > 0) caveats.push(...completeness.caveats);
	const persistence = Math.max(0, Math.min(1, side.weeksSeen / Math.max(1, weeks)));
	if (side.weeksSeen < weeks) {
		caveats.push(`vu ${side.weeksSeen}/${weeks} semaines de la fenêtre`);
	}

	let qualification = 1;
	if (unit.kind === 'new' && unit.confirmation === 'emerging') {
		qualification = 0.6;
		caveats.push('entrée par la croissance répétée, pas par le volume : à confirmer');
	}
	if (unit.kind === 'lost' && unit.pageIndexation === 'unknown') {
		qualification = 0.8;
		caveats.push('indexation de la page jamais inspectée : la perte n’est pas confirmée par §10.4');
	}
	if (side.impressions < thresholds.lowVolumeImpressions) {
		caveats.push(`faible volume (${side.impressions} impressions)`);
	}
	if (unit.group.members.length > 1) {
		caveats.push(`${unit.group.members.length} variantes regroupées sous une même demande`);
	}

	const confidence = clampScore(
		completeness.coverage * persistence * qualification * PRIORITY_WEIGHTS.confidence,
		0,
		PRIORITY_WEIGHTS.confidence
	);

	const hasClicks = side.clicks > 0 ? 0.5 : 0;
	const volumeFit = Math.min(
		0.5,
		(side.impressions / Math.max(1, thresholds.lowVolumeImpressions)) * 0.5
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

// ── Sévérité (plafonds FIND-002) ────────────────────────────────────

/**
 * Traduit un score en sévérité, avec les mêmes plafonds que partout ailleurs :
 * faible volume ou confiance dégradée ne dépassent jamais `medium`, et une découverte
 * `emerging` non plus — quelle que soit son ampleur, deux semaines de croissance
 * peuvent être un pic d'actualité. La semaine suivante tranche.
 */
export function deriveTurnoverSeverity(input: {
	priorityScore: number;
	impressions: number;
	thresholds: TurnoverThresholds;
	confidenceScore: number;
	emerging: boolean;
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

	const underpowered =
		input.impressions < input.thresholds.lowVolumeImpressions ||
		input.confidenceScore < 50 ||
		input.emerging;
	if (!underpowered) return base;
	return base === 'critical' || base === 'high' ? 'medium' : base;
}

// ── Preuves = POINTEURS (piège DATA-005) ────────────────────────────

/** Plafond de variantes et de pages détaillées : les preuves restent bornées. */
export const MAX_EVIDENCE_VARIANTS = 25;
export const MAX_EVIDENCE_PAGES = 10;

export interface TurnoverEvidence {
	detector: string;
	kind: 'new' | 'lost';
	/**
	 * La clé de variante. Présente pour que le regroupement soit INSPECTABLE : on peut
	 * rejouer `normalizeQueryKey` sur n'importe quel terme et retrouver ce groupe.
	 */
	variantKey: string;
	confirmation: NewConfirmation | null;
	pageIndexation: PageIndexation | null;
	window: { current: { start: string; end: string; weeks: number } | null; prior: { start: string; end: string; weeks: number } | null };
	/** Première et dernière apparition du GROUPE, sur tout l'historique (acceptation FIND-006). */
	firstSeen: string;
	lastSeen: string;
	metrics: {
		clicks: number;
		impressions: number;
		ctr: number;
		position: number;
		weeksSeen: number;
		/** Impressions par semaine, triées — c'est ce qui rend la croissance vérifiable. */
		weekly: { week: string; impressions: number }[];
	};
	/** Chaque terme BRUT du groupe, avec sa propre durée de vie : le regroupement est réversible. */
	variants: { query: string; impressions: number; clicks: number; firstSeen: string; lastSeen: string }[];
	variantCount: number;
	pages: { page: string; impressions: number; indexation: PageIndexation }[];
	pageCount: number;
	observationIds: string[];
	observationCount: number;
	scoreBreakdown: { impact: number; urgency: number; confidence: number; strategicFit: number };
	confidenceCaveats: string[];
}

export function buildTurnoverEvidence(input: {
	unit: TurnoverUnit;
	score: TurnoverScore;
	window: TurnoverEvidence['window'];
	indexation: Map<string, PageIndexation>;
}): TurnoverEvidence {
	const { unit, score, window, indexation } = input;
	const side = unit.group.side;

	return {
		detector: DETECTOR_QUERY_TURNOVER,
		kind: unit.kind,
		variantKey: unit.group.key,
		confirmation: unit.kind === 'new' ? unit.confirmation : null,
		pageIndexation: unit.kind === 'lost' ? unit.pageIndexation : null,
		window,
		firstSeen: unit.group.firstSeen,
		lastSeen: unit.group.lastSeen,
		metrics: {
			clicks: side.clicks,
			impressions: side.impressions,
			ctr: side.ctr,
			position: side.position,
			weeksSeen: side.weeksSeen,
			weekly: [...side.weekly.entries()]
				.sort((a, b) => cmp(a[0], b[0]))
				.map(([week, impressions]) => ({ week, impressions }))
		},
		variants: unit.group.members.slice(0, MAX_EVIDENCE_VARIANTS),
		variantCount: unit.group.members.length,
		pages: [...side.pages.entries()]
			.sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : cmp(a[0], b[0])))
			.slice(0, MAX_EVIDENCE_PAGES)
			.map(([page, impressions]) => ({
				page,
				impressions,
				indexation: indexation.get(page) ?? 'unknown'
			})),
		pageCount: side.pages.size,
		observationIds: side.observationIds.slice(0, MAX_EVIDENCE_IDS),
		observationCount: side.observationIds.length,
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
 * ferait « bouger » un finding qui n'a pas changé de nature). Le terme affiché est
 * TOUJOURS le terme brut dominant, jamais la clé normalisée — « masquer les termes »
 * est exactement ce que l'acceptation interdit.
 */
export function buildTurnoverTitle(unit: TurnoverUnit): string {
	const side = unit.group.side;
	const extra = unit.group.members.length > 1 ? ` (+${unit.group.members.length - 1} variantes)` : '';
	if (unit.kind === 'new') {
		const qualifier = unit.confirmation === 'emerging' ? 'en croissance' : 'nouvelle';
		return `Requête ${qualifier} "${unit.group.label}"${extra} — ${side.impressions} impressions, ${side.clicks} clics`;
	}
	return `Requête perdue "${unit.group.label}"${extra} — ${side.impressions} impressions et ${side.clicks} clics disparus`;
}

/** Cause lisible, journalisée dans `finding_events.reason`. */
export function buildTurnoverReason(unit: TurnoverUnit, thresholds: TurnoverThresholds): string {
	const side = unit.group.side;
	const group =
		unit.group.members.length > 1
			? `${unit.group.members.length} variantes regroupées (${unit.group.members.map((m) => `"${m.query}"`).join(', ')})`
			: 'terme unique';

	if (unit.kind === 'new') {
		const gate =
			unit.confirmation === 'established'
				? `${side.impressions} impressions ≥ seuil ${thresholds.minNewImpressions}`
				: `croissance sur ${side.weeksSeen} semaines avec ${side.impressions} impressions ≥ plancher ${thresholds.minGrowthImpressions}`;
		return `absente de tout l'historique avant la fenêtre courante — ${gate} — ${group}`;
	}

	const indexation =
		unit.pageIndexation === 'indexed'
			? 'page toujours indexée'
			: 'indexation de la page inconnue (jamais inspectée)';
	return (
		`présente sur ${side.weeksSeen} semaines de la fenêtre précédente ` +
		`(${side.impressions} impressions ≥ seuil ${thresholds.minLostImpressions}, ${side.clicks} clics), ` +
		`absente de la fenêtre courante — ${indexation} — ${group}`
	);
}

/** Le skill recommandé d'une perte dépend de ce qu'on sait de la page (déterministe). */
export function lostQuerySkill(pageIndexation: PageIndexation): string {
	return pageIndexation === 'indexed' ? LOST_QUERY_SKILL_INDEXED : LOST_QUERY_SKILL_UNVERIFIED;
}
