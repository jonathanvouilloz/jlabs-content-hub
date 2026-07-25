/**
 * IDX-005 — Transitions d'indexation : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), colocalisé avec son détecteur comme
 * `collectors/url-inspection-state.ts` l'est avec son collecteur. `index-transition.ts` lit la base
 * et persiste ; ici on décide **ce qu'une suite d'états d'indexation signifie**.
 *
 * Les trois acceptations IDX-005 s'appuient sur ce module :
 *
 *   1. « une transition stable crée un événement unique » → le fingerprint ne porte QUE
 *      `(type, page, url)` : la même page toujours désindexée redonne la même clé semaine après
 *      semaine, donc un seul finding et un seul `created`. Aucune date, aucun compteur n'entre
 *      dans l'identité — sinon chaque run inventerait un nouveau problème.
 *   2. « une fluctuation isolée baisse la confiance ou attend confirmation » → `confirmTransition`
 *      exige `confirmAfterObservations` observations CONSÉCUTIVES dans le nouvel état. En dessous,
 *      le verdict est `pending` : le fait est dit, mais la confiance est dégradée et la sévérité
 *      plafonnée. Un aller-retour est compté (`flips`) et dégrade encore.
 *   3. « la résolution conserve l'historique complet » → ce module ne résout RIEN (il ne sait pas
 *      écrire) ; il produit la closure que `reconcileDetectionRun` confronte à l'état persisté, et
 *      les preuves restent des POINTEURS vers les observations qui les fondent.
 *
 * Deux règles de lecture portent tout le reste, et toutes deux viennent d'IDX-002 :
 *
 *   - **`unknown` n'est PAS un état.** Une inspection qu'on n'a pas su lire ne rompt pas une série
 *     et ne confirme rien. Ne pas savoir n'est pas un changement — c'est exactement la distinction
 *     que l'union discriminée d'IDX-002 a installée, portée ici à la série temporelle.
 *   - **`excluded` n'est pas `not_indexed`.** « Excluded by 'noindex' tag » est une décision du site
 *     qu'on respecte : elle ne produit aucun finding, et `indexed → excluded` n'est PAS une
 *     désindexation subie. C'est précisément pour ce détecteur que `classifyCoverage` a séparé les
 *     deux classes.
 */
import {
	PRIORITY_WEIGHTS,
	clampScore,
	type FindingSeverity
} from '../finding-state.js';
import type { IndexedClass } from '../collectors/url-inspection-state.js';

// ── Identité versionnée du détecteur ────────────────────────────────

/**
 * Version stockée dans `findings.detector_version`. À incrémenter dès que la sélection, la règle de
 * confirmation ou le scoring change : deux versions restent comparables sur un même jeu
 * d'observations (même discipline que `DETECTOR_KEYWORD_OPPORTUNITY`).
 */
export const DETECTOR_INDEX_TRANSITION = 'index_transition@1';

/** Skill recommandé pour les trois types (catalogue SPEC §10.4). */
export const INDEX_TRANSITION_SKILL = 'seo-index-diagnose';

/**
 * Les trois types du catalogue §10.4 que ce détecteur possède. `canonical_conflict` est une ligne
 * §10.4 distincte (une désaccord de canonical n'est pas une transition) : hors périmètre IDX-005.
 */
export const INDEX_TRANSITION_TYPES = [
	'index_drop',
	'crawled_not_indexed',
	'discovered_not_indexed'
] as const;
export type IndexTransitionType = (typeof INDEX_TRANSITION_TYPES)[number];

// ── Nature d'un « non indexé » ──────────────────────────────────────

/** Sous-familles de `not_indexed` que §10.4 distingue par un type de finding. */
export type NotIndexedKind = 'crawled' | 'discovered' | 'other';

/**
 * Affine `classifyCoverage` SANS la dupliquer : elle reste l'autorité unique de la famille
 * (`indexed`/`not_indexed`/`excluded`/`unknown`), consommée par `indexing-read.ts`. Ici on lit la
 * NUANCE à l'intérieur de `not_indexed`, parce que §10.4 lui donne deux types distincts :
 *
 *   - `crawled`    — « Crawled - currently not indexed » : Google a vu la page et l'a écartée.
 *                    Geste : enrichir le contenu, renforcer le maillage.
 *   - `discovered` — « Discovered - currently not indexed » : Google connaît l'URL mais n'est même
 *                    pas venu. Geste : découverte, budget de crawl, maillage.
 *
 * `other` couvre le reste (« Not found (404) », « URL is unknown to Google »…) : ce module ne lui
 * connaît pas de type propre et ne lui en invente pas. Ces cas ne produisent un finding que s'ils
 * font suite à un état indexé — c'est alors un `index_drop`, ce qu'ils sont réellement.
 */
export function classifyNotIndexedKind(coverageState: string | null): NotIndexedKind {
	if (!coverageState) return 'other';
	const cs = coverageState.toLowerCase();
	if (cs.includes('crawled')) return 'crawled';
	if (cs.includes('discovered')) return 'discovered';
	return 'other';
}

// ── Série d'états d'une URL ─────────────────────────────────────────

/** Une observation d'indexation, réduite à ce que le jugement utilise. */
export interface IndexStatePoint {
	observationId: string;
	observedDate: string;
	coverageState: string | null;
	indexedClass: IndexedClass;
}

/** La série d'une URL, du plus ancien au plus récent. */
export interface IndexStateSeries {
	url: string;
	points: IndexStatePoint[];
}

/**
 * Regroupe des observations par URL et ORDONNE chaque série du plus ancien au plus récent.
 *
 * Le tri est fait ici, pas laissé à la requête : la comparaison d'états consécutifs n'a de sens que
 * sur une série ordonnée, et une fonction pure qui dépendrait de l'ordre d'arrivée de ses lignes ne
 * serait pas rejouable. Départage par `observationId` — deux observations de même date sur la même
 * URL sont impossibles (unique `(project, url, observed_date)`), mais un ordre TOTAL garantit que
 * deux exécutions rendent le même résultat même si l'invariant bougeait.
 */
export function buildStateSeries(rows: (IndexStatePoint & { url: string })[]): IndexStateSeries[] {
	const byUrl = new Map<string, IndexStatePoint[]>();
	for (const row of rows) {
		const list = byUrl.get(row.url);
		const point: IndexStatePoint = {
			observationId: row.observationId,
			observedDate: row.observedDate,
			coverageState: row.coverageState,
			indexedClass: row.indexedClass
		};
		if (list) list.push(point);
		else byUrl.set(row.url, [point]);
	}

	const out: IndexStateSeries[] = [];
	for (const [url, points] of byUrl) {
		points.sort((a, b) =>
			a.observedDate === b.observedDate
				? cmp(a.observationId, b.observationId)
				: cmp(a.observedDate, b.observedDate)
		);
		out.push({ url, points });
	}
	return out.sort((a, b) => cmp(a.url, b.url));
}

function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

// ── Configuration (surchargeable par projet) ────────────────────────

export interface IndexTransitionConfig {
	/**
	 * Observations CONSÉCUTIVES dans le nouvel état avant qu'une transition soit confirmée.
	 * ≥ 2 par défaut : une inspection isolée peut mentir (Google republie ses index en continu),
	 * et crier sur une bascule unique est exactement ce que l'acceptation interdit.
	 */
	confirmAfterObservations: number;
	/** Profondeur d'historique consultée, en jours. Au-delà, c'est de l'archive, pas un état. */
	lookbackDays: number;
	/**
	 * Clics GSC (fenêtre récente) à partir desquels une page est tenue pour STRATÉGIQUE.
	 * Dérivé, donc disponible sans configuration — mais surchargeable, parce qu'une page de
	 * conversion (devis, contact) peut être stratégique sans capter un seul clic organique.
	 */
	strategicMinClicks: number;
	/**
	 * Pages stratégiques déclarées explicitement (URLs). Vide par défaut : on ne devine jamais la
	 * stratégie d'un projet, on la mesure — et on laisse la déclarer.
	 */
	strategicPages: string[];
	/** Plafond de findings écrits par run et par projet (jamais une troncature silencieuse). */
	maxCandidates: number;
}

export const INDEX_TRANSITION_DEFAULTS: IndexTransitionConfig = {
	confirmAfterObservations: 2,
	lookbackDays: 90,
	strategicMinClicks: 5,
	strategicPages: [],
	maxCandidates: 50
};

/**
 * Fusionne des overrides projet aux défauts. Même idiome tolérant que `resolveThresholds`
 * (`detector-state.ts`) : toute valeur non finie, non entière ou < 1 retombe sur le défaut. Un
 * override corrompu ne doit jamais DÉSACTIVER une garde — `confirmAfterObservations = 0` ferait
 * exactement ce que le lot existe pour empêcher.
 */
export function resolveIndexTransitionConfig(
	overrides?: Partial<IndexTransitionConfig> | null
): IndexTransitionConfig {
	const out: IndexTransitionConfig = { ...INDEX_TRANSITION_DEFAULTS, strategicPages: [] };
	if (!overrides) return out;
	for (const key of Object.keys(INDEX_TRANSITION_DEFAULTS) as (keyof IndexTransitionConfig)[]) {
		if (key === 'strategicPages') continue;
		const value = overrides[key];
		if (typeof value !== 'number' || !Number.isFinite(value)) continue;
		const rounded = Math.floor(value);
		if (rounded < 1) continue;
		(out[key] as number) = rounded;
	}
	if (Array.isArray(overrides.strategicPages)) {
		out.strategicPages = overrides.strategicPages
			.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
			.map((p) => p.trim());
	}
	return out;
}

// ── Confirmation d'une transition ───────────────────────────────────

/** Verdict de confirmation : le fait est-il assez stable pour être affirmé ? */
export type ConfirmationStatus = 'confirmed' | 'pending';

export interface TransitionVerdict {
	url: string;
	/** Type de finding à produire. */
	type: IndexTransitionType;
	/** Classe actuelle (toujours `not_indexed` : c'est la seule qui produise un finding). */
	currentClass: IndexedClass;
	/** Classe qui précédait immédiatement, `null` si la série n'en connaît pas d'autre. */
	previousClass: IndexedClass | null;
	/** `coverageState` brut de la dernière observation (trace lisible). */
	coverageState: string | null;
	kind: NotIndexedKind;
	status: ConfirmationStatus;
	/** Longueur de la série consécutive dans l'état courant (hors `unknown`). */
	streak: number;
	/** Seuil de confirmation appliqué. */
	required: number;
	/** Changements de classe sur la fenêtre : une page qui oscille est moins fiable. */
	flips: number;
	/** Observations ignorées parce qu'illisibles (`unknown`) — elles ne sont pas un état. */
	unknownSkipped: number;
	/** Date de la première observation du streak courant : quand le problème a commencé. */
	since: string;
	/** Date de la dernière observation retenue. */
	lastObservedDate: string;
	/** Pointeurs vers les observations qui fondent le verdict (les plus récentes d'abord). */
	observationIds: string[];
	/** Confiance 0–100, DÉRIVÉE (jamais stockée). */
	confidenceScore: number;
	/** Raisons lisibles de la dégradation de confiance (vide si pleine confiance). */
	confidenceCaveats: string[];
}

/**
 * Décide si la série d'une URL constitue un problème d'indexation, et s'il est confirmé.
 *
 * Rend `null` quand il n'y a rien à dire — et c'est la majorité des cas :
 *   - la page est indexée (aucun problème) ;
 *   - la page est `excluded` (décision du site, respectée) ;
 *   - la série ne contient QUE des `unknown` (on ne sait rien : ne pas savoir n'est pas un fait) ;
 *   - la page est `not_indexed` de nature `other` sans avoir jamais été indexée — ce module ne lui
 *     connaît pas de type §10.4 et n'en invente pas.
 *
 * ⚠ Le filtre `unknown` vient EN PREMIER : une inspection illisible intercalée entre deux
 * `not_indexed` ne doit ni casser le streak ni compter comme une confirmation. Sans cette règle, une
 * erreur de lecture suffirait à repousser indéfiniment la confirmation d'une vraie désindexation.
 */
export function confirmTransition(
	series: IndexStateSeries,
	config: IndexTransitionConfig
): TransitionVerdict | null {
	// `unknown` n'est pas un état : on le retire de la série AVANT tout raisonnement, et on garde
	// son compte comme caveat de confiance.
	const known = series.points.filter((p) => p.indexedClass !== 'unknown');
	const unknownSkipped = series.points.length - known.length;
	if (known.length === 0) return null;

	const last = known[known.length - 1];
	if (last.indexedClass === 'indexed' || last.indexedClass === 'excluded') return null;

	// Streak : combien d'observations consécutives (les plus récentes) partagent la classe courante.
	let streak = 1;
	for (let i = known.length - 2; i >= 0; i -= 1) {
		if (known[i].indexedClass !== last.indexedClass) break;
		streak += 1;
	}
	const streakStart = known[known.length - streak];
	const previous = known.length > streak ? known[known.length - streak - 1] : null;

	// Oscillations sur toute la fenêtre : une page qui bat entre indexée et non indexée est une
	// mesure moins fiable qu'une page franchement tombée.
	let flips = 0;
	for (let i = 1; i < known.length; i += 1) {
		if (known[i].indexedClass !== known[i - 1].indexedClass) flips += 1;
	}

	const kind = classifyNotIndexedKind(last.coverageState);
	const droppedFromIndexed = previous?.indexedClass === 'indexed';

	// Le TYPE dit ce qui s'est passé, pas seulement ce qu'on voit. Une page tombée d'`indexed` est
	// un `index_drop` quelle que soit la nuance de coverage : c'est la perte qui compte. Une page
	// jamais indexée relève de sa nuance — et si elle n'en a pas, on se tait.
	let type: IndexTransitionType;
	if (droppedFromIndexed) type = 'index_drop';
	else if (kind === 'crawled') type = 'crawled_not_indexed';
	else if (kind === 'discovered') type = 'discovered_not_indexed';
	else return null;

	const required = Math.max(1, Math.floor(config.confirmAfterObservations));
	const status: ConfirmationStatus = streak >= required ? 'confirmed' : 'pending';

	const caveats: string[] = [];
	if (status === 'pending') {
		caveats.push(
			`non confirmé : ${streak} observation(s) consécutive(s) sur ${required} requises`
		);
	}
	if (flips >= 2) {
		caveats.push(`état instable : ${flips} changements de classe sur la fenêtre`);
	}
	if (unknownSkipped > 0) {
		caveats.push(`${unknownSkipped} inspection(s) illisible(s) ignorée(s)`);
	}
	if (known.length === 1) {
		caveats.push('une seule observation connue : aucun état antérieur à comparer');
	}

	return {
		url: series.url,
		type,
		currentClass: last.indexedClass,
		previousClass: previous?.indexedClass ?? null,
		coverageState: last.coverageState,
		kind,
		status,
		streak,
		required,
		flips,
		unknownSkipped,
		since: streakStart.observedDate,
		lastObservedDate: last.observedDate,
		// Les plus récentes d'abord : on vient chercher ce qui vient de se passer.
		observationIds: known
			.slice(-Math.max(streak + 1, 2))
			.map((p) => p.observationId)
			.reverse(),
		confidenceScore: computeTransitionConfidence({
			streak,
			required,
			flips,
			unknownSkipped,
			knownPoints: known.length
		}),
		confidenceCaveats: caveats
	};
}

/**
 * Confiance 0–100, DÉRIVÉE à chaque run et jamais stockée (doctrine JOB-004/005 : deux états qui
 * divergent valent moins qu'un seul qui se recalcule).
 *
 * Trois choses la font baisser, et ce sont exactement les trois façons dont cette mesure peut
 * mentir : un streak trop court (le fait n'est pas confirmé), des oscillations (Google n'est pas
 * fixé), des inspections illisibles (on a des trous). Une série d'un seul point est plafonnée à 40 :
 * une observation isolée ne prouve pas une transition, elle la suggère.
 */
export function computeTransitionConfidence(input: {
	streak: number;
	required: number;
	flips: number;
	unknownSkipped: number;
	knownPoints: number;
}): number {
	const coverage = Math.min(1, input.streak / Math.max(1, input.required));
	let score = coverage * 100;
	score -= Math.min(30, input.flips * 10);
	score -= Math.min(20, input.unknownSkipped * 10);
	if (input.knownPoints <= 1) score = Math.min(score, 40);
	return clampScore(score);
}

// ── Page stratégique ────────────────────────────────────────────────

/** Contexte de décision « cette page compte-t-elle ? ». */
export interface StrategicContext {
	/** Clics GSC par URL sur la fenêtre récente. Vide = aucune page stratégique dérivée. */
	clicksByUrl: Map<string, number>;
	/** URLs déclarées stratégiques (déjà normalisées comme les clés de `clicksByUrl`). */
	declared: Set<string>;
	minClicks: number;
}

export interface StrategicVerdict {
	strategic: boolean;
	/** `'declared'` | `'clicks'` | `null` — chaque sélection expose sa raison. */
	reason: 'declared' | 'clicks' | null;
	clicks: number;
}

/**
 * Une page est stratégique si elle est DÉCLARÉE, ou si elle capte assez de clics organiques.
 *
 * Un projet sans donnée GSC et sans déclaration n'a donc AUCUNE page stratégique — état à part,
 * jamais « toutes ». Le défaut permissif serait le pire des deux mondes : il ferait passer chaque
 * désindexation pour une urgence critique, et l'alerte qui crie toujours n'est plus lue.
 *
 * L'appelant passe des URLs déjà normalisées (cf. `normalizeUrl` de `sitemap-state.ts`) : comparer
 * `…/page` à `…/page#a` ferait manquer la page qu'on cherche précisément à protéger.
 */
export function decideStrategic(url: string, ctx: StrategicContext): StrategicVerdict {
	const clicks = ctx.clicksByUrl.get(url) ?? 0;
	if (ctx.declared.has(url)) return { strategic: true, reason: 'declared', clicks };
	if (clicks >= ctx.minClicks && ctx.minClicks > 0) {
		return { strategic: true, reason: 'clicks', clicks };
	}
	return { strategic: false, reason: null, clicks };
}

// ── Score et sévérité ───────────────────────────────────────────────

export interface TransitionScore {
	impact: number;
	urgency: number;
	confidence: number;
	strategicFit: number;
}

/**
 * Urgence par TYPE — le barème §10.2 veut une urgence explicable, pas un réglage caché.
 * Perdre une page indexée est le cas urgent ; une page crawlée puis écartée demande du travail
 * éditorial ; une page seulement découverte relève du maillage et du budget de crawl.
 */
const URGENCY_BY_TYPE: Record<IndexTransitionType, number> = {
	index_drop: PRIORITY_WEIGHTS.urgency,
	crawled_not_indexed: Math.round(PRIORITY_WEIGHTS.urgency * 0.6),
	discovered_not_indexed: Math.round(PRIORITY_WEIGHTS.urgency * 0.35)
};

/**
 * Les 4 composantes du barème §10.2, à sommer par `finding-state.computePriorityScore` (jamais
 * réimplémenté ici) :
 *
 *   - impact       : ce qui est perdu — les clics que la page captait ;
 *   - urgency      : la nature de la transition (cf. `URGENCY_BY_TYPE`) ;
 *   - confidence   : la confiance dérivée, ramenée à son plafond ;
 *   - strategicFit : plein si la page est stratégique, proportionnel aux clics sinon.
 */
export function scoreTransition(input: {
	verdict: TransitionVerdict;
	strategic: StrategicVerdict;
	config: IndexTransitionConfig;
}): TransitionScore {
	const { verdict, strategic, config } = input;
	const clickRef = Math.max(1, config.strategicMinClicks);

	const impact = clampScore(
		Math.min(1, strategic.clicks / clickRef) * PRIORITY_WEIGHTS.impact,
		0,
		PRIORITY_WEIGHTS.impact
	);
	const urgency = clampScore(URGENCY_BY_TYPE[verdict.type], 0, PRIORITY_WEIGHTS.urgency);
	const confidence = clampScore(
		(verdict.confidenceScore / 100) * PRIORITY_WEIGHTS.confidence,
		0,
		PRIORITY_WEIGHTS.confidence
	);
	const strategicFit = strategic.strategic
		? PRIORITY_WEIGHTS.strategicFit
		: clampScore(
				Math.min(1, strategic.clicks / clickRef) * PRIORITY_WEIGHTS.strategicFit,
				0,
				PRIORITY_WEIGHTS.strategicFit
			);

	return { impact, urgency, confidence, strategicFit };
}

/**
 * Sévérité, avec le même PLAFOND que `deriveOpportunitySeverity` : un fait NON CONFIRMÉ ou à
 * confiance dégradée ne dépasse jamais `medium`. C'est la moitié « baisse la confiance » de
 * l'acceptation (2) — l'autre moitié étant l'attente de confirmation elle-même.
 *
 * `critical` est RÉSERVÉ au cas que §14.3 veut notifier immédiatement : une désindexation confirmée
 * d'une page stratégique. L'ouvrir plus largement viderait la notification de son sens.
 */
export function deriveTransitionSeverity(input: {
	verdict: TransitionVerdict;
	strategic: boolean;
	priorityScore: number;
}): FindingSeverity {
	const { verdict, strategic, priorityScore } = input;

	const base: FindingSeverity =
		verdict.type === 'index_drop'
			? strategic
				? 'critical'
				: 'high'
			: priorityScore >= 50
				? 'medium'
				: priorityScore >= 25
					? 'low'
					: 'info';

	const underpowered = verdict.status !== 'confirmed' || verdict.confidenceScore < 50;
	if (!underpowered) return base;
	return base === 'critical' || base === 'high' ? 'medium' : base;
}

// ── Notification (le SIGNAL, pas le canal) ──────────────────────────

/**
 * Cause figée d'une notification immédiate — SPEC §14.3 (« désindexation d'une page stratégique »).
 *
 * IDX-005 produit le SIGNAL ; la LIVRAISON appartient à TEL-002 (BLOCKED). Câbler ici un e-mail
 * installerait un second chemin de notification, avec sa propre déduplication, qu'il faudrait
 * défaire au moment de brancher le vrai canal. Le drapeau vit dans les preuves du finding : il est
 * interrogeable en base, et le canal viendra le lire.
 */
export const NOTIFY_IMMEDIATELY_REASON =
	'désindexation confirmée d’une page stratégique (SPEC §14.3)';

/**
 * Vrai si ce finding doit déclencher une notification immédiate dès qu'un canal existe.
 *
 * Les trois conditions sont cumulatives, et « confirmé » n'est pas négociable : notifier sur une
 * fluctuation isolée est précisément la fatigue d'alerte que §14.3 cherche à éviter.
 */
export function shouldNotifyImmediately(input: {
	verdict: TransitionVerdict;
	strategic: boolean;
}): boolean {
	return (
		input.verdict.type === 'index_drop' &&
		input.verdict.status === 'confirmed' &&
		input.strategic
	);
}

// ── Preuves = POINTEURS ─────────────────────────────────────────────

/** Plafond d'ids et de points embarqués : les preuves restent des pointeurs, pas un dump. */
export const MAX_TRANSITION_EVIDENCE_POINTS = 20;

export interface TransitionEvidence {
	detector: string;
	window: { since: string; lastObservedDate: string; lookbackDays: number };
	transition: {
		from: IndexedClass | null;
		to: IndexedClass;
		kind: NotIndexedKind;
		coverageState: string | null;
	};
	confirmation: {
		status: ConfirmationStatus;
		streak: number;
		required: number;
		flips: number;
		unknownSkipped: number;
	};
	strategic: { value: boolean; reason: 'declared' | 'clicks' | null; clicks: number };
	/** Ids d'observations (pointeurs), plafonnés. */
	observationIds: string[];
	observationCount: number;
	/** Série datée, bornée — de quoi relire la transition sans requête supplémentaire. */
	series: { observedDate: string; indexedClass: IndexedClass }[];
	scoreBreakdown: TransitionScore;
	confidenceCaveats: string[];
	/** SPEC §14.3 — le signal ; le canal est TEL-002. */
	notifyImmediately: boolean;
	notifyReason: string | null;
}

/**
 * Construit les preuves : uniquement des identifiants, des dates et des classes — jamais le contenu
 * de la page. Le résultat passe ensuite `assertBoundedPayload`/`assertNoInlineSecret`, appliqués par
 * `upsertFinding`.
 */
export function buildTransitionEvidence(input: {
	verdict: TransitionVerdict;
	strategic: StrategicVerdict;
	score: TransitionScore;
	series: IndexStateSeries;
	config: IndexTransitionConfig;
}): TransitionEvidence {
	const { verdict, strategic, score, series, config } = input;
	return {
		detector: DETECTOR_INDEX_TRANSITION,
		window: {
			since: verdict.since,
			lastObservedDate: verdict.lastObservedDate,
			lookbackDays: config.lookbackDays
		},
		transition: {
			from: verdict.previousClass,
			to: verdict.currentClass,
			kind: verdict.kind,
			coverageState: verdict.coverageState
		},
		confirmation: {
			status: verdict.status,
			streak: verdict.streak,
			required: verdict.required,
			flips: verdict.flips,
			unknownSkipped: verdict.unknownSkipped
		},
		strategic: {
			value: strategic.strategic,
			reason: strategic.reason,
			clicks: strategic.clicks
		},
		observationIds: verdict.observationIds.slice(0, MAX_TRANSITION_EVIDENCE_POINTS),
		observationCount: verdict.observationIds.length,
		series: series.points
			.slice(-MAX_TRANSITION_EVIDENCE_POINTS)
			.map((p) => ({ observedDate: p.observedDate, indexedClass: p.indexedClass })),
		scoreBreakdown: score,
		confidenceCaveats: verdict.confidenceCaveats,
		notifyImmediately: shouldNotifyImmediately({ verdict, strategic: strategic.strategic }),
		notifyReason: shouldNotifyImmediately({ verdict, strategic: strategic.strategic })
			? NOTIFY_IMMEDIATELY_REASON
			: null
	};
}

// ── Libellés ────────────────────────────────────────────────────────

const TITLE_BY_TYPE: Record<IndexTransitionType, string> = {
	index_drop: 'Page désindexée',
	crawled_not_indexed: 'Page crawlée mais non indexée',
	discovered_not_indexed: 'Page découverte mais non crawlée'
};

/**
 * Titre lisible et STABLE : ni date, ni compteur, ni statut de confirmation. Il est réécrit à chaque
 * re-détection (`upsertFinding` rafraîchit `title`) — y glisser une valeur mouvante ferait changer
 * la ligne d'inbox chaque semaine pour un problème qui, lui, n'a pas bougé.
 */
export function buildTransitionTitle(verdict: TransitionVerdict): string {
	return `${TITLE_BY_TYPE[verdict.type]} — ${verdict.url}`;
}

/** Cause lisible de la détection, journalisée dans `finding_events.reason`. */
export function buildTransitionReason(verdict: TransitionVerdict): string {
	const head =
		verdict.previousClass === 'indexed'
			? `indexée puis « ${verdict.coverageState ?? 'état inconnu'} »`
			: `« ${verdict.coverageState ?? 'état inconnu'} » depuis le début de la fenêtre`;
	const tail =
		verdict.status === 'confirmed'
			? `confirmé sur ${verdict.streak} observation(s) consécutive(s) depuis le ${verdict.since}`
			: `NON confirmé (${verdict.streak}/${verdict.required} observations) — en attente`;
	return `${head} ; ${tail}`;
}
