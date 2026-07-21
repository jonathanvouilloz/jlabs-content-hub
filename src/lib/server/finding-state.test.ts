import { describe, it, expect } from 'vitest';
import {
	deriveFindingFingerprint,
	computePriorityScore,
	clampScore,
	deriveSeverityEventType,
	deriveStatusEventType,
	isTerminalStatus,
	FINDING_FINGERPRINT_SEP,
	FINDING_TYPES,
	FINDING_STATUSES,
	FINDING_SEVERITIES,
	FINDING_ENTITY_TYPES,
	FINDING_EVENT_TYPES,
	FINDING_ACTORS,
	PRIORITY_WEIGHTS
} from './finding-state.js';

describe('vocabulaire SPEC §7.6/§10.4', () => {
	it('expose les 20 types du catalogue initial, sans doublon', () => {
		expect(FINDING_TYPES).toHaveLength(20);
		expect(new Set(FINDING_TYPES).size).toBe(20);
	});
	it('statuts = 7 de §7.6 + reopened, sans doublon', () => {
		expect(FINDING_STATUSES).toHaveLength(8);
		expect(new Set(FINDING_STATUSES).size).toBe(8);
		expect(FINDING_STATUSES).toContain('reopened');
		expect(FINDING_STATUSES).not.toContain('new'); // transitoire, non persisté
	});
	it('sévérités ordonnées info→critical', () => {
		expect(FINDING_SEVERITIES).toEqual(['info', 'low', 'medium', 'high', 'critical']);
	});
	it('entités et acteurs couvrent la spec', () => {
		expect(FINDING_ENTITY_TYPES).toEqual(['project', 'query', 'page', 'review', 'integration']);
		expect(FINDING_ACTORS).toContain('agent');
		expect(FINDING_ACTORS).toContain('detector');
		expect(FINDING_EVENT_TYPES).toContain('created');
		expect(FINDING_EVENT_TYPES).toContain('resolved');
	});
});

describe('deriveFindingFingerprint (dédup : même problème = même finding)', () => {
	it('assemble une clé déterministe type+entité+clé', () => {
		const key = deriveFindingFingerprint({
			type: 'ctr_gap',
			entityType: 'page',
			entityKey: 'https://ex.ch/p'
		});
		expect(key).toBe(['ctr_gap', 'page', 'https://ex.ch/p'].join(FINDING_FINGERPRINT_SEP));
	});
	it('est stable (mêmes entrées → même clé sur deux semaines)', () => {
		const input = { type: 'keyword_decline', entityType: 'query', entityKey: 'muay thai geneve' };
		expect(deriveFindingFingerprint(input)).toBe(deriveFindingFingerprint(input));
	});
	it('intègre les discriminants (device change → clé différente)', () => {
		const base = { type: 'keyword_decline', entityType: 'query', entityKey: 'q' };
		expect(deriveFindingFingerprint({ ...base, discriminators: ['MOBILE'] })).not.toBe(
			deriveFindingFingerprint({ ...base, discriminators: ['DESKTOP'] })
		);
	});
	it('type différent → clé différente', () => {
		expect(deriveFindingFingerprint({ type: 'ctr_gap', entityType: 'page', entityKey: 'p' })).not.toBe(
			deriveFindingFingerprint({ type: 'content_decay', entityType: 'page', entityKey: 'p' })
		);
	});
	it('rejette type/entité manquants', () => {
		expect(() => deriveFindingFingerprint({ type: '', entityType: 'page' })).toThrow();
		expect(() => deriveFindingFingerprint({ type: 'ctr_gap', entityType: '' })).toThrow();
	});
	it('rejette une partie contenant le séparateur réservé', () => {
		expect(() =>
			deriveFindingFingerprint({
				type: 'ctr_gap',
				entityType: 'page',
				entityKey: `a${FINDING_FINGERPRINT_SEP}b`
			})
		).toThrow();
	});
});

describe('computePriorityScore (barème §10.2)', () => {
	it('somme les 4 composantes', () => {
		expect(
			computePriorityScore({ impact: 40, urgency: 25, confidence: 20, strategicFit: 15 })
		).toBe(100);
		expect(computePriorityScore({ impact: 10, urgency: 5, confidence: 8, strategicFit: 3 })).toBe(26);
	});
	it('borne chaque composante à son plafond', () => {
		// impact demandé à 999 → plafonné à 40, le reste à 0.
		expect(
			computePriorityScore({ impact: 999, urgency: 0, confidence: 0, strategicFit: 0 })
		).toBe(PRIORITY_WEIGHTS.impact);
	});
	it('somme maximale bornée à 100', () => {
		expect(
			computePriorityScore({ impact: 999, urgency: 999, confidence: 999, strategicFit: 999 })
		).toBe(100);
	});
	it('valeurs négatives ramenées à 0', () => {
		expect(
			computePriorityScore({ impact: -5, urgency: -1, confidence: 0, strategicFit: 0 })
		).toBe(0);
	});
});

describe('clampScore', () => {
	it('borne et arrondit', () => {
		expect(clampScore(120)).toBe(100);
		expect(clampScore(-10)).toBe(0);
		expect(clampScore(42.6)).toBe(43);
		expect(clampScore(Number.NaN)).toBe(0);
	});
});

describe('deriveSeverityEventType', () => {
	it('sévérité qui monte = aggravated', () => {
		expect(deriveSeverityEventType('low', 'high')).toBe('aggravated');
	});
	it('sévérité qui baisse = improved', () => {
		expect(deriveSeverityEventType('critical', 'medium')).toBe('improved');
	});
	it('sévérité inchangée = null (pas d’événement)', () => {
		expect(deriveSeverityEventType('high', 'high')).toBeNull();
	});
	it('sévérité inconnue = null (pas d’événement inventé)', () => {
		expect(deriveSeverityEventType('bogus', 'high')).toBeNull();
	});
});

describe('deriveStatusEventType', () => {
	it('vers resolved → resolved', () => {
		expect(deriveStatusEventType('in_progress', 'resolved')).toBe('resolved');
	});
	it('vers dismissed → rejected', () => {
		expect(deriveStatusEventType('open', 'dismissed')).toBe('rejected');
	});
	it('depuis un terminal vers open → reopened', () => {
		expect(deriveStatusEventType('resolved', 'open')).toBe('reopened');
		expect(deriveStatusEventType('dismissed', 'reopened')).toBe('reopened');
	});
	it('depuis un actif vers open → validated (pas une réouverture)', () => {
		expect(deriveStatusEventType('snoozed', 'open')).toBe('validated');
	});
	it('statut inchangé → null', () => {
		expect(deriveStatusEventType('open', 'open')).toBeNull();
	});
	it('transitions intermédiaires → validated', () => {
		expect(deriveStatusEventType('open', 'acknowledged')).toBe('validated');
		expect(deriveStatusEventType('acknowledged', 'planned')).toBe('validated');
	});
});

describe('isTerminalStatus', () => {
	it('resolved et dismissed sont terminaux', () => {
		expect(isTerminalStatus('resolved')).toBe(true);
		expect(isTerminalStatus('dismissed')).toBe(true);
	});
	it('les états actifs ne le sont pas', () => {
		expect(isTerminalStatus('open')).toBe(false);
		expect(isTerminalStatus('snoozed')).toBe(false);
	});
});
