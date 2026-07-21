/**
 * DATA-004 — Helpers PURS pour le modele d'observations (SPEC 7.5).
 *
 * Zero import (ni db, ni `$env`) -> testables en isolation par vitest.
 * Portent les invariants d'acceptation DATA-004 :
 *   - deux collectes identiques ne dupliquent pas (fingerprint deterministe = cle
 *     d'upsert, en miroir des uniques poses dans schema.ts) ;
 *   - les requetes 7/28/90 jours sont bornees par une date de fenetre calculee ;
 *   - le payload brut reste BORNE et sans secret (separe du normalise).
 */

// -- Vocabulaire (SPEC 7.5) ------------------------------------------

/** Les 10 domaines d'observation canoniques (= une table chacun). */
export const OBSERVATION_DOMAINS = [
	'gsc_query_page',
	'gsc_page',
	'index',
	'sitemap',
	'plausible_page',
	'keyword_rank',
	'backlink',
	'ai_visibility',
	'gmb_review',
	'gmb_insight'
] as const;
export type ObservationDomain = (typeof OBSERVATION_DOMAINS)[number];

/** Providers emetteurs d'observations (aligne project_integrations.provider). */
export const OBSERVATION_PROVIDERS = [
	'gsc',
	'indexing',
	'plausible',
	'dataforseo',
	'ai',
	'gmb'
] as const;
export type ObservationProvider = (typeof OBSERVATION_PROVIDERS)[number];

// -- Fingerprint d'upsert (dedup ; acceptation "pas de doublon") -----

/**
 * Separateur de fingerprint : ASCII Unit Separator (0x1F). Non imprimable, jamais
 * present dans une query/URL/keyword legitime -> pas de collision entre dimensions.
 */
export const FINGERPRINT_SEP = '\x1f';

/**
 * Cle deterministe d'une observation, en miroir de l'unique pose en DB. Deux
 * collectes des memes dimensions sur la meme periode produisent la MEME cle ->
 * upsert (jamais deux lignes). La normalisation (trim/minuscule des URLs/queries)
 * est laissee a l'appelant ; les parties sont jointes par `FINGERPRINT_SEP`.
 *
 * @throws si la liste est vide, si une partie est absente, ou si une partie
 *         contient le separateur reserve (casserait la dedup silencieusement).
 */
export function deriveObservationFingerprint(domain: ObservationDomain, parts: string[]): string {
	if (parts.length === 0) {
		throw new Error(`Fingerprint ${domain} : aucune dimension fournie.`);
	}
	const clean = parts.map((p, i) => {
		if (p === null || p === undefined) {
			throw new Error(`Fingerprint ${domain} : dimension #${i} nulle.`);
		}
		const s = String(p);
		if (s.includes(FINGERPRINT_SEP)) {
			throw new Error(`Fingerprint ${domain} : dimension #${i} contient le separateur reserve.`);
		}
		return s;
	});
	return [domain, ...clean].join(FINGERPRINT_SEP);
}

// -- Fenetres 7 / 28 / 90 jours (requetes bornees) -------------------

/** Fenetres standard du cockpit (SPEC : requetes 7/28/90 jours). */
export const WINDOW_DAYS = [7, 28, 90] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];

/**
 * Date de debut (incluse) d'une fenetre glissante de `days` jours finissant a
 * `now`. DETERMINISTE : `now` est passe (jamais `Date.now()` interne) pour rester
 * pur/testable. Retourne une date `YYYY-MM-DD` (comparable lexicalement aux
 * colonnes `observed_date`/`period_start` des observations).
 */
export function computeWindowStart(input: { now: string | Date; days: number }): string {
	const end = typeof input.now === 'string' ? new Date(input.now) : input.now;
	if (Number.isNaN(end.getTime())) {
		throw new Error(`computeWindowStart : date "${String(input.now)}" invalide.`);
	}
	const days = Math.max(0, Math.floor(input.days));
	const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
	return start.toISOString().slice(0, 10);
}

/** Vrai si `observedDate` (YYYY-MM-DD...) tombe dans [windowStart, +inf). */
export function isWithinWindow(observedDate: string, windowStart: string): boolean {
	return observedDate.slice(0, 10) >= windowStart;
}

// -- Payload brut borne (SPEC : "payload brut borne", separe du normalise) --

/** Plafond par defaut d'un payload d'observation (32 Ko serialises). */
export const MAX_OBSERVATION_PAYLOAD_BYTES = 32 * 1024;

/**
 * Leve une erreur si le payload brut depasse le plafond. Garde le stock
 * d'observations borne (le brut illimite doit aller ailleurs, pas dans la serie
 * temporelle). `null`/vide = OK. Mesure la taille en octets UTF-8.
 */
export function assertBoundedPayload(
	raw: string | null | undefined,
	context: string,
	maxBytes: number = MAX_OBSERVATION_PAYLOAD_BYTES
): void {
	if (raw === null || raw === undefined || raw === '') return;
	const bytes = new TextEncoder().encode(raw).length;
	if (bytes > maxBytes) {
		throw new Error(`Payload ${context} trop gros (${bytes} > ${maxBytes} octets).`);
	}
}
