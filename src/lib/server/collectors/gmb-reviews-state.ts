/**
 * GMB-002 — Le jugement de la collecte d'avis, en module PUR.
 *
 * Zéro `db`, zéro `$env`, zéro réseau. Ce n'est pas une préférence de style : `gmb.ts`
 * importe `$env/dynamic/private` dès sa première ligne, donc tout module qui l'importe est
 * inchargeable hors runtime SvelteKit — y compris par vitest et par les scripts de preuve.
 * Mettre `GmbApiError` dans `gmb.ts` reviendrait à écrire une classe d'erreur qu'aucun test
 * ne peut construire et qu'aucune preuve ne peut vérifier.
 *
 * Ce que ce module décide, et que personne ne décidait avant :
 *   1. Ce qu'est une ERREUR Google (et non « une chaîne qui contient un statut »).
 *   2. Ce qu'est l'IDENTITÉ d'un avis (et non « le champ que Google a renvoyé »).
 *   3. Ce qui a CHANGÉ entre ce que Google dit et ce que la base garde.
 */
import { toDbTimestamp } from '../timestamps.js';

// ── 1. L'erreur ────────────────────────────────────────────────────────────────────────

/**
 * Erreur d'appel à l'API Google Business Profile, calquée sur `GscApiError`.
 *
 * `status` et `reason` sont exposés en propriétés parce que `classifyJobFailure`
 * (`job-retry.ts`) les lit EXACTEMENT sous ces noms. C'est ce qui rend la classification
 * délibérée au lieu d'accidentelle : aujourd'hui `fetchLocationReviews` lève un
 * `new Error("Fetch reviews failed: 429 {corps}")`, et `collectMarkers` retrouve
 * `rateLimitExceeded` **dans le texte du message** — ça marche, par chance, et ça cesserait
 * de marcher le jour où quelqu'un reformule le message.
 *
 * `locationId` remplace le `siteUrl` de `GscApiError` : c'est l'unité de panne côté GMB.
 * Sans lui, un 404 « cette fiche n'existe plus » ne dirait pas DE QUELLE fiche il parle,
 * alors que `barberconcept` en a six.
 */
export class GmbApiError extends Error {
	readonly status: number;
	readonly reason: string | null;
	readonly retryAfter: string | null;
	readonly locationId: string | null;

	constructor(input: {
		status: number;
		message: string;
		reason?: string | null;
		retryAfter?: string | null;
		locationId?: string | null;
	}) {
		super(input.message);
		this.name = 'GmbApiError';
		this.status = input.status;
		this.reason = input.reason ?? null;
		this.retryAfter = input.retryAfter ?? null;
		this.locationId = input.locationId ?? null;
	}
}

/** Forme d'un corps d'erreur Google (les deux variantes que GBP renvoie). */
interface GoogleErrorBody {
	error?: {
		status?: string;
		message?: string;
		errors?: Array<{ reason?: string; message?: string }>;
	};
}

/**
 * Corps de réponse Google → `GmbApiError`.
 *
 * ⚠️ La priorité `errors[0].reason` AVANT `error.status` n'est pas cosmétique : c'est la
 * même leçon que GSC-002. Google range un dépassement de quota en **403** avec
 * `reason: 'rateLimitExceeded'` — classé sur le statut nu, il deviendrait `permanent`, donc
 * une dead-letter immédiate au lieu d'un report. Le corps porte la vérité, pas l'en-tête.
 *
 * Un corps illisible n'invente rien : `reason` reste `null` et la classification retombe sur
 * le statut HTTP, qui est au moins un fait.
 */
export function parseGmbError(input: {
	status: number;
	body: string;
	retryAfter?: string | null;
	locationId?: string | null;
}): GmbApiError {
	let body: GoogleErrorBody = {};
	try {
		body = JSON.parse(input.body) as GoogleErrorBody;
	} catch {
		// corps non JSON : on garde le texte brut comme détail
	}
	const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? null;
	const detail = body.error?.message ?? input.body.slice(0, 200);
	const where = input.locationId ? ` sur ${input.locationId}` : '';
	return new GmbApiError({
		status: input.status,
		reason,
		retryAfter: input.retryAfter ?? null,
		locationId: input.locationId ?? null,
		message: `GMB ${input.status}${reason ? ` (${reason})` : ''}${where} : ${detail}`
	});
}

// ── 2. L'identité et la normalisation ──────────────────────────────────────────────────

export const REVIEW_PAGE_SIZE = 50;

/**
 * Borne dure de pagination par établissement. La boucle actuelle est un `do…while(pageToken)`
 * SANS borne : un `nextPageToken` constant (bug côté Google, proxy qui rejoue) ferait tourner
 * un job sous bail jusqu'à ce que le worker le tue. 200 pages × 50 = 10 000 avis, soit deux
 * ordres de grandeur au-dessus du plus gros parc (`barberconcept`, 379). Doctrine IDX-001 :
 * une borne dure, et une troncature qui se DIT.
 */
export const MAX_REVIEW_PAGES = 200;

/**
 * L'identité stable d'un avis : le DERNIER SEGMENT du path, jamais le path complet.
 *
 * Google renvoie `accounts/{acct}/locations/{loc}/reviews/{id}` dans `name`, et c'est ce que
 * la base stocke aujourd'hui (`gmb.ts:367`). Le jour d'un transfert de propriété GBP ou d'une
 * migration de compte, `{acct}` change : tous les `review_id` deviendraient différents, donc
 * tous les fingerprints de findings aussi, et chaque avis produirait un DOUBLON — un
 * « nouvel avis sans réponse » pour un avis vieux de six mois.
 *
 * Le segment nu est ce que Google garantit stable. Le path complet reste dans les preuves.
 */
export function normalizeReviewKey(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return '';
	const segments = trimmed.split('/').filter(Boolean);
	return segments[segments.length - 1] ?? '';
}

/**
 * `starRating` Google → note. Déplacé tel quel de `gmb.ts:386`.
 *
 * ⚠️ `0` veut dire « note ILLISIBLE », pas « zéro étoile » : GBP n'émet jamais 0. Les deux
 * détecteurs du lot 2 doivent exclure `rating === 0` de leurs closures — « ne pas savoir »
 * n'est pas « négatif », et un avis compté 0★ serait le plus prioritaire du parc.
 */
export function starRatingToNumber(rating: string | null | undefined): number {
	if (!rating) return 0;
	const map: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
	return map[rating] ?? 0;
}

/** Un avis tel qu'il sera écrit en base : formats DB, identité normalisée. */
export interface NormalizedReview {
	/** Identité stable (segment nu) — porte l'unique `gmb_reviews.review_id`. */
	reviewKey: string;
	/** Le `name` complet renvoyé par Google, conservé pour la trace et les preuves. */
	reviewName: string;
	locationId: string;
	locationLabel: string;
	authorName: string;
	rating: number;
	comment: string;
	/** Tel que Google l'envoie (ISO). Colonne historique, jamais réécrite. */
	createTime: string;
	/** Réponse publiée chez Google, ou `null`. */
	remoteReplyText: string | null;
	/** `reviewReply.updateTime` au format DB, ou `null`. */
	remoteReplyAt: string | null;
	/** `updateTime` de l'avis au format DB, ou `null`. */
	remoteUpdateAt: string | null;
}

/** Enveloppe brute d'un avis GBP v4 (les champs que nous lisons). */
interface RawReview {
	name?: unknown;
	reviewId?: unknown;
	reviewer?: { displayName?: unknown };
	starRating?: unknown;
	comment?: unknown;
	createTime?: unknown;
	updateTime?: unknown;
	reviewReply?: { comment?: unknown; updateTime?: unknown };
}

/** Convertit un horodatage Google (ISO) au format DB, ou `null` si illisible. */
function toDbOrNull(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		return toDbTimestamp(value);
	} catch {
		return null;
	}
}

/**
 * Enveloppe brute → avis normalisé, ou `null` si elle est inexploitable.
 *
 * `null` est un TROU NOMMÉ, pas un échec silencieux : l'appelant le compte et le journalise
 * (`unreadable`), exactement comme `url-inspection.ts` compte ses réponses illisibles. Rendre
 * un objet à champs vides serait pire — un avis sans identité ni date d'création entrerait en
 * base avec `createTime: ''`, et se lirait « reçu en l'an 0, jamais répondu », donc le finding
 * le plus prioritaire du parc.
 *
 * Les deux seules exigences sont l'IDENTITÉ et la DATE DE CRÉATION. Une note absente devient
 * `0` (illisible, exclu des closures) et un commentaire absent devient `''` — ce sont des cas
 * légitimes chez Google : un avis peut être une note sans texte.
 */
export function normalizeReview(
	raw: unknown,
	ctx: { locationId: string; locationLabel: string }
): NormalizedReview | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as RawReview;

	const rawName = typeof r.name === 'string' && r.name ? r.name : typeof r.reviewId === 'string' ? r.reviewId : '';
	const reviewKey = normalizeReviewKey(rawName);
	if (!reviewKey) return null;

	const createTime = typeof r.createTime === 'string' ? r.createTime.trim() : '';
	if (!createTime) return null;

	return {
		reviewKey,
		reviewName: rawName,
		locationId: ctx.locationId,
		locationLabel: ctx.locationLabel,
		authorName:
			typeof r.reviewer?.displayName === 'string' && r.reviewer.displayName
				? r.reviewer.displayName
				: 'Anonyme',
		rating: starRatingToNumber(typeof r.starRating === 'string' ? r.starRating : null),
		comment: typeof r.comment === 'string' ? r.comment : '',
		createTime,
		remoteReplyText:
			typeof r.reviewReply?.comment === 'string' && r.reviewReply.comment
				? r.reviewReply.comment
				: null,
		remoteReplyAt: toDbOrNull(r.reviewReply?.updateTime),
		remoteUpdateAt: toDbOrNull(r.updateTime)
	};
}

// ── 3. Le diff ─────────────────────────────────────────────────────────────────────────

/** L'état en base d'un avis, réduit aux champs que Google peut contredire. */
export interface StoredReview {
	reviewKey: string;
	rating: number;
	comment: string;
	authorName: string;
	locationLabel: string;
	remoteReplyText: string | null;
	remoteReplyAt: string | null;
	remoteUpdateAt: string | null;
}

/**
 * Les colonnes que la collecte a le droit de réécrire. Écrite EN DUR, jamais dérivée d'un
 * spread — c'est la garde qui protège `draft_reply`, `mentioned_employees` et `replied_at`.
 *
 * ⚠️ Un `SET` généreux au premier passage effacerait des mois de brouillons et toute la
 * matière première d'`employee_mentions`. Ces trois colonnes sont LOCALES : Google n'en sait
 * rien et n'a donc rien à en dire.
 */
export const SYNCABLE_FIELDS = [
	'rating',
	'comment',
	'authorName',
	'locationLabel',
	'remoteReplyText',
	'remoteReplyAt',
	'remoteUpdateAt'
] as const;

export type SyncableField = (typeof SYNCABLE_FIELDS)[number];

export interface ReviewDiff {
	action: 'insert' | 'update' | 'unchanged';
	/** Les champs qui diffèrent. Vide si `unchanged`, ignoré si `insert`. */
	fields: SyncableField[];
}

/**
 * Ce qui a changé entre la base et Google.
 *
 * Sert deux buts distincts : décider si un `UPDATE` vaut la peine (une charge identique ne
 * doit produire aucune écriture de contenu — l'acceptation GMB-002 « deux syncs ne créent pas
 * deux avis », qui cesse d'être gratuite dès qu'on passe de `onConflictDoNothing` à
 * `onConflictDoUpdate`), et donner le VOCABULAIRE de « un avis modifié invalide le brouillon
 * associé » : `fields` contenant `rating` ou `comment` est exactement ce cas.
 *
 * `last_seen_at` n'est pas dans le diff : il est rafraîchi à CHAQUE observation, y compris
 * quand rien n'a changé. C'est même tout son intérêt — « j'ai regardé et c'est identique »
 * doit se distinguer de « je n'ai pas regardé ».
 */
export function diffReview(existing: StoredReview | null, incoming: NormalizedReview): ReviewDiff {
	if (!existing) return { action: 'insert', fields: [] };

	const fields: SyncableField[] = [];
	if (existing.rating !== incoming.rating) fields.push('rating');
	if (existing.comment !== incoming.comment) fields.push('comment');
	if (existing.authorName !== incoming.authorName) fields.push('authorName');
	if (existing.locationLabel !== incoming.locationLabel) fields.push('locationLabel');
	if (existing.remoteReplyText !== incoming.remoteReplyText) fields.push('remoteReplyText');
	if (existing.remoteReplyAt !== incoming.remoteReplyAt) fields.push('remoteReplyAt');
	if (existing.remoteUpdateAt !== incoming.remoteUpdateAt) fields.push('remoteUpdateAt');

	return { action: fields.length > 0 ? 'update' : 'unchanged', fields };
}

/** Vrai si le diff porte sur le CONTENU de l'avis — donc invalide un brouillon (GMB-002). */
export function invalidatesDraft(diff: ReviewDiff): boolean {
	return diff.fields.includes('rating') || diff.fields.includes('comment');
}

// ── 4. Le résumé d'une passe ───────────────────────────────────────────────────────────

export interface LocationSyncOutcome {
	locationId: string;
	locationLabel: string;
	status: 'success' | 'error';
	/** Avis renvoyés par Google (0 est une valeur légitime : une fiche sans avis). */
	seen: number;
	inserted: number;
	updated: number;
	unchanged: number;
	/** Enveloppes inexploitables — un trou COMPTÉ, jamais avalé. */
	unreadable: number;
	/** Vrai si `MAX_REVIEW_PAGES` a été atteint : l'inventaire est incomplet, et le dit. */
	truncated: boolean;
	/** Message structuré du dernier échec, `null` en succès. */
	error: string | null;
}

export interface SyncSummary {
	locations: number;
	succeeded: number;
	failed: number;
	seen: number;
	inserted: number;
	updated: number;
	unchanged: number;
	unreadable: number;
	truncated: boolean;
	/** Vrai si AUCUNE location n'a réussi — le seul cas où le job doit échouer. */
	allFailed: boolean;
}

/**
 * Agrège les issues par établissement.
 *
 * `allFailed` porte la règle d'échec du job, et elle est délibérément stricte : une fiche
 * supprimée chez Google (404) ne doit pas faire échouer la collecte des cinq autres — c'est
 * l'« isolation des erreurs par établissement » de SPEC §9.6. Mais un job qui n'a RIEN pu
 * collecter doit échouer, sinon la file enregistrerait un succès sur une panne totale, et le
 * détecteur du lot 2 hériterait d'un scope vide qu'il prendrait pour un parc sain.
 *
 * ⚠️ `locations: 0` (projet sans fiche GMB) n'est PAS un échec : `allFailed` est faux. Cinq
 * des neuf projets sont dans ce cas, et leur job doit réussir vite avec un motif nommé.
 */
export function summarizeSync(outcomes: LocationSyncOutcome[]): SyncSummary {
	const succeeded = outcomes.filter((o) => o.status === 'success').length;
	const sum = (pick: (o: LocationSyncOutcome) => number) =>
		outcomes.reduce((acc, o) => acc + pick(o), 0);

	return {
		locations: outcomes.length,
		succeeded,
		failed: outcomes.length - succeeded,
		seen: sum((o) => o.seen),
		inserted: sum((o) => o.inserted),
		updated: sum((o) => o.updated),
		unchanged: sum((o) => o.unchanged),
		unreadable: sum((o) => o.unreadable),
		truncated: outcomes.some((o) => o.truncated),
		allFailed: outcomes.length > 0 && succeeded === 0
	};
}

/**
 * Le message d'échec rangé dans `project_gmb_locations.last_sync_error`.
 *
 * Borné : cette colonne est lue par un écran, pas par un debugger. Un corps d'erreur Google
 * complet y ferait entrer des kilo-octets de HTML de proxy.
 */
export const MAX_SYNC_ERROR_CHARS = 500;

export function formatSyncError(err: unknown): string {
	if (err instanceof GmbApiError) {
		const parts = [`HTTP ${err.status}`];
		if (err.reason) parts.push(err.reason);
		parts.push(err.message);
		return parts.join(' · ').slice(0, MAX_SYNC_ERROR_CHARS);
	}
	const message = err instanceof Error ? err.message : String(err);
	return message.slice(0, MAX_SYNC_ERROR_CHARS);
}
