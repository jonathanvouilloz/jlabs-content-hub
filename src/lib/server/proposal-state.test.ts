import { describe, it, expect } from 'vitest';
import {
	canActorApprove,
	isApprovalValid,
	statusAfterPayloadChange,
	isTerminalProposalStatus,
	PROPOSAL_STATUSES,
	APPROVAL_LEVELS,
	APPROVAL_STATUSES,
	APPROVER_TYPES,
	APPROVAL_METHODS,
	VERIFICATION_STATUSES,
	AGENT_RUN_STATUSES,
	OUTPUT_TYPES
} from './proposal-state.js';

describe('vocabulaire SPEC §7.8/§12.1', () => {
	it('9 statuts de proposition (7 §7.8 + invalidated + expired), sans doublon', () => {
		expect(PROPOSAL_STATUSES).toHaveLength(9);
		expect(new Set(PROPOSAL_STATUSES).size).toBe(9);
		expect(PROPOSAL_STATUSES).toContain('invalidated');
		expect(PROPOSAL_STATUSES).toContain('expired');
	});
	it('niveaux L0–L4', () => {
		expect(APPROVAL_LEVELS).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
	});
	it('statuts d’approbation, méthodes, acteurs, vérif, agent runs', () => {
		expect(APPROVAL_STATUSES).toContain('invalidated');
		expect(APPROVER_TYPES).toEqual(['user', 'agent', 'policy']);
		expect(APPROVAL_METHODS).toContain('telegram');
		expect(VERIFICATION_STATUSES).toEqual(['pending', 'passed', 'failed', 'skipped']);
		expect(AGENT_RUN_STATUSES).toEqual(['running', 'succeeded', 'failed']);
		expect(OUTPUT_TYPES).toEqual(['proposal', 'report']);
	});
});

describe('canActorApprove (un agent ne peut pas élever son niveau, §12.2)', () => {
	it('un agent peut approuver L0–L2, pas L3/L4', () => {
		expect(canActorApprove({ actorType: 'agent', level: 'L0' })).toBe(true);
		expect(canActorApprove({ actorType: 'agent', level: 'L2' })).toBe(true);
		expect(canActorApprove({ actorType: 'agent', level: 'L3' })).toBe(false);
		expect(canActorApprove({ actorType: 'agent', level: 'L4' })).toBe(false);
	});
	it('une policy peut jusqu’à L3, jamais L4 (jamais auto par config)', () => {
		expect(canActorApprove({ actorType: 'policy', level: 'L3' })).toBe(true);
		expect(canActorApprove({ actorType: 'policy', level: 'L4' })).toBe(false);
	});
	it('un user peut tous les niveaux, y compris L4', () => {
		for (const level of APPROVAL_LEVELS) {
			expect(canActorApprove({ actorType: 'user', level })).toBe(true);
		}
	});
	it('acteur ou niveau inconnu → refus par défaut', () => {
		expect(canActorApprove({ actorType: 'bogus', level: 'L0' })).toBe(false);
		expect(canActorApprove({ actorType: 'agent', level: 'L9' })).toBe(false);
	});
});

describe('isApprovalValid (modifier le payload invalide l’approbation, §12.2)', () => {
	const base = {
		status: 'active',
		approvedPayloadHash: 'abc',
		currentPayloadHash: 'abc',
		now: '2026-07-22T10:00:00.000Z'
	};
	it('active + hash égal + non expirée → valide', () => {
		expect(isApprovalValid(base)).toBe(true);
	});
	it('hash différent (payload modifié) → invalide', () => {
		expect(isApprovalValid({ ...base, currentPayloadHash: 'xyz' })).toBe(false);
	});
	it('statut non actif → invalide', () => {
		expect(isApprovalValid({ ...base, status: 'invalidated' })).toBe(false);
		expect(isApprovalValid({ ...base, status: 'consumed' })).toBe(false);
	});
	it('expirée (now >= expiresAt) → invalide', () => {
		expect(
			isApprovalValid({ ...base, expiresAt: '2026-07-22T09:00:00.000Z' })
		).toBe(false);
	});
	it('non expirée (now < expiresAt) → valide', () => {
		expect(
			isApprovalValid({ ...base, expiresAt: '2026-07-22T11:00:00.000Z' })
		).toBe(true);
	});
	it('sans expiration → valide', () => {
		expect(isApprovalValid({ ...base, expiresAt: null })).toBe(true);
	});
});

describe('statusAfterPayloadChange', () => {
	it('une proposition approuvée retombe à invalidated', () => {
		expect(statusAfterPayloadChange('approved')).toBe('invalidated');
	});
	it('proposed/invalidated → proposed', () => {
		expect(statusAfterPayloadChange('proposed')).toBe('proposed');
		expect(statusAfterPayloadChange('invalidated')).toBe('proposed');
	});
	it('autres statuts inchangés', () => {
		expect(statusAfterPayloadChange('executing')).toBe('executing');
	});
});

describe('isTerminalProposalStatus', () => {
	it('executed/failed/rejected/superseded/expired sont terminaux', () => {
		expect(isTerminalProposalStatus('executed')).toBe(true);
		expect(isTerminalProposalStatus('rejected')).toBe(true);
		expect(isTerminalProposalStatus('expired')).toBe(true);
	});
	it('proposed/approved/executing ne le sont pas', () => {
		expect(isTerminalProposalStatus('proposed')).toBe(false);
		expect(isTerminalProposalStatus('approved')).toBe(false);
		expect(isTerminalProposalStatus('executing')).toBe(false);
	});
});
