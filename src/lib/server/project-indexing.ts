/**
 * DASH-003 lot 2, chantier 2 — l'onglet Indexation : la LECTURE.
 *
 * Le jugement pur vit dans `project-indexing-state.ts` ; ici on lit la base et on applique les
 * fonctions pures. Client drizzle INJECTÉ (`db/types.ts`) — c'est ce qui rend ce chantier
 * prouvable sur Neon hors runtime SvelteKit, comme `project-cockpit.ts`.
 *
 * ⚠️ **Ce module ne charge PAS la santé du projet.** Le lot 1 pose que la carte vient de
 * `loadHomeCockpit` et de nulle part ailleurs ; le moyen le plus sûr de tenir cet invariant sur
 * un onglet qui n'affiche pas la santé, c'est de ne pas la calculer du tout. Ce qui EST partagé
 * avec la vue d'ensemble — le panneau `indexing` et le résumé `IndexationSummary` — passe par les
 * **mêmes fonctions pures**, alimentées par les **mêmes lectures**, et
 * `scripts/dash-003-indexing-proof.ts` en vérifie l'égalité champ par champ contre
 * `loadProjectCockpit` (l'équivalent de l'égalité §A du lot 1). Deux résumés de couverture qui
 * divergeraient afficheraient deux taux différents à un onglet d'écart, sans qu'on sache lequel
 * croire.
 *
 * ⚠️ **Zéro appel réseau.** Toute l'indexation se lit depuis la base : un écran qui appellerait
 * l'URL Inspection API au rendu dépenserait du quota à chaque rafraîchissement, sur un compte que
 * les six projets partagent (l'en-tête d'`indexing-read.ts` le dit pour la même raison).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { AppDb } from './db/types.js';
import { projectIntegrations, projects } from './db/schema.js';
import { deriveFreshness, type Freshness } from './home-state.js';
import {
	buildPanel,
	derivePanelState,
	makePeriod,
	summarizeIndexation,
	type IndexationSummary,
	type Panel,
	type PanelIntegration
} from './project-cockpit-state.js';
import { INDEX_STALE_AFTER_HOURS } from './project-cockpit.js';
import {
	countIndexClasses,
	loadIndexHistory,
	loadInspectionFreshness,
	loadLatestIndexStates,
	type IndexStateRow
} from './indexing-read.js';
import {
	loadDueSelections,
	loadGlobalPoolUsed,
	loadProjectSelectionOverrides,
	loadSelectionSettings
} from './collectors/index-selection.js';
import { resolveProjectSelection } from './collectors/index-selection-state.js';
import { loadLatestInventory, loadPreviousInventory } from './collectors/sitemap-inventory.js';
import { diffInventories } from './collectors/sitemap-state.js';
import { INDEX_TRANSITION_TYPES } from './detectors/index-transition-state.js';
import { listFindings, type FindingListRow } from './findings.js';
import { ACTIVE_STATUSES } from './finding-state.js';
import {
	buildClassFilters,
	describeInspectionFreshness,
	summarizeQuota,
	summarizeSitemap,
	type ClassFilter,
	type QuotaSummary,
	type SitemapSummary
} from './project-indexing-state.js';
import type { IndexedClass } from './collectors/url-inspection-state.js';

/** Plafond de la liste d'URLs rendue. Au-delà, la troncature est **dite**, jamais silencieuse. */
export const URL_LIST_LIMIT = 300;

/** Profondeur de l'historique d'une URL (`?url=`). */
export const URL_HISTORY_LIMIT = 60;

// ── Lectures ────────────────────────────────────────────────────────

async function loadProjectRow(db: AppDb, slug: string) {
	const rows = await db
		.select({
			id: projects.id,
			slug: projects.slug,
			name: projects.name,
			color: projects.color,
			archived: projects.archived
		})
		.from(projects)
		.where(eq(projects.slug, slug))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * La ligne d'intégration `indexing`, si elle existe.
 *
 * `null` n'est pas « cassé » : l'indexation peut tourner sans ligne déclarée (service account
 * partagé), et c'est `hasData` qui tranche dans `derivePanelState`.
 */
async function loadIndexingIntegration(
	db: AppDb,
	projectId: string
): Promise<PanelIntegration | null> {
	const rows = await db
		.select({
			provider: projectIntegrations.provider,
			enabled: projectIntegrations.enabled,
			status: projectIntegrations.status,
			healthStatus: projectIntegrations.healthStatus,
			lastErrorCode: projectIntegrations.lastErrorCode,
			lastSuccessAt: projectIntegrations.lastSuccessAt
		})
		.from(projectIntegrations)
		.where(
			and(
				eq(projectIntegrations.projectId, projectId),
				eq(projectIntegrations.provider, 'indexing')
			)
		)
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Dernière observation d'indexation du projet.
 *
 * Passe par `loadInspectionFreshness` (`indexing-read.ts`) plutôt que par un `max(observed_date)`
 * local : c'est la fonction écrite pour ça en IDX-002, et elle n'avait **aucun appelant** — un
 * read-model sans lecteur est un read-model qu'on croit juste. En recopier la requête ici en
 * ferait une deuxième autorité sur la même mesure, qui divergerait au premier changement de
 * borne. L'égalité du panneau avec celui de la vue d'ensemble est vérifiée en base (§A de
 * `scripts/dash-003-indexing-proof.ts`).
 */
async function loadLastIndexObservation(db: AppDb, projectSlug: string): Promise<string | null> {
	const rows = await loadInspectionFreshness({ db, projectSlug });
	return rows[0]?.lastObservedDate ?? null;
}

/**
 * Les fichiers sitemap parcourus à une date, et combien ont remonté une erreur.
 *
 * C'est ce que l'acceptation IDX-001 appelle « un sitemap injoignable ou malformé devient un fait
 * interrogeable » : le grain par FICHIER vit dans `sitemap_observations`, distinct de l'inventaire
 * par URL. Sans lui, un enfant mort au milieu de l'arbre passerait pour un site qui a simplement
 * moins de pages.
 */
async function loadSitemapFileStats(
	db: AppDb,
	projectId: string,
	observedDate: string | null
): Promise<{ files: number; filesWithErrors: number }> {
	if (!observedDate) return { files: 0, filesWithErrors: 0 };
	const res = await db.execute(sql`
		SELECT count(*)::int AS files,
		       count(*) FILTER (WHERE errors > 0)::int AS with_errors
		  FROM "seostats"."sitemap_observations"
		 WHERE project_id = ${projectId} AND observed_date = ${observedDate}
	`);
	const row = (res.rows ?? [])[0] as unknown as
		| { files: number; with_errors: number }
		| undefined;
	return { files: Number(row?.files ?? 0), filesWithErrors: Number(row?.with_errors ?? 0) };
}

// ── Le rapport assemblé ─────────────────────────────────────────────

export interface ProjectIndexing {
	project: { id: string; slug: string; name: string; color: string | null; archived: boolean };
	/** Date de référence (`YYYY-MM-DD`), calculée UNE fois et passée partout. */
	today: string;
	/** Le panneau `indexing`, **identique** à celui de la vue d'ensemble (prouvé). */
	panel: Panel;
	/** Le résumé de couverture, **identique** à celui de la vue d'ensemble (prouvé). */
	indexation: IndexationSummary;
	freshness: Freshness;
	freshnessNote: string;
	classFilters: ClassFilter[];
	/** La classe demandée par `?class=`, ou `null` si aucune (ou une valeur écartée). */
	activeClass: IndexedClass | null;
	/** Les URLs de la classe active, plafonnées à `URL_LIST_LIMIT`. */
	urls: IndexStateRow[];
	/** Vrai si le plafond a coupé la liste — annoncé avec le total réel. */
	urlsTruncated: boolean;
	/** Total d'URLs de la classe active, avant plafond. */
	urlsTotal: number;
	sitemap: SitemapSummary;
	quota: QuotaSummary;
	/** Findings d'indexation ouverts — la liste ET son compte sortent du même filtre. */
	transitions: FindingListRow[];
	/** L'URL demandée par `?url=`, si elle a un historique. */
	focusUrl: string | null;
	focusHistory: IndexStateRow[];
}

/**
 * L'onglet Indexation d'un projet en une lecture.
 *
 * Toutes les requêtes indépendantes partent en parallèle et `now` est calculé UNE fois : si
 * chaque bloc prenait sa propre heure, deux fraîcheurs de la même page pourraient se contredire.
 * Le nombre d'allers-retours est **constant** — il ne dépend ni du nombre d'URLs, ni du nombre de
 * findings.
 */
export async function loadProjectIndexing(input: {
	db: AppDb;
	projectSlug: string;
	now?: Date;
	/** Classe déjà normalisée par l'appelant (`normalizeIndexClass`). */
	activeClass?: IndexedClass | null;
	focusUrl?: string | null;
	indexStaleAfterHours?: number;
	urlLimit?: number;
}): Promise<ProjectIndexing | null> {
	const now = input.now ?? new Date();
	const today = now.toISOString().slice(0, 10);
	const activeClass = input.activeClass ?? null;
	const urlLimit = input.urlLimit ?? URL_LIST_LIMIT;
	const staleAfterHours = input.indexStaleAfterHours ?? INDEX_STALE_AFTER_HOURS;

	const project = await loadProjectRow(input.db, input.projectSlug);
	if (!project) return null;

	const [
		integration,
		lastIndexObserved,
		indexClasses,
		dueSelections,
		latestInventory,
		selectionConfig,
		selectionOverrides,
		poolUsedToday,
		transitions,
		allStates
	] = await Promise.all([
		loadIndexingIntegration(input.db, project.id),
		loadLastIndexObservation(input.db, project.slug),
		countIndexClasses({ db: input.db, projectId: project.id }),
		loadDueSelections({ db: input.db, projectId: project.id, today }),
		loadLatestInventory({ db: input.db, projectId: project.id, onOrBefore: today }),
		loadSelectionSettings(input.db),
		loadProjectSelectionOverrides(input.db, project.id),
		loadGlobalPoolUsed({ db: input.db, today }),
		listFindings(
			{
				projectSlug: project.slug,
				statuses: ACTIVE_STATUSES,
				types: INDEX_TRANSITION_TYPES,
				limit: 200
			},
			input.db
		),
		// La classe est DÉRIVÉE à la lecture (`classifyCoverage` reste l'autorité unique) : elle
		// ne peut donc pas être filtrée en SQL sans reproduire la classification, ce que
		// `countIndexClasses` refuse déjà de faire pour la même raison.
		loadLatestIndexStates({ db: input.db, projectId: project.id, limit: 5000 })
	]);

	// Ces deux lectures dépendent de la date d'inventaire : elles ne peuvent pas partir en même
	// temps que celle qui la découvre.
	const [previousInventory, fileStats] = await Promise.all([
		latestInventory.date
			? loadPreviousInventory({
					db: input.db,
					projectId: project.id,
					beforeDate: latestInventory.date
				})
			: Promise.resolve({ date: null, rows: [] }),
		loadSitemapFileStats(input.db, project.id, latestInventory.date)
	]);

	const focusUrl = (input.focusUrl ?? '').trim() || null;
	const focusHistory = focusUrl
		? await loadIndexHistory({
				db: input.db,
				projectId: project.id,
				url: focusUrl,
				limit: URL_HISTORY_LIMIT
			})
		: [];

	// ── Panneau : les mêmes fonctions pures que la vue d'ensemble ────
	const freshness = deriveFreshness({
		// `observed_date` est une DATE ; on la ramène au format DB pour que la comparaison d'âge
		// passe par le même parseur que partout ailleurs.
		lastSuccessAt: lastIndexObserved ? `${lastIndexObserved} 00:00:00` : null,
		now,
		staleAfterHours
	});
	const indexation = summarizeIndexation({
		classes: indexClasses,
		dueRows: dueSelections.rows.map((r) => ({ dueDate: r.dueDate }))
	});
	const panel = buildPanel({
		key: 'indexing',
		label: 'Indexation',
		verdict: derivePanelState({
			integration,
			freshness,
			hasData: indexation.urlsObserved > 0,
			label: 'Indexation'
		}),
		provenance: {
			// Une couverture est un ÉTAT au jour de la dernière inspection, pas une période : les
			// deux bornes sont la même date, et l'écrire ainsi vaut mieux qu'inventer une plage.
			period: makePeriod(lastIndexObserved, lastIndexObserved),
			freshness,
			source: 'index_observations + index_selection'
		}
	});

	// ── Liste d'URLs ────────────────────────────────────────────────
	const filtered = activeClass ? allStates.filter((s) => s.indexedClass === activeClass) : allStates;
	const urls = filtered.slice(0, urlLimit);

	// ── Inventaire sitemap ──────────────────────────────────────────
	const diff =
		latestInventory.date && previousInventory.date
			? diffInventories(
					previousInventory.rows,
					latestInventory.rows.map((r) => ({
						urlNormalized: r.urlNormalized,
						lastmod: r.lastmod,
						expectedCanonical: r.expectedCanonical
					}))
				)
			: null;

	const sitemap = summarizeSitemap({
		date: latestInventory.date,
		rows: latestInventory.rows,
		previousDate: previousInventory.date,
		diff,
		files: fileStats.files,
		filesWithErrors: fileStats.filesWithErrors
	});

	// ── Quota ───────────────────────────────────────────────────────
	const projectSelection = resolveProjectSelection(selectionConfig, selectionOverrides);
	const quota = summarizeQuota({
		// Repris de `summarizeIndexation`, jamais recomptés : deux comptes de la même file
		// finiraient par se contredire sur le même écran.
		dueNow: indexation.dueNow,
		oldestDueDate: indexation.oldestDueDate,
		dueRows: dueSelections.rows.map((r) => ({
			dueDate: r.dueDate,
			reason: r.reason,
			bucket: r.bucket
		})),
		unreadable: dueSelections.unreadable,
		today,
		maxAgeDays: selectionConfig.maxAgeDays,
		poolUsedToday,
		poolTotal: selectionConfig.dailyPoolTotal,
		dailyBudgetPerProject: projectSelection.dailyBudget
	});

	return {
		project: {
			id: project.id,
			slug: project.slug,
			name: project.name,
			color: project.color,
			archived: project.archived
		},
		today,
		panel,
		indexation,
		freshness,
		freshnessNote: describeInspectionFreshness(freshness),
		classFilters: buildClassFilters({
			classes: indexClasses,
			projectSlug: project.slug,
			activeClass
		}),
		activeClass,
		urls,
		urlsTruncated: filtered.length > urls.length,
		urlsTotal: filtered.length,
		sitemap,
		quota,
		transitions,
		focusUrl: focusHistory.length > 0 ? focusUrl : null,
		focusHistory
	};
}
