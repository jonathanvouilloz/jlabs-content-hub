import { describe, it, expect } from 'vitest';
import {
	DEPENDENCY_PENDING,
	DEPENDENCY_SATISFIED,
	MISSING_PREREQUISITE,
	classifyDependencyGate,
	parseDependencies,
	resolveDependencies,
	serializeDependencies,
	validateCatalogGraph,
	type JobDependency
} from './job-graph.js';

const dep = (over: Partial<JobDependency> = {}): JobDependency => ({
	jobId: 'job-a',
	jobType: 'detect:keyword_opportunity',
	required: true,
	...over
});

// ── Lecture de la colonne ───────────────────────────────────────────

describe('parseDependencies — tolérance', () => {
	it('null / vide → aucune arête', () => {
		expect(parseDependencies(null)).toEqual([]);
		expect(parseDependencies('')).toEqual([]);
		expect(parseDependencies(undefined)).toEqual([]);
	});

	it('JSON cassé → aucune arête, sans lever', () => {
		expect(() => parseDependencies('[{jobId:')).not.toThrow();
		expect(parseDependencies('[{jobId:')).toEqual([]);
	});

	it('objet au lieu d’un tableau → aucune arête', () => {
		expect(parseDependencies('{"jobId":"x"}')).toEqual([]);
	});

	it('éléments non-objets ou sans jobId → écartés un par un', () => {
		expect(parseDependencies('["x", null, 3, {"jobType":"t"}, {"jobId":""}]')).toEqual([]);
	});

	it('lit une arête complète', () => {
		expect(parseDependencies('[{"jobId":"j1","jobType":"detect","required":false}]')).toEqual([
			{ jobId: 'j1', jobType: 'detect', required: false }
		]);
	});

	it('`required` absent → OBLIGATOIRE (on ne relâche pas une garde qu’on n’a pas su lire)', () => {
		expect(parseDependencies('[{"jobId":"j1","jobType":"detect"}]')[0].required).toBe(true);
	});

	it('`required` illisible → obligatoire aussi', () => {
		expect(parseDependencies('[{"jobId":"j1","required":"non"}]')[0].required).toBe(true);
		expect(parseDependencies('[{"jobId":"j1","required":0}]')[0].required).toBe(true);
	});

	it('`jobType` absent → retombe sur l’id (nommable, même dégradé)', () => {
		expect(parseDependencies('[{"jobId":"j1"}]')[0].jobType).toBe('j1');
	});

	it('même arête deux fois → une seule (pas de message d’attente doublé)', () => {
		const deps = parseDependencies('[{"jobId":"j1","jobType":"a"},{"jobId":"j1","jobType":"a"}]');
		expect(deps).toHaveLength(1);
	});
});

describe('serializeDependencies', () => {
	it('aucune arête → NULL (la garde SQL court-circuite sur IS NULL)', () => {
		expect(serializeDependencies([])).toBeNull();
		expect(serializeDependencies(null)).toBeNull();
		expect(serializeDependencies([{ jobId: '', jobType: 't', required: true }])).toBeNull();
	});

	it('aller-retour stable', () => {
		const deps = [dep(), dep({ jobId: 'job-b', jobType: 'pull:plausible', required: false })];
		expect(parseDependencies(serializeDependencies(deps))).toEqual(deps);
	});
});

// ── La décision ─────────────────────────────────────────────────────

describe('classifyDependencyGate', () => {
	it('aucune arête → ready (comportement d’avant JOB-004)', () => {
		expect(classifyDependencyGate({ deps: [], statuses: {} }).action).toBe('ready');
	});

	it('prérequis `succeeded` → ready', () => {
		const gate = classifyDependencyGate({ deps: [dep()], statuses: { 'job-a': 'succeeded' } });
		expect(gate.action).toBe('ready');
		expect(gate.reason).toBeNull();
	});

	it.each(DEPENDENCY_PENDING)('prérequis `%s` → wait', (status) => {
		const gate = classifyDependencyGate({ deps: [dep()], statuses: { 'job-a': status } });
		expect(gate.action).toBe('wait');
		expect(gate.waitingOn).toEqual(['detect:keyword_opportunity']);
	});

	it('prérequis obligatoire `dead` → skip, avec la cause nommée', () => {
		const gate = classifyDependencyGate({ deps: [dep()], statuses: { 'job-a': 'dead' } });
		expect(gate.action).toBe('skip');
		expect(gate.failedRequired).toEqual(['detect:keyword_opportunity']);
		expect(gate.reason).toContain('detect:keyword_opportunity (dead)');
	});

	it.each(['dead', 'failed', 'cancelled'])('prérequis obligatoire `%s` → skip', (status) => {
		expect(classifyDependencyGate({ deps: [dep()], statuses: { 'job-a': status } }).action).toBe(
			'skip'
		);
	});

	it('prérequis lui-même `skipped` → le skip CASCADE', () => {
		const gate = classifyDependencyGate({ deps: [dep()], statuses: { 'job-a': 'skipped' } });
		expect(gate.action).toBe('skip');
	});

	it('prérequis introuvable (ligne purgée) → skip, et la raison le dit', () => {
		const gate = classifyDependencyGate({ deps: [dep()], statuses: {} });
		expect(gate.action).toBe('skip');
		expect(gate.reason).toContain(MISSING_PREREQUISITE);
	});

	it('prérequis OPTIONNEL mort → ready (Plausible indisponible ne bloque pas GSC)', () => {
		const gate = classifyDependencyGate({
			deps: [dep({ jobId: 'opt', jobType: 'pull:plausible', required: false })],
			statuses: { opt: 'dead' }
		});
		expect(gate.action).toBe('ready');
		expect(gate.failedRequired).toEqual([]);
	});

	it('prérequis OPTIONNEL encore en cours → wait quand même', () => {
		const gate = classifyDependencyGate({
			deps: [dep({ jobId: 'opt', jobType: 'pull:plausible', required: false })],
			statuses: { opt: 'running' }
		});
		expect(gate.action).toBe('wait');
	});

	it('un mort obligatoire À CÔTÉ d’un vivant → wait, pas skip (un skip est définitif)', () => {
		const gate = classifyDependencyGate({
			deps: [dep({ jobId: 'a' }), dep({ jobId: 'b', jobType: 'fetch:sitemap' })],
			statuses: { a: 'dead', b: 'running' }
		});
		expect(gate.action).toBe('wait');
		expect(gate.waitingOn).toEqual(['fetch:sitemap']);
		// La cause reste visible : elle décidera au tour suivant.
		expect(gate.failedRequired).toEqual(['detect:keyword_opportunity']);
	});

	it('mélange obligatoire mort + optionnel mort → skip sur le seul obligatoire', () => {
		const gate = classifyDependencyGate({
			deps: [dep({ jobId: 'a' }), dep({ jobId: 'b', jobType: 'pull:plausible', required: false })],
			statuses: { a: 'dead', b: 'dead' }
		});
		expect(gate.action).toBe('skip');
		expect(gate.failedRequired).toEqual(['detect:keyword_opportunity']);
	});

	it('tous les prérequis satisfaits → ready', () => {
		const gate = classifyDependencyGate({
			deps: [dep({ jobId: 'a' }), dep({ jobId: 'b', jobType: 'fetch:sitemap' })],
			statuses: { a: 'succeeded', b: 'succeeded' }
		});
		expect(gate.action).toBe('ready');
	});

	it('`succeeded` est le SEUL statut satisfaisant', () => {
		expect(DEPENDENCY_SATISFIED).toEqual(['succeeded']);
	});
});

// ── Catalogue ───────────────────────────────────────────────────────

describe('validateCatalogGraph', () => {
	it('catalogue sans arête → valide', () => {
		expect(() => validateCatalogGraph([{ jobType: 'a' }, { jobType: 'b' }])).not.toThrow();
	});

	it('prérequis déclaré AVANT son dépendant → valide', () => {
		expect(() =>
			validateCatalogGraph([{ jobType: 'a' }, { jobType: 'b', dependsOn: [{ jobType: 'a' }] }])
		).not.toThrow();
	});

	it('prérequis déclaré APRÈS → lève (planOne résout les ids dans l’ordre)', () => {
		expect(() =>
			validateCatalogGraph([{ jobType: 'b', dependsOn: [{ jobType: 'a' }] }, { jobType: 'a' }])
		).toThrow(/pas déclaré avant/);
	});

	it('type inconnu → lève', () => {
		expect(() => validateCatalogGraph([{ jobType: 'b', dependsOn: [{ jobType: 'zz' }] }])).toThrow(
			/zz/
		);
	});

	it('auto-dépendance → lève', () => {
		expect(() => validateCatalogGraph([{ jobType: 'a', dependsOn: [{ jobType: 'a' }] }])).toThrow();
	});

	it('cycle → lève (aucun ordre linéaire ne le satisfait)', () => {
		expect(() =>
			validateCatalogGraph([
				{ jobType: 'a', dependsOn: [{ jobType: 'b' }] },
				{ jobType: 'b', dependsOn: [{ jobType: 'a' }] }
			])
		).toThrow();
	});

	it('type déclaré deux fois → lève', () => {
		expect(() => validateCatalogGraph([{ jobType: 'a' }, { jobType: 'a' }])).toThrow(/deux fois/);
	});
});

describe('resolveDependencies', () => {
	it('traduit les types en ids réels', () => {
		const ids = new Map([['detect', 'job-1']]);
		expect(resolveDependencies([{ jobType: 'detect' }], ids)).toEqual([
			{ jobId: 'job-1', jobType: 'detect', required: true }
		]);
	});

	it('`required: false` est conservé', () => {
		const ids = new Map([['plausible', 'job-2']]);
		expect(resolveDependencies([{ jobType: 'plausible', required: false }], ids)[0].required).toBe(
			false
		);
	});

	it('type sans id connu → écarté (dry-run, catalogue substitué)', () => {
		expect(resolveDependencies([{ jobType: 'detect' }], new Map())).toEqual([]);
	});

	it('aucune arête déclarée → tableau vide', () => {
		expect(resolveDependencies(undefined, new Map())).toEqual([]);
	});
});
