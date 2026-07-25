/**
 * DASH-003 — Cockpit projet : la LECTURE.
 *
 * Le jugement pur vit dans `project-cockpit-state.ts` ; ici on lit la base et on applique les
 * fonctions pures. Client drizzle INJECTÉ (`db/types.ts`) — c'est ce qui rend ce lot prouvable
 * sur Neon hors runtime SvelteKit.
 *
 * ⚠️ **La carte de santé vient de `loadHomeCockpit`, et de nulle part ailleurs.** Recalculer ici
 * les six domaines de l'accueil ferait DEUX définitions de « projet à risque », qui
 * divergeraient au premier seuil modifié : le même projet serait alors noté différemment sur
 * l'accueil et sur son propre cockpit — précisément le genre d'incohérence qu'un tableau de bord
 * ne peut pas se permettre, puisqu'on ne saurait pas laquelle croire. Et le coût est nul : les
 * requêtes de l'accueil sont **déjà groupées par projet** (un nombre fixe d'allers-retours, quel
 * que soit le nombre de projets), donc les refiltrer ne ferait rien gagner.
 *
 * Ce que ce module ajoute, c'est le DÉTAIL par domaine, que l'accueil n'a pas la place de
 * porter : les fenêtres GSC, la couverture d'indexation (premier lecteur de `index_selection`
 * et d'`indexing-read.ts`) et la timeline.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppDb } from './db/types.js';
import {
	actionProposals,
	findingEvents,
	findings,
	monitoringRuns,
	projectIntegrations,
	projects,
	proposalApprovals
} from './db/schema.js';
import { loadHomeCockpit, GSC_STALE_AFTER_HOURS } from './home.js';
import {
	DEFAULT_WINDOW_DAYS,
	deriveFreshness,
	parseDbTimestampMs,
	type Counter,
	type Freshness,
	type ProjectCard
} from './home-state.js';
import { loadGscWindows, type GscWindowsReport } from './gsc-windows.js';
import { countIndexClasses } from './indexing-read.js';
import { loadDueSelections } from './collectors/index-selection.js';
import {
	buildPanel,
	buildTimeline,
	derivePanelState,
	makePeriod,
	rankPanels,
	summarizeIndexation,
	type IndexationSummary,
	type Panel,
	type PanelIntegration,
	type Timeline,
	type TimelineEntry
} from './project-cockpit-state.js';

/** Entrées de timeline chargées par nature avant fusion. Le plafond final est le seul qui compte. */
const TIMELINE_PER_SOURCE = 40;
export const DEFAULT_TIMELINE_LIMIT = 30;

/**
 * Au-delà de ce délai sans observation d'indexation, le panneau est dit « en retard ».
 *
 * 15 jours, et non 10 comme GSC : l'inspection n'est pas une collecte de masse mais une
 * **sélection** (IDX-004) — une page peut légitimement n'être revue que tous les 14 jours
 * (`sampleIntervalDays`). Un seuil calé sur GSC ferait crier tous les projets pour une rotation
 * qui fonctionne exactement comme prévu.
 */
export const INDEX_STALE_AFTER_HOURS = 24 * 15;

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

/** Les intégrations DÉCLARÉES du projet — la seule source qui sache dire « non branché ». */
async function loadProjectIntegrations(db: AppDb, projectId: string): Promise<PanelIntegration[]> {
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
		.where(eq(projectIntegrations.projectId, projectId))
		.orderBy(projectIntegrations.provider);
	return rows.map((r) => ({
		provider: r.provider,
		enabled: r.enabled,
		status: r.status,
		healthStatus: r.healthStatus,
		lastErrorCode: r.lastErrorCode,
		lastSuccessAt: r.lastSuccessAt
	}));
}

function integrationOf(
	integrations: PanelIntegration[],
	provider: string
): PanelIntegration | null {
	return integrations.find((i) => i.provider === provider) ?? null;
}

/** Derniers runs du projet — ce que le cockpit a FAIT. */
async function loadProjectRuns(db: AppDb, projectId: string, limit: number) {
	return db
		.select({
			id: monitoringRuns.id,
			runType: monitoringRuns.runType,
			status: monitoringRuns.status,
			periodStart: monitoringRuns.periodStart,
			periodEnd: monitoringRuns.periodEnd,
			triggeredBy: monitoringRuns.triggeredBy,
			createdAt: monitoringRuns.createdAt
		})
		.from(monitoringRuns)
		.where(eq(monitoringRuns.projectId, projectId))
		.orderBy(desc(monitoringRuns.createdAt))
		.limit(limit);
}

/** Derniers événements de findings — ce que le diagnostic a CONCLU (et décidé au finding). */
async function loadProjectFindingEvents(db: AppDb, projectId: string, limit: number) {
	return db
		.select({
			id: findingEvents.id,
			findingId: findingEvents.findingId,
			eventType: findingEvents.eventType,
			fromStatus: findingEvents.fromStatus,
			toStatus: findingEvents.toStatus,
			reason: findingEvents.reason,
			actor: findingEvents.actor,
			payloadJson: findingEvents.payloadJson,
			createdAt: findingEvents.createdAt,
			title: findings.title
		})
		.from(findingEvents)
		.leftJoin(findings, eq(findings.id, findingEvents.findingId))
		.where(eq(findingEvents.projectId, projectId))
		.orderBy(desc(findingEvents.createdAt))
		.limit(limit);
}

/**
 * Statuts qui signent une DÉCISION prise sur une proposition.
 *
 * `executing`/`executed`/`failed` n'y sont pas : ce sont des conséquences de la décision, pas
 * la décision elle-même — les compter ferait apparaître trois lignes de timeline là où un
 * humain n'a tranché qu'une fois.
 */
const DECIDED_STATUSES = ['approved', 'rejected', 'changes_requested'] as const;

/**
 * Les décisions du projet — **UNE décision, UNE ligne**.
 *
 * ⚠️ C'est le point délicat de la timeline, et il se lit dans les deux sens :
 *   - lire les décisions dans `proposal_approvals` seul **manquerait tous les rejets** (une
 *     proposition rejetée ne produit aucune approbation) ;
 *   - les lire dans `finding_events` seul manquerait les décisions prises sur une proposition
 *     **sans finding** — `proposals.ts` n'écrit son événement que `if (p.findingId)`, et une
 *     proposition issue d'un rapport n'en a pas.
 *
 * D'où la source unique retenue : `action_proposals` en statut décidé (que la décision ait ou
 * non un finding), enrichie de son approbation (méthode, auteur, hash) et de son motif quand
 * ils existent.
 */
async function loadProjectDecisions(db: AppDb, projectId: string, limit: number) {
	return db
		.select({
			id: actionProposals.id,
			findingId: actionProposals.findingId,
			actionType: actionProposals.actionType,
			target: actionProposals.target,
			status: actionProposals.status,
			requiredApprovalLevel: actionProposals.requiredApprovalLevel,
			approvedBy: actionProposals.approvedBy,
			updatedAt: actionProposals.updatedAt
		})
		.from(actionProposals)
		.where(
			and(
				eq(actionProposals.projectId, projectId),
				inArray(actionProposals.status, [...DECIDED_STATUSES])
			)
		)
		.orderBy(desc(actionProposals.updatedAt))
		.limit(limit);
}

/** Approbations des propositions listées — méthode et auteur, jamais un booléen. */
async function loadApprovalsFor(db: AppDb, proposalIds: string[]) {
	if (proposalIds.length === 0) return [];
	return db
		.select({
			proposalId: proposalApprovals.proposalId,
			approverType: proposalApprovals.approverType,
			approverId: proposalApprovals.approverId,
			method: proposalApprovals.method,
			status: proposalApprovals.status,
			createdAt: proposalApprovals.createdAt
		})
		.from(proposalApprovals)
		.where(inArray(proposalApprovals.proposalId, proposalIds))
		.orderBy(desc(proposalApprovals.createdAt));
}

/** Y a-t-il au moins une observation GSC pour ce projet ? (le `hasData` de `derivePanelState`) */
async function hasGscData(db: AppDb, projectId: string): Promise<boolean> {
	const res = await db.execute(sql`
		SELECT 1 AS n FROM "seostats"."gsc_query_page_observations"
		 WHERE project_id = ${projectId} LIMIT 1
	`);
	return (res.rows ?? []).length > 0;
}

/** Dernière observation d'indexation du projet — la fraîcheur du panneau indexation. */
async function loadLastIndexObservation(db: AppDb, projectId: string): Promise<string | null> {
	const res = await db.execute(sql`
		SELECT max(observed_date) AS d FROM "seostats"."index_observations"
		 WHERE project_id = ${projectId}
	`);
	const row = (res.rows ?? [])[0] as unknown as { d: string | null } | undefined;
	return row?.d ?? null;
}

// ── Le rapport assemblé ─────────────────────────────────────────────

export interface ProjectCockpit {
	project: { id: string; slug: string; name: string; color: string | null; archived: boolean };
	windowDays: number;
	sinceDb: string;
	/** L'heure du serveur, format DB — les écarts affichés se calculent contre elle. */
	now: string;
	/**
	 * La carte de santé, **telle que l'accueil la calcule**. `null` pour un projet archivé :
	 * l'accueil ne les classe pas, et fabriquer ici une carte qu'aucun autre écran ne
	 * montrerait recréerait exactement la divergence que ce module refuse.
	 */
	card: ProjectCard | null;
	counters: Counter[];
	integrations: PanelIntegration[];
	panels: Panel[];
	gsc: GscWindowsReport;
	indexation: IndexationSummary;
	indexFreshness: Freshness;
	timeline: Timeline;
}

/**
 * Le cockpit d'un projet en une lecture.
 *
 * Toutes les requêtes indépendantes partent en parallèle. `now` est calculé UNE fois et passé
 * partout : si chaque panneau prenait sa propre heure, deux fraîcheurs de la même page
 * pourraient se contredire.
 */
export async function loadProjectCockpit(input: {
	db: AppDb;
	projectSlug: string;
	now?: Date;
	windowDays?: number;
	timelineLimit?: number;
	staleAfterHours?: number;
	indexStaleAfterHours?: number;
}): Promise<ProjectCockpit | null> {
	const now = input.now ?? new Date();
	const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
	const timelineLimit = input.timelineLimit ?? DEFAULT_TIMELINE_LIMIT;
	const staleAfterHours = input.staleAfterHours ?? GSC_STALE_AFTER_HOURS;
	const indexStaleAfterHours = input.indexStaleAfterHours ?? INDEX_STALE_AFTER_HOURS;

	const project = await loadProjectRow(input.db, input.projectSlug);
	if (!project) return null;

	const today = now.toISOString().slice(0, 10);

	const [
		home,
		integrations,
		gsc,
		indexClasses,
		lastIndexObserved,
		dueSelections,
		gscData,
		runs,
		events,
		decisions
	] = await Promise.all([
		loadHomeCockpit({ db: input.db, now, windowDays, staleAfterHours }),
		loadProjectIntegrations(input.db, project.id),
		loadGscWindows({ db: input.db, projectId: project.id, now }),
		countIndexClasses({ db: input.db, projectId: project.id }),
		loadLastIndexObservation(input.db, project.id),
		loadDueSelections({ db: input.db, projectId: project.id, today }),
		hasGscData(input.db, project.id),
		loadProjectRuns(input.db, project.id, TIMELINE_PER_SOURCE),
		loadProjectFindingEvents(input.db, project.id, TIMELINE_PER_SOURCE),
		loadProjectDecisions(input.db, project.id, TIMELINE_PER_SOURCE)
	]);

	const approvals = await loadApprovalsFor(
		input.db,
		decisions.map((d) => d.id)
	);

	const card = home.projects.find((c) => c.slug === project.slug) ?? null;

	// ── Panneaux ────────────────────────────────────────────────────
	const gscIntegration = integrationOf(integrations, 'gsc');
	const gscFreshness = deriveFreshness({
		lastSuccessAt: gscIntegration?.lastSuccessAt ?? null,
		now,
		staleAfterHours
	});
	// Fenêtre de 28 j : celle que l'écran met en avant. La période affichée est celle des
	// SEMAINES RÉELLEMENT PRÉSENTES, pas celle demandée — une fenêtre tronquée qui annoncerait
	// ses bornes théoriques laisserait croire à une couverture qu'elle n'a pas.
	const gscWindow = gsc.windows.find((w) => w.span === 28) ?? gsc.windows[0] ?? null;

	// L'indexation n'a pas de ligne d'intégration à elle : le canon est `indexing` quand il
	// existe, sinon la présence d'observations décide (cf. `derivePanelState`).
	const indexIntegration = integrationOf(integrations, 'indexing');
	const indexFreshness = deriveFreshness({
		// `observed_date` est une DATE ; on la ramène au format DB pour que la comparaison
		// d'âge passe par le même parseur que tout le reste.
		lastSuccessAt: lastIndexObserved ? `${lastIndexObserved} 00:00:00` : null,
		now,
		staleAfterHours: indexStaleAfterHours
	});
	const indexation = summarizeIndexation({
		classes: indexClasses,
		dueRows: dueSelections.rows.map((r) => ({ dueDate: r.dueDate }))
	});

	const findingsFreshness = deriveFreshness({
		lastSuccessAt: events[0]?.createdAt ?? null,
		now,
		staleAfterHours
	});
	// Le diagnostic n'a rien produit : la fenêtre demandée n'est PAS une période couverte.
	// L'afficher quand même ferait lire « on a regardé ces 7 jours et tout va bien » là où la
	// vérité est « ce projet n'a jamais été diagnostiqué ».
	const findingsHasData = (card?.openTotal ?? 0) > 0 || events.length > 0;

	const panels = rankPanels([
		buildPanel({
			key: 'gsc',
			label: 'Search Console',
			verdict: derivePanelState({
				integration: gscIntegration,
				freshness: gscFreshness,
				hasData: gscData,
				label: 'Search Console'
			}),
			provenance: {
				period: makePeriod(gscWindow?.currentWindow?.start, gscWindow?.currentWindow?.end),
				freshness: gscFreshness,
				source: 'gsc_query_page_observations'
			}
		}),
		buildPanel({
			key: 'indexing',
			label: 'Indexation',
			verdict: derivePanelState({
				integration: indexIntegration,
				freshness: indexFreshness,
				hasData: indexation.urlsObserved > 0,
				label: 'Indexation'
			}),
			provenance: {
				// Une couverture est un ÉTAT au jour de la dernière inspection, pas une période :
				// la borne basse et la borne haute sont donc la même date, et l'écrire ainsi vaut
				// mieux que d'inventer une plage.
				period: makePeriod(lastIndexObserved, lastIndexObserved),
				freshness: indexFreshness,
				source: 'index_observations + index_selection'
			}
		}),
		buildPanel({
			key: 'findings',
			label: 'Diagnostic',
			verdict: derivePanelState({
				// Le diagnostic n'est pas un flux externe : il relit des observations déjà payées.
				// `external: false` — « non branché » y serait un contresens, et le lien
				// « Brancher » mènerait à une page de réglages qui ne propose rien.
				integration: null,
				external: false,
				freshness: findingsFreshness,
				hasData: findingsHasData,
				label: 'Diagnostic'
			}),
			provenance: {
				period: findingsHasData ? makePeriod(home.sinceDb.slice(0, 10), toIsoDate(now)) : null,
				freshness: findingsFreshness,
				source: 'findings + finding_events'
			}
		})
	]);

	// ── Timeline ────────────────────────────────────────────────────
	const approvalByProposal = new Map<string, (typeof approvals)[number]>();
	for (const a of approvals) if (!approvalByProposal.has(a.proposalId)) approvalByProposal.set(a.proposalId, a);

	// Le motif d'une décision est journalisé au finding (`agent_comment`) quand la proposition
	// en a un. On le retrouve par `proposalId` plutôt que de le relire en SQL : la jointure
	// passerait par un JSON, et une décision sans finding n'aurait de toute façon rien à joindre.
	const reasonByProposal = new Map<string, string>();
	for (const e of events) {
		if (e.eventType !== 'agent_comment' || !e.payloadJson || !e.reason) continue;
		try {
			const p = JSON.parse(e.payloadJson) as { proposalId?: string };
			if (p.proposalId && !reasonByProposal.has(p.proposalId)) {
				reasonByProposal.set(p.proposalId, e.reason);
			}
		} catch {
			// Un payload illisible ne coûte que ce motif-là : la décision reste dans la timeline.
		}
	}

	const entries: TimelineEntry[] = [
		...runs.map((r) => ({
			kind: 'run' as const,
			id: r.id,
			at: r.createdAt,
			atMs: parseDbTimestampMs(r.createdAt),
			title: `run ${r.runType} — ${r.status}`,
			detail: r.periodStart && r.periodEnd ? `période ${r.periodStart} → ${r.periodEnd}` : null,
			actor: r.triggeredBy,
			href: `/jobs?project=${project.slug}`
		})),
		...events.map((e) => ({
			kind: 'finding' as const,
			id: e.id,
			at: e.createdAt,
			atMs: parseDbTimestampMs(e.createdAt),
			title: `${e.eventType} — ${e.title ?? 'finding'}`,
			detail:
				e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus
					? `${e.fromStatus} → ${e.toStatus}`
					: null,
			actor: e.actor,
			reason: e.reason,
			href: `/inbox/findings/${e.findingId}`
		})),
		...decisions.map((d) => {
			const approval = approvalByProposal.get(d.id) ?? null;
			return {
				kind: 'decision' as const,
				id: d.id,
				at: d.updatedAt,
				atMs: parseDbTimestampMs(d.updatedAt),
				title: `proposition ${d.status} — ${d.actionType}`,
				detail: d.target,
				// L'auteur vient de l'approbation quand elle existe (une décision approuvée), du
				// champ dénormalisé sinon (un rejet n'a pas d'approbation).
				actor: approval?.approverId ?? approval?.approverType ?? d.approvedBy ?? null,
				reason: reasonByProposal.get(d.id) ?? null,
				approvalLevel: d.requiredApprovalLevel,
				href: `/inbox/proposals/${d.id}`
			};
		})
	];

	return {
		project: {
			id: project.id,
			slug: project.slug,
			name: project.name,
			color: project.color,
			archived: project.archived
		},
		windowDays,
		sinceDb: home.sinceDb,
		now: home.now,
		card,
		counters: card?.counters ?? [],
		integrations,
		panels,
		gsc,
		indexation,
		indexFreshness,
		timeline: buildTimeline(entries, timelineLimit)
	};
}

function toIsoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}
