/**
 * IDX-002 — Collecteur URL Inspection PERSISTANT (BACKLOG IDX-002, SPEC §9.2).
 *
 * **Ce qui manquait.** `indexing.ts:batchInspect` inspectait déjà des URLs — et n'en gardait
 * RIEN : il rendait des tableaux en mémoire, consommés par une route puis jetés. Le statut
 * d'indexation d'une page n'existait donc que le temps d'un appel, ce qui interdit trois
 * choses à la fois : un historique, un rerun non destructeur, et un écran qui lise la base
 * plutôt que d'appeler Google au rendu. Les trois sont les acceptations d'IDX-002.
 *
 * Trois défauts de fond du legacy, corrigés ici :
 *
 *   1. **il jetait les 5/7 des champs** — seuls `verdict` et `coverageState` survivaient, alors
 *      que `index_observations` a des colonnes pour `indexingState`, `robotsState`, les deux
 *      canonicals et `lastCrawlTime` depuis DATA-004 ;
 *   2. **il confondait erreur provider et « non indexé »** — un credential mort rendait
 *      `{ coverageState: null }`, que `classifyIndexStatus` classait `unknown`, exactement comme
 *      une page réellement inconnue de Google. Ici l'erreur **sort par `throw`**, et la
 *      distinction est portée par un type (`InspectionOutcome`), pas par une convention ;
 *   3. **il jetait une chaîne** — `classifyJobFailure` n'y trouvait ni `status` ni `reason`, donc
 *      un 429 partait en dead-letter permanente. `urlInspection` passe par `toGscApiError`, donc
 *      `GscApiError` : quota et auth sont classés juste, gratuitement.
 *
 * **Ce que ce lot ne fait PAS :** choisir les URLs. Elles arrivent dans le payload du job.
 * La politique (priorités, réserve de quota, J+3/J+7/J+28) est le sujet d'IDX-004 — installer
 * ici une règle implicite l'obligerait à la défaire. Conséquence assumée : `collect:url_inspection`
 * n'est PAS dans le catalogue hebdo (un job planifié sans liste tournerait pour rien).
 */
import type { AppDb } from '../db/types.js';
import { log } from '../log.js';
import { upsertIndexObservation } from '../observations.js';
import {
	GscApiError,
	loadGscBinding,
	syncGscIntegration,
	urlInspection,
	type GscAuthDeps,
	type GscBinding
} from '../gsc-auth.js';
import {
	capUrls,
	classifyCoverage,
	parseInspectionResult,
	type IndexedClass,
	type InspectionOutcome,
	type NormalizedInspection
} from './url-inspection-state.js';

const logger = log('collector:url-inspection');

/**
 * Pause entre deux inspections. L'API plafonne à **600 requêtes/minute par propriété** : à
 * 150 ms on reste à ~400/min, sous la limite avec marge. Sans pause, un job de 200 URLs
 * déclencherait le 429 qu'on cherche à éviter — et le déclencherait pour toute la cohorte
 * `gsc` (refroidissement JOB-006), donc aussi pour la collecte Search Analytics.
 */
const DELAY_MS = 150;

export interface CollectUrlInspectionInput {
	projectId: string;
	/** Les URLs à inspecter — fournies, jamais choisies ici (cf. IDX-004). */
	urls: string[];
	/** Plafond dur, borné par `MAX_URLS_PER_JOB`. */
	cap?: number;
	runId?: string | null;
	/** N'écrit rien : sondage et `--dry-run`. */
	dryRun?: boolean;
	deps?: GscAuthDeps;
	client?: AppDb;
	now?: Date;
	signal?: AbortSignal;
	/** Injectable pour les preuves (par défaut : la pause réelle). */
	sleep?: (ms: number) => Promise<void>;
}

export interface InspectedUrl {
	url: string;
	normalized: NormalizedInspection;
	indexedClass: IndexedClass;
	observationId: string;
}

export interface CollectUrlInspectionResult {
	projectId: string;
	siteUrl: string;
	observedDate: string;
	/** URLs réellement inspectées ET persistées. */
	inspected: InspectedUrl[];
	/**
	 * Réponses reçues mais NON comprises (pas de verdict ni de coverageState) : rien n'est
	 * écrit pour elles. Ce n'est ni un succès ni une erreur provider — c'est un trou nommé.
	 */
	unreadable: string[];
	/** Vrai si le plafond a écarté des URLs — jamais silencieux. */
	truncated: boolean;
	dropped: number;
	dryRun: boolean;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Inspecte une URL et rend une issue TYPÉE.
 *
 * Le seul endroit où une `GscApiError` est convertie en valeur — et elle devient un
 * `provider_error` explicite, jamais un résultat aux champs nuls. C'est ce qui permet à
 * l'appelant de décider *en connaissance* : ici, s'arrêter.
 */
export async function inspectOne(input: {
	binding: GscBinding;
	url: string;
	deps?: GscAuthDeps;
}): Promise<InspectionOutcome> {
	try {
		const json = await urlInspection(
			{ binding: input.binding, inspectionUrl: input.url },
			input.deps ?? {}
		);
		const { normalized, payload, understood } = parseInspectionResult(json);
		if (!understood) {
			// Une enveloppe qu'on n'a pas su lire n'est PAS « Google ne connaît pas cette page ».
			return {
				kind: 'provider_error',
				status: 200,
				reason: 'unreadable_response',
				message: `réponse d'inspection illisible pour ${input.url} (ni verdict ni coverageState)`
			};
		}
		return { kind: 'result', normalized, payload };
	} catch (err) {
		if (err instanceof GscApiError) {
			return { kind: 'provider_error', status: err.status, reason: err.reason, message: err.message };
		}
		return {
			kind: 'provider_error',
			status: 0,
			reason: null,
			message: err instanceof Error ? err.message : String(err)
		};
	}
}

/**
 * Inspecte une liste d'URLs et PERSISTE chaque résultat.
 *
 * **Contrairement au collecteur GSC, l'écriture est INCRÉMENTALE — et c'est voulu.** Là-bas,
 * une semaine partiellement écrite se lirait comme complète (donc comme une chute). Ici, une
 * URL inspectée est un fait **autonome** : elle ne prétend rien sur les autres, et rien ne la
 * compare à un total attendu. Écrire au fil de l'eau évite donc de perdre 199 inspections
 * payées au quota parce que la 200ᵉ a échoué.
 *
 * **Une erreur provider INTERROMPT le lot et remonte.** Absorber un 429 URL par URL brûlerait
 * les 199 tentatives suivantes contre un mur, et surtout : la file n'apprendrait rien. En
 * relançant l'erreur structurée, `classifyJobFailure` la classe `quota` et le refroidissement
 * JOB-006 met **toute la cohorte `gsc`** au repos — ce qui protège aussi la collecte Search
 * Analytics du même compte partagé.
 *
 * Les URLs déjà écrites RESTENT : elles sont des faits acquis, pas une transaction à annuler.
 */
export async function collectUrlInspection(
	input: CollectUrlInspectionInput
): Promise<CollectUrlInspectionResult> {
	const db = input.client ?? ((await import('../db/index.js')).db as unknown as AppDb);
	const now = input.now ?? new Date();
	const observedDate = now.toISOString().slice(0, 10);
	const sleep = input.sleep ?? sleepReal;

	const capped = capUrls(input.urls ?? [], input.cap);
	const binding = await loadGscBinding(input.projectId, { ...input.deps, client: db });

	const inspected: InspectedUrl[] = [];
	const unreadable: string[] = [];

	try {
		for (let i = 0; i < capped.kept.length; i++) {
			if (input.signal?.aborted) {
				// Bail perdu : on s'arrête. Ce qui est écrit reste (faits acquis), mais on
				// n'engage pas un quota de plus au nom d'un job qu'un autre worker a repris.
				logger.info('inspection interrompue (bail perdu)', {
					projectId: input.projectId,
					done: inspected.length,
					remaining: capped.kept.length - i
				});
				break;
			}
			const url = capped.kept[i];
			const outcome = await inspectOne({ binding, url, deps: { ...input.deps, client: db } });

			if (outcome.kind === 'provider_error') {
				if (outcome.reason === 'unreadable_response') {
					// Réponse 200 illisible : un trou NOMMÉ, pas une panne du provider. On
					// continue — rien n'indique que les URLs suivantes soient concernées.
					unreadable.push(url);
					if (DELAY_MS > 0) await sleep(DELAY_MS);
					continue;
				}
				await syncGscIntegration(
					{ binding, outcome: 'error', errorCode: outcome.reason ?? String(outcome.status) },
					{ ...input.deps, client: db }
				);
				// Remonte STRUCTURÉE : c'est ce qui rend `classifyJobFailure` exact, donc le
				// refroidissement provider effectif. Ne jamais l'absorber ici.
				throw new GscApiError({
					status: outcome.status,
					reason: outcome.reason,
					siteUrl: binding.siteUrl,
					message: outcome.message
				});
			}

			if (!input.dryRun) {
				const { id } = await upsertIndexObservation(
					{
						projectId: input.projectId,
						observedDate,
						url,
						coverageState: outcome.normalized.coverageState,
						verdict: outcome.normalized.verdict,
						indexingState: outcome.normalized.indexingState,
						robotsState: outcome.normalized.robotsState,
						googleCanonical: outcome.normalized.googleCanonical,
						userCanonical: outcome.normalized.userCanonical,
						lastCrawlAt: outcome.normalized.lastCrawlAt,
						runId: input.runId ?? null,
						payloadJson: JSON.stringify(outcome.payload)
					},
					db
				);
				inspected.push({
					url,
					normalized: outcome.normalized,
					indexedClass: classifyCoverage(outcome.normalized.coverageState),
					observationId: id
				});
			} else {
				inspected.push({
					url,
					normalized: outcome.normalized,
					indexedClass: classifyCoverage(outcome.normalized.coverageState),
					observationId: '(dry-run)'
				});
			}

			if (i < capped.kept.length - 1 && DELAY_MS > 0) await sleep(DELAY_MS);
		}

		if (inspected.length > 0 && !input.dryRun) {
			await syncGscIntegration({ binding, outcome: 'success' }, { ...input.deps, client: db });
		}
	} finally {
		logger.info('inspection terminée', {
			projectId: input.projectId,
			siteUrl: binding.siteUrl,
			observedDate,
			requested: (input.urls ?? []).length,
			inspected: inspected.length,
			unreadable: unreadable.length,
			truncated: capped.truncated,
			dropped: capped.dropped,
			dryRun: input.dryRun === true
		});
	}

	return {
		projectId: input.projectId,
		siteUrl: binding.siteUrl,
		observedDate,
		inspected,
		unreadable,
		truncated: capped.truncated,
		dropped: capped.dropped,
		dryRun: input.dryRun === true
	};
}
