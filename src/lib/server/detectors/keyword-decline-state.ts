/**
 * FIND-005 — Détecteur de baisses `keyword_decline` : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), dans la lignée de `detector-state.ts`,
 * `index-transition-state.ts` et `gsc-windows-state.ts`. `keyword-decline.ts` lit la
 * base et exécute ; ici, rien qui touche le monde extérieur → testable par vitest.
 *
 * Ce détecteur est le premier CONSOMMATEUR des fenêtres de comparaison de GSC-004 :
 * jusqu'ici, `buildWindowComparison`/`computeWindowDelta` n'alimentaient qu'un écran.
 *
 * ── Les quatre décisions porteuses ────────────────────────────────────────────
 *
 * 1. **On ne compare QUE les couples présents dans les DEUX fenêtres.** Un couple
 *    query×page qui a disparu est indiscernable d'un couple dont la semaine n'a pas
 *    été collectée : le traiter comme « −100 % de clics » fabriquerait une baisse à
 *    partir d'un trou de collecte, exactement ce que l'acceptation FIND-005 interdit
 *    (« une collecte partielle ne crée pas de baisse »). Une disparition est un
 *    signal RÉEL mais d'un autre type (`lost_query`, FIND-006) avec ses propres
 *    garde-fous de volume. Ici elle est COMPTÉE et annoncée (`vanished`), jamais
 *    convertie en finding. C'est aussi ce qui répond à « distinguer baisse réelle et
 *    changement de périmètre » : un périmètre qui rétrécit sort du calcul.
 *
 * 2. **Deux fenêtres, et l'écart entre elles EST le niveau de confirmation.** Le
 *    ticket demande « 7 et 28 jours » ; les faire cohabiter sans les hiérarchiser
 *    produirait deux findings pour une seule baisse. Sur le canon hebdomadaire,
 *    28 j = 4 semaines (structurel) et 7 j = 1 semaine (récent) :
 *      - `confirmed` — les deux fenêtres tombent : la baisse est installée ET elle
 *        continue de se creuser d'une semaine sur l'autre ;
 *      - `sustained` — seul le 4 semaines tombe. La dernière semaine n'ajoute AUCUNE
 *        chute nouvelle, ce qui recouvre deux situations qu'on ne peut pas départager
 *        sans regarder plus loin : le niveau bas est devenu le nouveau normal, ou la
 *        semaine est déjà remontée. Dans les deux cas la perte face au mois précédent
 *        est réelle — d'où un finding, mais dont la confiance ne prétend pas trancher ;
 *      - `emerging`  — seul le 1 semaine tombe : une seule semaine ne prouve rien,
 *        c'est peut-être du bruit. Écrit quand même (l'ignorer retarderait d'un mois
 *        la détection d'un vrai décrochage) mais **plafonné à `medium`**, comme
 *        IDX-005 plafonne une fluctuation isolée. La 2ᵉ semaine le confirme ou l'efface.
 *
 * 3. **Une page qui décroche sur N requêtes est UN problème, pas N.** Sans
 *    regroupement, une page désindexée ou dépubliée remplirait à elle seule le
 *    plafond `maxCandidates` de findings qui disent tous la même chose. Le
 *    regroupement n'est PAS un simple `count >= seuil` : le total de la page doit
 *    lui-même baisser, calculé sur **tous** ses couples appariés — sinon une page
 *    dont 3 requêtes baissent et 12 montent serait signalée comme en perte.
 *    Il est « réversible et inspectable » : les preuves portent le delta de chaque
 *    requête du groupe.
 *
 * 4. **La position se lit à l'envers de tout le reste.** Une position GSC qui MONTE
 *    est une dégradation. `positionAbs` est donc `current − prior`, positif = pire,
 *    et c'est écrit partout où le chiffre circule — un signe inversé ici
 *    transformerait chaque remontée au classement en alerte.
 */
import {
	aggregateWindow,
	isExcludedQuery,
	MAX_EVIDENCE_IDS,
	type AggregatedPair,
	type ObservationRow,
	type ObservationWindow
} from '../detector-state.js';
import {
	clampScore,
	PRIORITY_WEIGHTS,
	type FindingSeverity
} from '../finding-state.js';
import { spanToWeeks, type WindowCompleteness, type WindowSpan } from '../gsc-windows-state.js';

// ── Identité du détecteur ───────────────────────────────────────────

/**
 * Version stockée dans `findings.detector_version`. À incrémenter dès que la
 * sélection ou le scoring change (acceptation FIND-001 : deux versions restent
 * comparables sur un même jeu d'observations).
 */
export const DETECTOR_KEYWORD_DECLINE = 'keyword_decline@1';

/** Type de finding produit (catalogue §10.4 — déjà au vocabulaire `FINDING_TYPES`). */
export const KEYWORD_DECLINE_TYPE = 'keyword_decline';

/**
 * Skill recommandé. `seo-refresh` diagnostique un contenu qui décroche à partir de
 * ses propres données GSC — c'est la suite naturelle d'une baisse mesurée. Le
 * producteur AGT-000 n'en fait AUCUNE proposition aujourd'hui (il ne traite que
 * `keyword_opportunity`) : une baisse se diagnostique avant de se corriger, donc
 * elle atterrit dans l'onglet findings, pas dans la file d'approbation.
 */
export const KEYWORD_DECLINE_SKILL = 'seo-refresh';

/** Fenêtre structurelle (4 semaines) et fenêtre récente (1 semaine). */
export const PRIMARY_SPAN: WindowSpan = 28;
export const RECENT_SPAN: WindowSpan = 7;

// ── Seuils (configurables par projet) ───────────────────────────────

export interface DeclineThresholds {
	/**
	 * Impressions minimales sur la fenêtre PRÉCÉDENTE. On ne peut perdre que ce
	 * qu'on avait : mesurer le seuil sur la fenêtre courante disqualifierait
	 * précisément les pires baisses (celles tombées à presque rien).
	 */
	minPriorImpressions: number;
	/** Baisse relative de clics à partir de laquelle on signale (%). */
	minClicksDropPct: number;
	/**
	 * Baisse ABSOLUE de clics exigée en plus du pourcentage. Sans elle, 3 clics
	 * tombés à 2 (−33 %) vaudrait autant que 300 tombés à 200.
	 */
	minClicksDropAbs: number;
	/** Baisse relative d'impressions à partir de laquelle on signale (%). */
	minImpressionsDropPct: number;
	/** Dégradation de position (en rangs) à partir de laquelle on signale. */
	minPositionDrop: number;
	/** Volume d'impressions sous lequel la sévérité est plafonnée (§10.3 / FIND-002). */
	lowVolumeImpressions: number;
	/** Nombre maximal de findings écrits par run et par projet. */
	maxCandidates: number;
	/** Nombre de requêtes en baisse sur une même page à partir duquel on regroupe. */
	pageGroupMinQueries: number;
	/** Bruit configuré à exclure (marque, navigationnel) — jamais deviné. */
	excludeQueryPatterns: string[];
}

/**
 * Défauts calibrés pour des sites locaux à faible volume, comme
 * `OPPORTUNITY_DEFAULTS` : `minPriorImpressions = 50` sur 4 semaines reste
 * atteignable par un petit site, et `minClicksDropAbs = 3` empêche le bruit des
 * très petits nombres de remplir l'inbox.
 */
export const DECLINE_DEFAULTS: DeclineThresholds = {
	minPriorImpressions: 50,
	minClicksDropPct: 30,
	minClicksDropAbs: 3,
	minImpressionsDropPct: 40,
	minPositionDrop: 3,
	lowVolumeImpressions: 100,
	maxCandidates: 50,
	pageGroupMinQueries: 3,
	excludeQueryPatterns: []
};

/**
 * Fusionne des overrides projet aux défauts. Même discipline que
 * `resolveThresholds` : toute valeur non finie ou négative est ignorée
 * silencieusement — un override corrompu ne doit jamais DÉSACTIVER un seuil, ce
 * qui produirait un flot de faux positifs au lieu d'une erreur visible.
 */
export function resolveDeclineThresholds(
	overrides?: Partial<DeclineThresholds> | null
): DeclineThresholds {
	const out = { ...DECLINE_DEFAULTS };
	if (!overrides) return out;
	for (const key of Object.keys(DECLINE_DEFAULTS) as (keyof DeclineThresholds)[]) {
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

// ── Appariement de deux fenêtres ────────────────────────────────────

/** Mesures d'un couple sur une fenêtre. */
export interface PairSide {
	clicks: number;
	impressions: number;
	ctr: number;
	position: number;
	weeksSeen: number;
}

/** Un couple query×page mesuré sur les deux fenêtres, avec ses écarts. */
export interface PairDelta {
	query: string;
	page: string;
	current: PairSide;
	prior: PairSide;
	/** `current − prior` : négatif = perte de clics. */
	clicksAbs: number;
	/** Variation relative en % ; `null` si `prior.clicks` vaut 0 (pas de base). */
	clicksPct: number | null;
	impressionsAbs: number;
	impressionsPct: number | null;
	/** `current − prior` : POSITIF = position dégradée (§ décision porteuse n°4). */
	positionAbs: number;
	/** Ids d'observations des DEUX fenêtres (pointeurs de preuve). */
	observationIds: string[];
}

export interface PairDiff {
	/** Couples présents dans les deux fenêtres — les SEULS comparables. */
	matched: PairDelta[];
	/** Couples présents avant, absents maintenant : ni baisse, ni guérison (FIND-006). */
	vanished: number;
	/** Couples apparus : hors périmètre de ce détecteur (FIND-006). */
	appeared: number;
}

function side(p: AggregatedPair): PairSide {
	return {
		clicks: p.clicks,
		impressions: p.impressions,
		ctr: p.ctr,
		position: p.position,
		weeksSeen: p.weeksSeen
	};
}

function pct(abs: number, prior: number): number | null {
	return prior !== 0 ? (abs / prior) * 100 : null;
}

const PAIR_SEP = '\x1f';

function pairKey(query: string, page: string): string {
	return `${query}${PAIR_SEP}${page}`;
}

/**
 * Apparie deux fenêtres agrégées. L'intersection seule est exploitable : voir la
 * décision porteuse n°1. Le tri final est déterministe (query puis page) pour que
 * deux runs sur le même snapshot produisent exactement la même liste.
 */
export function diffPairs(current: AggregatedPair[], prior: AggregatedPair[]): PairDiff {
	const priorByKey = new Map(prior.map((p) => [pairKey(p.query, p.page), p]));
	const currentKeys = new Set(current.map((p) => pairKey(p.query, p.page)));

	const matched: PairDelta[] = [];
	let appeared = 0;

	for (const c of current) {
		const key = pairKey(c.query, c.page);
		const p = priorByKey.get(key);
		if (!p) {
			appeared += 1;
			continue;
		}
		const clicksAbs = c.clicks - p.clicks;
		const impressionsAbs = c.impressions - p.impressions;
		matched.push({
			query: c.query,
			page: c.page,
			current: side(c),
			prior: side(p),
			clicksAbs,
			clicksPct: pct(clicksAbs, p.clicks),
			impressionsAbs,
			impressionsPct: pct(impressionsAbs, p.impressions),
			positionAbs: c.position - p.position,
			observationIds: [...c.observationIds, ...p.observationIds].sort()
		});
	}

	let vanished = 0;
	for (const key of priorByKey.keys()) {
		if (!currentKeys.has(key)) vanished += 1;
	}

	matched.sort((a, b) =>
		a.query === b.query ? cmp(a.page, b.page) : cmp(a.query, b.query)
	);
	return { matched, vanished, appeared };
}

function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

// ── Évaluation d'un écart contre les seuils ─────────────────────────

/** Quelle mesure a franchi son seuil. */
export type DeclineSignal = 'clicks' | 'impressions' | 'position';

/**
 * Les signaux qu'un écart déclenche. Liste vide = pas de baisse.
 *
 * Le seuil de volume porte sur la fenêtre PRÉCÉDENTE, et il est évalué EN PREMIER :
 * un couple trop petit n'est pas « une baisse à faible confiance », il n'est pas une
 * baisse du tout. Les clics exigent le pourcentage ET l'absolu (deux garde-fous, pas
 * un choix) ; impressions et position se suffisent à eux-mêmes.
 */
export function evaluateDecline(
	delta: PairDelta,
	thresholds: DeclineThresholds
): DeclineSignal[] {
	if (delta.prior.impressions < thresholds.minPriorImpressions) return [];

	const signals: DeclineSignal[] = [];

	const clicksDropPct = delta.clicksPct !== null ? -delta.clicksPct : 0;
	if (
		clicksDropPct >= thresholds.minClicksDropPct &&
		-delta.clicksAbs >= thresholds.minClicksDropAbs
	) {
		signals.push('clicks');
	}

	const impressionsDropPct = delta.impressionsPct !== null ? -delta.impressionsPct : 0;
	if (impressionsDropPct >= thresholds.minImpressionsDropPct) {
		signals.push('impressions');
	}

	if (delta.positionAbs >= thresholds.minPositionDrop) {
		signals.push('position');
	}

	return signals;
}

// ── Croisement des deux fenêtres → niveau de confirmation ───────────

/**
 * Niveau de confirmation d'une baisse (décision porteuse n°2). Ce n'est PAS une
 * sévérité : c'est ce que les données autorisent à affirmer.
 */
export type ConfirmationLevel = 'confirmed' | 'sustained' | 'emerging';

/** Ce qu'une fenêtre dit d'un couple. `null` = fenêtre non comparable ou couple absent. */
export interface SpanFinding {
	span: WindowSpan;
	weeks: number;
	signals: DeclineSignal[];
	delta: PairDelta;
}

export interface DeclineCandidate {
	query: string;
	page: string;
	confirmation: ConfirmationLevel;
	/** L'écart qui porte le chiffre affiché : le 4 semaines s'il a tiré, sinon le 1 semaine. */
	delta: PairDelta;
	/** Signaux franchis, union des deux fenêtres, ordre stable. */
	signals: DeclineSignal[];
	primary: SpanFinding | null;
	recent: SpanFinding | null;
}

const SIGNAL_ORDER: DeclineSignal[] = ['clicks', 'impressions', 'position'];

function unionSignals(a: DeclineSignal[], b: DeclineSignal[]): DeclineSignal[] {
	const set = new Set([...a, ...b]);
	return SIGNAL_ORDER.filter((s) => set.has(s));
}

/**
 * Croise les baisses vues sur les deux fenêtres en candidats uniques.
 *
 * Une fenêtre non comparable (historique trop court, longueurs différentes) est
 * passée à `null` par l'appelant : elle ne peut ni confirmer, ni infirmer. Un
 * candidat vu SEULEMENT par le 1 semaine reste `emerging` même si le 4 semaines
 * était disponible et n'a rien vu — c'est le cas normal d'une baisse toute fraîche,
 * qu'une moyenne sur 4 semaines n'a pas encore absorbée.
 */
export function combineSpans(input: {
	primary: Map<string, SpanFinding> | null;
	recent: Map<string, SpanFinding> | null;
}): DeclineCandidate[] {
	const keys = new Set<string>([
		...(input.primary?.keys() ?? []),
		...(input.recent?.keys() ?? [])
	]);

	const out: DeclineCandidate[] = [];
	for (const key of keys) {
		const primary = input.primary?.get(key) ?? null;
		const recent = input.recent?.get(key) ?? null;
		if (!primary && !recent) continue;

		const confirmation: ConfirmationLevel =
			primary && recent ? 'confirmed' : primary ? 'sustained' : 'emerging';
		// Le 4 semaines porte le chiffre quand il a tiré : il est plus robuste, et
		// c'est le nombre qu'on veut voir dans un titre qui sera relu dans un mois.
		const carrier = (primary ?? recent) as SpanFinding;

		out.push({
			query: carrier.delta.query,
			page: carrier.delta.page,
			confirmation,
			delta: carrier.delta,
			signals: unionSignals(primary?.signals ?? [], recent?.signals ?? []),
			primary,
			recent
		});
	}

	return out.sort((a, b) =>
		a.query === b.query ? cmp(a.page, b.page) : cmp(a.query, b.query)
	);
}

// ── Regroupement par page (décision porteuse n°3) ───────────────────

export interface PageGroup {
	page: string;
	/** Les candidats regroupés, triés (chacun garde son propre écart). */
	members: DeclineCandidate[];
	/** Écart de la PAGE, calculé sur tous ses couples appariés (pas seulement ceux en baisse). */
	pageDelta: PairDelta;
	signals: DeclineSignal[];
	/** Confirmation de la page : le plus fort niveau parmi ses membres. */
	confirmation: ConfirmationLevel;
}

/**
 * Agrège tous les couples appariés d'une page en un seul écart « page ». La query
 * du delta résultant est vide : ce n'est plus une requête, c'est la page.
 *
 * Les positions sont pondérées par les impressions de LEUR côté de la fenêtre — une
 * moyenne simple ferait peser autant une requête vue 3 fois qu'une vue 3 000 fois,
 * et le chiffre divergerait de celui du détecteur d'opportunités et du collecteur.
 */
export function aggregatePage(page: string, deltas: PairDelta[]): PairDelta {
	const acc = {
		curClicks: 0,
		curImpr: 0,
		curPosW: 0,
		priClicks: 0,
		priImpr: 0,
		priPosW: 0,
		curWeeks: 0,
		priWeeks: 0,
		ids: [] as string[]
	};
	for (const d of deltas) {
		acc.curClicks += d.current.clicks;
		acc.curImpr += d.current.impressions;
		acc.curPosW += d.current.position * d.current.impressions;
		acc.priClicks += d.prior.clicks;
		acc.priImpr += d.prior.impressions;
		acc.priPosW += d.prior.position * d.prior.impressions;
		acc.curWeeks = Math.max(acc.curWeeks, d.current.weeksSeen);
		acc.priWeeks = Math.max(acc.priWeeks, d.prior.weeksSeen);
		acc.ids.push(...d.observationIds);
	}

	const current: PairSide = {
		clicks: acc.curClicks,
		impressions: acc.curImpr,
		ctr: acc.curImpr > 0 ? acc.curClicks / acc.curImpr : 0,
		position: acc.curImpr > 0 ? acc.curPosW / acc.curImpr : 0,
		weeksSeen: acc.curWeeks
	};
	const prior: PairSide = {
		clicks: acc.priClicks,
		impressions: acc.priImpr,
		ctr: acc.priImpr > 0 ? acc.priClicks / acc.priImpr : 0,
		position: acc.priImpr > 0 ? acc.priPosW / acc.priImpr : 0,
		weeksSeen: acc.priWeeks
	};
	const clicksAbs = current.clicks - prior.clicks;
	const impressionsAbs = current.impressions - prior.impressions;

	return {
		query: '',
		page,
		current,
		prior,
		clicksAbs,
		clicksPct: pct(clicksAbs, prior.clicks),
		impressionsAbs,
		impressionsPct: pct(impressionsAbs, prior.impressions),
		positionAbs: current.position - prior.position,
		observationIds: [...new Set(acc.ids)].sort()
	};
}

const CONFIRMATION_RANK: Record<ConfirmationLevel, number> = {
	confirmed: 3,
	sustained: 2,
	emerging: 1
};

export interface GroupingResult {
	groups: PageGroup[];
	/** Les candidats restés individuels (page sous le seuil, ou page globalement stable). */
	singles: DeclineCandidate[];
	/**
	 * Pages ayant assez de requêtes en baisse mais dont le TOTAL ne baisse pas :
	 * leurs requêtes restent des findings individuels. Compteur annoncé — c'est la
	 * différence entre « une page qui décroche » et « une page qui se recompose ».
	 */
	pagesStable: number;
}

/**
 * Regroupe par page quand la page elle-même décroche.
 *
 * `allMatched` porte TOUS les couples appariés de la fenêtre porteuse, pas seulement
 * ceux en baisse : sans ça, l'agrégat de page ne verrait que les pertes et
 * confirmerait toujours le groupe (voir décision porteuse n°3).
 */
export function groupByPage(
	candidates: DeclineCandidate[],
	allMatched: PairDelta[],
	thresholds: DeclineThresholds
): GroupingResult {
	const minQueries = Math.max(2, Math.floor(thresholds.pageGroupMinQueries));

	const byPage = new Map<string, DeclineCandidate[]>();
	for (const c of candidates) {
		const list = byPage.get(c.page);
		if (list) list.push(c);
		else byPage.set(c.page, [c]);
	}

	const matchedByPage = new Map<string, PairDelta[]>();
	for (const d of allMatched) {
		const list = matchedByPage.get(d.page);
		if (list) list.push(d);
		else matchedByPage.set(d.page, [d]);
	}

	const groups: PageGroup[] = [];
	const singles: DeclineCandidate[] = [];
	let pagesStable = 0;

	for (const [page, members] of byPage) {
		if (members.length < minQueries) {
			singles.push(...members);
			continue;
		}
		const pageDelta = aggregatePage(page, matchedByPage.get(page) ?? members.map((m) => m.delta));
		const signals = evaluateDecline(pageDelta, thresholds);
		if (signals.length === 0) {
			// La page se recompose (des requêtes montent autant que d'autres baissent) :
			// il n'y a pas UN problème de page, il y a N problèmes de requête.
			pagesStable += 1;
			singles.push(...members);
			continue;
		}
		const confirmation = members.reduce<ConfirmationLevel>(
			(worst, m) =>
				CONFIRMATION_RANK[m.confirmation] > CONFIRMATION_RANK[worst] ? m.confirmation : worst,
			'emerging'
		);
		groups.push({
			page,
			members: [...members].sort((a, b) => cmp(a.query, b.query)),
			pageDelta,
			signals,
			confirmation
		});
	}

	groups.sort((a, b) => cmp(a.page, b.page));
	singles.sort((a, b) => (a.query === b.query ? cmp(a.page, b.page) : cmp(a.query, b.query)));
	return { groups, singles, pagesStable };
}

// ── Sélection finale (unités écrivables, triées, plafonnées) ────────

/** Une unité de finding : soit une page groupée, soit un couple query×page. */
export type DeclineUnit =
	| { kind: 'page'; page: string; group: PageGroup; delta: PairDelta; signals: DeclineSignal[]; confirmation: ConfirmationLevel }
	| { kind: 'query'; query: string; page: string; candidate: DeclineCandidate; delta: PairDelta; signals: DeclineSignal[]; confirmation: ConfirmationLevel };

export interface DeclineSelection {
	/** Unités écrites, éventuellement tronquées à `maxCandidates`. */
	units: DeclineUnit[];
	/** TOUTES les unités franchissant les seuils, AVANT troncature — base de la closure FIND-003. */
	matched: DeclineUnit[];
	totalMatched: number;
	truncated: boolean;
	groupsFormed: number;
	pagesStable: number;
}

/** Perte de clics par semaine, base du tri et de l'impact. Toujours ≥ 0. */
export function weeklyClickLoss(delta: PairDelta, weeks: number): number {
	return Math.max(0, -delta.clicksAbs) / Math.max(1, weeks);
}

/**
 * Ordonne et plafonne. Le tri est par perte de clics hebdomadaire décroissante,
 * départagée par la confirmation (une baisse prouvée passe devant une baisse
 * pressentie de même ampleur), puis par les impressions perdues, puis
 * alphabétiquement → ordre 100 % reproductible. La troncature est REPORTÉE.
 */
export function selectDeclines(
	units: DeclineUnit[],
	thresholds: DeclineThresholds,
	weeks: number
): DeclineSelection {
	const matched = [...units].sort((a, b) => {
		const la = weeklyClickLoss(a.delta, weeks);
		const lb = weeklyClickLoss(b.delta, weeks);
		if (lb !== la) return lb - la;
		const ca = CONFIRMATION_RANK[a.confirmation];
		const cb = CONFIRMATION_RANK[b.confirmation];
		if (cb !== ca) return cb - ca;
		const ia = -a.delta.impressionsAbs;
		const ib = -b.delta.impressionsAbs;
		if (ib !== ia) return ib - ia;
		return cmp(unitKey(a), unitKey(b));
	});

	const cap = Math.max(0, Math.floor(thresholds.maxCandidates));
	return {
		units: matched.slice(0, cap),
		matched,
		totalMatched: matched.length,
		truncated: matched.length > cap,
		groupsFormed: matched.filter((u) => u.kind === 'page').length,
		pagesStable: 0
	};
}

/** Clé de tri stable et lisible d'une unité (jamais un fingerprint : ce n'est pas une identité DB). */
export function unitKey(unit: DeclineUnit): string {
	return unit.kind === 'page' ? `page:${unit.page}` : `query:${unit.query} ${unit.page}`;
}

// ── Scoring (barème §10.2) ──────────────────────────────────────────

export interface DeclineScore {
	impact: number;
	urgency: number;
	confidence: number;
	strategicFit: number;
	confidenceScore: number;
	confidenceCaveats: string[];
}

/** Poids de confiance par niveau de confirmation — une seule semaine ne prouve pas. */
const CONFIRMATION_CONFIDENCE: Record<ConfirmationLevel, number> = {
	confirmed: 1,
	sustained: 0.8,
	emerging: 0.5
};

/**
 * Les 4 composantes du barème §10.2 (sommées par `computePriorityScore`, jamais
 * réimplémentées ici) :
 *
 *   - impact       : clics perdus par semaine, saturé à 10/semaine ;
 *   - urgency      : ampleur relative de la baisse (−100 % = maximum) ;
 *   - confidence   : couverture de fenêtre × persistance × niveau de confirmation.
 *                    Une fenêtre incomplète, un couple vu une semaine sur quatre ou
 *                    une baisse non confirmée FONT BAISSER la confiance — ils ne
 *                    bloquent pas le finding (acceptation GSC-004) ;
 *   - strategicFit : la page captait des clics avant + volume relatif.
 *
 * La saisonnalité est traitée à part : voir `SeasonalityContext`. Elle n'entre pas
 * dans le score tant qu'aucune donnée N-1 n'existe — un facteur neutre inventé
 * serait indistinguable d'un facteur mesuré.
 */
export function scoreDecline(
	unit: DeclineUnit,
	context: {
		thresholds: DeclineThresholds;
		completeness: WindowCompleteness;
		weeks: number;
		seasonality: SeasonalityContext;
	}
): DeclineScore {
	const { thresholds, completeness, weeks, seasonality } = context;
	const delta = unit.delta;
	const caveats: string[] = [];

	const lossPerWeek = weeklyClickLoss(delta, weeks);
	const impact = clampScore((lossPerWeek / 10) * PRIORITY_WEIGHTS.impact, 0, PRIORITY_WEIGHTS.impact);

	// urgency — la plus forte des deux baisses relatives mesurées, bornée à 100 %.
	const clicksDrop = delta.clicksPct !== null ? Math.max(0, -delta.clicksPct) : 0;
	const imprDrop = delta.impressionsPct !== null ? Math.max(0, -delta.impressionsPct) : 0;
	const severityRatio = Math.min(1, Math.max(clicksDrop, imprDrop) / 100);
	const urgency = clampScore(severityRatio * PRIORITY_WEIGHTS.urgency, 0, PRIORITY_WEIGHTS.urgency);

	// confidence — trois facteurs multiplicatifs, trois caveats distincts.
	if (completeness.caveats.length > 0) caveats.push(...completeness.caveats);
	const persistence = Math.max(
		0,
		Math.min(1, delta.prior.weeksSeen / Math.max(1, completeness.expectedWeeks))
	);
	if (delta.prior.weeksSeen < completeness.expectedWeeks) {
		caveats.push(
			`vu ${delta.prior.weeksSeen}/${completeness.expectedWeeks} semaines avant la baisse`
		);
	}
	if (unit.confirmation !== 'confirmed') {
		caveats.push(
			unit.confirmation === 'emerging'
				? 'baisse vue sur une seule semaine : pas encore confirmée'
				: 'baisse installée ; la dernière semaine n’ajoute pas de chute nouvelle'
		);
	}
	if (delta.prior.impressions < thresholds.lowVolumeImpressions) {
		caveats.push(`faible volume (${delta.prior.impressions} impressions avant)`);
	}
	if (!seasonality.available) caveats.push(seasonality.note);

	const confidence = clampScore(
		completeness.coverage *
			persistence *
			CONFIRMATION_CONFIDENCE[unit.confirmation] *
			PRIORITY_WEIGHTS.confidence,
		0,
		PRIORITY_WEIGHTS.confidence
	);

	const hadClicks = delta.prior.clicks > 0 ? 0.5 : 0;
	const volumeFit = Math.min(
		0.5,
		(delta.prior.impressions / Math.max(1, thresholds.lowVolumeImpressions)) * 0.5
	);
	const strategicFit = clampScore(
		(hadClicks + volumeFit) * PRIORITY_WEIGHTS.strategicFit,
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

// ── Saisonnalité : disponible ou déclarée absente, jamais neutre ────

/**
 * « Pondérer la saisonnalité DISPONIBLE » (ticket FIND-005). Elle ne l'est pas
 * encore : `buildYoyComparison` (GSC-004) est inerte tant qu'aucune semaine N-1
 * n'existe en base, et la donnée réelle commence en 2026. Plutôt qu'un facteur
 * neutre — indistinguable d'un facteur mesuré à 1,0 — l'absence est DÉCLARÉE et
 * porte dans les preuves et dans les caveats de confiance, comme un provider
 * optionnel absent apparaît absent et jamais zéro (acceptation REP-001).
 */
export type SeasonalityContext =
	| { available: false; reason: 'no_year_ago_data' | 'insufficient_current'; note: string }
	| { available: true; span: WindowSpan; window: { start: string; end: string } };

export function seasonalityUnavailable(
	reason: 'no_year_ago_data' | 'insufficient_current'
): SeasonalityContext {
	return {
		available: false,
		reason,
		note:
			reason === 'no_year_ago_data'
				? 'saisonnalité non évaluable : aucune semaine comparable il y a un an'
				: 'saisonnalité non évaluable : fenêtre courante trop courte'
	};
}

// ── Sévérité (plafonds FIND-002) ────────────────────────────────────

/**
 * Traduit un score en sévérité, avec DEUX plafonds distincts :
 *
 *   - faible volume ou confiance dégradée → jamais au-dessus de `medium`
 *     (acceptation FIND-002 : « les findings sans données suffisantes n'atteignent
 *     pas une priorité critique ») ;
 *   - baisse `emerging` → jamais au-dessus de `medium` non plus, quelle que soit
 *     l'ampleur. Une chute de 90 % sur une seule semaine peut être une semaine
 *     fériée ; la deuxième semaine tranche. C'est le plafond d'IDX-005 sur la
 *     fluctuation isolée, appliqué au même raisonnement.
 */
export function deriveDeclineSeverity(input: {
	priorityScore: number;
	priorImpressions: number;
	thresholds: DeclineThresholds;
	confidenceScore: number;
	confirmation: ConfirmationLevel;
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
		input.priorImpressions < input.thresholds.lowVolumeImpressions ||
		input.confidenceScore < 50 ||
		input.confirmation === 'emerging';
	if (!underpowered) return base;
	return base === 'critical' || base === 'high' ? 'medium' : base;
}

// ── Preuves = POINTEURS (piège DATA-005) ────────────────────────────

export interface DeclineEvidence {
	detector: string;
	/** 'page' quand le finding regroupe, 'query' sinon. */
	granularity: 'page' | 'query';
	confirmation: ConfirmationLevel;
	signals: DeclineSignal[];
	windows: {
		primary: { span: WindowSpan; weeks: number; current: ObservationWindow; prior: ObservationWindow } | null;
		recent: { span: WindowSpan; weeks: number; current: ObservationWindow; prior: ObservationWindow } | null;
	};
	metrics: {
		current: PairSide;
		prior: PairSide;
		clicksAbs: number;
		clicksPct: number | null;
		impressionsAbs: number;
		impressionsPct: number | null;
		/** POSITIF = position dégradée. */
		positionAbs: number;
		weeklyClickLoss: number;
	};
	/** Détail par requête quand le finding est groupé (réversible et inspectable). */
	queries: {
		query: string;
		clicksAbs: number;
		clicksPct: number | null;
		positionAbs: number;
		confirmation: ConfirmationLevel;
	}[];
	queryCount: number;
	observationIds: string[];
	observationCount: number;
	scoreBreakdown: { impact: number; urgency: number; confidence: number; strategicFit: number };
	confidenceCaveats: string[];
	seasonality: SeasonalityContext;
}

/** Plafond de requêtes détaillées dans un groupe : les preuves restent bornées. */
export const MAX_EVIDENCE_QUERIES = 25;

export function buildDeclineEvidence(input: {
	unit: DeclineUnit;
	score: DeclineScore;
	weeks: number;
	windows: DeclineEvidence['windows'];
	seasonality: SeasonalityContext;
}): DeclineEvidence {
	const { unit, score, weeks, windows, seasonality } = input;
	const delta = unit.delta;
	const members = unit.kind === 'page' ? unit.group.members : [];

	return {
		detector: DETECTOR_KEYWORD_DECLINE,
		granularity: unit.kind,
		confirmation: unit.confirmation,
		signals: unit.signals,
		windows,
		metrics: {
			current: delta.current,
			prior: delta.prior,
			clicksAbs: delta.clicksAbs,
			clicksPct: delta.clicksPct,
			impressionsAbs: delta.impressionsAbs,
			impressionsPct: delta.impressionsPct,
			positionAbs: delta.positionAbs,
			weeklyClickLoss: weeklyClickLoss(delta, weeks)
		},
		queries: members.slice(0, MAX_EVIDENCE_QUERIES).map((m) => ({
			query: m.query,
			clicksAbs: m.delta.clicksAbs,
			clicksPct: m.delta.clicksPct,
			positionAbs: m.delta.positionAbs,
			confirmation: m.confirmation
		})),
		queryCount: members.length,
		observationIds: delta.observationIds.slice(0, MAX_EVIDENCE_IDS),
		observationCount: delta.observationIds.length,
		scoreBreakdown: {
			impact: score.impact,
			urgency: score.urgency,
			confidence: score.confidence,
			strategicFit: score.strategicFit
		},
		confidenceCaveats: score.confidenceCaveats,
		seasonality
	};
}

// ── Titre et raison lisibles ────────────────────────────────────────

const CONFIRMATION_LABEL: Record<ConfirmationLevel, string> = {
	confirmed: 'confirmée',
	sustained: 'installée',
	emerging: 'à confirmer'
};

/**
 * Titre STABLE : aucune date dedans (il est réécrit à chaque re-détection, une date
 * ferait « bouger » un finding qui n'a pas changé de nature).
 */
export function buildDeclineTitle(unit: DeclineUnit): string {
	const d = unit.delta;
	const loss = Math.max(0, -d.clicksAbs);
	const pctPart = d.clicksPct !== null ? ` (${d.clicksPct.toFixed(0)} %)` : '';
	const label = CONFIRMATION_LABEL[unit.confirmation];
	if (unit.kind === 'page') {
		return `Baisse ${label} sur ${unit.page} — −${loss} clics${pctPart} sur ${unit.group.members.length} requêtes`;
	}
	return `Baisse ${label} "${unit.query}" — −${loss} clics${pctPart}`;
}

/** Cause lisible, journalisée dans `finding_events.reason`. */
export function buildDeclineReason(unit: DeclineUnit, thresholds: DeclineThresholds): string {
	const d = unit.delta;
	const parts: string[] = [];
	if (unit.signals.includes('clicks')) {
		parts.push(
			`clics ${d.prior.clicks} → ${d.current.clicks}` +
				(d.clicksPct !== null ? ` (${d.clicksPct.toFixed(0)} %, seuil −${thresholds.minClicksDropPct} %)` : '')
		);
	}
	if (unit.signals.includes('impressions')) {
		parts.push(
			`impressions ${d.prior.impressions} → ${d.current.impressions}` +
				(d.impressionsPct !== null
					? ` (${d.impressionsPct.toFixed(0)} %, seuil −${thresholds.minImpressionsDropPct} %)`
					: '')
		);
	}
	if (unit.signals.includes('position')) {
		parts.push(
			`position ${d.prior.position.toFixed(1)} → ${d.current.position.toFixed(1)} ` +
				`(+${d.positionAbs.toFixed(1)} rangs, seuil +${thresholds.minPositionDrop})`
		);
	}
	const scope =
		unit.kind === 'page'
			? `page (${unit.group.members.length} requêtes en baisse, total de la page en baisse)`
			: 'requête';
	return `${scope} — ${parts.join(' · ')} — confirmation : ${CONFIRMATION_LABEL[unit.confirmation]}`;
}

// ── Passe complète (pure) ───────────────────────────────────────────

export interface DeclinePassInput {
	/** Lignes d'observation de la fenêtre courante 4 semaines (vide si indisponible). */
	primaryCurrentRows: ObservationRow[];
	primaryPriorRows: ObservationRow[];
	/** Vrai si les deux fenêtres 4 semaines couvrent le même nombre de semaines. */
	primaryComparable: boolean;
	recentCurrentRows: ObservationRow[];
	recentPriorRows: ObservationRow[];
	recentComparable: boolean;
	thresholds: DeclineThresholds;
}

export interface DeclinePassResult {
	selection: DeclineSelection;
	/** Couples appariés de la fenêtre porteuse (base du regroupement et des compteurs). */
	matchedPairs: number;
	vanished: number;
	appeared: number;
	pagesStable: number;
	excludedByNoise: number;
	/** Renseigné quand aucune détection n'était possible : jamais un résultat vide muet. */
	skippedReason: string | null;
}

function toSpanMap(
	rowsCurrent: ObservationRow[],
	rowsPrior: ObservationRow[],
	comparable: boolean,
	span: WindowSpan,
	thresholds: DeclineThresholds
): { map: Map<string, SpanFinding>; diff: PairDiff; excluded: number } | null {
	if (!comparable) return null;
	const current = aggregateWindow(rowsCurrent);
	const prior = aggregateWindow(rowsPrior);
	const diff = diffPairs(current, prior);

	const map = new Map<string, SpanFinding>();
	let excluded = 0;
	for (const delta of diff.matched) {
		if (isExcludedQuery(delta.query, thresholds.excludeQueryPatterns)) {
			excluded += 1;
			continue;
		}
		const signals = evaluateDecline(delta, thresholds);
		if (signals.length === 0) continue;
		map.set(pairKey(delta.query, delta.page), {
			span,
			weeks: spanToWeeks(span),
			signals,
			delta
		});
	}
	return { map, diff, excluded };
}

/**
 * Enchaîne appariement → évaluation → croisement des fenêtres → regroupement →
 * tri/plafond, sans jamais toucher la base. C'est cette fonction que les tests
 * pilotent, et elle porte l'invariant d'acceptation le plus important : **si
 * aucune des deux fenêtres n'est comparable, il ne sort RIEN** — une fenêtre
 * incomplète ne produit pas une baisse à faible confiance, elle ne produit pas de
 * baisse du tout.
 */
export function runDeclinePass(input: DeclinePassInput): DeclinePassResult {
	const { thresholds } = input;

	const primary = toSpanMap(
		input.primaryCurrentRows,
		input.primaryPriorRows,
		input.primaryComparable,
		PRIMARY_SPAN,
		thresholds
	);
	const recent = toSpanMap(
		input.recentCurrentRows,
		input.recentPriorRows,
		input.recentComparable,
		RECENT_SPAN,
		thresholds
	);

	const empty: DeclineSelection = {
		units: [],
		matched: [],
		totalMatched: 0,
		truncated: false,
		groupsFormed: 0,
		pagesStable: 0
	};

	if (!primary && !recent) {
		return {
			selection: empty,
			matchedPairs: 0,
			vanished: 0,
			appeared: 0,
			pagesStable: 0,
			excludedByNoise: 0,
			skippedReason:
				'aucune fenêtre comparable (historique insuffisant pour comparer deux périodes de même longueur)'
		};
	}

	// La fenêtre PORTEUSE des compteurs et du regroupement : le 4 semaines quand il
	// est disponible (plus robuste), sinon le 1 semaine.
	const carrier = primary ?? (recent as NonNullable<typeof recent>);
	const weeks = primary ? spanToWeeks(PRIMARY_SPAN) : spanToWeeks(RECENT_SPAN);

	const candidates = combineSpans({
		primary: primary?.map ?? null,
		recent: recent?.map ?? null
	});

	const grouping = groupByPage(candidates, carrier.diff.matched, thresholds);

	const units: DeclineUnit[] = [
		...grouping.groups.map(
			(group): DeclineUnit => ({
				kind: 'page',
				page: group.page,
				group,
				delta: group.pageDelta,
				signals: group.signals,
				confirmation: group.confirmation
			})
		),
		...grouping.singles.map(
			(candidate): DeclineUnit => ({
				kind: 'query',
				query: candidate.query,
				page: candidate.page,
				candidate,
				delta: candidate.delta,
				signals: candidate.signals,
				confirmation: candidate.confirmation
			})
		)
	];

	const selection = selectDeclines(units, thresholds, weeks);

	return {
		selection: { ...selection, pagesStable: grouping.pagesStable },
		matchedPairs: carrier.diff.matched.length,
		vanished: carrier.diff.vanished,
		appeared: carrier.diff.appeared,
		pagesStable: grouping.pagesStable,
		excludedByNoise: carrier.excluded,
		// Une fenêtre comparable qui ne trouve aucune baisse n'est PAS un run sauté :
		// c'est un run qui a regardé et n'a rien vu. Seule l'incapacité à comparer
		// (plus haut) mérite une raison — confondre les deux ferait lire « rien à
		// signaler » là où personne n'a rien pu juger.
		skippedReason: null
	};
}
