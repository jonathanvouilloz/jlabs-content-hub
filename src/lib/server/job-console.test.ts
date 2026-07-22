import { describe, it, expect } from 'vitest';
import {
	CANCELLABLE_STATUSES,
	JOBS_PAGE_SIZE,
	REQUEUABLE_STATUSES,
	canCancelJob,
	canRequeueJob,
	describeDependencies,
	explainFailure,
	normalizeJobFilters
} from './job-console.js';
import { ERROR_CLASSES } from './job-retry.js';
import { JOB_STATUSES } from './monitoring-state.js';
import type { JobDependency } from './job-graph.js';

// ── Filtres ─────────────────────────────────────────────────────────

describe('normalizeJobFilters', () => {
	it('ne laisse passer que des statuts du vocabulaire', () => {
		const f = normalizeJobFilters({ status: 'dead,queued,dropped,;DELETE' });
		expect(f.statuses).toEqual(['dead', 'queued']);
	});

	it('ne laisse passer que des classes d’erreur du vocabulaire', () => {
		const f = normalizeJobFilters({ class: 'auth,inventée,quota' });
		expect(f.errorClasses).toEqual(['auth', 'quota']);
	});

	it('un filtre entièrement inconnu vaut « aucun filtre », pas une erreur', () => {
		const f = normalizeJobFilters({ status: 'n’importe quoi' });
		expect(f.statuses).toEqual([]);
	});

	it('déduplique — un paramètre lié ne doit pas être répété', () => {
		expect(normalizeJobFilters({ status: 'dead,dead,dead' }).statuses).toEqual(['dead']);
	});

	it('borne la pagination (défaut, plafond, offset plancher)', () => {
		expect(normalizeJobFilters({}).limit).toBe(JOBS_PAGE_SIZE);
		expect(normalizeJobFilters({ limit: '9999' }).limit).toBe(200);
		expect(normalizeJobFilters({ limit: '-3' }).limit).toBe(JOBS_PAGE_SIZE);
		expect(normalizeJobFilters({ limit: 'abc' }).limit).toBe(JOBS_PAGE_SIZE);
		expect(normalizeJobFilters({ offset: '-10' }).offset).toBe(0);
		expect(normalizeJobFilters({ offset: '150' }).offset).toBe(150);
	});

	it('projet et type restent libres (valeurs LIÉES) mais vides → null', () => {
		expect(normalizeJobFilters({ project: ' jonlabs ' }).projectSlug).toBe('jonlabs');
		expect(normalizeJobFilters({ project: '   ' }).projectSlug).toBeNull();
		expect(normalizeJobFilters({ type: 'findings:lifecycle' }).type).toBe('findings:lifecycle');
	});

	it('couvre tout le vocabulaire de statuts, pas un sous-ensemble figé', () => {
		const f = normalizeJobFilters({ status: JOB_STATUSES.join(',') });
		expect(f.statuses).toEqual([...JOB_STATUSES]);
	});
});

// ── Légalité des actions ────────────────────────────────────────────

describe('légalité des actions d’exploitation', () => {
	it('annulable : en file, en cours, mort ou échoué', () => {
		expect(canCancelJob('queued')).toBe(true);
		expect(canCancelJob('running')).toBe(true);
		expect(canCancelJob('dead')).toBe(true);
		expect(canCancelJob('failed')).toBe(true);
	});

	it('jamais annulable : un job réussi ou déjà annulé', () => {
		expect(canCancelJob('succeeded')).toBe(false);
		expect(canCancelJob('cancelled')).toBe(false);
	});

	it('reprise = dead-letter seulement — miroir exact de la garde SQL de requeueDeadJob', () => {
		expect(REQUEUABLE_STATUSES).toEqual(['dead', 'failed', 'skipped']);
		expect(canRequeueJob('dead')).toBe(true);
		expect(canRequeueJob('failed')).toBe(true);
		// JOB-004 — sinon un job sauté ne repartirait jamais, même prérequis réparé.
		expect(canRequeueJob('skipped')).toBe(true);
		expect(canRequeueJob('queued')).toBe(false);
		expect(canRequeueJob('running')).toBe(false);
		expect(canRequeueJob('succeeded')).toBe(false);
		expect(canRequeueJob('cancelled')).toBe(false);
	});

	it('un statut inconnu n’autorise rien', () => {
		expect(canCancelJob('zombie')).toBe(false);
		expect(canRequeueJob('zombie')).toBe(false);
	});

	it('toute action légale porte sur un statut du vocabulaire', () => {
		for (const s of [...CANCELLABLE_STATUSES, ...REQUEUABLE_STATUSES]) {
			expect(JOB_STATUSES).toContain(s);
		}
	});
});

// ── Verdict d'échec ─────────────────────────────────────────────────

const base = {
	status: 'dead',
	errorCode: 'E',
	attempts: 5,
	maxAttempts: 5,
	deferrals: 0,
	requeuedCount: 0
};

describe('explainFailure — l’opérateur comprend sans lire la DB', () => {
	it('auth : la reprise seule ne suffit pas', () => {
		const e = explainFailure({ ...base, errorClass: 'auth' })!;
		expect(e.willRepeat).toBe(true);
		expect(e.action).toMatch(/jeton|consentement/i);
	});

	it('permanent : rejouer redonnerait la même erreur', () => {
		const e = explainFailure({ ...base, errorClass: 'permanent' })!;
		expect(e.willRepeat).toBe(true);
		expect(e.action).toMatch(/corriger/i);
	});

	it('quota : la tentative n’a PAS été consommée, et le job repart seul', () => {
		const e = explainFailure({
			...base,
			status: 'queued',
			errorClass: 'quota',
			deferrals: 3
		})!;
		expect(e.willRepeat).toBe(false);
		expect(e.verdict).toMatch(/3 reports/);
		expect(e.action).toMatch(/de lui-même/i);
	});

	it('quota en dead-letter : le plafond de reports est la cause, pas le job', () => {
		const e = explainFailure({ ...base, errorClass: 'quota', deferrals: 20 })!;
		expect(e.action).toMatch(/plafond/i);
	});

	it('retryable vivant : replanifié tout seul ; mort : budget épuisé', () => {
		const vivant = explainFailure({
			...base,
			status: 'queued',
			errorClass: 'retryable',
			attempts: 2
		})!;
		expect(vivant.verdict).toMatch(/2\/5/);
		expect(vivant.action).toMatch(/backoff/i);

		const mort = explainFailure({ ...base, errorClass: 'retryable' })!;
		expect(mort.verdict).toMatch(/épuisé/i);
	});

	it('classe absente : traité comme rejouable, jamais condamné', () => {
		const e = explainFailure({ ...base, errorClass: null })!;
		expect(e.willRepeat).toBe(false);
		expect(e.action).toMatch(/rejouable/i);
	});

	it('un job réussi n’a rien à expliquer', () => {
		expect(explainFailure({ ...base, status: 'succeeded', errorClass: null })).toBeNull();
	});

	it('un job sans erreur du tout n’a rien à expliquer', () => {
		expect(
			explainFailure({ ...base, status: 'queued', errorClass: null, errorCode: null })
		).toBeNull();
	});

	it('une annulation est expliquée comme une décision, pas comme un échec', () => {
		const e = explainFailure({ ...base, status: 'cancelled', errorClass: null, errorCode: null })!;
		expect(e.willRepeat).toBe(false);
		expect(e.verdict).toMatch(/annulé/i);
	});

	it('les 4 classes produisent toutes un verdict', () => {
		for (const c of ERROR_CLASSES) {
			expect(explainFailure({ ...base, errorClass: c })).not.toBeNull();
		}
	});
});

// ── JOB-004 — dépendances ───────────────────────────────────────────

describe('explainFailure — un job sauté n’a jamais tourné', () => {
	const skipped = {
		...base,
		status: 'skipped',
		errorClass: null,
		errorCode: 'DependencySkipped',
		errorMessage: 'Prérequis obligatoire non abouti : detect:keyword_opportunity (dead).'
	};

	it('rend la cause du prérequis, pas une erreur d’exécution', () => {
		const e = explainFailure(skipped)!;
		expect(e.verdict).toContain('detect:keyword_opportunity');
	});

	it('envoie l’opérateur relancer le PRÉREQUIS, pas ce job', () => {
		const e = explainFailure(skipped)!;
		expect(e.action).toMatch(/prérequis/i);
		expect(e.willRepeat).toBe(true);
	});

	it('sans message, dit quand même que le job n’a pas été exécuté', () => {
		const e = explainFailure({ ...skipped, errorMessage: null })!;
		expect(e.verdict).toMatch(/jamais été exécuté/i);
	});

	it('n’est pas confondu avec une annulation humaine', () => {
		const annule = explainFailure({ ...base, status: 'cancelled', errorClass: null })!;
		expect(explainFailure(skipped)!.verdict).not.toEqual(annule.verdict);
	});
});

describe('describeDependencies — un job retenu ne doit pas paraître coincé', () => {
	const dep = (over: Partial<JobDependency> = {}): JobDependency => ({
		jobId: 'j-detect',
		jobType: 'detect:keyword_opportunity',
		required: true,
		...over
	});

	it('aucune arête → rien à afficher', () => {
		const v = describeDependencies({ deps: [], statuses: {} });
		expect(v.rows).toEqual([]);
		expect(v.label).toBeNull();
		expect(v.blocked).toBe(false);
	});

	it('prérequis en cours → badge « attend … »', () => {
		const v = describeDependencies({
			deps: [dep()],
			statuses: { 'j-detect': 'running' },
			status: 'queued'
		});
		expect(v.blocked).toBe(true);
		expect(v.label).toBe('attend detect:keyword_opportunity');
		expect(v.waitingOn).toEqual(['detect:keyword_opportunity']);
	});

	it('prérequis abouti → plus rien à signaler', () => {
		const v = describeDependencies({
			deps: [dep()],
			statuses: { 'j-detect': 'succeeded' },
			status: 'queued'
		});
		expect(v.blocked).toBe(false);
		expect(v.label).toBeNull();
		expect(v.rows[0].satisfied).toBe(true);
	});

	it('prérequis obligatoire mort → « prérequis manquant »', () => {
		const v = describeDependencies({
			deps: [dep()],
			statuses: { 'j-detect': 'dead' },
			status: 'queued'
		});
		expect(v.blocked).toBe(true);
		expect(v.label).toBe('prérequis manquant');
	});

	it('un job DÉJÀ terminé n’attend plus rien — ses arêtes ne sont qu’une trace', () => {
		const v = describeDependencies({
			deps: [dep()],
			statuses: { 'j-detect': 'dead' },
			status: 'skipped'
		});
		expect(v.blocked).toBe(false);
		expect(v.label).toBeNull();
		// La ligne reste lisible : c'est elle qui explique le skip.
		expect(v.rows[0].status).toBe('dead');
	});

	it('prérequis introuvable → statut null, non satisfait', () => {
		const v = describeDependencies({ deps: [dep()], statuses: {}, status: 'queued' });
		expect(v.rows[0].status).toBeNull();
		expect(v.rows[0].satisfied).toBe(false);
	});

	it('prérequis optionnel mort → le job n’est pas retenu', () => {
		const v = describeDependencies({
			deps: [dep({ required: false })],
			statuses: { 'j-detect': 'dead' },
			status: 'queued'
		});
		expect(v.blocked).toBe(false);
	});
});
