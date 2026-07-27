/**
 * REP-004 lot 1 — Historique et comparaison des rapports : le MODÈLE (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), même paire que `report-read-state.ts` /
 * `report-publication.ts`. Deux sujets, une seule raison d'être ensemble : ils répondent à la
 * même question — **qu'est-ce qui a changé, et de quoi ai-je le droit de le déduire ?**
 *
 *   1. la RÉVISION d'un créneau (« régénérer un rapport ne remplace pas silencieusement
 *      l'original ») ;
 *   2. la COMPARAISON de deux rapports publiés (d'une semaine à l'autre, ou d'une révision à
 *      la suivante).
 *
 * ⭐ **LE point du lot : un écart n'existe QUE quand les deux côtés ont regardé la même chose.**
 * REP-001 a rendu structurel « absent, pas zéro » à l'intérieur d'un rapport ; DASH-003 l'a
 * porté jusqu'à l'écran. La comparaison est le troisième endroit où l'invariant se défait — et
 * le plus coûteux, parce qu'ici il ne produit pas un `0` mais un **mouvement** : une section
 * `not_wired` la semaine dernière et remplie cette semaine annoncerait `+13`, un provider tombé
 * en panne annoncerait `−13` (donc « treize problèmes résolus »). Ce sont des faits inventés
 * par la forme de la donnée, pas par le parc. `SectionComparison` est donc une **union
 * discriminée** dont les variantes `became_available` / `became_absent` ne portent **aucun
 * champ chiffré** : il n'y a pas de case où un delta pourrait vivre.
 *
 * C'est la même règle que FIND-005 (« seuls les couples présents dans les DEUX fenêtres sont
 * comparés ») et que GSC-004 (« aucun delta entre longueurs incompatibles »), appliquée cette
 * fois à la structure du rapport plutôt qu'aux observations.
 *
 * ⚠️ Ce module ne LIT rien et ne recalcule rien : les deux rapports comparés sont les JSON
 * archivés, tels qu'ils ont été publiés. Une comparaison qui reconstruirait l'un des deux
 * côtés répondrait sur le parc d'aujourd'hui à une question posée sur celui d'il y a un mois.
 */
import type {
	AbsenceReason,
	ReportItem,
	ReportMetric,
	ReportSection,
	ReportSource,
	SectionKey,
	WeeklyReport
} from './weekly-report-state.js';

// ════════════════════════════════════════════════════════════════════
// 1. La révision d'un créneau
// ════════════════════════════════════════════════════════════════════

/**
 * Pourquoi une révision est refusée.
 *
 *   - `no_original` — le créneau n'a jamais été publié. Réviser un rapport qui n'existe pas
 *     n'est pas une révision, c'est une publication : le geste est `publishWeeklyReport`, et
 *     l'y renvoyer vaut mieux que d'écrire une « révision 1 » par une autre porte.
 *   - `reason_required` — une révision sans raison est un remplacement silencieux qui a
 *     simplement gardé l'ancienne ligne. La contrainte
 *     `weekly_reports_revision_reason_check` le refuse aussi en base ; ici on le refuse
 *     AVANT de reconstruire le rapport, donc sans dépenser une lecture de parc.
 */
export type RevisionRefusal = 'no_original' | 'reason_required';

/** Longueur maximale d'une raison de révision — assez pour une phrase, pas pour un rapport. */
export const REVISION_REASON_MAX_LENGTH = 500;

export type RevisionDecision =
	| { action: 'refuse'; refusal: RevisionRefusal; note: string }
	| { action: 'revise'; revision: number; reason: string; supersedesId: string };

/**
 * Normalise une raison de révision. `null` = pas de raison utilisable.
 *
 * Les espaces seuls ne sont pas une raison : sans ce `trim`, `" "` passerait le CHECK de la
 * base (la valeur n'est pas NULL) et le journal porterait une justification vide.
 */
export function normalizeRevisionReason(raw: string | null | undefined): string | null {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim().slice(0, REVISION_REASON_MAX_LENGTH);
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Faut-il écrire une révision, et laquelle ?
 *
 * ⚠️ **Le numéro se dérive de la révision COURANTE, pas d'un compte de lignes.** `max + 1`
 * plutôt que `count + 1` : les deux coïncident tant que rien n'est purgé, et divergent
 * silencieusement le jour où la rétention (lot 2) videra les plus anciennes — la révision 4
 * s'appellerait alors 3 et écraserait une ligne existante.
 */
export function decideRevision(input: {
	/** La révision courante du créneau, ou `null` si le créneau n'a jamais été publié. */
	current: { id: string; revision: number } | null;
	reason: string | null | undefined;
}): RevisionDecision {
	if (!input.current) {
		return {
			action: 'refuse',
			refusal: 'no_original',
			note: 'Ce créneau n’a jamais été publié : il n’y a rien à réviser. La publication initiale passe par le tick (ou `publishWeeklyReport`).'
		};
	}
	const reason = normalizeRevisionReason(input.reason);
	if (!reason) {
		return {
			action: 'refuse',
			refusal: 'reason_required',
			note: 'Une révision porte toujours sa raison : sans elle, régénérer serait un remplacement silencieux qui a gardé l’ancienne ligne.'
		};
	}
	return {
		action: 'revise',
		revision: input.current.revision + 1,
		reason,
		supersedesId: input.current.id
	};
}

// ── Le lignage, tel que l'écran le montre ───────────────────────────

export interface RevisionEntry {
	id: string;
	revision: number;
	status: 'complete' | 'partial';
	publishedAt: string;
	/** `null` sur la révision 1 : personne n'a rien régénéré. */
	reason: string | null;
	/** `true` pour la révision affichée par défaut (la plus haute). */
	current: boolean;
}

export interface RevisionLineage {
	entries: RevisionEntry[];
	/** Une phrase, ou `null` quand le créneau n'a qu'une révision (rien à raconter). */
	note: string | null;
}

/**
 * Le lignage d'un créneau — l'acceptation « ne remplace pas silencieusement », rendue lisible.
 *
 * ⚠️ La révision COURANTE est celle qui porte le numéro le plus haut, jamais la plus récemment
 * écrite : `published_at` d'une révision est l'heure de son écriture, et deux écritures
 * concurrentes pourraient s'inverser d'une milliseconde. Le numéro, lui, est porté par
 * l'unique (period_slot, revision) — il ne peut pas mentir.
 */
export function describeLineage(
	rows: readonly {
		id: string;
		revision: number;
		status: 'complete' | 'partial';
		publishedAt: string;
		revisionReason: string | null;
	}[]
): RevisionLineage {
	const sorted = [...rows].sort((a, b) => a.revision - b.revision);
	const max = sorted.at(-1)?.revision ?? 0;
	const entries: RevisionEntry[] = sorted.map((r) => ({
		id: r.id,
		revision: r.revision,
		status: r.status,
		publishedAt: r.publishedAt,
		reason: r.revisionReason,
		current: r.revision === max
	}));
	if (entries.length <= 1) return { entries, note: null };
	const first = entries[0];
	const last = entries[entries.length - 1];
	const changedStatus =
		first.status !== last.status
			? ` Le statut est passé de ${first.status} à ${last.status} ; la publication d’origine reste consultable telle qu’elle a été publiée.`
			: ' La publication d’origine reste consultable telle qu’elle a été publiée.';
	return {
		entries,
		note: `${entries.length} révisions pour ce créneau.${changedStatus}`
	};
}

// ════════════════════════════════════════════════════════════════════
// 2. La comparaison de deux rapports
// ════════════════════════════════════════════════════════════════════

/**
 * Le détail d'un rapport publié — présent, ou retiré par la rétention (REP-004 lot 2).
 *
 * ⭐ **Une union, et c'est le quatrième endroit où « absent ≠ zéro » se défait.** `payload_json`
 * est nullable depuis le lot 2 ; un `report: WeeklyReport | null` aurait invité le premier
 * `?? EMPTY_REPORT` venu, et un rapport vide n'est pas un rapport purgé : il porterait douze
 * sections sans corps, donc la comparaison annoncerait douze sections « hors plan » et un
 * changement de TEMPLATE — un mouvement fabriqué par une politique de rétention. Ici le cas
 * purgé n'a pas de `report` du tout : il n'y a aucune case où un rapport de substitution
 * pourrait vivre.
 */
export type ReportDetail =
	| { kind: 'available'; report: WeeklyReport }
	| { kind: 'purged'; purgedAt: string; archiveRef: string };

/** Un rapport publié, réduit à ce qu'une comparaison a besoin de savoir. */
export interface ComparisonPoint {
	periodSlot: string;
	revision: number;
	/** Version du schéma de rapport telle qu'elle a été PUBLIÉE — jamais celle du code courant. */
	reportSchemaVersion: number;
	detail: ReportDetail;
}

/**
 * Sur quel axe on compare.
 *
 *   - `slot` — deux créneaux différents : « qu'est-ce qui a changé depuis la semaine dernière ? ».
 *   - `revision` — deux révisions du MÊME créneau : « qu'est-ce que la régénération a changé ? ».
 *     Le parc n'a pas bougé de période entre les deux ; tout écart vient de la collecte qui a
 *     fini d'arriver, ou du code qui a changé. C'est l'audit d'une révision.
 */
export type ComparisonAxis = 'slot' | 'revision';

/**
 * Pourquoi les CHIFFRES d'une comparaison sont bloqués, alors que sa structure reste lisible.
 *
 *   - `schema_changed` — les deux rapports n'ont pas la même version de schéma. Les clés de
 *     métriques peuvent ne pas désigner la même chose ; apparier à l'aveugle produirait un
 *     delta calculé sur une correspondance devinée, pire qu'un delta absent.
 *   - `window_mismatch` — les deux périodes n'ont pas la même longueur. Doctrine GSC-004 :
 *     un écart entre 7 et 28 jours mesure la fenêtre, pas le parc.
 */
export type QuantitativeBlock = 'schema_changed' | 'window_mismatch';

export interface ComparisonBlock {
	reason: QuantitativeBlock;
	note: string;
}

// ── Métriques ───────────────────────────────────────────────────────

export type MetricComparison =
	| {
			key: string;
			kind: 'comparable';
			baseLabel: string;
			headLabel: string;
			/** `true` quand le libellé a changé à clé constante : un RENOMMAGE, pas une rupture. */
			renamed: boolean;
			base: number;
			head: number;
			/**
			 * L'écart BRUT. Volontairement pas de `deltaDisplay` : le schéma ne dit pas l'unité
			 * d'une métrique (`value: number | null` + `display: string` libre), donc formater
			 * `+0.07` pour un taux passé de 85 % à 92 % inventerait une unité. L'écran montre
			 * `baseDisplay → headDisplay` et la DIRECTION ; le nombre reste disponible pour qui
			 * connaît la métrique (REP-002).
			 */
			delta: number;
			direction: 'up' | 'down' | 'flat';
			baseDisplay: string;
			headDisplay: string;
	  }
	| {
			key: string;
			kind: 'unquantified';
			label: string;
			/**
			 * Au moins un des deux côtés porte `value: null` — « pas de nombre », ce que REP-001
			 * distingue soigneusement de zéro (« aucun verdict tranché » n'est pas « 0 % »).
			 * Soustraire un `null` traité comme `0` est exactement l'invariant qu'on protège.
			 */
			baseDisplay: string | null;
			headDisplay: string | null;
			note: string;
	  }
	| { key: string; kind: 'appeared'; label: string; headDisplay: string }
	| { key: string; kind: 'disappeared'; label: string; baseDisplay: string }
	| {
			key: string;
			kind: 'blocked';
			label: string;
			reason: QuantitativeBlock | 'ambiguous_key';
			baseDisplay: string | null;
			headDisplay: string | null;
			note: string;
	  };

// ── Items ───────────────────────────────────────────────────────────

/**
 * L'identité d'un item, pour l'apparier d'un rapport à l'autre.
 *
 * ⚠️ **Jamais le libellé.** Le titre d'un finding peut être réécrit par un détecteur sans que
 * le finding change ; l'apparier dessus ferait « un finding disparu, un finding apparu » pour
 * une ligne qui n'a pas bougé.
 *
 * ⚠️ Les sources `observation` ne portent QUE le nom de leur table, partagé par tous les items
 * de la section (les neuf lignes d'indexation citent toutes `index_observations`). Le projet
 * complète donc la clé : dans ces sections, un item EST un projet.
 */
export function itemKey(item: ReportItem): string {
	const s: ReportSource = item.source;
	switch (s.kind) {
		case 'finding':
			return `finding:${s.id}`;
		case 'proposal':
			return `proposal:${s.id}`;
		case 'project':
			return `project:${s.slug}`;
		case 'observation':
			return `observation:${s.table}|${item.projectSlug ?? '∅'}|${item.label}`;
	}
}

/**
 * Une section liste-t-elle des ÉVÉNEMENTS de la période, ou un ÉTAT courant ?
 *
 * ⭐ La distinction n'est pas cosmétique : sur une section d'ACTIVITÉ, un item présent la
 * semaine dernière et absent cette semaine n'a rien quitté — il a simplement cessé d'être
 * nouveau. Le compter comme « sorti » ferait lire douze résolutions là où douze findings sont
 * seulement devenus vieux. Les sections d'activité ne produisent donc **aucun mouvement
 * d'items** : leur comparaison est celle de leurs compteurs, qui, eux, mesurent bien deux
 * périodes de même longueur.
 *
 * Le classement suit `loadWeeklyReport`, qui le dit déjà de son côté (« les opportunités sont
 * un ÉTAT, pas une activité ») : il n'y a qu'une définition, ici recopiée pour rester pure.
 */
export const SECTION_NATURE: Record<SectionKey, 'activity' | 'state'> = {
	executive_summary: 'state',
	projects_needing_action: 'state',
	findings_new: 'activity',
	findings_aggravated: 'activity',
	findings_resolved: 'activity',
	opportunities: 'state',
	indexation: 'state',
	traffic_conversions: 'state',
	reviews: 'state',
	proposed_actions: 'activity',
	approvals_requested: 'state',
	automation_health: 'state'
};

export type ItemsComparison =
	| {
			kind: 'movements';
			entered: ReportItem[];
			left: ReportItem[];
			/** Items présents des deux côtés. Un nombre, pas une liste : c'est le fond stable. */
			stayed: number;
	  }
	| {
			kind: 'suppressed';
			reason: 'activity' | 'truncated' | 'ambiguous_keys';
			note: string;
	  };

// ── Sections ────────────────────────────────────────────────────────

export type SectionComparison =
	| {
			key: SectionKey;
			title: string;
			kind: 'comparable';
			metrics: MetricComparison[];
			items: ItemsComparison;
	  }
	/**
	 * ⭐ Absente avant, présente maintenant. **Aucun champ chiffré**, par construction : il n'y
	 * a pas de case où « +13 » pourrait s'écrire. Ce n'est pas une hausse, c'est un
	 * BRANCHEMENT — la section ne comptait rien la semaine dernière parce qu'il n'y avait rien
	 * à compter.
	 */
	| { key: SectionKey; title: string; kind: 'became_available'; baseReason: AbsenceReason; note: string }
	/**
	 * ⭐ Présente avant, absente maintenant. Aucun champ chiffré non plus, et c'est le cas le
	 * plus dangereux des deux : une collecte tombée en panne se lirait comme une baisse, donc
	 * comme un progrès sur une section de problèmes.
	 */
	| { key: SectionKey; title: string; kind: 'became_absent'; headReason: AbsenceReason; note: string }
	| {
			key: SectionKey;
			title: string;
			kind: 'both_absent';
			baseReason: AbsenceReason;
			headReason: AbsenceReason;
			/** `not_wired` → `never_collected` est un progrès : quelqu'un a branché. */
			reasonChanged: boolean;
			note: string;
	  }
	/** La section n'existe pas dans le plan de l'autre rapport : le TEMPLATE a changé. */
	| { key: SectionKey; title: string; kind: 'only_in_base'; note: string }
	| { key: SectionKey; title: string; kind: 'only_in_head'; note: string };

export interface ComparisonSummary {
	/** Sections effectivement comparées (les deux côtés présents). */
	compared: number;
	becameAvailable: SectionKey[];
	becameAbsent: SectionKey[];
	/** Sections présentes dans un seul des deux plans — un changement de template. */
	planChanged: SectionKey[];
	/** Une phrase. Elle ne chiffre RIEN quand rien n'est chiffrable. */
	headline: string;
}

export type ReportComparison =
	| {
			kind: 'unavailable';
			/**
			 * `detail_purged` (REP-004 lot 2) — le détail d'un des deux points a été retiré par la
			 * rétention. Ce n'est ni une erreur ni « rien n'a changé » : la comparaison n'a plus de
			 * sujet d'un côté, et le nommer envoie vers l'archive plutôt que vers un support.
			 */
			reason: 'same_point' | 'not_ordered' | 'detail_purged';
			note: string;
	  }
	| {
			kind: 'available';
			axis: ComparisonAxis;
			base: { periodSlot: string; revision: number; reportSchemaVersion: number; periodLabel: string };
			head: { periodSlot: string; revision: number; reportSchemaVersion: number; periodLabel: string };
			/** Vide = les chiffres sont comparables. Non vide = tous les deltas sont bloqués. */
			blocks: ComparisonBlock[];
			sections: SectionComparison[];
			summary: ComparisonSummary;
	  };

// ── L'ordre des deux points ─────────────────────────────────────────

/** −1 / 0 / +1 sur (créneau, révision). Le créneau d'abord : il est lexicalement chronologique. */
export function comparePoints(
	a: { periodSlot: string; revision: number },
	b: { periodSlot: string; revision: number }
): number {
	const slot = a.periodSlot.localeCompare(b.periodSlot);
	if (slot !== 0) return slot < 0 ? -1 : 1;
	if (a.revision === b.revision) return 0;
	return a.revision < b.revision ? -1 : 1;
}

// ── Le calcul ───────────────────────────────────────────────────────

function metricMap(metrics: readonly ReportMetric[]): {
	byKey: Map<string, ReportMetric>;
	ambiguous: Set<string>;
} {
	const byKey = new Map<string, ReportMetric>();
	const ambiguous = new Set<string>();
	for (const m of metrics) {
		if (byKey.has(m.key)) ambiguous.add(m.key);
		else byKey.set(m.key, m);
	}
	return { byKey, ambiguous };
}

function compareMetrics(
	baseMetrics: readonly ReportMetric[],
	headMetrics: readonly ReportMetric[],
	blocks: readonly ComparisonBlock[]
): MetricComparison[] {
	const base = metricMap(baseMetrics);
	const head = metricMap(headMetrics);
	const block = blocks[0] ?? null;
	const out: MetricComparison[] = [];

	// L'ordre est celui de la section COURANTE (head), puis ce que seule l'ancienne portait :
	// on lit un rapport pour ce qu'il dit aujourd'hui, pas pour ce qu'il disait avant.
	for (const m of headMetrics) {
		const b = base.byKey.get(m.key);
		if (base.ambiguous.has(m.key) || head.ambiguous.has(m.key)) {
			out.push({
				key: m.key,
				kind: 'blocked',
				label: m.label,
				reason: 'ambiguous_key',
				baseDisplay: b?.display ?? null,
				headDisplay: m.display,
				note: 'deux métriques portent cette clé dans la même section : impossible de savoir laquelle comparer à laquelle.'
			});
			continue;
		}
		if (!b) {
			out.push({ key: m.key, kind: 'appeared', label: m.label, headDisplay: m.display });
			continue;
		}
		if (block) {
			out.push({
				key: m.key,
				kind: 'blocked',
				label: m.label,
				reason: block.reason,
				baseDisplay: b.display,
				headDisplay: m.display,
				note: block.note
			});
			continue;
		}
		if (b.value === null || m.value === null) {
			out.push({
				key: m.key,
				kind: 'unquantified',
				label: m.label,
				baseDisplay: b.display,
				headDisplay: m.display,
				note:
					b.value === null && m.value === null
						? 'aucun des deux rapports ne chiffre cette métrique.'
						: 'un des deux rapports ne chiffre pas cette métrique — un `null` n’est pas un zéro, il n’y a donc pas d’écart à calculer.'
			});
			continue;
		}
		const delta = m.value - b.value;
		out.push({
			key: m.key,
			kind: 'comparable',
			baseLabel: b.label,
			headLabel: m.label,
			renamed: b.label !== m.label,
			base: b.value,
			head: m.value,
			delta,
			direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
			baseDisplay: b.display,
			headDisplay: m.display
		});
	}

	for (const m of baseMetrics) {
		if (head.byKey.has(m.key) || base.ambiguous.has(m.key)) continue;
		out.push({ key: m.key, kind: 'disappeared', label: m.label, baseDisplay: m.display });
	}
	return out;
}

function compareItems(input: {
	key: SectionKey;
	baseItems: readonly ReportItem[];
	headItems: readonly ReportItem[];
	baseTruncated: number;
	headTruncated: number;
}): ItemsComparison {
	if (SECTION_NATURE[input.key] === 'activity') {
		return {
			kind: 'suppressed',
			reason: 'activity',
			note: 'section d’activité : ses items sont les événements de la période. Un item absent cette semaine n’est pas sorti, il a cessé d’être nouveau — seuls ses compteurs se comparent.'
		};
	}
	// ⭐ Une liste PLAFONNÉE ne se compare pas. Les items d'une section sont coupés à 15
	// (`DEFAULT_MAX_ITEMS_PER_SECTION`) : un item présent des deux côtés mais hors plafond d'un
	// seul se lirait « entré » ou « sorti ». Ce serait un mouvement fabriqué par une limite
	// d'affichage — exactement ce que FIND-005 refuse en ne comparant que les couples présents
	// dans les DEUX fenêtres.
	if (input.baseTruncated > 0 || input.headTruncated > 0) {
		return {
			kind: 'suppressed',
			reason: 'truncated',
			note: 'au moins un des deux côtés est plafonné : comparer des listes coupées ferait entrer ou sortir des items qui n’ont fait que franchir le plafond.'
		};
	}

	const baseByKey = new Map<string, ReportItem>();
	let ambiguous = false;
	for (const it of input.baseItems) {
		const k = itemKey(it);
		if (baseByKey.has(k)) ambiguous = true;
		baseByKey.set(k, it);
	}
	const headByKey = new Map<string, ReportItem>();
	for (const it of input.headItems) {
		const k = itemKey(it);
		if (headByKey.has(k)) ambiguous = true;
		headByKey.set(k, it);
	}
	if (ambiguous) {
		return {
			kind: 'suppressed',
			reason: 'ambiguous_keys',
			note: 'deux items partagent la même identité dans cette section : les apparier reviendrait à en choisir un au hasard.'
		};
	}

	const entered = input.headItems.filter((it) => !baseByKey.has(itemKey(it)));
	const left = input.baseItems.filter((it) => !headByKey.has(itemKey(it)));
	const stayed = input.headItems.length - entered.length;
	return { kind: 'movements', entered, left, stayed };
}

const ABSENCE_WORDS: Record<AbsenceReason, string> = {
	not_wired: 'aucun provider branché',
	never_collected: 'branché, rien de collecté',
	not_examined: 'jamais examiné'
};

function compareSection(input: {
	base: ReportSection;
	head: ReportSection;
	blocks: readonly ComparisonBlock[];
}): SectionComparison {
	const { base, head } = input;
	const key = head.key;
	const title = head.title;

	if (!base.body.available && !head.body.available) {
		const reasonChanged = base.body.reason !== head.body.reason;
		return {
			key,
			title,
			kind: 'both_absent',
			baseReason: base.body.reason,
			headReason: head.body.reason,
			reasonChanged,
			note: reasonChanged
				? `l’absence a changé de nature : ${ABSENCE_WORDS[base.body.reason]} → ${ABSENCE_WORDS[head.body.reason]} — ce n’est pas rien, c’est un geste qui a été fait (ou défait).`
				: `toujours absente (${ABSENCE_WORDS[head.body.reason]}) : il n’y a rien à comparer, et surtout pas zéro à zéro.`
		};
	}
	if (!base.body.available && head.body.available) {
		return {
			key,
			title,
			kind: 'became_available',
			baseReason: base.body.reason,
			note: 'cette section n’existait pas dans le rapport précédent (elle était absente, pas vide) : ce que le rapport courant y compte n’est donc pas une hausse — il n’y a aucun écart à en tirer.'
		};
	}
	if (base.body.available && !head.body.available) {
		return {
			key,
			title,
			kind: 'became_absent',
			headReason: head.body.reason,
			note: 'cette section a cessé d’être disponible. Ce n’est pas une baisse : ce qu’elle comptait n’a pas disparu, c’est la mesure qui a disparu.'
		};
	}
	// Les deux disponibles — TypeScript ne le déduit pas des tests précédents.
	if (!base.body.available || !head.body.available) {
		throw new Error('état impossible');
	}
	return {
		key,
		title,
		kind: 'comparable',
		metrics: compareMetrics(base.body.data.metrics, head.body.data.metrics, input.blocks),
		items: compareItems({
			key,
			baseItems: base.body.data.items,
			headItems: head.body.data.items,
			baseTruncated: base.body.data.truncated,
			headTruncated: head.body.data.truncated
		})
	};
}

function buildSummary(sections: readonly SectionComparison[], blocks: readonly ComparisonBlock[]): ComparisonSummary {
	const becameAvailable = sections.filter((s) => s.kind === 'became_available').map((s) => s.key);
	const becameAbsent = sections.filter((s) => s.kind === 'became_absent').map((s) => s.key);
	const planChanged = sections
		.filter((s) => s.kind === 'only_in_base' || s.kind === 'only_in_head')
		.map((s) => s.key);
	const compared = sections.filter((s) => s.kind === 'comparable').length;

	const parts: string[] = [];
	if (blocks.length > 0) {
		// ⚠️ La phrase ne chiffre RIEN quand rien n'est chiffrable : c'est le seul endroit du
		// module où un résumé pourrait affirmer plus que ses sections.
		parts.push(`Écarts chiffrés indisponibles (${blocks.map((b) => b.reason).join(', ')})`);
	} else {
		parts.push(`${compared} section${compared > 1 ? 's' : ''} comparée${compared > 1 ? 's' : ''}`);
	}
	if (becameAvailable.length > 0) {
		parts.push(`${becameAvailable.length} devenue(s) disponible(s) — pas une hausse`);
	}
	if (becameAbsent.length > 0) {
		parts.push(`${becameAbsent.length} devenue(s) absente(s) — pas une baisse`);
	}
	if (planChanged.length > 0) {
		parts.push(`${planChanged.length} section(s) hors du plan de l’autre rapport (template modifié)`);
	}
	return {
		compared,
		becameAvailable,
		becameAbsent,
		planChanged,
		headline: `${parts.join(' · ')}.`
	};
}

/**
 * Cette section a-t-elle quelque chose à dire ?
 *
 * ⚠️ Le prédicat vit ICI et pas dans un `{#if}` : « rien n'a changé » est un jugement, et un
 * jugement écrit dans un template se perd au premier refactor (doctrine `buildProjectCounters`).
 *
 * ⚠️ Une métrique `blocked` ou `unquantified` COMPTE comme quelque chose à dire : « je ne peux
 * pas comparer » est une information, et la ravaler au rang de « rien n'a bougé » est exactement
 * la confusion que tout ce module refuse.
 */
export function sectionHasChange(section: SectionComparison): boolean {
	switch (section.kind) {
		case 'became_available':
		case 'became_absent':
		case 'only_in_base':
		case 'only_in_head':
			return true;
		case 'both_absent':
			return section.reasonChanged;
		case 'comparable': {
			const metricMoved = section.metrics.some(
				(m) => m.kind !== 'comparable' || m.delta !== 0 || m.renamed
			);
			const itemsMoved =
				section.items.kind === 'movements' &&
				(section.items.entered.length > 0 || section.items.left.length > 0);
			return metricMoved || itemsMoved;
		}
	}
}

/**
 * Compare deux rapports PUBLIÉS.
 *
 * `base` est le point le plus ANCIEN, `head` le plus récent — l'ordre est vérifié, jamais
 * corrigé en silence : inverser les deux inverserait le signe de chaque écart, et une fonction
 * qui se réordonne toute seule rendrait ce bug invisible.
 *
 * Le résultat est une union : « il n'y a rien à comparer » est un ÉTAT, pas une liste vide.
 */
export function compareReports(input: {
	base: ComparisonPoint;
	head: ComparisonPoint;
}): ReportComparison {
	const { base, head } = input;
	const order = comparePoints(base, head);
	if (order === 0) {
		return {
			kind: 'unavailable',
			reason: 'same_point',
			note: 'les deux points désignent le même rapport (même créneau, même révision).'
		};
	}
	if (order > 0) {
		return {
			kind: 'unavailable',
			reason: 'not_ordered',
			note: 'le point de référence est POSTÉRIEUR au point courant : la comparaison n’est pas faite plutôt que rendue à l’envers.'
		};
	}

	// ⭐ Un détail purgé n'est pas un rapport vide (REP-004 lot 2). Le comparer comme tel
	// produirait douze sections « hors plan » et annoncerait un changement de TEMPLATE là où il
	// n'y a eu qu'une rétention. Le refus NOMME le côté et son archive : la question « qu'est-ce
	// qui a changé ? » reste répondable, ailleurs.
	if (base.detail.kind === 'purged' || head.detail.kind === 'purged') {
		const sides: string[] = [];
		if (base.detail.kind === 'purged') {
			sides.push(
				`de référence (${base.periodSlot} rév. ${base.revision}) — archivé dans « ${base.detail.archiveRef} »`
			);
		}
		if (head.detail.kind === 'purged') {
			sides.push(
				`courant (${head.periodSlot} rév. ${head.revision}) — archivé dans « ${head.detail.archiveRef} »`
			);
		}
		return {
			kind: 'unavailable',
			reason: 'detail_purged',
			note: `le détail d’un des deux rapports a été retiré par la rétention : ${sides.join(' · ')}. Rien n’est comparé plutôt que de comparer contre un rapport vide, qui annoncerait un changement de template.`
		};
	}

	const baseReport = base.detail.report;
	const headReport = head.detail.report;

	const axis: ComparisonAxis = base.periodSlot === head.periodSlot ? 'revision' : 'slot';

	const blocks: ComparisonBlock[] = [];
	if (base.reportSchemaVersion !== head.reportSchemaVersion) {
		blocks.push({
			reason: 'schema_changed',
			note: `schéma de rapport ${base.reportSchemaVersion} → ${head.reportSchemaVersion} : les métriques ne sont pas garanties désigner la même chose, aucun écart n’est chiffré.`
		});
	}
	if (baseReport.period.windowDays !== headReport.period.windowDays) {
		blocks.push({
			reason: 'window_mismatch',
			note: `périodes de longueurs différentes (${baseReport.period.windowDays} j → ${headReport.period.windowDays} j) : un écart mesurerait la fenêtre, pas le parc.`
		});
	}

	const baseByKey = new Map(baseReport.sections.map((s) => [s.key, s]));
	const headByKey = new Map(headReport.sections.map((s) => [s.key, s]));

	// L'ordre est celui du rapport COURANT (son propre plan, jamais `SECTION_ORDER`), suivi de
	// ce que seul l'ancien portait — même discipline que `buildReportView`.
	const sections: SectionComparison[] = [];
	for (const headSection of headReport.sections) {
		const baseSection = baseByKey.get(headSection.key);
		if (!baseSection) {
			sections.push({
				key: headSection.key,
				title: headSection.title,
				kind: 'only_in_head',
				note: 'section absente du plan du rapport de référence : le template a changé entre les deux publications.'
			});
			continue;
		}
		sections.push(compareSection({ base: baseSection, head: headSection, blocks }));
	}
	for (const baseSection of baseReport.sections) {
		if (headByKey.has(baseSection.key)) continue;
		sections.push({
			key: baseSection.key,
			title: baseSection.title,
			kind: 'only_in_base',
			note: 'section présente dans le rapport de référence et absente du plan courant : le template a changé entre les deux publications.'
		});
	}

	return {
		kind: 'available',
		axis,
		base: {
			periodSlot: base.periodSlot,
			revision: base.revision,
			reportSchemaVersion: base.reportSchemaVersion,
			periodLabel: baseReport.period.label
		},
		head: {
			periodSlot: head.periodSlot,
			revision: head.revision,
			reportSchemaVersion: head.reportSchemaVersion,
			periodLabel: headReport.period.label
		},
		blocks,
		sections,
		summary: buildSummary(sections, blocks)
	};
}
