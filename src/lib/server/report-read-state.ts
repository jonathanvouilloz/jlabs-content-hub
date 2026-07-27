/**
 * DASH-003 lot 2, chantier 3 — l'écran Rapports : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), même paire que `project-indexing-state.ts` /
 * `project-indexing.ts`. Il décide **ce que l'écran a le droit de dire** d'un rapport que
 * REP-001 a construit et que REP-003 a publié — et rien de plus.
 *
 * ⭐ **L'écran est une PROJECTION d'un JSON archivé, jamais une reconstruction.** REP-003 pose
 * que le contenu d'un rapport est une fonction du CRÉNEAU (`now = slot`) : recalculer quoi que
 * ce soit ici ferait dire à l'écran de lundi prochain autre chose que ce qui a été publié lundi
 * dernier, et « il reste accessible après restart » perdrait son sujet. Une projection a le droit
 * de compresser et de trier ; elle n'a **jamais** le droit d'ajouter.
 *
 * Ce que ce module NE fait pas :
 *
 *   - il **ne dérive pas** le SLO. `deriveSlo` (`report-publication-state.ts`) le fait déjà à
 *     chaque lecture, dans `toMeta` : une seconde comparaison `published_at <= due_at` ici
 *     divergerait le jour où l'échéance change de valeur — exactement le piège que REP-003 a
 *     refusé en n'ajoutant aucune colonne de verdict ;
 *   - il **ne recompte pas** la préparation. `summarizeReadiness` a produit `readiness_json` au
 *     moment de la publication, avec le parc de CE moment-là ; le recompter aujourd'hui
 *     répondrait avec le parc d'aujourd'hui, et un projet créé mardi apparaîtrait comme
 *     « attendu » d'un créneau de lundi ;
 *   - il **ne réordonne pas** les sections. Le rapport porte son propre plan (`report.sections`),
 *     ce qui rend un rapport de 2026 relisible même si `SECTION_ORDER` change.
 *
 * ⭐ **Ce qu'il protège avant tout : « absent, pas zéro ».** L'étoile de REP-001 est qu'il
 * n'existe aucun endroit où loger un `0` pour un provider non branché — `Availability<T>` est une
 * union discriminée, une section absente n'a **pas de corps**. L'UI est l'endroit le plus facile
 * où défaire ça (`section.body.data?.items.length ?? 0` suffirait). `sectionView` rend donc à son
 * tour une union discriminée : le template ne peut pas atteindre un compteur qui n'existe pas.
 */
import type {
	AbsenceReason,
	Availability,
	BlindSpot,
	ReportItem,
	ReportMetric,
	ReportSection,
	SectionBody,
	SectionKey,
	WeeklyReport
} from './weekly-report-state.js';
import type {
	PublicationReadiness,
	PublicationStatus,
	SloVerdict
} from './report-publication-state.js';
import type { RevisionLineage } from './report-history-state.js';
import { describeDetailState, type DetailState } from './report-retention-state.js';

// ── Le lien d'un rapport : l'URL et son libellé naissent ensemble ────

/**
 * Le lien vers un créneau publié.
 *
 * ⚠️ **Le créneau porte un `:`** (`2026-07-27T09:00`). Légal dans un segment de chemin, mais
 * `encodeURIComponent` est obligatoire côté lien : sans lui, un slot qui gagnerait un jour un
 * `/` (ou n'importe quel séparateur) casserait le routage sans bruit. SvelteKit décode
 * `params.slot` de son côté, donc la valeur relue est le `period_slot` exact.
 */
export function reportHref(periodSlot: string): string {
	return `/reports/${encodeURIComponent(periodSlot)}`;
}

/**
 * Le créneau, écrit pour un humain — **sans conversion de fuseau**.
 *
 * `period_slot` est déjà un créneau LOCAL (`Europe/Zurich`, DST comprise, décision REP-003) :
 * le relire comme une date UTC pour le reformater décalerait l'affichage d'une ou deux heures
 * selon la saison, et le lundi 09:00 de Jonathan s'afficherait « 07:00 ». On découpe la chaîne,
 * on ne la parse pas.
 */
export function formatSlotLabel(periodSlot: string): string {
	const [date, time] = periodSlot.split('T');
	if (!date || !time) return periodSlot;
	const [y, m, d] = date.split('-');
	if (!y || !m || !d) return periodSlot;
	return `${d}.${m}.${y} à ${time}`;
}

// ── La liste des créneaux publiés ───────────────────────────────────

/** Ce qu'une ligne de `/reports` affiche. Aucune valeur n'est calculée ici : tout est repris. */
export interface ReportListRow {
	periodSlot: string;
	slotLabel: string;
	href: string;
	status: PublicationStatus;
	/** Repris de `meta.slo` — jamais re-dérivé (une seule autorité sur le verdict). */
	slo: SloVerdict;
	/** Le verdict SLO, écrit. Le template recopie, il ne formate pas. */
	sloLabel: string;
	publishedAt: string;
	/** La préparation telle qu'elle a été PERSISTÉE, ou `null` si `readiness_json` est illisible. */
	readiness: PublicationReadiness | null;
	/** Une phrase qui dit le périmètre. `null` quand la préparation est illisible. */
	readinessLabel: string | null;
	/**
	 * Ce que le statut veut dire, en une phrase — jamais un badge muet.
	 *
	 * ⚠️ `partial` portait la réserve REP-003 (« republier est un no-op, un rapport partiel ne
	 * redevient jamais complet »). REP-004 lot 1 l'a rendue fausse : une **révision** peut le
	 * compléter, et la phrase dit désormais le geste au lieu de l'impasse — sans rien promettre
	 * d'automatique, puisque la révision reste délibérée.
	 */
	statusNote: string;
	/** REP-004 — numéro de la révision affichée (`1` = la publication automatique). */
	revision: number;
	/** Nombre de révisions du créneau (>= 1). */
	revisionCount: number;
	/** Une phrase, ou `null` quand le créneau n'a jamais été révisé (rien à signaler). */
	revisionLabel: string | null;
	/**
	 * REP-004 lot 2 — où vit le détail de ce créneau (`stored` / `archived` / `purged`).
	 *
	 * ⚠️ Lu depuis les colonnes légères, jamais depuis le payload : la liste ne charge aucun
	 * détail, et c'est précisément ce qui lui permet d'en parler sans le payer.
	 */
	detailState: DetailState['kind'];
	/**
	 * Une phrase, ou `null` quand le détail est simplement là.
	 *
	 * Le cas nominal ne se commente pas : annoncer « détail conservé » sur douze lignes ferait
	 * du bruit là où il n'y a pas de fait.
	 */
	detailNote: string | null;
}

/**
 * Le verdict SLO, écrit.
 *
 * ⚠️ Sur un créneau révisé, la phrase NOMME la publication d'origine. Le SLO se dérive de
 * `firstPublishedAt` (`toMeta`) : sans ce rappel, « SLO tenu » s'afficherait au-dessus d'une
 * ligne datée du mercredi et se lirait comme la ponctualité de la révision.
 */
function describeSlo(
	slo: SloVerdict,
	deadlineMinutes: number | null,
	revisionCount = 1
): string {
	const scope = revisionCount > 1 ? ' — publication d’origine' : '';
	if (slo.met) {
		return deadlineMinutes === null
			? `SLO tenu${scope}`
			: `SLO tenu (échéance créneau +${deadlineMinutes} min)${scope}`;
	}
	const lateMinutes = Math.max(1, Math.round(slo.lateMs / 60000));
	return `SLO manqué de ${lateMinutes} min${scope}`;
}

function describeReadiness(readiness: PublicationReadiness): string {
	const parts = [
		`${readiness.expected} projet${readiness.expected > 1 ? 's' : ''} attendu${readiness.expected > 1 ? 's' : ''}`,
		`${readiness.ready} prêt${readiness.ready > 1 ? 's' : ''}`,
		`${readiness.degraded} dégradé${readiness.degraded > 1 ? 's' : ''}`,
		`${readiness.waiting} en attente`,
		`${readiness.missing} absent${readiness.missing > 1 ? 's' : ''}`
	];
	// Les projets écartés par une PAUSE sont dits à part : une décision assumée n'a rien à faire
	// dans la même énumération que ce qui a cassé (même règle que `renderPublicationAnnouncement`).
	if (readiness.paused.length > 0) {
		parts.push(`${readiness.paused.length} en pause (${readiness.paused.join(', ')})`);
	}
	return parts.join(' · ');
}

const STATUS_NOTE: Record<PublicationStatus, string> = {
	complete: 'Tout le périmètre attendu a produit son run hebdomadaire.',
	partial:
		'Publié sans tout le périmètre attendu. Une révision peut le compléter quand la collecte a fini d’arriver — c’est un geste délibéré, jamais automatique, et la publication d’origine reste consultable.'
};

/** Ce que le lignage dit d'un créneau, en une ligne. `null` = jamais révisé. */
function describeRevision(revision: number, revisionCount: number): string | null {
	if (revisionCount <= 1) return null;
	const position = revision === revisionCount ? 'courante' : 'archivée';
	return `Révision ${revision}/${revisionCount} (${position}) — les précédentes restent lisibles telles qu’elles ont été publiées.`;
}

/**
 * La liste des créneaux publiés, telle que `/reports` la rend.
 *
 * ⚠️ Aucun `now` en paramètre, et c'est voulu : rien dans cette liste ne dépend de l'instant de
 * lecture. Deux lectures à trois semaines d'écart doivent rendre exactement les mêmes lignes,
 * sinon « le rapport reste accessible après restart » ne voudrait plus dire grand-chose.
 */
export function summarizeReportList(
	metas: readonly {
		periodSlot: string;
		status: PublicationStatus;
		publishedAt: string;
		readiness: PublicationReadiness | null;
		slo: SloVerdict;
		revision?: number;
		revisionCount?: number;
		retention?: DetailState;
	}[]
): ReportListRow[] {
	return metas.map((meta) => {
		const revision = meta.revision ?? 1;
		const revisionCount = meta.revisionCount ?? 1;
		const retention: DetailState = meta.retention ?? { kind: 'stored', bytes: null };
		return {
			periodSlot: meta.periodSlot,
			slotLabel: formatSlotLabel(meta.periodSlot),
			href: reportHref(meta.periodSlot),
			status: meta.status,
			slo: meta.slo,
			sloLabel: describeSlo(meta.slo, meta.readiness?.deadlineMinutes ?? null, revisionCount),
			publishedAt: meta.publishedAt,
			readiness: meta.readiness,
			readinessLabel: meta.readiness ? describeReadiness(meta.readiness) : null,
			statusNote: STATUS_NOTE[meta.status],
			revision,
			revisionCount,
			revisionLabel: describeRevision(revision, revisionCount),
			detailState: retention.kind,
			detailNote: retention.kind === 'stored' ? null : describeDetailState(retention)
		};
	});
}

// ── L'état de la liste : « jamais publié » n'est pas « rien à dire » ──

export type ReportsFreshnessState = 'never' | 'current' | 'stale';

export interface ReportsFreshness {
	state: ReportsFreshnessState;
	/** Le dernier créneau publié, ou `null`. **Jamais** une date par défaut. */
	lastSlot: string | null;
	/** Âge en jours du dernier créneau publié — `null` si aucun. JAMAIS 0 pour « aucun ». */
	ageDays: number | null;
	note: string;
}

/** Au-delà de 8 jours sans publication, un créneau hebdomadaire a été manqué. */
export const REPORTS_STALE_AFTER_DAYS = 8;

/**
 * L'état de la publication, vu de la liste.
 *
 * ⚠️ **« Aucun rapport publié » n'est pas « rapport vide ».** Même doctrine que
 * `describeInspectionFreshness` (`project-indexing-state.ts`) et que les trois absences de
 * REP-001 : une liste vide sur un cockpit qui n'a jamais tourné annonce que **le tick n'a
 * jamais publié**, pas qu'il n'y avait rien à dire. Les deux demandent deux gestes opposés
 * (brancher le cron / lire le rapport).
 *
 * ⚠️ Le retard se compte sur le **créneau**, pas sur `published_at` : c'est la semaine
 * couverte qui vieillit. Un rapport publié en retard couvre quand même son créneau.
 */
export function describeReportsFreshness(input: {
	/**
	 * Un couple par rapport publié : le créneau LOCAL (ce qu'on affiche) et son `slot_at`
	 * (l'instant, au format DB, UTC).
	 *
	 * ⚠️ **Les deux sont nécessaires et ne se déduisent pas l'un de l'autre.** `period_slot`
	 * est local (`2026-07-27T09:00`, `Europe/Zurich`) : le passer à `dbTimestampToMs` le
	 * lirait comme de l'UTC et décalerait l'âge d'une à deux heures selon la saison. `slot_at`
	 * est l'instant exact, mais il ne s'affiche pas — il dirait 07:00 pour le lundi 09:00 de
	 * Jonathan. Chacun sert à ce pour quoi REP-003 l'a écrit.
	 */
	entries: readonly { periodSlot: string; slotAt: string }[];
	/** Instant de lecture (ms) — passé, jamais lu d'une horloge implicite. */
	nowMs: number;
	/** Format DB → instant. Injecté (`dbTimestampToMs`) : ce module reste pur. */
	parseMs: (value: string) => number;
}): ReportsFreshness {
	if (input.entries.length === 0) {
		return {
			state: 'never',
			lastSlot: null,
			ageDays: null,
			note: 'Aucun rapport publié à ce jour — le tick hebdomadaire n’en a encore produit aucun. Ce n’est pas une semaine sans nouvelle.'
		};
	}
	// Le plus RÉCENT, quel que soit l'ordre reçu : `period_slot` est trié lexicalement, ce que
	// son format (`YYYY-MM-DDTHH:MM`) rend équivalent à un tri chronologique.
	const last = [...input.entries].sort((a, b) => a.periodSlot.localeCompare(b.periodSlot)).at(-1) as {
		periodSlot: string;
		slotAt: string;
	};
	const lastSlot = last.periodSlot;
	const lastMs = input.parseMs(last.slotAt);
	if (!Number.isFinite(lastMs)) {
		return {
			state: 'current',
			lastSlot,
			ageDays: null,
			note: `Dernier créneau publié : ${formatSlotLabel(lastSlot)} (âge indéterminable).`
		};
	}
	const ageDays = Math.max(0, Math.floor((input.nowMs - lastMs) / 86_400_000));
	if (ageDays > REPORTS_STALE_AFTER_DAYS) {
		return {
			state: 'stale',
			lastSlot,
			ageDays,
			note: `Dernier créneau publié il y a ${ageDays} j (${formatSlotLabel(lastSlot)}) — au moins un créneau hebdomadaire n’a produit aucun rapport.`
		};
	}
	return {
		state: 'current',
		lastSlot,
		ageDays,
		note: `Dernier créneau publié il y a ${ageDays} j (${formatSlotLabel(lastSlot)}).`
	};
}

// ── Une section : l'union discriminée qui interdit le zéro ───────────

/**
 * Une section prête à rendre.
 *
 * ⭐ **C'est une union, pas un objet à champs optionnels.** Une section absente n'a ni `metrics`,
 * ni `items`, ni `truncated` : le template ne peut donc pas écrire « 0 » pour un provider non
 * branché, parce qu'il n'y a aucun champ où ce `0` pourrait vivre. C'est le portage littéral de
 * l'invariant REP-001 jusqu'à l'écran — le seul endroit du parcours où il n'avait pas encore de
 * gardien.
 */
export type SectionView =
	| {
			key: SectionKey;
			title: string;
			kind: 'absent';
			/** `not_wired` | `never_collected` | `not_examined` — trois gestes différents. */
			reason: AbsenceReason;
			/** La phrase persistée dans le rapport, recopiée. */
			detail: string;
			/** Ce que l'absence demande, en une phrase. */
			note: string;
	  }
	| {
			key: SectionKey;
			title: string;
			kind: 'present';
			metrics: ReportMetric[];
			items: ReportItem[];
			/** Items écartés par le plafond — **dits**, jamais tus. */
			truncated: number;
			truncationNote: string | null;
			blindSpots: BlindSpot[];
			note: string | null;
			/** `true` quand la section couvre son périmètre et n'a rien trouvé. */
			isEmpty: boolean;
	  };

const ABSENCE_NOTE: Record<AbsenceReason, string> = {
	not_wired: 'Aucun fournisseur branché pour cette section — il n’y a rien à collecter, donc rien à compter.',
	never_collected: 'Le fournisseur est branché mais n’a jamais rien collecté sur la période.',
	not_examined: 'La donnée existe, mais aucun diagnostic ne l’a examinée sur la période.'
};

/**
 * La troncature, dite avec le total réel.
 *
 * Doctrine `buildTimeline` : une liste plafonnée qui ne dit pas son plafond se lit comme une
 * liste complète. `truncated` est le nombre d'items ÉCARTÉS, donc le total se reconstitue.
 */
export function describeTruncation(body: SectionBody): string | null {
	if (body.truncated <= 0) return null;
	const shown = body.items.length;
	return `${shown} affichés sur ${shown + body.truncated} — ${body.truncated} écartés par le plafond de section.`;
}

/**
 * Projette une section du rapport archivé.
 *
 * ⚠️ **`isEmpty` n'est PAS une absence.** Une section `present` à 0 item dit « j'ai regardé, il
 * n'y a rien » ; une section `absent` dit « je n'ai pas regardé, ou il n'y a rien à regarder ».
 * Les rendre pareil est exactement ce que le gate d'examen de REP-001 interdit — et c'est aussi
 * pourquoi `blindSpots` reste attaché à la section même quand elle est vide : « rien de nouveau »
 * sur un parc dont deux projets n'ont jamais été diagnostiqués n'annonce pas une semaine calme.
 */
export function sectionView(section: ReportSection): SectionView {
	const body: Availability<SectionBody> = section.body;
	if (!body.available) {
		return {
			key: section.key,
			title: section.title,
			kind: 'absent',
			reason: body.reason,
			detail: body.detail,
			note: ABSENCE_NOTE[body.reason]
		};
	}
	return {
		key: section.key,
		title: section.title,
		kind: 'present',
		metrics: body.data.metrics,
		items: body.data.items,
		truncated: body.data.truncated,
		truncationNote: describeTruncation(body.data),
		blindSpots: body.data.blindSpots,
		note: body.data.note,
		isEmpty: body.data.items.length === 0
	};
}

// ── Le rapport entier ───────────────────────────────────────────────

/**
 * Ce qu'un rapport porte AVANT son détail : le créneau, le verdict, la préparation, le lignage.
 *
 * ⭐ **C'est exactement ce qui survit à la rétention** (REP-004 lot 2), et c'est pour ça que
 * l'en-tête est un type à part : une ligne dont le détail a été purgé garde tout ceci, et la
 * page reste donc une page — avec son statut, son SLO, ses révisions et l'adresse de son
 * archive. « Les liens restent valides après rétention du détail » n'est pas une promesse de
 * l'écran, c'est la forme de ce type.
 */
export interface ReportHeaderView {
	periodSlot: string;
	slotLabel: string;
	status: PublicationStatus;
	statusNote: string;
	slo: SloVerdict;
	sloLabel: string;
	publishedAt: string;
	readiness: PublicationReadiness | null;
	readinessLabel: string | null;
	/** Version du schéma de rapport telle qu'elle a été publiée. */
	reportSchemaVersion: number;
	/** REP-004 — la révision affichée, et le nombre de révisions du créneau. */
	revision: number;
	revisionCount: number;
	revisionLabel: string | null;
	/** La raison de CETTE révision (`null` sur la révision 1). */
	revisionReason: string | null;
	/** Le lignage complet du créneau — `null` quand il n'a qu'une révision. */
	lineage: RevisionLineage | null;
	/** REP-004 lot 2 — où vit le détail, et ce que ça implique, en une phrase. */
	detailNote: string;
}

/**
 * Le détail d'un rapport, projeté — ou son absence NOMMÉE.
 *
 * ⭐ **Union, cinquième application de « absent ≠ zéro ».** Le cas `purged` n'a ni `sections`,
 * ni `headline`, ni `coverage` : un template ne peut donc pas rendre un rapport purgé comme un
 * rapport à zéro section (ce qui afficherait douze providers non branchés pour un rapport qui
 * en portait dix). Le prix est un `{#if}` de plus dans la page ; le bénéfice est qu'aucun oubli
 * de `{#if}` ne peut mentir.
 */
export type ReportDetailView =
	| ({ kind: 'available' } & ReportHeaderView & ReportBody)
	| ({ kind: 'purged' } & ReportHeaderView & PurgedBody);

/** Ce que porte un rapport dont le détail est encore là. */
export interface ReportBody {
	generatedAt: string;
	/** Bornes RÉELLES de ce qui a été compté, reprises du payload. */
	periodLabel: string;
	headline: string;
	/** Les angles morts du PARC, une fois — non répétés section par section. */
	coverage: BlindSpot[];
	coverageNote: string | null;
	/** Les sections **dans l'ordre du JSON archivé**, jamais dans celui de la spec courante. */
	sections: SectionView[];
}

/**
 * Ce que porte un rapport dont le détail a été retiré par la rétention.
 *
 * Aucun champ chiffré, aucune section, aucun résumé : ce que ce rapport DISAIT n'est pas ici,
 * il est à `archiveRef`. Le seul contenu est l'adresse et l'empreinte — de quoi retrouver le
 * fichier et prouver que c'est le bon.
 */
export interface PurgedBody {
	purgedAt: string;
	archiveRef: string;
	/** Ce que pesait le détail. `null` sur une ligne archivée avant qu'on le mesure. */
	bytes: number | null;
}

/** Le lien vers une révision précise d'un créneau. */
export function revisionHref(periodSlot: string, revision: number): string {
	return `${reportHref(periodSlot)}?revision=${revision}`;
}

/**
 * Les angles morts du parc, en une phrase.
 *
 * Ils restent dans chaque section (une section extraite seule doit garder sa réserve), mais
 * l'écran ne les répète pas douze fois : à neuf projets et douze sections, la même liste
 * s'imprimerait 108 fois et noierait le rapport — la même compression que `renderWeeklyReportText`.
 */
export function describeCoverage(coverage: readonly BlindSpot[]): string | null {
	if (coverage.length === 0) return null;
	const byReason = new Map<BlindSpot['reason'], string[]>();
	for (const spot of coverage) {
		const list = byReason.get(spot.reason) ?? [];
		list.push(spot.projectSlug);
		byReason.set(spot.reason, list);
	}
	const labels: Record<BlindSpot['reason'], string> = {
		never_examined: 'jamais diagnostiqués',
		partially_examined: 'partiellement diagnostiqués',
		paused: 'en pause'
	};
	const parts: string[] = [];
	for (const [reason, slugs] of byReason) {
		parts.push(`${labels[reason]} : ${[...slugs].sort().join(', ')}`);
	}
	return `Ce rapport ne peut rien dire de ${coverage.length} projet${
		coverage.length > 1 ? 's' : ''
	} — ${parts.join(' · ')}.`;
}

/** Ce qui ne dépend PAS du détail — donc ce qui survit à sa purge. */
interface HeaderInput {
	periodSlot: string;
	status: PublicationStatus;
	publishedAt: string;
	reportSchemaVersion: number;
	slo: SloVerdict;
	readiness: PublicationReadiness | null;
	revision?: number;
	revisionCount?: number;
	revisionReason?: string | null;
	/** Le lignage du créneau, tel que `describeLineage` le rend. */
	lineage?: RevisionLineage | null;
	/** REP-004 lot 2 — l'état du détail, tel que `deriveDetailState` le rend. */
	retention?: DetailState;
}

function buildHeader(input: HeaderInput): ReportHeaderView {
	const revision = input.revision ?? 1;
	const revisionCount = input.revisionCount ?? 1;
	const retention: DetailState = input.retention ?? { kind: 'stored', bytes: null };
	return {
		periodSlot: input.periodSlot,
		slotLabel: formatSlotLabel(input.periodSlot),
		status: input.status,
		statusNote: STATUS_NOTE[input.status],
		slo: input.slo,
		sloLabel: describeSlo(input.slo, input.readiness?.deadlineMinutes ?? null, revisionCount),
		publishedAt: input.publishedAt,
		readiness: input.readiness,
		readinessLabel: input.readiness ? describeReadiness(input.readiness) : null,
		reportSchemaVersion: input.reportSchemaVersion,
		revision,
		revisionCount,
		revisionLabel: describeRevision(revision, revisionCount),
		revisionReason: input.revisionReason ?? null,
		lineage: input.lineage ?? null,
		detailNote: describeDetailState(retention)
	};
}

/**
 * Projette un rapport publié pour `/reports/[slot]`.
 *
 * Le seul paramètre est ce qui a été PERSISTÉ — même discipline que `renderWeeklyReportText`
 * (« générable sans LLM » devient structurel quand la fonction n'a rien d'autre à lire) et que
 * `renderPublicationAnnouncement`. L'écran ne peut donc rien affirmer que la base ne porte pas.
 */
export function buildReportView(
	input: HeaderInput & { report: WeeklyReport }
): Extract<ReportDetailView, { kind: 'available' }> {
	const { report } = input;
	return {
		kind: 'available',
		...buildHeader(input),
		generatedAt: report.generatedAt,
		periodLabel: report.period.label,
		headline: report.headline,
		coverage: report.coverage,
		coverageNote: describeCoverage(report.coverage),
		sections: report.sections.map(sectionView)
	};
}

/**
 * Projette un rapport dont le DÉTAIL a été purgé (REP-004 lot 2).
 *
 * ⭐ **Ce n'est pas une page d'erreur, et ce n'est pas une page vide.** Le rapport a existé, il
 * a été publié à l'heure (ou non), il a peut-être été révisé — tout cela est encore vrai et
 * encore affiché. Seule sa matière est ailleurs, à une adresse que la page donne. C'est le sens
 * exact de l'acceptation « les liens restent valides après rétention du détail » : le lien vers
 * le créneau ne casse pas, il change de destination.
 */
export function buildPurgedReportView(
	input: HeaderInput & { purgedAt: string; archiveRef: string; bytes?: number | null }
): Extract<ReportDetailView, { kind: 'purged' }> {
	return {
		kind: 'purged',
		...buildHeader(input),
		purgedAt: input.purgedAt,
		archiveRef: input.archiveRef,
		bytes: input.bytes ?? null
	};
}
