/**
 * DASH-003 — Cockpit projet : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), même paire que `home-state.ts` / `home.ts` :
 * `project-cockpit.ts` lit la base, ici on décide **ce qu'un panneau a le droit de dire**.
 *
 * Les trois acceptations DASH-003 vivent ici :
 *
 *   1. « chaque métrique affiche période, fraîcheur et source » → **`ProvenanceTrio`**. Ce n'est
 *      pas une décoration : un chiffre sans période est incomparable, sans fraîcheur il peut
 *      dater de trois semaines sans le dire, et sans source personne ne peut aller vérifier. Le
 *      type est **obligatoire** dans `Panel` — un panneau ne peut pas exister sans son trio.
 *   2. « un provider désactivé n'est pas présenté comme une erreur » → **`derivePanelState`**.
 *      `inactive` (non branché) et `never` (branché, jamais collecté) sont des états À PART de
 *      `broken` : ils demandent des gestes différents (brancher / attendre / réparer), et les
 *      confondre ferait crier six projets pour un Plausible qu'on n'utilise pas encore.
 *   3. « les décisions passées sont accessibles depuis la timeline » → **`buildTimeline`**, qui
 *      mélange trois natures d'entrée dans un ordre **total** et dit ce qu'il coupe.
 *
 * ⚠️ Ce module ne classe PAS la santé du projet : elle vient de `classifyProject` (`home-state`),
 * telle quelle. Deux définitions de « projet à risque » divergeraient au premier seuil modifié,
 * et le même projet serait noté différemment sur l'accueil et sur son cockpit.
 */
import type { Freshness } from './home-state.js';
import type { IndexedClass } from './collectors/url-inspection-state.js';

// ── Provenance : période, fraîcheur, source ─────────────────────────

export interface ProvenancePeriod {
	/** Borne basse RÉELLE de la donnée affichée (`YYYY-MM-DD`). */
	start: string;
	/** Borne haute réelle. */
	end: string;
	/** Libellé prêt à rendre — l'écran ne recalcule rien. */
	label: string;
}

export interface ProvenanceTrio {
	/**
	 * La période **effectivement couverte par la donnée**, pas celle demandée par le filtre.
	 * `null` quand il n'y a aucune donnée — et c'est alors un fait, jamais une plage vide
	 * qu'on lirait comme « rien ne s'est passé sur ces 28 jours ».
	 */
	period: ProvenancePeriod | null;
	freshness: Freshness;
	/** La table canon d'où sort le chiffre. Nommée, pour que « aller vérifier » soit possible. */
	source: string;
}

/** `2026-06-29 → 2026-07-20`. Une seule écriture du libellé, partagée par tous les panneaux. */
export function periodLabel(start: string, end: string): string {
	return `${start} → ${end}`;
}

export function makePeriod(
	start: string | null | undefined,
	end: string | null | undefined
): ProvenancePeriod | null {
	if (!start || !end) return null;
	return { start, end, label: periodLabel(start, end) };
}

// ── État d'un panneau : « non branché » n'est pas « cassé » ──────────

export type PanelState = 'ok' | 'stale' | 'never' | 'inactive' | 'broken';

/** Ce que `project_integrations` sait d'un provider (sous-ensemble de `IntegrationSummary`). */
export interface PanelIntegration {
	provider: string;
	enabled: boolean;
	/** `inactive | active | error | revoked`. */
	status: string;
	/** `healthy | degraded | down | unknown`. */
	healthStatus: string;
	lastErrorCode: string | null;
	/** Dernier succès déclaré — la fraîcheur du panneau en dérive. */
	lastSuccessAt: string | null;
}

export interface PanelVerdict {
	state: PanelState;
	/** UNE phrase qui dit pourquoi — jamais un badge muet. */
	note: string;
}

/**
 * L'état d'un panneau de domaine.
 *
 * L'ordre des règles EST la décision :
 *
 *   1. **Désactivé ⇒ `inactive`, quoi qu'il porte par ailleurs.** Une intégration qu'on a
 *      éteinte peut garder un `last_error_code` d'il y a trois mois ; l'afficher en rouge
 *      reprocherait à l'utilisateur une panne qu'il a lui-même débranchée.
 *   2. Activée mais `error`/`revoked`/`down` ⇒ `broken` — là, il y a un geste à faire.
 *   3. Sinon la FRAÎCHEUR décide : `never` (jamais collecté) est distinct de `stale` (en
 *      retard), parce que brancher et réparer ne sont pas le même geste.
 *
 * ⚠️ **`hasData` prime sur l'absence de ligne d'intégration.** Un projet peut collecter sans
 * qu'aucune ligne `project_integrations` n'existe (compte de service partagé, flux hérité) :
 * annoncer « non branché » alors que la table déborde d'observations serait un mensonge
 * vérifiable à l'écran d'à côté. Sans ligne ET sans donnée, `inactive` est la vérité.
 */
export function derivePanelState(input: {
	integration: PanelIntegration | null;
	freshness: Freshness;
	/** Y a-t-il au moins une observation dans ce domaine, quelle que soit sa date ? */
	hasData: boolean;
	/** Nom lisible du domaine, pour la phrase. */
	label: string;
	/**
	 * Le domaine dépend-il d'un flux EXTERNE qu'on peut brancher ou débrancher ?
	 *
	 * Défaut `true`. À `false` pour les domaines internes (le diagnostic lit des observations
	 * déjà payées, il n'a pas de credential) : « non branché » y serait un contresens — il n'y a
	 * rien à brancher, et l'écran enverrait vers une page de réglages qui ne propose rien.
	 */
	external?: boolean;
}): PanelVerdict {
	const i = input.integration;
	const external = input.external !== false;

	if (external && i && !i.enabled) {
		return { state: 'inactive', note: `${input.label} non branché (intégration désactivée)` };
	}
	if (external && !i && !input.hasData) {
		return { state: 'inactive', note: `${input.label} non branché (aucune intégration déclarée)` };
	}
	if (i && (i.status === 'error' || i.status === 'revoked' || i.healthStatus === 'down')) {
		const what = i.status === 'revoked' ? 'révoquée' : 'en erreur';
		return {
			state: 'broken',
			note: `intégration ${i.provider} ${what}${i.lastErrorCode ? ` (${i.lastErrorCode})` : ''}`
		};
	}
	if (!input.hasData || input.freshness.state === 'never') {
		return {
			state: 'never',
			note: external
				? `${input.label} branché, aucune collecte à ce jour`
				: `${input.label} : aucune donnée à ce jour`
		};
	}
	if (input.freshness.state === 'stale') {
		return {
			state: 'stale',
			note: `dernière collecte ${input.freshness.lastSuccessAt ?? 'inconnue'} — en retard`
		};
	}
	// Dégradé sans être cassé : la donnée arrive, on le dit sans peindre en rouge.
	if (i && i.healthStatus === 'degraded') {
		return { state: 'ok', note: `intégration ${i.provider} dégradée, la donnée arrive encore` };
	}
	return { state: 'ok', note: 'à jour' };
}

export interface Panel {
	/** Clé stable du domaine (`gsc`, `indexing`, `findings`, `proposals`). */
	key: string;
	label: string;
	state: PanelState;
	note: string;
	/** Obligatoire : un panneau sans provenance ne doit pas pouvoir exister. */
	provenance: ProvenanceTrio;
}

/** Un panneau ne s'assemble QUE par ici — c'est ce qui rend le trio non contournable. */
export function buildPanel(input: {
	key: string;
	label: string;
	verdict: PanelVerdict;
	provenance: ProvenanceTrio;
}): Panel {
	return {
		key: input.key,
		label: input.label,
		state: input.verdict.state,
		note: input.verdict.note,
		provenance: input.provenance
	};
}

/** Panneaux demandant un geste, en tête. Un `inactive` n'en demande AUCUN. */
const PANEL_RANK: Record<PanelState, number> = {
	broken: 0,
	stale: 1,
	never: 2,
	ok: 3,
	inactive: 4
};

export function rankPanels(panels: Panel[]): Panel[] {
	return [...panels].sort((a, b) => {
		const r = PANEL_RANK[a.state] - PANEL_RANK[b.state];
		return r !== 0 ? r : a.key.localeCompare(b.key);
	});
}

// ── Indexation : ce que la couverture dit, et ce qu'elle ne dit pas ──

export interface IndexationSummary {
	classes: Record<IndexedClass, number>;
	/** URLs ayant au moins une observation. */
	urlsObserved: number;
	/**
	 * Part d'URLs indexées parmi celles qui ont un verdict tranché (indexed + not_indexed).
	 * `null` si aucune — **jamais 0 %**, qui se lirait « rien n'est indexé ».
	 *
	 * `excluded` est HORS dénominateur : une page en `noindex` est une décision du site, pas
	 * un échec d'indexation (même règle qu'IDX-005, où `excluded` n'est jamais un `index_drop`).
	 */
	coverageRate: number | null;
	/** Échéances posées et non honorées à ce jour. */
	dueNow: number;
	/** La plus ancienne échéance en attente — celle qui dit depuis quand on est en retard. */
	oldestDueDate: string | null;
}

/**
 * Assemble le panneau indexation.
 *
 * ⚠️ `dueNow` vient de lignes `index_selection` **non honorées**, c'est-à-dire d'un calcul qui
 * a déjà joint `index_observations` (`loadDueSelections`). Compter la table seule dirait
 * « pages inspectées » alors qu'elle ne contient que des **intentions** — le piège nommé au
 * lot 1 d'IDX-004, et ce module est le premier lecteur de cette table.
 */
export function summarizeIndexation(input: {
	classes: Record<IndexedClass, number>;
	dueRows: readonly { dueDate: string }[];
}): IndexationSummary {
	const c = input.classes;
	const urlsObserved = c.indexed + c.not_indexed + c.excluded + c.unknown;
	const decided = c.indexed + c.not_indexed;
	const dueDates = input.dueRows.map((r) => r.dueDate).sort();
	return {
		classes: c,
		urlsObserved,
		coverageRate: decided > 0 ? c.indexed / decided : null,
		dueNow: input.dueRows.length,
		oldestDueDate: dueDates[0] ?? null
	};
}

// ── Timeline : ce que le cockpit a fait, conclu, et décidé ───────────

export type TimelineKind = 'run' | 'finding' | 'decision';

export interface TimelineEntry {
	kind: TimelineKind;
	/** Identifiant de la ligne SOURCE — c'est aussi la dernière clé de l'ordre total. */
	id: string;
	/** Horodatage au format DB, tel que lu. */
	at: string;
	/** Millisecondes epoch, ou `null` si l'horodatage est illisible. */
	atMs: number | null;
	title: string;
	detail: string | null;
	actor: string | null;
	/** Décisions seulement : le motif, obligatoire côté écriture (DASH-005). */
	reason?: string | null;
	/** Décisions seulement : le niveau d'autorisation requis (§12.1). */
	approvalLevel?: string | null;
	/** Où aller pour en savoir plus, ou `null` si aucun écran ne le montre. */
	href: string | null;
}

/** À horodatage égal, un run précède ce qu'il a produit, qui précède ce qu'on en a décidé. */
const KIND_RANK: Record<TimelineKind, number> = { run: 0, finding: 1, decision: 2 };

export interface Timeline {
	entries: TimelineEntry[];
	/** Entrées écartées par le plafond — **dites**, jamais tues. */
	truncated: number;
}

/**
 * Fusionne les trois natures en une seule liste, la plus récente d'abord.
 *
 * **Ordre TOTAL** : horodatage décroissant, puis nature, puis id. La dernière clé n'est pas
 * décorative — sans elle, deux chargements de la même page pourraient rendre deux ordres
 * différents pour des entrées du même instant (même doctrine que `compareCandidates`
 * d'IDX-004 et que l'ordre des cartes de DASH-002).
 *
 * Un horodatage illisible ne fait pas remonter l'entrée en tête : elle part à la FIN. Une
 * date cassée n'est pas une nouvelle.
 */
export function buildTimeline(entries: readonly TimelineEntry[], limit: number): Timeline {
	const sorted = [...entries].sort((a, b) => {
		if (a.atMs === null && b.atMs !== null) return 1;
		if (b.atMs === null && a.atMs !== null) return -1;
		if (a.atMs !== null && b.atMs !== null && a.atMs !== b.atMs) return b.atMs - a.atMs;
		const k = KIND_RANK[a.kind] - KIND_RANK[b.kind];
		return k !== 0 ? k : a.id.localeCompare(b.id);
	});
	const cap = Math.max(0, Math.floor(limit));
	return { entries: sorted.slice(0, cap), truncated: Math.max(0, sorted.length - cap) };
}
