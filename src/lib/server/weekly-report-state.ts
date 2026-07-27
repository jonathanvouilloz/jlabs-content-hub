/**
 * REP-001 — Rapport hebdomadaire interne : le MODÈLE (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), même paire que `home-state.ts` / `home.ts` :
 * `weekly-report.ts` lit la base, ici on décide **ce que le rapport a le droit de dire**.
 *
 * Les trois acceptations REP-001 vivent ici :
 *
 *   1. « un rapport peut être généré sans LLM » → **`buildWeeklyReport`** produit un objet
 *      JSON complet et **versionné** (`REPORT_SCHEMA_VERSION`), et **`renderWeeklyReportText`
 *      ne prend que cet objet en paramètre**. Ce n'est pas une commodité : c'est la seule
 *      façon de garantir que le texte ne contient rien que le JSON ne porte. Un rendu qui
 *      relirait la base pourrait dire une chose que la synthèse agentique (REP-002) ne verrait
 *      jamais, et personne ne saurait laquelle des deux fait foi.
 *   2. « un provider optionnel absent apparaît comme absent, pas comme zéro » →
 *      **`Availability<T>`** et **`deriveAvailability`**. Une section absente n'a **pas de
 *      compteur du tout** : il n'existe aucun chemin de code qui écrive `0` pour un provider
 *      non branché, parce que la donnée n'a pas de place où loger.
 *   3. « chaque item renvoie au finding ou à l'observation source » → **`ReportSource`**,
 *      **obligatoire** sur `ReportItem`. Un item sans source ne peut pas être construit.
 *
 * ⚠️ Ce module ne classe PAS la santé des projets : elle arrive déjà calculée par
 * `classifyProject` (`home-state`). Deux définitions de « projet à risque » divergeraient au
 * premier seuil modifié, et le rapport du lundi contredirait l'accueil qu'il est censé résumer.
 */
import type { CostSummary, Counter, PortfolioHealth, ProjectCard } from './home-state.js';

/**
 * Version du SCHÉMA du rapport, pas du contenu.
 *
 * Elle est portée par le JSON parce que ce JSON va être **stocké** (REP-004), **relu par un
 * agent** (REP-002) et **rendu au client** (REP-005) : trois consommateurs qui n'évolueront
 * pas en même temps. Un rapport archivé sans numéro de schéma est un rapport qu'on ne saura
 * plus lire le jour où une section change de forme.
 */
export const REPORT_SCHEMA_VERSION = 1;

// ── Absence : trois façons de n'avoir rien à dire, aucune n'est zéro ──

/**
 * Pourquoi une section ne dit rien. Les trois demandent des gestes DIFFÉRENTS, et les
 * confondre est exactement l'erreur que l'acceptation interdit :
 *
 *   - `not_wired` — aucun provider déclaré. Le geste est « brancher ». Écrire `0 visite`
 *     ici annoncerait un site sans trafic là où la vérité est qu'on ne le mesure pas.
 *   - `never_collected` — branché, rien n'est encore arrivé. Le geste est « attendre ou
 *     réparer la collecte », pas « brancher ».
 *   - `not_examined` — la donnée est là, mais **aucun détecteur n'a jamais tourné**. Le geste
 *     est « lancer le diagnostic ». C'est la règle DASH-002 (« jamais regardé ≠ rien à
 *     signaler ») portée jusqu'au rapport : une section de findings vide sur un parc jamais
 *     diagnostiqué est une page blanche, pas un bulletin de santé.
 */
export type AbsenceReason = 'not_wired' | 'never_collected' | 'not_examined';

export type Availability<T> =
	| { available: true; data: T }
	| { available: false; reason: AbsenceReason; detail: string };

export function present<T>(data: T): Availability<T> {
	return { available: true, data };
}

export function absent<T>(reason: AbsenceReason, detail: string): Availability<T> {
	return { available: false, reason, detail };
}

/**
 * Une section a-t-elle le droit de parler ?
 *
 * ⚠️ **`hasData` prime sur l'absence d'intégration déclarée** — même règle que
 * `derivePanelState` (DASH-003) : un projet peut collecter sans ligne `project_integrations`
 * (compte de service partagé, flux hérité), et annoncer « non branché » au-dessus de milliers
 * d'observations serait un mensonge vérifiable à l'écran d'à côté.
 *
 * Et ce n'est PAS `derivePanelState` réutilisé, volontairement : ce dernier répond à « ce
 * panneau demande-t-il un geste ? » (d'où `stale` et `broken`), celui-ci à « cette section
 * a-t-elle de quoi parler ? ». Une collecte en retard **a** de la donnée à rapporter : la
 * fusionner avec `broken` ferait taire une section qui a des faits à dire.
 */
export function deriveAvailability<T>(input: {
	/** Une intégration est-elle DÉCLARÉE et activée pour ce domaine ? */
	wired: boolean;
	/** Existe-t-il au moins une donnée, quelle que soit sa date ? */
	hasData: boolean;
	data: T;
	/** Nom du domaine, pour la phrase d'absence. */
	label: string;
}): Availability<T> {
	if (input.hasData) return present(input.data);
	if (!input.wired) {
		return absent(
			'not_wired',
			`${input.label} : aucun provider branché — non mesuré, ce qui n'est pas la même chose que zéro`
		);
	}
	return absent('never_collected', `${input.label} : branché, aucune donnée collectée à ce jour`);
}

// ── Ce qu'un item désigne : sa source, toujours ─────────────────────

/**
 * D'où vient un item, et où aller le vérifier.
 *
 * **Obligatoire** sur `ReportItem` : c'est l'acceptation « chaque item renvoie au finding ou
 * à l'observation source » rendue impossible à oublier. Un rapport dont une ligne ne se
 * remonte pas jusqu'à sa preuve est un rapport qu'on ne peut pas contester — donc qu'on ne
 * peut pas croire.
 *
 * `href` peut être `null` sur une source `observation` : certaines tables n'ont aucun écran
 * qui les liste (même doctrine que `counterHref`, où un compteur sans liste cohérente reste
 * un chiffre plutôt que de pointer vers un autre ensemble). La table, elle, est TOUJOURS
 * nommée : « aller vérifier » reste possible, à défaut d'être cliquable.
 */
export type ReportSource =
	| { kind: 'finding'; id: string; href: string }
	| { kind: 'proposal'; id: string; href: string }
	| { kind: 'project'; slug: string; href: string }
	| { kind: 'observation'; table: string; href: string | null };

export function findingSource(id: string): ReportSource {
	return { kind: 'finding', id, href: `/inbox/findings/${id}` };
}

export function proposalSource(id: string): ReportSource {
	return { kind: 'proposal', id, href: `/inbox/proposals/${id}` };
}

export function projectSource(slug: string): ReportSource {
	return { kind: 'project', slug, href: `/projects/${slug}` };
}

export function observationSource(table: string, href: string | null = null): ReportSource {
	return { kind: 'observation', table, href };
}

/** Clé d'ordre d'une source — la DERNIÈRE clé de tri, celle qui rend l'ordre total. */
function sourceKey(source: ReportSource): string {
	switch (source.kind) {
		case 'finding':
		case 'proposal':
			return source.id;
		case 'project':
			return source.slug;
		case 'observation':
			return source.table;
	}
}

// ── Les briques d'une section ───────────────────────────────────────

export interface ReportItem {
	/** Ce qu'on lit en premier — jamais un identifiant. */
	label: string;
	/** Le détail chiffré ou qualifié, ou `null` s'il n'y a rien à ajouter. */
	detail: string | null;
	/** Le projet porteur : un rapport cross-projet sans cette colonne ne se lit pas. */
	projectSlug: string | null;
	/**
	 * Le nombre qui a décidé de la place de l'item dans la liste. Affiché, pas seulement
	 * utilisé : un tri dont le critère reste caché se lit comme un ordre arbitraire.
	 */
	rank: number;
	source: ReportSource;
}

export interface ReportMetric {
	label: string;
	/**
	 * Valeur BRUTE quand il y en a une. REP-002 et REP-004 compareront des nombres d'une
	 * semaine à l'autre — pas des libellés formatés, qu'il faudrait re-parser.
	 */
	value: number | null;
	/** Le même fait, écrit. Le rendu texte ne formate rien : il recopie. */
	display: string;
	/** `null` quand aucune liste ne reproduit exactement ce chiffre (doctrine `counterHref`). */
	source: ReportSource | null;
}

/**
 * Un projet dont la section ne peut RIEN dire, alors qu'elle parle des autres.
 *
 * ⭐ C'est la pièce qui empêche une liste vide de se lire « rien à signaler ». Une section de
 * findings à 0 item sur un parc dont deux projets n'ont jamais été diagnostiqués n'annonce
 * pas une semaine calme : elle annonce deux angles morts et une semaine calme sur le reste.
 */
export interface BlindSpot {
	projectSlug: string;
	reason: 'never_examined' | 'partially_examined' | 'paused';
	/** UNE phrase qui dit ce qui manque — jamais un badge muet. */
	note: string;
}

export interface SectionBody {
	/** Les chiffres de la section, dans un ordre fixé par le constructeur. */
	metrics: ReportMetric[];
	/** Les lignes, déjà triées (ordre TOTAL) et déjà plafonnées. */
	items: ReportItem[];
	/** Items écartés par le plafond — **dits**, jamais tus (doctrine `buildTimeline`). */
	truncated: number;
	/** Ce dont la section ne peut pas parler. Vide = elle couvre tout son périmètre. */
	blindSpots: BlindSpot[];
	/** Une réserve à porter au lecteur, ou `null`. */
	note: string | null;
}

export type SectionKey =
	| 'executive_summary'
	| 'projects_needing_action'
	| 'findings_new'
	| 'findings_aggravated'
	| 'findings_resolved'
	| 'opportunities'
	| 'indexation'
	| 'traffic_conversions'
	| 'reviews'
	| 'proposed_actions'
	| 'approvals_requested'
	| 'automation_health';

/**
 * Les douze sections de SPEC §14.1, **dans l'ordre de la spec**.
 *
 * L'ordre vit dans le tableau `sections` du rapport, pas dans le moteur de rendu : le JSON
 * archivé porte donc son propre plan, et un rapport de 2026 se relira dans son ordre d'origine
 * même si la spec en change. C'est ce qui rend REP-004 (historique) possible sans versionner
 * le renderer.
 */
export const SECTION_TITLES: Record<SectionKey, string> = {
	executive_summary: 'Résumé exécutif',
	projects_needing_action: 'Projets nécessitant une intervention',
	findings_new: 'Nouveaux findings',
	findings_aggravated: 'Findings aggravés',
	findings_resolved: 'Findings résolus',
	opportunities: 'Opportunités à fort impact',
	indexation: 'Indexation',
	traffic_conversions: 'Trafic et conversions',
	reviews: 'Avis Google',
	proposed_actions: 'Actions proposées',
	approvals_requested: 'Validations demandées',
	automation_health: 'Santé des automatisations et données manquantes'
};

export const SECTION_ORDER: SectionKey[] = [
	'executive_summary',
	'projects_needing_action',
	'findings_new',
	'findings_aggravated',
	'findings_resolved',
	'opportunities',
	'indexation',
	'traffic_conversions',
	'reviews',
	'proposed_actions',
	'approvals_requested',
	'automation_health'
];

export interface ReportSection {
	key: SectionKey;
	title: string;
	/** Ce que la section dit — ou POURQUOI elle ne dit rien. Jamais un zéro par défaut. */
	body: Availability<SectionBody>;
}

// ── Le rapport ──────────────────────────────────────────────────────

export interface ReportPeriod {
	/** Bornes RÉELLES de ce qui a été compté, au format DB. */
	sinceDb: string;
	untilDb: string;
	windowDays: number;
	label: string;
}

export interface WeeklyReport {
	schemaVersion: number;
	/** Passé par l'appelant — JAMAIS `new Date()` ici, sinon deux appels diffèrent. */
	generatedAt: string;
	period: ReportPeriod;
	/** UNE phrase : ce qu'on lit si on ne lit qu'une ligne. */
	headline: string;
	/**
	 * Les angles morts du PARC, une seule fois.
	 *
	 * Ils restent aussi dans chaque section (une section extraite seule doit rester lisible avec
	 * sa réserve, ce dont REP-002 aura besoin) — mais le RENDU TEXTE ne les répète pas : à neuf
	 * projets et douze sections, la même liste s'imprimait 108 fois et noyait le rapport. Une
	 * projection a le droit de compresser ce que le JSON répète ; elle n'a jamais le droit
	 * d'ajouter.
	 */
	coverage: BlindSpot[];
	sections: ReportSection[];
}

// ── Entrées (données BRUTES : le jugement se fait ici, pas chez l'appelant) ──

export interface ReportFindingInput {
	id: string;
	projectSlug: string | null;
	type: string;
	title: string;
	severity: string;
	priorityScore: number;
	status: string;
	occurrenceCount: number;
	lastSeenAt: string;
}

export interface ReportProposalInput {
	id: string;
	projectSlug: string | null;
	actionType: string;
	target: string | null;
	status: string;
	riskLevel: string;
	requiredApprovalLevel: string;
	createdAt: string;
}

/**
 * Un ensemble à rapporter : son TOTAL et les lignes qu'on a lues.
 *
 * ⭐ Les deux sont séparés parce qu'ils ne viennent pas du même endroit. Le total est un
 * `count(*)` en base ; les lignes sont une page bornée. Dériver le total de `rows.length`
 * ferait annoncer « 15 nouveaux findings » sur un parc qui en a 200, simplement parce que la
 * lecture était plafonnée à 15 — un plafond de lecture deviendrait un fait, et le rapport
 * annoncerait une semaine calme parce qu'il a mal lu.
 */
export interface ReportSet<T> {
	total: number;
	rows: T[];
}

export interface ReportIndexationInput {
	projectSlug: string;
	/** URLs ayant au moins une observation d'indexation. */
	urlsObserved: number;
	indexed: number;
	notIndexed: number;
	/** Part d'indexées parmi les verdicts tranchés — `null`, jamais 0 %, quand il n'y en a pas. */
	coverageRate: number | null;
	/** Échéances d'inspection posées et non honorées. */
	dueNow: number;
	/** Une intégration d'indexation est-elle déclarée et activée ? */
	wired: boolean;
}

export interface ReportReviewsInput {
	projectSlug: string;
	unanswered: number;
	/** Avis reçus dans la période. */
	received: number;
	/** Avis 1–2 étoiles reçus dans la période (§14.3 : notification immédiate). */
	negative: number;
	wired: boolean;
}

export interface ReportTrafficInput {
	projectSlug: string;
	visits: number;
	conversions: number;
	wired: boolean;
}

export interface WeeklyReportInput {
	generatedAt: string;
	sinceDb: string;
	untilDb: string;
	windowDays: number;
	/** La santé du portefeuille, **telle que l'accueil la calcule**. */
	portfolio: PortfolioHealth;
	/** Les cartes déjà classées et triées par `home.ts`. */
	projects: ProjectCard[];
	/**
	 * Les compteurs cross-projet de l'accueil, avec leurs liens déjà résolus.
	 *
	 * ⚠️ On prend les COMPTEURS et pas `HomeCockpit.activity` : les deux portent les mêmes
	 * nombres, mais seul le compteur porte le lien qui les reproduit. Recopier l'activité brute
	 * ferait un chiffre sans liste — exactement ce que DASH-002 a refusé.
	 */
	counters: Counter[];
	findingsNew: ReportSet<ReportFindingInput>;
	findingsAggravated: ReportSet<ReportFindingInput>;
	findingsResolved: ReportSet<ReportFindingInput>;
	opportunities: ReportSet<ReportFindingInput>;
	/** Propositions CRÉÉES dans la période — ce que le cockpit a proposé. */
	proposalsCreated: ReportSet<ReportProposalInput>;
	/** Propositions en attente de décision AUJOURD'HUI — la file, pas l'activité. */
	proposalsPending: ReportSet<ReportProposalInput>;
	indexation: ReportIndexationInput[];
	reviews: ReportReviewsInput[];
	traffic: ReportTrafficInput[];
	costs: CostSummary;
	runStatusCounts: Record<string, number>;
	/** Plafond d'items par section. Au-delà, c'est un export, plus un rapport. */
	maxItemsPerSection?: number;
}

export const DEFAULT_MAX_ITEMS_PER_SECTION = 15;

// ── Tri : un ordre TOTAL, sinon deux générations diffèrent ───────────

/**
 * Rang décroissant, puis clé de source croissante.
 *
 * La seconde clé n'est pas décorative : sans elle, deux findings au même score de priorité
 * pourraient permuter d'une génération à l'autre, et deux rapports du même instant ne
 * seraient pas identiques — ce qui rendrait REP-004 (comparaison d'une semaine à l'autre)
 * ininterprétable, et le déterminisme intestable. Même discipline que `listFindings`
 * (priorité desc, puis fingerprint) et que `buildTimeline`.
 */
export function rankItems(items: readonly ReportItem[]): ReportItem[] {
	return [...items].sort((a, b) => {
		if (a.rank !== b.rank) return b.rank - a.rank;
		return sourceKey(a.source).localeCompare(sourceKey(b.source));
	});
}

/**
 * Trie puis plafonne, en DISANT ce qui a été coupé.
 *
 * `total` est le compte RÉEL de l'ensemble (celui de la base), pas la longueur du tableau
 * reçu : quand la lecture a elle-même été bornée, `truncated` doit compter ce que ni le
 * plafond d'affichage ni le plafond de lecture n'ont laissé passer. Un rapport qui tairait la
 * seconde coupure se lirait comme exhaustif.
 */
export function capItems(
	items: readonly ReportItem[],
	limit: number,
	total?: number
): { items: ReportItem[]; truncated: number } {
	const sorted = rankItems(items);
	const cap = Math.max(0, Math.floor(limit));
	const shown = sorted.slice(0, cap);
	const real = typeof total === 'number' && total > sorted.length ? total : sorted.length;
	return { items: shown, truncated: Math.max(0, real - shown.length) };
}

// ── Angles morts : ce que le diagnostic n'a pas regardé ──────────────

/**
 * Les projets dont une section de findings ne peut rien dire.
 *
 * `paused` est distinct de `never_examined` : l'un est une décision (DASH-006 : « une décision
 * n'est pas une panne »), l'autre un manque. Les afficher pareil ferait reprocher au lecteur
 * un silence qu'il a lui-même demandé.
 *
 * La couverture `partial` compte AUSSI : depuis FIND-005 le catalogue porte trois détecteurs,
 * donc un projet peut être examiné pour les opportunités et jamais pour les baisses. Dire
 * « couvert » parce qu'un détecteur sur trois a tourné annoncerait une exhaustivité fausse.
 */
export function deriveBlindSpots(cards: readonly ProjectCard[]): BlindSpot[] {
	const spots: BlindSpot[] = [];
	for (const card of cards) {
		// ⚠️ `pause.full` et non `pause` : une pause PARTIELLE laisse une partie du diagnostic
		// tourner. Annoncer « suspendu » sur un projet dont deux détecteurs sur trois passent
		// encore ferait ignorer les findings qu'il continue de produire.
		if (card.pause?.full) {
			spots.push({
				projectSlug: card.slug,
				reason: 'paused',
				note: `diagnostic suspendu (${card.pause.reason}) — le silence est une décision, pas un constat`
			});
			continue;
		}
		if (card.diagnosis.state === 'none') {
			spots.push({
				projectSlug: card.slug,
				reason: 'never_examined',
				note:
					card.diagnosis.expectedCount === 0
						? 'aucun détecteur planifié sur ce projet'
						: `aucun des ${card.diagnosis.expectedCount} détecteurs attendus n'a jamais tourné`
			});
			continue;
		}
		if (card.diagnosis.state === 'partial') {
			spots.push({
				projectSlug: card.slug,
				reason: 'partially_examined',
				note: `${card.diagnosis.ranCount}/${card.diagnosis.expectedCount} détecteurs ont tourné — manque ${card.diagnosis.neverRan.join(', ')}`
			});
			continue;
		}
		// Couverture complète, mais une pause partielle empêche son RENOUVELLEMENT. Distinct des
		// deux cas ci-dessus : ce qui a été examiné l'a été (DASH-003 : la couverture acquise ne
		// se rabaisse pas), la section est simplement en train de vieillir sur ce domaine.
		if (card.diagnosis.suspended.length > 0) {
			spots.push({
				projectSlug: card.slug,
				reason: 'paused',
				note: `couverture acquise mais plus renouvelée : ${card.diagnosis.suspended.join(', ')} suspendu(s)`
			});
		}
	}
	return spots.sort((a, b) => a.projectSlug.localeCompare(b.projectSlug));
}

/**
 * Un parc dont AUCUN projet n'a jamais été diagnostiqué n'a pas « zéro finding » : il n'a
 * jamais été examiné. Toute section de findings doit alors se déclarer absente.
 */
/** Clé d'identité d'un angle mort — projet + nature, jamais la phrase (qui peut évoluer). */
export function blindSpotKey(spot: BlindSpot): string {
	return `${spot.projectSlug}${spot.reason}`;
}

export function isNeverExamined(cards: readonly ProjectCard[]): boolean {
	if (cards.length === 0) return true;
	return cards.every((c) => c.diagnosis.ranCount === 0);
}

// ── Conversions vers des items ──────────────────────────────────────

const SEVERITY_LABELS: Record<string, string> = {
	critical: 'critique',
	high: 'élevée',
	medium: 'moyenne',
	low: 'faible',
	info: 'info'
};

export function findingItem(f: ReportFindingInput): ReportItem {
	const occurrences =
		f.occurrenceCount > 1 ? `, vu ${f.occurrenceCount} fois` : ', première occurrence';
	return {
		label: f.title,
		detail: `${f.type} · sévérité ${SEVERITY_LABELS[f.severity] ?? f.severity}${occurrences}`,
		projectSlug: f.projectSlug,
		rank: f.priorityScore,
		source: findingSource(f.id)
	};
}

/**
 * Rang d'une proposition : le RISQUE d'abord, comme `listProposals`.
 *
 * Une proposition ne porte pas de score de priorité — la trier par date en ferait remonter la
 * plus ancienne, qui n'est pas la plus lourde de conséquences. Le risque est ce dont on veut
 * parler en premier dans un rapport qu'on lit une fois par semaine.
 */
const RISK_RANK: Record<string, number> = { critical: 40, high: 30, medium: 20, low: 10 };
const LEVEL_RANK: Record<string, number> = { L4: 4, L3: 3, L2: 2, L1: 1, L0: 0 };

export function proposalItem(p: ReportProposalInput): ReportItem {
	return {
		label: `${p.actionType}${p.target ? ` → ${p.target}` : ''}`,
		detail: `risque ${p.riskLevel} · validation ${p.requiredApprovalLevel} · ${p.status}`,
		projectSlug: p.projectSlug,
		rank: (RISK_RANK[p.riskLevel] ?? 0) + (LEVEL_RANK[p.requiredApprovalLevel] ?? 0),
		source: proposalSource(p.id)
	};
}

// ── Formatage (fait UNE fois, ici — le rendu ne calcule rien) ────────

function pct(rate: number): string {
	return `${Math.round(rate * 1000) / 10} %`;
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

const STATE_LABELS: Record<string, string> = {
	ok: 'sain',
	watch: 'à surveiller',
	at_risk: 'à risque',
	broken: 'en panne',
	unknown: 'non diagnostiqué',
	paused: 'suspendu'
};

// ── Construction des sections ───────────────────────────────────────

function findingsSection(input: {
	key: SectionKey;
	findings: ReportSet<ReportFindingInput>;
	cards: readonly ProjectCard[];
	limit: number;
	metricLabel: string;
	counter: Counter | null;
	note?: string | null;
}): ReportSection {
	const title = SECTION_TITLES[input.key];
	// ⭐ Le gate d'examen passe AVANT le comptage : sur un parc jamais diagnostiqué, il n'existe
	// aucun chemin qui produise « 0 nouveau finding ».
	if (isNeverExamined(input.cards)) {
		return {
			key: input.key,
			title,
			body: absent(
				'not_examined',
				input.cards.length === 0
					? 'aucun projet actif'
					: 'aucun détecteur n’a jamais tourné sur le parc — page blanche, pas semaine calme'
			)
		};
	}
	const { items, truncated } = capItems(
		input.findings.rows.map(findingItem),
		input.limit,
		input.findings.total
	);
	return {
		key: input.key,
		title,
		body: present({
			metrics: [
				{
					label: input.metricLabel,
					value: input.findings.total,
					display: plural(input.findings.total, 'finding'),
					// Le lien vient du compteur de l'accueil : le rapport et l'écran ouvrent donc
					// littéralement la même liste, filtrée par le même `since`.
					source: input.counter?.href
						? observationSource('findings + finding_events', input.counter.href)
						: observationSource('findings + finding_events')
				}
			],
			items,
			truncated,
			blindSpots: deriveBlindSpots(input.cards),
			note: input.note ?? null
		})
	};
}

function executiveSection(input: WeeklyReportInput): ReportSection {
	const p = input.portfolio;
	const metrics: ReportMetric[] = [
		{
			label: 'projets actifs',
			value: p.total,
			display: plural(p.total, 'projet'),
			source: null
		},
		{
			label: 'état du portefeuille',
			value: null,
			display: STATE_LABELS[p.worst] ?? p.worst,
			source: null
		},
		{
			label: 'projets à traiter',
			value: p.needingAction,
			display: plural(p.needingAction, 'projet'),
			source: null
		},
		...input.counters.map((c) => ({
			label: c.label,
			value: c.count,
			display: String(c.count),
			source: c.href ? observationSource('findings + action_proposals + jobs', c.href) : null
		}))
	];
	return {
		key: 'executive_summary',
		title: SECTION_TITLES.executive_summary,
		body: present({
			metrics,
			items: [],
			truncated: 0,
			blindSpots: deriveBlindSpots(input.projects),
			// Un parc entièrement suspendu n'est pas « au vert » : `summarizePortfolio` le sait
			// déjà (`worst = 'paused'`), on le REDIT ici parce que c'est la première ligne lue.
			note:
				p.worst === 'paused'
					? 'tout le parc est suspendu : ce rapport décrit un monitoring à l’arrêt'
					: null
		})
	};
}

function projectsSection(input: WeeklyReportInput): ReportSection {
	// `needsAction` a déjà été appliqué par `home.ts` sur l'accueil ; le refaire ici avec un
	// autre prédicat créerait deux définitions du « à traiter ». On filtre donc sur l'ÉTAT
	// classé, jamais sur les compteurs.
	const cards = input.projects.filter((c) => c.state !== 'ok');
	const items: ReportItem[] = cards.map((c) => ({
		// Le nom SEUL : `card.headline` nomme déjà l'état en toutes lettres (« État inconnu — … »),
		// et l'écrire deux fois donnait « Barber Concept — non diagnostiqué — État inconnu — … ».
		label: c.name,
		detail: c.headline,
		projectSlug: c.slug,
		// L'ordre d'urgence de l'accueil est déjà celui du tableau `projects` ; on le rejoue en
		// rang décroissant pour que la section garde le MÊME ordre que l'écran.
		rank: input.projects.length - input.projects.indexOf(c),
		source: projectSource(c.slug)
	}));
	const { items: capped, truncated } = capItems(items, input.maxItemsPerSection ?? DEFAULT_MAX_ITEMS_PER_SECTION);
	return {
		key: 'projects_needing_action',
		title: SECTION_TITLES.projects_needing_action,
		body: present({
			metrics: [
				{
					label: 'projets nécessitant une intervention',
					value: cards.length,
					display: plural(cards.length, 'projet'),
					source: null
				}
			],
			items: capped,
			truncated,
			blindSpots: deriveBlindSpots(input.projects),
			note: null
		})
	};
}

function indexationSection(input: WeeklyReportInput): ReportSection {
	const rows = input.indexation;
	const observed = rows.filter((r) => r.urlsObserved > 0);
	const availability = deriveAvailability({
		wired: rows.some((r) => r.wired),
		hasData: observed.length > 0,
		data: observed,
		label: 'Indexation'
	});
	if (!availability.available) {
		return { key: 'indexation', title: SECTION_TITLES.indexation, body: availability };
	}
	const totalIndexed = observed.reduce((a, r) => a + r.indexed, 0);
	const totalDecided = observed.reduce((a, r) => a + r.indexed + r.notIndexed, 0);
	const dueNow = observed.reduce((a, r) => a + r.dueNow, 0);
	const items: ReportItem[] = observed.map((r) => ({
		label: r.projectSlug,
		detail: `${r.indexed}/${r.indexed + r.notIndexed} indexées${r.coverageRate === null ? '' : ` (${pct(r.coverageRate)})`} · ${r.dueNow} inspection(s) due(s)`,
		projectSlug: r.projectSlug,
		// Le rang est le NOMBRE de non indexées, pas le taux : dix pages perdues sur mille
		// comptent plus qu'une sur deux, et un taux ferait remonter les petits échantillons.
		rank: r.notIndexed,
		source: observationSource('index_observations', `/projects/${r.projectSlug}/indexing`)
	}));
	const { items: capped, truncated } = capItems(items, input.maxItemsPerSection ?? DEFAULT_MAX_ITEMS_PER_SECTION);
	return {
		key: 'indexation',
		title: SECTION_TITLES.indexation,
		body: present({
			metrics: [
				{
					label: 'couverture d’indexation',
					value: totalDecided > 0 ? totalIndexed / totalDecided : null,
					// `null`, jamais « 0 % » : sans verdict tranché, il n'y a pas de taux, et
					// « 0 % indexé » se lirait comme une catastrophe là où il n'y a rien du tout.
					display: totalDecided > 0 ? pct(totalIndexed / totalDecided) : 'aucun verdict tranché',
					source: observationSource('index_observations')
				},
				{
					label: 'inspections dues',
					value: dueNow,
					display: plural(dueNow, 'inspection'),
					source: observationSource('index_selection')
				}
			],
			items: capped,
			truncated,
			blindSpots: [],
			// Le périmètre de l'indexation est une SÉLECTION (IDX-004), pas le site entier.
			// Sans cette réserve, « 92 % indexées » se lirait comme une couverture de site.
			note: 'périmètre = les URLs sélectionnées pour inspection (IDX-004), jamais le site entier'
		})
	};
}

function trafficSection(input: WeeklyReportInput): ReportSection {
	const rows = input.traffic;
	const withData = rows.filter((r) => r.visits > 0 || r.conversions > 0);
	const availability = deriveAvailability({
		wired: rows.some((r) => r.wired),
		hasData: withData.length > 0,
		data: withData,
		label: 'Trafic et conversions'
	});
	if (!availability.available) {
		return {
			key: 'traffic_conversions',
			title: SECTION_TITLES.traffic_conversions,
			body: availability
		};
	}
	const visits = withData.reduce((a, r) => a + r.visits, 0);
	const conversions = withData.reduce((a, r) => a + r.conversions, 0);
	const items: ReportItem[] = withData.map((r) => ({
		label: r.projectSlug,
		detail: `${r.visits} visites · ${r.conversions} conversions`,
		projectSlug: r.projectSlug,
		rank: r.visits,
		source: observationSource('plausible_page_observations')
	}));
	const { items: capped, truncated } = capItems(items, input.maxItemsPerSection ?? DEFAULT_MAX_ITEMS_PER_SECTION);
	return {
		key: 'traffic_conversions',
		title: SECTION_TITLES.traffic_conversions,
		body: present({
			metrics: [
				{
					label: 'visites',
					value: visits,
					display: String(visits),
					source: observationSource('plausible_page_observations')
				},
				{
					label: 'conversions',
					value: conversions,
					display: String(conversions),
					source: observationSource('plausible_page_observations')
				}
			],
			items: capped,
			truncated,
			blindSpots: rows
				.filter((r) => !r.wired)
				.map((r) => ({
					projectSlug: r.projectSlug,
					reason: 'never_examined' as const,
					note: 'aucun provider analytics branché sur ce projet'
				}))
				.sort((a, b) => a.projectSlug.localeCompare(b.projectSlug)),
			note: null
		})
	};
}

function reviewsSection(input: WeeklyReportInput): ReportSection {
	const rows = input.reviews;
	const withData = rows.filter((r) => r.unanswered > 0 || r.received > 0);
	const availability = deriveAvailability({
		wired: rows.some((r) => r.wired),
		hasData: withData.length > 0,
		data: withData,
		label: 'Avis Google'
	});
	if (!availability.available) {
		return { key: 'reviews', title: SECTION_TITLES.reviews, body: availability };
	}
	const unanswered = withData.reduce((a, r) => a + r.unanswered, 0);
	const negative = withData.reduce((a, r) => a + r.negative, 0);
	const items: ReportItem[] = withData.map((r) => ({
		label: r.projectSlug,
		detail: `${r.received} reçus · ${r.unanswered} sans réponse · ${r.negative} négatifs (1–2★)`,
		projectSlug: r.projectSlug,
		// Un avis négatif pèse plus qu'un avis sans réponse : §14.3 en fait une notification
		// immédiate. Le rang le dit au lieu de le laisser au lecteur.
		rank: r.negative * 10 + r.unanswered,
		source: observationSource('gmb_reviews', `/projects/${r.projectSlug}/reviews`)
	}));
	const { items: capped, truncated } = capItems(items, input.maxItemsPerSection ?? DEFAULT_MAX_ITEMS_PER_SECTION);
	return {
		key: 'reviews',
		title: SECTION_TITLES.reviews,
		body: present({
			metrics: [
				{
					label: 'avis sans réponse',
					value: unanswered,
					display: plural(unanswered, 'avis', 'avis'),
					source: observationSource('gmb_reviews')
				},
				{
					label: 'avis négatifs de la période',
					value: negative,
					display: plural(negative, 'avis', 'avis'),
					source: observationSource('gmb_reviews')
				}
			],
			items: capped,
			truncated,
			// Volontairement vide, et ce n'est PAS l'oubli que c'est pour le trafic. Un projet
			// sans fiche Google n'est pas un angle mort : c'est un fait métier (un SaaS B2B n'en
			// a pas). Déclarer sept angles morts pour un domaine qui ne s'applique pas ferait
			// crier une section qui n'a rien à dire — l'inverse exact de ce qu'on cherche.
			blindSpots: [],
			note: 'les projets sans fiche Google ne sont pas listés : l’absence de fiche est un fait métier, pas un angle mort'
		})
	};
}

function proposalsSection(input: {
	key: 'proposed_actions' | 'approvals_requested';
	proposals: ReportSet<ReportProposalInput>;
	limit: number;
	metricLabel: string;
	note: string | null;
}): ReportSection {
	const { items, truncated } = capItems(
		input.proposals.rows.map(proposalItem),
		input.limit,
		input.proposals.total
	);
	// ⚠️ Compté sur les LIGNES LUES, pas sur le total : si la lecture a été plafonnée, ce
	// sous-compte serait faux. Le dire ainsi (« parmi les N listées ») vaut mieux qu'un chiffre
	// qui prétendrait couvrir un ensemble qu'on n'a pas vu — les L4 sont précisément ce qu'on
	// ne veut pas croire sur parole (DASH-005 : elles n'entrent jamais dans un lot).
	const l4 = input.proposals.rows.filter((p) => p.requiredApprovalLevel === 'L4').length;
	return {
		key: input.key,
		title: SECTION_TITLES[input.key],
		body: present({
			metrics: [
				{
					label: input.metricLabel,
					value: input.proposals.total,
					display: plural(input.proposals.total, 'proposition'),
					source: observationSource('action_proposals', '/inbox')
				},
				{
					label: `dont L4 (humain obligatoire), parmi les ${input.proposals.rows.length} listées`,
					value: l4,
					display: plural(l4, 'proposition'),
					source: null
				}
			],
			items,
			truncated,
			blindSpots: [],
			note: input.note
		})
	};
}

function automationSection(input: WeeklyReportInput): ReportSection {
	const runs = Object.entries(input.runStatusCounts).sort(([a], [b]) => a.localeCompare(b));
	const failed = (input.runStatusCounts.failed ?? 0) + (input.runStatusCounts.partial ?? 0);
	const jobsDead = input.projects.reduce((a, c) => a + c.jobsDead, 0);
	// « Données manquantes » = ce que l'axe PIPELINE de chaque carte a déjà conclu. Le
	// recalculer ici ferait un second verdict sur la même question, à côté de celui de l'accueil.
	const missing: ReportItem[] = input.projects
		.filter((c) => c.pipeline.state !== 'ok')
		.map((c) => ({
			label: `${c.name} — pipeline ${c.pipeline.state}`,
			detail: c.pipeline.reasons.join(' · ') || null,
			projectSlug: c.slug,
			rank: c.pipeline.state === 'broken' ? 3 : c.pipeline.state === 'degraded' ? 2 : 1,
			source: projectSource(c.slug)
		}));
	const { items, truncated } = capItems(missing, input.maxItemsPerSection ?? DEFAULT_MAX_ITEMS_PER_SECTION);
	const metrics: ReportMetric[] = [
		...runs.map(([status, n]) => ({
			label: `runs ${status}`,
			value: n,
			display: String(n),
			source: observationSource('monitoring_runs', `/automations?status=${status}`)
		})),
		{
			label: 'jobs en dead-letter',
			value: jobsDead,
			display: plural(jobsDead, 'job'),
			source: observationSource('jobs', '/jobs?status=dead')
		},
		// Les coûts arrivent DÉJÀ sous forme d'union discriminée (`summarizeCosts`) : un gate
		// inerte, pas un zéro. On le recopie tel quel plutôt que de le réduire à un nombre.
		input.costs.instrumented
			? {
					label: 'coûts de la période',
					value: Object.values(input.costs.totals).reduce((a, n) => a + n, 0),
					display: Object.entries(input.costs.totals)
						.map(([k, v]) => `${k}: ${v}`)
						.join(' · '),
					source: observationSource('monitoring_runs.cost_json')
				}
			: {
					label: 'coûts de la période',
					value: null,
					display: `non instrumentés — ${input.costs.detail}`,
					source: null
				}
	];
	return {
		key: 'automation_health',
		title: SECTION_TITLES.automation_health,
		body: present({
			metrics,
			items,
			truncated,
			blindSpots: deriveBlindSpots(input.projects),
			note: failed > 0 ? `${failed} run(s) non nominaux dans la période` : null
		})
	};
}

// ── Le constructeur ─────────────────────────────────────────────────

/**
 * Assemble le rapport hebdomadaire.
 *
 * **Déterministe par construction** : aucune horloge, aucun aléa, aucun accès réseau. Deux
 * appels sur les mêmes entrées rendent deux objets `JSON.stringify`-identiques — c'est ce qui
 * rend le rapport comparable d'une semaine à l'autre (REP-004) et vérifiable en preuve.
 */
export function buildWeeklyReport(input: WeeklyReportInput): WeeklyReport {
	const limit = input.maxItemsPerSection ?? DEFAULT_MAX_ITEMS_PER_SECTION;
	const counterBy = (label: string) => input.counters.find((c) => c.label === label) ?? null;

	const sections: ReportSection[] = [
		executiveSection(input),
		projectsSection(input),
		findingsSection({
			key: 'findings_new',
			findings: input.findingsNew,
			cards: input.projects,
			limit,
			metricLabel: 'nouveaux findings de la période',
			counter: counterBy('nouveaux')
		}),
		findingsSection({
			key: 'findings_aggravated',
			findings: input.findingsAggravated,
			cards: input.projects,
			limit,
			metricLabel: 'findings aggravés dans la période',
			counter: counterBy('aggravés')
		}),
		findingsSection({
			key: 'findings_resolved',
			findings: input.findingsResolved,
			cards: input.projects,
			limit,
			metricLabel: 'findings résolus dans la période',
			counter: counterBy('résolus'),
			note: 'une auto-résolution ne prouve pas une correction : elle dit que le signal ne franchit plus les seuils'
		}),
		findingsSection({
			key: 'opportunities',
			findings: input.opportunities,
			cards: input.projects,
			limit,
			metricLabel: 'opportunités ouvertes',
			counter: counterBy('findings ouverts')
		}),
		indexationSection(input),
		trafficSection(input),
		reviewsSection(input),
		proposalsSection({
			key: 'proposed_actions',
			proposals: input.proposalsCreated,
			limit,
			metricLabel: 'propositions produites dans la période',
			note: null
		}),
		proposalsSection({
			key: 'approvals_requested',
			proposals: input.proposalsPending,
			limit,
			metricLabel: 'propositions en attente de décision',
			// Dit ici parce que c'est la section qu'on lit avant d'aller cliquer : approuver
			// n'exécute rien tant qu'aucun handler d'exécution n'existe (E11).
			note: 'approuver enregistre une décision ; aucune exécution n’est encore branchée'
		}),
		automationSection(input)
	];

	return {
		schemaVersion: REPORT_SCHEMA_VERSION,
		generatedAt: input.generatedAt,
		period: {
			sinceDb: input.sinceDb,
			untilDb: input.untilDb,
			windowDays: input.windowDays,
			label: `${input.sinceDb} → ${input.untilDb}`
		},
		headline: buildReportHeadline(input),
		coverage: deriveBlindSpots(input.projects),
		sections
	};
}

/**
 * La phrase qu'on lit si on ne lit qu'une ligne.
 *
 * L'ordre des cas EST la priorité : une panne de collecte prime sur ce que les findings
 * racontent, parce qu'un pipeline mort rend le signal muet (règle DASH-002). Annoncer
 * « 0 nouveau problème » au-dessus d'une collecte morte serait le pire titre possible.
 */
export function buildReportHeadline(input: WeeklyReportInput): string {
	const p = input.portfolio;
	if (p.total === 0) return 'Aucun projet actif — rien à rapporter.';
	if (p.worst === 'paused') return 'Parc entièrement suspendu : le monitoring est à l’arrêt.';
	if (p.byState.broken > 0) {
		return `${plural(p.byState.broken, 'projet')} en panne de collecte — le signal des autres domaines n'y est pas interprétable.`;
	}
	if (isNeverExamined(input.projects)) {
		return 'Aucun détecteur n’a jamais tourné sur le parc : ce rapport ne conclut rien.';
	}
	if (p.byState.at_risk > 0) {
		return `${plural(p.byState.at_risk, 'projet')} à risque, ${plural(input.findingsNew.total, 'nouveau finding', 'nouveaux findings')} cette période.`;
	}
	if (input.findingsNew.total > 0 || input.findingsAggravated.total > 0) {
		return `${plural(input.findingsNew.total, 'nouveau finding', 'nouveaux findings')} et ${plural(input.findingsAggravated.total, 'aggravé')} sur ${plural(p.total, 'projet')}.`;
	}
	return `Rien de nouveau sur ${plural(p.total, 'projet')} — ${plural(p.needingAction, 'projet')} restent à traiter.`;
}

// ── Rendu texte ─────────────────────────────────────────────────────

/**
 * Rend le rapport en texte, **sans autre entrée que le rapport lui-même**.
 *
 * C'est l'acceptation « un rapport peut être généré sans LLM » rendue structurelle : cette
 * fonction n'a accès ni à la base, ni à l'heure, ni à un modèle. Elle ne peut donc rien
 * ajouter que le JSON ne porte — et tout ce qu'elle omettrait resterait disponible dans le
 * JSON pour REP-002/REP-004. Le texte est une PROJECTION, jamais la source.
 *
 * Une section absente rend sa raison, **jamais un compteur** : il n'y a pas de branche qui
 * écrive `0` pour un domaine non branché, parce que `SectionBody` n'existe pas dans ce cas.
 */
export function renderWeeklyReportText(report: WeeklyReport): string {
	const lines: string[] = [];
	lines.push(`# Rapport hebdomadaire — ${report.period.label}`);
	lines.push('');
	lines.push(`_généré le ${report.generatedAt} · schéma v${report.schemaVersion} · fenêtre ${report.period.windowDays} j_`);
	lines.push('');
	lines.push(report.headline);

	// Les angles morts du parc, UNE fois et en tête — avant les sections, parce qu'ils
	// conditionnent la lecture de toutes : un « 0 » plus bas ne veut pas dire la même chose
	// selon que six projets sur neuf ont été regardés ou aucun.
	if (report.coverage.length > 0) {
		lines.push('');
		lines.push(`⚠ ${report.coverage.length} angle(s) mort(s) — ce que ce rapport ne peut pas dire :`);
		for (const spot of report.coverage) {
			lines.push(`  - [${spot.projectSlug}] ${spot.note}`);
		}
	}

	const parcSpots = new Set(report.coverage.map(blindSpotKey));

	report.sections.forEach((section, i) => {
		lines.push('');
		lines.push(`## ${i + 1}. ${section.title}`);
		if (!section.body.available) {
			lines.push(`_absent (${section.body.reason}) : ${section.body.detail}_`);
			return;
		}
		const body = section.body.data;
		for (const m of body.metrics) {
			lines.push(`- **${m.label}** : ${m.display}${m.source?.href ? ` — ${m.source.href}` : ''}`);
		}
		if (body.items.length > 0) lines.push('');
		for (const item of body.items) {
			// Pas de préfixe quand le libellé EST le projet : « [alpha] alpha » ne dit rien deux
			// fois, il dit une fois et bégaie.
			const project =
				item.projectSlug && item.projectSlug !== item.label ? `[${item.projectSlug}] ` : '';
			const detail = item.detail ? ` — ${item.detail}` : '';
			const href = item.source.href ? ` (${item.source.href})` : ` (${sourceKey(item.source)})`;
			lines.push(`  - ${project}${item.label}${detail}${href}`);
		}
		if (body.truncated > 0) {
			lines.push(`  - … et ${body.truncated} de plus (non affichés, pas absents)`);
		}
		// Les angles morts PROPRES à la section sont dits ici ; ceux du parc entier ont été dits
		// en tête. Le nombre élidé est rappelé — compresser n'est pas taire.
		const own = body.blindSpots.filter((s) => !parcSpots.has(blindSpotKey(s)));
		for (const spot of own) {
			lines.push(`  ⚠ angle mort [${spot.projectSlug}] : ${spot.note}`);
		}
		const elided = body.blindSpots.length - own.length;
		if (elided > 0) {
			lines.push(`  ⚠ ${elided} angle(s) mort(s) du parc — détail en tête de rapport`);
		}
		if (body.note) lines.push(`  _${body.note}_`);
	});

	lines.push('');
	return lines.join('\n');
}
