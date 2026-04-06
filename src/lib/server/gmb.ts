import { env } from '$env/dynamic/private';
import { encrypt, decrypt } from './crypto.js';
import { db } from './db/index.js';
import { gmbSettings, projectGmbLocations } from './db/schema.js';
import { eq } from 'drizzle-orm';

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
			schedule: {
				startDate: parseIsoDate(post.eventStartDate),
				endDate: parseIsoDate(post.eventEndDate)
			}
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
		const result = await publishPost(loc.gmbLocationId, post);
		results.push({
			locationId: loc.gmbLocationId,
			label: loc.label,
			success: result.success,
			gmb_post_id: result.gmb_post_id,
			error: result.error
		});
	}

	return {
		results,
		allSuccess: results.every((r) => r.success)
	};
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
