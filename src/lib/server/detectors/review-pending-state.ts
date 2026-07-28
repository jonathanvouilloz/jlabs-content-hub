/**
 * GMB-002 lot 2 — Avis sans réponse : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), colocalisé avec son détecteur comme
 * `index-transition-state.ts` l'est avec le sien. `review-pending.ts` lit la base et persiste ;
 * ici on décide **ce qu'un avis non répondu signifie**.
 *
 * Le lot 1 a rendu la synchro fiable et observable (382 → 3 189 avis, 502 réellement en attente,
 * vérifiés contre l'API Google fiche par fiche). Il n'a rien rendu DÉCIDABLE : le 2★ de Sion du
 * 18/07 était interrogeable en base et n'apparaissait ni dans `/inbox` ni au rapport hebdo. Ce
 * module produit les deux types que §10.4 réserve à ce cas, déjà présents au vocabulaire
 * (`FINDING_TYPES`), donc sans une ligne de DDL.
 *
 * Quatre décisions portent tout le reste :
 *
 *   1. **Les deux types COEXISTENT.** Un avis 2★ de 20 jours produit deux findings. §10.4 leur
 *      donne deux gestes différents — `review_pending_sla` → skill `gmb-review-responder`,
 *      `negative_review` → escalade humaine, PAS de skill. Faire absorber l'un par l'autre
 *      déciderait à la place de l'humain lequel est le bon, et masquerait le fait qu'on cherche
 *      justement à voir : « avis négatif EN RETARD » deviendrait indiscernable de « avis négatif
 *      frais ».
 *   2. **`negative_review` vise un avis 1–3★ NON TRAITÉ**, pas un avis 1–3★. La note sélectionne,
 *      l'absence de réponse rend actionnable. Sans ce prédicat, le détecteur écrirait des
 *      centaines de findings permanents que rien ne pourrait jamais résoudre. Les deux types
 *      partagent donc `pendingReviewFilter()` (le handler) ; ce qui les distingue est l'ÂGE
 *      contre la NOTE.
 *   3. **Le glissement de fenêtre ne doit JAMAIS auto-résoudre.** Un avis qui franchit
 *      `slaLookbackDays` sort de la closure ET du scope simultanément. Sans cette symétrie, le
 *      détecteur écrirait « auto-résolu : le signal ne franchit plus les seuils » sur 332 avis
 *      toujours sans réponse — le mensonge exact que la fenêtre existe pour éviter.
 *   4. **Le signal doit être lisible PAR FICHE.** Deux établissements sur six portent 74 % de
 *      l'arriéré (Eaux Vives 190/541, Jonction 179/499) pendant que Lausanne tient 301/302. D'où
 *      le tour d'équité de `selectByLocation`, la part de fiche dans le score, et l'établissement
 *      NOMMÉ dans le titre.
 *
 * ⚠️ **Aucune comparaison lexicale entre `create_time` et une borne au format DB.**
 *    `gmb_reviews.create_time` est stocké en ISO (`…T10:52:48Z`) quand tout le reste du schéma est
 *    au format DB (`YYYY-MM-DD HH:MM:SS`). À l'index 10, `'T'` (0x54) > `' '` (0x20) : c'est
 *    exactement le bug corrigé au lot 1 dans `weekly-report.ts`, où tout avis du même jour que la
 *    borne comptait comme « reçu » quelle que soit son heure. Ici, le SQL ne pré-filtre que sur une
 *    DATE NUE (seul préfixe commun aux deux formes) et tout le jugement d'âge passe par
 *    `parseReviewCreateTime`.
 */
import {
	PRIORITY_WEIGHTS,
	clampScore,
	computePriorityScore,
	deriveFindingFingerprint,
	type FindingSeverity
} from '../finding-state.js';
import { dbTimestampToMs, toDbTimestamp } from '../timestamps.js';

// ── Identité versionnée du détecteur ────────────────────────────────

/**
 * Version stockée dans `findings.detector_version`. À incrémenter dès que la sélection, les seuils
 * ou le scoring changent — deux versions restent comparables sur un même jeu d'avis (même
 * discipline que `DETECTOR_INDEX_TRANSITION`).
 */
export const DETECTOR_REVIEW_PENDING = 'review_pending@1';

/** Types du catalogue §10.4 que ce détecteur possède (déjà dans `FINDING_TYPES`). */
export const REVIEW_PENDING_SLA_TYPE = 'review_pending_sla';
export const NEGATIVE_REVIEW_TYPE = 'negative_review';
export const REVIEW_PENDING_TYPES = [REVIEW_PENDING_SLA_TYPE, NEGATIVE_REVIEW_TYPE] as const;
export type ReviewFindingType = (typeof REVIEW_PENDING_TYPES)[number];

/** L'entité visée : un avis. `'review'` est déjà dans `FINDING_ENTITY_TYPES`. */
export const REVIEW_ENTITY_TYPE = 'review';

/** §10.4 — une réponse en retard se produit ; le skill sait la rédiger. */
export const REVIEW_PENDING_SLA_SKILL = 'gmb-review-responder';

/**
 * §10.4 — pour un avis négatif, l'action prescrite est « escalade humaine ». Constante
 * EXPLICITEMENT nulle, pas une omission : proposer ici `gmb-review-responder` ferait de
 * l'escalade un simple brouillon de plus, et les deux types redeviendraient un seul.
 */
export const NEGATIVE_REVIEW_SKILL: string | null = null;

/** Skill recommandé, par type. */
export function reviewSkill(type: ReviewFindingType): string | null {
	return type === REVIEW_PENDING_SLA_TYPE ? REVIEW_PENDING_SLA_SKILL : NEGATIVE_REVIEW_SKILL;
}

// ── Horodatage : la garde du format mixte ───────────────────────────

const DB_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Instant (ms epoch) d'une valeur temporelle, quelle que soit sa FORME.
 *
 * Trois formes coexistent réellement en base et doivent rendre le même instant :
 *   - ISO Google (`2026-07-18T10:52:48.406099Z`) — ce que `create_time` porte ;
 *   - format DB (`2026-07-18 10:52:48`) — ce que `last_seen_at`, `last_sync_at` et les colonnes
 *     écrites par le hub portent ;
 *   - date nue (`2026-07-18`) — tolérée, lue comme minuit UTC.
 *
 * Le format DB passe par `dbTimestampToMs` et NON par `new Date()` : ECMA-262 parse une date-time
 * sans `Z` en heure LOCALE, ce qui décalerait la valeur d'une à deux heures à Zurich selon la
 * saison. Rend `null` sur illisible — jamais une date inventée, l'appelant compte le cas.
 */
export function parseReviewCreateTime(raw: string | null | undefined): number | null {
	if (typeof raw !== 'string') return null;
	const value = raw.trim();
	if (value.length === 0) return null;
	if (DB_TIMESTAMP_RE.test(value)) {
		const ms = dbTimestampToMs(value);
		return Number.isNaN(ms) ? null : ms;
	}
	if (DATE_ONLY_RE.test(value)) {
		const ms = Date.parse(`${value}T00:00:00Z`);
		return Number.isNaN(ms) ? null : ms;
	}
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Borne inférieure d'une fenêtre, en DATE NUE `YYYY-MM-DD`.
 *
 * C'est le SEUL pré-filtre SQL sûr sur `create_time` : `'2026-01-29T08:00:00Z' >= '2026-01-29'` et
 * `'2026-01-29 08:00:00' >= '2026-01-29'` sont vrais tous les deux. Une borne au format DB
 * exclurait à tort les lignes ISO du jour de bord, une borne ISO exclurait les lignes DB — le bug
 * du lot 1, rejoué dans un sens puis dans l'autre.
 */
export function reviewSinceBound(now: Date, days: number): string {
	const span = Math.max(0, Math.floor(days));
	return new Date(now.getTime() - span * DAY_MS).toISOString().slice(0, 10);
}

/** Âge en jours pleins entre deux instants (jamais négatif : un avis « du futur » a 0 jour). */
export function reviewAgeDays(createdMs: number, nowMs: number): number {
	return Math.max(0, Math.floor((nowMs - createdMs) / DAY_MS));
}

/** Date lisible `YYYY-MM-DD` d'un instant — sert au titre, qui doit rester STABLE. */
export function reviewDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

// ── Seuils (surchargeables par projet) ──────────────────────────────

export interface ReviewPendingThresholds {
	/**
	 * Jours sans réponse au-delà desquels l'avis est en retard. 3 par défaut : le geste est humain
	 * et hebdomadaire côté client, mais un avis Google reste visible en permanence — trois jours de
	 * silence sont déjà lisibles par le prochain visiteur.
	 */
	slaDays: number;
	/**
	 * Profondeur de la fenêtre SLA, en jours. 180 par défaut, et c'est LE réglage porteur du lot :
	 * l'arriéré réel est de 502 avis (332 d'avant 2025 pour le seul `barberconcept`). Sans cette
	 * borne, la closure contiendrait 499 entrées et l'inbox deviendrait un inventaire. Au-delà, les
	 * avis restent un stock consultable à l'écran, jamais une alerte.
	 */
	slaLookbackDays: number;
	/** Note maximale d'un avis « négatif » — §10.4 dit « note 1–3 ». */
	negativeRatingMax: number;
	/**
	 * Note maximale déclenchant une notification immédiate — §14.3 dit « 1–2 étoiles ». Distinct de
	 * `negativeRatingMax` À DESSEIN : les deux paragraphes de la SPEC ne disent pas la même chose, et
	 * les confondre ferait ou bien taire les 3★, ou bien réveiller la nuit pour un 3★.
	 */
	notifyRatingMax: number;
	/** Profondeur de la fenêtre « avis négatif ». Plus longue que le SLA : un 1★ vieillit mal. */
	negativeLookbackDays: number;
	/**
	 * Fraîcheur de synchro exigée pour qu'une fiche soit dans la portée du run. 48 h = deux passages
	 * de la collecte quotidienne, donc une marge d'un cycle manqué.
	 */
	syncFreshnessHours: number;
	/** Note minimale lisible. `rating = 0` est une donnée illisible, pas le pire avis du parc. */
	minRating: number;
	/** Findings écrits par run, par projet et PAR TYPE (jamais une troncature silencieuse). */
	maxCandidates: number;
}

export const REVIEW_PENDING_DEFAULTS: ReviewPendingThresholds = {
	slaDays: 3,
	slaLookbackDays: 180,
	negativeRatingMax: 3,
	notifyRatingMax: 2,
	negativeLookbackDays: 365,
	syncFreshnessHours: 48,
	minRating: 1,
	maxCandidates: 30
};

/** Bornes dures des seuils de note : un override ne doit jamais désarmer une garde. */
const RATING_BOUNDS = { min: 1, max: 5 } as const;

/**
 * Fusionne des overrides projet aux défauts. Même idiome tolérant que
 * `resolveIndexTransitionConfig` : toute valeur non finie, non entière ou < 1 retombe sur le
 * défaut.
 *
 * En PLUS ici : les deux seuils de note sont bornés à [1, 5]. Un `negativeRatingMax: 9` ne serait
 * pas une valeur absurde rejetée par le filtre générique (elle est finie, entière, ≥ 1) — elle
 * ferait simplement de TOUT avis un avis négatif. C'est le mode de défaillance exact que la règle
 * « un override ne désactive jamais une garde » existe pour couvrir.
 */
export function resolveReviewPendingThresholds(
	overrides?: Partial<ReviewPendingThresholds> | null
): ReviewPendingThresholds {
	const out = { ...REVIEW_PENDING_DEFAULTS };
	if (!overrides) return out;
	for (const key of Object.keys(REVIEW_PENDING_DEFAULTS) as (keyof ReviewPendingThresholds)[]) {
		const value = overrides[key];
		if (typeof value !== 'number' || !Number.isFinite(value)) continue;
		const rounded = Math.floor(value);
		if (rounded < 1) continue;
		out[key] = rounded;
	}
	out.negativeRatingMax = Math.min(RATING_BOUNDS.max, Math.max(RATING_BOUNDS.min, out.negativeRatingMax));
	out.notifyRatingMax = Math.min(RATING_BOUNDS.max, Math.max(RATING_BOUNDS.min, out.notifyRatingMax));
	out.minRating = Math.min(RATING_BOUNDS.max, Math.max(RATING_BOUNDS.min, out.minRating));
	return out;
}

// ── Entrées du jugement ─────────────────────────────────────────────

/** Un avis, réduit à ce que le jugement utilise. Ni auteur, ni commentaire : cf. `buildReviewEvidence`. */
export interface ReviewRow {
	reviewId: string;
	locationId: string;
	locationLabel: string;
	rating: number;
	createTime: string;
	/** Marqueur LOCAL (« le hub a envoyé »). Contaminé sur les lignes antérieures à GMB-002. */
	repliedAt: string | null;
	/** État DISTANT (« Google montre une réponse »). */
	remoteReplyAt: string | null;
	/** Dernière fois que Google a renvoyé cette ligne. NULL ⇒ hors scope ET hors closure. */
	lastSeenAt: string | null;
	/** Un brouillon existe côté hub — le fait est utile, son TEXTE ne l'est pas. */
	hasDraft: boolean;
}

/** La santé de synchro d'une fiche : elle porte le `scope` du run. */
export interface LocationHealth {
	locationId: string;
	label: string;
	lastSyncAt: string | null;
	lastSyncStatus: string | null;
}

/** L'arriéré d'une fiche, TOUTES périodes confondues (cf. requête B du handler). */
export interface LocationBacklog {
	locationId: string;
	total: number;
	pending: number;
}

// ── Portée d'une fiche ──────────────────────────────────────────────

export interface LocationScopeVerdict {
	fresh: boolean;
	/** `null` si la fiche n'a jamais été synchronisée. */
	lastSyncMs: number | null;
	hoursSinceSync: number | null;
	reason: 'never_synced' | 'sync_error' | 'stale' | null;
}

/**
 * Une fiche est dans la portée du run si sa dernière synchro a RÉUSSI et qu'elle est récente.
 *
 * Les deux conditions sont indissociables, et c'est le piège du lot : `collect:gmb_reviews` écrit
 * `last_sync_at` **aussi en cas d'échec** (c'est ce qui rend la panne observable). La date seule
 * dirait donc « synchronisée » d'une fiche en panne depuis avril, et le détecteur se croirait
 * autoritaire sur des avis dont il ne sait plus rien.
 */
export function decideLocationScope(input: {
	health: LocationHealth | undefined;
	nowMs: number;
	freshnessHours: number;
}): LocationScopeVerdict {
	const { health, nowMs, freshnessHours } = input;
	if (!health || !health.lastSyncAt) {
		return { fresh: false, lastSyncMs: null, hoursSinceSync: null, reason: 'never_synced' };
	}
	const lastSyncMs = parseReviewCreateTime(health.lastSyncAt);
	if (lastSyncMs === null) {
		return { fresh: false, lastSyncMs: null, hoursSinceSync: null, reason: 'never_synced' };
	}
	const hoursSinceSync = Math.max(0, (nowMs - lastSyncMs) / 3_600_000);
	if (health.lastSyncStatus !== 'success') {
		return { fresh: false, lastSyncMs, hoursSinceSync, reason: 'sync_error' };
	}
	if (hoursSinceSync > freshnessHours) {
		return { fresh: false, lastSyncMs, hoursSinceSync, reason: 'stale' };
	}
	return { fresh: true, lastSyncMs, hoursSinceSync, reason: null };
}

// ── Confiance ───────────────────────────────────────────────────────

/**
 * Confiance 0–100, DÉRIVÉE à chaque run et jamais stockée.
 *
 * UNE seule chose peut faire mentir ce signal, et c'est la synchro qui vieillit : entre le dernier
 * passage et maintenant, l'avis a pu recevoir sa réponse directement dans l'application Google,
 * sans que le hub en sache rien (c'est précisément ce que `remote_reply_at` a servi à découvrir au
 * lot 1). Le reste du raisonnement ne repose sur aucune estimation : la note et la date viennent de
 * Google, l'absence de réponse est un fait à deux sources.
 *
 * La pénalité va jusqu'à 60 points au bord de la fenêtre de fraîcheur, ce qui fait passer la
 * confiance sous 50 quand la collecte a effectivement manqué son cycle — et à ce moment-là la
 * sévérité est plafonnée. Un 1★ trouvé sur un état vieux de deux jours ne mérite pas d'être crié
 * `critical` : il mérite d'être vu, et vérifié.
 */
export function computeReviewConfidence(input: {
	hoursSinceSync: number | null;
	freshnessHours: number;
}): { score: number; caveats: string[] } {
	const caveats: string[] = [];
	const freshness = Math.max(1, input.freshnessHours);
	const hours = input.hoursSinceSync ?? freshness;
	const penalty = Math.min(60, Math.round((hours / freshness) * 60));
	if (penalty >= 15) {
		caveats.push(
			`état distant lu il y a ${Math.round(hours)} h : une réponse publiée depuis chez Google ne serait pas encore connue`
		);
	}
	return { score: clampScore(100 - penalty), caveats };
}

// ── Score et sévérité ───────────────────────────────────────────────

export interface ReviewScore {
	impact: number;
	urgency: number;
	confidence: number;
	strategicFit: number;
}

/**
 * Les 4 composantes du barème §10.2, à sommer par `computePriorityScore` (jamais réimplémenté) :
 *
 *   - impact       : la note (ce que l'avis dit du commerce) PONDÉRÉE par la part d'arriéré de sa
 *                    fiche. C'est la contrainte « par fiche » traduite en score : à note égale, un
 *                    avis d'Eaux Vives (35 % d'arriéré) remonte sur un avis de Lausanne (0,3 %) ;
 *   - urgency      : le retard pour le SLA, la note pour le négatif — §10.4 range sa confirmation
 *                    en « immédiat », donc son urgence est intrinsèque et non temporelle ;
 *   - confidence   : la confiance dérivée, ramenée à son plafond ;
 *   - strategicFit : plein pour un avis négatif (§14.3 en fait le domaine de ce détecteur),
 *                    proportionnel à la part d'arriéré sinon.
 */
export function scoreReviewUnit(input: {
	type: ReviewFindingType;
	rating: number;
	overdueBy: number;
	locationShare: number;
	confidenceScore: number;
	thresholds: ReviewPendingThresholds;
}): ReviewScore {
	const { type, rating, overdueBy, locationShare, confidenceScore, thresholds } = input;
	const ratingWeight = Math.min(1, Math.max(0, (6 - rating) / 5));
	const share = Math.min(1, Math.max(0, locationShare));

	const impact = clampScore(
		(ratingWeight * 0.7 + share * 0.3) * PRIORITY_WEIGHTS.impact,
		0,
		PRIORITY_WEIGHTS.impact
	);

	const urgency =
		type === REVIEW_PENDING_SLA_TYPE
			? clampScore(
					Math.min(1, overdueBy / Math.max(1, thresholds.slaDays * 4)) * PRIORITY_WEIGHTS.urgency,
					0,
					PRIORITY_WEIGHTS.urgency
				)
			: clampScore(
					rating <= thresholds.notifyRatingMax
						? PRIORITY_WEIGHTS.urgency
						: PRIORITY_WEIGHTS.urgency * 0.6,
					0,
					PRIORITY_WEIGHTS.urgency
				);

	const confidence = clampScore(
		(confidenceScore / 100) * PRIORITY_WEIGHTS.confidence,
		0,
		PRIORITY_WEIGHTS.confidence
	);

	const strategicFit =
		type === NEGATIVE_REVIEW_TYPE
			? PRIORITY_WEIGHTS.strategicFit
			: clampScore(share * PRIORITY_WEIGHTS.strategicFit, 0, PRIORITY_WEIGHTS.strategicFit);

	return { impact, urgency, confidence, strategicFit };
}

/**
 * Sévérité, avec le même PLAFOND que `deriveTransitionSeverity` : une confiance dégradée ne
 * dépasse jamais `medium`.
 *
 * `critical` est RÉSERVÉ au cas que §14.3 veut notifier immédiatement — un avis 1–2★ sans réponse.
 * Un `review_pending_sla` ne l'atteint donc JAMAIS : un 5★ non répondu depuis trois mois est un
 * manquement, pas une urgence de nuit, et ouvrir `critical` plus largement viderait la
 * notification de son sens.
 */
export function deriveReviewSeverity(input: {
	type: ReviewFindingType;
	rating: number;
	overdueBy: number;
	confidenceScore: number;
	thresholds: ReviewPendingThresholds;
}): FindingSeverity {
	const { type, rating, overdueBy, confidenceScore, thresholds } = input;

	let base: FindingSeverity;
	if (type === NEGATIVE_REVIEW_TYPE) {
		base = rating <= thresholds.notifyRatingMax ? 'critical' : 'high';
	} else if (overdueBy >= thresholds.slaDays * 4 || rating <= thresholds.negativeRatingMax) {
		base = 'high';
	} else if (overdueBy >= thresholds.slaDays) {
		base = 'medium';
	} else {
		base = 'low';
	}

	if (confidenceScore >= 50) return base;
	return base === 'critical' || base === 'high' ? 'medium' : base;
}

// ── Notification (le SIGNAL, pas le canal) ──────────────────────────

/**
 * Cause figée d'une notification immédiate — SPEC §14.3 (« avis 1–2 étoiles »).
 *
 * Ce lot produit le SIGNAL ; la LIVRAISON appartient à TEL-002 (BLOCKED). Câbler ici un e-mail
 * installerait un second chemin de notification, avec sa propre déduplication, qu'il faudrait
 * défaire au moment de brancher le vrai canal. Le drapeau vit dans les preuves : il est
 * interrogeable en base, et le canal viendra le lire. Même position qu'IDX-005.
 */
export const NOTIFY_IMMEDIATELY_REASON = 'avis 1–2 étoiles sans réponse (SPEC §14.3)';

/** Vrai si ce finding doit déclencher une notification immédiate dès qu'un canal existe. */
export function shouldNotifyImmediately(input: {
	type: ReviewFindingType;
	rating: number;
	notifyRatingMax: number;
}): boolean {
	return input.type === NEGATIVE_REVIEW_TYPE && input.rating <= input.notifyRatingMax;
}

// ── Unité jugée ─────────────────────────────────────────────────────

/** Un avis retenu pour un type donné, avec tout ce qui fonde son finding. */
export interface ReviewUnit {
	type: ReviewFindingType;
	fingerprint: string;
	reviewId: string;
	locationId: string;
	locationLabel: string;
	rating: number;
	/** `create_time` brut, tel que Google l'a envoyé. */
	createdAtRaw: string;
	/** Le même instant au format DB — la forme comparable au reste du schéma. */
	createdAtDb: string;
	/** `YYYY-MM-DD` — la seule part de la date qui entre dans le titre. */
	createdDate: string;
	ageDays: number;
	/** Jours au-delà du SLA. Toujours ≥ 0 ; vaut 0 pour un négatif encore dans les délais. */
	overdueBy: number;
	slaBreached: boolean;
	hasDraft: boolean;
	backlog: { pending: number; total: number; share: number };
	health: { lastSyncAt: string | null; lastSyncStatus: string | null; hoursSinceSync: number | null };
	lastSeenAt: string | null;
	confidenceScore: number;
	confidenceCaveats: string[];
	score: ReviewScore;
	priorityScore: number;
	severity: FindingSeverity;
	notifyImmediately: boolean;
}

/** Fingerprint STABLE d'un avis pour un type. */
export function reviewFingerprint(
	type: ReviewFindingType,
	reviewId: string,
	locationId: string
): string {
	return deriveFindingFingerprint({
		type,
		entityType: REVIEW_ENTITY_TYPE,
		entityKey: reviewId,
		discriminators: [locationId]
	});
}

// ── Sélection : plafond et tour d'équité ────────────────────────────

export interface ReviewSelection {
	/** Ce qu'on écrit : au plus `maxCandidates`, réparti entre les fiches. */
	units: ReviewUnit[];
	/** TOUT ce qui franchit les seuils, avant plafond — c'est ça, la closure. */
	matched: ReviewUnit[];
	totalMatched: number;
	truncated: boolean;
}

/**
 * Applique le plafond en donnant la parole à CHAQUE fiche, par tour.
 *
 * Sans ce tour, les 30 places de `barberconcept` iraient toutes à Eaux Vives (190 avis en attente)
 * et le 2★ de Sion serait tronqué — c'est-à-dire précisément le fait que le lot 1 a mis quatre mois
 * à découvrir, et l'acceptation « le signal doit être lisible par fiche » se retournerait contre
 * elle-même. Aucun autre détecteur du parc n'a de quota par sous-entité : c'est une décision de ce
 * lot, tracée dans `DECISIONS.md`.
 *
 * L'ordre est TOTAL à deux niveaux — candidats par (priorité desc, `reviewId` asc), fiches par
 * `locationId` asc — sinon le plafond retiendrait un lot différent à chaque exécution sur les mêmes
 * données, et l'inbox clignoterait d'un run à l'autre. L'ordre des fiches est volontairement
 * NEUTRE (l'identifiant, pas l'arriéré) : classer les fiches par volume redonnerait au plus gros
 * l'avantage que le tour existe pour retirer.
 *
 * ⚠️ `matched` reste intégral : le tour d'équité ne ferme rien. Un fingerprint absent d'une closure
 * tronquée passerait pour guéri (leçon FIND-003).
 */
export function selectByLocation(units: ReviewUnit[], maxCandidates: number): ReviewSelection {
	const matched = [...units].sort((a, b) =>
		b.priorityScore !== a.priorityScore
			? b.priorityScore - a.priorityScore
			: a.reviewId < b.reviewId
				? -1
				: a.reviewId > b.reviewId
					? 1
					: 0
	);
	const cap = Math.max(0, Math.floor(maxCandidates));
	if (matched.length <= cap) {
		return { units: matched, matched, totalMatched: matched.length, truncated: false };
	}

	const byLocation = new Map<string, ReviewUnit[]>();
	for (const unit of matched) {
		const list = byLocation.get(unit.locationId);
		if (list) list.push(unit);
		else byLocation.set(unit.locationId, [unit]);
	}
	const queues = [...byLocation.keys()].sort().map((id) => byLocation.get(id)!);

	const kept: ReviewUnit[] = [];
	const cursors = new Array<number>(queues.length).fill(0);
	let progressed = true;
	while (kept.length < cap && progressed) {
		progressed = false;
		for (let i = 0; i < queues.length && kept.length < cap; i += 1) {
			const cursor = cursors[i];
			if (cursor >= queues[i].length) continue;
			kept.push(queues[i][cursor]);
			cursors[i] = cursor + 1;
			progressed = true;
		}
	}

	// Le lot retenu reste rendu dans l'ordre de priorité : le tour décide QUI entre, pas dans quel
	// ordre l'inbox le lit.
	kept.sort((a, b) =>
		b.priorityScore !== a.priorityScore
			? b.priorityScore - a.priorityScore
			: a.reviewId < b.reviewId
				? -1
				: a.reviewId > b.reviewId
					? 1
					: 0
	);
	return { units: kept, matched, totalMatched: matched.length, truncated: true };
}

// ── La passe complète ───────────────────────────────────────────────

export interface ReviewPendingPassInput {
	reviews: ReviewRow[];
	locations: LocationHealth[];
	backlog: LocationBacklog[];
	thresholds: ReviewPendingThresholds;
	now: Date;
}

export interface ReviewPendingPassResult {
	sla: ReviewSelection;
	negative: ReviewSelection;
	/** Portées d'autorité, par type : un fingerprint absent d'ici est laissé strictement intact. */
	scopeSla: Set<string>;
	scopeNegative: Set<string>;
	reviewsRead: number;
	inScopeSla: number;
	inScopeNegative: number;
	/** Avis lus dont la fiche n'est ni fraîche ni en succès. */
	staleLocation: number;
	/** `last_seen_at IS NULL` : l'état distant n'a jamais été lu pour cette ligne (backfill). */
	neverSeen: number;
	/** Vu pour la dernière fois AVANT la dernière synchro réussie ⇒ disparu chez Google. */
	vanished: number;
	/** Dans la portée, mais hors des deux fenêtres. */
	outOfWindow: number;
	/** Dans la portée d'au moins une fenêtre, et déjà répondu (local ou distant). */
	answered: number;
	/** Sous-ensemble d'`answered` : le hub croit avoir répondu, Google ne le confirme pas (GMB-007). */
	divergent: number;
	unreadableRating: number;
	unreadableCreateTime: number;
	locationsFresh: number;
	locationsStale: number;
}

/**
 * Le jugement complet, sans une ligne de SQL : rend les deux sélections, les deux portées, et les
 * compteurs qui expliquent ce qui n'a PAS produit de finding.
 *
 * Les deux portées diffèrent parce que les deux fenêtres diffèrent : un avis de 200 jours est dans
 * la portée `negative_review` (365 j) et hors de la portée `review_pending_sla` (180 j). C'est ce
 * qui fait que le glissement de fenêtre laisse le finding INTACT au lieu de le résoudre.
 *
 * Une portée contient délibérément les avis DÉJÀ RÉPONDUS de sa fenêtre : c'est exactement ce qui
 * permet à un finding de s'auto-résoudre quand la réponse arrive. Et pour le type négatif, elle
 * contient aussi les avis bien notés — un avis dont la note remonte doit pouvoir se résoudre.
 */
export function runReviewPendingPass(input: ReviewPendingPassInput): ReviewPendingPassResult {
	const { reviews, locations, backlog, thresholds } = input;
	const nowMs = input.now.getTime();

	const healthById = new Map(locations.map((l) => [l.locationId, l]));
	const backlogById = new Map(backlog.map((b) => [b.locationId, b]));

	const scopeVerdicts = new Map<string, LocationScopeVerdict>();
	let locationsFresh = 0;
	let locationsStale = 0;
	for (const location of locations) {
		const verdict = decideLocationScope({
			health: location,
			nowMs,
			freshnessHours: thresholds.syncFreshnessHours
		});
		scopeVerdicts.set(location.locationId, verdict);
		if (verdict.fresh) locationsFresh += 1;
		else locationsStale += 1;
	}

	const scopeSla = new Set<string>();
	const scopeNegative = new Set<string>();
	const slaUnits: ReviewUnit[] = [];
	const negativeUnits: ReviewUnit[] = [];

	const counters = {
		inScopeSla: 0,
		inScopeNegative: 0,
		staleLocation: 0,
		neverSeen: 0,
		vanished: 0,
		outOfWindow: 0,
		answered: 0,
		divergent: 0,
		unreadableRating: 0,
		unreadableCreateTime: 0
	};

	for (const row of reviews) {
		const verdict =
			scopeVerdicts.get(row.locationId) ??
			decideLocationScope({
				health: healthById.get(row.locationId),
				nowMs,
				freshnessHours: thresholds.syncFreshnessHours
			});
		if (!verdict.fresh) {
			counters.staleLocation += 1;
			continue;
		}

		if (!row.lastSeenAt) {
			counters.neverSeen += 1;
			continue;
		}
		const lastSeenMs = parseReviewCreateTime(row.lastSeenAt);
		if (lastSeenMs === null || (verdict.lastSyncMs !== null && lastSeenMs < verdict.lastSyncMs)) {
			// Google ne renvoie plus cette ligne : elle a disparu chez lui. Ce n'est ni une guérison
			// ni un manquement — et on ne DELETE jamais une ligne pour le dire (lot 1).
			counters.vanished += 1;
			continue;
		}

		const createdMs = parseReviewCreateTime(row.createTime);
		if (createdMs === null) {
			counters.unreadableCreateTime += 1;
			continue;
		}
		if (
			!Number.isFinite(row.rating) ||
			row.rating < thresholds.minRating ||
			row.rating > RATING_BOUNDS.max
		) {
			counters.unreadableRating += 1;
			continue;
		}

		const ageDays = reviewAgeDays(createdMs, nowMs);
		const inSlaWindow = ageDays <= thresholds.slaLookbackDays;
		const inNegativeWindow = ageDays <= thresholds.negativeLookbackDays;
		if (!inSlaWindow && !inNegativeWindow) {
			counters.outOfWindow += 1;
			continue;
		}

		// PORTÉE — posée avant toute considération de note ou de réponse : c'est ce sur quoi le run
		// fait autorité, pas ce qu'il dénonce.
		if (inSlaWindow) {
			scopeSla.add(reviewFingerprint(REVIEW_PENDING_SLA_TYPE, row.reviewId, row.locationId));
			counters.inScopeSla += 1;
		}
		if (inNegativeWindow) {
			scopeNegative.add(reviewFingerprint(NEGATIVE_REVIEW_TYPE, row.reviewId, row.locationId));
			counters.inScopeNegative += 1;
		}

		const pending = row.repliedAt === null && row.remoteReplyAt === null;
		if (!pending) {
			counters.answered += 1;
			if (row.repliedAt !== null && row.remoteReplyAt === null) counters.divergent += 1;
			continue;
		}

		const backlogRow = backlogById.get(row.locationId);
		const total = backlogRow?.total ?? 0;
		const share = total > 0 ? (backlogRow?.pending ?? 0) / total : 0;
		const confidence = computeReviewConfidence({
			hoursSinceSync: verdict.hoursSinceSync,
			freshnessHours: thresholds.syncFreshnessHours
		});
		const overdueBy = Math.max(0, ageDays - thresholds.slaDays);

		const shared = {
			reviewId: row.reviewId,
			locationId: row.locationId,
			locationLabel: row.locationLabel,
			rating: row.rating,
			createdAtRaw: row.createTime,
			createdAtDb: toDbTimestamp(new Date(createdMs)),
			createdDate: reviewDate(createdMs),
			ageDays,
			overdueBy,
			slaBreached: ageDays > thresholds.slaDays,
			hasDraft: row.hasDraft,
			backlog: { pending: backlogRow?.pending ?? 0, total, share },
			health: {
				lastSyncAt: healthById.get(row.locationId)?.lastSyncAt ?? null,
				lastSyncStatus: healthById.get(row.locationId)?.lastSyncStatus ?? null,
				hoursSinceSync: verdict.hoursSinceSync
			},
			lastSeenAt: row.lastSeenAt,
			confidenceScore: confidence.score,
			confidenceCaveats: confidence.caveats
		};

		if (inSlaWindow && ageDays > thresholds.slaDays) {
			slaUnits.push(finishUnit(REVIEW_PENDING_SLA_TYPE, shared, thresholds));
		}
		if (
			inNegativeWindow &&
			row.rating <= thresholds.negativeRatingMax &&
			row.rating >= thresholds.minRating
		) {
			negativeUnits.push(finishUnit(NEGATIVE_REVIEW_TYPE, shared, thresholds));
		}
	}

	return {
		sla: selectByLocation(slaUnits, thresholds.maxCandidates),
		negative: selectByLocation(negativeUnits, thresholds.maxCandidates),
		scopeSla,
		scopeNegative,
		reviewsRead: reviews.length,
		locationsFresh,
		locationsStale,
		...counters
	};
}

type SharedUnit = Omit<
	ReviewUnit,
	'type' | 'fingerprint' | 'score' | 'priorityScore' | 'severity' | 'notifyImmediately'
>;

/** Complète une unité partagée avec ce qui dépend du TYPE (score, sévérité, identité). */
function finishUnit(
	type: ReviewFindingType,
	shared: SharedUnit,
	thresholds: ReviewPendingThresholds
): ReviewUnit {
	const score = scoreReviewUnit({
		type,
		rating: shared.rating,
		overdueBy: shared.overdueBy,
		locationShare: shared.backlog.share,
		confidenceScore: shared.confidenceScore,
		thresholds
	});
	// `computePriorityScore` fait la somme bornée du barème §10.2 — jamais réimplémentée ici, sans
	// quoi deux détecteurs finiraient par ne plus produire des scores comparables.
	const priorityScore = computePriorityScore(score);

	return {
		...shared,
		type,
		fingerprint: reviewFingerprint(type, shared.reviewId, shared.locationId),
		score,
		priorityScore,
		severity: deriveReviewSeverity({
			type,
			rating: shared.rating,
			overdueBy: shared.overdueBy,
			confidenceScore: shared.confidenceScore,
			thresholds
		}),
		notifyImmediately: shouldNotifyImmediately({
			type,
			rating: shared.rating,
			notifyRatingMax: thresholds.notifyRatingMax
		})
	};
}

// ── Preuves = POINTEURS et MESURES, jamais du texte ─────────────────

export interface ReviewEvidence {
	detector: string;
	reviewId: string;
	location: { id: string; label: string };
	rating: number;
	createdAtIso: string;
	createdAtDb: string;
	ageDays: number;
	sla: { days: number; overdueBy: number; breached: boolean };
	negative: { value: boolean; ratingMax: number };
	/** La preuve du prédicat : les DEUX sources disent « pas de réponse ». */
	pending: { repliedAt: null; remoteReplyAt: null };
	draft: { present: boolean };
	scope: {
		lastSyncAt: string | null;
		lastSyncStatus: string | null;
		lastSeenAt: string | null;
		hoursSinceSync: number | null;
		freshnessHours: number;
	};
	/** Le fait PAR FICHE : cet avis appartient à un établissement qui en porte N en attente. */
	locationBacklog: { pending: number; total: number; share: number };
	window: { lookbackDays: number };
	scoreBreakdown: ReviewScore;
	confidenceScore: number;
	confidenceCaveats: string[];
	/** SPEC §14.3 — le signal ; le canal est TEL-002. */
	notifyImmediately: boolean;
	notifyReason: string | null;
}

/**
 * Construit les preuves : des identifiants, des dates et des mesures — JAMAIS `comment`,
 * `author_name` ni `draft_reply`.
 *
 * Trois raisons cumulées, et la troisième est décisive : la doctrine du parc (`detector-state.ts` :
 * jamais le texte d'un contenu ou d'un avis), le garde-fou `assertNoInlineSecret` appliqué par
 * `upsertFinding`, et surtout le fait que `finding_events.payload_json` est APPEND-ONLY — une
 * donnée personnelle qu'on y écrit ne s'efface plus. Le finding pointe l'avis par son identifiant ;
 * `/projects/[slug]/reviews` sait afficher le reste.
 */
export function buildReviewEvidence(input: {
	unit: ReviewUnit;
	thresholds: ReviewPendingThresholds;
}): ReviewEvidence {
	const { unit, thresholds } = input;
	return {
		detector: DETECTOR_REVIEW_PENDING,
		reviewId: unit.reviewId,
		location: { id: unit.locationId, label: unit.locationLabel },
		rating: unit.rating,
		createdAtIso: unit.createdAtRaw,
		createdAtDb: unit.createdAtDb,
		ageDays: unit.ageDays,
		sla: { days: thresholds.slaDays, overdueBy: unit.overdueBy, breached: unit.slaBreached },
		negative: {
			value: unit.rating <= thresholds.negativeRatingMax,
			ratingMax: thresholds.negativeRatingMax
		},
		pending: { repliedAt: null, remoteReplyAt: null },
		draft: { present: unit.hasDraft },
		scope: {
			lastSyncAt: unit.health.lastSyncAt,
			lastSyncStatus: unit.health.lastSyncStatus,
			lastSeenAt: unit.lastSeenAt,
			hoursSinceSync:
				unit.health.hoursSinceSync === null ? null : Math.round(unit.health.hoursSinceSync),
			freshnessHours: thresholds.syncFreshnessHours
		},
		locationBacklog: {
			pending: unit.backlog.pending,
			total: unit.backlog.total,
			share: Math.round(unit.backlog.share * 1000) / 1000
		},
		window: {
			lookbackDays:
				unit.type === REVIEW_PENDING_SLA_TYPE
					? thresholds.slaLookbackDays
					: thresholds.negativeLookbackDays
		},
		scoreBreakdown: unit.score,
		confidenceScore: unit.confidenceScore,
		confidenceCaveats: unit.confidenceCaveats,
		notifyImmediately: unit.notifyImmediately,
		notifyReason: unit.notifyImmediately ? NOTIFY_IMMEDIATELY_REASON : null
	};
}

// ── Libellés ────────────────────────────────────────────────────────

/**
 * Titre lisible et STABLE, qui NOMME l'établissement.
 *
 * Nommer la fiche est l'acceptation métier du lot : un titre agrégé au projet dirait
 * « barberconcept a 499 avis en retard » et noierait le fait utile, alors que deux établissements
 * sur six portent 74 % de l'arriéré.
 *
 * ⚠️ Ni âge, ni compteur : `upsertFinding` réécrit `title` à chaque run, et y glisser « depuis
 * 12 j » ferait changer la ligne d'inbox chaque jour pour un problème qui, lui, n'a pas bougé
 * (règle IDX-005). La date de l'AVIS, elle, est fixe — donc admissible, et elle sert à le
 * retrouver. Aucun nom d'auteur : le titre est journalisé.
 */
export function buildReviewTitle(unit: ReviewUnit): string {
	return unit.type === NEGATIVE_REVIEW_TYPE
		? `Avis négatif ${unit.rating}★ sans réponse — ${unit.locationLabel} (avis du ${unit.createdDate})`
		: `Avis sans réponse — ${unit.locationLabel} (${unit.rating}★, avis du ${unit.createdDate})`;
}

/** Cause lisible de la détection, journalisée dans `finding_events.reason`. */
export function buildReviewReason(unit: ReviewUnit, thresholds: ReviewPendingThresholds): string {
	const head =
		unit.type === NEGATIVE_REVIEW_TYPE
			? `avis ${unit.rating}★ (seuil ${thresholds.negativeRatingMax}★) sans réponse ni locale ni distante`
			: `sans réponse depuis ${unit.ageDays} j, soit ${unit.overdueBy} j au-delà du délai de ${thresholds.slaDays} j`;
	const tail = `${unit.locationLabel} porte ${unit.backlog.pending} avis en attente sur ${unit.backlog.total}`;
	const draft = unit.hasDraft ? ' ; un brouillon existe et n’a jamais été envoyé' : '';
	return `${head} ; ${tail}${draft}`;
}
