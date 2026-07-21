import { createSign } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { indexingCredentials, indexingSubmissions } from './db/schema.js';
import { decrypt, encrypt } from './crypto.js';
import { createId } from './utils.js';

export type IndexingType = 'URL_UPDATED' | 'URL_DELETED';

interface ServiceAccountJson {
	client_email: string;
	private_key: string;
	token_uri?: string;
}

interface CachedToken {
	token: string;
	expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';
const WEBMASTERS_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const COMBINED_SCOPE = `${INDEXING_SCOPE} ${WEBMASTERS_SCOPE}`;
const PUBLISH_ENDPOINT = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const INSPECT_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

function base64url(input: Buffer | string): string {
	const buf = typeof input === 'string' ? Buffer.from(input) : input;
	return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(sa: ServiceAccountJson): string {
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: 'RS256', typ: 'JWT' };
	const claim = {
		iss: sa.client_email,
		scope: COMBINED_SCOPE,
		aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
		exp: now + 3600,
		iat: now
	};
	const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
	const signer = createSign('RSA-SHA256');
	signer.update(unsigned);
	const signature = signer.sign(sa.private_key);
	return `${unsigned}.${base64url(signature)}`;
}

async function exchangeJwtForToken(sa: ServiceAccountJson): Promise<{ access_token: string; expires_in: number }> {
	const jwt = signJwt(sa);
	const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
	const body = new URLSearchParams({
		grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
		assertion: jwt
	});
	const res = await fetch(tokenUri, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
	if (!res.ok || !json.access_token) {
		throw new Error(`Token exchange failed: ${json.error || res.status} ${json.error_description || ''}`.trim());
	}
	return { access_token: json.access_token, expires_in: json.expires_in || 3600 };
}

export async function getAccessTokenForProject(projectId: string): Promise<{ token: string; sa: ServiceAccountJson }> {
	const row = await db.query.indexingCredentials.findFirst({ where: eq(indexingCredentials.projectId, projectId) });
	if (!row) throw new Error('No indexing credentials configured for this project');
	const sa = JSON.parse(decrypt(row.serviceAccountJson)) as ServiceAccountJson;

	const cached = tokenCache.get(projectId);
	if (cached && cached.expiresAt > Date.now() + 60_000) {
		return { token: cached.token, sa };
	}
	const { access_token, expires_in } = await exchangeJwtForToken(sa);
	tokenCache.set(projectId, { token: access_token, expiresAt: Date.now() + expires_in * 1000 });
	return { token: access_token, sa };
}

export function parseServiceAccount(raw: string): ServiceAccountJson {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('Invalid JSON');
	}
	const sa = parsed as Partial<ServiceAccountJson>;
	if (!sa.client_email || !sa.private_key) {
		throw new Error('Service account JSON missing client_email or private_key');
	}
	return sa as ServiceAccountJson;
}

export async function saveCredentials(params: {
	projectId: string;
	serviceAccountJsonRaw: string;
	siteUrl?: string | null;
	sitemapUrl?: string | null;
	publicUrlTemplate?: string | null;
	autoSubmitOnPublish?: boolean;
	excludePatterns?: string[] | null;
}): Promise<{ serviceAccountEmail: string }> {
	const sa = parseServiceAccount(params.serviceAccountJsonRaw);
	const encrypted = encrypt(params.serviceAccountJsonRaw);
	const patternsJson = serializePatterns(params.excludePatterns);

	const existing = await db.query.indexingCredentials.findFirst({
		where: eq(indexingCredentials.projectId, params.projectId)
	});

	if (existing) {
		await db.update(indexingCredentials).set({
			serviceAccountEmail: sa.client_email,
			serviceAccountJson: encrypted,
			siteUrl: params.siteUrl ?? null,
			sitemapUrl: params.sitemapUrl ?? null,
			publicUrlTemplate: params.publicUrlTemplate ?? null,
			autoSubmitOnPublish: params.autoSubmitOnPublish ?? false,
			excludePatterns: patternsJson,
			updatedAt: new Date().toISOString()
		}).where(eq(indexingCredentials.id, existing.id));
	} else {
		await db.insert(indexingCredentials).values({
			id: createId(),
			projectId: params.projectId,
			serviceAccountEmail: sa.client_email,
			serviceAccountJson: encrypted,
			siteUrl: params.siteUrl ?? null,
			sitemapUrl: params.sitemapUrl ?? null,
			publicUrlTemplate: params.publicUrlTemplate ?? null,
			autoSubmitOnPublish: params.autoSubmitOnPublish ?? false,
			excludePatterns: patternsJson
		});
	}
	tokenCache.delete(params.projectId);
	return { serviceAccountEmail: sa.client_email };
}

function serializePatterns(patterns: string[] | null | undefined): string | null {
	if (!patterns) return null;
	const cleaned = patterns.map((p) => p.trim()).filter((p) => p.length > 0);
	return cleaned.length === 0 ? null : JSON.stringify(cleaned);
}

export function parseExcludePatterns(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed.filter((p) => typeof p === 'string');
	} catch {
		// fall through
	}
	return [];
}

export function matchesAnyPattern(url: string, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	for (const p of patterns) {
		if (p && url.includes(p)) return true;
	}
	return false;
}

export function partitionByPatterns(
	urls: string[],
	patterns: string[]
): { kept: string[]; excluded: string[] } {
	if (patterns.length === 0) return { kept: urls, excluded: [] };
	const kept: string[] = [];
	const excluded: string[] = [];
	for (const u of urls) {
		if (matchesAnyPattern(u, patterns)) excluded.push(u);
		else kept.push(u);
	}
	return { kept, excluded };
}

export async function deleteCredentials(projectId: string): Promise<void> {
	await db.delete(indexingCredentials).where(eq(indexingCredentials.projectId, projectId));
	tokenCache.delete(projectId);
}

export async function updateSettings(params: {
	projectId: string;
	siteUrl?: string | null;
	sitemapUrl?: string | null;
	publicUrlTemplate?: string | null;
	autoSubmitOnPublish?: boolean;
	excludePatterns?: string[] | null;
}): Promise<void> {
	const row = await db.query.indexingCredentials.findFirst({
		where: eq(indexingCredentials.projectId, params.projectId)
	});
	if (!row) throw new Error('No indexing credentials configured');
	await db.update(indexingCredentials).set({
		siteUrl: params.siteUrl ?? row.siteUrl,
		sitemapUrl: params.sitemapUrl ?? row.sitemapUrl,
		publicUrlTemplate: params.publicUrlTemplate ?? row.publicUrlTemplate,
		autoSubmitOnPublish: params.autoSubmitOnPublish ?? row.autoSubmitOnPublish,
		excludePatterns:
			params.excludePatterns === undefined ? row.excludePatterns : serializePatterns(params.excludePatterns),
		updatedAt: new Date().toISOString()
	}).where(eq(indexingCredentials.id, row.id));
}

export async function publishUrl(params: {
	projectId: string;
	url: string;
	type: IndexingType;
	source?: string;
}): Promise<{ success: boolean; httpStatus: number; response: string }> {
	const submissionId = createId();
	let token: string;
	try {
		const auth = await getAccessTokenForProject(params.projectId);
		token = auth.token;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await db.insert(indexingSubmissions).values({
			id: submissionId,
			projectId: params.projectId,
			url: params.url,
			type: params.type,
			status: 'failed',
			httpStatus: null,
			response: msg,
			source: params.source ?? null
		});
		return { success: false, httpStatus: 0, response: msg };
	}

	const res = await fetch(PUBLISH_ENDPOINT, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify({ url: params.url, type: params.type })
	});
	const text = await res.text();
	const success = res.ok;

	await db.insert(indexingSubmissions).values({
		id: submissionId,
		projectId: params.projectId,
		url: params.url,
		type: params.type,
		status: success ? 'success' : 'failed',
		httpStatus: res.status,
		response: text.slice(0, 2000),
		source: params.source ?? null
	});

	return { success, httpStatus: res.status, response: text };
}

export async function batchSubmit(params: {
	projectId: string;
	urls: string[];
	type: IndexingType;
	source?: string;
	delayMs?: number;
}): Promise<{
	total: number;
	success: number;
	failed: number;
	skipped: number;
	stoppedOnQuota: boolean;
	results: Array<{ url: string; success: boolean; httpStatus: number }>;
}> {
	const delay = params.delayMs ?? 100;
	const results: Array<{ url: string; success: boolean; httpStatus: number }> = [];
	let success = 0;
	let failed = 0;
	let stoppedOnQuota = false;
	let i = 0;
	for (; i < params.urls.length; i++) {
		const url = params.urls[i];
		const r = await publishUrl({ projectId: params.projectId, url, type: params.type, source: params.source });
		results.push({ url, success: r.success, httpStatus: r.httpStatus });
		if (r.success) success++;
		else failed++;
		if (r.httpStatus === 429) {
			stoppedOnQuota = true;
			break;
		}
		if (delay > 0) await new Promise((res) => setTimeout(res, delay));
	}
	const skipped = Math.max(0, params.urls.length - (i + 1));
	return { total: params.urls.length, success, failed, skipped, stoppedOnQuota, results };
}

export interface InspectionResult {
	url: string;
	verdict: string | null;
	coverageState: string | null;
	httpStatus: number;
	error?: string;
}

export type IndexedClassification = 'indexed' | 'not_indexed' | 'unknown';

export function classifyIndexStatus(coverageState: string | null): IndexedClassification {
	if (!coverageState) return 'unknown';
	const cs = coverageState.toLowerCase();
	if (cs.includes('not indexed')) return 'not_indexed';
	if (cs.includes('unknown to google')) return 'not_indexed';
	if (cs.includes('indexed')) return 'indexed';
	if (cs.includes('excluded')) return 'indexed'; // intentional exclusion (noindex, robots), don't resubmit
	if (cs.includes('not selected as canonical')) return 'indexed';
	return 'unknown';
}

export async function inspectUrl(params: {
	projectId: string;
	url: string;
	siteUrl: string;
}): Promise<InspectionResult> {
	let token: string;
	try {
		const auth = await getAccessTokenForProject(params.projectId);
		token = auth.token;
	} catch (err) {
		return {
			url: params.url,
			verdict: null,
			coverageState: null,
			httpStatus: 0,
			error: err instanceof Error ? err.message : String(err)
		};
	}

	const res = await fetch(INSPECT_ENDPOINT, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify({ inspectionUrl: params.url, siteUrl: params.siteUrl })
	});

	type InspectResponse = {
		inspectionResult?: {
			indexStatusResult?: {
				verdict?: string;
				coverageState?: string;
			};
		};
		error?: { message?: string };
	};
	const json = (await res.json().catch(() => ({}))) as InspectResponse;

	if (!res.ok) {
		return {
			url: params.url,
			verdict: null,
			coverageState: null,
			httpStatus: res.status,
			error: json.error?.message ?? `HTTP ${res.status}`
		};
	}

	const idx = json.inspectionResult?.indexStatusResult;
	return {
		url: params.url,
		verdict: idx?.verdict ?? null,
		coverageState: idx?.coverageState ?? null,
		httpStatus: res.status
	};
}

export async function batchInspect(params: {
	projectId: string;
	urls: string[];
	siteUrl: string;
	delayMs?: number;
}): Promise<{
	indexed: string[];
	notIndexed: string[];
	unknown: string[];
	errors: Array<{ url: string; httpStatus: number; error: string }>;
	stoppedOnQuota: boolean;
}> {
	const delay = params.delayMs ?? 100;
	const indexed: string[] = [];
	const notIndexed: string[] = [];
	const unknownList: string[] = [];
	const errors: Array<{ url: string; httpStatus: number; error: string }> = [];
	let stoppedOnQuota = false;

	for (const url of params.urls) {
		const r = await inspectUrl({ projectId: params.projectId, url, siteUrl: params.siteUrl });
		if (r.error || r.httpStatus !== 200) {
			errors.push({ url, httpStatus: r.httpStatus, error: r.error ?? 'unknown' });
			if (r.httpStatus === 429) {
				stoppedOnQuota = true;
				break;
			}
		} else {
			const cls = classifyIndexStatus(r.coverageState);
			if (cls === 'indexed') indexed.push(url);
			else if (cls === 'not_indexed') notIndexed.push(url);
			else unknownList.push(url);
		}
		if (delay > 0) await new Promise((res) => setTimeout(res, delay));
	}

	return { indexed, notIndexed, unknown: unknownList, errors, stoppedOnQuota };
}

export async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
	const res = await fetch(sitemapUrl, { headers: { 'User-Agent': 'jlabs-content-hub/indexing' } });
	if (!res.ok) throw new Error(`Sitemap fetch failed: HTTP ${res.status}`);
	const xml = await res.text();

	const urls = new Set<string>();
	const locMatches = xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi);
	const locs: string[] = [];
	for (const m of locMatches) locs.push(m[1].trim());

	const isSitemapIndex = /<sitemapindex\b/i.test(xml);
	if (isSitemapIndex) {
		for (const sub of locs) {
			try {
				const subUrls = await fetchSitemapUrls(sub);
				for (const u of subUrls) urls.add(u);
			} catch {
				// skip failed sub-sitemaps
			}
		}
	} else {
		for (const u of locs) urls.add(u);
	}
	return Array.from(urls);
}

export async function getCredentials(projectId: string) {
	return db.query.indexingCredentials.findFirst({ where: eq(indexingCredentials.projectId, projectId) });
}

export async function listSubmissions(projectId: string, limit = 50, offset = 0) {
	return db
		.select()
		.from(indexingSubmissions)
		.where(eq(indexingSubmissions.projectId, projectId))
		.orderBy(desc(indexingSubmissions.submittedAt))
		.limit(limit)
		.offset(offset);
}

export async function countSubmissions(projectId: string): Promise<number> {
	const row = await db
		.select({ count: sql<number>`count(*)` })
		.from(indexingSubmissions)
		.where(eq(indexingSubmissions.projectId, projectId))
		.then((r) => r[0]);
	return Number(row?.count ?? 0);
}
