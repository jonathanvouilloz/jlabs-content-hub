/**
 * DASH-005 — Cœur PUR de l'inbox de propositions.
 *
 * Miroir exact de `job-console.ts` pour l'autre file d'attente du cockpit : celle
 * des décisions. La console ne décide rien de neuf sur les propositions — elle
 * RÉVÈLE ce que DATA-006 et AGT-000 y ont déjà écrit, et rend légal à l'écran
 * exactement ce que les gardes serveur accepteront.
 *
 * Quatre choses se raisonnent sans la base, donc quatre choses vivent ici :
 *
 *   1. `normalizeProposalFilters` — ce qui vient de l'URL est réduit au vocabulaire
 *      connu AVANT d'atteindre une requête. Une valeur inventée est ÉCARTÉE, jamais
 *      transmise.
 *   2. `canApprove` / `canReject` / `canRequestChanges` — la légalité d'une décision,
 *      pour que l'interface n'offre pas un bouton que l'endpoint refusera.
 *   3. `buildApprovalLots` — l'acceptation « grouper uniquement lots homogènes » et
 *      « L4 n'a pas de bouton tout approuver ». C'est ICI que L4 est exclu, dans du
 *      code pur qu'un test ferme : une règle qui ne vit que dans un `{#if}` de page
 *      se contourne au premier refactor de template.
 *   4. `explainProposal` — pourquoi cette proposition n'est pas décidable. Sans ça,
 *      un bouton grisé ne dit rien, et une proposition `superseded` ressemble à une
 *      proposition oubliée.
 *
 * Ce module reste SERVEUR : il dépend du vocabulaire d'autorisation (§12.1/§12.2)
 * qui vit avec les propositions. Les libellés sont dans `$lib/utils/proposal-format.ts`
 * — une page Svelte ne peut pas importer `$lib/server`, et la CLI devra traduire pareil.
 *
 * Aucun accès DB : ces fonctions décident, elles n'observent pas.
 */
import {
	APPROVAL_LEVELS,
	PROPOSAL_STATUSES,
	canActorApprove,
	isDecidableStatus,
	isTerminalProposalStatus,
	type ApprovalLevel,
	type ProposalStatus
} from './proposal-state.js';
import { RISK_LEVELS, type RiskLevel } from './proposer-state.js';

// ── Filtres ─────────────────────────────────────────────────────────

export interface ProposalFilters {
	statuses: ProposalStatus[];
	levels: ApprovalLevel[];
	risks: RiskLevel[];
	projectSlug: string | null;
	actionType: string | null;
	limit: number;
	offset: number;
}

export const PROPOSALS_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Statuts affichés quand l'URL n'en impose aucun : ceux qui ATTENDENT quelqu'un.
 *
 * Même choix que `listFindings`, qui filtre par défaut sur `ACTIVE_STATUSES` : une
 * inbox qui s'ouvrirait sur « tout » noierait les 4 décisions à prendre sous les
 * propositions périmées des semaines passées — et une inbox qu'on ne peut pas vider
 * cesse d'être lue. `approved` en fait partie : rien ne l'exécute encore, elle reste
 * donc une chose à suivre, pas une chose classée.
 */
export const OPEN_PROPOSAL_STATUSES: readonly ProposalStatus[] = [
	'proposed',
	'invalidated',
	'changes_requested',
	'approved'
];

/** Ce que la page sait lire dans l'URL (`?status=proposed&level=L3&risk=high`). */
export interface RawProposalFilters {
	status?: string | null;
	level?: string | null;
	risk?: string | null;
	project?: string | null;
	action?: string | null;
	limit?: string | null;
	offset?: string | null;
}

function splitList(raw: string | null | undefined): string[] {
	return (raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Réduit des paramètres d'URL au vocabulaire connu.
 *
 * Une valeur hors vocabulaire est ÉCARTÉE et non refusée : un lien périmé doit
 * afficher l'inbox, pas une erreur. La garantie qui compte est l'inverse — rien
 * d'inconnu ne descend jusqu'à la requête. `projectSlug` et `actionType` restent
 * libres : ce sont des valeurs LIÉES (`$n`), jamais concaténées.
 *
 * `status` absent → `OPEN_PROPOSAL_STATUSES`. Mais `status` présent et entièrement
 * INVALIDE (`?status=bogus`) rend une liste vide, c'est-à-dire « aucun filtre de
 * statut » : ne pas retomber sur le défaut est délibéré — l'utilisateur a demandé
 * autre chose que le défaut, lui rendre le défaut lui ferait croire qu'il regarde
 * son filtre.
 */
export function normalizeProposalFilters(raw: RawProposalFilters): ProposalFilters {
	const rawStatus = splitList(raw.status);
	const statuses = rawStatus.filter((s): s is ProposalStatus =>
		(PROPOSAL_STATUSES as readonly string[]).includes(s)
	);
	const levels = splitList(raw.level).filter((l): l is ApprovalLevel =>
		(APPROVAL_LEVELS as readonly string[]).includes(l)
	);
	const risks = splitList(raw.risk).filter((r): r is RiskLevel =>
		(RISK_LEVELS as readonly string[]).includes(r)
	);

	const parsedLimit = Number(raw.limit);
	const limit =
		Number.isFinite(parsedLimit) && parsedLimit > 0
			? Math.min(Math.floor(parsedLimit), MAX_PAGE_SIZE)
			: PROPOSALS_PAGE_SIZE;

	const parsedOffset = Number(raw.offset);
	const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? Math.floor(parsedOffset) : 0;

	return {
		statuses: rawStatus.length === 0 ? [...OPEN_PROPOSAL_STATUSES] : [...new Set(statuses)],
		levels: [...new Set(levels)],
		risks: [...new Set(risks)],
		projectSlug: raw.project?.trim() || null,
		actionType: raw.action?.trim() || null,
		limit,
		offset
	};
}

// ── Légalité des décisions ──────────────────────────────────────────

/** Ce qu'un humain peut faire d'une proposition, ici et maintenant. */
export interface ProposalAbilities {
	approve: boolean;
	reject: boolean;
	requestChanges: boolean;
}

/**
 * Décisions légales sur une proposition, pour un acteur donné.
 *
 * Deux gardes de rang différent, et il faut les deux : le STATUT (a-t-on encore le
 * droit de décider ?) et le NIVEAU (cet acteur peut-il accorder celui-là ?). Un
 * `user` peut tout accorder, y compris L4 — c'est la définition de L4 ; mais
 * `approve` reste faux sur une proposition déjà `executing`, et `reject` reste
 * possible sur une proposition dont l'acteur ne pourrait PAS accorder le niveau :
 * refuser, c'est ne rien accorder, aucune escalade n'est en jeu.
 */
export function proposalAbilities(input: {
	status: string;
	requiredApprovalLevel: string;
	actorType: string;
}): ProposalAbilities {
	const decidable = isDecidableStatus(input.status);
	return {
		approve:
			decidable &&
			canActorApprove({ actorType: input.actorType, level: input.requiredApprovalLevel }),
		reject: decidable,
		// Demander une révision sur une proposition déjà en révision ne dit rien de
		// neuf et écraserait la raison précédente.
		requestChanges: decidable && input.status !== 'changes_requested'
	};
}

// ── Lots homogènes (« L4 n'a pas de bouton tout approuver ») ─────────

/** Le minimum qu'un élément doit porter pour être groupé. */
export interface LotCandidate {
	id: string;
	projectId: string;
	projectSlug: string | null;
	actionType: string;
	requiredApprovalLevel: string;
	riskLevel: string | null;
	status: string;
	payloadHash: string;
}

export interface ApprovalLot {
	/** Clé stable du lot : `projet∷action∷niveau∷risque`. */
	key: string;
	projectId: string;
	projectSlug: string | null;
	actionType: string;
	level: string;
	risk: string;
	/** Les items du lot, avec le hash à renvoyer pour chacun. */
	items: { id: string; payloadHash: string }[];
}

export interface ApprovalLotsResult {
	lots: ApprovalLot[];
	/**
	 * Ce qui n'a pas pu être groupé, et pourquoi. Toujours rendu : un lot qui tait
	 * ce qu'il laisse dehors se lit comme « tout est couvert » (leçon FIND-003 —
	 * `matched` complet exposé à côté de `selected`).
	 */
	excluded: { id: string; reason: string }[];
}

/** Séparateur de clé de lot : ASCII Unit Separator, jamais présent dans un slug ou
 *  un type d'action — même discipline que `FINDING_FINGERPRINT_SEP`. */
export const LOT_KEY_SEP = '\x1f';

/**
 * Groupe des propositions en lots STRICTEMENT homogènes : même projet, même type
 * d'action, même niveau d'autorisation, même risque.
 *
 * Trois exclusions, dans cet ordre :
 *   1. **L4, toujours** — §12.1 en fait la classe des gestes irréversibles (301,
 *      canonical, suppression, désindexation). Une validation groupée est une
 *      décision prise sur un résumé ; L4 exige d'avoir vu la cible. Le bouton
 *      n'existe donc pas, plutôt que d'exister et de refuser.
 *   2. les statuts non décidables (déjà approuvées, engagées ou closes) ;
 *   3. les lots d'UN SEUL élément — approuver « le lot » d'un item est l'action
 *      individuelle, avec un mot de plus et une confirmation de moins.
 *
 * Le risque `null` forme sa propre classe (`inconnu`) et ne se mélange jamais à
 * `low` : ne pas savoir n'est pas savoir que c'est faible.
 */
export function buildApprovalLots(candidates: LotCandidate[]): ApprovalLotsResult {
	const groups = new Map<string, ApprovalLot>();
	const excluded: { id: string; reason: string }[] = [];

	for (const c of candidates) {
		if (c.requiredApprovalLevel === 'L4') {
			excluded.push({
				id: c.id,
				reason: 'niveau L4 : validation individuelle obligatoire (§12.1)'
			});
			continue;
		}
		if (!isDecidableStatus(c.status)) {
			excluded.push({
				id: c.id,
				reason: isTerminalProposalStatus(c.status)
					? `statut ${c.status} : décision déjà close`
					: `statut ${c.status} : déjà engagée`
			});
			continue;
		}

		const risk = c.riskLevel ?? 'inconnu';
		const key = [c.projectId, c.actionType, c.requiredApprovalLevel, risk].join(LOT_KEY_SEP);
		const lot = groups.get(key);
		if (lot) {
			lot.items.push({ id: c.id, payloadHash: c.payloadHash });
		} else {
			groups.set(key, {
				key,
				projectId: c.projectId,
				projectSlug: c.projectSlug,
				actionType: c.actionType,
				level: c.requiredApprovalLevel,
				risk,
				items: [{ id: c.id, payloadHash: c.payloadHash }]
			});
		}
	}

	const lots: ApprovalLot[] = [];
	for (const lot of groups.values()) {
		if (lot.items.length < 2) {
			excluded.push({
				id: lot.items[0].id,
				reason: 'seule de sa catégorie : à décider individuellement'
			});
			continue;
		}
		lots.push(lot);
	}

	return { lots, excluded };
}

// ── Verdict lisible ─────────────────────────────────────────────────

export interface ProposalExplanation {
	/** Où en est cette proposition, en une phrase. */
	verdict: string;
	/** Ce qu'il y a à faire — ou l'absence d'action utile. */
	action: string;
}

/**
 * Traduit l'état d'une proposition en verdict d'exploitant.
 *
 * Porte l'acceptation implicite de toute console : comprendre sans lire la DB.
 * `superseded` et `invalidated` sont les deux cas où le silence coûterait cher —
 * l'un veut dire « la machine en a écrit une meilleure », l'autre « ton approbation
 * est tombée avec le payload », et rien à l'écran ne les distingue autrement.
 */
export function explainProposal(input: {
	status: string;
	requiredApprovalLevel: string;
	actorType: string;
}): ProposalExplanation {
	switch (input.status) {
		case 'proposed':
			return canActorApprove({ actorType: input.actorType, level: input.requiredApprovalLevel })
				? {
						verdict: 'En attente de décision.',
						action: `Approuver, rejeter ou demander une révision (niveau ${input.requiredApprovalLevel}).`
					}
				: {
						verdict: `Niveau ${input.requiredApprovalLevel} : hors de portée de cet acteur (§12.2).`,
						action: 'Seul un humain peut accorder ce niveau — un agent ne se l’accorde jamais.'
					};
		case 'changes_requested':
			return {
				verdict: 'Révision demandée : l’intention tient, sa forme reste à revoir.',
				action:
					'La proposition ne repartira pas d’elle-même et le run hebdomadaire ne l’écrasera pas. ' +
					'Un humain la rouvre en l’approuvant ou en la rejetant.'
			};
		case 'invalidated':
			return {
				verdict: 'Le payload a changé depuis l’approbation : celle-ci est tombée.',
				action: 'Re-décider sur le contenu ACTUEL — l’ancienne approbation ne couvre plus rien.'
			};
		case 'approved':
			return {
				verdict: 'Approuvée. L’approbation est liée au hash affiché.',
				action:
					'Rien n’exécute encore les propositions : cette décision est journalisée, ' +
					'elle ne déclenche aucune action.'
			};
		case 'superseded':
			return {
				verdict: 'Remplacée par une proposition plus récente sur la même cible.',
				action: 'Rien à faire — la version vivante porte les mesures à jour.'
			};
		case 'rejected':
			return {
				verdict: 'Rejetée par un humain.',
				action: 'La raison est au journal du finding. Une re-détection ne la ressuscite pas.'
			};
		case 'expired':
			return {
				verdict: 'Expirée avant décision.',
				action: 'Attendre qu’une nouvelle détection la reproduise, si le problème tient toujours.'
			};
		case 'executing':
			return { verdict: 'Exécution en cours.', action: 'Suivre le job d’exécution rattaché.' };
		case 'executed':
			return {
				verdict: 'Exécutée.',
				action: 'La vérification post-exécution dit si l’effet attendu a eu lieu.'
			};
		case 'failed':
			return {
				verdict: 'L’exécution a échoué.',
				action: 'Lire le job rattaché : c’est lui qui porte la cause classée.'
			};
		default:
			return {
				verdict: `Statut inconnu (${input.status}).`,
				action: 'Aucune décision proposée : on n’agit pas sur ce qu’on ne sait pas lire.'
			};
	}
}
