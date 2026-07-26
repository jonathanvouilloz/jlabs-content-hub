/**
 * DASH-003 lot 2, chantier 2 — l'onglet Indexation : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), même paire que `project-cockpit-state.ts` /
 * `project-cockpit.ts` : `project-indexing.ts` lit la base, ici on décide **ce que l'écran a le
 * droit de dire** de quatre tickets E04 livrés sans lecteur (`IDX-001`, `IDX-002`, `IDX-004`,
 * `IDX-005`).
 *
 * Ce que ce module N'EST PAS :
 *
 *   - il **ne recalcule pas** la couverture d'indexation. `summarizeIndexation`
 *     (`project-cockpit-state.ts`) la calcule déjà pour la vue d'ensemble, et deux définitions du
 *     taux de couverture divergeraient au premier changement de dénominateur — le même projet
 *     serait alors à 82 % sur un onglet et à 74 % sur l'onglet d'à côté ;
 *   - il **ne classe pas** la santé du projet : elle vient de `classifyProject` (`home-state.ts`)
 *     via `loadHomeCockpit`, comme au lot 1.
 *
 * Ce qu'il ajoute : le détail que la vue d'ensemble résume en quatre chiffres — ce que le site
 * déclare (inventaire sitemap et son diff), où part le quota (`index_selection`), et ce que
 * l'écran peut prouver de ce qu'il affiche (chaque compteur porte le lien de son propre filtre).
 */
import type { Freshness } from './home-state.js';
import type { IndexedClass } from './collectors/url-inspection-state.js';
import {
	familyForReason,
	isExpired,
	type SelectionBucket,
	type SelectionFamily,
	type SelectionReason
} from './collectors/index-selection-state.js';
import type { InventoryDiff } from './collectors/sitemap-state.js';

// ── Répartition par classe : le compteur ET son lien naissent ensemble ──

/**
 * L'ordre d'affichage des classes. `indexed` en tête (l'état attendu), `unknown` en queue : une
 * classe qu'on ne sait pas nommer ne prend pas la place de celles qui demandent un geste.
 */
export const INDEX_CLASS_ORDER: readonly IndexedClass[] = [
	'indexed',
	'not_indexed',
	'excluded',
	'unknown'
] as const;

const CLASS_LABEL: Record<IndexedClass, string> = {
	indexed: 'Indexées',
	not_indexed: 'Non indexées',
	excluded: 'Exclues',
	unknown: 'Indéterminées'
};

/**
 * Ce que chaque classe veut dire, en une phrase — jamais un badge muet.
 *
 * `excluded` porte la sienne parce qu'elle est la plus facile à mal lire : ce n'est pas un échec,
 * c'est une décision du site (`noindex`), et c'est exactement pour ça qu'elle sort du dénominateur
 * de couverture.
 */
const CLASS_NOTE: Record<IndexedClass, string> = {
	indexed: 'Présentes dans l’index Google.',
	not_indexed: 'Connues de Google, absentes de l’index.',
	excluded: 'Exclues par le site (noindex, canonical) — une décision, pas un échec.',
	unknown: 'Verdict illisible ou absent — jamais compté comme « non indexée ».'
};

export interface ClassFilter {
	/** `null` = « toutes », l'entrée sans filtre. */
	value: IndexedClass | null;
	label: string;
	note: string | null;
	count: number;
	/** L'URL qui reproduit EXACTEMENT ce que `count` a compté. */
	href: string;
	active: boolean;
}

/**
 * Les filtres de classe — **le compteur et son lien sortent du même descripteur**.
 *
 * C'est la règle de DASH-002, et elle n'est pas cosmétique : un compteur sans liste capable de le
 * reproduire n'est pas un compteur, c'est un chiffre. En les fabriquant ensemble, il devient
 * impossible d'afficher « 34 non indexées » au-dessus d'un lien qui en montrerait 12.
 *
 * Le filtre vit dans la QUERY STRING (`?class=`), donc il est reproductible et partageable — un
 * état de filtre gardé en mémoire du composant ne se recolle pas dans un message.
 */
export function buildClassFilters(input: {
	classes: Record<IndexedClass, number>;
	projectSlug: string;
	activeClass: IndexedClass | null;
}): ClassFilter[] {
	const base = `/projects/${input.projectSlug}/indexing`;
	const total = INDEX_CLASS_ORDER.reduce((sum, c) => sum + input.classes[c], 0);

	return [
		{
			value: null,
			label: 'Toutes',
			note: null,
			count: total,
			href: base,
			active: input.activeClass === null
		},
		...INDEX_CLASS_ORDER.map((c) => ({
			value: c,
			label: CLASS_LABEL[c],
			note: CLASS_NOTE[c],
			count: input.classes[c],
			href: `${base}?class=${c}`,
			active: input.activeClass === c
		}))
	];
}

/** Une valeur de `?class=` hors vocabulaire est ÉCARTÉE, jamais réinterprétée. */
export function normalizeIndexClass(raw: string | null | undefined): IndexedClass | null {
	const s = (raw ?? '').trim();
	return (INDEX_CLASS_ORDER as readonly string[]).includes(s) ? (s as IndexedClass) : null;
}

// ── Fraîcheur : `null` est un état, jamais un zéro ───────────────────

/**
 * La phrase de fraîcheur de l'inspection.
 *
 * `never` n'est pas « il y a 0 heure » : une page jamais inspectée et une page inspectée à
 * l'instant demandent deux gestes opposés. `deriveFreshness` garde déjà `ageHours: null` dans ce
 * cas — ici on refuse simplement de le rendre en « 0 h ».
 *
 * Le seuil de retard est celui d'`INDEX_STALE_AFTER_HOURS` (15 j), pas celui de GSC (10 j) :
 * l'inspection est un ÉCHANTILLON (IDX-004), une page peut légitimement n'être revue que tous les
 * `sampleIntervalDays`. Le rappeler dans la phrase évite qu'un retard normal se lise comme une
 * panne.
 */
export function describeInspectionFreshness(freshness: Freshness): string {
	if (freshness.state === 'never' || freshness.ageHours === null) {
		return 'Jamais inspecté — aucune observation d’indexation à ce jour.';
	}
	const days = Math.floor(freshness.ageHours / 24);
	const age = days >= 1 ? `${days} j` : `${Math.floor(freshness.ageHours)} h`;
	return freshness.state === 'stale'
		? `Dernière inspection il y a ${age} — au-delà du cycle d’échantillon attendu.`
		: `Dernière inspection il y a ${age}.`;
}

// ── Inventaire sitemap : ce que le SITE déclare ──────────────────────

export interface SitemapSummary {
	/** Date du dernier inventaire, ou `null` — **jamais collecté**, pas « inventaire vide ». */
	date: string | null;
	/** URLs déclarées, alternates exclues (une alternate n'est pas une page). */
	urls: number;
	/** Entrées `<xhtml:link rel="alternate">` — comptées à part, jamais dans `urls`. */
	alternates: number;
	/** Fichiers sitemap parcourus au dernier inventaire. */
	files: number;
	/** Fichiers ayant remonté au moins une erreur — un fait interrogeable (IDX-001). */
	filesWithErrors: number;
	previousDate: string | null;
	/**
	 * Le diff contre l'inventaire précédent. `null` quand il n'y a pas DEUX snapshots à comparer
	 * — et c'est un fait distinct d'un diff vide, qui dirait « rien n'a bougé ».
	 */
	diff: InventoryDiff | null;
	note: string;
}

/**
 * Résume l'inventaire sitemap et son diff.
 *
 * ⚠️ **Un seul snapshot ne produit pas un diff vide.** Renvoyer `{added: [], removed: []}` pour un
 * premier inventaire ferait lire « rien n'a changé » là où la vérité est « il n'y a rien à quoi
 * comparer ». Les deux se rendent différemment à l'écran, donc ils se distinguent ici.
 *
 * ⚠️ **`removed` est un constat, jamais une action.** IDX-001 pose qu'aucune URL retirée du
 * sitemap n'est désindexée : l'écran le montre, il ne propose rien.
 */
export function summarizeSitemap(input: {
	date: string | null;
	rows: readonly { isAlternate: boolean }[];
	previousDate: string | null;
	diff: InventoryDiff | null;
	files: number;
	filesWithErrors: number;
}): SitemapSummary {
	const alternates = input.rows.filter((r) => r.isAlternate).length;
	const urls = input.rows.length - alternates;

	let note: string;
	if (!input.date) {
		note = 'Aucun inventaire sitemap collecté à ce jour.';
	} else if (!input.diff || !input.previousDate) {
		note = 'Premier inventaire — aucun snapshot antérieur auquel le comparer.';
	} else {
		const d = input.diff;
		note =
			d.added.length + d.removed.length + d.changed.length === 0
				? `Identique à l’inventaire du ${input.previousDate}.`
				: `${d.added.length} ajoutée(s), ${d.removed.length} retirée(s), ${d.changed.length} modifiée(s) depuis le ${input.previousDate}.`;
	}

	return {
		date: input.date,
		urls,
		alternates,
		files: input.files,
		filesWithErrors: input.filesWithErrors,
		previousDate: input.previousDate,
		diff: input.date && input.previousDate ? input.diff : null,
		note
	};
}

// ── Quota d'inspection : où part la dépense ─────────────────────────

export interface SelectionGroup<K extends string> {
	key: K;
	label: string;
	count: number;
}

const FAMILY_LABEL: Record<SelectionFamily, string> = {
	urgent: 'Urgent (servi en premier, sans plafond)',
	routine: 'Routine (nouveautés, changements, pages stratégiques)',
	sample: 'Échantillon (rotation de fond, plafonné)'
};

const BUCKET_LABEL: Record<SelectionBucket, string> = {
	priority: 'Priorité',
	sample: 'Échantillon'
};

export interface QuotaSummary {
	/**
	 * Intentions dues et non honorées. Vient de `loadDueSelections`, qui a DÉJÀ joint
	 * `index_observations` : `index_selection` seule ne contient que des intentions, la compter
	 * dirait « pages inspectées » (le piège nommé au lot 1 d'IDX-004).
	 */
	dueNow: number;
	oldestDueDate: string | null;
	/**
	 * Échéances dues depuis plus de `maxAgeDays` — **abandonnées, et dites**. Les taire ferait
	 * croire à une file qui se vide alors qu'elle se périme.
	 */
	expired: number;
	/**
	 * Lignes dont la `reason` n'appartient plus au vocabulaire (écrites par une version future).
	 * `loadDueSelections` les ÉCARTE et les compte ; l'écran les dit. Deviner une raison serait
	 * inventer un diagnostic.
	 */
	unreadable: number;
	byFamily: SelectionGroup<SelectionFamily>[];
	byBucket: SelectionGroup<SelectionBucket>[];
	/**
	 * Observations d'indexation écrites aujourd'hui, tous projets confondus.
	 *
	 * ⚠️ **C'est une borne INFÉRIEURE de la dépense réelle** : ce compte ne voit ni les appels
	 * échoués, ni les réponses illisibles, ni ceux du skill `/seo-index-diagnose` et de la route
	 * legacy `seo-data`, qui tapent le MÊME service account.
	 */
	poolUsedToday: number;
	poolTotal: number;
	dailyBudgetPerProject: number;
	/** La phrase du pool. Toujours « au plus N », **jamais** « il reste N ». */
	poolNote: string;
}

export function summarizeQuota(input: {
	/** Les deux champs que `summarizeIndexation` calcule déjà — repris, jamais recalculés. */
	dueNow: number;
	oldestDueDate: string | null;
	dueRows: readonly { dueDate: string; reason: SelectionReason; bucket: SelectionBucket }[];
	unreadable: number;
	today: string;
	maxAgeDays: number;
	poolUsedToday: number;
	poolTotal: number;
	dailyBudgetPerProject: number;
}): QuotaSummary {
	const families = new Map<SelectionFamily, number>();
	const buckets = new Map<SelectionBucket, number>();
	let expired = 0;

	for (const row of input.dueRows) {
		const family = familyForReason(row.reason);
		families.set(family, (families.get(family) ?? 0) + 1);
		buckets.set(row.bucket, (buckets.get(row.bucket) ?? 0) + 1);
		if (isExpired({ dueDate: row.dueDate, today: input.today, maxAgeDays: input.maxAgeDays })) {
			expired += 1;
		}
	}

	const order: SelectionFamily[] = ['urgent', 'routine', 'sample'];
	const bucketOrder: SelectionBucket[] = ['priority', 'sample'];

	// « au plus », et le reste de la phrase dit POURQUOI : sans la raison, un lecteur corrigerait
	// mentalement en « il reste 766 » à la première soustraction.
	const remaining = Math.max(0, input.poolTotal - input.poolUsedToday);
	const poolNote =
		`Au plus ${remaining} inspection(s) encore disponibles aujourd’hui sur ${input.poolTotal} ` +
		`— borne prudentielle : les appels échoués et ceux des outils hors cockpit tapent le même compte sans être comptés ici.`;

	return {
		dueNow: input.dueNow,
		oldestDueDate: input.oldestDueDate,
		expired,
		unreadable: input.unreadable,
		byFamily: order
			.filter((f) => (families.get(f) ?? 0) > 0)
			.map((f) => ({ key: f, label: FAMILY_LABEL[f], count: families.get(f) ?? 0 })),
		byBucket: bucketOrder
			.filter((b) => (buckets.get(b) ?? 0) > 0)
			.map((b) => ({ key: b, label: BUCKET_LABEL[b], count: buckets.get(b) ?? 0 })),
		poolUsedToday: input.poolUsedToday,
		poolTotal: input.poolTotal,
		dailyBudgetPerProject: input.dailyBudgetPerProject,
		poolNote
	};
}

// ── Une URL : ce que l'écran a le droit de conclure de son canonical ──

export type CanonicalVerdict = 'agree' | 'mismatch' | 'incomparable';

/**
 * `canonicalMismatch: null` veut dire **incomparable** (l'un des deux canonicals manque), pas
 * « ils sont d'accord ». Les confondre annoncerait un accord que personne n'a constaté — et sur
 * la seule colonne dont le détecteur `canonical_conflict` dépendra.
 */
export function describeCanonical(mismatch: boolean | null): {
	verdict: CanonicalVerdict;
	label: string;
} {
	if (mismatch === null) {
		return { verdict: 'incomparable', label: 'Incomparable' };
	}
	return mismatch
		? { verdict: 'mismatch', label: 'Désaccord Google / site' }
		: { verdict: 'agree', label: 'Accord' };
}
