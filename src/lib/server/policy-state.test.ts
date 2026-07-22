import { describe, it, expect } from 'vitest';
import {
	deriveScopeKey,
	nextPolicyVersion,
	canonicalPolicyConfig,
	resolveEffectiveKillSwitch,
	evaluatePolicyGates,
	canAutoSendReview,
	derivePromotionKind,
	POLICY_MODES,
	POLICY_STATUSES,
	POLICY_PROMOTION_KINDS,
	PROJECT_WIDE_SCOPE,
	type PolicyConfig
} from './policy-state.js';

describe('vocabulaire SPEC §7.10', () => {
	it('3 modes d’automatisation', () => {
		expect(POLICY_MODES).toEqual(['draft_only', 'guarded_auto', 'manual']);
	});
	it('2 statuts de version (current | superseded)', () => {
		expect(POLICY_STATUSES).toEqual(['current', 'superseded']);
	});
	it('4 natures de promotion, sans doublon', () => {
		expect(POLICY_PROMOTION_KINDS).toHaveLength(4);
		expect(new Set(POLICY_PROMOTION_KINDS).size).toBe(4);
		expect(POLICY_PROMOTION_KINDS).toContain('kill_switch');
	});
});

describe('deriveScopeKey', () => {
	it('une localisation → son id', () => {
		expect(deriveScopeKey('loc-123')).toBe('loc-123');
	});
	it('null/undefined/vide → sentinelle projet-wide', () => {
		expect(deriveScopeKey(null)).toBe(PROJECT_WIDE_SCOPE);
		expect(deriveScopeKey(undefined)).toBe(PROJECT_WIDE_SCOPE);
		expect(deriveScopeKey('')).toBe(PROJECT_WIDE_SCOPE);
	});
});

describe('nextPolicyVersion', () => {
	it('première version = 1', () => {
		expect(nextPolicyVersion(null)).toBe(1);
		expect(nextPolicyVersion(undefined)).toBe(1);
	});
	it('incrémente la version courante', () => {
		expect(nextPolicyVersion(1)).toBe(2);
		expect(nextPolicyVersion(7)).toBe(8);
	});
});

describe('canonicalPolicyConfig (dédup / versionnage)', () => {
	const a: PolicyConfig = {
		mode: 'guarded_auto',
		syncEnabled: true,
		autoGenerationEnabled: true,
		killSwitch: false,
		minRatingForAutoSend: 5
	};
	it('déterministe pour une même config', () => {
		expect(canonicalPolicyConfig(a)).toBe(canonicalPolicyConfig({ ...a }));
	});
	it('undefined et null sont équivalents (normalisés)', () => {
		expect(canonicalPolicyConfig({ ...a, signature: undefined })).toBe(
			canonicalPolicyConfig({ ...a, signature: null })
		);
	});
	it('un champ différent change la chaîne', () => {
		expect(canonicalPolicyConfig(a)).not.toBe(
			canonicalPolicyConfig({ ...a, minRatingForAutoSend: 4 })
		);
		expect(canonicalPolicyConfig(a)).not.toBe(canonicalPolicyConfig({ ...a, killSwitch: true }));
	});
});

describe('resolveEffectiveKillSwitch (global OU par localisation)', () => {
	it('actif si la localisation le porte', () => {
		expect(resolveEffectiveKillSwitch({ locationKillSwitch: true, projectKillSwitch: false })).toBe(
			true
		);
	});
	it('actif si le projet-wide le porte', () => {
		expect(resolveEffectiveKillSwitch({ locationKillSwitch: false, projectKillSwitch: true })).toBe(
			true
		);
	});
	it('inactif si aucun des deux', () => {
		expect(resolveEffectiveKillSwitch({})).toBe(false);
		expect(
			resolveEffectiveKillSwitch({ locationKillSwitch: false, projectKillSwitch: false })
		).toBe(false);
	});
});

describe('evaluatePolicyGates (le kill switch bloque les envois, JAMAIS la sync)', () => {
	it('kill switch actif → sync toujours autorisée, envoi bloqué', () => {
		const gates = evaluatePolicyGates({
			mode: 'guarded_auto',
			syncEnabled: true,
			autoGenerationEnabled: true,
			killSwitch: true
		});
		expect(gates.syncAllowed).toBe(true); // invariant DATA-007
		expect(gates.autoSendAllowed).toBe(false);
		expect(gates.reason).toBe('kill switch actif');
	});
	it('sync désactivée → syncAllowed false (indépendant du kill switch)', () => {
		expect(
			evaluatePolicyGates({ mode: 'draft_only', syncEnabled: false, killSwitch: false }).syncAllowed
		).toBe(false);
	});
	it('draft_only → jamais d’envoi autonome, sync ok', () => {
		const gates = evaluatePolicyGates({ mode: 'draft_only', syncEnabled: true });
		expect(gates.syncAllowed).toBe(true);
		expect(gates.autoSendAllowed).toBe(false);
	});
	it('guarded_auto + génération auto + pas de kill switch → envoi autorisé', () => {
		const gates = evaluatePolicyGates({
			mode: 'guarded_auto',
			syncEnabled: true,
			autoGenerationEnabled: true,
			killSwitch: false
		});
		expect(gates.autoSendAllowed).toBe(true);
	});
	it('guarded_auto sans génération auto → envoi bloqué', () => {
		expect(
			evaluatePolicyGates({
				mode: 'guarded_auto',
				syncEnabled: true,
				autoGenerationEnabled: false,
				killSwitch: false
			}).autoSendAllowed
		).toBe(false);
	});
});

describe('canAutoSendReview (SPEC §8.4, refus par défaut)', () => {
	const guarded = {
		mode: 'guarded_auto',
		killSwitch: false,
		autoGenerationEnabled: true,
		rating: 5,
		minRatingForAutoSend: 5,
		category: 'positif',
		escalationCategories: ['négatif', 'sensible']
	};
	it('avis 5★ non escaladé sous guarded_auto → autorisé', () => {
		expect(canAutoSendReview(guarded).allowed).toBe(true);
	});
	it('draft_only → jamais', () => {
		expect(canAutoSendReview({ ...guarded, mode: 'draft_only' }).allowed).toBe(false);
	});
	it('manual → jamais', () => {
		expect(canAutoSendReview({ ...guarded, mode: 'manual' }).allowed).toBe(false);
	});
	it('kill switch actif → refus', () => {
		expect(canAutoSendReview({ ...guarded, killSwitch: true }).allowed).toBe(false);
	});
	it('génération auto désactivée → refus', () => {
		expect(canAutoSendReview({ ...guarded, autoGenerationEnabled: false }).allowed).toBe(false);
	});
	it('catégorie escaladée → refus', () => {
		const r = canAutoSendReview({ ...guarded, category: 'sensible' });
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain('sensible');
	});
	it('note < minimale → refus', () => {
		const r = canAutoSendReview({ ...guarded, rating: 3 });
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain('minimale');
	});
});

describe('derivePromotionKind', () => {
	it('pas de précédent → create', () => {
		expect(
			derivePromotionKind({ hadPrevious: false, modeChanged: false, killSwitchChanged: false })
		).toBe('create');
	});
	it('changement de mode prime', () => {
		expect(
			derivePromotionKind({ hadPrevious: true, modeChanged: true, killSwitchChanged: true })
		).toBe('mode_change');
	});
	it('bascule du seul kill switch', () => {
		expect(
			derivePromotionKind({ hadPrevious: true, modeChanged: false, killSwitchChanged: true })
		).toBe('kill_switch');
	});
	it('autre changement de config', () => {
		expect(
			derivePromotionKind({ hadPrevious: true, modeChanged: false, killSwitchChanged: false })
		).toBe('config_change');
	});
});
