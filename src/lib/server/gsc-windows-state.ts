/**
 * GSC-004 — Fenêtres de comparaison 7/28/90 jours : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), dans la lignée de `detector-state.ts`
 * et `gsc-collector-state.ts` : il décide **quelles semaines composent une fenêtre**,
 * **si deux fenêtres sont comparables**, et **ce qu'une fenêtre incomplète doit dire
 * de sa confiance**. `gsc-windows.ts` lit la base et exécute ; ici, rien qui touche
 * le monde extérieur → testable en isolation par vitest.
 *
 * Deux invariants d'acceptation GSC-004 vivent ici :
 *   - « aucun delta n'est calculé entre périodes de longueurs incompatibles » :
 *     `computeWindowDelta` refuse (`available:false`) dès que la fenêtre courante et
 *     la précédente ne couvrent pas le MÊME nombre de semaines
 *     (`areWindowsComparable`, réutilisée du détecteur) ;
 *   - « un manque de données baisse la confiance au lieu de produire un faux
 *     signal » : `windowCompleteness` dérive une couverture + des caveats explicites
 *     d'une fenêtre tronquée ou pas encore fraîche — DÉRIVÉ, jamais stocké.
 *
 * Grain : les observations GSC sont HEBDOMADAIRES (`period_start`/`period_end` =
 * lundi→dimanche). « 7/28/90 jours » = **1 / 4 / 13 semaines complètes**. Les helpers
 * day-span de `observation-state.ts` (`computeWindowStart`) servent aux domaines
 * date-grained (index, keyword), pas à GSC.
 */
import {
	areWindowsComparable,
	buildWindow,
	type ObservationRow,
	type ObservationWindow
} from './detector-state.js';
import { addDaysIso } from './collectors/gsc-collector-state.js';

// ── Spans → nombre de semaines complètes ────────────────────────────

/** Fenêtres standard du cockpit (SPEC : 7/28/90 jours), en jours. */
export const WINDOW_SPANS = [7, 28, 90] as const;
export type WindowSpan = (typeof WINDOW_SPANS)[number];

/**
 * Un span en jours → le nombre de semaines COMPLÈTES qu'il représente sur un canon
 * hebdomadaire : 7 j = 1 sem, 28 j = 4 sem, 90 j ≈ 13 sem (13×7 = 91). On n'ajuste
 * pas au jour près : une observation GSC ne porte pas de granularité inférieure à la
 * semaine, un « 90 jours » exact serait une précision que la donnée n'a pas.
 */
const SPAN_WEEKS: Record<WindowSpan, number> = { 7: 1, 28: 4, 90: 13 };

export function spanToWeeks(span: WindowSpan): number {
	return SPAN_WEEKS[span];
}

/** 52 semaines en jours — décalage année N-1 (52×7 = 364, pas 365 : on aligne sur les lundis). */
const YEAR_IN_DAYS = 364;

// ── Paire de semaines (entrée : ce que la base rend, distinct) ──────

export interface WeekBounds {
	periodStart: string;
	periodEnd: string;
}

/** Dédup par `period_start` (le loader fait déjà un DISTINCT ; on ne s'en remet pas à lui). */
function dedupeWeeks(weeks: WeekBounds[]): WeekBounds[] {
	const byStart = new Map<string, WeekBounds>();
	for (const w of weeks) {
		if (!byStart.has(w.periodStart)) byStart.set(w.periodStart, w);
	}
	return [...byStart.values()];
}

/** Tri DÉCROISSANT par `period_start` — la plus récente d'abord. */
function sortDesc(weeks: WeekBounds[]): WeekBounds[] {
	return [...weeks].sort((a, b) =>
		a.periodStart < b.periodStart ? 1 : a.periodStart > b.periodStart ? -1 : 0
	);
}

// ── Comparaison fenêtre courante vs précédente ──────────────────────

export interface WindowComparison {
	span: WindowSpan;
	/** Nombre de semaines ATTENDUES pour ce span (référence de complétude). */
	weeks: number;
	/** Fenêtre courante (les `weeks` plus récentes présentes) — `null` si aucune donnée. */
	current: ObservationWindow | null;
	/** Fenêtre précédente (les `weeks` d'avant) — `null` si l'historique est trop court. */
	prior: ObservationWindow | null;
	/** Vrai seulement si les deux fenêtres couvrent le MÊME nombre de semaines (> 0). */
	comparable: boolean;
}

/**
 * Découpe les semaines disponibles en (courante, précédente) pour un span.
 *
 * `current` = les `weeks` plus récentes ; `prior` = les `weeks` juste avant. Chacune
 * passe par `buildWindow`, qui rend `null` sur une tranche vide et ne traite JAMAIS
 * une fenêtre absente comme des zéros (§10.3). `comparable` retombe sur
 * `areWindowsComparable` : un historique trop court pour remplir `prior` rend les deux
 * fenêtres non comparables — et donc, plus bas, aucun delta.
 */
export function buildWindowComparison(availableWeeks: WeekBounds[], span: WindowSpan): WindowComparison {
	const weeks = spanToWeeks(span);
	const sorted = sortDesc(dedupeWeeks(availableWeeks));
	const current = buildWindow(sorted.slice(0, weeks), weeks);
	const prior = buildWindow(sorted.slice(weeks, weeks * 2), weeks);
	const comparable = current !== null && prior !== null && areWindowsComparable(current, prior);
	return { span, weeks, current, prior, comparable };
}

// ── Totaux d'une fenêtre ────────────────────────────────────────────

export interface WindowTotals {
	clicks: number;
	impressions: number;
	ctr: number;
	/** Position moyenne PONDÉRÉE par les impressions (même règle que le détecteur/collecteur). */
	position: number;
	/** Nombre de semaines distinctes réellement présentes dans les lignes. */
	weeksSeen: number;
}

/**
 * Agrège les lignes d'observation d'une fenêtre en totaux. CTR et position sont
 * pondérés par les impressions : une moyenne arithmétique donnerait le même poids à
 * une requête vue 3 fois et à une vue 3 000 fois, et ferait diverger le chiffre de
 * celui du détecteur et du chemin legacy.
 */
export function sumWindow(rows: ObservationRow[]): WindowTotals {
	let clicks = 0;
	let impressions = 0;
	let weightedPosition = 0;
	const weeks = new Set<string>();
	for (const r of rows) {
		clicks += r.clicks;
		impressions += r.impressions;
		weightedPosition += r.position * r.impressions;
		weeks.add(r.periodStart);
	}
	return {
		clicks,
		impressions,
		ctr: impressions > 0 ? clicks / impressions : 0,
		position: impressions > 0 ? weightedPosition / impressions : 0,
		weeksSeen: weeks.size
	};
}

// ── Delta (gate de comparabilité) ───────────────────────────────────

export interface DeltaPair {
	current: number;
	prior: number;
	/** Variation absolue `current - prior`. */
	abs: number;
	/** Variation relative en % ; `null` quand `prior` vaut 0 (pas de base de comparaison). */
	pct: number | null;
}

export type WindowDelta =
	| { available: false; reason: 'incomparable_lengths' }
	| {
			available: true;
			clicks: DeltaPair;
			impressions: DeltaPair;
			ctr: DeltaPair;
			position: DeltaPair;
	  };

function delta(current: number, prior: number): DeltaPair {
	const abs = current - prior;
	return { current, prior, abs, pct: prior !== 0 ? (abs / prior) * 100 : null };
}

/**
 * Delta entre deux fenêtres — mais SEULEMENT si elles sont comparables.
 *
 * C'est l'acceptation GSC-004 « aucun delta n'est calculé entre périodes de longueurs
 * incompatibles » rendue structurelle : le refus vit dans cette fonction pure, pas
 * dans un `{#if}` de template qui se perdrait au premier refactor. La position n'est
 * pas « inversée » ici (plus basse = mieux) : on rend le brut, l'écran interprète.
 */
export function computeWindowDelta(
	current: WindowTotals,
	prior: WindowTotals,
	comparable: boolean
): WindowDelta {
	if (!comparable) return { available: false, reason: 'incomparable_lengths' };
	return {
		available: true,
		clicks: delta(current.clicks, prior.clicks),
		impressions: delta(current.impressions, prior.impressions),
		ctr: delta(current.ctr, prior.ctr),
		position: delta(current.position, prior.position)
	};
}

// ── Complétude / fraîcheur (confiance dérivée) ──────────────────────

export interface WindowCompleteness {
	/** Fenêtre pleine ET à jour. */
	complete: boolean;
	/** Couverture 0..1 = semaines présentes / attendues. */
	coverage: number;
	/** Semaines effectivement présentes. */
	weeks: number;
	/** Semaines attendues pour le span. */
	expectedWeeks: number;
	/** La semaine la plus récente présente est bien la dernière semaine complète. */
	fresh: boolean;
	/** Raisons lisibles d'une confiance réduite (vide si complète). */
	caveats: string[];
}

/**
 * Dérive la complétude d'une fenêtre courante. Ne stocke rien (doctrine JOB-004/005 :
 * « deux états qui divergent valent moins qu'un seul qui se recalcule ») : la
 * complétude se recalcule à chaque lecture contre la dernière semaine complète.
 *
 * Deux manques distincts, deux caveats distincts :
 *   - `weeks < expected` : l'historique n'a pas encore assez de semaines ;
 *   - `current.end < latestCompleteWeekEnd` : une semaine complète plus récente n'a
 *     pas encore été collectée (fenêtre en retard, pas tronquée).
 */
export function windowCompleteness(input: {
	current: ObservationWindow | null;
	expectedWeeks: number;
	/** `period_end` (dimanche) de la dernière semaine consolidée. */
	latestCompleteWeekEnd: string;
}): WindowCompleteness {
	const expectedWeeks = Math.max(1, Math.floor(input.expectedWeeks));
	const weeks = input.current?.weeks ?? 0;
	const coverage = Math.min(1, weeks / expectedWeeks);
	const fresh = input.current !== null && input.current.end >= input.latestCompleteWeekEnd;

	const caveats: string[] = [];
	if (weeks === 0) {
		caveats.push('aucune donnée sur la fenêtre');
	} else if (weeks < expectedWeeks) {
		caveats.push(`fenêtre incomplète (${weeks}/${expectedWeeks} semaines)`);
	}
	if (input.current !== null && !fresh) {
		caveats.push(
			`données pas à jour (dernière semaine collectée ${input.current.end} < ${input.latestCompleteWeekEnd})`
		);
	}

	return {
		complete: weeks >= expectedWeeks && fresh,
		coverage,
		weeks,
		expectedWeeks,
		fresh,
		caveats
	};
}

// ── Année N-1 (gate INERTE tant qu'il n'y a pas de donnée) ──────────

export type YoyComparison =
	| { available: false; reason: 'no_year_ago_data' | 'insufficient_current' }
	| {
			available: true;
			span: WindowSpan;
			weeks: number;
			current: ObservationWindow;
			yearAgo: ObservationWindow;
	  };

/**
 * Comparaison « fenêtre courante vs mêmes semaines calendaires il y a un an ».
 *
 * INERTE aujourd'hui : la donnée réelle commence ~2026, aucune semaine N-1 n'existe
 * avant 2027. Plutôt qu'un module que rien ne peut nourrir (piège AGT-000), la
 * fonction est câblée et rend proprement `{ available:false }` — elle se réveillera
 * seule le jour où les semaines N-1 seront en base. Le décalage est de 52 semaines
 * pile (364 jours) pour retomber sur des lundis, jamais 365.
 */
export function buildYoyComparison(availableWeeks: WeekBounds[], span: WindowSpan): YoyComparison {
	const weeks = spanToWeeks(span);
	const sorted = sortDesc(dedupeWeeks(availableWeeks));
	const currentSlice = sorted.slice(0, weeks);
	const current = buildWindow(currentSlice, weeks);
	if (!current || current.weeks < weeks) return { available: false, reason: 'insufficient_current' };

	// Les `period_start` visés un an plus tôt, cherchés parmi les paires RÉELLES.
	const wantedStarts = new Set(currentSlice.map((w) => addDaysIso(w.periodStart, -YEAR_IN_DAYS)));
	const yearAgoWeeks = dedupeWeeks(availableWeeks).filter((w) => wantedStarts.has(w.periodStart));
	const yearAgo = buildWindow(yearAgoWeeks, weeks);
	if (!yearAgo || !areWindowsComparable(current, yearAgo)) {
		return { available: false, reason: 'no_year_ago_data' };
	}
	return { available: true, span, weeks, current, yearAgo };
}
