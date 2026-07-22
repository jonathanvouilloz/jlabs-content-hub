/**
 * DATA-005 / FIND-003 — Helpers PURS pour les findings (SPEC §7.6/§7.7/§10).
 *
 * Aucune dépendance db ni `$env` (seul `timestamps.ts`, pur lui aussi) →
 * testables en isolation par vitest. Portent les invariants d'acceptation :
 *   - DATA-005 : le même problème sur deux semaines conserve le MÊME finding
 *     (fingerprint déterministe = clé d'upsert, miroir de l'unique de schema.ts) ;
 *     la priorité est un score explicite et borné (barème §10.2) ; une transition
 *     d'état/sévérité se traduit par un `event_type` dérivable ;
 *   - FIND-003 : le cycle de vie §10.1 (légalité des transitions), l'auto-résolution
 *     confirmée sur plusieurs fenêtres, et l'expiration de la veille.
 */
import { toDbTimestamp, toDbTimestampPlus } from './timestamps.js';

// ── Vocabulaire (SPEC §7.6 / §10.4) ─────────────────────────────────

/** Catalogue initial des types de findings (SPEC §10.4). */
export const FINDING_TYPES = [
	'keyword_opportunity',
	'keyword_decline',
	'new_query',
	'lost_query',
	'ctr_gap',
	'content_decay',
	'target_url_mismatch',
	'cannibalization',
	'index_drop',
	'crawled_not_indexed',
	'discovered_not_indexed',
	'canonical_conflict',
	'sitemap_anomaly',
	'redirect_in_sitemap',
	'soft_404',
	'traffic_anomaly',
	'conversion_drop',
	'review_pending_sla',
	'negative_review',
	'integration_stale'
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

/**
 * Statuts persistés = les 7 de SPEC §7.6 + `reopened` (réapparition après
 * résolution, explicite dans le cycle de vie §10.1). `new` reste transitoire :
 * un finding naît directement `open`.
 */
export const FINDING_STATUSES = [
	'open',
	'acknowledged',
	'planned',
	'in_progress',
	'resolved',
	'dismissed',
	'snoozed',
	'reopened'
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Statuts terminaux : un finding y arrête son cycle actif (jusqu'à réouverture). */
export const TERMINAL_STATUSES = ['resolved', 'dismissed'] as const;

/** Sévérités (SPEC §7.6). */
export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** Types d'entité qu'un finding peut viser (SPEC §7.6). */
export const FINDING_ENTITY_TYPES = ['project', 'query', 'page', 'review', 'integration'] as const;
export type FindingEntityType = (typeof FINDING_ENTITY_TYPES)[number];

/**
 * Types d'événement du journal append-only (SPEC §7.7). `unsnoozed` (FIND-003)
 * s'ajoute au catalogue : une veille qui expire n'est pas une « validation », et
 * la distinguer rend le taux de snooze mesurable (FIND-010).
 */
export const FINDING_EVENT_TYPES = [
	'created',
	'aggravated',
	'improved',
	'agent_comment',
	'validated',
	'rejected',
	'snoozed',
	'unsnoozed',
	'reopened',
	'resolved'
] as const;
export type FindingEventType = (typeof FINDING_EVENT_TYPES)[number];

/** Auteurs possibles d'un événement (cause/auteur, acceptation DATA-005). */
export const FINDING_ACTORS = ['schedule', 'user', 'agent', 'system', 'detector'] as const;
export type FindingActor = (typeof FINDING_ACTORS)[number];

// ── Fingerprint stable (dédup ; acceptation "même problème = même finding") ──

/**
 * Séparateur de fingerprint : ASCII Unit Separator (0x1F). Non imprimable, jamais
 * présent dans une query/URL/keyword légitime → pas de collision entre dimensions.
 * Aligné sur `observation-state.FINGERPRINT_SEP` (même discipline de dédup).
 */
export const FINDING_FINGERPRINT_SEP = '\x1f';

/**
 * Clé déterministe et STABLE d'un finding, en miroir de l'unique posé en DB
 * (`findings_fingerprint_unique` sur project_id + fingerprint). Le même problème
 * (même type + entité + discriminants) redétecté une autre semaine produit la
 * MÊME clé → upsert (jamais un doublon). La normalisation (trim/minuscule des
 * URLs/queries) est laissée à l'appelant ; les parties sont jointes par le
 * séparateur réservé.
 *
 * @throws si `type`/`entityType` sont vides, ou si une partie contient le
 *         séparateur réservé (casserait la dédup silencieusement).
 */
export function deriveFindingFingerprint(input: {
	type: string;
	entityType: string;
	entityKey?: string | null;
	discriminators?: (string | number)[];
}): string {
	if (!input.type) throw new Error('Fingerprint finding : type manquant.');
	if (!input.entityType) throw new Error('Fingerprint finding : entityType manquant.');
	const parts = [
		input.type,
		input.entityType,
		input.entityKey ?? '',
		...(input.discriminators ?? []).map((d) => String(d))
	];
	parts.forEach((p, i) => {
		if (p.includes(FINDING_FINGERPRINT_SEP)) {
			throw new Error(`Fingerprint finding : partie #${i} contient le séparateur réservé.`);
		}
	});
	return parts.join(FINDING_FINGERPRINT_SEP);
}

/**
 * Lecture inverse de `deriveFindingFingerprint`. Le fingerprint est la SEULE
 * source de certains discriminants : `findings.entity_key` ne porte qu'une
 * dimension (pour `keyword_opportunity`, la query), alors que la page vit en
 * discriminant. Un producteur d'actions a besoin de la cible — la parser ici,
 * à côté de la fonction qui la compose, évite qu'un appelant refasse un `split`
 * sur un séparateur qu'il aurait deviné.
 *
 * Tolérante par construction : un fingerprint malformé rend des parties vides
 * plutôt qu'une exception. Un finding illisible ne doit pas faire tomber un run
 * entier — il ne produira simplement aucune action.
 */
export function parseFindingFingerprint(fingerprint: string): {
	type: string;
	entityType: string;
	entityKey: string;
	discriminators: string[];
} {
	const parts = (fingerprint ?? '').split(FINDING_FINGERPRINT_SEP);
	return {
		type: parts[0] ?? '',
		entityType: parts[1] ?? '',
		entityKey: parts[2] ?? '',
		discriminators: parts.slice(3)
	};
}

// ── Priorité (barème SPEC §10.2) ────────────────────────────────────

/** Borne un score entier dans [min, max] (défaut [0, 100]). */
export function clampScore(value: number, min = 0, max = 100): number {
	if (Number.isNaN(value)) return min;
	return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Plafonds des composantes du score de priorité (SPEC §10.2) :
 *   priority = impact (0–40) + urgency (0–25) + confidence (0–20) + strategic_fit (0–15)
 * Somme maximale = 100. Chaque composante est bornée avant sommation.
 */
export const PRIORITY_WEIGHTS = {
	impact: 40,
	urgency: 25,
	confidence: 20,
	strategicFit: 15
} as const;

/**
 * Score de priorité déterministe 0–100 à partir de ses 4 composantes. Chaque
 * composante est bornée à son plafond (§10.2) puis sommée. Le score et ses
 * composantes restent visibles/explicables (SPEC §10.2 : « l'agent peut commenter
 * la priorité mais ne remplace pas le calcul de base »).
 */
export function computePriorityScore(input: {
	impact: number;
	urgency: number;
	confidence: number;
	strategicFit: number;
}): number {
	const impact = clampScore(input.impact, 0, PRIORITY_WEIGHTS.impact);
	const urgency = clampScore(input.urgency, 0, PRIORITY_WEIGHTS.urgency);
	const confidence = clampScore(input.confidence, 0, PRIORITY_WEIGHTS.confidence);
	const strategicFit = clampScore(input.strategicFit, 0, PRIORITY_WEIGHTS.strategicFit);
	return impact + urgency + confidence + strategicFit;
}

// ── Transitions → event_type dérivé (journal §7.7) ──────────────────

/** Vrai si `status` est un statut terminal (resolved/dismissed). */
export function isTerminalStatus(status: string): boolean {
	return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Dérive l'`event_type` d'un changement de SÉVÉRITÉ : une sévérité qui monte est
 * une aggravation, qui baisse une amélioration, inchangée = pas d'événement.
 * Retourne `null` si l'une des sévérités est inconnue (pas d'événement inventé).
 */
export function deriveSeverityEventType(
	oldSeverity: string,
	newSeverity: string
): 'aggravated' | 'improved' | null {
	const order = FINDING_SEVERITIES as readonly string[];
	const a = order.indexOf(oldSeverity);
	const b = order.indexOf(newSeverity);
	if (a < 0 || b < 0 || a === b) return null;
	return b > a ? 'aggravated' : 'improved';
}

/**
 * Dérive l'`event_type` d'un changement de STATUT (SPEC §7.7). Statuts sans
 * événement dédié dans le catalogue (acknowledged/planned/in_progress) tombent sur
 * `validated` (décision humaine/agent enregistrée). Retourne `null` si aucun
 * changement.
 */
export function deriveStatusEventType(
	fromStatus: string,
	toStatus: string
): FindingEventType | null {
	if (fromStatus === toStatus) return null;
	// Sortie de veille (expiration automatique ou réveil manuel) : événement propre,
	// jamais confondu avec une validation humaine.
	if (fromStatus === 'snoozed' && !isTerminalStatus(toStatus) && toStatus !== 'snoozed') {
		return 'unsnoozed';
	}
	switch (toStatus) {
		case 'resolved':
			return 'resolved';
		case 'dismissed':
			return 'rejected';
		case 'snoozed':
			return 'snoozed';
		case 'reopened':
		case 'open':
			// Repasser à un état actif depuis un terminal = réouverture.
			return isTerminalStatus(fromStatus) ? 'reopened' : 'validated';
		default:
			return 'validated';
	}
}

// ── FIND-003 — Cycle de vie : légalité, absence, veille ─────────────
//
// Trois invariants portés ici (donc testables sans DB) :
//   1. un problème persistant n'apparaît qu'UNE fois dans l'inbox ;
//   2. une résolution puis récidive produit une RÉOUVERTURE ;
//   3. le snooze EXPIRE automatiquement.
// Décisions produit câblées dans ces fonctions :
//   - le snooze TIENT (aucune re-détection, aucune aggravation ne le rompt) ;
//   - le dismiss vaut À VIE pour ce fingerprint (seul un humain rouvre).

/**
 * Graphe des transitions légales (SPEC §10.1) :
 *   new → open → acknowledged → planned → in_progress → resolved
 *                      └──────── dismissed / snoozed
 *   resolved → reopened si le problème réapparaît
 *
 * `reopened` est un état actif à part entière : il se comporte comme `open`.
 * Une transition absente de cette table est refusée à l'écriture — un statut
 * incohérent ne doit jamais s'installer en silence.
 */
const LEGAL_TRANSITIONS: Record<FindingStatus, readonly FindingStatus[]> = {
	open: ['acknowledged', 'planned', 'in_progress', 'snoozed', 'dismissed', 'resolved'],
	reopened: ['acknowledged', 'planned', 'in_progress', 'snoozed', 'dismissed', 'resolved'],
	acknowledged: ['planned', 'in_progress', 'snoozed', 'dismissed', 'resolved', 'open'],
	planned: ['in_progress', 'snoozed', 'dismissed', 'resolved', 'acknowledged'],
	in_progress: ['resolved', 'planned', 'snoozed', 'dismissed'],
	// Sortie de veille : retour à l'état actif (expiration ou réveil manuel), ou
	// décision terminale prise pendant la veille.
	snoozed: ['open', 'acknowledged', 'planned', 'in_progress', 'dismissed', 'resolved'],
	// Récidive d'un problème résolu → réouverture (acceptation 2).
	resolved: ['reopened', 'open'],
	// Le dismiss vaut à vie : SEULE une réouverture explicite (humaine) le défait.
	dismissed: ['reopened', 'open']
};

/** Vrai si la transition `from → to` est légale (SPEC §10.1). */
export function canTransition(from: string, to: string): boolean {
	if (from === to) return false;
	const allowed = LEGAL_TRANSITIONS[from as FindingStatus];
	if (!allowed) return false;
	return (allowed as readonly string[]).includes(to);
}

/** Statuts « actifs » : présents dans l'inbox, susceptibles d'être réconciliés. */
export const ACTIVE_STATUSES = [
	'open',
	'reopened',
	'acknowledged',
	'planned',
	'in_progress'
] as const;

/** Vrai si le finding occupe l'inbox (ni terminal, ni en veille). */
export function isActiveStatus(status: string): boolean {
	return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

// ── Configuration du cycle de vie (par projet) ──────────────────────

export interface LifecycleConfig {
	/**
	 * Fenêtres CONSÉCUTIVES sans match avant auto-résolution. ≥ 2 par défaut :
	 * une seule absence peut venir d'une collecte partielle, pas d'une guérison
	 * (SPEC §10.3 « persistance sur plusieurs fenêtres »).
	 */
	autoResolveAfterMisses: number;
	/** Durée par défaut d'une mise en veille, en jours. */
	defaultSnoozeDays: number;
}

export const LIFECYCLE_DEFAULTS: LifecycleConfig = {
	autoResolveAfterMisses: 2,
	defaultSnoozeDays: 14
};

/**
 * Fusionne des overrides projet aux défauts. Même idiome tolérant que
 * `resolveThresholds` (detector-state.ts) : une valeur non finie ou hors bornes
 * retombe sur le défaut plutôt que de casser la réconciliation — un override
 * corrompu ne doit jamais fermer l'inbox d'un coup (`autoResolveAfterMisses = 0`).
 */
export function resolveLifecycleConfig(
	overrides?: Partial<LifecycleConfig> | null
): LifecycleConfig {
	const out = { ...LIFECYCLE_DEFAULTS };
	if (!overrides) return out;
	for (const key of Object.keys(LIFECYCLE_DEFAULTS) as (keyof LifecycleConfig)[]) {
		const value = overrides[key];
		if (typeof value !== 'number' || !Number.isFinite(value)) continue;
		const rounded = Math.floor(value);
		if (rounded < 1) continue; // 0 ou négatif = absurde → défaut
		out[key] = rounded;
	}
	return out;
}

// ── Décisions de réconciliation ─────────────────────────────────────

/** Ce qu'on fait d'un finding REDÉTECTÉ (présent dans la closure du run). */
export type RedetectionDecision = 'reopen' | 'refresh' | 'hold';

/**
 * Le problème est toujours là :
 *   - `resolved` → **reopen** (acceptation 2 : récidive = réouverture) ;
 *   - `dismissed` → **hold** — le dismiss vaut à vie ; `occurrence_count` monte
 *     quand même (matière première de la mesure de faux positifs, FIND-010) mais
 *     le finding ne remonte jamais seul dans l'inbox ;
 *   - `snoozed` → **hold** — le snooze est une promesse de silence : rien ne le
 *     rompt avant son échéance, pas même une aggravation (qui reste journalisée) ;
 *   - actif → **refresh** (l'upsert a déjà rafraîchi scores et preuves).
 */
export function decideOnRedetection(status: string): RedetectionDecision {
	if (status === 'resolved') return 'reopen';
	if (status === 'dismissed' || status === 'snoozed') return 'hold';
	return 'refresh';
}

/** Ce qu'on fait d'un finding ABSENT de la closure d'un run autoritaire. */
export interface AbsenceDecision {
	/** `resolve` = seuil atteint · `count` = une absence de plus · `skip` = intouchable. */
	action: 'resolve' | 'count' | 'skip';
	/** Valeur à persister dans `consecutive_misses` (inchangée si `skip`). */
	nextMisses: number;
}

/**
 * Le problème ne se manifeste plus. On ne résout qu'après
 * `autoResolveAfterMisses` fenêtres consécutives — jamais sur une seule absence.
 * Les findings en veille, dismissés ou déjà terminaux ne sont pas touchés : une
 * absence n'est pas une raison de rompre une veille ni de réécrire une décision
 * humaine.
 */
export function decideOnAbsence(input: {
	status: string;
	consecutiveMisses: number;
	config?: Partial<LifecycleConfig> | null;
}): AbsenceDecision {
	const current = Number.isFinite(input.consecutiveMisses)
		? Math.max(0, Math.floor(input.consecutiveMisses))
		: 0;
	if (!isActiveStatus(input.status)) return { action: 'skip', nextMisses: current };

	const { autoResolveAfterMisses } = resolveLifecycleConfig(input.config);
	const next = current + 1;
	return next >= autoResolveAfterMisses
		? { action: 'resolve', nextMisses: next }
		: { action: 'count', nextMisses: next };
}

// ── Veille (snooze) ─────────────────────────────────────────────────

/** Millisecondes d'un jour — unité des échéances de veille. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Échéance d'une veille de `days` jours, au format DB (comparable lexicalement
 * aux colonnes `text`, cf. `timestamps.ts`). `from` est passé explicitement →
 * déterministe et testable. Une durée absurde (0, négative, non finie) retombe
 * sur le défaut : une veille mal saisie ne doit pas expirer immédiatement.
 */
export function computeSnoozeUntil(input: {
	days?: number | null;
	from?: Date | string;
}): string {
	const raw = input.days;
	const days =
		typeof raw === 'number' && Number.isFinite(raw) && raw >= 1
			? Math.floor(raw)
			: LIFECYCLE_DEFAULTS.defaultSnoozeDays;
	return toDbTimestampPlus(days * DAY_MS, input.from ?? new Date());
}

/**
 * Vrai si la veille est échue à `now`. Une échéance absente = veille sans terme →
 * traitée comme expirée : un `snoozed` sans `snoozed_until` est une anomalie
 * qu'on préfère réveiller plutôt que laisser dormir pour toujours.
 * La comparaison porte sur deux chaînes AU MÊME FORMAT DB, donc lexicographiquement
 * sûre — c'est toute la raison de la discipline `toDbTimestamp` à l'écriture.
 */
export function isSnoozeExpired(
	snoozedUntil: string | null | undefined,
	now: Date | string
): boolean {
	if (!snoozedUntil) return true;
	return snoozedUntil <= toDbTimestamp(now);
}

// ── Causes canoniques des transitions automatiques ──────────────────
// Toute transition porte une cause lisible (acceptation DATA-005) ; celles que la
// machine décide seule ont une formulation figée, repérable dans le journal.

export const AUTO_RESOLUTION_REASON =
	'auto-résolu : le signal ne franchit plus les seuils du détecteur';
export const SNOOZE_EXPIRED_REASON = 'veille expirée : le finding revient dans l’inbox';
export const RECURRENCE_REASON = 'récidive : le signal franchit de nouveau les seuils du détecteur';
