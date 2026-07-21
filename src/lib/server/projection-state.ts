/**
 * DATA-002 — Helpers PURS pour projections & intégrations.
 *
 * Zéro import (ni db, ni `$env`) → testables en isolation par vitest.
 * Portent les invariants d'acceptation DATA-002 :
 *   - une projection inchangée (même `source_hash`) n'est pas une nouvelle version ;
 *   - un `configuration_json`/`payload` ne doit JAMAIS contenir de secret en clair ;
 *   - la santé d'une intégration se dérive de sa fraîcheur (succès/erreur).
 */

// ── Projections ─────────────────────────────────────────────────────

export const PROJECTION_STATUSES = ['current', 'stale', 'invalid'] as const;
export type ProjectionStatus = (typeof PROJECTION_STATUSES)[number];

export type ProjectionClassification = 'duplicate' | 'new_version';

/**
 * Compare le hash entrant au hash de la projection courante. Hash identique =
 * `duplicate` (no-op, pas de nouvelle ligne) ; sinon `new_version` (à insérer,
 * l'ancienne courante passera `stale`).
 */
export function classifyProjection(input: {
	incomingHash: string;
	currentHash?: string | null;
}): ProjectionClassification {
	if (input.currentHash && input.currentHash === input.incomingHash) return 'duplicate';
	return 'new_version';
}

// ── Garde anti-secret ───────────────────────────────────────────────

/**
 * Clés dont la présence dans un blob « non secret » (projection payload ou
 * configuration_json d'intégration) trahit une fuite de secret. Comparaison sur
 * le nom de clé normalisé (insensible à la casse, `-`/espaces → `_`).
 */
const SECRET_KEY_MARKERS = [
	'private_key',
	'password',
	'passwd',
	'secret',
	'client_secret',
	'access_token',
	'refresh_token',
	'id_token',
	'api_key',
	'apikey',
	'authorization',
	'service_account_json'
] as const;

function normalizeKey(k: string): string {
	// Découpe les frontières camelCase (clientSecret → client_secret) avant de
	// normaliser séparateurs et casse, pour attraper aussi les clés sans underscore.
	return k
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.toLowerCase()
		.replace(/[\s-]+/g, '_');
}

/** Collecte récursivement les noms de clés d'un objet JSON déjà parsé. */
function collectKeys(value: unknown, out: Set<string>): void {
	if (Array.isArray(value)) {
		for (const v of value) collectKeys(v, out);
	} else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) {
			out.add(normalizeKey(k));
			collectKeys(v, out);
		}
	}
}

/**
 * Lève une erreur si `raw` (JSON sérialisé, ou `null`/vide = OK) contient une clé
 * qui ressemble à un secret. Best-effort : protège contre l'erreur humaine, pas
 * contre un adversaire. À appeler avant de persister une projection ou une config.
 */
export function assertNoInlineSecret(raw: string | null | undefined, context: string): void {
	if (raw === null || raw === undefined || raw.trim() === '') return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Pas du JSON structuré : on scanne le texte brut pour les marqueurs évidents.
		const hay = normalizeKey(raw);
		const hit = SECRET_KEY_MARKERS.find((m) => hay.includes(m));
		if (hit) throw new Error(`Secret potentiel « ${hit} » interdit dans ${context}.`);
		return;
	}
	const keys = new Set<string>();
	collectKeys(parsed, keys);
	const hit = SECRET_KEY_MARKERS.find((m) => keys.has(m));
	if (hit) throw new Error(`Secret potentiel « ${hit} » interdit dans ${context}.`);
}

// ── Santé des intégrations ──────────────────────────────────────────

export const HEALTH_STATUSES = ['healthy', 'degraded', 'down', 'unknown'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/**
 * Dérive la santé d'une intégration de sa fraîcheur. Règles :
 *   - jamais de succès ni d'erreur → `unknown` ;
 *   - dernier événement = succès (ou plus récent que la dernière erreur) → `healthy` ;
 *   - une erreur mais un succès antérieur existe → `degraded` (dégradé, pas mort) ;
 *   - une erreur et aucun succès → `down`.
 * Timestamps comparés comme chaînes ISO/`YYYY-MM-DD HH:MM:SS` (ordre lexical = chrono).
 */
export function computeHealth(input: {
	lastSuccessAt?: string | null;
	lastErrorAt?: string | null;
}): HealthStatus {
	const ok = input.lastSuccessAt ?? null;
	const err = input.lastErrorAt ?? null;
	if (!ok && !err) return 'unknown';
	if (ok && !err) return 'healthy';
	if (!ok && err) return 'down';
	// Les deux existent : le plus récent gagne.
	return (ok as string) >= (err as string) ? 'healthy' : 'degraded';
}
