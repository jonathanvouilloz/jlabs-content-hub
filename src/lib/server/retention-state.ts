/**
 * DATA-008 — Helpers PURS pour la rétention, l'agrégation et la purge (SPEC §7.11).
 *
 * Zéro import (ni db, ni `$env`, ni crypto) → testables en isolation par vitest.
 * Portent les invariants d'acceptation DATA-008 :
 *   - `isExpired` : rétention `null` = sans limite → jamais expiré (agrégats, audit,
 *     findings, rapports sont protégés par une rétention infinie) ;
 *   - `isPurgeable` : seule une donnée de détail active, à rétention finie et NON
 *     protégée, peut être purgée (« aucun agrégat requis n'est supprimé ») ;
 *   - `assertPurgeAuthorized` : une suppression d'audit exige le niveau L4 ;
 *   - `derivePeriod` : buckets semaine/mois/année déterministes (agréger avant purge).
 */

// ── Vocabulaire (SPEC §7.11) ────────────────────────────────────────

/** Catégories de données pour la politique de rétention. */
export const RETENTION_CATEGORIES = ['detail', 'aggregate', 'audit', 'report', 'debug'] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

/** Grains d'agrégation avant purge (SPEC : semaine/mois/année). */
export const AGGREGATE_GRAINS = ['week', 'month', 'year'] as const;
export type AggregateGrain = (typeof AGGREGATE_GRAINS)[number];

/** Statuts d'un run de purge. */
export const PURGE_RUN_STATUSES = ['planned', 'running', 'completed', 'failed', 'aborted'] as const;
export type PurgeRunStatus = (typeof PURGE_RUN_STATUSES)[number];

const DAY_MS = 86_400_000;

// ── Normalisation des timestamps ────────────────────────────────────

/**
 * Normalise un timestamp vers un ISO UTC parsable. Les colonnes date « métier »
 * sont stockées en `'YYYY-MM-DD HH:MM:SS'` (défaut nowText) ou déjà en ISO ; une
 * date seule `'YYYY-MM-DD'` est ramenée à minuit UTC. Évite l'ambiguïté locale de
 * `Date.parse('YYYY-MM-DD HH:MM:SS')` (interprété en heure locale selon le moteur).
 */
export function normalizeTimestamp(ts: string): string {
	if (ts.length === 10) return `${ts}T00:00:00Z`; // date seule
	if (ts.length === 19 && ts[10] === ' ') return `${ts.replace(' ', 'T')}Z`; // 'YYYY-MM-DD HH:MM:SS'
	return ts; // supposé ISO
}

// ── Cutoff & expiration ─────────────────────────────────────────────

/** Date de coupure ISO : `now` moins `retentionDays` jours. */
export function computeCutoff(now: string, retentionDays: number): string {
	return new Date(Date.parse(normalizeTimestamp(now)) - retentionDays * DAY_MS).toISOString();
}

/**
 * Vrai si `timestamp` est plus vieux que la rétention. Rétention `null` = sans
 * limite (SPEC §7.11 : agrégats/audit/findings/rapports) → jamais expiré.
 */
export function isExpired(input: {
	timestamp: string;
	retentionDays: number | null | undefined;
	now: string;
}): boolean {
	if (input.retentionDays == null) return false; // sans limite prédéfinie
	const cutoffMs = Date.parse(normalizeTimestamp(input.now)) - input.retentionDays * DAY_MS;
	return Date.parse(normalizeTimestamp(input.timestamp)) < cutoffMs;
}

// ── Purgeabilité & autorisation ─────────────────────────────────────

/** Forme minimale d'une politique de rétention (miroir de la table). */
export interface RetentionPolicyShape {
	category: string;
	retentionDays: number | null;
	protected: boolean;
	active?: boolean; // absent = actif (les défauts §7.11 n'ont pas le champ ; seedés active=true)
	requiresL4?: boolean;
}

/**
 * Vrai si une donnée régie par `policy` peut être purgée. Refus par défaut :
 * une donnée protégée, explicitement inactive ou à rétention infinie n'est JAMAIS
 * purgeable (« aucun agrégat requis n'est supprimé »). `active` absent = actif.
 */
export function isPurgeable(policy: RetentionPolicyShape): boolean {
	if (policy.active === false) return false;
	if (policy.protected) return false;
	if (policy.retentionDays == null) return false;
	return true;
}

/** Vrai si la purge de cette catégorie exige une validation L4 (SPEC §7.11 : audit). */
export function requiresL4ForPurge(policy: { category: string; requiresL4?: boolean }): boolean {
	return Boolean(policy.requiresL4) || policy.category === 'audit';
}

/**
 * Garde d'autorisation de purge. Lève si la donnée exige L4 et que le niveau fourni
 * n'est pas exactement `L4` (SPEC §7.11 : « une suppression de données d'audit ne
 * peut pas être déclenchée par un agent sans validation L4 »).
 */
export function assertPurgeAuthorized(input: {
	policy: { category: string; requiresL4?: boolean };
	approvalLevel?: string | null;
	dataType?: string;
}): void {
	if (requiresL4ForPurge(input.policy) && input.approvalLevel !== 'L4') {
		throw new Error(
			`Purge refusée : ${input.dataType ?? input.policy.category} exige une validation L4 (reçu : ${input.approvalLevel ?? 'aucune'}).`
		);
	}
}

// ── Périodes d'agrégation (semaine/mois/année) ──────────────────────

function fmt(y: number, m: number, d: number): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${y}-${p(m)}-${p(d)}`;
}

/**
 * Bucket d'agrégation contenant `dateStr` (les 10 premiers caractères font foi)
 * pour un grain donné. Déterministe, en UTC :
 *   - `week`  : lundi → dimanche (semaine ISO) ;
 *   - `month` : 1er → dernier jour du mois ;
 *   - `year`  : 1er janvier → 31 décembre.
 */
export function derivePeriod(
	dateStr: string,
	grain: AggregateGrain
): { periodStart: string; periodEnd: string } {
	const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
	if (grain === 'year') {
		return { periodStart: fmt(y, 1, 1), periodEnd: fmt(y, 12, 31) };
	}
	if (grain === 'month') {
		const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // jour 0 du mois suivant = dernier du mois
		return { periodStart: fmt(y, m, 1), periodEnd: fmt(y, m, lastDay) };
	}
	// week : ramener au lundi (getUTCDay : 0=dim..6=sam → offset vers lundi)
	const base = new Date(Date.UTC(y, m - 1, d));
	const dow = base.getUTCDay();
	const toMonday = (dow + 6) % 7;
	const monday = new Date(base.getTime() - toMonday * DAY_MS);
	const sunday = new Date(monday.getTime() + 6 * DAY_MS);
	return {
		periodStart: fmt(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()),
		periodEnd: fmt(sunday.getUTCFullYear(), sunday.getUTCMonth() + 1, sunday.getUTCDate())
	};
}

/**
 * Sérialisation stable d'un tuple de dimensions (query/page, métrique, keyword…)
 * → alimente le hash d'unicité d'un agrégat (calculé côté helper avec crypto).
 * `null`/`undefined` normalisés ; ordre des dimensions préservé (à la charge de
 * l'appelant de le figer par source).
 */
export function canonicalDimensions(values: ReadonlyArray<string | number | null | undefined>): string {
	return JSON.stringify(values.map((v) => (v === undefined || v === null ? null : v)));
}

// ── Politique de rétention par défaut (SPEC §7.11) ──────────────────
//
// Donnée de config PURE (aucun accès DB) → importable par le helper (retention.ts)
// comme par le runner (scripts/purge.ts) sans tirer `$env`/`db`.

export interface RetentionDefault {
	dataType: string;
	category: RetentionCategory;
	retentionDays: number | null; // null = sans limite
	aggregateBeforePurge: boolean;
	requiresL4: boolean;
	protected: boolean;
	sourceTable: string | null; // null = policy logique (pas encore câblée au runner)
	timestampColumn: string | null;
	description: string;
}

const DETAIL_MONTHS_24 = 730; // 24 mois
const DEBUG_DAYS = 90;

/**
 * Politique validée §7.11. Détail = 24 mois (agrégé avant purge) ; agrégats,
 * findings, décisions, approbations, audit et rapports = sans limite ; payloads/logs
 * de debug = 90 jours. Les colonnes d'âge des observations = `period_end` (l'âge de
 * la DONNÉE ; `fetched_at` vaut ~now après backfill, donc inutilisable ici).
 */
export const RETENTION_DEFAULTS: RetentionDefault[] = [
	{
		dataType: 'gsc_query_page_observation',
		category: 'detail',
		retentionDays: DETAIL_MONTHS_24,
		aggregateBeforePurge: true,
		requiresL4: false,
		protected: false,
		sourceTable: 'gsc_query_page_observations',
		timestampColumn: 'period_end',
		description: 'Détail GSC requête×page — 24 mois, agrégé avant purge.'
	},
	{
		dataType: 'gsc_page_observation',
		category: 'detail',
		retentionDays: DETAIL_MONTHS_24,
		aggregateBeforePurge: true,
		requiresL4: false,
		protected: false,
		sourceTable: 'gsc_page_observations',
		timestampColumn: 'period_end',
		description: 'Rollup page GSC — 24 mois, agrégé avant purge.'
	},
	{
		dataType: 'keyword_rank_observation',
		category: 'detail',
		retentionDays: DETAIL_MONTHS_24,
		aggregateBeforePurge: true,
		requiresL4: false,
		protected: false,
		sourceTable: 'keyword_rank_observations',
		timestampColumn: 'observed_date',
		description: 'Positions keyword suivies — 24 mois, agrégé avant purge.'
	},
	{
		dataType: 'debug_payload',
		category: 'debug',
		retentionDays: DEBUG_DAYS,
		aggregateBeforePurge: false,
		requiresL4: false,
		protected: false,
		sourceTable: null, // column-level (payload_json des observations) — runner à câbler
		timestampColumn: 'fetched_at',
		description: 'Payloads techniques volumineux & logs de debug — 90 jours.'
	},
	{
		dataType: 'observation_aggregate',
		category: 'aggregate',
		retentionDays: null,
		aggregateBeforePurge: false,
		requiresL4: false,
		protected: true,
		sourceTable: 'observation_aggregates',
		timestampColumn: 'computed_at',
		description: 'Agrégats semaine/mois/année — conservés sans limite.'
	},
	{
		dataType: 'finding',
		category: 'detail',
		retentionDays: null,
		aggregateBeforePurge: false,
		requiresL4: false,
		protected: true,
		sourceTable: 'findings',
		timestampColumn: 'last_seen_at',
		description: 'Findings — conservés sans limite (interprétations persistantes).'
	},
	{
		dataType: 'decision',
		category: 'audit',
		retentionDays: null,
		aggregateBeforePurge: false,
		requiresL4: true,
		protected: true,
		sourceTable: 'action_proposals',
		timestampColumn: 'created_at',
		description: 'Décisions & approbations — sans limite ; suppression = L4.'
	},
	{
		dataType: 'audit_action',
		category: 'audit',
		retentionDays: null,
		aggregateBeforePurge: false,
		requiresL4: true,
		protected: true,
		sourceTable: 'agent_runs',
		timestampColumn: 'created_at',
		description: 'Audit des actions externes / agent runs — sans limite ; suppression = L4.'
	},
	{
		// IDX-004 — le journal des décisions de DÉPENSE DE QUOTA. Catégorie `audit` et non
		// `detail` : « pourquoi cette page a-t-elle coûté un appel le 12 mars » est une
		// question d'audit, pas une mesure qu'on agrège. Purger ce registre effacerait
		// aussi la seule trace des inspections dues et jamais honorées.
		dataType: 'index_selection',
		category: 'audit',
		retentionDays: null,
		aggregateBeforePurge: false,
		requiresL4: true,
		protected: true,
		sourceTable: 'index_selection',
		timestampColumn: 'due_date',
		description: 'Décisions de sélection d’inspection — sans limite ; suppression = L4.'
	},
	{
		dataType: 'report',
		category: 'report',
		retentionDays: null,
		aggregateBeforePurge: false,
		requiresL4: false,
		protected: true,
		sourceTable: 'seo_reports',
		timestampColumn: 'created_at',
		description: 'Rapports générés — conservés sans limite.'
	}
];
