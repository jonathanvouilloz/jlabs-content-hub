/**
 * JOB-004 — Dépendances entre jobs : le JUGEMENT (SPEC §6.2 « dépendances entre
 * jobs », §8.2 graphe du run hebdomadaire).
 *
 * Module PUR (zéro import db/`$env`), dans la lignée de `job-retry.ts` : il décide
 * ce qu'un job en file a le droit de faire au vu de ses prérequis ; `jobs-graph.ts`
 * exécute et `jobs-claim.ts` garde la porte.
 *
 * Ce que JOB-005 laissait ouvert : le catalogue hebdo enfile `detect` PUIS `propose`,
 * mais `priority: 10` contre `8` n'est qu'un ordre de SERVICE — rien n'attend rien.
 * Deux workers concurrents, ou un détecteur reporté pour quota, et le producteur
 * travaille sur les findings de la semaine précédente, en silence.
 *
 * Trois décisions, et une seule sortie par job :
 *   - `wait`  — un prérequis n'a pas fini : le job reste en file, non réclamable ;
 *   - `skip`  — un prérequis OBLIGATOIRE a échoué pour de bon : le job est terminé
 *               sans avoir été tenté, et son run le dira (`partial`) ;
 *   - `ready` — tout ce qui devait aboutir a abouti. Un prérequis OPTIONNEL mort ne
 *               bloque personne (acceptation « Plausible indisponible ne bloque pas
 *               un rapport GSC »).
 */
import type { JobStatus } from './monitoring-state.js';

// ── Vocabulaire ─────────────────────────────────────────────────────

/**
 * Une arête, telle que `jobs.depends_on` la porte (JSON array).
 *
 * `jobType` est stocké EN PLUS de `jobId` : la console doit pouvoir écrire « attend
 * detect:keyword_opportunity » sans une requête de plus, et un prérequis purgé de la
 * base doit rester nommable — un id nu ne dit rien à personne.
 */
export interface JobDependency {
	jobId: string;
	jobType: string;
	/** Un prérequis obligatoire qui échoue fait SKIPPER le dépendant. */
	required: boolean;
}

/** Le seul statut qui satisfait une dépendance. Tout le reste est en cours ou perdu. */
export const DEPENDENCY_SATISFIED: readonly JobStatus[] = ['succeeded'];

/** Statuts encore en jeu : le dépendant attend, il ne décide rien. */
export const DEPENDENCY_PENDING: readonly JobStatus[] = ['queued', 'running'];

export type DependencyAction = 'ready' | 'wait' | 'skip';

export interface DependencyGate {
	action: DependencyAction;
	/** Types des prérequis encore en cours (ordre de déclaration). */
	waitingOn: string[];
	/** Types des prérequis OBLIGATOIRES perdus — la cause d'un `skip`. */
	failedRequired: string[];
	/** Phrase prête à poser dans le step et dans l'explication d'opérateur. */
	reason: string | null;
}

/** Statut d'un prérequis, par `jobId`. Clé absente = ligne introuvable en base. */
export type DependencyStatuses = Record<string, string | null | undefined>;

/** Prérequis introuvable : le job a été purgé. Terminal, et jamais satisfait. */
export const MISSING_PREREQUISITE = 'introuvable';

function isPending(status: string | null | undefined): boolean {
	return status !== null && status !== undefined && (DEPENDENCY_PENDING as readonly string[]).includes(status);
}

function isSatisfied(status: string | null | undefined): boolean {
	return status !== null && status !== undefined && (DEPENDENCY_SATISFIED as readonly string[]).includes(status);
}

// ── Lecture / écriture de la colonne ────────────────────────────────

/**
 * Lit `jobs.depends_on`. TOLÉRANT : ne lève jamais.
 *
 * Même discipline que `loadProjectScheduleConfig` — un payload illisible ne doit ni
 * faire échouer, ni pire, faire TAIRE la file. Une valeur qu'on ne sait pas lire est
 * une absence d'arête, et un job sans arête part immédiatement : c'est le
 * comportement d'avant JOB-004, donc le pire cas est une régression connue, pas un
 * blocage silencieux.
 *
 * `required` absent ou illisible → `true`. On ne relâche jamais une garde sur ce
 * qu'on n'a pas su lire (miroir de « une erreur illisible retombe sur `retryable` »).
 */
export function parseDependencies(raw: string | null | undefined): JobDependency[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const out: JobDependency[] = [];
	const seen = new Set<string>();
	for (const item of parsed) {
		if (!item || typeof item !== 'object') continue;
		const o = item as { jobId?: unknown; jobType?: unknown; required?: unknown };
		if (typeof o.jobId !== 'string' || o.jobId.length === 0) continue;
		// Une même arête déclarée deux fois ne doit pas doubler le message d'attente.
		if (seen.has(o.jobId)) continue;
		seen.add(o.jobId);
		out.push({
			jobId: o.jobId,
			jobType: typeof o.jobType === 'string' && o.jobType.length > 0 ? o.jobType : o.jobId,
			required: o.required === false ? false : true
		});
	}
	return out;
}

/**
 * Écrit `jobs.depends_on`. `null` quand il n'y a rien à déclarer : la colonne reste
 * NULLE sur l'écrasante majorité des jobs, et la garde SQL de `claimJob` court-circuite
 * sur ce simple `IS NULL` sans jamais toucher au JSON.
 */
export function serializeDependencies(deps: JobDependency[] | null | undefined): string | null {
	if (!deps || deps.length === 0) return null;
	const clean = deps.filter((d) => d && typeof d.jobId === 'string' && d.jobId.length > 0);
	if (clean.length === 0) return null;
	return JSON.stringify(
		clean.map((d) => ({ jobId: d.jobId, jobType: d.jobType || d.jobId, required: d.required !== false }))
	);
}

// ── La décision ─────────────────────────────────────────────────────

/**
 * Que faire d'un job en file, au vu de l'état de ses prérequis.
 *
 * L'ordre d'examen compte : on regarde D'ABORD s'il reste quelque chose en cours.
 * Un prérequis obligatoire déjà mort À CÔTÉ d'un autre encore en cours ne fait pas
 * skipper tout de suite — attendre coûte un tick, alors qu'un skip prématuré serait
 * définitif. Un prérequis OPTIONNEL en cours retient lui aussi le dépendant : lancer
 * le second pendant que le premier écrit encore ses données ferait travailler sur un
 * état à moitié posé, ce qui est exactement le désordre que ce lot ferme.
 */
export function classifyDependencyGate(input: {
	deps: JobDependency[];
	statuses: DependencyStatuses;
}): DependencyGate {
	const { deps, statuses } = input;
	if (deps.length === 0) {
		return { action: 'ready', waitingOn: [], failedRequired: [], reason: null };
	}

	const waitingOn: string[] = [];
	const failedRequired: string[] = [];
	const failedDetail: string[] = [];

	for (const dep of deps) {
		const status = statuses[dep.jobId];
		if (isPending(status)) {
			waitingOn.push(dep.jobType);
			continue;
		}
		if (isSatisfied(status)) continue;
		// Terminal et non abouti : `dead`, `failed`, `cancelled`, `skipped` — ou une
		// ligne absente. Un prérequis lui-même SKIPPÉ fait donc cascader le skip :
		// sans quoi un maillon manquant au milieu d'une chaîne laisserait la fin
		// s'exécuter sur du vide.
		if (dep.required) {
			failedRequired.push(dep.jobType);
			failedDetail.push(`${dep.jobType} (${status ?? MISSING_PREREQUISITE})`);
		}
	}

	if (waitingOn.length > 0) {
		return {
			action: 'wait',
			waitingOn,
			failedRequired,
			reason: `En attente de : ${waitingOn.join(', ')}.`
		};
	}

	if (failedRequired.length > 0) {
		return {
			action: 'skip',
			waitingOn: [],
			failedRequired,
			reason: `Prérequis obligatoire non abouti : ${failedDetail.join(', ')}.`
		};
	}

	return { action: 'ready', waitingOn: [], failedRequired: [], reason: null };
}

// ── Catalogue → arêtes ──────────────────────────────────────────────

/** Arête telle que le CATALOGUE la déclare : par type, avant que les ids n'existent. */
export interface CatalogDependency {
	jobType: string;
	/** Défaut `true` — cf. `parseDependencies`. */
	required?: boolean;
}

interface CatalogNode {
	jobType: string;
	dependsOn?: CatalogDependency[];
}

/**
 * Valide le graphe déclaré par un catalogue de cadence. LÈVE plutôt que d'écarter :
 * le catalogue est un littéral du code, une erreur y est un bug de programmation, pas
 * une donnée douteuse — et un test unitaire suffit alors à la fermer pour de bon.
 *
 * La règle est plus forte qu'une simple absence de cycle : chaque prérequis doit être
 * déclaré STRICTEMENT AVANT son dépendant. C'est exactement ce dont `planOne` a besoin
 * (il résout les ids au fil de la mise en file, dans l'ordre du tableau) et ça exclut
 * du même geste l'auto-dépendance et les cycles, qu'aucun ordre linéaire ne peut
 * satisfaire.
 */
export function validateCatalogGraph(entries: readonly CatalogNode[]): void {
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.jobType)) {
			throw new Error(`Catalogue invalide : le type "${entry.jobType}" est déclaré deux fois.`);
		}
		for (const dep of entry.dependsOn ?? []) {
			if (!seen.has(dep.jobType)) {
				throw new Error(
					`Catalogue invalide : "${entry.jobType}" dépend de "${dep.jobType}", ` +
						`qui n'est pas déclaré avant lui dans la même cadence.`
				);
			}
		}
		seen.add(entry.jobType);
	}
}

/**
 * Traduit les arêtes déclarées par type en arêtes portant de vrais ids de jobs.
 *
 * Un type sans id connu est ÉCARTÉ, pas inventé : le seul cas où ça arrive est un
 * `dryRun` ou un catalogue substitué par une preuve, où il n'y a précisément aucun
 * job à référencer. `validateCatalogGraph` couvre le cas réel (un type inconnu est
 * un bug, et il lève).
 */
export function resolveDependencies(
	deps: readonly CatalogDependency[] | undefined,
	idsByType: ReadonlyMap<string, string>
): JobDependency[] {
	if (!deps || deps.length === 0) return [];
	const out: JobDependency[] = [];
	for (const dep of deps) {
		const jobId = idsByType.get(dep.jobType);
		if (!jobId) continue;
		out.push({ jobId, jobType: dep.jobType, required: dep.required !== false });
	}
	return out;
}
