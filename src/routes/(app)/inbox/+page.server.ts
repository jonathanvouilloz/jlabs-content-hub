import type { PageServerLoad } from './$types.js';
import { db } from '$lib/server/db/index.js';
import {
	countProposals,
	countProposalsByStatus,
	listProposals
} from '$lib/server/proposals.js';
import { countFindings, countFindingsByStatus, listFindings } from '$lib/server/findings.js';
import { ACTIVE_STATUSES, FINDING_STATUSES } from '$lib/server/finding-state.js';
import {
	buildApprovalLots,
	normalizeProposalFilters,
	proposalAbilities
} from '$lib/server/proposal-console.js';
import { toDbTimestamp } from '$lib/server/timestamps.js';

/**
 * DASH-004/005 — L'inbox : ce que le cockpit a produit et qui attend un humain.
 *
 * Cross-projet comme `/jobs`, et pour la même raison : en ouvrant l'inbox on ne
 * sait pas encore quel projet demande une décision — c'est ce qu'on vient
 * chercher. Le filtre projet permet de redescendre ensuite.
 *
 * Deux onglets, deux listes, mais les DEUX compteurs sont toujours chargés : un
 * onglet dont le badge n'est calculé qu'une fois ouvert cache exactement ce que
 * l'inbox existe pour montrer. Seule la liste de l'onglet actif est paginée —
 * charger les deux doublerait le coût pour rien.
 *
 * Tout ce qui vient de l'URL passe par `normalizeProposalFilters` AVANT d'atteindre
 * une requête : une valeur inventée est écartée, jamais transmise.
 */
export const load: PageServerLoad = async ({ url, locals }) => {
	const tab = url.searchParams.get('tab') === 'findings' ? 'findings' : 'proposals';

	const filters = normalizeProposalFilters({
		status: url.searchParams.get('status'),
		level: url.searchParams.get('level'),
		risk: url.searchParams.get('risk'),
		project: url.searchParams.get('project'),
		action: url.searchParams.get('action'),
		limit: url.searchParams.get('limit'),
		offset: url.searchParams.get('offset')
	});

	// Les statuts de finding vivent dans leur propre vocabulaire : les normaliser
	// ici plutôt que d'emprunter celui des propositions, qui n'a rien à voir.
	const rawFindingStatus = (url.searchParams.get('fstatus') ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const findingStatuses = rawFindingStatus.filter((s) =>
		(FINDING_STATUSES as readonly string[]).includes(s)
	);
	const findingFilters = {
		projectSlug: filters.projectSlug,
		statuses: rawFindingStatus.length === 0 ? ACTIVE_STATUSES : findingStatuses,
		limit: filters.limit,
		offset: filters.offset
	};

	// La liste des projets vient du layout (`sidebarProjects`) : la requêter à
	// nouveau ici ferait deux sources pour la même liste déroulante.
	const [proposalCounts, findingCounts, proposalTotal, findingTotal, proposalRows, findingRows] =
		await Promise.all([
			countProposalsByStatus({ projectSlug: filters.projectSlug }, db),
			countFindingsByStatus({ projectSlug: filters.projectSlug }, db),
			countProposals(filters, db),
			countFindings(findingFilters, db),
			tab === 'proposals' ? listProposals(filters, db) : Promise.resolve([]),
			tab === 'findings' ? listFindings(findingFilters, db) : Promise.resolve([])
		]);

	// Les lots sont calculés SERVEUR, sur les lignes réelles — l'écran ne fait
	// que les rendre. `approve-batch` rejouera exactement ce calcul avant d'écrire :
	// une règle de groupement qui ne vivrait que dans un template serait contournable.
	const { lots, excluded } = buildApprovalLots(
		proposalRows.map((r) => ({
			id: r.id,
			projectId: r.projectId,
			projectSlug: r.projectSlug,
			actionType: r.actionType,
			requiredApprovalLevel: r.requiredApprovalLevel,
			riskLevel: r.riskLevel,
			status: r.status,
			payloadHash: r.payloadHash
		}))
	);

	return {
		tab,
		filters,
		findingStatuses: rawFindingStatus.length === 0 ? [...ACTIVE_STATUSES] : findingStatuses,
		proposals: proposalRows.map((p) => ({
			...p,
			// La légalité est décidée SERVEUR (règle JOB-007) : l'interface propose
			// exactement ce que les endpoints accepteront, jamais plus.
			abilities: proposalAbilities({
				status: p.status,
				requiredApprovalLevel: p.requiredApprovalLevel,
				actorType: locals.user ? 'user' : 'agent'
			})
		})),
		findings: findingRows,
		lots,
		excludedFromLots: excluded,
		proposalCounts,
		findingCounts,
		proposalTotal,
		findingTotal,
		// L'heure du SERVEUR, au format DB : les écarts affichés se calculent contre
		// elle, jamais contre l'horloge du navigateur.
		now: toDbTimestamp(new Date())
	};
};
