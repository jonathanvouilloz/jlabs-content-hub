/**
 * GSC-001 — Adaptateur d'authentification GSC multi-projet (BACKLOG GSC-001,
 * SPEC §9.1, §7.1).
 *
 * Ce que ce module apporte, et que `indexing.ts` ne pouvait pas donner :
 *
 *   1. **il est chargeable hors runtime SvelteKit** — client drizzle, clé de
 *      chiffrement et `fetch` sont INJECTÉS. `indexing.ts` importe `db` et
 *      `crypto.ts` (donc `$env`) statiquement : aucun collecteur bâti dessus
 *      n'aurait pu être prouvé sur Neon. Même correction qu'en AGT-000 ;
 *   2. **il jette des erreurs STRUCTURÉES** (`GscApiError` porte `status`,
 *      `reason`, `retryAfter`). `gsc-analytics.ts` jette aujourd'hui
 *      `new Error("GSC API 429 pour siteUrl=…")` — une chaîne. `classifyJobFailure`
 *      (job-retry.ts) cherche `status`/`statusCode`/`code` sur l'objet, n'en trouve
 *      aucun, et ne retombe sur la bonne classe QUE si les 200 premiers caractères
 *      du corps Google contiennent `rateLimitExceeded`. Autrement dit la file
 *      classait un quota au petit bonheur — et un quota mal classé part en
 *      dead-letter permanent (JOB-003) ;
 *   3. **il distingue les trois échecs d'accès** — jeton mort (`auth`), service
 *      account non autorisé sur la propriété (`permission`), propriété absente de
 *      Search Console (`property_absent`) — l'acceptation GSC-001 ;
 *   4. **il tient à jour `project_integrations`** (fraîcheur, santé, `secret_ref`),
 *      table créée par DATA-002 et jusqu'ici JAMAIS écrite.
 *
 * **Le magasin de secrets ne bouge pas.** Les service accounts restent chiffrés
 * dans `indexing_credentials` ; `project_integrations.secret_ref` ne porte qu'un
 * POINTEUR (`indexing_credentials:{id}`), conformément à l'invariant DATA-002
 * « aucun secret ici ». Déplacer les secrets serait une migration à part entière,
 * et elle n'apporterait rien à la collecte.
 */
import { eq } from 'drizzle-orm';
import { createSign } from 'node:crypto';
import { indexingCredentials, projects } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { decryptWith } from './crypto-core.js';
import { recordIntegrationError, recordIntegrationSuccess, upsertIntegration } from './integrations.js';

// ── Constantes Google ───────────────────────────────────────────────

const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';
export const WEBMASTERS_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

/**
 * Scope combiné, identique à celui d'`indexing.ts` — À DESSEIN. Les deux chemins
 * partagent le même cache de jeton : demander un scope plus étroit ici forcerait un
 * second échange JWT pour le même service account, donc deux jetons à renouveler là
 * où un seul suffit.
 */
const COMBINED_SCOPE = `${INDEXING_SCOPE} ${WEBMASTERS_SCOPE}`;

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const WEBMASTERS_SITES = 'https://www.googleapis.com/webmasters/v3/sites';
const SEARCH_ANALYTICS_BASE = 'https://www.googleapis.com/webmasters/v3/sites';

/**
 * IDX-002 — URL Inspection (API v1, endpoint distinct de `webmasters/v3`).
 *
 * Le scope requis (`webmasters.readonly`) est déjà dans `COMBINED_SCOPE` : aucun nouveau
 * consentement, aucune nouvelle clé. Quotas propres (2 000/jour et 600/minute par propriété)
 * mais **même service account** que Search Analytics — donc même cohorte de refroidissement
 * JOB-006, ce qui est exactement ce qu'on veut sur un compte partagé par 6 projets.
 */
const URL_INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

export const GSC_PROVIDER = 'gsc';

// ── Types ───────────────────────────────────────────────────────────

export interface ServiceAccountJson {
	client_email: string;
	private_key: string;
	token_uri?: string;
}

/** Dépendances injectables — l'app passe les siennes, une preuve passe des doubles. */
export interface GscAuthDeps {
	client?: AppDb;
	/** Clé de chiffrement ; à défaut `process.env.ENCRYPTION_KEY` (runners `scripts/`). */
	encryptionKey?: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export interface GscBinding {
	credentialId: string;
	projectId: string;
	siteUrl: string;
	serviceAccountEmail: string;
	serviceAccount: ServiceAccountJson;
}

/**
 * Erreur d'appel GSC, PORTEUSE de son statut.
 *
 * `status`, `code` et `reason` sont exposés en propriétés parce que
 * `classifyJobFailure` les lit exactement sous ces noms : c'est ce qui rend la
 * classification déterministe au lieu de dépendre du texte du corps de réponse.
 * `retryAfter` est laissé tel que Google l'a envoyé — `parseRetryAfter` sait lire
 * les deux formes du protocole (secondes ou date HTTP).
 */
export class GscApiError extends Error {
	readonly status: number;
	readonly reason: string | null;
	readonly retryAfter: string | null;
	readonly siteUrl: string | null;

	constructor(input: {
		status: number;
		message: string;
		reason?: string | null;
		retryAfter?: string | null;
		siteUrl?: string | null;
	}) {
		super(input.message);
		this.name = 'GscApiError';
		this.status = input.status;
		this.reason = input.reason ?? null;
		this.retryAfter = input.retryAfter ?? null;
		this.siteUrl = input.siteUrl ?? null;
	}
}

// ── Résolution des dépendances ──────────────────────────────────────

/**
 * Client d'écriture : celui de l'app par défaut, ou un client INJECTÉ. L'import de
 * `db/index.js` est DYNAMIQUE et n'a lieu que si aucun client n'est fourni — ce
 * module reste donc chargeable là où `$env/dynamic/private` n'existe pas.
 */
async function resolveDb(client?: AppDb): Promise<AppDb> {
	if (client) return client;
	const mod = await import('./db/index.js');
	return mod.db as unknown as AppDb;
}

function resolveKey(deps: GscAuthDeps): string {
	const key = deps.encryptionKey ?? process.env.ENCRYPTION_KEY;
	if (!key) throw new Error('ENCRYPTION_KEY absente : impossible de lire le service account.');
	return key;
}

function resolveFetch(deps: GscAuthDeps): typeof fetch {
	return deps.fetchImpl ?? fetch;
}

// ── Jeton d'accès ───────────────────────────────────────────────────

interface CachedToken {
	token: string;
	expiresAt: number;
}

/**
 * Cache de jetons clé par **service account**, pas par projet.
 *
 * Mesuré : les 6 projets partagent `indexing-api@jonlabs.iam.gserviceaccount.com`.
 * Une clé par projet ferait donc 6 échanges JWT pour 6 jetons identiques, à chaque
 * tick — et 6 fois le risque de se faire refouler sur le point d'échange. Le scope
 * étant constant (`COMBINED_SCOPE`), un jeton par compte est exactement ce que le
 * protocole permet de réutiliser.
 */
const tokenCache = new Map<string, CachedToken>();

/** Vidange du cache — réservé aux tests et aux preuves. */
export function resetTokenCache(): void {
	tokenCache.clear();
}

function base64url(input: Buffer | string): string {
	const buf = typeof input === 'string' ? Buffer.from(input) : input;
	return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(sa: ServiceAccountJson, nowMs: number): string {
	const now = Math.floor(nowMs / 1000);
	const header = { alg: 'RS256', typ: 'JWT' };
	const claim = {
		iss: sa.client_email,
		scope: COMBINED_SCOPE,
		aud: sa.token_uri || DEFAULT_TOKEN_URI,
		exp: now + 3600,
		iat: now
	};
	const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
	const signer = createSign('RSA-SHA256');
	signer.update(unsigned);
	return `${unsigned}.${base64url(signer.sign(sa.private_key))}`;
}

/**
 * Échange le JWT contre un jeton d'accès.
 *
 * Un échec ici sort en `GscApiError` avec le `reason` du corps OAuth
 * (`invalid_grant`, `invalid_client`…) : ce sont les marqueurs que
 * `classifyJobFailure` reconnaît comme `auth`. Google renvoie `invalid_grant` en
 * **400** — le classer sur le statut nu en ferait un `permanent`, donc une
 * dead-letter silencieuse là où il faut renouveler une clé.
 */
async function exchangeJwtForToken(
	sa: ServiceAccountJson,
	deps: GscAuthDeps
): Promise<{ token: string; expiresInSec: number }> {
	const nowMs = deps.now?.() ?? Date.now();
	const jwt = signJwt(sa, nowMs);
	const tokenUri = sa.token_uri || DEFAULT_TOKEN_URI;
	const res = await resolveFetch(deps)(tokenUri, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion: jwt
		}).toString()
	});
	const json = (await res.json().catch(() => ({}))) as {
		access_token?: string;
		expires_in?: number;
		error?: string;
		error_description?: string;
	};
	if (!res.ok || !json.access_token) {
		throw new GscApiError({
			status: res.status || 400,
			reason: json.error ?? null,
			message: `Échange de jeton refusé : ${json.error ?? res.status} ${json.error_description ?? ''}`.trim(),
			retryAfter: res.headers?.get?.('retry-after') ?? null
		});
	}
	return { token: json.access_token, expiresInSec: json.expires_in || 3600 };
}

/** Jeton d'accès pour un service account, mis en cache jusqu'à 60 s de sa fin. */
export async function getAccessToken(
	sa: ServiceAccountJson,
	deps: GscAuthDeps = {}
): Promise<string> {
	const nowMs = deps.now?.() ?? Date.now();
	const cached = tokenCache.get(sa.client_email);
	if (cached && cached.expiresAt > nowMs + 60_000) return cached.token;

	const { token, expiresInSec } = await exchangeJwtForToken(sa, deps);
	tokenCache.set(sa.client_email, { token, expiresAt: nowMs + expiresInSec * 1000 });
	return token;
}

// ── Liaison projet ↔ propriété GSC ──────────────────────────────────

/**
 * Charge la liaison GSC d'un projet depuis `indexing_credentials`.
 *
 * L'absence de credentials et l'absence de `site_url` sont DEUX erreurs
 * distinctes : la première dit « ce projet n'est pas branché », la seconde « il est
 * branché mais on ne sait pas sur quelle propriété ». Les confondre enverrait
 * chercher une clé là où il manque une URL.
 */
export async function loadGscBinding(projectId: string, deps: GscAuthDeps = {}): Promise<GscBinding> {
	const db = await resolveDb(deps.client);
	const rows = await db
		.select()
		.from(indexingCredentials)
		.where(eq(indexingCredentials.projectId, projectId))
		.limit(1);
	const row = rows[0];
	if (!row) throw new Error(`Aucune credential GSC configurée pour le projet ${projectId}.`);
	if (!row.siteUrl) {
		throw new Error(`Credential GSC sans site_url pour le projet ${projectId} : propriété inconnue.`);
	}

	let serviceAccount: ServiceAccountJson;
	try {
		serviceAccount = JSON.parse(decryptWith(resolveKey(deps), row.serviceAccountJson));
	} catch {
		// Le message ne répète JAMAIS ce qu'on a tenté de déchiffrer.
		throw new Error(`Service account illisible pour le projet ${projectId}.`);
	}

	return {
		credentialId: row.id,
		projectId,
		siteUrl: row.siteUrl,
		serviceAccountEmail: row.serviceAccountEmail,
		serviceAccount
	};
}

/** Projets actifs disposant d'une propriété GSC exploitable. */
export async function listGscProjects(
	deps: GscAuthDeps = {}
): Promise<Array<{ id: string; slug: string; siteUrl: string }>> {
	const db = await resolveDb(deps.client);
	const rows = await db
		.select({ id: projects.id, slug: projects.slug, siteUrl: indexingCredentials.siteUrl })
		.from(projects)
		.innerJoin(indexingCredentials, eq(indexingCredentials.projectId, projects.id))
		.where(eq(projects.archived, false));
	return rows
		.filter((r): r is { id: string; slug: string; siteUrl: string } => !!r.siteUrl)
		.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ── Appels GSC ──────────────────────────────────────────────────────

/**
 * `sc-domain:exemple.ch` doit garder son `:` dans le segment de chemin — c'est
 * le format que l'API exige, et `encodeURIComponent` l'encode en `%3A`.
 * Les 6 propriétés du parc sont toutes des `sc-domain:`.
 */
export function encodeSiteUrlPath(siteUrl: string): string {
	return encodeURIComponent(siteUrl).replace(/%3A/g, ':');
}

interface GoogleErrorBody {
	error?: {
		code?: number;
		message?: string;
		status?: string;
		errors?: Array<{ reason?: string; message?: string }>;
	};
}

/**
 * Transforme une réponse HTTP en échec en `GscApiError` renseignée.
 *
 * Le `reason` est pris dans le corps Google (`errors[0].reason`, puis
 * `error.status`) : c'est LUI qui porte la vérité, pas le statut. Un dépassement
 * de quota arrive en **403** `rateLimitExceeded` — classé sur le statut nu il
 * deviendrait `permanent`, donc une dead-letter immédiate au lieu d'un report.
 */
async function toGscApiError(res: Response, siteUrl: string | null): Promise<GscApiError> {
	const text = await res.text().catch(() => '');
	let body: GoogleErrorBody = {};
	try {
		body = JSON.parse(text) as GoogleErrorBody;
	} catch {
		// corps non JSON : on garde le texte brut comme message
	}
	const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? null;
	const detail = body.error?.message ?? text.slice(0, 200);
	return new GscApiError({
		status: res.status,
		reason,
		retryAfter: res.headers?.get?.('retry-after') ?? null,
		siteUrl,
		message: `GSC ${res.status}${reason ? ` (${reason})` : ''}${siteUrl ? ` sur ${siteUrl}` : ''} : ${detail}`
	});
}

export interface GscRow {
	keys?: string[];
	clicks?: number;
	impressions?: number;
	ctr?: number;
	position?: number;
}

export interface SearchAnalyticsPage {
	rows: GscRow[];
}

/** Une page de `searchAnalytics/query`. La pagination est l'affaire de l'appelant. */
export async function searchAnalyticsPage(
	input: {
		binding: GscBinding;
		startDate: string;
		endDate: string;
		dimensions: string[];
		rowLimit: number;
		startRow: number;
	},
	deps: GscAuthDeps = {}
): Promise<SearchAnalyticsPage> {
	const token = await getAccessToken(input.binding.serviceAccount, deps);
	const url = `${SEARCH_ANALYTICS_BASE}/${encodeSiteUrlPath(input.binding.siteUrl)}/searchAnalytics/query`;
	const res = await resolveFetch(deps)(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
		body: JSON.stringify({
			startDate: input.startDate,
			endDate: input.endDate,
			dimensions: input.dimensions,
			rowLimit: input.rowLimit,
			startRow: input.startRow,
			// `final` = données consolidées seulement. `all` inclurait du frais
			// incomplet, qui se lirait comme une baisse la semaine suivante.
			dataState: 'final'
		})
	});
	if (!res.ok) throw await toGscApiError(res, input.binding.siteUrl);
	const json = (await res.json()) as { rows?: GscRow[] };
	return { rows: json.rows ?? [] };
}

/**
 * IDX-002 — Inspection d'UNE url via la propriété correcte (`binding.siteUrl`).
 *
 * Rend la réponse Google **BRUTE** : la normalisation en colonnes vit dans le module pur
 * `collectors/url-inspection-state.ts`, testable sans réseau. Ici, une seule
 * responsabilité — parler à Google et **jeter une erreur STRUCTURÉE**.
 *
 * C'est tout l'écart avec `indexing.ts:inspectUrl`, qui `catch` et rend
 * `{ verdict: null, coverageState: null, httpStatus: 0, error: '…' }` : une **chaîne**, donc
 * `classifyJobFailure` n'y trouve ni `status` ni `reason` et classe un quota au petit bonheur
 * — or un quota mal classé part en **dead-letter permanente**. En passant par `toGscApiError`,
 * les deux cas que Google fait à l'envers sont justes gratuitement : **403 `rateLimitExceeded`
 * → `quota`** (et non `permanent`), **400 `invalid_grant` → `auth`**.
 *
 * Et surtout : une erreur provider **n'est jamais un résultat**. Elle sort par `throw`, pas
 * par une valeur de retour qu'un appelant pourrait confondre avec « page non indexée » —
 * l'acceptation IDX-002 « distinguer erreur provider et résultat non indexé » commence ici.
 */
export async function urlInspection(
	input: { binding: GscBinding; inspectionUrl: string; languageCode?: string },
	deps: GscAuthDeps = {}
): Promise<Record<string, unknown>> {
	const token = await getAccessToken(input.binding.serviceAccount, deps);
	const res = await resolveFetch(deps)(URL_INSPECTION_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
		body: JSON.stringify({
			inspectionUrl: input.inspectionUrl,
			siteUrl: input.binding.siteUrl,
			...(input.languageCode ? { languageCode: input.languageCode } : {})
		})
	});
	if (!res.ok) throw await toGscApiError(res, input.binding.siteUrl);
	return (await res.json()) as Record<string, unknown>;
}

/** Propriétés visibles par le service account (diagnostic d'accès). */
export async function listAccessibleSites(
	binding: GscBinding,
	deps: GscAuthDeps = {}
): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
	const token = await getAccessToken(binding.serviceAccount, deps);
	const res = await resolveFetch(deps)(WEBMASTERS_SITES, {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) throw await toGscApiError(res, null);
	const json = (await res.json()) as {
		siteEntry?: Array<{ siteUrl: string; permissionLevel: string }>;
	};
	return json.siteEntry ?? [];
}

// ── Test d'accès (acceptation GSC-001) ──────────────────────────────

export type GscAccessReason = 'ok' | 'auth' | 'permission' | 'property_absent' | 'unreachable';

export interface GscAccessResult {
	ok: boolean;
	reason: GscAccessReason;
	siteUrl: string;
	/** Renseigné dès qu'on a pu lister — c'est ce qui rend le diagnostic actionnable. */
	accessibleSites: string[];
	message: string;
}

/**
 * Teste l'accès d'un projet à SA propriété, et NOMME l'échec.
 *
 * L'ordre du diagnostic n'est pas cosmétique : on liste d'abord les propriétés
 * visibles. Si la liste échoue, le problème est le JETON (auth). Si elle réussit
 * mais ne contient pas la propriété visée, le service account n'y a pas été
 * ajouté — ou la propriété n'existe pas dans Search Console. Les deux se
 * ressemblent à l'écran et appellent des gestes opposés : ajouter un utilisateur,
 * ou créer/corriger la propriété. Un sondage réel tranche.
 *
 * Isolation : un projet testé n'en touche aucun autre (acceptation GSC-001).
 */
export async function testGscAccess(
	projectId: string,
	deps: GscAuthDeps = {}
): Promise<GscAccessResult> {
	let binding: GscBinding;
	try {
		binding = await loadGscBinding(projectId, deps);
	} catch (err) {
		return {
			ok: false,
			reason: 'auth',
			siteUrl: '',
			accessibleSites: [],
			message: err instanceof Error ? err.message : String(err)
		};
	}

	let sites: Array<{ siteUrl: string; permissionLevel: string }>;
	try {
		sites = await listAccessibleSites(binding, deps);
	} catch (err) {
		const status = err instanceof GscApiError ? err.status : 0;
		return {
			ok: false,
			reason: status === 401 || status === 400 ? 'auth' : 'unreachable',
			siteUrl: binding.siteUrl,
			accessibleSites: [],
			message: err instanceof Error ? err.message : String(err)
		};
	}

	const names = sites.map((s) => s.siteUrl);
	if (!names.includes(binding.siteUrl)) {
		return {
			ok: false,
			reason: 'property_absent',
			siteUrl: binding.siteUrl,
			accessibleSites: names,
			message:
				`La propriété "${binding.siteUrl}" n'est pas visible par ${binding.serviceAccountEmail}. ` +
				(names.length
					? `Propriétés accessibles : ${names.join(', ')}.`
					: 'Aucune propriété accessible — ajoute le service account en utilisateur dans Search Console.')
		};
	}

	// Sondage minimal : une propriété listée peut rester refusée en lecture.
	try {
		await searchAnalyticsPage(
			{
				binding,
				startDate: '2020-01-01',
				endDate: '2020-01-01',
				dimensions: ['date'],
				rowLimit: 1,
				startRow: 0
			},
			deps
		);
	} catch (err) {
		const status = err instanceof GscApiError ? err.status : 0;
		return {
			ok: false,
			reason: status === 403 ? 'permission' : status === 401 ? 'auth' : 'unreachable',
			siteUrl: binding.siteUrl,
			accessibleSites: names,
			message: err instanceof Error ? err.message : String(err)
		};
	}

	return {
		ok: true,
		reason: 'ok',
		siteUrl: binding.siteUrl,
		accessibleSites: names,
		message: `Accès confirmé sur ${binding.siteUrl}.`
	};
}

// ── Fraîcheur de l'intégration (project_integrations) ───────────────

/**
 * Reflète l'état de la liaison GSC dans `project_integrations`.
 *
 * `secret_ref` ne porte qu'un POINTEUR vers `indexing_credentials` — jamais le
 * secret (invariant DATA-002, vérifié par `assertNoInlineSecret` sur
 * `configuration_json`).
 *
 * La propriétaire du retour à `healthy` est désormais évidente : c'est la
 * COLLECTE qui réussit. C'était la raison pour laquelle JOB-006 avait laissé cet
 * état à OPS-002 (« un second état dont personne ne serait clairement
 * propriétaire ») ; le collecteur lève l'objection en devenant ce propriétaire.
 */
export async function syncGscIntegration(
	input: {
		binding: GscBinding;
		outcome: 'success' | 'error';
		errorCode?: string;
	},
	deps: GscAuthDeps = {}
): Promise<{ id: string }> {
	const { id } = await upsertIntegration(
		{
			projectId: input.binding.projectId,
			provider: GSC_PROVIDER,
			resourceKey: input.binding.siteUrl,
			enabled: true,
			status: input.outcome === 'success' ? 'active' : 'error',
			scopes: WEBMASTERS_SCOPE,
			configurationJson: JSON.stringify({
				siteUrl: input.binding.siteUrl,
				serviceAccountEmail: input.binding.serviceAccountEmail
			}),
			secretRef: `indexing_credentials:${input.binding.credentialId}`
		},
		deps.client
	);

	if (input.outcome === 'success') {
		await recordIntegrationSuccess(id, deps.client);
	} else {
		await recordIntegrationError(id, input.errorCode ?? 'UnknownError', deps.client);
	}
	return { id };
}
