/**
 * IDX-004 — Politique de sélection d'inspection : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau — le seul est `normalizeUrl`, lui-même pur),
 * colocalisé avec son sélecteur comme `url-inspection-state.ts` l'est avec son collecteur.
 * `index-selection.ts` lit la base et persiste ; ici on décide **quelles URLs méritent le
 * quota, dans quel ordre, et jusqu'où**.
 *
 * IDX-002 s'était explicitement interdit de choisir ses URLs (« installer ici une règle
 * implicite obligerait IDX-004 à la défaire »). C'est ce module qui choisit.
 *
 * Les trois acceptations IDX-004 s'appuient sur lui :
 *
 *   1. « le quota ne peut pas être consommé entièrement par l'échantillon » → `allocate`
 *      plafonne la famille `sample` à `sampleCap`, lui-même **borné en configuration** par
 *      `MAX_SAMPLE_PCT`. Un override à 100 retombe à 60 : la garde ne peut pas être désarmée
 *      par un réglage. Même leçon que `resolveLimits` (JOB-006) et `confirmAfterObservations`
 *      (IDX-005).
 *   2. « chaque sélection expose sa raison » → `SelectionReason` est un vocabulaire **fermé**,
 *      et `dedupeCandidates` conserve les raisons secondaires (`alsoBecause`) plutôt que de
 *      les perdre : une page à la fois stratégique et porteuse d'un finding ne doit ni payer
 *      deux fois le quota, ni voir sa seconde raison effacée.
 *   3. « une inspection manquée est replanifiée sans duplication » → tenu côté base par
 *      l'unique `(project, url_normalized, due_date)` ; ici on garantit seulement qu'une
 *      échéance **due** passe avant tout le reste, et qu'une échéance **périmée** est écartée
 *      en le DISANT (`expired`), jamais en silence.
 *
 * ⚠️⚠️ **`0` VEUT DIRE ZÉRO ICI, l'inverse de `job-limits.ts`.**
 * JOB-006 pose « `0` = pas de limite » parce qu'il gouverne une concurrence interne. Ici les
 * plafonds gouvernent un **quota externe payant** : lire `0` comme « illimité » brûlerait le
 * pool en un job. Ne JAMAIS copier l'idiome `budget > 0 && used >= budget` de `job-limits.ts`.
 * Une valeur illisible ou négative retombe sur le défaut du code ; `0` est une valeur VALIDE
 * qui veut dire « aucune inspection ».
 */
// `normalizeUrl` est la SEULE porte de normalisation (IDX-001) : la réimplémenter ici ferait
// diverger la forme inscrite au registre de celle envoyée à Google, et la jointure « honorée »
// ne retrouverait jamais sa mesure. Le module reste pur (sitemap-state n'importe rien).
import { normalizeUrl } from './sitemap-state.js';

// ── Version de la politique ─────────────────────────────────────────

/**
 * Estampillée dans `index_selection.selector_version`, même discipline que `detector_version`
 * (IDX-005) : un lot ancien ne doit pas se relire avec les règles d'aujourd'hui.
 */
export const SELECTOR_VERSION = 'index_selection@1';

// ── Vocabulaire fermé des raisons ───────────────────────────────────

/**
 * Pourquoi cette URL a coûté du quota. **Fermé** : c'est l'acceptation « chaque sélection
 * expose sa raison », et une raison en texte libre ne s'interroge pas en SQL.
 *
 * L'ordre de ce tableau EST l'ordre de service à l'intérieur d'une famille (voir
 * `compareCandidates`). Le changer change la politique — c'est pourquoi `SELECTOR_VERSION`
 * existe.
 *
 * `manual` et `post_publish` n'ont pas encore de producteur dans le lot 1 : le CLI d'audit et
 * le câblage J+N à la publication sont le lot 2. Ils sont déclarés ici parce que la table les
 * accepte déjà et qu'un vocabulaire fermé se déclare entier, pas au fil de l'eau.
 */
export const SELECTION_REASONS = [
	/** Demandé à la main par un opérateur (CLI d'audit borné — lot 2). */
	'manual',
	/** Rappel J+3 / J+7 / J+28 après publication (lot 2). */
	'post_publish',
	/** L'URL porte un finding d'indexation ouvert : on revérifie ce qu'on a annoncé. */
	'finding',
	/** Page stratégique au sens d'IDX-005 (clics GSC ou déclaration projet). */
	'strategic',
	/** Apparue dans l'inventaire sitemap depuis le dernier snapshot. */
	'new',
	/** `lastmod` ou canonical attendu a bougé depuis le dernier snapshot. */
	'changed',
	/** Rotation de fond : la page n'a pas été vue depuis `sampleIntervalDays`. */
	'sample'
] as const;

export type SelectionReason = (typeof SELECTION_REASONS)[number];

const REASON_RANK = new Map<SelectionReason, number>(
	SELECTION_REASONS.map((reason, index) => [reason, index])
);

/** Vrai si la chaîne appartient au vocabulaire fermé. Une raison inconnue est REFUSÉE. */
export function isSelectionReason(raw: unknown): raw is SelectionReason {
	return typeof raw === 'string' && REASON_RANK.has(raw as SelectionReason);
}

/**
 * Les trois familles de service, dans l'ordre.
 *
 * « Réserver du quota aux vérifications urgentes » est tenu par l'ORDRE, pas par un
 * pourcentage : la famille `urgent` est servie en premier et sans plafond propre. Un
 * pourcentage de réserve ne pourrait que **dégrader** une garantie déjà totale, et il
 * ajouterait un réglage qu'on peut mettre à zéro.
 */
export type SelectionFamily = 'urgent' | 'routine' | 'sample';

export function familyForReason(reason: SelectionReason): SelectionFamily {
	if (reason === 'manual' || reason === 'post_publish' || reason === 'finding') return 'urgent';
	if (reason === 'sample') return 'sample';
	return 'routine';
}

/**
 * Le bucket persisté. `sample` est isolé parce que c'est LUI que l'acceptation 1 plafonne :
 * `GROUP BY bucket` en base doit pouvoir montrer que l'échantillon n'a pas tout pris.
 */
export type SelectionBucket = 'priority' | 'sample';

export function bucketForReason(reason: SelectionReason): SelectionBucket {
	return reason === 'sample' ? 'sample' : 'priority';
}

// ── Réglages ────────────────────────────────────────────────────────

export interface SelectionConfig {
	/** Plafond quotidien TOUS PROJETS confondus (le service account est partagé par 6). */
	dailyPoolTotal: number;
	/** Part du pool que seule une passe `scope: 'due'` peut dépenser. */
	poolUrgentReserve: number;
	/** Plafond quotidien par projet. */
	dailyBudgetPerProject: number;
	/** Part maximale du budget d'un job dévolue à l'échantillon tournant, en %. */
	samplePctMax: number;
	/** Une page non observée depuis N jours redevient candidate à l'échantillon. */
	sampleIntervalDays: number;
	/** Une échéance non honorée depuis N jours est abandonnée (et le DIT). */
	maxAgeDays: number;
	/** Plafond dur d'un job, avant le plafond dur du collecteur (`MAX_URLS_PER_JOB`). */
	jobCap: number;
}

/**
 * Défauts PRUDENTS (décision de Jonathan, 2026-07-25 : « je règle après la première
 * observation »).
 *
 * `dailyPoolTotal` vaut 800 et non 2 000 : le pool consommé est **dérivé** d'un `count` sur
 * `index_observations`, qui ne compte ni les appels échoués, ni les réponses illisibles, ni
 * ceux du skill `/seo-index-diagnose` et de la route legacy `seo-data` — lesquels tapent le
 * MÊME service account. La marge absorbe ce sous-comptage : ce chiffre est une **borne
 * prudentielle choisie**, jamais un quota mesuré.
 *
 * `dailyBudgetPerProject` vaut 40 aussi pour une raison de file : `DELAY_MS = 150` côté
 * collecteur, donc 6 projets × 40 URLs = 36 s de pause pure dans un budget de drain de 240 s.
 */
export const SELECTION_DEFAULTS: SelectionConfig = {
	dailyPoolTotal: 800,
	poolUrgentReserve: 100,
	dailyBudgetPerProject: 40,
	samplePctMax: 40,
	sampleIntervalDays: 14,
	maxAgeDays: 14,
	jobCap: 200
};

/**
 * Plafond DUR de la part d'échantillon, quel que soit le réglage.
 *
 * C'est la seule chose qui rend l'acceptation 1 intenable à contourner : un `samplePctMax` à
 * 100 en base retombe ici à 60. Une garde désactivable par configuration n'est pas une garde.
 */
export const MAX_SAMPLE_PCT = 60;

/**
 * Un entier >= 0 où **`0` est une valeur valide** (voir l'avertissement en tête de fichier).
 * Illisible, non fini ou négatif → défaut du code.
 */
function boundedBudget(value: unknown, fallback: number): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n) || n < 0) return fallback;
	return Math.floor(n);
}

/**
 * Un entier >= 1 : une cadence à zéro n'a pas de sens (« re-échantillonner tous les 0 jours »
 * n'est pas une politique). Même durcissement que `resolveIndexTransitionConfig`.
 */
function boundedCadence(value: unknown, fallback: number): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n) || n < 1) return fallback;
	return Math.floor(n);
}

/**
 * Durcit des réglages bruts en configuration utilisable. PURE → testable sans base.
 *
 * Tolérante par construction : un réglage corrompu qui ferait LEVER arrêterait toute la
 * collecte d'indexation en silence. Le pire cas est de tourner aux défauts documentés.
 */
export function resolveSelectionConfig(
	overrides?: Partial<SelectionConfig> | null
): SelectionConfig {
	const o = overrides ?? {};
	return {
		dailyPoolTotal: boundedBudget(o.dailyPoolTotal, SELECTION_DEFAULTS.dailyPoolTotal),
		poolUrgentReserve: boundedBudget(o.poolUrgentReserve, SELECTION_DEFAULTS.poolUrgentReserve),
		dailyBudgetPerProject: boundedBudget(
			o.dailyBudgetPerProject,
			SELECTION_DEFAULTS.dailyBudgetPerProject
		),
		// Clampé des DEUX côtés : le plafond dur ne se règle pas.
		samplePctMax: Math.min(
			MAX_SAMPLE_PCT,
			boundedBudget(o.samplePctMax, SELECTION_DEFAULTS.samplePctMax)
		),
		sampleIntervalDays: boundedCadence(
			o.sampleIntervalDays,
			SELECTION_DEFAULTS.sampleIntervalDays
		),
		maxAgeDays: boundedCadence(o.maxAgeDays, SELECTION_DEFAULTS.maxAgeDays),
		jobCap: boundedBudget(o.jobCap, SELECTION_DEFAULTS.jobCap)
	};
}

/** Ce qu'un projet peut régler pour lui-même, dans `project_projections.payload`. */
export interface ProjectSelectionOverrides {
	dailyBudget?: number;
	sampleIntervalDays?: number;
	excludePatterns?: string[];
}

export interface ResolvedProjectSelection {
	dailyBudget: number;
	sampleIntervalDays: number;
	excludePatterns: string[];
}

/**
 * Applique les réglages d'un projet, qui ne peuvent que **RESSERRER**.
 *
 * Même sens unique que `resolveProjectLimits` (JOB-006) : un projet n'a pas à décider d'un
 * budget qu'il partage avec cinq autres, seulement de la place qu'il prend. Un budget projet
 * plus GRAND que le budget système est donc ignoré (`min`), et un intervalle d'échantillon
 * plus COURT aussi (`max` : allonger l'intervalle échantillonne moins).
 */
export function resolveProjectSelection(
	config: SelectionConfig,
	overrides?: ProjectSelectionOverrides | null
): ResolvedProjectSelection {
	const o = overrides ?? {};
	const rawBudget = boundedBudget(o.dailyBudget, config.dailyBudgetPerProject);
	const rawInterval = boundedCadence(o.sampleIntervalDays, config.sampleIntervalDays);
	return {
		dailyBudget: Math.min(config.dailyBudgetPerProject, rawBudget),
		sampleIntervalDays: Math.max(config.sampleIntervalDays, rawInterval),
		excludePatterns: Array.isArray(o.excludePatterns)
			? o.excludePatterns.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
			: []
	};
}

// ── Candidats ───────────────────────────────────────────────────────

export interface Candidate {
	/** La forme SOURCE (`<loc>` du sitemap, `page` GSC, `entity_key` du finding). Trace. */
	url: string;
	/** La forme comparée ET envoyée à Google. Porte l'unique en base. */
	urlNormalized: string;
	reason: SelectionReason;
	/** La PREUVE de la raison (`clicks`, `findingId`, `offsetDays`, `lastmodFrom`/`To`…). */
	reasonDetail?: Record<string, unknown> | null;
	/** Départage à l'intérieur d'une même raison. Plus haut = servi d'abord. */
	weight?: number;
	/** Échéance déjà posée en base ; absente pour un candidat calculé au vol. */
	dueDate?: string;
}

export interface SelectedUrl extends Candidate {
	bucket: SelectionBucket;
	family: SelectionFamily;
	/** Rang dans la sélection ordonnée, AVANT troncature — rend la coupe lisible. */
	rank: number;
	/** Les autres raisons qui désignaient la même URL, conservées et jamais perdues. */
	alsoBecause: SelectionReason[];
}

/**
 * Ordre TOTAL : famille, puis raison, puis poids décroissant, puis URL normalisée.
 *
 * La dernière clé n'est pas décorative — sans elle, deux runs sur les mêmes données
 * pourraient rendre des sélections différentes, et « rejouer la politique » cesserait d'être
 * une vérification (même doctrine que l'ordre total de DASH-002).
 */
const FAMILY_RANK: Record<SelectionFamily, number> = { urgent: 0, routine: 1, sample: 2 };

export function compareCandidates(a: Candidate, b: Candidate): number {
	const fa = FAMILY_RANK[familyForReason(a.reason)];
	const fb = FAMILY_RANK[familyForReason(b.reason)];
	if (fa !== fb) return fa - fb;
	const ra = REASON_RANK.get(a.reason) ?? Number.MAX_SAFE_INTEGER;
	const rb = REASON_RANK.get(b.reason) ?? Number.MAX_SAFE_INTEGER;
	if (ra !== rb) return ra - rb;
	const wa = a.weight ?? 0;
	const wb = b.weight ?? 0;
	if (wa !== wb) return wb - wa;
	return a.urlNormalized < b.urlNormalized ? -1 : a.urlNormalized > b.urlNormalized ? 1 : 0;
}

/**
 * Une URL, une place. Les raisons secondaires sont CONSERVÉES, pas perdues.
 *
 * Une page peut être stratégique ET porter un finding ET avoir bougé. Sans cette passe elle
 * prendrait trois slots pour une seule mesure — trois fois le quota pour la même donnée, et
 * un `ON CONFLICT` qui écrase sa propre ligne. Écraser les raisons secondaires serait l'autre
 * erreur : « pourquoi a-t-on inspecté cette page » se répond avec la liste, pas avec la
 * première trouvée.
 *
 * Les candidats sans `urlNormalized` exploitable sont écartés ici : une URL qu'on ne sait pas
 * normaliser ne peut pas être comparée à sa propre mesure, donc ne peut jamais être honorée.
 */
export function dedupeCandidates(candidates: readonly Candidate[]): {
	kept: Candidate[];
	alsoBecause: Map<string, SelectionReason[]>;
	dropped: number;
} {
	const sorted = [...candidates]
		.filter((c) => typeof c.urlNormalized === 'string' && c.urlNormalized.trim() !== '')
		.sort(compareCandidates);
	const kept: Candidate[] = [];
	const alsoBecause = new Map<string, SelectionReason[]>();
	const seen = new Set<string>();
	for (const candidate of sorted) {
		const key = candidate.urlNormalized;
		if (seen.has(key)) {
			const others = alsoBecause.get(key) ?? [];
			if (!others.includes(candidate.reason)) others.push(candidate.reason);
			alsoBecause.set(key, others);
			continue;
		}
		seen.add(key);
		kept.push(candidate);
	}
	return { kept, alsoBecause, dropped: candidates.length - kept.length };
}

// ── Budget ──────────────────────────────────────────────────────────

/**
 * Causes NOMMÉES d'une sélection courte ou vide.
 *
 * Un sélecteur qui rend zéro URL sans dire pourquoi se lirait comme « rien à inspecter »,
 * alors qu'il peut vouloir dire « le pool est épuisé » ou « le budget projet est à zéro ».
 * Même doctrine que les `holds` de JOB-006 et que le `skippedReason` d'IDX-005.
 */
export const SELECTION_GUARDS = [
	'pool_exhausted',
	'urgent_reserve',
	'project_budget_zero',
	'job_cap',
	'collector_cap',
	'sample_capped',
	'no_candidates'
] as const;

export type SelectionGuard = (typeof SELECTION_GUARDS)[number];

export interface BudgetInput {
	config: SelectionConfig;
	/** Budget du projet après resserrement (`resolveProjectSelection`). */
	projectDailyBudget: number;
	/**
	 * Appels déjà comptés aujourd'hui, TOUS projets. **Borne inférieure** : ne compte ni les
	 * échecs, ni les réponses illisibles, ni les appels hors cockpit.
	 */
	poolUsed: number;
	/** `'due'` n'honore que les échéances et peut puiser dans la réserve ; `'full'` non. */
	scope: 'due' | 'full';
	/** Plafond explicite du job, s'il en porte un. */
	jobBudget?: number | null;
	/** Plafond dur du collecteur (`MAX_URLS_PER_JOB`), injecté pour garder ce module pur. */
	collectorCap: number;
}

export interface BudgetResult {
	budget: number;
	/** Ce que le pool laisse à cette passe, réserve déduite le cas échéant. */
	poolAvailable: number;
	guards: SelectionGuard[];
}

/**
 * Résout le budget d'UN job.
 *
 * La réserve urgente est **cross-projet** et c'est sa raison d'être : le projet qui tire le
 * lundi ne doit pas pouvoir priver les cinq autres de leurs échéances. Elle n'est déductible
 * que d'une passe `full` — une passe `due`, qui ne peut par construction inspecter que des
 * échéances, y a accès.
 */
export function resolveBudget(input: BudgetInput): BudgetResult {
	const guards: SelectionGuard[] = [];
	const { config } = input;

	const reserve = input.scope === 'due' ? 0 : config.poolUrgentReserve;
	const poolAvailable = Math.max(0, config.dailyPoolTotal - Math.max(0, input.poolUsed) - reserve);
	if (poolAvailable === 0) {
		guards.push(reserve > 0 && input.poolUsed < config.dailyPoolTotal ? 'urgent_reserve' : 'pool_exhausted');
	}

	const candidates: { value: number; guard: SelectionGuard | null }[] = [
		{ value: input.projectDailyBudget, guard: 'project_budget_zero' },
		{ value: poolAvailable, guard: null },
		{ value: config.jobCap, guard: 'job_cap' },
		{ value: Math.max(0, input.collectorCap), guard: 'collector_cap' }
	];
	if (typeof input.jobBudget === 'number' && Number.isFinite(input.jobBudget)) {
		candidates.push({ value: Math.max(0, Math.floor(input.jobBudget)), guard: 'job_cap' });
	}

	let budget = Number.MAX_SAFE_INTEGER;
	for (const c of candidates) budget = Math.min(budget, Math.max(0, c.value));
	// Nommer QUI a mordu, pas seulement le résultat : « 0 URL » sans cause se lit « rien à faire ».
	for (const c of candidates) {
		if (c.guard && Math.max(0, c.value) === budget && budget === 0) guards.push(c.guard);
	}

	return { budget, poolAvailable, guards: [...new Set(guards)] };
}

/**
 * Plafond de la famille `sample`.
 *
 * L'invariant qui porte l'acceptation 1 : **`budget >= 1` ⇒ `sampleCap < budget`**. Avec
 * `samplePctMax` clampé à 60 %, `floor(budget × 0.6) < budget` pour tout `budget >= 1`
 * (y compris `budget = 1`, où le plancher rend 0). L'échantillon ne peut donc jamais prendre
 * le dernier slot, et il ne peut jamais prendre la place d'un urgent.
 */
export function computeSampleCap(input: {
	budget: number;
	samplePctMax: number;
	takenUrgent: number;
}): number {
	const pct = Math.min(MAX_SAMPLE_PCT, Math.max(0, input.samplePctMax));
	const byPct = Math.floor((Math.max(0, input.budget) * pct) / 100);
	const byRemainder = Math.max(0, input.budget - Math.max(0, input.takenUrgent));
	return Math.max(0, Math.min(byPct, byRemainder));
}

// ── Allocation ──────────────────────────────────────────────────────

export interface AllocationResult {
	kept: SelectedUrl[];
	/** Candidats uniques écartés faute de budget — la coupe est DITE, jamais silencieuse. */
	dropped: number;
	/** Doublons fusionnés par `dedupeCandidates` (quota économisé, pas perdu). */
	merged: number;
	sampleCap: number;
	byReason: Partial<Record<SelectionReason, number>>;
	byBucket: Record<SelectionBucket, number>;
	guards: SelectionGuard[];
}

/**
 * Répartit le budget entre les trois familles, dans l'ordre.
 *
 * `urgent` d'abord et sans plafond propre, puis `routine`, puis `sample` sous `sampleCap`.
 *
 * Les slots qu'une famille ne consomme pas **passent à la suivante**, dans les deux sens :
 * un échantillon plus court laisse la place à la routine, et une routine plus courte rend
 * ses slots à l'échantillon — toujours sous `sampleCap`, qui ne bouge jamais. Un slot
 * inutilisé est du quota perdu, et rien ne justifie de le laisser vide quand des pages
 * nouvelles ou jamais vues attendent.
 */
export function allocate(input: {
	candidates: readonly Candidate[];
	budget: number;
	samplePctMax: number;
}): AllocationResult {
	const guards: SelectionGuard[] = [];
	const { kept: unique, alsoBecause, dropped: merged } = dedupeCandidates(input.candidates);

	if (unique.length === 0) guards.push('no_candidates');

	const budget = Math.max(0, Math.floor(input.budget));
	const urgent = unique.filter((c) => familyForReason(c.reason) === 'urgent');
	const routine = unique.filter((c) => familyForReason(c.reason) === 'routine');
	const sample = unique.filter((c) => familyForReason(c.reason) === 'sample');

	const takenUrgent = urgent.slice(0, budget);
	const remaining = budget - takenUrgent.length;

	const sampleCap = computeSampleCap({ budget, samplePctMax: input.samplePctMax, takenUrgent: takenUrgent.length });
	const sampleAllowed = Math.min(sampleCap, remaining, sample.length);

	const takenRoutine = routine.slice(0, Math.max(0, remaining - sampleAllowed));
	// Le reste que la routine n'a pas consommé revient à l'échantillon, toujours sous son cap.
	const sampleFinal = Math.min(sampleCap, remaining - takenRoutine.length, sample.length);
	const takenSample = sample.slice(0, Math.max(0, sampleFinal));

	// Comparé au chiffre FINAL, pas au chiffre pré-routine : sinon on annoncerait un plafond
	// là où la routine avait simplement rendu ses slots.
	if (sample.length > takenSample.length) guards.push('sample_capped');

	const selected = [...takenUrgent, ...takenRoutine, ...takenSample].sort(compareCandidates);

	const byReason: Partial<Record<SelectionReason, number>> = {};
	const byBucket: Record<SelectionBucket, number> = { priority: 0, sample: 0 };
	const kept: SelectedUrl[] = selected.map((candidate, index) => {
		const bucket = bucketForReason(candidate.reason);
		byReason[candidate.reason] = (byReason[candidate.reason] ?? 0) + 1;
		byBucket[bucket] += 1;
		return {
			...candidate,
			bucket,
			family: familyForReason(candidate.reason),
			rank: index,
			alsoBecause: alsoBecause.get(candidate.urlNormalized) ?? []
		};
	});

	return {
		kept,
		dropped: unique.length - kept.length,
		merged,
		sampleCap,
		byReason,
		byBucket,
		guards: [...new Set(guards)]
	};
}

// ── Échéances et rotation ───────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Différence en jours entre deux dates `YYYY-MM-DD`. Rend `null` si l'une est illisible. */
export function daysBetween(from: string, to: string): number | null {
	const a = Date.parse(`${from}T00:00:00Z`);
	const b = Date.parse(`${to}T00:00:00Z`);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
	return Math.round((b - a) / DAY_MS);
}

/** Ajoute N jours à une date `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
	const base = Date.parse(`${date}T00:00:00Z`);
	if (!Number.isFinite(base)) return date;
	return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Une page redevient candidate à l'échantillon si on ne l'a jamais vue, ou si sa dernière
 * observation date d'au moins `intervalDays`.
 *
 * **Jamais observée ⇒ due**, et c'est délibéré : c'est l'état qui fait démarrer la rotation
 * sur un projet neuf. « Pas de mesure » n'est pas « mesure récente » — la doctrine
 * `deriveFreshness` de DASH-002, appliquée à une URL.
 */
export function isSampleDue(input: {
	lastObservedDate: string | null;
	today: string;
	intervalDays: number;
}): boolean {
	if (!input.lastObservedDate) return true;
	const age = daysBetween(input.lastObservedDate, input.today);
	if (age === null) return true;
	return age >= input.intervalDays;
}

/**
 * Une échéance non honorée depuis plus de `maxAgeDays` est abandonnée.
 *
 * Sans borne, une URL devenue impossible à inspecter (domaine mort, propriété retirée)
 * resterait en tête de file pour toujours et mangerait le budget urgent de chaque run. Le
 * sélecteur DOIT compter les abandons et les dire : un abandon silencieux se lirait comme
 * une inspection réussie.
 */
export function isExpired(input: { dueDate: string; today: string; maxAgeDays: number }): boolean {
	const age = daysBetween(input.dueDate, input.today);
	if (age === null) return false;
	return age > input.maxAgeDays;
}

/** Vrai si l'échéance est arrivée (aujourd'hui ou avant). */
export function isDue(input: { dueDate: string; today: string }): boolean {
	const age = daysBetween(input.dueDate, input.today);
	if (age === null) return false;
	return age >= 0;
}

// ── Exclusions ──────────────────────────────────────────────────────

/**
 * Correspondance par sous-chaîne, comme `matchesAnyPattern` du legacy.
 *
 * ⚠️ Ces motifs sont ceux de la SÉLECTION, distincts de
 * `indexing_credentials.exclude_patterns` qui gouvernent la SOUMISSION (Indexing API).
 * Exclure une page de la soumission ne veut pas dire qu'on ne veut pas savoir si elle est
 * indexée — souvent l'inverse. Les confondre ferait taire l'indexation des pages qu'on a
 * volontairement décidé de ne pas pousser.
 */
export function matchesExclude(url: string, patterns: readonly string[]): boolean {
	if (patterns.length === 0) return false;
	return patterns.some((p) => p !== '' && url.includes(p));
}

// ── Producteurs d'intentions (lot 2) ────────────────────────────────

/**
 * IDX-004 lot 2 — les échéances d'une publication (J+3, J+7, J+28).
 *
 * ⚠️ **Ces candidats ne passent PAS par `allocate`, et c'est structurel.** `dedupeCandidates`
 * fusionne par URL : trois échéances de la même page y deviendraient une seule ligne. La règle
 * « une URL, un slot » vaut pour une JOURNÉE — deux raisons le même jour, c'est une mesure et
 * un appel. Trois dates futures ne sont pas trois fois la même dépense, ce sont trois
 * rendez-vous distincts, et c'est la clé `(url_normalized, due_date)` qui les sépare.
 *
 * Rend `[]` si l'URL n'est pas normalisable : une échéance sur une URL qu'on ne sait pas
 * comparer à sa propre mesure serait due pour toujours et jamais honorable.
 */
export function postPublishSelections(input: {
	url: string;
	/** Date de publication `YYYY-MM-DD` — la BASE des offsets, jamais « aujourd'hui ». */
	publishedDate: string;
	offsets: readonly number[];
	contentId?: string | null;
}): SelectedUrl[] {
	const normalized = normalizeUrl(input.url);
	if (!normalized.ok) return [];
	// Date illisible : `addDays` rendrait la chaîne inchangée, donc trois échéances IDENTIQUES
	// et fausses (dont deux perdues au `ON CONFLICT`). Mieux vaut ne rien poser.
	if (daysBetween(input.publishedDate, input.publishedDate) === null) return [];

	return input.offsets.map((offsetDays, i) => ({
		url: input.url,
		urlNormalized: normalized.normalized,
		reason: 'post_publish' as const,
		reasonDetail: {
			contentId: input.contentId ?? null,
			publishedAt: input.publishedDate,
			offsetDays
		},
		// Poids décroissant avec l'offset : à échéances égales, le J+3 passe avant le J+28.
		weight: -offsetDays,
		dueDate: addDays(input.publishedDate, offsetDays),
		bucket: 'priority' as const,
		family: 'urgent' as const,
		rank: i,
		alsoBecause: []
	}));
}

export interface ManualSelectionSplit {
	kept: SelectedUrl[];
	/** Coupées par le budget — le BAS de la liste écrite par l'humain, jamais un choix opaque. */
	truncated: string[];
	/** Non normalisables : elles ne pourraient jamais être comparées à leur propre mesure. */
	unnormalizable: string[];
	/** Doublons d'URL dans l'entrée, fusionnés avant tout comptage. */
	merged: number;
}

/**
 * IDX-004 lot 2 — l'entrée d'un audit manuel, ramenée à ce que le budget autorise.
 *
 * L'ORDRE D'ENTRÉE EST CONSERVÉ : pas de tri par famille (elles sont toutes `manual`), pas de
 * poids. Ce qui est coupé est donc la fin de la liste que l'opérateur a écrite — un tri
 * réordonnerait sa priorité à sa place, puis couperait ailleurs qu'il ne croit.
 *
 * `budget` est appliqué tel quel, `0` compris : ici comme partout dans ce module, **`0` veut
 * dire zéro**, jamais « illimité ».
 */
export function manualSelections(input: {
	urls: readonly string[];
	today: string;
	budget: number;
	note?: string | null;
}): ManualSelectionSplit {
	const unnormalizable: string[] = [];
	const seen = new Set<string>();
	const candidates: SelectedUrl[] = [];
	let merged = 0;

	for (const raw of input.urls) {
		const normalized = normalizeUrl(raw);
		if (!normalized.ok) {
			unnormalizable.push(raw);
			continue;
		}
		if (seen.has(normalized.normalized)) {
			merged += 1;
			continue;
		}
		seen.add(normalized.normalized);
		candidates.push({
			url: raw,
			urlNormalized: normalized.normalized,
			reason: 'manual',
			reasonDetail: { note: input.note ?? null, requestedAt: input.today },
			weight: 0,
			dueDate: input.today,
			bucket: 'priority',
			family: 'urgent',
			rank: candidates.length,
			alsoBecause: []
		});
	}

	const budget = Math.max(0, Math.floor(input.budget));
	return {
		kept: candidates.slice(0, budget),
		truncated: candidates.slice(budget).map((c) => c.url),
		unnormalizable,
		merged
	};
}
