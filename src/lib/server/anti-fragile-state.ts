/**
 * E18 — Anti-fragilité du monitoring hebdomadaire : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), colocalisé avec son exécutant comme
 * `report-publication-state.ts` l'est avec `report-publication.ts`. Deux sujets, une seule
 * raison d'être ensemble : ils répondent à la même question — **comment le système s'adapte
 * quand un run rame, au lieu de laisser un `partial` dormir ou de foncer plus fort dans le mur.**
 *
 *   1. la DÉTECTION d'un projet à timeouts récurrents (volet B) ;
 *   2. le RESSERREMENT de son budget d'inspection (volet C).
 *
 * ⭐ **L'anti-fragile à l'endroit : on RÉDUIT la charge d'un projet qui rame.** Quand Google
 * répond lentement (`ProviderTimeout`, appel > 30 s) ou qu'une fonction Vercel meurt
 * (`WorkerDied`), ce n'est pas un problème de volume — wildcat n'avait que 15 URLs et a quand
 * même eu 3 échecs le 10/08. Augmenter le nombre d'URLs d'un projet qui timeout serait
 * PRO-CYCLIQUE (plus d'appels = plus de chance de heurter le mur). Le resserrement du lot fait
 * passer chaque tentative sous le budget de durée et étale la charge ; une fois le projet
 * stable, le budget remonte vers le défaut.
 */

// ── Vocabulaire des échecs d'inspection ─────────────────────────────

/**
 * Les codes d'erreur de tentatives qui trahissent un provider lent ou un worker tué — la
 * source de vérité est `job_attempts.error_code` (append-only), pas un label de statut.
 *
 *   - `ProviderTimeout` — `withRequestTimeout` (gsc-auth.ts) a couvert un appel Google sans
 *     réponse après 30 s, classé `retryable`.
 *   - `WorkerDied` — bail expiré sans battement : la fonction Vercel a été tuée (SIGKILL), le
 *     reaper a rendu la tentative `abandoned`.
 */
export const INSPECTION_TIMEOUT_CODES = ['ProviderTimeout', 'WorkerDied'] as const;
export type InspectionTimeoutCode = (typeof INSPECTION_TIMEOUT_CODES)[number];

/** Vrai si un code d'erreur de tentative signale un timeout d'inspection. */
export function isInspectionTimeoutCode(code: string | null | undefined): boolean {
	if (!code) return false;
	return (INSPECTION_TIMEOUT_CODES as readonly string[]).includes(code);
}

// ── Volet B — Détection d'un projet à timeouts récurrents ───────────

export interface TimeoutWeek {
	/** Date de début de semaine `YYYY-MM-DD` — la clé de la fenêtre. */
	weekStart: string;
	/** Vrai si au moins UNE tentative d'inspection de la semaine porte un code timeout. */
	timedOut: boolean;
}

export interface RecurrentTimeoutVerdict {
	/** Projet à timeouts récurrents : la semaine courante + les précédentes le confirment. */
	recurrent: boolean;
	/** Semaines concernées, dans l'ordre chronologique. */
	weeks: TimeoutWeek[];
	/** Nombre de semaines (sur la fenêtre) avec au moins un timeout. */
	timedOutWeeks: number;
	/** Nombre de semaines examinées. */
	totalWeeks: number;
	/** Une phrase qui dit le verdict — jamais un `boolean` nu (doctrine `BlindSpot`). */
	note: string;
}

/**
 * Seuil de récurrence : un projet est jugé « à timeouts récurrents » quand au moins
 * `timeoutThreshold` semaines de la fenêtre portent un timeout.
 */
export const RECURRENT_TIMEOUT_DEFAULTS = {
	/** Fenêtre examinée, en semaines. */
	windowWeeks: 3,
	/** Semaines (sur la fenêtre) nécessaires pour juger le projet récurrent. */
	timeoutThreshold: 2
} as const;

export function detectRecurrentTimeout(input: {
	weeks: TimeoutWeek[];
	windowWeeks?: number;
	timeoutThreshold?: number;
}): RecurrentTimeoutVerdict {
	const windowWeeks = input.windowWeeks ?? RECURRENT_TIMEOUT_DEFAULTS.windowWeeks;
	const threshold = input.timeoutThreshold ?? RECURRENT_TIMEOUT_DEFAULTS.timeoutThreshold;
	const weeks = input.weeks.slice(-windowWeeks);
	const timedOutWeeks = weeks.filter((w) => w.timedOut).length;
	const totalWeeks = weeks.length;
	const recurrent = timedOutWeeks >= threshold;

	const note = recurrent
		? `inspection en timeout sur ${timedOutWeeks}/${totalWeeks} dernières semaines (seuil ${threshold})`
		: `inspection en timeout sur ${timedOutWeeks}/${totalWeeks} dernières semaines (sous le seuil ${threshold})`;

	return { recurrent, weeks, timedOutWeeks, totalWeeks, note };
}

// ── Volet C — Resserrement du budget d'inspection ───────────────────

export interface TightenedBudget {
	/** Budget quotidien effectif après resserrement. */
	effectiveBudget: number;
	/** Budget de base (défaut du projet). */
	baseBudget: number;
	/** Borne basse : on ne descend jamais sous ce plancher. */
	minBudget: number;
	/** Vrai si le budget a été resserré en dessous du défaut. */
	tightened: boolean;
	/** Facteur appliqué (≤ 1 quand resserré). */
	multiplier: number;
	note: string;
}

/** Borne basse dure du budget quotidien par projet. Zéro URL n'est pas une politique : le
 * collecteur a déjà ses propres gardes, et un budget à 0 priverait le projet de toute
 * inspection. */
export const MIN_INSPECTION_BUDGET = 5;

/**
 * Facteur de resserrement quand le projet est jugé à timeouts récurrents.
 * Volontairement modéré (0.5) : on veut que le run finisse dans sa fenêtre, pas le réduire à
 * l'inaction. Une seule marche, pas une cascade — la détection est binaire (seuil), le
 * resserrement aussi.
 */
export const TIGHTENING_MULTIPLIER = 0.5;

/**
 * Calcule le budget d'inspection effectif d'un projet.
 *
 * Le resserrement n'a PAS besoin d'écrire dans `project_projections` (dont le registre est
 * possédé par le migrateur neutre, loi n°5 du Noyau) : il est calculé À L'EXÉCUTION à partir du
 * verdict de récurrence, ce qui le rend automatiquement réversible — quand le projet redevient
 * stable (plus de timeout sur la fenêtre), le verdict passe à `recurrent: false` et le budget
 * revient au défaut sans aucun geste.
 *
 * `minBudget` borne basse : on plafonne le resserrement pour ne jamais descendre sous un
 * plancher qui priverait le projet de toute inspection.
 */
export function computeTightenedBudget(input: {
	/** Budget de base (défaut du projet). */
	baseBudget: number;
	/** Verdict de récurrence (volet B). */
	recurrent: boolean;
	minBudget?: number;
}): TightenedBudget {
	const baseBudget = Math.max(0, Math.floor(input.baseBudget));
	const minBudget = Math.max(0, Math.floor(input.minBudget ?? MIN_INSPECTION_BUDGET));
	const minEffective = Math.min(baseBudget, minBudget);

	if (!input.recurrent || baseBudget <= minEffective) {
		return {
			effectiveBudget: baseBudget,
			baseBudget,
			minBudget: minEffective,
			tightened: false,
			multiplier: 1,
			note: input.recurrent
				? 'projet à timeouts récurrents mais déjà au plancher : pas de resserrement possible'
				: 'projet stable : budget au défaut'
		};
	}

	const tightened = Math.max(minEffective, Math.floor(baseBudget * TIGHTENING_MULTIPLIER));
	return {
		effectiveBudget: tightened,
		baseBudget,
		minBudget: minEffective,
		tightened: true,
		multiplier: TIGHTENING_MULTIPLIER,
		note: `projet à timeouts récurrents : budget resserré de ${baseBudget} à ${tightened} (×${TIGHTENING_MULTIPLIER})`
	};
}
