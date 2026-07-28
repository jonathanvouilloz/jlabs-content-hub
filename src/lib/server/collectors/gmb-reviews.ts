/**
 * GMB-002 — Collecteur d'avis Google, RÉCONCILIANT et observable.
 *
 * **Ce qui manquait.** `syncProjectReviews` collectait déjà des avis — et ne pouvait rien
 * corriger : `onConflictDoNothing` sur l'unique `review_id`, donc un avis connu n'était
 * JAMAIS rafraîchi, et `fetchProjectReviews` filtrait `!r.reply`, donc un avis répondu
 * n'entrait jamais. Le hub ne pouvait que fabriquer des fantômes et n'avait aucun moyen de
 * les dissiper. Mesuré le 2026-07-28 : `physiopommier` porte un avis du 15 mars toujours « en
 * attente », et personne ne peut dire s'il a été oublié ou répondu directement dans Google.
 *
 * Trois défauts de fond du legacy, corrigés ici :
 *
 *   1. **il jetait toutes ses erreurs** — le cron avalait chaque échec dans un `catch {}`
 *      anonyme (`api/cron/gmb-reviews/+server.ts:26`), sans log ni écriture. Un projet
 *      pouvait échouer soixante jours d'affilée sans laisser une trace. Ici chaque
 *      établissement écrit son issue dans `project_gmb_locations.last_sync_*` : « mois calme »
 *      et « panne depuis avril » cessent d'être indiscernables ;
 *   2. **il jetait une chaîne** — `new Error("Fetch reviews failed: 429 …")`, où
 *      `classifyJobFailure` ne trouvait `rateLimitExceeded` que dans le TEXTE du message.
 *      Ça marchait par chance. `parseGmbError` rend une `GmbApiError` portant `status` et
 *      `reason`, donc quota et auth sont classés juste, gratuitement ;
 *   3. **sa pagination n'avait aucune borne** — `do…while(pageToken)` : un `nextPageToken`
 *      constant faisait tourner un job sous bail jusqu'à ce que le worker le tue.
 *
 * **Coût Google : nul.** `fetchLocationReviews` paginait DÉJÀ tout ; le filtre de 30 jours
 * était appliqué après le fetch. Réconcilier la totalité ne coûte pas un appel de plus.
 *
 * **Ce que ce lot ne fait PAS :** juger. Aucun finding n'est produit ici — c'est le lot 2
 * (`detect:review_pending`). Ce collecteur ne fait qu'une chose : rendre vrai, en base, ce
 * que Google dit aujourd'hui.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppDb } from '../db/types.js';
import { gmbReviews, projectGmbLocations } from '../db/schema.js';
import { log } from '../log.js';
import { createId } from '../utils.js';
import { toDbTimestamp } from '../timestamps.js';
import {
	diffReview,
	formatSyncError,
	invalidatesDraft,
	normalizeReview,
	parseGmbError,
	summarizeSync,
	GmbApiError,
	MAX_REVIEW_PAGES,
	REVIEW_PAGE_SIZE,
	type LocationSyncOutcome,
	type NormalizedReview,
	type StoredReview,
	type SyncSummary
} from './gmb-reviews-state.js';

const logger = log('collector:gmb-reviews');

/**
 * Taille des lots d'écriture. Le legacy faisait UNE instruction SQL par avis sur un WebSocket
 * Neon serverless : 800 avis × 30-60 ms = 24 à 48 s, dans une fonction Vercel, sous bail.
 * Par lots de 100, le même travail tient en une poignée d'allers-retours.
 */
const WRITE_CHUNK = 100;

/** Ce que le collecteur a besoin de savoir du monde extérieur — tout est injectable. */
export interface GmbReviewDeps {
	getAccessToken: () => Promise<string>;
	getAccountId: () => Promise<string>;
	/** Injecté par les preuves : aucune requête réseau ne part alors. */
	fetchImpl?: typeof fetch;
}

export interface CollectGmbReviewsInput {
	projectId: string;
	deps: GmbReviewDeps;
	runId?: string | null;
	/** N'écrit rien : sondage et `--dry-run`. */
	dryRun?: boolean;
	client?: AppDb;
	now?: Date;
	signal?: AbortSignal;
}

export interface CollectGmbReviewsResult {
	projectId: string;
	/** Instant de référence du run, format DB. C'est LUI qu'on écrit dans `last_seen_at`. */
	syncedAt: string;
	locations: LocationSyncOutcome[];
	summary: SyncSummary;
	/** Brouillons invalidés parce que la note ou le commentaire a changé (GMB-002). */
	draftsInvalidated: number;
	/**
	 * Motif nommé quand le collecteur n'avait rien à faire. `null` s'il a travaillé.
	 * Un run qui n'a RIEN PU collecter ne doit jamais se lire comme un run qui n'a rien trouvé.
	 */
	skippedReason: string | null;
	dryRun: boolean;
}

const REVIEWS_BASE = 'https://mybusiness.googleapis.com/v4';

/** Résolution paresseuse du client : le module reste chargeable hors runtime SvelteKit. */
async function resolveDb(client?: AppDb): Promise<AppDb> {
	if (client) return client;
	const mod = await import('../db/index.js');
	return mod.db as unknown as AppDb;
}

/**
 * Toutes les pages d'avis d'un établissement.
 *
 * Une erreur sort en `GmbApiError` STRUCTURÉE — jamais en chaîne : c'est ce qui rend la
 * classification JOB-003 exacte et le refroidissement JOB-006 déclenchable. La troncature
 * (`MAX_REVIEW_PAGES`) est REMONTÉE, jamais silencieuse : un inventaire incomplet qui se
 * tairait ferait passer les avis non vus pour disparus au run suivant.
 */
async function fetchAllReviews(input: {
	locationId: string;
	locationLabel: string;
	accountId: string;
	accessToken: string;
	fetchImpl: typeof fetch;
	signal?: AbortSignal;
}): Promise<{ reviews: NormalizedReview[]; unreadable: number; truncated: boolean }> {
	const locId = input.locationId.replace(/^locations\//, '');
	const reviews: NormalizedReview[] = [];
	let unreadable = 0;
	let pageToken: string | undefined;
	let pages = 0;

	do {
		if (input.signal?.aborted) break;

		const params = new URLSearchParams({ pageSize: String(REVIEW_PAGE_SIZE) });
		if (pageToken) params.set('pageToken', pageToken);

		const url = `${REVIEWS_BASE}/accounts/${input.accountId}/locations/${locId}/reviews?${params}`;
		const res = await input.fetchImpl(url, {
			headers: { Authorization: `Bearer ${input.accessToken}` }
		});

		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw parseGmbError({
				status: res.status,
				body,
				retryAfter: res.headers?.get?.('retry-after') ?? null,
				locationId: input.locationId
			});
		}

		const data = (await res.json()) as { reviews?: unknown[]; nextPageToken?: string };
		for (const rawReview of data.reviews ?? []) {
			const normalized = normalizeReview(rawReview, {
				locationId: input.locationId,
				locationLabel: input.locationLabel
			});
			// `null` est un trou COMPTÉ : une enveloppe sans identité ni date de création
			// entrerait sinon en base comme un avis « reçu en l'an 0, jamais répondu ».
			if (normalized) reviews.push(normalized);
			else unreadable += 1;
		}

		pageToken = data.nextPageToken;
		pages += 1;
	} while (pageToken && pages < MAX_REVIEW_PAGES);

	return { reviews, unreadable, truncated: Boolean(pageToken) && pages >= MAX_REVIEW_PAGES };
}

/** L'état en base des avis d'un établissement, réduit à ce que Google peut contredire. */
async function loadStored(
	db: AppDb,
	projectId: string,
	keys: string[]
): Promise<Map<string, StoredReview>> {
	if (keys.length === 0) return new Map();
	const out = new Map<string, StoredReview>();

	for (let i = 0; i < keys.length; i += WRITE_CHUNK) {
		const rows = await db
			.select({
				reviewKey: gmbReviews.reviewId,
				rating: gmbReviews.rating,
				comment: gmbReviews.comment,
				authorName: gmbReviews.authorName,
				locationLabel: gmbReviews.locationLabel,
				remoteReplyText: gmbReviews.remoteReplyText,
				remoteReplyAt: gmbReviews.remoteReplyAt,
				remoteUpdateAt: gmbReviews.remoteUpdateAt
			})
			.from(gmbReviews)
			.where(
				and(
					eq(gmbReviews.projectId, projectId),
					inArray(gmbReviews.reviewId, keys.slice(i, i + WRITE_CHUNK))
				)
			);
		for (const r of rows) out.set(r.reviewKey, r as StoredReview);
	}
	return out;
}

/**
 * Ce que `writeReviews` FERAIT, sans rien écrire.
 *
 * Partage le même `diffReview` que le chemin d'écriture — c'est tout l'intérêt : un dry-run
 * qui compterait avec sa propre logique finirait par annoncer autre chose que ce que
 * l'exécution produit, et le sondage d'avant-bascule ne vaudrait rien.
 */
function countWrites(
	reviews: NormalizedReview[],
	stored: Map<string, StoredReview>
): { inserted: number; updated: number; unchanged: number; draftsInvalidated: number } {
	let inserted = 0;
	let updated = 0;
	let unchanged = 0;
	let draftsInvalidated = 0;

	for (const review of reviews) {
		const diff = diffReview(stored.get(review.reviewKey) ?? null, review);
		if (diff.action === 'insert') inserted += 1;
		else if (diff.action === 'update') {
			updated += 1;
			if (invalidatesDraft(diff)) draftsInvalidated += 1;
		} else unchanged += 1;
	}

	return { inserted, updated, unchanged, draftsInvalidated };
}

/**
 * Écrit les avis d'un établissement.
 *
 * ⚠️ La liste des colonnes du `SET` est ÉCRITE EN DUR, jamais dérivée d'un spread. C'est la
 * garde qui protège `draft_reply`, `mentioned_employees` et `replied_at` : ces trois colonnes
 * sont LOCALES, Google n'en sait rien et n'a donc rien à en dire. Un `SET` généreux au
 * premier passage effacerait des mois de brouillons et toute la matière d'`employee_mentions`.
 *
 * La seule exception est délibérée : quand la note ou le commentaire CHANGE, `draft_reply`
 * est remis à `NULL` — c'est l'acceptation GMB-002 « un avis modifié invalide le brouillon
 * associé ». Répondre à un avis 5★ avec un brouillon écrit quand il était 2★ serait pire que
 * de ne pas répondre.
 */
async function writeReviews(input: {
	db: AppDb;
	projectId: string;
	reviews: NormalizedReview[];
	stored: Map<string, StoredReview>;
	syncedAt: string;
}): Promise<{ inserted: number; updated: number; unchanged: number; draftsInvalidated: number }> {
	let inserted = 0;
	let updated = 0;
	let unchanged = 0;
	let draftsInvalidated = 0;

	/** Les avis dont seul `last_seen_at` bouge : une seule instruction pour tout le lot. */
	const touchOnly: string[] = [];
	/** Ceux qu'il faut écrire (insert ou update) : groupés, jamais un aller-retour chacun. */
	const toWrite: NormalizedReview[] = [];

	for (const review of input.reviews) {
		const diff = diffReview(input.stored.get(review.reviewKey) ?? null, review);
		if (diff.action === 'unchanged') {
			unchanged += 1;
			touchOnly.push(review.reviewKey);
			continue;
		}
		if (invalidatesDraft(diff)) draftsInvalidated += 1;
		if (diff.action === 'insert') inserted += 1;
		else updated += 1;
		toWrite.push(review);
	}

	// Écriture PAR LOTS. Le premier import réel porte 2 807 avis (mesuré en dry-run sur les
	// 4 projets équipés) : un aller-retour par avis, c'est 2 807 allers-retours sur un
	// WebSocket Neon serverless, soit une à trois minutes sous bail dans une fonction Vercel.
	// Par lots de 100, le même travail tient en une trentaine d'échanges.
	for (let i = 0; i < toWrite.length; i += WRITE_CHUNK) {
		const chunk = toWrite.slice(i, i + WRITE_CHUNK);
		await input.db
			.insert(gmbReviews)
			.values(
				chunk.map((review) => ({
					id: createId(),
					projectId: input.projectId,
					locationId: review.locationId,
					locationLabel: review.locationLabel,
					reviewId: review.reviewKey,
					authorName: review.authorName,
					rating: review.rating,
					comment: review.comment,
					createTime: review.createTime,
					remoteReplyText: review.remoteReplyText,
					remoteReplyAt: review.remoteReplyAt,
					remoteUpdateAt: review.remoteUpdateAt,
					lastSeenAt: input.syncedAt
				}))
			)
			.onConflictDoUpdate({
				target: gmbReviews.reviewId,
				set: {
					// Colonnes DISTANTES uniquement — la liste est exhaustive et volontairement
					// littérale. Ni `draftReply`, ni `repliedAt`, ni `mentionedEmployees`.
					rating: sql`excluded.rating`,
					comment: sql`excluded.comment`,
					authorName: sql`excluded.author_name`,
					locationLabel: sql`excluded.location_label`,
					remoteReplyText: sql`excluded.remote_reply_text`,
					remoteReplyAt: sql`excluded.remote_reply_at`,
					remoteUpdateAt: sql`excluded.remote_update_at`,
					lastSeenAt: sql`excluded.last_seen_at`,
					// L'unique exception, et elle est le contraire d'un effet de bord : un avis
					// dont la NOTE ou le TEXTE a changé rend son brouillon caduc (GMB-002).
					// Exprimée en SQL plutôt que par un drapeau calculé en amont, parce que le
					// lot est écrit d'un bloc — et parce que la condition devient ainsi une
					// propriété de l'écriture, vraie ligne par ligne, jamais approximée.
					draftReply: sql`CASE
						WHEN excluded.rating IS DISTINCT FROM ${gmbReviews.rating}
						  OR excluded.comment IS DISTINCT FROM ${gmbReviews.comment}
						THEN NULL
						ELSE ${gmbReviews.draftReply}
					END`
				}
			});
	}

	// « J'ai regardé et c'est identique » doit se distinguer de « je n'ai pas regardé » :
	// c'est exactement ce que `last_seen_at` porte, et ce dont le scope du lot 2 dépend.
	for (let i = 0; i < touchOnly.length; i += WRITE_CHUNK) {
		await input.db
			.update(gmbReviews)
			.set({ lastSeenAt: input.syncedAt })
			.where(
				and(
					eq(gmbReviews.projectId, input.projectId),
					inArray(gmbReviews.reviewId, touchOnly.slice(i, i + WRITE_CHUNK))
				)
			);
	}

	return { inserted, updated, unchanged, draftsInvalidated };
}

/**
 * Collecte les avis d'un projet, établissement par établissement.
 *
 * **Règle d'arrêt**, qui tranche la tension entre isolation et refroidissement :
 *
 *   - `quota` / `auth` (429, 401, 403 `rateLimitExceeded`) → **arrêt immédiat et rethrow**.
 *     Les établissements suivants échoueraient identiquement — le hub n'a qu'UN compte Google
 *     (`gmb_settings.account_tokens`) — et surtout la file doit APPRENDRE : c'est le rethrow
 *     qui met toute la cohorte `gmb` au repos (JOB-006). Absorber le 429 brûlerait cinq
 *     tentatives de plus contre le même mur, sans que rien ne le sache.
 *   - toute autre erreur (404 fiche supprimée, 500) → l'établissement porte son échec et **on
 *     continue** : c'est l'« isolation des erreurs par établissement » de SPEC §9.6. Une fiche
 *     morte ne doit pas emporter les cinq autres de `barberconcept`.
 *
 * **La progression est persistée par ÉTABLISSEMENT**, jamais en fin de job : un timeout au
 * cinquième laisse quatre faits acquis, et le run suivant repart de là.
 */
export async function collectGmbReviews(
	input: CollectGmbReviewsInput
): Promise<CollectGmbReviewsResult> {
	const db = await resolveDb(input.client);
	const now = input.now ?? new Date();
	const syncedAt = toDbTimestamp(now);
	const dryRun = input.dryRun ?? false;
	const fetchImpl = input.deps.fetchImpl ?? fetch;

	const locations = await db
		.select({
			id: projectGmbLocations.id,
			gmbLocationId: projectGmbLocations.gmbLocationId,
			label: projectGmbLocations.label
		})
		.from(projectGmbLocations)
		.where(eq(projectGmbLocations.projectId, input.projectId));

	// Cinq des neuf projets n'ont aucune fiche GMB. Leur job doit RÉUSSIR vite avec un motif
	// nommé — jamais échouer (ce serait un faux incident tous les jours), jamais se taire
	// (« 0 avis » se lirait comme un parc propre plutôt que comme un parc hors sujet).
	if (locations.length === 0) {
		const result: CollectGmbReviewsResult = {
			projectId: input.projectId,
			syncedAt,
			locations: [],
			summary: summarizeSync([]),
			draftsInvalidated: 0,
			skippedReason: 'no_gmb_location',
			dryRun
		};
		logger.info('collecte avis ignorée', { projectId: input.projectId, reason: 'no_gmb_location' });
		return result;
	}

	const accessToken = await input.deps.getAccessToken();
	const accountId = await input.deps.getAccountId();

	const outcomes: LocationSyncOutcome[] = [];
	let draftsInvalidated = 0;
	let aborted = false;

	try {
		for (const loc of locations) {
			if (input.signal?.aborted) {
				// Bail perdu : on n'engage pas un appel de plus. Ce qui est écrit reste, et
				// `last_sync_at` des établissements traités porte déjà leur succès.
				aborted = true;
				break;
			}

			try {
				const { reviews, unreadable, truncated } = await fetchAllReviews({
					locationId: loc.gmbLocationId,
					locationLabel: loc.label,
					accountId,
					accessToken,
					fetchImpl,
					signal: input.signal
				});

				// La lecture de l'état existant et le DIFF ont lieu dans les deux modes : un
				// dry-run qui ne compte rien ne mesurerait pas ce qu'il annonce éviter. Seule
				// l'ÉCRITURE est conditionnelle.
				const stored = await loadStored(
					db,
					input.projectId,
					reviews.map((r) => r.reviewKey)
				);
				const written = dryRun
					? countWrites(reviews, stored)
					: await writeReviews({ db, projectId: input.projectId, reviews, stored, syncedAt });
				draftsInvalidated += written.draftsInvalidated;

				outcomes.push({
					locationId: loc.gmbLocationId,
					locationLabel: loc.label,
					status: 'success',
					seen: reviews.length,
					inserted: written.inserted,
					updated: written.updated,
					unchanged: written.unchanged,
					unreadable,
					truncated,
					error: null
				});

				// Le fait de synchro est écrit MAINTENANT, pas en fin de job.
				if (!dryRun) {
					await db
						.update(projectGmbLocations)
						.set({ lastSyncAt: syncedAt, lastSyncStatus: 'success', lastSyncError: null })
						.where(eq(projectGmbLocations.id, loc.id));
				}
			} catch (err) {
				const message = formatSyncError(err);
				outcomes.push({
					locationId: loc.gmbLocationId,
					locationLabel: loc.label,
					status: 'error',
					seen: 0,
					inserted: 0,
					updated: 0,
					unchanged: 0,
					unreadable: 0,
					truncated: false,
					error: message
				});

				if (!dryRun) {
					await db
						.update(projectGmbLocations)
						.set({ lastSyncAt: syncedAt, lastSyncStatus: 'error', lastSyncError: message })
						.where(eq(projectGmbLocations.id, loc.id));
				}

				// Quota et auth valent pour TOUT le compte : continuer serait brûler des
				// tentatives contre le même mur, et priverait la file du signal qui met la
				// cohorte `gmb` au repos.
				if (err instanceof GmbApiError && (err.status === 429 || err.status === 401)) throw err;
				if (err instanceof GmbApiError && err.reason && /ratelimit|resource_exhausted|quota/i.test(err.reason)) {
					throw err;
				}

				logger.warn('établissement en échec, collecte poursuivie', {
					projectId: input.projectId,
					locationId: loc.gmbLocationId,
					error: message
				});
			}
		}
	} finally {
		logger.info('collecte avis terminée', {
			projectId: input.projectId,
			...summarizeSync(outcomes),
			draftsInvalidated,
			aborted,
			dryRun
		});
	}

	const summary = summarizeSync(outcomes);

	// Une panne TOTALE ne doit pas s'enregistrer comme un succès : le détecteur du lot 2
	// hériterait d'un scope vide qu'il prendrait pour un parc sain.
	if (summary.allFailed) {
		const first = outcomes.find((o) => o.error)?.error ?? 'aucun établissement synchronisé';
		throw new Error(`collecte avis échouée sur les ${outcomes.length} établissement(s) : ${first}`);
	}

	return {
		projectId: input.projectId,
		syncedAt,
		locations: outcomes,
		summary,
		draftsInvalidated,
		skippedReason: aborted ? 'aborted' : null,
		dryRun
	};
}
