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
	PRIORITY_WEIGHTS,
	ACTIVE_STATUSES,
	LIFECYCLE_DEFAULTS,
	canTransition,
	computeSnoozeUntil,
	decideOnAbsence,
	decideOnRedetection,
	isActiveStatus,
	isSnoozeExpired,
	resolveLifecycleConfig
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
	it('sortie de veille → unsnoozed (ni validation, ni réouverture)', () => {
		expect(deriveStatusEventType('snoozed', 'open')).toBe('unsnoozed');
		expect(deriveStatusEventType('snoozed', 'acknowledged')).toBe('unsnoozed');
	});
	it('depuis la veille vers un terminal garde l’événement terminal', () => {
		expect(deriveStatusEventType('snoozed', 'dismissed')).toBe('rejected');
		expect(deriveStatusEventType('snoozed', 'resolved')).toBe('resolved');
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

// ── FIND-003 — cycle de vie ─────────────────────────────────────────

describe('FIND-003 · statuts actifs (ce qui occupe l’inbox)', () => {
	it('les 5 états actifs, ni terminaux ni en veille', () => {
		expect([...ACTIVE_STATUSES]).toEqual([
			'open',
			'reopened',
			'acknowledged',
			'planned',
			'in_progress'
		]);
	});
	it('snoozed, resolved et dismissed n’occupent pas l’inbox', () => {
		expect(isActiveStatus('snoozed')).toBe(false);
		expect(isActiveStatus('resolved')).toBe(false);
		expect(isActiveStatus('dismissed')).toBe(false);
	});
	it('reopened se comporte comme open', () => {
		expect(isActiveStatus('reopened')).toBe(true);
	});
	it('un statut inconnu n’est jamais actif', () => {
		expect(isActiveStatus('bogus')).toBe(false);
	});
});

describe('FIND-003 · canTransition (graphe §10.1)', () => {
	it('parcours nominal open → … → resolved', () => {
		expect(canTransition('open', 'acknowledged')).toBe(true);
		expect(canTransition('acknowledged', 'planned')).toBe(true);
		expect(canTransition('planned', 'in_progress')).toBe(true);
		expect(canTransition('in_progress', 'resolved')).toBe(true);
	});
	it('les 6 statuts du travail FIND-003 sont atteignables depuis open', () => {
		for (const to of ['acknowledged', 'planned', 'in_progress', 'snoozed', 'dismissed', 'resolved']) {
			expect(canTransition('open', to)).toBe(true);
		}
	});
	it('récidive : resolved → reopened (acceptation 2)', () => {
		expect(canTransition('resolved', 'reopened')).toBe(true);
	});
	it('le dismiss ne se défait que par une réouverture explicite', () => {
		expect(canTransition('dismissed', 'reopened')).toBe(true);
		expect(canTransition('dismissed', 'open')).toBe(true);
		expect(canTransition('dismissed', 'snoozed')).toBe(false);
		expect(canTransition('dismissed', 'resolved')).toBe(false);
	});
	it('sortie de veille vers un état actif ou terminal', () => {
		expect(canTransition('snoozed', 'open')).toBe(true);
		expect(canTransition('snoozed', 'dismissed')).toBe(true);
	});
	it('refuse une transition vers soi-même', () => {
		expect(canTransition('open', 'open')).toBe(false);
		expect(canTransition('snoozed', 'snoozed')).toBe(false);
	});
	it('refuse un statut inconnu des deux côtés (jamais de passage silencieux)', () => {
		expect(canTransition('bogus', 'open')).toBe(false);
		expect(canTransition('open', 'bogus')).toBe(false);
	});
	it('refuse un raccourci illégal (resolved → in_progress)', () => {
		expect(canTransition('resolved', 'in_progress')).toBe(false);
		expect(canTransition('resolved', 'dismissed')).toBe(false);
	});
});

describe('FIND-003 · resolveLifecycleConfig (tolérant, jamais destructeur)', () => {
	it('défauts : 2 fenêtres de confirmation, veille de 14 jours', () => {
		expect(LIFECYCLE_DEFAULTS.autoResolveAfterMisses).toBe(2);
		expect(resolveLifecycleConfig(null)).toEqual(LIFECYCLE_DEFAULTS);
		expect(resolveLifecycleConfig(undefined)).toEqual(LIFECYCLE_DEFAULTS);
	});
	it('applique un override valide', () => {
		expect(resolveLifecycleConfig({ autoResolveAfterMisses: 4 }).autoResolveAfterMisses).toBe(4);
		expect(resolveLifecycleConfig({ defaultSnoozeDays: 30 }).defaultSnoozeDays).toBe(30);
	});
	it('un override corrompu retombe sur le défaut (ne ferme pas l’inbox d’un coup)', () => {
		expect(resolveLifecycleConfig({ autoResolveAfterMisses: 0 }).autoResolveAfterMisses).toBe(2);
		expect(resolveLifecycleConfig({ autoResolveAfterMisses: -3 }).autoResolveAfterMisses).toBe(2);
		expect(
			resolveLifecycleConfig({ autoResolveAfterMisses: Number.NaN }).autoResolveAfterMisses
		).toBe(2);
		expect(
			resolveLifecycleConfig({ autoResolveAfterMisses: 'trois' as unknown as number })
				.autoResolveAfterMisses
		).toBe(2);
	});
	it('tronque une valeur décimale', () => {
		expect(resolveLifecycleConfig({ autoResolveAfterMisses: 3.9 }).autoResolveAfterMisses).toBe(3);
	});
});

describe('FIND-003 · decideOnRedetection (le problème est toujours là)', () => {
	it('un finding résolu qui récidive rouvre (acceptation 2)', () => {
		expect(decideOnRedetection('resolved')).toBe('reopen');
	});
	it('le dismiss tient à vie — jamais de retour spontané dans l’inbox', () => {
		expect(decideOnRedetection('dismissed')).toBe('hold');
	});
	it('le snooze tient — une re-détection ne rompt pas la veille', () => {
		expect(decideOnRedetection('snoozed')).toBe('hold');
	});
	it('un finding actif est simplement rafraîchi (acceptation 1 : une seule ligne)', () => {
		for (const status of ACTIVE_STATUSES) {
			expect(decideOnRedetection(status)).toBe('refresh');
		}
	});
});

describe('FIND-003 · decideOnAbsence (le problème ne se manifeste plus)', () => {
	it('une seule absence ne résout jamais — elle compte', () => {
		expect(decideOnAbsence({ status: 'open', consecutiveMisses: 0 })).toEqual({
			action: 'count',
			nextMisses: 1
		});
	});
	it('résout au seuil exact, pas avant', () => {
		expect(decideOnAbsence({ status: 'open', consecutiveMisses: 1 }).action).toBe('resolve');
		expect(
			decideOnAbsence({
				status: 'open',
				consecutiveMisses: 1,
				config: { autoResolveAfterMisses: 3 }
			}).action
		).toBe('count');
		expect(
			decideOnAbsence({
				status: 'open',
				consecutiveMisses: 2,
				config: { autoResolveAfterMisses: 3 }
			})
		).toEqual({ action: 'resolve', nextMisses: 3 });
	});
	it('ne touche ni la veille, ni le dismiss, ni un finding déjà résolu', () => {
		for (const status of ['snoozed', 'dismissed', 'resolved']) {
			expect(decideOnAbsence({ status, consecutiveMisses: 5 })).toEqual({
				action: 'skip',
				nextMisses: 5
			});
		}
	});
	it('un compteur corrompu repart de zéro plutôt que de résoudre par accident', () => {
		expect(decideOnAbsence({ status: 'open', consecutiveMisses: Number.NaN })).toEqual({
			action: 'count',
			nextMisses: 1
		});
		expect(decideOnAbsence({ status: 'open', consecutiveMisses: -4 })).toEqual({
			action: 'count',
			nextMisses: 1
		});
	});
	it('un finding rouvert se réconcilie comme un finding ouvert', () => {
		expect(decideOnAbsence({ status: 'reopened', consecutiveMisses: 1 }).action).toBe('resolve');
	});
});

describe('FIND-003 · veille (snooze)', () => {
	const REF = '2026-07-22T10:00:00.000Z';

	it('computeSnoozeUntil rend une échéance au format DB', () => {
		expect(computeSnoozeUntil({ days: 7, from: REF })).toBe('2026-07-29 10:00:00');
	});
	it('durée absente ou absurde → défaut (jamais une veille qui expire aussitôt)', () => {
		const byDefault = computeSnoozeUntil({ from: REF });
		expect(byDefault).toBe(computeSnoozeUntil({ days: LIFECYCLE_DEFAULTS.defaultSnoozeDays, from: REF }));
		expect(computeSnoozeUntil({ days: 0, from: REF })).toBe(byDefault);
		expect(computeSnoozeUntil({ days: -5, from: REF })).toBe(byDefault);
		expect(computeSnoozeUntil({ days: Number.NaN, from: REF })).toBe(byDefault);
	});
	it('expire à l’échéance et après, pas avant (acceptation 3)', () => {
		const until = computeSnoozeUntil({ days: 1, from: REF });
		expect(isSnoozeExpired(until, REF)).toBe(false);
		expect(isSnoozeExpired(until, '2026-07-23T09:59:59.000Z')).toBe(false);
		expect(isSnoozeExpired(until, '2026-07-23T10:00:00.000Z')).toBe(true);
		expect(isSnoozeExpired(until, '2026-07-24T00:00:00.000Z')).toBe(true);
	});
	it('une veille sans échéance est réveillée (anomalie, pas sommeil éternel)', () => {
		expect(isSnoozeExpired(null, REF)).toBe(true);
		expect(isSnoozeExpired(undefined, REF)).toBe(true);
		expect(isSnoozeExpired('', REF)).toBe(true);
	});
	it('compare au format DB, jamais à de l’ISO (piège lexical)', () => {
		// '2026-07-22T09:00:00.000Z' > '2026-07-22 23:00:00' en lexical : si `now`
		// n'était pas normalisé, une veille du soir paraîtrait échue le matin.
		expect(isSnoozeExpired('2026-07-22 23:00:00', '2026-07-22T09:00:00.000Z')).toBe(false);
	});
});
