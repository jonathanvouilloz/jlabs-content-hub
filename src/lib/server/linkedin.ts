import { env } from '$env/dynamic/private';
import { encrypt, decrypt } from './crypto.js';
import { db } from './db/index.js';
import { linkedinSettings } from './db/schema.js';
import { eq } from 'drizzle-orm';

interface Tokens {
	access_token: string;
	refresh_token?: string;
	expiry: string;
}

// ── Settings helpers ───────────────────────────────────────────────

async function getSetting(key: string): Promise<string | null> {
	const row = await db.select().from(linkedinSettings).where(eq(linkedinSettings.key, key)).get();
	return row?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
	await db
		.insert(linkedinSettings)
		.values({ key, value })
		.onConflictDoUpdate({ target: linkedinSettings.key, set: { value } });
}

async function deleteSetting(key: string): Promise<void> {
	await db.delete(linkedinSettings).where(eq(linkedinSettings.key, key));
}

// ── Auth ──────────────────────────────────────────────────────────

export function getAuthUrl(origin: string): string {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: env.LINKEDIN_CLIENT_ID || '',
		redirect_uri: `${origin}/api/auth/linkedin/callback`,
		scope: 'openid profile w_member_social',
		state: 'linkedin_auth'
	});

	return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}

export async function exchangeCode(code: string, origin: string): Promise<Tokens> {
	const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: env.LINKEDIN_CLIENT_ID || '',
			client_secret: env.LINKEDIN_CLIENT_SECRET || '',
			redirect_uri: `${origin}/api/auth/linkedin/callback`
		})
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`LinkedIn token exchange failed: ${res.status} ${text}`);
	}

	const data = await res.json();

	return {
		access_token: data.access_token,
		refresh_token: data.refresh_token,
		expiry: new Date(Date.now() + (data.expires_in ?? 5184000) * 1000).toISOString()
	};
}

export async function refreshAccessToken(): Promise<Tokens> {
	const encryptedTokens = await getSetting('account_tokens');
	if (!encryptedTokens) throw new Error('LinkedIn account not connected');

	const tokens: Tokens = JSON.parse(decrypt(encryptedTokens));

	// Return if still valid
	if (new Date(tokens.expiry) > new Date()) {
		return tokens;
	}

	// Try refresh if we have a refresh token
	if (!tokens.refresh_token) {
		throw new Error('LinkedIn token expired and no refresh token available. Please reconnect.');
	}

	const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: tokens.refresh_token,
			client_id: env.LINKEDIN_CLIENT_ID || '',
			client_secret: env.LINKEDIN_CLIENT_SECRET || ''
		})
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`LinkedIn token refresh failed: ${res.status} ${text}`);
	}

	const data = await res.json();
	const newTokens: Tokens = {
		access_token: data.access_token,
		refresh_token: tokens.refresh_token,
		expiry: new Date(Date.now() + (data.expires_in ?? 5184000) * 1000).toISOString()
	};

	await setSetting('account_tokens', encrypt(JSON.stringify(newTokens)));
	return newTokens;
}

// ── Profile ───────────────────────────────────────────────────────

export async function getProfile(accessToken: string): Promise<{ id: string; name: string }> {
	const res = await fetch('https://api.linkedin.com/v2/userinfo', {
		headers: { Authorization: `Bearer ${accessToken}` }
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`LinkedIn profile fetch failed: ${res.status} ${text}`);
	}

	const data = await res.json();
	return {
		id: data.sub,
		name: data.name || `${data.given_name ?? ''} ${data.family_name ?? ''}`.trim()
	};
}

// ── Publishing ────────────────────────────────────────────────────

export async function publishPost(
	text: string
): Promise<{ success: boolean; post_id?: string; error?: string }> {
	const tokens = await refreshAccessToken();
	const personId = await getSetting('person_id');

	if (!personId) {
		return { success: false, error: 'LinkedIn person ID not configured' };
	}

	const res = await fetch('https://api.linkedin.com/rest/posts', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${tokens.access_token}`,
			'Content-Type': 'application/json',
			'LinkedIn-Version': '202401',
			'X-Restli-Protocol-Version': '2.0.0'
		},
		body: JSON.stringify({
			author: `urn:li:person:${personId}`,
			commentary: text,
			visibility: 'PUBLIC',
			distribution: {
				feedDistribution: 'MAIN_FEED',
				targetEntities: [],
				thirdPartyDistributionChannels: []
			},
			lifecycleState: 'PUBLISHED'
		})
	});

	if (!res.ok) {
		const body = await res.text();
		return { success: false, error: `LinkedIn API ${res.status}: ${body}` };
	}

	const postId = res.headers.get('x-restli-id') ?? undefined;
	return { success: true, post_id: postId };
}

// ── Connection status ─────────────────────────────────────────────

export async function isConnected(): Promise<boolean> {
	const tokens = await getSetting('account_tokens');
	return !!tokens;
}

export async function getConnectedName(): Promise<string | null> {
	return getSetting('person_name');
}

export async function disconnect(): Promise<void> {
	await deleteSetting('account_tokens');
	await deleteSetting('person_id');
	await deleteSetting('person_name');
}

export { getSetting as getLinkedinSetting, setSetting as setLinkedinSetting };
