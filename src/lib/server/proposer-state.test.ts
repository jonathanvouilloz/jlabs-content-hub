import { describe, it, expect } from 'vitest';
import {
	APPROVAL_LEVEL_BY_ACTION,
	PROPOSAL_ACTION_TYPES,
	PROPOSAL_PAYLOAD_SCHEMA_VERSION,
	PROPOSER_DEFAULTS,
	PROPOSER_VERSION,
	SKILL_BY_ACTION,
	buildExpectedImpact,
	buildProposalPayload,
	buildRationale,
	canonicalInputSignature,
	canonicalProposalPayload,
	decideAutoApproval,
	decideSupersession,
	deriveApprovalLevel,
	deriveRiskLevel,
	isHumanOnlyAction,
	mapFindingToActions,
	readFindingSignals,
	resolveProposerConfig,
	selectProposableFindings,
	type ProposableFinding
} from './proposer-state.js';
import {
	FINDING_FINGERPRINT_SEP,
	deriveFindingFingerprint,
	parseFindingFingerprint
} from './finding-state.js';
import { APPROVAL_LEVELS, canActorApprove } from './proposal-state.js';

// ── Fixtures ────────────────────────────────────────────────────────

const FP = deriveFindingFingerprint({
	type: 'keyword_opportunity',
	entityType: 'query',
	entityKey: 'chaise de bureau ergonomique',
	discriminators: ['https://exemple.ch/chaises']
});

function evidence(over: Record<string, number> = {}): string {
	return JSON.stringify({
		detector: 'keyword_opportunity@1',
		window: { start: '2026-06-01', end: '2026-06-28', weeks: 4 },
		observationIds: ['obs1', 'obs2'],
		observationCount: 2,
		metrics: {
			clicks: 3,
			impressions: 900,
			ctr: 0.012,
			position: 7.4,
			weeksSeen: 4,
			gainEstimate: 24,
			...over
		},
		scoreBreakdown: { impact: 40, urgency: 18, confidence: 14, strategicFit: 9 },
		confidenceCaveats: []
	});
}

function finding(over: Partial<ProposableFinding> = {}): ProposableFinding {
	return {
		id: 'find_1',
		type: 'keyword_opportunity',
		fingerprint: FP,
		entityType: 'query',
		entityKey: 'chaise de bureau ergonomique',
		title: 'Opportunité "chaise de bureau ergonomique"',
		status: 'open',
		severity: 'high',
		priorityScore: 81,
		confidenceScore: 70,
		impactEstimateJson: JSON.stringify({ gainEstimateClicksPerWeek: 24, ctrGap: 0.028 }),
		evidenceJson: evidence(),
		recommendedSkill: 'seo-refresh',
		...over
	};
}

const CFG = resolveProposerConfig(null);

// ── Catalogue & niveaux (SPEC §12.1) ────────────────────────────────

describe('catalogue d’actions et niveaux d’approbation', () => {
	it('chaque action du catalogue a un niveau ET un skill déclarés', () => {
		for (const a of PROPOSAL_ACTION_TYPES) {
			expect(APPROVAL_LEVEL_BY_ACTION[a]).toBeDefined();
			expect(APPROVAL_LEVELS).toContain(APPROVAL_LEVEL_BY_ACTION[a]);
			expect(SKILL_BY_ACTION).toHaveProperty(a);
		}
	});

	it('reprend les exemples littéraux de la SPEC §12.1', () => {
		expect(deriveApprovalLevel('report_generate')).toBe('L0'); // observation
		expect(deriveApprovalLevel('indexnow_submit')).toBe('L1'); // opération réversible
		expect(deriveApprovalLevel('brief_create')).toBe('L2'); // brouillon
		expect(deriveApprovalLevel('refresh_plan')).toBe('L2'); // « plan de refresh »
		expect(deriveApprovalLevel('content_refresh')).toBe('L3'); // modification contenu
		expect(deriveApprovalLevel('redirect_301')).toBe('L4'); // sensible/destructif
		expect(deriveApprovalLevel('canonical_set')).toBe('L4');
		expect(deriveApprovalLevel('deindex')).toBe('L4');
	});

	it('un type d’action inconnu n’a pas de niveau (refus, jamais de défaut permissif)', () => {
		expect(deriveApprovalLevel('rm_-rf')).toBeNull();
		expect(deriveApprovalLevel('')).toBeNull();
	});

	it('aucune action L4 n’est approuvable par un agent (§12.2)', () => {
		for (const a of PROPOSAL_ACTION_TYPES) {
			const level = APPROVAL_LEVEL_BY_ACTION[a];
			if (level !== 'L4') continue;
			expect(isHumanOnlyAction(a)).toBe(true);
			expect(canActorApprove({ actorType: 'agent', level })).toBe(false);
			expect(canActorApprove({ actorType: 'policy', level })).toBe(false);
			expect(canActorApprove({ actorType: 'user', level })).toBe(true);
		}
	});
});

// ── Risque ──────────────────────────────────────────────────────────

describe('deriveRiskLevel', () => {
	it('suit le niveau de l’action, pas la gravité du problème', () => {
		expect(deriveRiskLevel('refresh_plan')).toBe('low');
		expect(deriveRiskLevel('meta_rewrite')).toBe('medium');
		expect(deriveRiskLevel('redirect_301')).toBe('high');
	});

	it('monte d’un cran quand l’action touche une page qui a déjà des clics à perdre', () => {
		expect(deriveRiskLevel('meta_rewrite', { existingClicks: 0 })).toBe('medium');
		expect(deriveRiskLevel('meta_rewrite', { existingClicks: 9 })).toBe('medium');
		expect(deriveRiskLevel('meta_rewrite', { existingClicks: 40 })).toBe('high');
	});

	it('ne monte pas une action qui ne publie rien (un brouillon ne perd aucun clic)', () => {
		expect(deriveRiskLevel('refresh_plan', { existingClicks: 500 })).toBe('low');
		expect(deriveRiskLevel('brief_create', { existingClicks: 500 })).toBe('low');
	});

	it('une action inconnue est traitée comme la plus risquée, jamais banalisée', () => {
		expect(deriveRiskLevel('mystere')).toBe('high');
	});
});

// ── Configuration ───────────────────────────────────────────────────

describe('resolveProposerConfig', () => {
	it('sans override, rend les défauts conservateurs', () => {
		expect(CFG).toEqual(PROPOSER_DEFAULTS);
		expect(CFG.minPriority).toBe(60);
		expect(CFG.maxProposals).toBe(10);
	});

	it('accepte des overrides valides', () => {
		const c = resolveProposerConfig({ minPriority: 40, maxProposals: 3 });
		expect(c.minPriority).toBe(40);
		expect(c.maxProposals).toBe(3);
	});

	it('accepte minPriority=0 (proposer sur tout est un choix légitime)', () => {
		expect(resolveProposerConfig({ minPriority: 0 }).minPriority).toBe(0);
	});

	it('un override absurde retombe sur le défaut plutôt que de tout taire', () => {
		expect(resolveProposerConfig({ maxProposals: 0 }).maxProposals).toBe(10);
		expect(resolveProposerConfig({ maxProposals: -5 }).maxProposals).toBe(10);
		expect(resolveProposerConfig({ minPriority: Number.NaN }).minPriority).toBe(60);
		expect(
			resolveProposerConfig({ minPriority: 'haut' as unknown as number }).minPriority
		).toBe(60);
	});

	it('garde les décimales de metaRewriteMaxPosition (une position n’est pas un entier)', () => {
		expect(resolveProposerConfig({ metaRewriteMaxPosition: 10.5 }).metaRewriteMaxPosition).toBe(
			10.5
		);
	});
});

// ── Lecture des signaux ─────────────────────────────────────────────

describe('readFindingSignals', () => {
	it('retrouve la page dans le fingerprint (elle n’est pas dans entity_key)', () => {
		const s = readFindingSignals(finding());
		expect(s.page).toBe('https://exemple.ch/chaises');
		expect(s.query).toBe('chaise de bureau ergonomique');
		expect(parseFindingFingerprint(FP).discriminators[0]).toBe(s.page);
	});

	it('lit les mesures des preuves sans les recalculer', () => {
		const s = readFindingSignals(finding());
		expect(s.position).toBe(7.4);
		expect(s.clicks).toBe(3);
		expect(s.impressions).toBe(900);
		expect(s.gainEstimate).toBe(24);
	});

	it('retombe sur impact_estimate_json quand les preuves n’ont pas le gain', () => {
		const f = finding({ evidenceJson: JSON.stringify({ metrics: { position: 7.4 } }) });
		expect(readFindingSignals(f).gainEstimate).toBe(24);
	});

	it('un blob illisible rend des null — aucune métrique inventée (§3.3)', () => {
		const s = readFindingSignals(
			finding({ evidenceJson: '{ pas du json', impactEstimateJson: null })
		);
		expect(s.position).toBeNull();
		expect(s.clicks).toBeNull();
		expect(s.gainEstimate).toBeNull();
		expect(s.page).toBe('https://exemple.ch/chaises'); // le fingerprint, lui, tient
	});
});

// ── Choix de l'action ───────────────────────────────────────────────

describe('mapFindingToActions', () => {
	it('position sous le seuil → meta_rewrite (la page est vue, le snippet pèche)', () => {
		const f = finding({ evidenceJson: evidence({ position: 6.2 }) });
		const actions = mapFindingToActions(f, readFindingSignals(f), CFG);
		expect(actions).toHaveLength(1);
		expect(actions[0].actionType).toBe('meta_rewrite');
		expect(actions[0].selectionReason).toContain('6.2');
	});

	it('position au-delà du seuil → refresh_plan (il faut d’abord gagner des places)', () => {
		const f = finding({ evidenceJson: evidence({ position: 15.8 }) });
		const actions = mapFindingToActions(f, readFindingSignals(f), CFG);
		expect(actions).toHaveLength(1);
		expect(actions[0].actionType).toBe('refresh_plan');
	});

	it('la bascule est au seuil exact, inclusif', () => {
		const at = finding({ evidenceJson: evidence({ position: 10 }) });
		const over = finding({ evidenceJson: evidence({ position: 10.1 }) });
		expect(mapFindingToActions(at, readFindingSignals(at), CFG)[0].actionType).toBe(
			'meta_rewrite'
		);
		expect(mapFindingToActions(over, readFindingSignals(over), CFG)[0].actionType).toBe(
			'refresh_plan'
		);
	});

	it('ne propose JAMAIS une action L3+ sans y être conduit par une règle', () => {
		for (const pos of [3, 7, 9.9, 10, 11, 25]) {
			const f = finding({ evidenceJson: evidence({ position: pos }) });
			for (const a of mapFindingToActions(f, readFindingSignals(f), CFG)) {
				expect(deriveApprovalLevel(a.actionType)).not.toBe('L4');
			}
		}
	});

	it('un type de finding inconnu ne produit AUCUNE action (pas de défaut)', () => {
		const f = finding({ type: 'cannibalization' });
		expect(mapFindingToActions(f, readFindingSignals(f), CFG)).toEqual([]);
	});

	it('sans cible ni position, rien n’est proposé (une action doit être adressable)', () => {
		const noPos = finding({ evidenceJson: '{}', impactEstimateJson: null });
		expect(mapFindingToActions(noPos, readFindingSignals(noPos), CFG)).toEqual([]);

		const noPage = finding({
			fingerprint: ['keyword_opportunity', 'query', 'requete'].join(FINDING_FINGERPRINT_SEP)
		});
		expect(mapFindingToActions(noPage, readFindingSignals(noPage), CFG)).toEqual([]);
	});
});

// ── Payload stable — le cœur de l'idempotence ───────────────────────

describe('payload canonique', () => {
	const f = finding();
	const s = readFindingSignals(f);
	const choice = mapFindingToActions(f, s, CFG)[0];

	it('porte version, action, finding et cible', () => {
		const p = buildProposalPayload({ finding: f, signals: s, choice });
		expect(p.schema_version).toBe(PROPOSAL_PAYLOAD_SCHEMA_VERSION);
		expect(p.action).toBe('meta_rewrite');
		expect(p.proposer).toBe(PROPOSER_VERSION);
		expect(p.finding_ids).toEqual(['find_1']);
		expect(p.target).toBe('https://exemple.ch/chaises');
		expect(p.skill).toBe('seo-refresh');
	});

	it('NE CHANGE PAS quand les mesures hebdomadaires bougent — sinon l’inbox doublerait chaque semaine', () => {
		const semaine1 = finding({ evidenceJson: evidence({ position: 7.4, impressions: 900 }) });
		const semaine2 = finding({
			evidenceJson: evidence({ position: 7.1, impressions: 1120, clicks: 5 }),
			priorityScore: 84,
			confidenceScore: 75
		});
		const p1 = buildProposalPayload({
			finding: semaine1,
			signals: readFindingSignals(semaine1),
			choice: mapFindingToActions(semaine1, readFindingSignals(semaine1), CFG)[0]
		});
		const p2 = buildProposalPayload({
			finding: semaine2,
			signals: readFindingSignals(semaine2),
			choice: mapFindingToActions(semaine2, readFindingSignals(semaine2), CFG)[0]
		});
		expect(canonicalProposalPayload(p1)).toBe(canonicalProposalPayload(p2));
	});

	it('CHANGE quand l’action change (la situation, elle, a vraiment changé)', () => {
		const proche = finding({ evidenceJson: evidence({ position: 6 }) });
		const loin = finding({ evidenceJson: evidence({ position: 18 }) });
		const pProche = buildProposalPayload({
			finding: proche,
			signals: readFindingSignals(proche),
			choice: mapFindingToActions(proche, readFindingSignals(proche), CFG)[0]
		});
		const pLoin = buildProposalPayload({
			finding: loin,
			signals: readFindingSignals(loin),
			choice: mapFindingToActions(loin, readFindingSignals(loin), CFG)[0]
		});
		expect(canonicalProposalPayload(pProche)).not.toBe(canonicalProposalPayload(pLoin));
	});

	it('ne contient aucun champ volatil (ni date, ni compteur, ni mesure)', () => {
		const raw = canonicalProposalPayload(
			buildProposalPayload({ finding: f, signals: s, choice })
		);
		for (const interdit of [
			'position',
			'impressions',
			'clicks',
			'ctr',
			'gain',
			'occurrence',
			'last_seen',
			'priority',
			'2026-'
		]) {
			expect(raw).not.toContain(interdit);
		}
	});

	it('la sérialisation est stable quel que soit l’ordre des finding_ids', () => {
		const base = buildProposalPayload({ finding: f, signals: s, choice });
		const a = canonicalProposalPayload({ ...base, finding_ids: ['b', 'a'] });
		const b = canonicalProposalPayload({ ...base, finding_ids: ['a', 'b'] });
		expect(a).toBe(b);
	});

	it('la signature d’ENTRÉE, elle, bouge avec les mesures (c’est son rôle)', () => {
		const s2 = readFindingSignals(finding({ evidenceJson: evidence({ position: 7.1 }) }));
		expect(canonicalInputSignature({ finding: f, signals: s })).not.toBe(
			canonicalInputSignature({ finding: f, signals: s2 })
		);
	});
});

// ── Textes lisibles ─────────────────────────────────────────────────

describe('rationale et impact attendu', () => {
	it('le rationale cite le fait et justifie l’action retenue', () => {
		const f = finding();
		const s = readFindingSignals(f);
		const r = buildRationale({ finding: f, signals: s, choice: mapFindingToActions(f, s, CFG)[0] });
		expect(r).toContain('900 impressions');
		expect(r).toContain('position 7.4');
		expect(r).toContain('meta_rewrite');
		expect(r).toContain('81/100');
	});

	it('l’impact vient du détecteur, jamais recalculé', () => {
		expect(buildExpectedImpact(readFindingSignals(finding()))).toContain('~24 clics/semaine');
	});

	it('sans estimation, on le DIT au lieu d’en inventer une', () => {
		const f = finding({ evidenceJson: '{}', impactEstimateJson: null });
		expect(buildExpectedImpact(readFindingSignals(f))).toBe('impact non estimé par le détecteur');
	});
});

// ── Sélection ───────────────────────────────────────────────────────

describe('selectProposableFindings', () => {
	const pool: ProposableFinding[] = [
		finding({ id: 'a', fingerprint: 'fp-a', priorityScore: 90, status: 'open' }),
		finding({ id: 'b', fingerprint: 'fp-b', priorityScore: 75, status: 'reopened' }),
		finding({ id: 'c', fingerprint: 'fp-c', priorityScore: 95, status: 'snoozed' }),
		finding({ id: 'd', fingerprint: 'fp-d', priorityScore: 99, status: 'dismissed' }),
		finding({ id: 'e', fingerprint: 'fp-e', priorityScore: 88, status: 'resolved' }),
		finding({ id: 'f', fingerprint: 'fp-f', priorityScore: 30, status: 'open' }),
		finding({ id: 'g', fingerprint: 'fp-g', priorityScore: 60, status: 'in_progress' })
	];

	it('ne retient que les findings ACTIFS — le snooze et le dismiss tiennent', () => {
		const sel = selectProposableFindings(pool, CFG);
		const ids = sel.matched.map((f) => f.id);
		expect(ids).not.toContain('c'); // snoozed : promesse de silence
		expect(ids).not.toContain('d'); // dismissed : vaut à vie
		expect(ids).not.toContain('e'); // resolved
		expect(sel.excludedByStatus).toBe(3);
	});

	it('écarte ce qui est sous minPriority', () => {
		const sel = selectProposableFindings(pool, CFG);
		expect(sel.matched.map((f) => f.id)).not.toContain('f');
		expect(sel.excludedByPriority).toBe(1);
	});

	it('garde le seuil inclusif (60 passe avec minPriority=60)', () => {
		expect(selectProposableFindings(pool, CFG).matched.map((f) => f.id)).toContain('g');
	});

	it('trie par priorité décroissante, départagée de façon déterministe', () => {
		const sel = selectProposableFindings(pool, CFG);
		expect(sel.matched.map((f) => f.id)).toEqual(['a', 'b', 'g']);
		const exaequo = [
			finding({ id: 'z', fingerprint: 'fp-z', priorityScore: 80 }),
			finding({ id: 'y', fingerprint: 'fp-y', priorityScore: 80 })
		];
		expect(selectProposableFindings(exaequo, CFG).matched.map((f) => f.id)).toEqual(['y', 'z']);
		expect(selectProposableFindings([...exaequo].reverse(), CFG).matched.map((f) => f.id)).toEqual(
			['y', 'z']
		);
	});

	it('expose matched COMPLET à côté de selected tronqué (leçon FIND-003)', () => {
		const sel = selectProposableFindings(pool, resolveProposerConfig({ maxProposals: 2 }));
		expect(sel.matched).toHaveLength(3);
		expect(sel.selected).toHaveLength(2);
		expect(sel.truncated).toBe(true);
	});

	it('sans troncature, truncated reste faux', () => {
		expect(selectProposableFindings(pool, CFG).truncated).toBe(false);
	});
});

// ── Supersession ────────────────────────────────────────────────────

describe('decideSupersession', () => {
	const existing = [
		{ id: 'p1', actionType: 'meta_rewrite', payloadHash: 'vieux', status: 'proposed' },
		{ id: 'p2', actionType: 'meta_rewrite', payloadHash: 'vieux', status: 'invalidated' },
		{ id: 'p3', actionType: 'meta_rewrite', payloadHash: 'vieux', status: 'approved' },
		{ id: 'p4', actionType: 'meta_rewrite', payloadHash: 'vieux', status: 'executed' },
		{ id: 'p5', actionType: 'meta_rewrite', payloadHash: 'vieux', status: 'rejected' },
		{ id: 'p6', actionType: 'refresh_plan', payloadHash: 'vieux', status: 'proposed' },
		{ id: 'p7', actionType: 'meta_rewrite', payloadHash: 'neuf', status: 'proposed' }
	];

	it('périme les propositions ouvertes de la MÊME action au payload obsolète', () => {
		const d = decideSupersession({ existing, actionType: 'meta_rewrite', nextPayloadHash: 'neuf' });
		expect(d.supersede).toEqual(['p1', 'p2']);
	});

	it('ne touche jamais une décision prise (approved/executed/rejected)', () => {
		const d = decideSupersession({ existing, actionType: 'meta_rewrite', nextPayloadHash: 'neuf' });
		expect(d.supersede).not.toContain('p3');
		expect(d.supersede).not.toContain('p4');
		expect(d.supersede).not.toContain('p5');
	});

	it('REMONTE une approbation devenue obsolète au lieu de l’effacer en silence', () => {
		const d = decideSupersession({ existing, actionType: 'meta_rewrite', nextPayloadHash: 'neuf' });
		expect(d.staleApproved).toEqual(['p3']);
	});

	it('ne touche pas une autre action', () => {
		const d = decideSupersession({ existing, actionType: 'meta_rewrite', nextPayloadHash: 'neuf' });
		expect(d.supersede).not.toContain('p6');
	});

	it('la proposition au MÊME hash est laissée à l’upsert idempotent', () => {
		const d = decideSupersession({ existing, actionType: 'meta_rewrite', nextPayloadHash: 'neuf' });
		expect(d.supersede).not.toContain('p7');
	});

	it('sans existant, rien à faire', () => {
		expect(
			decideSupersession({ existing: [], actionType: 'meta_rewrite', nextPayloadHash: 'x' })
		).toEqual({ supersede: [], staleApproved: [] });
	});
});

// ── Auto-approbation ────────────────────────────────────────────────

describe('decideAutoApproval', () => {
	it('refuse tout niveau hors de portée d’un agent (§12.2)', () => {
		for (const level of ['L3', 'L4'] as const) {
			const d = decideAutoApproval({ approvalLevel: level, policyMode: 'guarded_auto' });
			expect(d.allowed).toBe(false);
			expect(d.reason).toContain(level);
			// cohérent avec la garde IO, qui refusera de toute façon
			expect(canActorApprove({ actorType: 'agent', level })).toBe(false);
		}
	});

	it('refuse par défaut quand aucune policy n’est connue — l’état de tous les projets', () => {
		const d = decideAutoApproval({ approvalLevel: 'L2', policyMode: null });
		expect(d.allowed).toBe(false);
		expect(d.reason).toContain('refus par défaut');
	});

	it('draft_only et manual n’autorisent jamais un geste autonome', () => {
		expect(decideAutoApproval({ approvalLevel: 'L2', policyMode: 'draft_only' }).allowed).toBe(
			false
		);
		expect(decideAutoApproval({ approvalLevel: 'L2', policyMode: 'manual' }).allowed).toBe(false);
	});

	it('le kill switch bloque même en guarded_auto', () => {
		const d = decideAutoApproval({
			approvalLevel: 'L2',
			policyMode: 'guarded_auto',
			killSwitch: true
		});
		expect(d.allowed).toBe(false);
		expect(d.reason).toContain('kill switch');
	});

	it('autorise L0–L2 sous guarded_auto sans kill switch', () => {
		for (const level of ['L0', 'L1', 'L2'] as const) {
			expect(
				decideAutoApproval({ approvalLevel: level, policyMode: 'guarded_auto' }).allowed
			).toBe(true);
		}
	});
});
