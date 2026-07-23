import { describe, it, expect } from 'vitest';
import {
	normalizeProposalFilters,
	proposalAbilities,
	buildApprovalLots,
	explainProposal,
	OPEN_PROPOSAL_STATUSES,
	PROPOSALS_PAGE_SIZE,
	LOT_KEY_SEP,
	type LotCandidate
} from './proposal-console.js';

describe('normalizeProposalFilters (rien d’inconnu n’atteint la requête)', () => {
	it('sans paramètre : les statuts OUVERTS, pas « tout »', () => {
		const f = normalizeProposalFilters({});
		expect(f.statuses).toEqual([...OPEN_PROPOSAL_STATUSES]);
		expect(f.limit).toBe(PROPOSALS_PAGE_SIZE);
		expect(f.offset).toBe(0);
		expect(f.projectSlug).toBeNull();
	});

	it('une valeur hors vocabulaire est ÉCARTÉE, pas refusée', () => {
		const f = normalizeProposalFilters({ status: 'proposed,bogus', level: 'L3,L9', risk: 'high,x' });
		expect(f.statuses).toEqual(['proposed']);
		expect(f.levels).toEqual(['L3']);
		expect(f.risks).toEqual(['high']);
	});

	it('un filtre de statut entièrement invalide ne retombe PAS sur le défaut', () => {
		// L'utilisateur a demandé autre chose que le défaut : lui rendre le défaut lui
		// ferait croire qu'il regarde son filtre.
		expect(normalizeProposalFilters({ status: 'bogus' }).statuses).toEqual([]);
	});

	it('déduplique : `?status=proposed,proposed` ne double pas un paramètre lié', () => {
		expect(normalizeProposalFilters({ status: 'proposed,proposed' }).statuses).toEqual(['proposed']);
	});

	it('projet et action restent libres (valeurs liées), trimés, vide → null', () => {
		const f = normalizeProposalFilters({ project: ' jonlabs ', action: ' meta_rewrite ' });
		expect(f.projectSlug).toBe('jonlabs');
		expect(f.actionType).toBe('meta_rewrite');
		expect(normalizeProposalFilters({ project: '   ' }).projectSlug).toBeNull();
	});

	it('limit borné, offset négatif ou illisible ramené à 0', () => {
		expect(normalizeProposalFilters({ limit: '5000' }).limit).toBe(200);
		expect(normalizeProposalFilters({ limit: '0' }).limit).toBe(PROPOSALS_PAGE_SIZE);
		expect(normalizeProposalFilters({ limit: 'abc' }).limit).toBe(PROPOSALS_PAGE_SIZE);
		expect(normalizeProposalFilters({ offset: '-3' }).offset).toBe(0);
		expect(normalizeProposalFilters({ offset: '80' }).offset).toBe(80);
	});
});

describe('proposalAbilities (l’écran ne propose que ce que le serveur acceptera)', () => {
	const user = (status: string, level = 'L3') =>
		proposalAbilities({ status, requiredApprovalLevel: level, actorType: 'user' });

	it('une proposition à décider : les trois décisions sont offertes', () => {
		expect(user('proposed')).toEqual({ approve: true, reject: true, requestChanges: true });
	});

	it('une proposition engagée ou close n’offre plus rien', () => {
		for (const status of ['approved', 'executing', 'executed', 'rejected', 'superseded', 'expired']) {
			expect(user(status)).toEqual({ approve: false, reject: false, requestChanges: false });
		}
	});

	it('`invalidated` reste décidable : l’approbation est tombée, pas la proposition', () => {
		expect(user('invalidated')).toEqual({ approve: true, reject: true, requestChanges: true });
	});

	it('on ne redemande pas une révision déjà demandée (ça écraserait la raison)', () => {
		expect(user('changes_requested')).toEqual({
			approve: true,
			reject: true,
			requestChanges: false
		});
	});

	it('un agent ne peut pas approuver une L3, mais peut la rejeter (refuser n’accorde rien)', () => {
		const agent = proposalAbilities({
			status: 'proposed',
			requiredApprovalLevel: 'L3',
			actorType: 'agent'
		});
		expect(agent.approve).toBe(false);
		expect(agent.reject).toBe(true);
	});

	it('un humain peut approuver une L4', () => {
		expect(user('proposed', 'L4').approve).toBe(true);
	});

	it('un niveau inconnu n’est jamais approuvable (refus par défaut)', () => {
		expect(user('proposed', 'L9').approve).toBe(false);
	});
});

describe('buildApprovalLots (lots homogènes, L4 jamais groupée)', () => {
	const item = (over: Partial<LotCandidate> & { id: string }): LotCandidate => ({
		projectId: 'p1',
		projectSlug: 'jonlabs',
		actionType: 'meta_rewrite',
		requiredApprovalLevel: 'L3',
		riskLevel: 'medium',
		status: 'proposed',
		payloadHash: `hash-${over.id}`,
		...over
	});

	it('regroupe ce qui est identique sur les quatre axes', () => {
		const { lots } = buildApprovalLots([item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]);
		expect(lots).toHaveLength(1);
		expect(lots[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
		expect(lots[0].items[0].payloadHash).toBe('hash-a');
		expect(lots[0].key.split(LOT_KEY_SEP)).toEqual(['p1', 'meta_rewrite', 'L3', 'medium']);
	});

	it('ne mélange JAMAIS deux projets, deux actions, deux niveaux ou deux risques', () => {
		const { lots } = buildApprovalLots([
			item({ id: 'a' }),
			item({ id: 'b' }),
			item({ id: 'c', projectId: 'p2' }),
			item({ id: 'd', projectId: 'p2' }),
			item({ id: 'e', actionType: 'content_refresh' }),
			item({ id: 'f', actionType: 'content_refresh' }),
			item({ id: 'g', riskLevel: 'high' }),
			item({ id: 'h', riskLevel: 'high' })
		]);
		expect(lots).toHaveLength(4);
		for (const lot of lots) {
			expect(new Set(lot.items.map((i) => i.id)).size).toBe(2);
		}
	});

	it('une L4 n’entre dans AUCUN lot, même à plusieurs (§12.1)', () => {
		const { lots, excluded } = buildApprovalLots([
			item({ id: 'a', actionType: 'redirect_301', requiredApprovalLevel: 'L4', riskLevel: 'high' }),
			item({ id: 'b', actionType: 'redirect_301', requiredApprovalLevel: 'L4', riskLevel: 'high' })
		]);
		expect(lots).toEqual([]);
		expect(excluded.map((e) => e.id).sort()).toEqual(['a', 'b']);
		expect(excluded[0].reason).toContain('L4');
	});

	it('un statut non décidable est exclu, et le motif distingue « close » de « engagée »', () => {
		const { lots, excluded } = buildApprovalLots([
			item({ id: 'a' }),
			item({ id: 'b' }),
			item({ id: 'c', status: 'rejected' }),
			item({ id: 'd', status: 'executing' })
		]);
		expect(lots[0].items.map((i) => i.id)).toEqual(['a', 'b']);
		expect(excluded.find((e) => e.id === 'c')?.reason).toContain('close');
		expect(excluded.find((e) => e.id === 'd')?.reason).toContain('engagée');
	});

	it('un élément seul de sa catégorie n’est pas un lot, et il est NOMMÉ', () => {
		const { lots, excluded } = buildApprovalLots([item({ id: 'seul' })]);
		expect(lots).toEqual([]);
		expect(excluded).toEqual([
			{ id: 'seul', reason: 'seule de sa catégorie : à décider individuellement' }
		]);
	});

	it('un risque `null` forme sa propre classe : ne pas savoir ≠ savoir que c’est faible', () => {
		const { lots } = buildApprovalLots([
			item({ id: 'a', riskLevel: null }),
			item({ id: 'b', riskLevel: null }),
			item({ id: 'c', riskLevel: 'low' }),
			item({ id: 'd', riskLevel: 'low' })
		]);
		expect(lots).toHaveLength(2);
		expect(lots.find((l) => l.risk === 'inconnu')?.items.map((i) => i.id)).toEqual(['a', 'b']);
	});

	it('rien en entrée → aucun lot, aucune exclusion', () => {
		expect(buildApprovalLots([])).toEqual({ lots: [], excluded: [] });
	});
});

describe('explainProposal (comprendre sans lire la DB)', () => {
	const forUser = (status: string, level = 'L3') =>
		explainProposal({ status, requiredApprovalLevel: level, actorType: 'user' });

	it('`invalidated` dit que le payload a bougé, pas que quelqu’un a refusé', () => {
		expect(forUser('invalidated').verdict).toContain('payload');
		expect(forUser('rejected').verdict).toContain('Rejetée');
	});

	it('`superseded` dit qu’il n’y a rien à faire', () => {
		expect(forUser('superseded').action).toContain('Rien à faire');
	});

	it('`approved` dit qu’aucune exécution n’en découle (rien n’exécute encore)', () => {
		expect(forUser('approved').action).toContain('aucune action');
	});

	it('`changes_requested` dit que le run hebdomadaire ne l’écrasera pas', () => {
		expect(forUser('changes_requested').action).toContain('hebdomadaire');
	});

	it('une L3 vue par un agent explique le refus par le niveau', () => {
		const e = explainProposal({
			status: 'proposed',
			requiredApprovalLevel: 'L3',
			actorType: 'agent'
		});
		expect(e.verdict).toContain('L3');
		expect(e.action).toContain('humain');
	});

	it('un statut inconnu ne propose aucune décision', () => {
		expect(forUser('bogus').action).toContain('Aucune décision');
	});
});
