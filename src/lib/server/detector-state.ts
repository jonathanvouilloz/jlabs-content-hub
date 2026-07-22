/**
 * FIND-001/FIND-004 — Helpers PURS du premier détecteur déterministe
 * (`keyword_opportunity`, SPEC §10.3/§10.4).
 *
 * Zéro import db/`$env` → testables en isolation par vitest. Portent les invariants :
 *   - un détecteur est REJOUABLE : mêmes observations en entrée ⇒ mêmes fingerprints,
 *     mêmes scores, même ordre (aucune dépendance à l'ordre d'arrivée ni à l'horloge) ;
 *   - le fait est établi SANS IA (SPEC §3.3) : seuils, agrégation et score sont
 *     arithmétiques et explicables ;
 *   - un manque de données BAISSE la confiance au lieu de produire un faux signal
 *     (§10.3 + acceptation GSC-004), et ne peut pas atteindre une priorité critique ;
 *   - les preuves sont des POINTEURS (ids d'observations), jamais du texte libre.
 *
 * Le barème de priorité lui-même n'est pas réimplémenté ici : il vit dans
 * `finding-state.computePriorityScore` (§10.2), ce module ne calcule que ses composantes.
 */
import {
	PRIORITY_WEIGHTS,
	clampScore,
	type FindingSeverity
} from './finding-state.js';

// ── Identité versionnée du détecteur (FIND-001) ─────────────────────

/**
 * Version stockée dans `findings.detector_version`. À incrémenter dès que la
 * sélection ou le scoring change : deux versions restent comparables sur un même
 * jeu d'observations (acceptation FIND-001). `findings` n'a volontairement pas de
 * `schema_version` — c'est CETTE chaîne qui versionne un finding (piège DATA-005).
 */
export const DETECTOR_KEYWORD_OPPORTUNITY = 'keyword_opportunity@1';

/** Type de finding produit (catalogue §10.4). */
export const KEYWORD_OPPORTUNITY_TYPE = 'keyword_opportunity';

/** Skill recommandé pour ce type (§10.4). */
export const KEYWORD_OPPORTUNITY_SKILL = 'seo-refresh';

// ── Seuils (configurables par projet — acceptation FIND-004) ────────

export interface OpportunityThresholds {
	/** Impressions minimales sur la fenêtre pour qu'un couple query×page compte. */
	minImpressions: number;
	/** Position moyenne minimale (exclut ce qui ranke déjà au sommet). */
	positionMin: number;
	/** Position moyenne maximale (au-delà, ce n'est plus une opportunité mais un sujet à créer). */
	positionMax: number;
	/** CTR cible d'une position exploitable : en dessous, il y a du clic à récupérer. */
	targetCtr: number;
	/** Nombre de semaines complètes attendues dans la fenêtre (référence de confiance). */
	expectedWeeks: number;
	/** Volume d'impressions en dessous duquel la sévérité est plafonnée (§10.3). */
	lowVolumeImpressions: number;
	/** Nombre maximal de findings produits par run et par projet. */
	maxCandidates: number;
	/**
	 * Bruit CONFIGURÉ à exclure (FIND-004 : « exclure navigational/bruit configuré ») :
	 * fragments de requête (marque, nom de l'entreprise, requêtes navigationnelles).
	 * Vide par défaut — on n'invente jamais la marque d'un projet, elle se configure
	 * par projet ; comparaison insensible à la casse, sur sous-chaîne.
	 */
	excludeQueryPatterns: string[];
}

/**
 * Défauts calibrés pour des sites locaux à faible volume (§10.3 : « minimum
 * d'impressions/clics adapté aux sites locaux »). `positionMin = 4` évite de
 * signaler ce qui est déjà top 3 ; `positionMax = 25` borne au périmètre où un
 * refresh peut raisonnablement faire bouger la position.
 */
export const OPPORTUNITY_DEFAULTS: OpportunityThresholds = {
	minImpressions: 30,
	positionMin: 4,
	positionMax: 25,
	targetCtr: 0.1,
	expectedWeeks: 4,
	lowVolumeImpressions: 100,
	maxCandidates: 50,
	excludeQueryPatterns: []
};

/**
 * Fusionne des overrides projet aux défauts. Tolère `null`/`undefined` (les
 * projections peuvent ne pas exister) et ignore silencieusement toute valeur non
 * finie : un override corrompu ne doit jamais désactiver un seuil (ce qui
 * produirait un flot de faux positifs), il retombe sur le défaut.
 */
export function resolveThresholds(
	overrides?: Partial<OpportunityThresholds> | null
): OpportunityThresholds {
	const out = { ...OPPORTUNITY_DEFAULTS };
	if (!overrides) return out;
	for (const key of Object.keys(OPPORTUNITY_DEFAULTS) as (keyof OpportunityThresholds)[]) {
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

/**
 * Vrai si la requête tombe dans le bruit configuré (marque, navigationnel). Aucune
 * heuristique implicite : seule la liste configurée exclut, sinon on ne filtre rien
 * — mieux vaut un finding de marque visible qu'un filtre invisible mal deviné.
 */
export function isExcludedQuery(query: string, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	const q = query.toLowerCase();
	return patterns.some((p) => q.includes(p));
}

// ── Fenêtre d'observation (hebdomadaire) ────────────────────────────

/**
 * Une fenêtre = une liste de semaines COMPLÈTES présentes en base (les observations
 * GSC sont hebdomadaires : `period_start`/`period_end` = bornes de la semaine).
 */
export interface ObservationWindow {
	/** `period_start` de la plus ancienne semaine retenue (YYYY-MM-DD). */
	start: string;
	/** `period_end` de la plus récente semaine retenue (YYYY-MM-DD). */
	end: string;
	/** Nombre de semaines effectivement présentes. */
	weeks: number;
}

/**
 * Construit la fenêtre à partir des semaines DISTINCTES disponibles (paires
 * period_start/period_end), en retenant les `weeks` plus récentes. Retourne `null`
 * si aucune semaine : pas de fenêtre ⇒ pas de détection (jamais une fenêtre vide
 * traitée comme des zéros — §10.3 « distinction entre absence de donnée et valeur zéro »).
 */
export function buildWindow(
	availableWeeks: { periodStart: string; periodEnd: string }[],
	weeks: number
): ObservationWindow | null {
	if (availableWeeks.length === 0) return null;
	const wanted = Math.max(1, Math.floor(weeks));
	const sorted = [...availableWeeks].sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1));
	const kept = sorted.slice(Math.max(0, sorted.length - wanted));
	return {
		start: kept[0].periodStart,
		end: kept[kept.length - 1].periodEnd,
		weeks: kept.length
	};
}

/**
 * Deux fenêtres ne sont comparables que si elles couvrent le MÊME nombre de
 * semaines (acceptation GSC-004 : « aucun delta n'est calculé entre périodes de
 * longueurs incompatibles »). Toute comparaison inter-fenêtres doit passer par là.
 */
export function areWindowsComparable(a: ObservationWindow, b: ObservationWindow): boolean {
	return a.weeks === b.weeks && a.weeks > 0;
}

// ── Agrégation query×page sur la fenêtre ────────────────────────────

/** Ligne d'observation en entrée du détecteur (sous-ensemble de gsc_query_page_observations). */
export interface ObservationRow {
	id: string;
	query: string;
	page: string;
	clicks: number;
	impressions: number;
	position: number;
	periodStart: string;
}

/** Couple query×page agrégé sur toute la fenêtre. */
export interface AggregatedPair {
	query: string;
	page: string;
	clicks: number;
	impressions: number;
	ctr: number;
	/** Position moyenne PONDÉRÉE par les impressions (même règle que le rollup MIGRATE). */
	position: number;
	/** Nombre de semaines distinctes où le couple apparaît (persistance, §10.3). */
	weeksSeen: number;
	/** Ids des observations agrégées → preuves en POINTEURS, jamais de texte libre. */
	observationIds: string[];
}

const PAIR_SEP = '\x1f';

/**
 * Agrège les observations `query×page×device` d'une fenêtre en couples `query×page` :
 * Σ clicks, Σ impressions, CTR recalculé, position pondérée par impressions (une
 * position n'est jamais une moyenne simple : une ligne à 3 impressions ne pèse pas
 * autant qu'une ligne à 3000). Le résultat est trié déterministe (query puis page)
 * → rejouabilité indépendante de l'ordre d'arrivée des lignes.
 */
export function aggregateWindow(rows: ObservationRow[]): AggregatedPair[] {
	const groups = new Map<
		string,
		{
			query: string;
			page: string;
			clicks: number;
			impressions: number;
			positionSum: number;
			weeks: Set<string>;
			ids: string[];
		}
	>();

	for (const r of rows) {
		const key = `${r.query}${PAIR_SEP}${r.page}`;
		let g = groups.get(key);
		if (!g) {
			g = {
				query: r.query,
				page: r.page,
				clicks: 0,
				impressions: 0,
				positionSum: 0,
				weeks: new Set(),
				ids: []
			};
			groups.set(key, g);
		}
		g.clicks += r.clicks;
		g.impressions += r.impressions;
		g.positionSum += r.position * r.impressions;
		g.weeks.add(r.periodStart);
		g.ids.push(r.id);
	}

	const out: AggregatedPair[] = [];
	for (const g of groups.values()) {
		out.push({
			query: g.query,
			page: g.page,
			clicks: g.clicks,
			impressions: g.impressions,
			ctr: g.impressions > 0 ? g.clicks / g.impressions : 0,
			position: g.impressions > 0 ? g.positionSum / g.impressions : 0,
			weeksSeen: g.weeks.size,
			observationIds: [...g.ids].sort()
		});
	}
	return out.sort((a, b) => (a.query === b.query ? cmp(a.page, b.page) : cmp(a.query, b.query)));
}

function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

// ── Sélection des opportunités (filtre déterministe, §10.4) ─────────

export interface OpportunityCandidate extends AggregatedPair {
	/** Écart entre le CTR cible de la position et le CTR observé (borné à ≥ 0). */
	ctrGap: number;
	/** Clics hebdomadaires estimés récupérables si l'action aboutit (entier ≥ 0). */
	gainEstimate: number;
}

export interface OpportunitySelection {
	/** Les candidats retenus, triés, éventuellement tronqués à `maxCandidates`. */
	candidates: OpportunityCandidate[];
	/** Nombre de couples franchissant les seuils AVANT troncature. */
	totalMatched: number;
	/** Couples écartés parce qu'ils tombent dans le bruit configuré. */
	excludedByNoise: number;
	/** Vrai si `maxCandidates` a tronqué la liste — jamais une troncature silencieuse. */
	truncated: boolean;
}

/**
 * Signal principal §10.4 : « impressions + position exploitable ». Un couple est
 * candidat s'il n'est pas du bruit configuré, a assez d'impressions, une position
 * dans la plage exploitable, et un CTR sous la cible (donc du clic réellement
 * récupérable). Un gain estimé nul disqualifie (rien à gagner = pas un finding).
 * Tri par gain décroissant, départagé par impressions puis query/page → ordre
 * 100 % déterministe. La troncature est REPORTÉE, jamais silencieuse.
 */
export function selectOpportunities(
	pairs: AggregatedPair[],
	thresholds: OpportunityThresholds
): OpportunitySelection {
	const matched: OpportunityCandidate[] = [];
	let excludedByNoise = 0;

	for (const p of pairs) {
		if (isExcludedQuery(p.query, thresholds.excludeQueryPatterns)) {
			excludedByNoise += 1;
			continue;
		}
		if (p.impressions < thresholds.minImpressions) continue;
		if (p.position < thresholds.positionMin || p.position > thresholds.positionMax) continue;
		const ctrGap = Math.max(0, thresholds.targetCtr - p.ctr);
		if (ctrGap <= 0) continue;
		const gainEstimate = Math.round(p.impressions * ctrGap);
		if (gainEstimate < 1) continue;
		matched.push({ ...p, ctrGap, gainEstimate });
	}

	matched.sort((a, b) => {
		if (b.gainEstimate !== a.gainEstimate) return b.gainEstimate - a.gainEstimate;
		if (b.impressions !== a.impressions) return b.impressions - a.impressions;
		return a.query === b.query ? cmp(a.page, b.page) : cmp(a.query, b.query);
	});

	const cap = Math.max(0, Math.floor(thresholds.maxCandidates));
	return {
		candidates: matched.slice(0, cap),
		totalMatched: matched.length,
		excludedByNoise,
		truncated: matched.length > cap
	};
}

// ── Scoring (composantes du barème §10.2) ───────────────────────────

export interface OpportunityScore {
	impact: number;
	urgency: number;
	confidence: number;
	strategicFit: number;
	/** Confiance exprimée sur 0–100 (colonne `confidence_score`). */
	confidenceScore: number;
	/** Raisons lisibles de la dégradation de confiance (vide si pleine confiance). */
	confidenceCaveats: string[];
}

/**
 * Calcule les 4 composantes du barème §10.2 (à sommer par
 * `finding-state.computePriorityScore`, jamais réimplémenté ici).
 *
 *   - impact       : le gain de clics estimé, saturé au plafond (40) ;
 *   - urgency      : d'autant plus haute que la position est proche du top
 *                    (une position 5 est plus urgente à travailler qu'une position 24) ;
 *   - confidence   : couverture de la fenêtre × persistance du couple — une fenêtre
 *                    incomplète ou un couple vu une seule semaine FAIT BAISSER la
 *                    confiance (acceptation GSC-004), il ne bloque pas le finding ;
 *   - strategicFit : présence de clics existants (la page convertit déjà des
 *                    impressions) + volume relatif.
 */
export function scoreOpportunity(
	candidate: OpportunityCandidate,
	context: { window: ObservationWindow; thresholds: OpportunityThresholds }
): OpportunityScore {
	const { window, thresholds } = context;
	const caveats: string[] = [];

	// impact — 10 clics/semaine récupérables = plafond.
	const impact = clampScore((candidate.gainEstimate / 10) * PRIORITY_WEIGHTS.impact, 0, PRIORITY_WEIGHTS.impact);

	// urgency — linéaire décroissante sur la plage exploitable.
	const span = Math.max(1, thresholds.positionMax - thresholds.positionMin);
	const closeness = Math.max(0, Math.min(1, (thresholds.positionMax - candidate.position) / span));
	const urgency = clampScore(closeness * PRIORITY_WEIGHTS.urgency, 0, PRIORITY_WEIGHTS.urgency);

	// confidence — couverture de fenêtre × persistance.
	const coverage = Math.max(0, Math.min(1, window.weeks / Math.max(1, thresholds.expectedWeeks)));
	if (coverage < 1) {
		caveats.push(`fenêtre incomplète (${window.weeks}/${thresholds.expectedWeeks} semaines)`);
	}
	const persistence = Math.max(0, Math.min(1, candidate.weeksSeen / Math.max(1, window.weeks)));
	if (candidate.weeksSeen < window.weeks) {
		caveats.push(`vu ${candidate.weeksSeen}/${window.weeks} semaines de la fenêtre`);
	}
	if (candidate.impressions < thresholds.lowVolumeImpressions) {
		caveats.push(`faible volume (${candidate.impressions} impressions)`);
	}
	const confidence = clampScore(
		coverage * persistence * PRIORITY_WEIGHTS.confidence,
		0,
		PRIORITY_WEIGHTS.confidence
	);

	// strategicFit — la moitié pour « la page capte déjà des clics », la moitié au volume.
	const hasClicks = candidate.clicks > 0 ? 0.5 : 0;
	const volumeFit = Math.min(0.5, (candidate.impressions / Math.max(1, thresholds.lowVolumeImpressions)) * 0.5);
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

// ── Sévérité (plafonnée à faible volume, §10.3 / FIND-002) ──────────

/**
 * Traduit un score de priorité en sévérité. PLAFOND : un signal à faible volume ou
 * à confiance dégradée ne dépasse jamais `medium` — « les findings sans données
 * suffisantes n'atteignent pas une priorité critique » (acceptation FIND-002).
 */
export function deriveOpportunitySeverity(input: {
	priorityScore: number;
	impressions: number;
	thresholds: OpportunityThresholds;
	confidenceScore: number;
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
		input.impressions < input.thresholds.lowVolumeImpressions || input.confidenceScore < 50;
	if (!underpowered) return base;
	return base === 'critical' || base === 'high' ? 'medium' : base;
}

// ── Preuves = POINTEURS (piège DATA-005) ────────────────────────────

export interface OpportunityEvidence {
	detector: string;
	window: { start: string; end: string; weeks: number };
	/** Ids d'observations agrégées (pointeurs, plafonnés pour borner le blob). */
	observationIds: string[];
	observationCount: number;
	metrics: {
		clicks: number;
		impressions: number;
		ctr: number;
		position: number;
		weeksSeen: number;
		gainEstimate: number;
	};
	scoreBreakdown: { impact: number; urgency: number; confidence: number; strategicFit: number };
	confidenceCaveats: string[];
}

/** Plafond d'ids embarqués : les preuves restent des pointeurs, pas un dump. */
export const MAX_EVIDENCE_IDS = 50;

/**
 * Construit les preuves d'un finding : uniquement des identifiants et des mesures,
 * jamais le texte d'un contenu ou d'un avis. Le résultat passe ensuite les gardes
 * `assertBoundedPayload`/`assertNoInlineSecret` de `findings.ts`.
 */
export function buildOpportunityEvidence(input: {
	candidate: OpportunityCandidate;
	window: ObservationWindow;
	score: OpportunityScore;
}): OpportunityEvidence {
	const { candidate, window, score } = input;
	return {
		detector: DETECTOR_KEYWORD_OPPORTUNITY,
		window: { start: window.start, end: window.end, weeks: window.weeks },
		observationIds: candidate.observationIds.slice(0, MAX_EVIDENCE_IDS),
		observationCount: candidate.observationIds.length,
		metrics: {
			clicks: candidate.clicks,
			impressions: candidate.impressions,
			ctr: candidate.ctr,
			position: candidate.position,
			weeksSeen: candidate.weeksSeen,
			gainEstimate: candidate.gainEstimate
		},
		scoreBreakdown: {
			impact: score.impact,
			urgency: score.urgency,
			confidence: score.confidence,
			strategicFit: score.strategicFit
		},
		confidenceCaveats: score.confidenceCaveats
	};
}

/** Titre lisible et STABLE d'un finding d'opportunité (pas de date dedans : il est réécrit à chaque re-détection). */
export function buildOpportunityTitle(candidate: OpportunityCandidate): string {
	return `Opportunité "${candidate.query}" — position ${candidate.position.toFixed(1)}, ${candidate.impressions} impressions`;
}

/** Cause lisible de la détection, journalisée dans `finding_events.reason`. */
export function buildOpportunityReason(
	candidate: OpportunityCandidate,
	thresholds: OpportunityThresholds
): string {
	return (
		`${candidate.impressions} impressions ≥ ${thresholds.minImpressions}, ` +
		`position ${candidate.position.toFixed(1)} dans [${thresholds.positionMin}, ${thresholds.positionMax}], ` +
		`CTR ${(candidate.ctr * 100).toFixed(2)}% < cible ${(thresholds.targetCtr * 100).toFixed(0)}% ` +
		`→ ~${candidate.gainEstimate} clics/semaine récupérables`
	);
}
