/**
 * JOB-007 — Cœur PUR de la console d'exploitation des jobs.
 *
 * La console ne décide rien de neuf sur la file : elle RÉVÈLE ce que JOB-001/002/003
 * y ont déjà écrit. Ce module porte donc les trois seules choses qui se raisonnent
 * sans la base — et qui, elles, doivent être testées :
 *
 *   1. `normalizeJobFilters` — ce qui vient de l'URL est réduit au vocabulaire connu
 *      AVANT d'atteindre une requête. Un statut inventé est ÉCARTÉ, jamais transmis.
 *   2. `canCancelJob` / `canRequeueJob` — la légalité d'une action d'exploitation
 *      (miroir du `canTransition` de `finding-state.ts`), pour que l'interface propose
 *      exactement ce que les gardes SQL accepteront.
 *   3. `explainFailure` — l'acceptation « un opérateur comprend un échec sans lire
 *      directement la DB ». `last_error_class` est une étiquette de machine ; ici elle
 *      devient un verdict et une action.
 *
 * Ce module reste SERVEUR : il dépend des vocabulaires (`JOB_STATUSES`,
 * `ERROR_CLASSES`) qui vivent avec la file. Les libellés et les formats, eux, sont
 * dans `$lib/utils/job-format.ts` — une page Svelte ne peut pas importer
 * `$lib/server`, et surtout la CLI et la console doivent traduire pareil.
 *
 * Aucun accès DB : ces fonctions décident, elles n'observent pas.
 */
import { ERROR_CLASSES, type ErrorClass } from './job-retry.js';
import { JOB_STATUSES, type JobStatus } from './monitoring-state.js';
import {
	DEPENDENCY_SATISFIED,
	classifyDependencyGate,
	type DependencyStatuses,
	type JobDependency
} from './job-graph.js';

// ── Filtres ─────────────────────────────────────────────────────────

export interface JobFilters {
	statuses: JobStatus[];
	errorClasses: ErrorClass[];
	projectSlug: string | null;
	type: string | null;
	/** DASH-006 — restreint aux jobs d'un run logique (`?run=<id>`). */
	runId: string | null;
	limit: number;
	offset: number;
}

export const JOBS_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Ce que la page sait lire dans l'URL (`?status=dead,failed&class=auth`). */
export interface RawJobFilters {
	status?: string | null;
	class?: string | null;
	project?: string | null;
	type?: string | null;
	run?: string | null;
	limit?: string | null;
	offset?: string | null;
}

function splitList(raw: string | null | undefined): string[] {
	return (raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Réduit des paramètres d'URL au vocabulaire connu.
 *
 * Une valeur hors vocabulaire est ÉCARTÉE et non refusée : un lien périmé doit
 * afficher la file, pas une erreur. La garantie qui compte est l'inverse — rien
 * d'inconnu ne descend jusqu'à la requête, donc le filtre ne peut pas devenir un
 * canal d'écriture arbitraire. `projectSlug` et `type` restent libres : ce sont
 * des valeurs LIÉES (`$n`), jamais concaténées — `run` de même.
 */
export function normalizeJobFilters(raw: RawJobFilters): JobFilters {
	const statuses = splitList(raw.status).filter((s): s is JobStatus =>
		(JOB_STATUSES as readonly string[]).includes(s)
	);
	const errorClasses = splitList(raw.class).filter((c): c is ErrorClass =>
		(ERROR_CLASSES as readonly string[]).includes(c)
	);

	const parsedLimit = Number(raw.limit);
	const limit =
		Number.isFinite(parsedLimit) && parsedLimit > 0
			? Math.min(Math.floor(parsedLimit), MAX_PAGE_SIZE)
			: JOBS_PAGE_SIZE;

	const parsedOffset = Number(raw.offset);
	const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? Math.floor(parsedOffset) : 0;

	return {
		// Dédupliqués : `?status=dead,dead` ne doit pas dupliquer un paramètre lié.
		statuses: [...new Set(statuses)],
		errorClasses: [...new Set(errorClasses)],
		projectSlug: raw.project?.trim() || null,
		type: raw.type?.trim() || null,
		runId: raw.run?.trim() || null,
		limit,
		offset
	};
}

// ── Légalité des actions d'exploitation ─────────────────────────────

/**
 * Statuts depuis lesquels une ANNULATION est légale.
 *
 * `running` en fait partie : on ne tue pas le worker, on lui retire son bail —
 * `renewLease` cesse alors de matcher et le runner interrompt son handler. Un job
 * `succeeded` n'est pas annulable (son effet a eu lieu), un `cancelled` non plus
 * (rien à annuler deux fois).
 */
export const CANCELLABLE_STATUSES: readonly JobStatus[] = ['queued', 'running', 'dead', 'failed'];

/**
 * Statuts depuis lesquels une REPRISE est légale — miroir exact de la garde SQL de
 * `requeueDeadJob`.
 *
 * `skipped` en fait partie (JOB-004), et c'est nécessaire : un job sauté faute de
 * prérequis ne repart JAMAIS tout seul, même une fois son prérequis relancé et réussi
 * — rien ne ressuscite un statut terminal, et c'est voulu. Sans cette reprise, le skip
 * serait un cul-de-sac, exactement ce que JOB-003 avait ouvert pour la dead-letter.
 * L'ordre à respecter est dans `explainFailure` : le prérequis d'abord, le dépendant
 * ensuite (relancé avant, la garde de réclamation le retiendrait de toute façon).
 */
export const REQUEUABLE_STATUSES: readonly JobStatus[] = ['dead', 'failed', 'skipped'];

export function canCancelJob(status: string): boolean {
	return (CANCELLABLE_STATUSES as readonly string[]).includes(status);
}

export function canRequeueJob(status: string): boolean {
	return (REQUEUABLE_STATUSES as readonly string[]).includes(status);
}

// ── Dépendances, telles que l'écran doit les montrer ────────────────

export interface DependencyRow {
	jobId: string;
	jobType: string;
	required: boolean;
	/** Statut du prérequis, ou `null` si sa ligne n'existe plus. */
	status: string | null;
	satisfied: boolean;
}

export interface DependencyView {
	rows: DependencyRow[];
	/** Types encore en cours — ce que ce job attend, ici et maintenant. */
	waitingOn: string[];
	/** Le job est retenu par la garde de réclamation (il n'est donc pas « coincé »). */
	blocked: boolean;
	/** Badge court, ou `null` s'il n'y a rien à signaler. */
	label: string | null;
}

/**
 * Traduit les arêtes d'un job en ce qu'un écran doit en dire.
 *
 * DÉRIVÉE, jamais lue dans un état persisté : la file n'a pas de statut `blocked` et
 * n'en aura pas. Deux états qui peuvent diverger valent moins qu'un seul qui se
 * recalcule (même raison qu'au « zéro table de planification » de JOB-005).
 *
 * Ce qu'elle existe pour éviter : un job `queued` que la garde retient ressemble
 * EXACTEMENT à un job coincé. Sans cette ligne, l'opérateur relancerait le mauvais.
 */
export function describeDependencies(input: {
	deps: JobDependency[];
	statuses: DependencyStatuses;
	/** Statut du job lui-même : seul un `queued` peut être « en attente ». */
	status?: string;
}): DependencyView {
	const rows: DependencyRow[] = input.deps.map((d) => {
		const status = input.statuses[d.jobId] ?? null;
		return {
			jobId: d.jobId,
			jobType: d.jobType,
			required: d.required,
			status,
			satisfied: (DEPENDENCY_SATISFIED as readonly string[]).includes(status ?? '')
		};
	});

	if (rows.length === 0) {
		return { rows, waitingOn: [], blocked: false, label: null };
	}

	const gate = classifyDependencyGate({ deps: input.deps, statuses: input.statuses });
	// Un job qui a déjà tourné n'attend plus rien : ses arêtes ne sont plus qu'une trace.
	const pending = input.status === undefined || input.status === 'queued';
	const blocked = pending && gate.action !== 'ready';

	return {
		rows,
		waitingOn: gate.waitingOn,
		blocked,
		label: blocked
			? gate.action === 'wait'
				? `attend ${gate.waitingOn.join(', ')}`
				: 'prérequis manquant'
			: null
	};
}

// ── Verdict lisible d'un échec ──────────────────────────────────────

export interface FailureExplanation {
	/** Ce qui s'est passé, en une phrase. */
	verdict: string;
	/** Ce qu'il y a à faire — ou l'absence d'action utile. */
	action: string;
	/** `true` si relancer sans corriger la cause redonnera le même résultat. */
	willRepeat: boolean;
}

export interface ExplainFailureInput {
	status: string;
	errorClass: string | null;
	errorCode: string | null;
	attempts: number;
	maxAttempts: number;
	deferrals: number;
	requeuedCount: number;
	/** JOB-004 — porte la raison d'un `skipped` (quel prérequis a manqué). */
	errorMessage?: string | null;
}

/**
 * Traduit l'état d'échec d'un job en verdict d'opérateur.
 *
 * C'est la fonction qui porte l'acceptation « un opérateur peut comprendre un
 * échec sans lire directement la DB » : sans elle, la console se contenterait
 * d'afficher `auth` ou `permanent`, ce qui suppose de connaître JOB-003.
 */
export function explainFailure(input: ExplainFailureInput): FailureExplanation | null {
	if (input.status === 'succeeded') return null;
	if (input.status === 'cancelled') {
		return {
			verdict: 'Job annulé par un opérateur.',
			action: 'Aucune reprise automatique — le journal dit qui a décidé, et pourquoi.',
			willRepeat: false
		};
	}
	// JOB-004 — ce job n'a JAMAIS tourné. Le dire explicitement : sans ça, un opérateur
	// lirait `last_error_message` comme une erreur d'exécution et chercherait la panne
	// du mauvais côté. La cause est ailleurs, dans le prérequis.
	if (input.status === 'skipped') {
		return {
			verdict:
				input.errorMessage?.trim() ||
				'Job sauté : un prérequis obligatoire n’a pas abouti. Il n’a jamais été exécuté.',
			action:
				'Corriger puis relancer le PRÉREQUIS — c’est lui qui a échoué. ' +
				'Relancer ce job-ci ne servirait à rien tant que sa dépendance n’a pas abouti.',
			willRepeat: true
		};
	}
	if (!input.errorClass && !input.errorCode) return null;

	const code = input.errorCode ? ` (${input.errorCode})` : '';

	switch (input.errorClass) {
		case 'auth':
			return {
				verdict: `Le provider a refusé l'authentification${code}.`,
				action:
					'Renouveler le consentement ou le jeton du provider, PUIS relancer. ' +
					'Une reprise sans cela échouera à l’identique.',
				willRepeat: true
			};
		case 'permanent':
			return {
				verdict: `Erreur structurelle${code} — rejouer à l'identique redonnerait la même erreur.`,
				action:
					'Corriger la cause (permission, configuration, handler manquant) avant de relancer.',
				willRepeat: true
			};
		case 'quota':
			return {
				verdict:
					`Provider saturé${code} — le job n'a rien fait de mal : sa tentative lui a été rendue ` +
					`(${input.deferrals} report${input.deferrals > 1 ? 's' : ''}).`,
				action:
					input.status === 'dead'
						? 'Plafond de reports atteint : vérifier le quota du provider avant de relancer.'
						: 'Rien à faire — le job repartira de lui-même quand le provider aura desserré.',
				willRepeat: false
			};
		case 'retryable':
			return input.status === 'dead'
				? {
						verdict: `Budget de tentatives épuisé (${input.attempts}/${input.maxAttempts})${code}.`,
						action:
							'L’erreur était rejouable mais ne s’est jamais résorbée : vérifier la cause, ' +
							'puis relancer (le compteur repart à zéro).',
						willRepeat: false
					}
				: {
						verdict: `Échec rejouable${code} — tentative ${input.attempts}/${input.maxAttempts}.`,
						action: 'Le job est replanifié automatiquement, avec backoff.',
						willRepeat: false
					};
		default:
			return {
				verdict: `Échec de cause inconnue${code}.`,
				action:
					'Aucune classe n’a pu être établie : le job est traité comme rejouable ' +
					'(on ne condamne jamais un job sur ce qu’on n’a pas su lire).',
				willRepeat: false
			};
	}
}
