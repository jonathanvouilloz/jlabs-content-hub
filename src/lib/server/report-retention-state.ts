/**
 * REP-004 lot 2 — Rétention du DÉTAIL d'un rapport publié : le MODÈLE (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), même paire que `report-history-state.ts` /
 * `report-publication.ts`. Il répond à une seule question : **de quel rapport ai-je le droit de
 * retirer le détail ?**
 *
 * ⭐ **On purge le DÉTAIL, jamais la LIGNE.** Un rapport pèse ~28 kio de `payload_json`, et
 * §7.11 range les rapports en « sans limite, protégés ». Les deux tiennent ensemble dès qu'on
 * cesse de confondre le RAPPORT (le créneau, son statut, son SLO, sa préparation, son lignage —
 * des faits qui ne pèsent rien et qu'on relit des années après) et son DÉTAIL (la matière). Le
 * lot 1 en dépendait déjà sans le dire : `supersedes_id` n'a pas de FK et le numéro de révision
 * se dérive du `max`, précisément pour que la rétention ne casse ni le lignage ni la
 * numérotation. Supprimer des LIGNES ferait mentir le second — la révision 4 s'appellerait 3.
 *
 * ⭐ **« Archivé » est une CONDITION, pas une intention.** Une purge qui ne vérifie pas que le
 * détail existe ailleurs n'est pas une rétention, c'est une perte : un rapport ne se regénère
 * pas (REP-003 l'a construit sur l'état du parc à cet instant ; `loadWeeklyReport` répondrait
 * aujourd'hui avec le parc d'aujourd'hui). `not_archived` retient donc une ligne quel que soit
 * son âge, et rien dans ce module ne permet de passer outre.
 *
 * ⚠️ **L'âge se compte sur le CRÉNEAU (`slot_at`), jamais sur `published_at`.** C'est la semaine
 * couverte qui vieillit — même règle que `describeReportsFreshness`. Sinon réviser un vieux
 * créneau lui rendrait N semaines de rétention, alors que la révision décrit toujours la même
 * vieille semaine.
 */

/** Clé portant la fenêtre de rétention du détail dans `system_settings`. */
export const DETAIL_RETENTION_KEY = 'report.detail_retention_weeks';

/**
 * Plancher de la fenêtre, en semaines.
 *
 * ⚠️ Un réglage à 1 purgerait le détail du rapport de la semaine dernière — c'est-à-dire
 * l'unique rapport que quelqu'un est en train de lire. Le plancher rend ce cas inatteignable
 * par réglage, comme `samplePctMax` est clampé à 60 % (IDX-004) pour qu'un échantillon ne
 * puisse jamais prendre le dernier slot de quota.
 */
export const MIN_DETAIL_RETENTION_WEEKS = 4;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Valide une fenêtre brute (texte de `system_settings`, ou JSON `{"weeks":N}`) → semaines.
 *
 * `null` = **rétention désactivée, le détail est conservé sans limite**. C'est le défaut du
 * code, et ce n'est pas une prudence gratuite : `weekly_reports` compte 0 ligne, et écrire une
 * politique de purge chiffrée pour une table vide serait de la spéculation. Le mécanisme
 * existe, la fenêtre se pose le jour où il y a quelque chose à purger.
 *
 * Toute valeur illisible, négative ou nulle retombe sur `null` (conserver), jamais sur une
 * fenêtre courte : le pire cas d'une valeur corrompue doit être « on garde tout », pas « on
 * purge tout ». Une valeur sous le plancher est REMONTÉE, pas refusée — l'appelant compare à
 * `MIN_DETAIL_RETENTION_WEEKS` s'il veut le dire.
 */
export function resolveDetailRetentionWeeks(raw: string | null | undefined): number | null {
	if (raw === null || raw === undefined || raw === '') return null;
	let value: unknown = raw;
	try {
		const parsed: unknown = JSON.parse(raw);
		value = parsed && typeof parsed === 'object' ? (parsed as { weeks?: unknown }).weeks : parsed;
	} catch {
		value = raw;
	}
	if (value === null) return null;
	const weeks = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(weeks) || weeks <= 0) return null;
	return Math.max(MIN_DETAIL_RETENTION_WEEKS, Math.floor(weeks));
}

// ── L'état du détail d'une ligne ────────────────────────────────────

/**
 * Où en est le détail d'un rapport.
 *
 * ⭐ **Une union, pas trois booléens.** `stored` / `archived` / `purged` sont trois états d'une
 * même chose, et un jeu de drapeaux autoriserait l'état impossible « purgé mais pas archivé »
 * dans le code alors que la base le refuse (`weekly_reports_payload_presence_check`). Le type
 * et la contrainte disent la même chose.
 */
export type DetailState =
	/** Le payload est en base et n'est parti nulle part. */
	| { kind: 'stored'; bytes: number | null }
	/** Le payload est en base ET retrouvé dans le vault : purgeable le jour venu. */
	| {
			kind: 'archived';
			bytes: number | null;
			archivedAt: string;
			archiveRef: string;
	  }
	/** Le payload n'est plus en base : il vit à `archiveRef`, et son empreinte le prouve. */
	| {
			kind: 'purged';
			bytes: number | null;
			archivedAt: string;
			archiveRef: string;
			purgedAt: string;
			digest: string;
	  };

/** Les colonnes de rétention d'une ligne, telles que la base les porte. */
export interface DetailColumns {
	hasPayload: boolean;
	payloadBytes: number | null;
	payloadDigest: string | null;
	payloadArchivedAt: string | null;
	payloadArchiveRef: string | null;
	payloadPurgedAt: string | null;
}

/**
 * L'état du détail, dérivé des colonnes.
 *
 * ⚠️ Ne « répare » rien : une ligne sans payload dont l'archive manquerait serait un état que le
 * CHECK interdit. Si elle existait quand même (contrainte non appliquée), la lire comme `stored`
 * serait le pire choix — on la rend `purged` avec ce qu'elle porte, quitte à afficher une
 * adresse vide, parce que « le détail n'est plus là » reste vrai et que c'est ce qui compte.
 */
export function deriveDetailState(row: DetailColumns): DetailState {
	if (!row.hasPayload) {
		return {
			kind: 'purged',
			bytes: row.payloadBytes,
			archivedAt: row.payloadArchivedAt ?? '',
			archiveRef: row.payloadArchiveRef ?? '',
			purgedAt: row.payloadPurgedAt ?? '',
			digest: row.payloadDigest ?? ''
		};
	}
	if (row.payloadArchivedAt && row.payloadArchiveRef) {
		return {
			kind: 'archived',
			bytes: row.payloadBytes,
			archivedAt: row.payloadArchivedAt,
			archiveRef: row.payloadArchiveRef
		};
	}
	return { kind: 'stored', bytes: row.payloadBytes };
}

/** L'état du détail, écrit pour un humain. */
export function describeDetailState(state: DetailState): string {
	const size = state.bytes === null ? null : `${Math.round(state.bytes / 1024)} kio`;
	switch (state.kind) {
		case 'stored':
			return size
				? `Détail conservé en base (${size}) — jamais archivé hors ligne.`
				: 'Détail conservé en base — jamais archivé hors ligne.';
		case 'archived':
			return `Détail conservé en base${size ? ` (${size})` : ''} et archivé le ${state.archivedAt} dans « ${state.archiveRef} » : il pourra être purgé sans rien perdre.`;
		case 'purged':
			return `Détail purgé le ${state.purgedAt}${size ? ` (${size} libérés)` : ''} — il reste lisible dans l’archive « ${state.archiveRef} », empreinte SHA-256 ${state.digest.slice(0, 12)}… Le rapport lui-même (créneau, statut, SLO, préparation, révisions) n’a pas bougé.`;
	}
}

// ── Le plan de purge ────────────────────────────────────────────────

/**
 * Pourquoi une ligne n'est PAS purgée. Chaque raison appelle un geste différent, et c'est
 * pourquoi il y en a quatre plutôt qu'un `false` :
 *
 *   - `retention_disabled` — aucune fenêtre réglée : le geste est de la poser ;
 *   - `within_retention`   — trop récente : le geste est d'attendre ;
 *   - `not_archived`       — le détail n'existe nulle part ailleurs : le geste est d'archiver ;
 *   - `already_purged`     — rien à faire, et surtout pas « repurger » (ce serait un no-op qui
 *                            se lirait comme un travail).
 */
export type PurgeHoldReason =
	'retention_disabled' | 'within_retention' | 'not_archived' | 'already_purged';

/** Une ligne candidate à la purge, réduite à ce que la décision a besoin de savoir. */
export interface RetentionCandidate {
	id: string;
	periodSlot: string;
	revision: number;
	/** Instant du CRÉNEAU (format DB). L'âge se compte là-dessus, jamais sur `published_at`. */
	slotAt: string;
	detail: DetailState;
}

export interface PurgeEntry {
	id: string;
	periodSlot: string;
	revision: number;
	/** `null` quand `slot_at` est illisible — jamais 0, qui se lirait « publié aujourd'hui ». */
	ageDays: number | null;
	bytes: number | null;
	note: string;
}

export interface PurgeHold extends PurgeEntry {
	reason: PurgeHoldReason;
}

export interface DetailPurgePlan {
	/** La fenêtre appliquée. `null` = rétention désactivée : rien n'est purgeable. */
	retentionWeeks: number | null;
	/** Instant de coupure (ms), ou `null` si la rétention est désactivée. */
	cutoffMs: number | null;
	purge: PurgeEntry[];
	hold: PurgeHold[];
	/**
	 * Octets qui seraient libérés — **borne inférieure**, jamais un total.
	 *
	 * ⚠️ Une ligne archivée avant que `payload_bytes` soit mesuré porte `null` : la compter 0
	 * annoncerait « rien à gagner » sur une purge qui libère peut-être 28 kio. Doctrine IDX-004
	 * (« au plus N », jamais « il reste N ») : `bytesKnown` dit si le total est complet.
	 */
	bytes: number;
	bytesKnown: boolean;
	headline: string;
}

function ageDaysOf(slotAt: string, nowMs: number, parseMs: (v: string) => number): number | null {
	const ms = parseMs(slotAt);
	if (!Number.isFinite(ms)) return null;
	return Math.max(0, Math.floor((nowMs - ms) / DAY_MS));
}

/**
 * Quelles lignes peuvent perdre leur détail, et pourquoi les autres le gardent.
 *
 * ⚠️ **Aucune exception pour la révision courante ni pour le dernier créneau.** L'âge est l'âge :
 * un créneau de l'an dernier reste vieux même s'il a été révisé hier, et le plancher de fenêtre
 * (`MIN_DETAIL_RETENTION_WEEKS`) suffit à garantir qu'un rapport récent n'est jamais candidat.
 * Ajouter une exception ferait deux règles à tenir d'accord, dont une invisible à la lecture du
 * plan.
 *
 * ⚠️ **Un `slot_at` illisible RETIENT la ligne** (`within_retention`, âge `null`) : une date
 * qu'on ne sait pas lire ne prouve pas que la ligne est vieille. Purger sur un âge inconnu est
 * la seule erreur irréversible de ce module.
 */
export function planDetailPurge(input: {
	candidates: readonly RetentionCandidate[];
	retentionWeeks: number | null;
	nowMs: number;
	/** Format DB → instant. Injecté (`dbTimestampToMs`) : ce module reste pur. */
	parseMs: (value: string) => number;
}): DetailPurgePlan {
	const { retentionWeeks } = input;
	const cutoffMs = retentionWeeks === null ? null : input.nowMs - retentionWeeks * WEEK_MS;

	const purge: PurgeEntry[] = [];
	const hold: PurgeHold[] = [];

	for (const candidate of input.candidates) {
		const ageDays = ageDaysOf(candidate.slotAt, input.nowMs, input.parseMs);
		const base = {
			id: candidate.id,
			periodSlot: candidate.periodSlot,
			revision: candidate.revision,
			ageDays,
			bytes: candidate.detail.bytes
		};

		if (candidate.detail.kind === 'purged') {
			hold.push({
				...base,
				reason: 'already_purged',
				note: 'détail déjà purgé : il n’y a rien à retirer, et le repurger serait un no-op qui se lirait comme un travail.'
			});
			continue;
		}
		if (retentionWeeks === null || cutoffMs === null) {
			hold.push({
				...base,
				reason: 'retention_disabled',
				note: 'aucune fenêtre de rétention réglée — le détail est conservé sans limite (défaut du code).'
			});
			continue;
		}
		if (candidate.detail.kind !== 'archived') {
			hold.push({
				...base,
				reason: 'not_archived',
				note: 'le détail n’existe nulle part ailleurs : un rapport ne se régénère pas (il a été construit sur l’état du parc de ce créneau-là). Archiver d’abord.'
			});
			continue;
		}
		const slotMs = input.parseMs(candidate.slotAt);
		if (!Number.isFinite(slotMs) || slotMs > cutoffMs) {
			hold.push({
				...base,
				reason: 'within_retention',
				note: Number.isFinite(slotMs)
					? `créneau dans la fenêtre de rétention (${retentionWeeks} semaines).`
					: 'créneau illisible : un âge inconnu ne prouve pas qu’une ligne est vieille, elle est conservée.'
			});
			continue;
		}
		purge.push({
			...base,
			note: `créneau au-delà de ${retentionWeeks} semaines, détail archivé le ${candidate.detail.archivedAt} dans « ${candidate.detail.archiveRef} ».`
		});
	}

	const bytes = purge.reduce((sum, p) => sum + (p.bytes ?? 0), 0);
	const bytesKnown = purge.every((p) => p.bytes !== null);

	const headline =
		retentionWeeks === null
			? `Rétention du détail désactivée : ${input.candidates.length} rapport(s) conservé(s) intégralement.`
			: `${purge.length} détail(s) purgeable(s) au-delà de ${retentionWeeks} semaines · ${
					hold.length
				} conservé(s) · ${bytesKnown ? '' : 'au moins '}${Math.round(bytes / 1024)} kio libérables.`;

	return { retentionWeeks, cutoffMs, purge, hold, bytes, bytesKnown, headline };
}

// ── L'archive : nom de fichier et empreinte ─────────────────────────

/**
 * Le nom du fichier d'archive d'une révision.
 *
 * ⚠️ **Pas de `:` dans un nom de fichier** (illégal sous Windows, piège classique) : le créneau
 * `2026-07-27T09:00` devient `2026-07-27-0900`. La transformation est bijective et le nom reste
 * la SEULE métadonnée du fichier — parce que son contenu, lui, est le `payload_json` octet pour
 * octet, et rien d'autre. Y ajouter un en-tête casserait l'égalité des empreintes entre la base,
 * le fichier et la note du vault.
 */
export function archiveFileName(periodSlot: string, revision: number): string {
	const [date, time] = periodSlot.split('T');
	const compact = (time ?? '0000').replace(':', '');
	return `weekly-report-${date}-${compact}-r${revision}.json`;
}

/** L'inverse d'`archiveFileName`. `null` si le nom ne suit pas la convention. */
export function parseArchiveFileName(
	fileName: string
): { periodSlot: string; revision: number } | null {
	const m = /^weekly-report-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})-r(\d+)\.json$/.exec(fileName);
	if (!m) return null;
	return { periodSlot: `${m[1]}T${m[2]}:${m[3]}`, revision: Number(m[4]) };
}
