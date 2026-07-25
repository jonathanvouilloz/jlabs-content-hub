import { describe, it, expect } from 'vitest';
import {
	MAX_SAMPLE_PCT,
	SELECTION_DEFAULTS,
	SELECTION_REASONS,
	SELECTOR_VERSION,
	addDays,
	allocate,
	bucketForReason,
	compareCandidates,
	computeSampleCap,
	daysBetween,
	dedupeCandidates,
	familyForReason,
	isDue,
	isExpired,
	isSampleDue,
	isSelectionReason,
	manualSelections,
	matchesExclude,
	postPublishSelections,
	resolveBudget,
	resolveProjectSelection,
	resolveSelectionConfig,
	type Candidate,
	type SelectionReason
} from './index-selection-state.js';
import { MAX_URLS_PER_JOB } from './url-inspection-state.js';

const CONFIG = resolveSelectionConfig();

/** Fabrique un candidat minimal — l'URL normalisée est dérivée du chemin, comme en base. */
function c(path: string, reason: SelectionReason, weight = 0): Candidate {
	const url = `https://x.ch${path}`;
	return { url, urlNormalized: url, reason, weight };
}

/**
 * N candidats distincts de la même raison.
 *
 * Le chemin porte la raison : sans ça, `many(3, 'sample')` produirait les mêmes URLs que
 * `many(100, 'new')` et `dedupeCandidates` les fusionnerait — on croirait tester une
 * allocation alors qu'on testerait la déduplication.
 */
function many(n: number, reason: SelectionReason): Candidate[] {
	return Array.from({ length: n }, (_, i) => c(`/${reason}/p${String(i).padStart(4, '0')}`, reason));
}

function budgetOf(overrides: Partial<Parameters<typeof resolveBudget>[0]> = {}) {
	return resolveBudget({
		config: CONFIG,
		projectDailyBudget: CONFIG.dailyBudgetPerProject,
		poolUsed: 0,
		scope: 'full',
		collectorCap: MAX_URLS_PER_JOB,
		...overrides
	});
}

describe('vocabulaire des raisons — FERMÉ, sinon « expose sa raison » ne s’interroge pas', () => {
	it('refuse une raison inventée', () => {
		expect(isSelectionReason('parce_que')).toBe(false);
		expect(isSelectionReason('')).toBe(false);
		expect(isSelectionReason(null)).toBe(false);
		expect(isSelectionReason(42)).toBe(false);
	});

	it('accepte exactement les sept raisons déclarées', () => {
		expect(SELECTION_REASONS.every(isSelectionReason)).toBe(true);
		expect(SELECTION_REASONS).toHaveLength(7);
	});

	it('`sample` est le SEUL bucket plafonné — c’est lui que l’acceptation 1 vise', () => {
		expect(bucketForReason('sample')).toBe('sample');
		for (const reason of SELECTION_REASONS.filter((r) => r !== 'sample')) {
			expect(bucketForReason(reason)).toBe('priority');
		}
	});

	it('les trois familles se répartissent sans reste', () => {
		expect(SELECTION_REASONS.map(familyForReason)).toEqual([
			'urgent',
			'urgent',
			'urgent',
			'routine',
			'routine',
			'routine',
			'sample'
		]);
	});

	it('la politique est VERSIONNÉE : un lot ancien ne se relit pas avec les règles d’aujourd’hui', () => {
		expect(SELECTOR_VERSION).toBe('index_selection@1');
	});
});

describe('resolveSelectionConfig — `0` veut dire ZÉRO, l’inverse de job-limits.ts', () => {
	it('un budget à 0 reste 0 : le lire « illimité » brûlerait le pool en un job', () => {
		expect(resolveSelectionConfig({ dailyBudgetPerProject: 0 }).dailyBudgetPerProject).toBe(0);
		expect(resolveSelectionConfig({ dailyPoolTotal: 0 }).dailyPoolTotal).toBe(0);
		expect(resolveSelectionConfig({ jobCap: 0 }).jobCap).toBe(0);
		expect(resolveSelectionConfig({ samplePctMax: 0 }).samplePctMax).toBe(0);
	});

	it('une valeur illisible ou négative retombe sur le défaut, elle ne devient pas 0', () => {
		expect(resolveSelectionConfig({ dailyBudgetPerProject: -5 }).dailyBudgetPerProject).toBe(
			SELECTION_DEFAULTS.dailyBudgetPerProject
		);
		expect(
			resolveSelectionConfig({ dailyPoolTotal: Number.NaN }).dailyPoolTotal
		).toBe(SELECTION_DEFAULTS.dailyPoolTotal);
		expect(
			resolveSelectionConfig({ jobCap: 'beaucoup' as unknown as number }).jobCap
		).toBe(SELECTION_DEFAULTS.jobCap);
		expect(resolveSelectionConfig({ dailyPoolTotal: Infinity }).dailyPoolTotal).toBe(
			SELECTION_DEFAULTS.dailyPoolTotal
		);
	});

	it('une CADENCE à 0 retombe au défaut : « tous les 0 jours » n’est pas une politique', () => {
		expect(resolveSelectionConfig({ sampleIntervalDays: 0 }).sampleIntervalDays).toBe(
			SELECTION_DEFAULTS.sampleIntervalDays
		);
		expect(resolveSelectionConfig({ maxAgeDays: 0 }).maxAgeDays).toBe(
			SELECTION_DEFAULTS.maxAgeDays
		);
	});

	it('un `samplePctMax` à 100 retombe à 60 : une garde désactivable n’est pas une garde', () => {
		expect(resolveSelectionConfig({ samplePctMax: 100 }).samplePctMax).toBe(MAX_SAMPLE_PCT);
		expect(resolveSelectionConfig({ samplePctMax: 9999 }).samplePctMax).toBe(MAX_SAMPLE_PCT);
	});

	it('null / undefined / objet vide rendent les défauts documentés', () => {
		expect(resolveSelectionConfig(null)).toEqual(SELECTION_DEFAULTS);
		expect(resolveSelectionConfig(undefined)).toEqual(SELECTION_DEFAULTS);
		expect(resolveSelectionConfig({})).toEqual(SELECTION_DEFAULTS);
	});

	it('les défauts sont PRUDENTS : le pool est sous le quota théorique, pas dessus', () => {
		// 800 et non 2 000 : `poolUsed` est une borne inférieure (les échecs ne s'y comptent pas).
		expect(SELECTION_DEFAULTS.dailyPoolTotal).toBeLessThan(2000);
		expect(SELECTION_DEFAULTS.dailyBudgetPerProject * 6).toBeLessThan(
			SELECTION_DEFAULTS.dailyPoolTotal
		);
	});
});

describe('resolveProjectSelection — un projet ne peut que RESSERRER', () => {
	it('un budget projet plus GRAND que le système est ignoré', () => {
		expect(resolveProjectSelection(CONFIG, { dailyBudget: 5000 }).dailyBudget).toBe(
			CONFIG.dailyBudgetPerProject
		);
	});

	it('un budget projet plus PETIT s’applique', () => {
		expect(resolveProjectSelection(CONFIG, { dailyBudget: 5 }).dailyBudget).toBe(5);
	});

	it('un budget projet à 0 s’applique : un projet peut se retirer de la rotation', () => {
		expect(resolveProjectSelection(CONFIG, { dailyBudget: 0 }).dailyBudget).toBe(0);
	});

	it('un intervalle plus COURT est ignoré : échantillonner plus n’est pas resserrer', () => {
		expect(resolveProjectSelection(CONFIG, { sampleIntervalDays: 1 }).sampleIntervalDays).toBe(
			CONFIG.sampleIntervalDays
		);
		expect(resolveProjectSelection(CONFIG, { sampleIntervalDays: 30 }).sampleIntervalDays).toBe(30);
	});

	it('des motifs d’exclusion corrompus ne cassent rien', () => {
		expect(
			resolveProjectSelection(CONFIG, {
				excludePatterns: ['/tag/', '', '  ', 42 as unknown as string]
			}).excludePatterns
		).toEqual(['/tag/']);
		expect(resolveProjectSelection(CONFIG, null).excludePatterns).toEqual([]);
	});
});

describe('computeSampleCap — l’échantillon ne peut JAMAIS prendre le dernier slot', () => {
	it('budget >= 1 ⇒ sampleCap < budget, pour tout pourcentage admissible', () => {
		for (const budget of [1, 2, 3, 5, 10, 40, 199, 200]) {
			for (const pct of [0, 10, 40, 60, 100, 9999]) {
				const cap = computeSampleCap({ budget, samplePctMax: pct, takenUrgent: 0 });
				expect(cap).toBeLessThan(budget);
				expect(cap).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it('budget = 1 ⇒ sampleCap = 0 : le seul slot ne peut pas partir en rotation', () => {
		expect(computeSampleCap({ budget: 1, samplePctMax: 60, takenUrgent: 0 })).toBe(0);
	});

	it('un pourcentage à 100 est clampé à 60 %, ici comme dans la config', () => {
		expect(computeSampleCap({ budget: 100, samplePctMax: 100, takenUrgent: 0 })).toBe(60);
	});

	it('l’urgent déjà servi rogne le cap, jamais l’inverse', () => {
		expect(computeSampleCap({ budget: 10, samplePctMax: 60, takenUrgent: 8 })).toBe(2);
		expect(computeSampleCap({ budget: 10, samplePctMax: 60, takenUrgent: 10 })).toBe(0);
	});

	it('budget = 0 ⇒ cap = 0', () => {
		expect(computeSampleCap({ budget: 0, samplePctMax: 60, takenUrgent: 0 })).toBe(0);
	});
});

describe('resolveBudget — la réserve urgente est CROSS-PROJET', () => {
	it('une passe `full` ne peut pas puiser dans la réserve', () => {
		const res = budgetOf({ poolUsed: CONFIG.dailyPoolTotal - CONFIG.poolUrgentReserve, scope: 'full' });
		expect(res.poolAvailable).toBe(0);
		expect(res.budget).toBe(0);
		expect(res.guards).toContain('urgent_reserve');
	});

	it('une passe `due` y a accès, et c’est toute la différence', () => {
		const res = budgetOf({ poolUsed: CONFIG.dailyPoolTotal - CONFIG.poolUrgentReserve, scope: 'due' });
		expect(res.poolAvailable).toBe(CONFIG.poolUrgentReserve);
		expect(res.budget).toBe(Math.min(CONFIG.dailyBudgetPerProject, CONFIG.poolUrgentReserve));
		expect(res.guards).toEqual([]);
	});

	it('pool réellement épuisé ⇒ `pool_exhausted`, pas `urgent_reserve` : deux causes, deux noms', () => {
		const res = budgetOf({ poolUsed: CONFIG.dailyPoolTotal + 10, scope: 'due' });
		expect(res.budget).toBe(0);
		expect(res.guards).toContain('pool_exhausted');
		expect(res.guards).not.toContain('urgent_reserve');
	});

	it('un budget projet à 0 le DIT au lieu de rendre 0 en silence', () => {
		const res = budgetOf({ projectDailyBudget: 0 });
		expect(res.budget).toBe(0);
		expect(res.guards).toContain('project_budget_zero');
	});

	it('un `budget` forgé au payload ne peut pas dépasser les plafonds', () => {
		expect(budgetOf({ jobBudget: 100_000 }).budget).toBe(CONFIG.dailyBudgetPerProject);
		expect(budgetOf({ jobBudget: 3 }).budget).toBe(3);
	});

	it('le plafond du collecteur borne tout le reste', () => {
		const res = resolveBudget({
			config: resolveSelectionConfig({ dailyBudgetPerProject: 9999, jobCap: 9999, dailyPoolTotal: 99999 }),
			projectDailyBudget: 9999,
			poolUsed: 0,
			scope: 'full',
			collectorCap: MAX_URLS_PER_JOB
		});
		expect(res.budget).toBe(MAX_URLS_PER_JOB);
	});

	it('un run ordinaire ne lève aucune garde', () => {
		expect(budgetOf().guards).toEqual([]);
		expect(budgetOf().budget).toBe(CONFIG.dailyBudgetPerProject);
	});
});

describe('dedupeCandidates — une URL, une place, et les raisons CONSERVÉES', () => {
	it('la même page stratégique ET porteuse d’un finding ne paie qu’une fois le quota', () => {
		const res = dedupeCandidates([c('/a', 'strategic'), c('/a', 'finding'), c('/b', 'new')]);
		expect(res.kept).toHaveLength(2);
		expect(res.dropped).toBe(1);
	});

	it('la raison RETENUE est la plus urgente, pas la première rencontrée', () => {
		const res = dedupeCandidates([c('/a', 'sample'), c('/a', 'strategic'), c('/a', 'finding')]);
		expect(res.kept[0].reason).toBe('finding');
	});

	it('les raisons secondaires ne sont pas perdues : « pourquoi » se répond avec la liste', () => {
		const res = dedupeCandidates([c('/a', 'finding'), c('/a', 'strategic'), c('/a', 'sample')]);
		expect(res.alsoBecause.get('https://x.ch/a')).toEqual(['strategic', 'sample']);
	});

	it('une URL non normalisable est ÉCARTÉE : elle ne pourrait jamais être honorée', () => {
		const res = dedupeCandidates([
			{ url: 'https://x.ch/a', urlNormalized: '', reason: 'new' },
			{ url: 'https://x.ch/b', urlNormalized: '   ', reason: 'new' },
			c('/c', 'new')
		]);
		expect(res.kept).toHaveLength(1);
		expect(res.kept[0].urlNormalized).toBe('https://x.ch/c');
	});

	it('rejouable : l’ordre d’arrivée ne change pas le résultat', () => {
		const input = [c('/b', 'new'), c('/a', 'finding'), c('/c', 'sample'), c('/a', 'strategic')];
		expect(dedupeCandidates(input).kept).toEqual(dedupeCandidates([...input].reverse()).kept);
	});
});

describe('compareCandidates — ordre TOTAL, sinon « rejouer la politique » ne vérifie rien', () => {
	it('famille avant raison, raison avant poids, poids avant URL', () => {
		const sorted = [
			c('/z', 'sample', 999),
			c('/a', 'new', 1),
			c('/b', 'new', 5),
			c('/y', 'finding')
		].sort(compareCandidates);
		expect(sorted.map((x) => x.reason)).toEqual(['finding', 'new', 'new', 'sample']);
		// À raison égale, le poids fort passe devant.
		expect(sorted[1].urlNormalized).toBe('https://x.ch/b');
	});

	it('deux candidats strictement identiques ne permutent pas', () => {
		const a = c('/a', 'new', 3);
		const b = c('/a', 'new', 3);
		expect(compareCandidates(a, b)).toBe(0);
	});

	it('l’URL départage quand tout le reste est égal — la clé finale de l’ordre total', () => {
		expect(compareCandidates(c('/a', 'new'), c('/b', 'new'))).toBeLessThan(0);
	});
});

describe('allocate — ACCEPTATION 1 : l’échantillon ne peut pas manger le quota', () => {
	it('500 candidats `sample`, budget 40 ⇒ au plus 16 slots d’échantillon', () => {
		const res = allocate({ candidates: many(500, 'sample'), budget: 40, samplePctMax: 40 });
		expect(res.sampleCap).toBe(16);
		expect(res.byBucket.sample).toBe(16);
		expect(res.kept).toHaveLength(16);
		// Et surtout : jamais 40. Le reste du budget n'est pas dépensé s'il n'y a que du sample.
		expect(res.byBucket.sample).toBeLessThan(40);
		expect(res.guards).toContain('sample_capped');
	});

	it('un `samplePctMax` forgé à 100 ne desserre rien au-delà de 60 %', () => {
		const res = allocate({ candidates: many(500, 'sample'), budget: 40, samplePctMax: 100 });
		expect(res.byBucket.sample).toBe(24);
		expect(res.byBucket.sample).toBeLessThan(40);
	});

	it('un urgent passe TOUJOURS, quel que soit le nombre de candidats routine et sample', () => {
		const res = allocate({
			candidates: [...many(500, 'sample'), ...many(500, 'new'), c('/urgent', 'finding')],
			budget: 40,
			samplePctMax: 40
		});
		expect(res.kept[0].reason).toBe('finding');
		expect(res.kept.some((k) => k.urlNormalized === 'https://x.ch/urgent')).toBe(true);
		expect(res.kept).toHaveLength(40);
	});

	it('budget entièrement pris par l’urgent ⇒ zéro échantillon, jamais l’inverse', () => {
		const res = allocate({ candidates: [...many(50, 'finding'), ...many(50, 'sample')], budget: 40, samplePctMax: 60 });
		expect(res.byBucket.priority).toBe(40);
		expect(res.byBucket.sample).toBe(0);
	});
});

describe('allocate — les slots inutilisés passent à la famille suivante, dans les deux sens', () => {
	it('une routine plus courte rend ses slots à l’échantillon, sous le cap', () => {
		const res = allocate({
			candidates: [...many(2, 'new'), ...many(100, 'sample')],
			budget: 40,
			samplePctMax: 40
		});
		expect(res.byBucket.priority).toBe(2);
		// 38 slots libres, mais le cap tient toujours.
		expect(res.byBucket.sample).toBe(16);
	});

	it('un échantillon plus court laisse la place à la routine', () => {
		const res = allocate({
			candidates: [...many(100, 'new'), ...many(3, 'sample')],
			budget: 40,
			samplePctMax: 40
		});
		expect(res.byBucket.sample).toBe(3);
		expect(res.byBucket.priority).toBe(37);
		expect(res.guards).not.toContain('sample_capped');
	});
});

describe('allocate — la coupe et la fusion se DISENT, jamais en silence', () => {
	it('les candidats écartés faute de budget sont comptés', () => {
		const res = allocate({ candidates: many(100, 'new'), budget: 40, samplePctMax: 40 });
		expect(res.kept).toHaveLength(40);
		expect(res.dropped).toBe(60);
	});

	it('les doublons fusionnés sont comptés à part : quota économisé, pas perdu', () => {
		const res = allocate({
			candidates: [c('/a', 'finding'), c('/a', 'strategic'), c('/b', 'new')],
			budget: 40,
			samplePctMax: 40
		});
		expect(res.merged).toBe(1);
		expect(res.dropped).toBe(0);
	});

	it('le rang est CONTIGU et croissant : la coupe est lisible', () => {
		const res = allocate({ candidates: many(10, 'new'), budget: 4, samplePctMax: 40 });
		expect(res.kept.map((k) => k.rank)).toEqual([0, 1, 2, 3]);
	});

	it('aucun candidat ⇒ `no_candidates`, pas un silence qu’on lirait « rien à inspecter »', () => {
		const res = allocate({ candidates: [], budget: 40, samplePctMax: 40 });
		expect(res.kept).toEqual([]);
		expect(res.guards).toContain('no_candidates');
	});

	it('budget 0 ⇒ rien de gardé, et tous les candidats comptés comme écartés', () => {
		const res = allocate({ candidates: many(10, 'finding'), budget: 0, samplePctMax: 40 });
		expect(res.kept).toEqual([]);
		expect(res.dropped).toBe(10);
	});

	it('chaque ligne gardée porte son bucket et sa famille — c’est ce que la base persiste', () => {
		const res = allocate({
			candidates: [c('/a', 'finding'), c('/b', 'new'), c('/c', 'sample')],
			budget: 40,
			samplePctMax: 40
		});
		expect(res.kept.map((k) => [k.reason, k.bucket, k.family])).toEqual([
			['finding', 'priority', 'urgent'],
			['new', 'priority', 'routine'],
			['sample', 'sample', 'sample']
		]);
	});

	it('rejouable : deux allocations sur les mêmes données rendent la même sélection', () => {
		const candidates = [...many(30, 'new'), ...many(30, 'sample'), ...many(5, 'finding')];
		const a = allocate({ candidates, budget: 40, samplePctMax: 40 });
		const b = allocate({ candidates: [...candidates].reverse(), budget: 40, samplePctMax: 40 });
		expect(a.kept.map((k) => k.urlNormalized)).toEqual(b.kept.map((k) => k.urlNormalized));
	});
});

describe('isSampleDue — « jamais observée » est DUE, ce n’est pas « observée récemment »', () => {
	it('jamais observée ⇒ due : c’est ce qui fait démarrer la rotation sur un projet neuf', () => {
		expect(isSampleDue({ lastObservedDate: null, today: '2026-07-25', intervalDays: 14 })).toBe(true);
	});

	it('une date illisible ⇒ due : ne pas savoir ne vaut pas « fraîche »', () => {
		expect(isSampleDue({ lastObservedDate: 'jamais', today: '2026-07-25', intervalDays: 14 })).toBe(
			true
		);
	});

	it('l’intervalle est atteint, pas dépassé, pour redevenir candidate', () => {
		expect(isSampleDue({ lastObservedDate: '2026-07-11', today: '2026-07-25', intervalDays: 14 })).toBe(true);
		expect(isSampleDue({ lastObservedDate: '2026-07-12', today: '2026-07-25', intervalDays: 14 })).toBe(false);
	});
});

describe('échéances — une absence d’inspection n’est ni une guérison ni un abandon muet', () => {
	it('une échéance du jour ou passée est due ; une échéance future ne l’est pas', () => {
		expect(isDue({ dueDate: '2026-07-25', today: '2026-07-25' })).toBe(true);
		expect(isDue({ dueDate: '2026-07-20', today: '2026-07-25' })).toBe(true);
		expect(isDue({ dueDate: '2026-07-26', today: '2026-07-25' })).toBe(false);
	});

	it('une échéance non honorée au-delà de `maxAgeDays` est abandonnée — et comptée par l’appelant', () => {
		expect(isExpired({ dueDate: '2026-07-10', today: '2026-07-25', maxAgeDays: 14 })).toBe(true);
		expect(isExpired({ dueDate: '2026-07-11', today: '2026-07-25', maxAgeDays: 14 })).toBe(false);
	});

	it('une date illisible n’expire RIEN : on ne jette pas sur une donnée qu’on n’a pas lue', () => {
		expect(isExpired({ dueDate: 'n’importe quoi', today: '2026-07-25', maxAgeDays: 14 })).toBe(false);
	});

	it('daysBetween et addDays sont réciproques, y compris à cheval sur un mois', () => {
		expect(addDays('2026-07-25', 7)).toBe('2026-08-01');
		expect(daysBetween('2026-07-25', '2026-08-01')).toBe(7);
		expect(daysBetween('2026-07-25', '2026-07-25')).toBe(0);
		expect(daysBetween('illisible', '2026-07-25')).toBeNull();
		expect(addDays('illisible', 7)).toBe('illisible');
	});
});

describe('matchesExclude — les motifs de SÉLECTION, pas ceux de la soumission', () => {
	it('aucun motif ⇒ rien n’est exclu', () => {
		expect(matchesExclude('https://x.ch/tag/a', [])).toBe(false);
	});

	it('correspondance par sous-chaîne, comme le legacy', () => {
		expect(matchesExclude('https://x.ch/tag/a', ['/tag/'])).toBe(true);
		expect(matchesExclude('https://x.ch/blog/a', ['/tag/'])).toBe(false);
	});

	it('un motif vide n’exclut pas tout — ce serait éteindre la sélection par accident', () => {
		expect(matchesExclude('https://x.ch/a', [''])).toBe(false);
	});
});

// ── Lot 2 : les producteurs d'intentions ────────────────────────────

describe('postPublishSelections — trois rendez-vous, pas trois fois la même dépense', () => {
	const OFFSETS = [3, 7, 28] as const;

	it('pose une échéance par offset, datée depuis la PUBLICATION', () => {
		const sel = postPublishSelections({
			url: 'https://x.ch/article',
			publishedDate: '2026-03-10',
			offsets: OFFSETS,
			contentId: 'ct_1'
		});
		// La base est la date de publication, jamais « aujourd'hui » : une transition rejouée
		// une semaine plus tard doit rendre EXACTEMENT les mêmes échéances, sinon l'idempotence
		// par `(url_normalized, due_date)` ne tient plus.
		expect(sel.map((s) => s.dueDate)).toEqual(['2026-03-13', '2026-03-17', '2026-04-07']);
		expect(sel.every((s) => s.reason === 'post_publish')).toBe(true);
		expect(sel.every((s) => s.bucket === 'priority')).toBe(true);
	});

	it('trois lignes SURVIVENT à la dédup de la persistance (clé url + échéance)', () => {
		const sel = postPublishSelections({
			url: 'https://x.ch/article',
			publishedDate: '2026-03-10',
			offsets: OFFSETS
		});
		// La même clé que `persistSelections` : trois dates distinctes ⇒ trois lignes.
		const keys = new Set(sel.map((s) => `${s.urlNormalized}|${s.dueDate}`));
		expect(keys.size).toBe(3);
		// …alors que la dédup de l'ALLOCATION, elle, n'en garderait qu'une. C'est précisément
		// pourquoi ces candidats ne passent pas par `allocate`.
		expect(dedupeCandidates(sel).kept).toHaveLength(1);
	});

	it('chaque échéance porte de quoi la justifier', () => {
		const sel = postPublishSelections({
			url: 'https://x.ch/article',
			publishedDate: '2026-03-10',
			offsets: OFFSETS,
			contentId: 'ct_1'
		});
		expect(sel[0].reasonDetail).toEqual({
			contentId: 'ct_1',
			publishedAt: '2026-03-10',
			offsetDays: 3
		});
	});

	it('à échéances dues ensemble, le J+3 passe avant le J+28', () => {
		const sel = postPublishSelections({
			url: 'https://x.ch/article',
			publishedDate: '2026-03-10',
			offsets: OFFSETS
		});
		expect([...sel].sort(compareCandidates).map((s) => s.reasonDetail?.offsetDays)).toEqual([
			3, 7, 28
		]);
	});

	it('une URL non normalisable ne pose RIEN — une échéance jamais honorable serait éternelle', () => {
		expect(
			postPublishSelections({ url: '/relative', publishedDate: '2026-03-10', offsets: OFFSETS })
		).toEqual([]);
	});

	it('une date de publication illisible ne pose RIEN', () => {
		// Sinon `addDays` rendrait la chaîne inchangée : trois échéances identiques et fausses,
		// dont deux perdues au `ON CONFLICT` — un J+28 qui se croit honoré à J+0.
		expect(
			postPublishSelections({ url: 'https://x.ch/a', publishedDate: 'jamais', offsets: OFFSETS })
		).toEqual([]);
	});

	it('le fragment est normalisé — sinon la page paierait deux fois pour une mesure', () => {
		const sel = postPublishSelections({
			url: 'https://x.ch/article#top',
			publishedDate: '2026-03-10',
			offsets: [3]
		});
		expect(sel[0].urlNormalized).toBe('https://x.ch/article');
	});
});

describe('manualSelections — un audit à la main reste BORNÉ', () => {
	const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://x.ch/p${i}`);

	it('coupe au budget, et ce qui est coupé est le BAS de la liste écrite', () => {
		const res = manualSelections({ urls: urls(50), today: '2026-03-10', budget: 5 });
		expect(res.kept).toHaveLength(5);
		expect(res.kept.map((k) => k.url)).toEqual(urls(5));
		expect(res.truncated).toHaveLength(45);
		expect(res.truncated[0]).toBe('https://x.ch/p5');
	});

	it('`0` veut dire ZÉRO, jamais « illimité »', () => {
		// L'inverse de `job-limits.ts`. Lire 0 comme « pas de limite » ferait d'un pool épuisé
		// une autorisation à inspecter les 500 URLs collées dans le terminal.
		const res = manualSelections({ urls: urls(10), today: '2026-03-10', budget: 0 });
		expect(res.kept).toEqual([]);
		expect(res.truncated).toHaveLength(10);
	});

	it('les doublons sont fusionnés AVANT le comptage du budget', () => {
		const res = manualSelections({
			urls: ['https://x.ch/a', 'https://x.ch/a#top', 'https://x.ch/b'],
			today: '2026-03-10',
			budget: 3
		});
		expect(res.merged).toBe(1);
		expect(res.kept.map((k) => k.urlNormalized)).toEqual(['https://x.ch/a', 'https://x.ch/b']);
	});

	it('les URLs non normalisables sont écartées et DITES, jamais comptées comme retenues', () => {
		const res = manualSelections({
			urls: ['/relative', 'https://x.ch/a'],
			today: '2026-03-10',
			budget: 5
		});
		expect(res.unnormalizable).toEqual(['/relative']);
		expect(res.kept).toHaveLength(1);
	});

	it('la raison `manual` est de famille URGENTE — on ne tape pas une URL à la main sans motif', () => {
		const res = manualSelections({ urls: urls(1), today: '2026-03-10', budget: 1, note: 'audit' });
		expect(familyForReason(res.kept[0].reason)).toBe('urgent');
		expect(res.kept[0].reasonDetail).toEqual({ note: 'audit', requestedAt: '2026-03-10' });
		// Due le jour même : un audit manuel n'attend pas.
		expect(res.kept[0].dueDate).toBe('2026-03-10');
	});
});
