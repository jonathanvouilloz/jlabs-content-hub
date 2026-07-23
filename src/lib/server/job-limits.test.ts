import { describe, it, expect } from 'vitest';
import {
	JOB_PROVIDERS,
	LIMIT_DEFAULTS,
	computeCapacity,
	emptySnapshot,
	jobTypesForProvider,
	openFairness,
	planAdmission,
	providerForJobType,
	recordClaim,
	resolveLimits,
	resolveProjectLimits,
	zeroByProvider,
	type JobLimits,
	type QueueSnapshot
} from './job-limits.js';

const NOW = Date.parse('2026-07-23T10:00:00Z');

function snapshot(over: Partial<QueueSnapshot> = {}): QueueSnapshot {
	return { ...emptySnapshot(), ...over };
}

/** Limites resserrées : les cas d'exclusion se lisent sans arithmétique de tête. */
function limits(over: Partial<JobLimits> = {}): JobLimits {
	return {
		...LIMIT_DEFAULTS,
		perProviderConcurrency: { ...LIMIT_DEFAULTS.perProviderConcurrency },
		providerWindowBudget: { ...LIMIT_DEFAULTS.providerWindowBudget },
		reservedTypes: [...LIMIT_DEFAULTS.reservedTypes],
		...over
	};
}

// ── Providers ───────────────────────────────────────────────────────

describe('providerForJobType', () => {
	it('les types actuels ne sortent pas de la base', () => {
		expect(providerForJobType('detect:keyword_opportunity')).toBe('none');
		expect(providerForJobType('propose:actions')).toBe('none');
		expect(providerForJobType('findings:lifecycle')).toBe('none');
	});

	it('`post_publish:check` est déjà déclaré GSC (E03 n’aura qu’un handler à poser)', () => {
		expect(providerForJobType('post_publish:check')).toBe('gsc');
	});

	it('un type INCONNU vaut `none` — jamais bloqué par un budget provider', () => {
		expect(providerForJobType('collect:whatever')).toBe('none');
		expect(providerForJobType('')).toBe('none');
	});

	it('jobTypesForProvider ne rend que les types déclarés pour ce provider', () => {
		expect(jobTypesForProvider('gsc')).toEqual(['post_publish:check']);
		expect(jobTypesForProvider('dataforseo')).toEqual([]);
		expect(jobTypesForProvider('none')).toContain('detect:keyword_opportunity');
	});
});

// ── resolveLimits ───────────────────────────────────────────────────

describe('resolveLimits — tolérance', () => {
	it('aucune source → les défauts', () => {
		expect(resolveLimits()).toEqual(LIMIT_DEFAULTS);
		expect(resolveLimits(null, undefined)).toEqual(LIMIT_DEFAULTS);
	});

	it('valeur d’un mauvais type → défaut (jamais « aucune limite », jamais file éteinte)', () => {
		const l = resolveLimits({ globalConcurrency: 'beaucoup', perProjectPerLap: null });
		expect(l.globalConcurrency).toBe(LIMIT_DEFAULTS.globalConcurrency);
		expect(l.perProjectPerLap).toBe(LIMIT_DEFAULTS.perProjectPerLap);
	});

	it('valeur hors bornes → défaut', () => {
		const l = resolveLimits({ globalConcurrency: -1, cooldownMs: 99 * 60 * 60 * 1000 });
		expect(l.globalConcurrency).toBe(LIMIT_DEFAULTS.globalConcurrency);
		expect(l.cooldownMs).toBe(LIMIT_DEFAULTS.cooldownMs);
	});

	it('`0` est une valeur LÉGITIME : « pas de limite »', () => {
		expect(resolveLimits({ globalConcurrency: 0 }).globalConcurrency).toBe(0);
		expect(resolveLimits({ perProjectPerLap: 0 }).perProjectPerLap).toBe(0);
	});

	it('les sources se fusionnent dans l’ordre reçu (système puis projet)', () => {
		const l = resolveLimits({ perProjectConcurrency: 8 }, { perProjectConcurrency: 1 });
		expect(l.perProjectConcurrency).toBe(1);
	});

	it('une clé provider inconnue est ignorée, les autres passent', () => {
		const l = resolveLimits({ perProviderConcurrency: { gsc: 9, martien: 3 } });
		expect(l.perProviderConcurrency.gsc).toBe(9);
		expect(Object.keys(l.perProviderConcurrency).sort()).toEqual([...JOB_PROVIDERS].sort());
	});

	it('`reservedTypes` : liste vide = plus de réserve, valeur illisible = inchangée', () => {
		expect(resolveLimits({ reservedTypes: [] }).reservedTypes).toEqual([]);
		expect(resolveLimits({ reservedTypes: 'avis' }).reservedTypes).toEqual(
			LIMIT_DEFAULTS.reservedTypes
		);
		expect(resolveLimits({ reservedTypes: ['a', 'a', 3] }).reservedTypes).toEqual(['a']);
	});

	it('ne mute jamais les défauts (les maps sont recopiées)', () => {
		resolveLimits({ perProviderConcurrency: { gsc: 42 }, reservedTypes: ['x'] });
		expect(LIMIT_DEFAULTS.perProviderConcurrency.gsc).toBe(2);
		expect(LIMIT_DEFAULTS.reservedTypes).toContain('reviews:sync');
	});
});

// ── Concurrence ─────────────────────────────────────────────────────

describe('planAdmission — concurrence', () => {
	it('file vide → rien d’exclu', () => {
		const plan = planAdmission({
			limits: limits(),
			snapshot: snapshot(),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.saturated).toBe(false);
		expect(plan.excludedTypes).toEqual([]);
		expect(plan.excludedProjectIds).toEqual([]);
		expect(plan.holds).toEqual([]);
	});

	it('plafond global atteint → saturé, avec sa cause nommée', () => {
		const plan = planAdmission({
			limits: limits({ globalConcurrency: 2 }),
			snapshot: snapshot({ running: 2 }),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.saturated).toBe(true);
		expect(plan.holds.map((h) => h.reason)).toContain('global_concurrency');
	});

	it('`globalConcurrency: 0` = pas de limite, même avec 50 jobs en cours', () => {
		const plan = planAdmission({
			limits: limits({ globalConcurrency: 0 }),
			snapshot: snapshot({ running: 50 }),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.saturated).toBe(false);
		expect(plan.reservedOnly).toBe(false);
	});

	it('un projet à son plafond est exclu — les autres passent', () => {
		const plan = planAdmission({
			limits: limits({ perProjectConcurrency: 2 }),
			snapshot: snapshot({ runningByProject: { 'p-gros': 2, 'p-petit': 1 }, running: 3 }),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.excludedProjectIds).toEqual(['p-gros']);
	});

	it('un provider à son plafond exclut SES types, pas les autres', () => {
		const plan = planAdmission({
			limits: limits({ perProviderConcurrency: { ...LIMIT_DEFAULTS.perProviderConcurrency, gsc: 1 } }),
			snapshot: snapshot({
				runningByProvider: { ...zeroByProvider(), gsc: 1 },
				running: 1
			}),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.excludedTypes).toEqual(['post_publish:check']);
		expect(plan.excludedTypes).not.toContain('detect:keyword_opportunity');
	});

	it('`none` sans plafond ne bloque jamais les types internes', () => {
		const plan = planAdmission({
			limits: limits(),
			snapshot: snapshot({ runningByProvider: { ...zeroByProvider(), none: 99 }, running: 99 }),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.excludedTypes).not.toContain('detect:keyword_opportunity');
	});
});

// ── Réserve ─────────────────────────────────────────────────────────

describe('planAdmission — réserve', () => {
	it('mord quand il reste moins de places que la réserve', () => {
		const plan = planAdmission({
			limits: limits({ globalConcurrency: 4, reservedSlots: 1 }),
			snapshot: snapshot({ running: 3 }),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.reservedOnly).toBe(true);
		expect(plan.saturated).toBe(false);
	});

	it('ne mord pas tant qu’il reste de la marge', () => {
		const plan = planAdmission({
			limits: limits({ globalConcurrency: 4, reservedSlots: 1 }),
			snapshot: snapshot({ running: 2 }),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.reservedOnly).toBe(false);
	});

	it('saturé ET réservé ne coexistent pas : plus une seule place, même réservée', () => {
		const plan = planAdmission({
			limits: limits({ globalConcurrency: 4, reservedSlots: 1 }),
			snapshot: snapshot({ running: 4 }),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.saturated).toBe(true);
		expect(plan.reservedOnly).toBe(false);
	});

	it('sans type réservé déclaré, la réserve ne mord pas (elle affamerait la file)', () => {
		const plan = planAdmission({
			limits: limits({ globalConcurrency: 4, reservedSlots: 1, reservedTypes: [] }),
			snapshot: snapshot({ running: 3 }),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.reservedOnly).toBe(false);
	});
});

// ── Quota : refroidissement et budget ───────────────────────────────

describe('planAdmission — quota', () => {
	it('un échec `quota` met TOUTE la cohorte du provider au repos', () => {
		const plan = planAdmission({
			limits: limits({ cooldownMs: 900_000 }),
			snapshot: snapshot({
				lastQuotaFailureMsByProvider: {
					gsc: NOW - 60_000,
					dataforseo: null,
					gmb: null,
					llm: null,
					none: null
				}
			}),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.excludedTypes).toContain('post_publish:check');
		expect(plan.cooldownUntilByProvider.gsc).toBe(NOW - 60_000 + 900_000);
		expect(plan.holds.map((h) => h.reason)).toContain('provider_cooldown');
	});

	it('refroidissement expiré → le provider repart, sans intervention', () => {
		const plan = planAdmission({
			limits: limits({ cooldownMs: 900_000 }),
			snapshot: snapshot({
				lastQuotaFailureMsByProvider: {
					gsc: NOW - 900_001,
					dataforseo: null,
					gmb: null,
					llm: null,
					none: null
				}
			}),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.excludedTypes).toEqual([]);
		expect(plan.cooldownUntilByProvider.gsc).toBeUndefined();
	});

	it('`cooldownMs: 0` désarme le refroidissement', () => {
		const plan = planAdmission({
			limits: limits({ cooldownMs: 0 }),
			snapshot: snapshot({
				lastQuotaFailureMsByProvider: {
					gsc: NOW,
					dataforseo: null,
					gmb: null,
					llm: null,
					none: null
				}
			}),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.excludedTypes).toEqual([]);
	});

	it('budget de fenêtre épuisé → types exclus, cause nommée', () => {
		const plan = planAdmission({
			limits: limits({ providerWindowBudget: { ...LIMIT_DEFAULTS.providerWindowBudget, gsc: 10 } }),
			snapshot: snapshot({
				attemptsInWindowByProvider: { ...zeroByProvider(), gsc: 10 }
			}),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.excludedTypes).toContain('post_publish:check');
		expect(plan.holds.map((h) => h.reason)).toContain('provider_budget');
	});

	it('budget à 0 = pas de budget : un provider très sollicité passe quand même', () => {
		const plan = planAdmission({
			limits: limits({ providerWindowBudget: { ...LIMIT_DEFAULTS.providerWindowBudget, gsc: 0 } }),
			snapshot: snapshot({ attemptsInWindowByProvider: { ...zeroByProvider(), gsc: 9999 } }),
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.excludedTypes).toEqual([]);
	});
});

// ── Équité : le tour ────────────────────────────────────────────────

describe('planAdmission — équité', () => {
	it('un projet qui a consommé sa part est écarté, les autres passent', () => {
		let fairness = openFairness();
		for (let i = 0; i < 5; i += 1) fairness = recordClaim(fairness, 'p-gros');

		const plan = planAdmission({
			limits: limits({ perProjectPerLap: 5 }),
			snapshot: snapshot({ projectsWithClaimableWork: ['p-gros', 'p-petit'] }),
			fairness,
			now: NOW
		});
		expect(plan.excludedProjectIds).toEqual(['p-gros']);
		expect(plan.lapOpened).toBe(false);
		expect(plan.holds.map((h) => h.reason)).toContain('project_lap');
	});

	it('quand TOUS les projets qui ont du travail ont leur part, un tour s’ouvre', () => {
		let fairness = openFairness();
		for (let i = 0; i < 5; i += 1) fairness = recordClaim(fairness, 'p-a');
		for (let i = 0; i < 5; i += 1) fairness = recordClaim(fairness, 'p-b');

		const plan = planAdmission({
			limits: limits({ perProjectPerLap: 5 }),
			snapshot: snapshot({ projectsWithClaimableWork: ['p-a', 'p-b'] }),
			fairness,
			now: NOW
		});
		expect(plan.lapOpened).toBe(true);
		expect(plan.fairness.lap).toBe(2);
		expect(plan.fairness.takenThisLap).toEqual({});
		expect(plan.excludedProjectIds).toEqual([]);
	});

	it('aucun travail réclamable → aucun tour ne s’ouvre (rien à servir)', () => {
		let fairness = openFairness();
		for (let i = 0; i < 5; i += 1) fairness = recordClaim(fairness, 'p-a');

		const plan = planAdmission({
			limits: limits({ perProjectPerLap: 5 }),
			snapshot: snapshot({ projectsWithClaimableWork: [] }),
			fairness,
			now: NOW
		});
		expect(plan.lapOpened).toBe(false);
		expect(plan.fairness.lap).toBe(1);
	});

	it('un projet OCCUPÉ ne compte pas parmi ceux à servir : le tour se rouvre quand même', () => {
		let fairness = openFairness();
		for (let i = 0; i < 5; i += 1) fairness = recordClaim(fairness, 'p-a');

		const plan = planAdmission({
			limits: limits({ perProjectPerLap: 5, perProjectConcurrency: 1 }),
			// p-b a du travail mais tourne déjà : il n'est pas « en attente d'être servi »,
			// il est occupé — et rouvrir un tour ne libérerait pas sa concurrence. Le seul
			// projet que le tour peut encore servir est p-a : ne pas rouvrir laisserait le
			// tick INACTIF avec du budget et de la file.
			snapshot: snapshot({
				projectsWithClaimableWork: ['p-a', 'p-b'],
				runningByProject: { 'p-b': 1 },
				running: 1
			}),
			fairness,
			now: NOW
		});
		expect(plan.lapOpened).toBe(true);
		// p-b reste écarté : sa contrainte est en base, le tour n'y peut rien.
		expect(plan.excludedProjectIds).toEqual(['p-b']);
	});

	it('aucun projet à servir hors des occupés → pas de tour ouvert pour rien', () => {
		const plan = planAdmission({
			limits: limits({ perProjectPerLap: 5, perProjectConcurrency: 1 }),
			snapshot: snapshot({
				projectsWithClaimableWork: ['p-b'],
				runningByProject: { 'p-b': 1 },
				running: 1
			}),
			fairness: recordClaim(openFairness(), 'p-a'),
			now: NOW
		});
		expect(plan.lapOpened).toBe(false);
		expect(plan.excludedProjectIds).toEqual(['p-b']);
	});

	it('`perProjectPerLap: 0` désarme l’équité', () => {
		let fairness = openFairness();
		for (let i = 0; i < 50; i += 1) fairness = recordClaim(fairness, 'p-a');

		const plan = planAdmission({
			limits: limits({ perProjectPerLap: 0 }),
			snapshot: snapshot({ projectsWithClaimableWork: ['p-a'] }),
			fairness,
			now: NOW
		});
		expect(plan.excludedProjectIds).toEqual([]);
		expect(plan.lapOpened).toBe(false);
	});

	it('recordClaim ne mute pas l’état reçu', () => {
		const before = openFairness();
		const after = recordClaim(before, 'p-a');
		expect(before.takenThisLap).toEqual({});
		expect(after.takenThisLap).toEqual({ 'p-a': 1 });
	});
});

// ── Réglages par projet ─────────────────────────────────────────────

describe('resolveProjectLimits', () => {
	it('payload absent ou illisible → aucun override (le projet suit le système)', () => {
		expect(resolveProjectLimits(null)).toEqual({});
		expect(resolveProjectLimits('serré')).toEqual({});
		expect(resolveProjectLimits({ perProjectConcurrency: 'deux' })).toEqual({});
	});

	it('hors bornes → ignoré, pas rabattu sur une borne', () => {
		expect(resolveProjectLimits({ perProjectConcurrency: -1, perProjectPerLap: 5000 })).toEqual({});
	});

	it('lit les deux knobs, `0` compris', () => {
		expect(resolveProjectLimits({ perProjectConcurrency: 1, perProjectPerLap: 0 })).toEqual({
			perProjectConcurrency: 1,
			perProjectPerLap: 0
		});
	});
});

describe('planAdmission — réglages par projet', () => {
	it('un projet resserré atteint son plafond avant les autres', () => {
		const plan = planAdmission({
			limits: limits({ perProjectConcurrency: 4 }),
			snapshot: snapshot({ runningByProject: { 'p-serre': 1, 'p-libre': 1 }, running: 2 }),
			projectLimits: { 'p-serre': { perProjectConcurrency: 1 } },
			fairness: openFairness(),
			now: NOW
		});
		expect(plan.excludedProjectIds).toEqual(['p-serre']);
	});

	it('la part de tour se resserre aussi par projet', () => {
		let fairness = openFairness();
		fairness = recordClaim(fairness, 'p-serre');
		fairness = recordClaim(fairness, 'p-libre');

		const plan = planAdmission({
			limits: limits({ perProjectPerLap: 5 }),
			snapshot: snapshot({ projectsWithClaimableWork: ['p-serre', 'p-libre'] }),
			projectLimits: { 'p-serre': { perProjectPerLap: 1 } },
			fairness,
			now: NOW
		});
		expect(plan.excludedProjectIds).toEqual(['p-serre']);
		expect(plan.lapOpened).toBe(false);
	});

	it('un projet qui se met à `0` désarme sa propre équité', () => {
		let fairness = openFairness();
		for (let i = 0; i < 99; i += 1) fairness = recordClaim(fairness, 'p-illimite');

		const plan = planAdmission({
			limits: limits({ perProjectPerLap: 5 }),
			snapshot: snapshot({ projectsWithClaimableWork: ['p-illimite'] }),
			projectLimits: { 'p-illimite': { perProjectPerLap: 0 } },
			fairness,
			now: NOW
		});
		expect(plan.excludedProjectIds).toEqual([]);
	});
});

// ── Exposition ──────────────────────────────────────────────────────

describe('computeCapacity', () => {
	it('rend une ligne par provider, avec ses types', () => {
		const report = computeCapacity({
			limits: limits(),
			snapshot: snapshot(),
			fairness: openFairness(),
			now: NOW
		});
		expect(report.providers).toHaveLength(JOB_PROVIDERS.length);
		expect(report.providers.find((p) => p.provider === 'gsc')?.jobTypes).toEqual([
			'post_publish:check'
		]);
	});

	it('un provider au repos est `quota_limited`, pas `saturated`', () => {
		const report = computeCapacity({
			limits: limits({ cooldownMs: 900_000 }),
			snapshot: snapshot({
				lastQuotaFailureMsByProvider: {
					gsc: NOW - 1000,
					dataforseo: null,
					gmb: null,
					llm: null,
					none: null
				}
			}),
			fairness: openFairness(),
			now: NOW
		});
		const gsc = report.providers.find((p) => p.provider === 'gsc');
		expect(gsc?.state).toBe('quota_limited');
		expect(gsc?.cooldownUntilMs).toBe(NOW - 1000 + 900_000);
	});

	it('budget épuisé sans refroidissement vaut aussi `quota_limited`', () => {
		const report = computeCapacity({
			limits: limits({ providerWindowBudget: { ...LIMIT_DEFAULTS.providerWindowBudget, gmb: 5 } }),
			snapshot: snapshot({ attemptsInWindowByProvider: { ...zeroByProvider(), gmb: 5 } }),
			fairness: openFairness(),
			now: NOW
		});
		expect(report.providers.find((p) => p.provider === 'gmb')?.state).toBe('quota_limited');
	});

	it('les projets viennent des trois sources (en cours, tour, travail en attente)', () => {
		const report = computeCapacity({
			limits: limits(),
			snapshot: snapshot({
				runningByProject: { 'p-a': 1 },
				running: 1,
				projectsWithClaimableWork: ['p-c']
			}),
			fairness: recordClaim(openFairness(), 'p-b'),
			now: NOW
		});
		expect(report.projects.map((p) => p.projectId)).toEqual(['p-a', 'p-b', 'p-c']);
	});

	it('un projet à sa part de tour est `saturated`, même sans job en cours', () => {
		let fairness = openFairness();
		for (let i = 0; i < 5; i += 1) fairness = recordClaim(fairness, 'p-a');
		const report = computeCapacity({
			limits: limits({ perProjectPerLap: 5 }),
			snapshot: snapshot(),
			fairness,
			now: NOW
		});
		expect(report.projects[0]).toMatchObject({ projectId: 'p-a', running: 0, state: 'saturated' });
	});
});
