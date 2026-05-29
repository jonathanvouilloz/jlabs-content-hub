import { env } from '$env/dynamic/private';
import { encrypt, decrypt } from './crypto.js';
import { db } from './db/index.js';
import {
	gmbSettings,
	projectGmbLocations,
	gmbReviews,
	gmbLocationProfiles,
	gmbInsightsDaily
} from './db/schema.js';
import { and, eq } from 'drizzle-orm';
import { createId } from './utils.js';

interface Tokens {
	access_token: string;
	refresh_token: string;
	expiry: string;
}

interface GmbPost {
	id: string;
	title: string;
	body: string;
	type: string;
	ctaAction: string | null;
	ctaUrl: string | null;
	imageUrl: string | null;
	eventStartDate: string | null;
	eventEndDate: string | null;
}

interface GmbLocation {
	name: string;
	title: string;
	address: string;
}

interface PublishResult {
	locationId: string;
	label: string;
	success: boolean;
	gmb_post_id?: string;
	error?: string;
	durationMs?: number;
}

// ── Settings helpers ───────────────────────────────────────────────

async function getSetting(key: string): Promise<string | null> {
	const row = await db.select().from(gmbSettings).where(eq(gmbSettings.key, key)).get();
	return row?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
	await db
		.insert(gmbSettings)
		.values({ key, value })
		.onConflictDoUpdate({ target: gmbSettings.key, set: { value } });
}

// ── Token management ───────────────────────────────────────────────

function parseIsoDate(iso: string): { year: number; month: number; day: number } {
	const d = new Date(iso);
	return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Construit le `event.schedule` attendu par l'API GBP v4.
// Google exige que l'instant de début soit strictement avant l'instant de fin.
// Sans `startTime`/`endTime`, début et fin valent 00:00 : un event/offer mono-jour
// (start === end) est alors rejeté ("Start date must occur before end date").
// On clamp les dates inversées et on ajoute des heures pour le mono-jour.
function buildEventSchedule(
	startIso: string,
	endIso: string
): Record<string, unknown> {
	const start = parseIsoDate(startIso);
	let end = parseIsoDate(endIso);
	const num = (d: { year: number; month: number; day: number }) =>
		d.year * 10000 + d.month * 100 + d.day;

	if (num(end) < num(start)) end = start; // dates inversées → clamp

	const schedule: Record<string, unknown> = { startDate: start, endDate: end };

	if (num(start) === num(end)) {
		// mono-jour : forcer des instants distincts
		schedule.startTime = { hours: 0, minutes: 0 };
		schedule.endTime = { hours: 23, minutes: 59 };
	}

	return schedule;
}

function mapType(type: string): string {
	switch (type) {
		case 'event':
			return 'EVENT';
		case 'offer':
			return 'OFFER';
		default:
			return 'STANDARD';
	}
}

export function decryptTokens(encrypted: string): Tokens {
	return JSON.parse(decrypt(encrypted));
}

export async function refreshAccountToken(): Promise<Tokens> {
	const encryptedTokens = await getSetting('account_tokens');
	if (!encryptedTokens) throw new Error('No account tokens configured');

	const tokens = decryptTokens(encryptedTokens);

	if (new Date(tokens.expiry) > new Date()) {
		return tokens;
	}

	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID || '',
			client_secret: env.GOOGLE_CLIENT_SECRET || '',
			refresh_token: tokens.refresh_token,
			grant_type: 'refresh_token'
		})
	});

	if (!res.ok) {
		const text = await res.text();
		// Non-blocking critical alert (deduped 1h)
		const { sendCriticalError } = await import('./notifications.js');
		sendCriticalError('Refresh token Google échoué', `Status ${res.status}\n${text}`).catch(() => {});
		throw new Error(`Account token refresh failed: ${res.status} ${text}`);
	}

	const data = await res.json();
	const newTokens: Tokens = {
		access_token: data.access_token,
		refresh_token: tokens.refresh_token,
		expiry: new Date(Date.now() + data.expires_in * 1000).toISOString()
	};

	await setSetting('account_tokens', encrypt(JSON.stringify(newTokens)));
	return newTokens;
}

// ── Locations ──────────────────────────────────────────────────────

export async function listLocations(): Promise<GmbLocation[]> {
	const tokens = await refreshAccountToken();
	const gmbAccountId = await getSetting('account_id');
	if (!gmbAccountId) throw new Error('GMB Account ID not configured');

	const locations: GmbLocation[] = [];
	let pageToken: string | undefined;

	do {
		const params = new URLSearchParams({ readMask: 'name,title,storefrontAddress' });
		if (pageToken) params.set('pageToken', pageToken);

		const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${gmbAccountId}/locations?${params}`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${tokens.access_token}` }
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`List locations failed: ${res.status} ${text}`);
		}

		const data = await res.json();
		if (data.locations) {
			for (const loc of data.locations) {
				const addr = loc.storefrontAddress;
				const addressParts: string[] = [];
				if (addr?.addressLines) addressParts.push(...addr.addressLines);
				if (addr?.postalCode) addressParts.push(addr.postalCode);
				if (addr?.locality) addressParts.push(addr.locality);

				locations.push({
					name: loc.name,
					title: loc.title || loc.name,
					address: addressParts.join(', ') || ''
				});
			}
		}

		pageToken = data.nextPageToken;
	} while (pageToken);

	return locations;
}

// ── Publishing ─────────────────────────────────────────────────────

async function callGmbApi(
	locationId: string,
	tokens: Tokens,
	post: GmbPost,
	isRetry = false
): Promise<{ success: boolean; gmb_post_id?: string; error?: string }> {
	const rawAccountId = await getSetting('account_id');
	const accountId = rawAccountId?.replace(/^accounts\//, '') ?? '';
	const locId = locationId.replace(/^locations\//, '');
	const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locId}/localPosts`;

	const body: Record<string, unknown> = {
		topicType: mapType(post.type),
		summary: post.body
	};

	if (post.ctaAction && post.ctaUrl) {
		body.callToAction = {
			actionType: post.ctaAction,
			url: post.ctaUrl
		};
	}

	if (post.imageUrl) {
		body.media = [{ mediaFormat: 'PHOTO', sourceUrl: post.imageUrl }];
	}

	if ((post.type === 'event' || post.type === 'offer') && post.eventStartDate && post.eventEndDate) {
		body.event = {
			title: post.title,
			schedule: buildEventSchedule(post.eventStartDate, post.eventEndDate)
		};
	}

	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${tokens.access_token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});

	if (res.status === 401 && !isRetry) {
		const newTokens = await refreshAccountToken();
		return callGmbApi(locationId, newTokens, post, true);
	}

	if (!res.ok) {
		const text = await res.text();
		return { success: false, error: `GMB API ${res.status}: ${text}` };
	}

	const data = await res.json();
	return { success: true, gmb_post_id: data.name };
}

export async function publishPost(
	locationId: string,
	post: GmbPost
): Promise<{ success: boolean; gmb_post_id?: string; error?: string }> {
	const accountTokens = await getSetting('account_tokens');
	if (!accountTokens) {
		return { success: false, error: 'Google account not connected' };
	}

	const tokens = await refreshAccountToken();
	return callGmbApi(locationId, tokens, post);
}

// ── Multi-location helpers ────────────────────────────────────────

export async function getProjectLocations(projectId: string) {
	return db
		.select()
		.from(projectGmbLocations)
		.where(eq(projectGmbLocations.projectId, projectId));
}

export async function resolveTargetLocations(
	projectId: string,
	meta: { target_locations?: string[] } | null
): Promise<typeof projectGmbLocations.$inferSelect[]> {
	const allLocations = await getProjectLocations(projectId);

	if (meta?.target_locations?.length) {
		const targetSet = new Set(meta.target_locations);
		return allLocations.filter((loc) => targetSet.has(loc.gmbLocationId));
	}

	return allLocations;
}

export async function publishToLocations(
	post: GmbPost,
	locations: { gmbLocationId: string; label: string }[]
): Promise<{ results: PublishResult[]; allSuccess: boolean }> {
	const results: PublishResult[] = [];

	for (const loc of locations) {
		const start = Date.now();
		const result = await publishPost(loc.gmbLocationId, post);
		const durationMs = Date.now() - start;
		results.push({
			locationId: loc.gmbLocationId,
			label: loc.label,
			success: result.success,
			gmb_post_id: result.gmb_post_id,
			error: result.error,
			durationMs
		});
	}

	return {
		results,
		allSuccess: results.every((r) => r.success)
	};
}

// ── Reviews ───────────────────────────────────────────────────────

export interface GmbReview {
	reviewId: string;
	locationId: string;
	locationLabel: string;
	authorName: string;
	rating: number;
	comment: string;
	createTime: string;
	reply: string | null;
	replyTime: string | null;
}

export async function fetchLocationReviews(
	locationId: string,
	tokens: Tokens,
	isRetry = false
): Promise<GmbReview[]> {
	const rawAccountId = await getSetting('account_id');
	const accountId = rawAccountId?.replace(/^accounts\//, '') ?? '';
	const locId = locationId.replace(/^locations\//, '');

	const reviews: GmbReview[] = [];
	let pageToken: string | undefined;

	do {
		const params = new URLSearchParams({ pageSize: '50' });
		if (pageToken) params.set('pageToken', pageToken);

		const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locId}/reviews?${params}`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${tokens.access_token}` }
		});

		if (res.status === 401 && !isRetry) {
			const newTokens = await refreshAccountToken();
			return fetchLocationReviews(locationId, newTokens, true);
		}

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Fetch reviews failed: ${res.status} ${text}`);
		}

		const data = await res.json();
		if (data.reviews) {
			for (const r of data.reviews) {
				reviews.push({
					reviewId: r.name || r.reviewId,
					locationId,
					locationLabel: '',
					authorName: r.reviewer?.displayName || 'Anonyme',
					rating: r.starRating ? starRatingToNumber(r.starRating) : 0,
					comment: r.comment || '',
					createTime: r.createTime || '',
					reply: r.reviewReply?.comment || null,
					replyTime: r.reviewReply?.updateTime || null
				});
			}
		}

		pageToken = data.nextPageToken;
	} while (pageToken);

	return reviews;
}

function starRatingToNumber(rating: string): number {
	const map: Record<string, number> = {
		ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5
	};
	return map[rating] ?? 0;
}

export async function fetchProjectReviews(
	projectId: string,
	maxAgeDays = 30
): Promise<GmbReview[]> {
	const tokens = await refreshAccountToken();
	const locations = await getProjectLocations(projectId);

	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - maxAgeDays);

	const allReviews: GmbReview[] = [];

	for (const loc of locations) {
		const reviews = await fetchLocationReviews(loc.gmbLocationId, tokens);
		for (const r of reviews) {
			r.locationLabel = loc.label;
		}
		allReviews.push(...reviews);
	}

	return allReviews
		.filter((r) => !r.reply && new Date(r.createTime) >= cutoff)
		.sort((a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime());
}

export async function replyToReview(
	locationId: string,
	reviewId: string,
	replyBody: string
): Promise<{ success: boolean; error?: string }> {
	const tokens = await refreshAccountToken();
	const rawAccountId = await getSetting('account_id');
	const accountId = rawAccountId?.replace(/^accounts\//, '') ?? '';
	const locId = locationId.replace(/^locations\//, '');

	// reviewId can be full path or just the ID
	const revId = reviewId.includes('/') ? reviewId.split('/').pop() : reviewId;

	const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locId}/reviews/${revId}/reply`;
	const res = await fetch(url, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${tokens.access_token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ comment: replyBody })
	});

	if (!res.ok) {
		const text = await res.text();
		return { success: false, error: `Reply failed: ${res.status} ${text}` };
	}

	return { success: true };
}

export async function syncProjectReviews(projectId: string): Promise<number> {
	const reviews = await fetchProjectReviews(projectId);
	let synced = 0;

	for (const r of reviews) {
		const result = await db
			.insert(gmbReviews)
			.values({
				id: createId(),
				projectId,
				locationId: r.locationId,
				locationLabel: r.locationLabel,
				reviewId: r.reviewId,
				authorName: r.authorName,
				rating: r.rating,
				comment: r.comment,
				createTime: r.createTime
			})
			.onConflictDoNothing();

		if (result.rowsAffected > 0) synced++;
	}

	return synced;
}

export async function markReviewAsReplied(reviewId: string): Promise<void> {
	await db.update(gmbReviews)
		.set({ repliedAt: new Date().toISOString() })
		.where(eq(gmbReviews.reviewId, reviewId));
}

/** Parse gmbPostId field — handles legacy string and new JSON map */
export function parseGmbPostIds(raw: string | null): Record<string, string> | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === 'object' && parsed !== null) return parsed;
	} catch {
		/* legacy single string */
	}
	return { _legacy: raw };
}

/** Build gmbPostId JSON map from publish results */
export function buildGmbPostIdMap(results: PublishResult[]): string {
	const map: Record<string, string> = {};
	for (const r of results) {
		if (r.success && r.gmb_post_id) {
			map[r.locationId] = r.gmb_post_id;
		}
	}
	return JSON.stringify(map);
}

export { getSetting as getGmbSetting, setSetting as setGmbSetting };

// ── Profile (Business Information API v1) ─────────────────────────

const PROFILE_READ_MASK = [
	'title',
	'storefrontAddress',
	'phoneNumbers',
	'websiteUri',
	'regularHours',
	'specialHours',
	'categories',
	'serviceItems',
	'profile',
	'labels',
	'latlng',
	'storeCode',
	'openInfo',
	'metadata',
	'languageCode'
].join(',');

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface RawLocation {
	name: string;
	title?: string;
	storefrontAddress?: {
		regionCode?: string;
		languageCode?: string;
		postalCode?: string;
		administrativeArea?: string;
		locality?: string;
		addressLines?: string[];
	};
	phoneNumbers?: {
		primaryPhone?: string;
		additionalPhones?: string[];
	};
	websiteUri?: string;
	regularHours?: { periods?: any[] };
	specialHours?: { specialHourPeriods?: any[] };
	categories?: {
		primaryCategory?: { name?: string; displayName?: string };
		additionalCategories?: Array<{ name?: string; displayName?: string }>;
	};
	serviceItems?: any[];
	profile?: { description?: string };
	labels?: string[];
	latlng?: { latitude?: number; longitude?: number };
	storeCode?: string;
	openInfo?: {
		status?: string;
		canReopen?: boolean;
		openingDate?: { year?: number; month?: number; day?: number };
	};
	metadata?: {
		hasPendingEdits?: boolean;
		placeId?: string;
		mapsUri?: string;
		newReviewUri?: string;
		canHaveBusinessCalls?: boolean;
		duplicateLocation?: string;
	};
	languageCode?: string;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function callBusinessInfoApi(
	url: string,
	init: RequestInit,
	isRetry = false
): Promise<Response> {
	const tokens = await refreshAccountToken();
	const headers = new Headers(init.headers);
	headers.set('Authorization', `Bearer ${tokens.access_token}`);
	if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

	const res = await fetch(url, { ...init, headers });

	if (res.status === 401 && !isRetry) {
		// Force refresh by clearing expiry — refreshAccountToken refetches if expired.
		const encryptedTokens = await getSetting('account_tokens');
		if (encryptedTokens) {
			const current = decryptTokens(encryptedTokens);
			await setSetting(
				'account_tokens',
				encrypt(JSON.stringify({ ...current, expiry: '1970-01-01T00:00:00.000Z' }))
			);
		}
		return callBusinessInfoApi(url, init, true);
	}

	return res;
}

export async function fetchLocationFull(locationId: string): Promise<RawLocation> {
	const name = locationId.startsWith('locations/') ? locationId : `locations/${locationId}`;
	const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${name}?readMask=${PROFILE_READ_MASK}`;
	const res = await callBusinessInfoApi(url, { method: 'GET' });

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Fetch location failed: ${res.status} ${text}`);
	}

	return (await res.json()) as RawLocation;
}

export async function patchLocation(
	locationId: string,
	updateMask: string,
	body: Record<string, unknown>
): Promise<RawLocation> {
	const name = locationId.startsWith('locations/') ? locationId : `locations/${locationId}`;
	const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${name}?updateMask=${encodeURIComponent(updateMask)}`;
	const res = await callBusinessInfoApi(url, {
		method: 'PATCH',
		body: JSON.stringify(body)
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Patch location failed: ${res.status} ${text}`);
	}

	return (await res.json()) as RawLocation;
}

function formatAddress(addr: RawLocation['storefrontAddress']): string {
	if (!addr) return '';
	const parts: string[] = [];
	if (addr.addressLines) parts.push(...addr.addressLines);
	if (addr.postalCode) parts.push(addr.postalCode);
	if (addr.locality) parts.push(addr.locality);
	return parts.filter(Boolean).join(', ');
}

export async function syncLocationProfile(
	projectId: string,
	locationId: string
): Promise<typeof gmbLocationProfiles.$inferSelect> {
	const raw = await fetchLocationFull(locationId);

	const values = {
		projectId,
		gmbLocationId: raw.name,
		title: raw.title ?? locationId,
		phone: raw.phoneNumbers?.primaryPhone ?? null,
		websiteUri: raw.websiteUri ?? null,
		storeCode: raw.storeCode ?? null,
		primaryCategoryDisplay: raw.categories?.primaryCategory?.displayName ?? null,
		primaryCategoryId: raw.categories?.primaryCategory?.name ?? null,
		formattedAddress: formatAddress(raw.storefrontAddress),
		latitude: raw.latlng?.latitude ?? null,
		longitude: raw.latlng?.longitude ?? null,
		openStatus: raw.openInfo?.status ?? null,
		storefrontAddress: raw.storefrontAddress ? JSON.stringify(raw.storefrontAddress) : null,
		additionalPhones: raw.phoneNumbers?.additionalPhones
			? JSON.stringify(raw.phoneNumbers.additionalPhones)
			: null,
		additionalCategories: raw.categories?.additionalCategories
			? JSON.stringify(raw.categories.additionalCategories)
			: null,
		regularHours: raw.regularHours ? JSON.stringify(raw.regularHours) : null,
		specialHours: raw.specialHours ? JSON.stringify(raw.specialHours) : null,
		serviceItems: raw.serviceItems ? JSON.stringify(raw.serviceItems) : null,
		profileDescription: raw.profile?.description ?? null,
		labels: raw.labels ? JSON.stringify(raw.labels) : null,
		attributes: null,
		rawPayload: JSON.stringify(raw),
		etag: null,
		syncedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	};

	const existing = await db
		.select()
		.from(gmbLocationProfiles)
		.where(
			and(
				eq(gmbLocationProfiles.projectId, projectId),
				eq(gmbLocationProfiles.gmbLocationId, raw.name)
			)
		)
		.get();

	if (existing) {
		await db
			.update(gmbLocationProfiles)
			.set(values)
			.where(eq(gmbLocationProfiles.id, existing.id));
		return { ...existing, ...values };
	}

	const id = createId();
	const inserted = { id, ...values };
	await db.insert(gmbLocationProfiles).values(inserted);
	return inserted as typeof gmbLocationProfiles.$inferSelect;
}

// ── Insights (Business Profile Performance API v1) ────────────────

export type GmbMetric =
	| 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS'
	| 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'
	| 'BUSINESS_IMPRESSIONS_MOBILE_MAPS'
	| 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'
	| 'WEBSITE_CLICKS'
	| 'CALL_CLICKS'
	| 'BUSINESS_DIRECTION_REQUESTS';

export const ALL_METRICS: GmbMetric[] = [
	'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
	'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
	'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
	'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
	'WEBSITE_CLICKS',
	'CALL_CLICKS',
	'BUSINESS_DIRECTION_REQUESTS'
];

interface DatedValue {
	date: { year: number; month: number; day: number };
	value?: string;
}

function pad2(n: number): string {
	return n.toString().padStart(2, '0');
}

function isoFromDateObj(d: { year: number; month: number; day: number }): string {
	return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;
}

function isoToParts(iso: string): { year: number; month: number; day: number } {
	const [y, m, d] = iso.split('-').map(Number);
	return { year: y, month: m, day: d };
}

export async function fetchInsights(
	locationId: string,
	startDate: string,
	endDate: string,
	metrics: GmbMetric[]
): Promise<Array<{ date: string; metric: GmbMetric; value: number }>> {
	const locId = locationId.replace(/^locations\//, '');
	const params = new URLSearchParams();
	for (const m of metrics) params.append('dailyMetrics', m);
	const start = isoToParts(startDate);
	const end = isoToParts(endDate);
	params.set('dailyRange.startDate.year', String(start.year));
	params.set('dailyRange.startDate.month', String(start.month));
	params.set('dailyRange.startDate.day', String(start.day));
	params.set('dailyRange.endDate.year', String(end.year));
	params.set('dailyRange.endDate.month', String(end.month));
	params.set('dailyRange.endDate.day', String(end.day));

	const url = `https://businessprofileperformance.googleapis.com/v1/locations/${locId}:fetchMultiDailyMetricsTimeSeries?${params}`;
	const res = await callBusinessInfoApi(url, { method: 'GET' });

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Fetch insights failed: ${res.status} ${text}`);
	}

	const data = (await res.json()) as {
		multiDailyMetricTimeSeries?: Array<{
			dailyMetricTimeSeries?: Array<{
				dailyMetric: GmbMetric;
				timeSeries?: { datedValues?: DatedValue[] };
			}>;
		}>;
	};

	const points: Array<{ date: string; metric: GmbMetric; value: number }> = [];
	for (const outer of data.multiDailyMetricTimeSeries ?? []) {
		for (const inner of outer.dailyMetricTimeSeries ?? []) {
			for (const dv of inner.timeSeries?.datedValues ?? []) {
				points.push({
					date: isoFromDateObj(dv.date),
					metric: inner.dailyMetric,
					value: dv.value ? Number(dv.value) : 0
				});
			}
		}
	}
	return points;
}

export async function syncLocationInsights(
	projectId: string,
	locationId: string,
	days = 90
): Promise<{ inserted: number; updated: number }> {
	// Performance API publie avec un décalage ~3 jours → on requête jusqu'à J-3
	const end = new Date();
	end.setUTCDate(end.getUTCDate() - 3);
	const start = new Date(end);
	start.setUTCDate(start.getUTCDate() - days);

	const startIso = start.toISOString().slice(0, 10);
	const endIso = end.toISOString().slice(0, 10);

	const points = await fetchInsights(locationId, startIso, endIso, ALL_METRICS);

	let inserted = 0;
	let updated = 0;
	const fetchedAt = new Date().toISOString();
	const fullLocId = locationId.startsWith('locations/') ? locationId : `locations/${locationId}`;

	for (const p of points) {
		const existing = await db
			.select({ id: gmbInsightsDaily.id, value: gmbInsightsDaily.value })
			.from(gmbInsightsDaily)
			.where(
				and(
					eq(gmbInsightsDaily.gmbLocationId, fullLocId),
					eq(gmbInsightsDaily.date, p.date),
					eq(gmbInsightsDaily.metric, p.metric)
				)
			)
			.get();

		if (existing) {
			if (existing.value !== p.value) {
				await db
					.update(gmbInsightsDaily)
					.set({ value: p.value, fetchedAt })
					.where(eq(gmbInsightsDaily.id, existing.id));
				updated++;
			}
		} else {
			await db.insert(gmbInsightsDaily).values({
				id: createId(),
				projectId,
				gmbLocationId: fullLocId,
				date: p.date,
				metric: p.metric,
				value: p.value,
				fetchedAt
			});
			inserted++;
		}
	}

	return { inserted, updated };
}
