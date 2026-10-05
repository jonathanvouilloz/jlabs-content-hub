/**
 * GMB-011 — Vue agrégée « état des avis » pour les questions rapides d'Hermes (module PUR).
 *
 * ⚠️ Ce n'est PAS une autorité de décision. Les statuts comptés ici sont ceux que
 *    `classifyAgentReview` + `applyProjectionGate` rendent pour `GET /reviews`, calculés par le
 *    service avec exactement le même contexte : un compteur ne peut donc jamais contredire la
 *    décision avis par avis. Toute mutation (proposition, publication, réconciliation, roster)
 *    relit `GET /reviews` puis `decision.status` au moment du geste, jamais ce résumé.
 *
 * Aucun texte d'avis, nom de client, `reviewId`, URL Google ni texte de réponse ne sort d'ici :
 * les entrées n'en portent pas, le payload ne peut donc pas en contenir.
 */
import { createHash } from 'node:crypto';
import { europeZurichDayWindow, parseTimestamp, type AgentReviewStatus } from './agent-review-state.js';

export const REVIEW_STATUS_SCHEMA_VERSION = '1';
/** Même seuil que `classifyAgentReview` : au-delà, une fiche n'est plus jugeable. */
export const LOCATION_FRESHNESS_HOURS = 48;
/** Profondeur des compteurs « ouverts » : la fenêtre SLA du détecteur d'avis (GMB-002 lot 2). */
export const OPEN_LOOKBACK_DAYS = 180;
/** Propositions dont l'issue chez Google n'est pas confirmée — lues ici, jamais relancées. */
export const PENDING_CONFIRMATION_STATES = ['write_unknown', 'retry_eligible'] as const;

export type FreshnessStatus = 'healthy' | 'degraded' | 'stale' | 'unknown';

export interface StatusReviewRow {
	locationId: string;
	locationLabel: string;
	rating: number;
	createTime: string;
	status: AgentReviewStatus;
	latestProposalState: string | null;
	hasVerifiedReply: boolean;
}

export interface StatusLocationRow {
	locationId: string;
	label: string;
	lastSyncAt: string | null;
	lastSyncStatus: string | null;
	autoPublishingEnabled: boolean;
}

export interface StatusPolicyRow {
	mode: string;
	killSwitch: boolean;
	autoGenerationEnabled: boolean;
	minRatingForAutoSend: number | null;
}

export interface StatusWindow {
	fromInclusive: string;
	toExclusive: string;
}

export interface ReviewStatusWindows {
	last24Hours: StatusWindow;
	last7Days: StatusWindow;
	today: StatusWindow & { timezone: 'Europe/Zurich' };
}

/** Fenêtres glissantes 24 h / 7 j et jour civil Europe/Zurich. Bornes : [from, to[. */
export function reviewStatusWindows(now: Date): ReviewStatusWindows {
	const to = now.toISOString();
	return {
		last24Hours: { fromInclusive: new Date(now.getTime() - 24 * 3_600_000).toISOString(), toExclusive: to },
		last7Days: { fromInclusive: new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString(), toExclusive: to },
		today: { ...europeZurichDayWindow(now), timezone: 'Europe/Zurich' }
	};
}

function toIso(value: string | null): string | null {
	const ms = parseTimestamp(value);
	return ms === null ? null : new Date(ms).toISOString();
}

export function locationFreshness(location: StatusLocationRow, now: Date): FreshnessStatus {
	const syncMs = parseTimestamp(location.lastSyncAt);
	if (location.lastSyncStatus === null && syncMs === null) return 'unknown';
	if (location.lastSyncStatus !== 'success') return 'degraded';
	if (syncMs === null) return 'unknown';
	return now.getTime() - syncMs > LOCATION_FRESHNESS_HOURS * 3_600_000 ? 'stale' : 'healthy';
}

/** Le pire des états : une panne (`degraded`) prime sur l'ancienneté, l'ancienneté sur l'inconnu. */
const FRESHNESS_RANK: Record<FreshnessStatus, number> = { healthy: 0, unknown: 1, stale: 2, degraded: 3 };

function emptyCounts() {
	return {
		reviews: 0,
		ratings: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } as Record<'1' | '2' | '3' | '4' | '5', number>,
		eligibleAuto: 0,
		requiresHuman: 0,
		sensitiveOrBlocked: 0,
		alreadyReplied: 0,
		writeUnknown: 0,
		staleOrUnhealthyLocation: 0,
		verifiedReplies: 0,
		pendingConfirmations: 0
	};
}

type PeriodCounts = ReturnType<typeof emptyCounts>;

const STATUS_FIELD: Record<AgentReviewStatus, keyof Omit<PeriodCounts, 'reviews' | 'ratings' | 'verifiedReplies' | 'pendingConfirmations'>> = {
	eligible_auto: 'eligibleAuto',
	requires_human: 'requiresHuman',
	sensitive_or_blocked: 'sensitiveOrBlocked',
	already_replied: 'alreadyReplied',
	write_unknown: 'writeUnknown',
	stale_or_unhealthy_location: 'staleOrUnhealthyLocation'
};

function isPendingConfirmation(state: string | null): boolean {
	return state !== null && (PENDING_CONFIRMATION_STATES as readonly string[]).includes(state);
}

function addTo(counts: PeriodCounts, row: StatusReviewRow) {
	counts.reviews += 1;
	const key = String(row.rating) as keyof PeriodCounts['ratings'];
	if (key in counts.ratings) counts.ratings[key] += 1;
	counts[STATUS_FIELD[row.status]] += 1;
	if (row.hasVerifiedReply) counts.verifiedReplies += 1;
	if (isPendingConfirmation(row.latestProposalState)) counts.pendingConfirmations += 1;
}

function inWindow(ms: number, window: StatusWindow): boolean {
	return ms >= Date.parse(window.fromInclusive) && ms < Date.parse(window.toExclusive);
}

export function summarizePolicy(policy: StatusPolicyRow | null) {
	if (!policy) return { status: 'unknown' as const, mode: null, autoPublishingEnabled: false, minimumAutoRating: null };
	const autoPublishingEnabled = policy.mode === 'guarded_auto' && policy.autoGenerationEnabled && !policy.killSwitch;
	return {
		status: autoPublishingEnabled ? ('active' as const) : ('disabled' as const),
		mode: policy.mode,
		autoPublishingEnabled,
		minimumAutoRating: policy.minRatingForAutoSend
	};
}

export function summarizeReviewStatus(input: {
	projectSlug: string;
	now: Date;
	reviews: readonly StatusReviewRow[];
	locations: readonly StatusLocationRow[];
	policy: StatusPolicyRow | null;
	/** Toutes propositions confondues (quel que soit l'âge de l'avis), dernière par avis. */
	pendingConfirmationsByLocation: ReadonlyMap<string, number>;
}) {
	const windows = reviewStatusWindows(input.now);
	const periods = { last24Hours: emptyCounts(), last7Days: emptyCounts(), today: emptyCounts() };
	const openFromMs = input.now.getTime() - OPEN_LOOKBACK_DAYS * 24 * 3_600_000;

	const byLocation = new Map<string, {
		locationId: string;
		label: string;
		location: StatusLocationRow | null;
		reviewsLast24Hours: number;
		reviewsLast7Days: number;
		requiresHumanOpen: number;
		sensitiveOpen: number;
	}>();
	const slot = (locationId: string, label: string) => {
		let entry = byLocation.get(locationId);
		if (!entry) {
			entry = { locationId, label, location: null, reviewsLast24Hours: 0, reviewsLast7Days: 0, requiresHumanOpen: 0, sensitiveOpen: 0 };
			byLocation.set(locationId, entry);
		}
		return entry;
	};
	for (const location of input.locations) slot(location.locationId, location.label).location = location;

	for (const row of input.reviews) {
		const ms = parseTimestamp(row.createTime);
		if (ms === null) continue;
		const entry = slot(row.locationId, row.locationLabel);
		if (inWindow(ms, windows.last24Hours)) {
			addTo(periods.last24Hours, row);
			entry.reviewsLast24Hours += 1;
		}
		if (inWindow(ms, windows.last7Days)) {
			addTo(periods.last7Days, row);
			entry.reviewsLast7Days += 1;
		}
		if (inWindow(ms, windows.today)) addTo(periods.today, row);
		if (ms >= openFromMs) {
			if (row.status === 'requires_human') entry.requiresHumanOpen += 1;
			if (row.status === 'sensitive_or_blocked') entry.sensitiveOpen += 1;
		}
	}

	const locations = [...byLocation.values()]
		.sort((a, b) => a.label.localeCompare(b.label, 'fr') || a.locationId.localeCompare(b.locationId))
		.map((entry) => {
			const location = entry.location;
			const freshnessStatus: FreshnessStatus = location ? locationFreshness(location, input.now) : 'unknown';
			return {
				locationId: entry.locationId,
				label: entry.label,
				freshnessStatus,
				lastSyncAt: toIso(location?.lastSyncAt ?? null),
				// Le collecteur écrit `last_sync_at` AUSSI en échec : la date n'est un succès
				// que si le statut l'est. Aucune colonne ne garde le dernier succès d'une fiche en panne.
				lastSuccessfulSyncAt: location?.lastSyncStatus === 'success' ? toIso(location.lastSyncAt) : null,
				autoPublishingEnabled: location?.autoPublishingEnabled ?? false,
				reviewsLast24Hours: entry.reviewsLast24Hours,
				reviewsLast7Days: entry.reviewsLast7Days,
				requiresHumanOpen: entry.requiresHumanOpen,
				sensitiveOpen: entry.sensitiveOpen,
				pendingConfirmations: input.pendingConfirmationsByLocation.get(entry.locationId) ?? 0
			};
		});

	const overallStatus: FreshnessStatus = locations.length === 0
		? 'unknown'
		: locations.reduce<FreshnessStatus>(
				(worst, location) => (FRESHNESS_RANK[location.freshnessStatus] > FRESHNESS_RANK[worst] ? location.freshnessStatus : worst),
				'healthy'
			);
	const successes = locations.map((l) => l.lastSuccessfulSyncAt).filter((v): v is string => v !== null).sort();
	const syncs = locations.map((l) => l.lastSyncAt);

	return {
		schemaVersion: REVIEW_STATUS_SCHEMA_VERSION,
		generatedAt: input.now.toISOString(),
		project: input.projectSlug,
		freshness: {
			overallStatus,
			maxLocationAgeHours: LOCATION_FRESHNESS_HOURS,
			lastSuccessfulCollectionAt: successes.at(-1) ?? null,
			// Une fiche jamais synchronisée rend la borne inconnue : `null`, pas la plus vieille des autres.
			oldestLocationSyncAt: syncs.length === 0 || syncs.includes(null) ? null : [...(syncs as string[])].sort()[0]
		},
		windows,
		openLookbackDays: OPEN_LOOKBACK_DAYS,
		periods,
		pendingConfirmationsTotal: [...input.pendingConfirmationsByLocation.values()].reduce((sum, n) => sum + n, 0),
		locations,
		policy: summarizePolicy(input.policy)
	};
}

export type ReviewStatusPayload = ReturnType<typeof summarizeReviewStatus>;

/**
 * ETag fort sur le CONTENU. `generatedAt` et les bornes des fenêtres glissantes sont exclus :
 * ils changent à chaque requête, et l'ETag ne servirait alors jamais un 304. Ce qui compte
 * (compteurs, fraîcheur, policy) y est, donc deux réponses au même ETag disent la même chose.
 */
export function reviewStatusEtag(payload: ReviewStatusPayload): string {
	const { generatedAt: _generatedAt, windows: _windows, ...content } = payload;
	return `"${createHash('sha256').update(JSON.stringify(content)).digest('hex')}"`;
}
