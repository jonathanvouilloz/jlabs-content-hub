/**
 * IDX-008 — Éligibilité à la Google Indexing API.
 *
 * Helpers PURS (aucun import : ni db, ni crypto, ni `$env`) — testables en
 * isolation par vitest sans faire tomber le runtime SvelteKit.
 *
 * Doctrine (SPEC §9.4). La Google Indexing API n'est officiellement valable que
 * pour deux types de pages :
 *   - `JobPosting` ;
 *   - `BroadcastEvent` intégré dans un `VideoObject`.
 * La soumission générique d'articles et de pages locales est retirée : pour ces
 * pages, la voie normale est **sitemap + maillage interne + canonical + qualité
 * + inspection** (et, au besoin, une demande manuelle dans Search Console).
 *
 * Deux gardes se combinent en amont de tout appel réseau (cf. `indexing.ts`) :
 *   1. le flag `indexnow` (interrupteur maître, OFF par défaut pendant la migration) ;
 *   2. la validation de type ci-dessous (seuls les types éligibles passent).
 */

export type IndexingEligibility = 'JobPosting' | 'BroadcastEvent';

/** Les seuls types de pages qu'on autorise à atteindre l'Indexing API. */
export const ELIGIBLE_INDEXING_TYPES = ['JobPosting', 'BroadcastEvent'] as const;

const ELIGIBLE_SET = new Set<string>(ELIGIBLE_INDEXING_TYPES);

/** True si `x` est un type de page officiellement éligible à l'Indexing API. */
export function isEligibleForIndexingApi(x: string | null | undefined): x is IndexingEligibility {
	return typeof x === 'string' && ELIGIBLE_SET.has(x);
}

export type IndexingGuardVerdict =
	| { allowed: true }
	| { allowed: false; reason: 'flag_off' | 'ineligible_type'; message: string };

const FLAG_OFF_MESSAGE =
	'Soumission refusée : le flag « indexnow » est désactivé (interrupteur maître OFF pendant la migration).';
const INELIGIBLE_MESSAGE =
	'Soumission refusée : type de page non éligible à la Google Indexing API (réservée à JobPosting / BroadcastEvent). ' +
	'Pour une page ordinaire, la voie normale est sitemap + maillage interne + canonical + inspection.';

/**
 * Décide si une soumission peut atteindre l'Indexing API. Ordre : le flag maître
 * d'abord (rien ne part si OFF), puis la validation de type. Refus = audité +
 * zéro appel réseau côté appelant.
 */
export function evaluateIndexingGuard(input: {
	flagEnabled: boolean;
	eligibility?: string | null;
}): IndexingGuardVerdict {
	if (!input.flagEnabled) {
		return { allowed: false, reason: 'flag_off', message: FLAG_OFF_MESSAGE };
	}
	if (!isEligibleForIndexingApi(input.eligibility)) {
		return { allowed: false, reason: 'ineligible_type', message: INELIGIBLE_MESSAGE };
	}
	return { allowed: true };
}
