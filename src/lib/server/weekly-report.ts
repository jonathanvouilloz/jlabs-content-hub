/**
 * REP-001 — Rapport hebdomadaire interne : la LECTURE.
 *
 * Le modèle pur vit dans `weekly-report-state.ts` (testé par vitest) ; ici on lit la base et on
 * l'applique. Client drizzle INJECTÉ, comme partout depuis GSC-002 : c'est ce qui rend ce lot
 * prouvable sur Neon hors runtime SvelteKit.
 *
 * ⚠️ **La santé du portefeuille vient de `loadHomeCockpit`, et de nulle part ailleurs.** Le
 * rapport du lundi est censé résumer l'accueil : s'il recalculait ses propres états, les deux
 * pourraient se contredire un lundi matin, et personne ne saurait lequel croire. Même argument
 * qu'à `project-cockpit.ts`, et même coût nul — les requêtes de l'accueil sont déjà groupées
 * par projet.
 *
 * Ce que ce module AJOUTE, c'est ce que l'accueil n'a pas la place de porter : les listes
 * elles-mêmes (findings nouveaux/aggravés/résolus, opportunités, propositions), l'indexation
 * par projet, les avis de la période, et le gate analytics — qui, aujourd'hui, dit « non
 * branché » et surtout pas « zéro ».
 *
 * Une lecture par DOMAINE, groupée par projet — jamais une requête par projet dans une boucle.
 */
import { eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { gmbReviews, projectIntegrations } from './db/schema.js';
import type { AppDb } from './db/types.js';
import { loadHomeCockpit, GSC_STALE_AFTER_HOURS } from './home.js';
import { DEFAULT_WINDOW_DAYS } from './home-state.js';
import { ACTIVE_STATUSES, FINDING_STATUSES } from './finding-state.js';
import { countFindings, listFindings, type FindingListRow } from './findings.js';
import { countProposals, listProposals, type ProposalRow } from './proposals.js';
import { countIndexClassesByProject } from './indexing-read.js';
import { countDueSelectionsByProject } from './collectors/index-selection.js';
import { summarizeIndexation } from './project-cockpit-state.js';
import { OPEN_PROPOSAL_STATUSES } from './proposal-console.js';
import {
	buildWeeklyReport,
	DEFAULT_MAX_ITEMS_PER_SECTION,
	type ReportFindingInput,
	type ReportIndexationInput,
	type ReportProposalInput,
	type ReportReviewsInput,
	type ReportSet,
	type ReportTrafficInput,
	type WeeklyReport
} from './weekly-report-state.js';
import { toDbTimestamp } from './timestamps.js';

/**
 * Combien de lignes on LIT par section, au plus.
 *
 * Plus haut que le plafond d'AFFICHAGE (`DEFAULT_MAX_ITEMS_PER_SECTION`), et c'est voulu : le
 * JSON est archivé et relu par un agent (REP-002), il a le droit de porter plus que ce que le
 * texte montre. Le total, lui, ne dépend d'aucun des deux — il vient d'un `count(*)`.
 */
const READ_LIMIT_PER_SECTION = 200;

/**
 * Seuil d'entrée d'une opportunité dans le rapport.
 *
 * « À FORT IMPACT » est dans l'énoncé de la section (§14.1) : sans seuil, la liste serait le
 * dump de tout ce qui est ouvert, trié par score, et la section n'apporterait rien que l'inbox
 * ne montre déjà. 50/100 est la moitié du barème §10.2 — nommé ici plutôt que noyé dans un appel.
 */
export const OPPORTUNITY_MIN_PRIORITY = 50;

/** Le provider qui, s'il était branché, remplirait la section trafic/conversions. */
const ANALYTICS_PROVIDER = 'plausible';
/** Le provider qui nourrit la section avis. */
const REVIEWS_PROVIDER = 'gmb';
/** Le provider qui nourrit la section indexation. */
const INDEXING_PROVIDER = 'indexing';

// ── Conversions vers les entrées du modèle pur ──────────────────────

function toFindingInput(r: FindingListRow): ReportFindingInput {
	return {
		id: r.id,
		projectSlug: r.projectSlug,
		type: r.type,
		title: r.title,
		severity: r.severity,
		priorityScore: r.priorityScore,
		status: r.status,
		occurrenceCount: r.occurrenceCount,
		lastSeenAt: r.lastSeenAt
	};
}

function toProposalInput(r: ProposalRow): ReportProposalInput {
	return {
		id: r.id,
		projectSlug: r.projectSlug,
		actionType: r.actionType,
		target: r.target,
		status: r.status,
		// `risk_level` est nullable en base. `'inconnu'` plutôt que `'low'` : deviner le risque
		// le plus faible d'une proposition qui n'en déclare aucun ferait descendre dans la liste
		// exactement ce qu'on n'a pas su qualifier.
		riskLevel: r.riskLevel ?? 'inconnu',
		requiredApprovalLevel: r.requiredApprovalLevel,
		createdAt: r.createdAt
	};
}

// ── Lectures propres au rapport ─────────────────────────────────────

/**
 * Un ensemble = son TOTAL (un `count(*)`) et sa page lue.
 *
 * Les deux passent par les MÊMES filtres (`listFindings`/`countFindings` partagent
 * `findingFilters`), sans quoi le rapport annoncerait un nombre que sa propre liste ne
 * reproduirait pas — la faute que DASH-002 a poursuivie sur chaque compteur de l'accueil.
 */
async function findingSet(
	db: AppDb,
	filter: Parameters<typeof listFindings>[0]
): Promise<ReportSet<ReportFindingInput>> {
	const [rows, total] = await Promise.all([
		listFindings({ ...filter, limit: READ_LIMIT_PER_SECTION }, db),
		countFindings(filter, db)
	]);
	return { total, rows: rows.map(toFindingInput) };
}

async function proposalSet(
	db: AppDb,
	filter: Parameters<typeof listProposals>[0]
): Promise<ReportSet<ReportProposalInput>> {
	const [rows, total] = await Promise.all([
		listProposals({ ...filter, limit: READ_LIMIT_PER_SECTION }, db),
		countProposals(filter, db)
	]);
	return { total, rows: rows.map(toProposalInput) };
}

/**
 * Les avis de la PÉRIODE et l'arriéré, par projet.
 *
 * `create_time` (l'horodatage Google) et non `created_at` (la date d'import) : un import de
 * rattrapage ferait sinon apparaître trois ans d'avis comme « reçus cette semaine ». Les
 * négatifs sont les 1–2 étoiles, seuil de §14.3.
 */
async function loadReviewStats(
	db: AppDb,
	sinceDb: string
): Promise<Map<string, { unanswered: number; received: number; negative: number }>> {
	const rows = await db
		.select({
			projectId: gmbReviews.projectId,
			unanswered: sql<number>`count(*) filter (where ${isNull(gmbReviews.repliedAt)})::int`,
			received: sql<number>`count(*) filter (where ${gte(gmbReviews.createTime, sinceDb)})::int`,
			negative: sql<number>`count(*) filter (where ${gte(gmbReviews.createTime, sinceDb)} and ${lte(gmbReviews.rating, 2)})::int`
		})
		.from(gmbReviews)
		.groupBy(gmbReviews.projectId);
	return new Map(rows.map((r) => [r.projectId, r]));
}

/** Les providers DÉCLARÉS et activés, par projet — la seule source qui sache dire « non branché ». */
async function loadWiredProviders(db: AppDb): Promise<Map<string, Set<string>>> {
	const rows = await db
		.select({ projectId: projectIntegrations.projectId, provider: projectIntegrations.provider })
		.from(projectIntegrations)
		.where(eq(projectIntegrations.enabled, true));
	const out = new Map<string, Set<string>>();
	for (const r of rows) {
		const set = out.get(r.projectId) ?? new Set<string>();
		set.add(r.provider);
		out.set(r.projectId, set);
	}
	return out;
}

// ── L'assemblage ────────────────────────────────────────────────────

/**
 * Le rapport hebdomadaire en une lecture.
 *
 * `now` est calculé UNE fois et passé partout : si chaque section prenait son heure, deux
 * bornes de la même période pourraient différer de quelques millisecondes, et deux exécutions
 * du même rapport ne seraient pas comparables.
 *
 * Rend le JSON, pas le texte. `renderWeeklyReportText` reste un appel SÉPARÉ et volontaire :
 * c'est ce qui rend visible, à l'appel, que le texte est une projection du JSON — et non
 * l'inverse.
 */
export async function loadWeeklyReport(input: {
	db: AppDb;
	now?: Date;
	windowDays?: number;
	staleAfterHours?: number;
	maxItemsPerSection?: number;
}): Promise<WeeklyReport> {
	const now = input.now ?? new Date();
	const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
	const staleAfterHours = input.staleAfterHours ?? GSC_STALE_AFTER_HOURS;

	const home = await loadHomeCockpit({ db: input.db, now, windowDays, staleAfterHours });
	const sinceDb = home.sinceDb;
	const today = now.toISOString().slice(0, 10);

	// Les sections d'ACTIVITÉ portent le même filtre que les compteurs de l'accueil : tous les
	// statuts + un `EXISTS` sur le journal depuis la même borne. Restreindre aux statuts actifs
	// écarterait précisément les `resolved` que la section « résolus » vient compter.
	const activityFilter = { statuses: FINDING_STATUSES, activitySince: sinceDb };

	const [
		findingsNew,
		findingsAggravated,
		findingsResolved,
		opportunities,
		proposalsCreated,
		proposalsPending,
		indexClasses,
		dueSelections,
		reviewStats,
		wiredProviders
	] = await Promise.all([
		findingSet(input.db, { ...activityFilter, activityEvents: ['created'] }),
		findingSet(input.db, { ...activityFilter, activityEvents: ['aggravated'] }),
		findingSet(input.db, { ...activityFilter, activityEvents: ['resolved'] }),
		// Les opportunités sont un ÉTAT, pas une activité : ce qui est ouvert aujourd'hui, quelle
		// que soit la semaine où on l'a trouvé. Les borner à la période ferait disparaître du
		// rapport une opportunité à 90 points simplement parce qu'elle a déjà été annoncée.
		findingSet(input.db, {
			statuses: ACTIVE_STATUSES,
			types: ['keyword_opportunity'],
			minPriority: OPPORTUNITY_MIN_PRIORITY
		}),
		proposalSet(input.db, { createdSince: sinceDb }),
		proposalSet(input.db, { statuses: OPEN_PROPOSAL_STATUSES }),
		countIndexClassesByProject({ db: input.db }),
		countDueSelectionsByProject({ db: input.db, today }),
		loadReviewStats(input.db, sinceDb),
		loadWiredProviders(input.db)
	]);

	const indexation: ReportIndexationInput[] = home.projects.map((card) => {
		const classes = indexClasses.get(card.projectId) ?? {
			indexed: 0,
			not_indexed: 0,
			excluded: 0,
			unknown: 0
		};
		// ⚠️ `summarizeIndexation` reste l'AUTORITÉ du taux de couverture : `excluded` hors
		// dénominateur, `null` plutôt que 0 % quand aucun verdict n'est tranché. Le recopier ici
		// ferait diverger le taux du rapport et celui de l'onglet Indexation au premier
		// changement de dénominateur.
		//
		// `dueNow`, lui, vient de `countDueSelectionsByProject` : `summarizeIndexation` ne fait
		// qu'en compter les lignes (`dueRows.length`), et la SEULE règle qui compte — « honorée
		// se dérive » — vit dans le prédicat `notExists(honored)`, littéralement partagé avec
		// `loadDueSelections`. Fabriquer ici N lignes factices pour les faire recompter serait
		// du théâtre, et coûterait un tableau par projet.
		const summary = summarizeIndexation({ classes, dueRows: [] });
		const due = dueSelections.get(card.projectId);
		return {
			projectSlug: card.slug,
			urlsObserved: summary.urlsObserved,
			indexed: classes.indexed,
			notIndexed: classes.not_indexed,
			coverageRate: summary.coverageRate,
			dueNow: due?.dueNow ?? 0,
			wired: wiredProviders.get(card.projectId)?.has(INDEXING_PROVIDER) ?? false
		};
	});

	const reviews: ReportReviewsInput[] = home.projects.map((card) => {
		const stats = reviewStats.get(card.projectId);
		return {
			projectSlug: card.slug,
			unanswered: stats?.unanswered ?? 0,
			received: stats?.received ?? 0,
			negative: stats?.negative ?? 0,
			wired: wiredProviders.get(card.projectId)?.has(REVIEWS_PROVIDER) ?? false
		};
	});

	// ⭐ Trafic et conversions : AUCUNE lecture de `plausible_page_observations`, et c'est
	// exact. E10 n'est pas livré, rien n'écrit dans cette table, et aucun projet ne déclare le
	// provider. L'interroger pour en tirer des `0` serait la manière technique de mentir : le
	// rapport dirait « 0 visite » là où la vérité est « non mesuré ». On lit donc l'ÉTAT DU
	// BRANCHEMENT, et le modèle pur (`deriveAvailability`) en fait une absence NOMMÉE. Le jour
	// où E10 écrira, `wired` deviendra vrai et la section s'allumera d'elle-même.
	const traffic: ReportTrafficInput[] = home.projects.map((card) => ({
		projectSlug: card.slug,
		visits: 0,
		conversions: 0,
		wired: wiredProviders.get(card.projectId)?.has(ANALYTICS_PROVIDER) ?? false
	}));

	return buildWeeklyReport({
		generatedAt: toDbTimestamp(now),
		sinceDb,
		untilDb: home.now,
		windowDays,
		portfolio: home.portfolio,
		projects: home.projects,
		counters: home.counters,
		findingsNew,
		findingsAggravated,
		findingsResolved,
		opportunities,
		proposalsCreated,
		proposalsPending,
		indexation,
		reviews,
		traffic,
		costs: home.costs,
		runStatusCounts: home.runStatusCounts,
		maxItemsPerSection: input.maxItemsPerSection ?? DEFAULT_MAX_ITEMS_PER_SECTION
	});
}
