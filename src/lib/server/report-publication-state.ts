/**
 * REP-003 — Publication du rapport du lundi : le MODÈLE (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), même paire que `weekly-report-state.ts` /
 * `weekly-report.ts` : `report-publication.ts` lit et écrit la base, ici on décide **si le
 * rapport a le droit de partir, et ce que son statut veut dire**.
 *
 * Les trois acceptations REP-003 se répartissent ainsi :
 *
 *   1. « un seul rapport logique existe par semaine » → le CRÉNEAU LOCAL
 *      (`currentPublicationSlot`) est la clé, et il porte l'unique en base. Ce module ne
 *      fabrique donc jamais deux identités pour un même lundi, quelle que soit l'heure à
 *      laquelle le tick l'appelle.
 *   2. « il reste accessible après restart » → tenu par la table (`weekly_reports`) ; ici,
 *      la seule contribution est que `decidePublication` reconnaît un créneau **déjà
 *      publié** et ne propose jamais de le réécrire.
 *   3. « le SLO avant 10:00 est mesuré » → **`deriveSlo`**, dérivée de deux faits écrits
 *      (`published_at`, `due_at`) et de rien d'autre.
 *
 * ⚠️ Ce module ne CONSTRUIT pas le rapport : c'est `buildWeeklyReport` (REP-001), et il n'y
 * a aucun chemin par lequel la décision de publier pourrait modifier le contenu publié. Un
 * rapport `partial` et un rapport `complete` portent le MÊME JSON, produit de la même façon
 * — le statut qualifie la semaine, pas le texte. Les fondre (« en partial, ne mets que les
 * projets prêts ») ferait disparaître du rapport précisément les projets dont il faut parler.
 */
import type { CadenceSpec, Occurrence } from './schedule-state.js';
import { BUSINESS_TIMEZONE, dueOccurrences } from './schedule-state.js';

/** Version du schéma de PUBLICATION (la table), distincte de `REPORT_SCHEMA_VERSION`. */
export const PUBLICATION_SCHEMA_VERSION = 1;

/**
 * Vocabulaire FERMÉ du statut. Deux valeurs, et pas trois : `failed` n'existe pas, parce
 * qu'un rapport qui ne pourrait rien dire n'aurait pas à être publié — alors qu'un rapport
 * amputé d'un projet reste exploitable (SPEC §17.3 : « rapport disponible même si un
 * provider optionnel est en panne, avec statut `partial` »).
 */
export const PUBLICATION_STATUSES = ['complete', 'partial'] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/**
 * Échéance par défaut : 60 minutes après le créneau, soit **lundi 10:00 Europe/Zurich**
 * (SLO §17.3). En minutes plutôt qu'en heure absolue : c'est ce qui la laisse suivre le
 * créneau si celui-ci bouge, au lieu de devenir un 10:00 orphelin d'un run de 11:00.
 */
export const DEFAULT_PUBLISH_DEADLINE_MINUTES = 60;

/** Borne dure : une échéance nulle publierait avant tout drain, une infinie n'en serait plus une. */
const MIN_DEADLINE_MINUTES = 1;
const MAX_DEADLINE_MINUTES = 24 * 60;

/**
 * Valide une échéance brute (texte de `system_settings`, ou JSON `{"minutes":N}`) → minutes.
 * Idiome tolérant de `resolveLatencyDays` (GSC-004) et `resolveLimits` (JOB-006) : une valeur
 * illisible, négative ou absurde retombe sur le défaut documenté. Une échéance qui ferait
 * LEVER empêcherait toute publication — c'est-à-dire exactement ce que ce lot livre.
 */
export function resolvePublishDeadlineMinutes(raw: string | null | undefined): number {
	if (raw === null || raw === undefined || raw === '') return DEFAULT_PUBLISH_DEADLINE_MINUTES;
	let value: unknown = raw;
	try {
		const parsed: unknown = JSON.parse(raw);
		value =
			parsed && typeof parsed === 'object' ? (parsed as { minutes?: unknown }).minutes : parsed;
	} catch {
		value = raw;
	}
	const minutes = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(minutes)) return DEFAULT_PUBLISH_DEADLINE_MINUTES;
	const floored = Math.floor(minutes);
	if (floored < MIN_DEADLINE_MINUTES || floored > MAX_DEADLINE_MINUTES) {
		return DEFAULT_PUBLISH_DEADLINE_MINUTES;
	}
	return floored;
}

// ── Le créneau du rapport ───────────────────────────────────────────

/**
 * Le créneau hebdomadaire COURANT : la dernière occurrence à `now` ou avant.
 *
 * Ne réimplémente aucune règle de calendrier — `dueOccurrences` (JOB-005) fait tout le
 * travail, y compris les deux bascules DST. Recopier « lundi 09:00 » ici créerait une
 * seconde autorité de calendrier, et le rapport se publierait à une heure que le scheduler
 * ne connaît pas.
 *
 * ⚠️ Le `spec` attendu est celui du PARC (`SCHEDULE_DEFAULTS.weekly`), **jamais** un
 * override de projet. Le rapport est cross-projet : si chaque projet pouvait déplacer son
 * hebdo, neuf projets définiraient neuf créneaux pour un seul rapport, et « un seul rapport
 * logique par semaine » n'aurait plus de sujet. Un projet qui décale sa cadence décale ses
 * runs — il ne décale pas le lundi de Jonathan.
 *
 * Rend `null` si la cadence est désactivée ou si aucune occurrence ne tombe dans la fenêtre
 * (`lookbackDays`, 8 jours par défaut : une semaine plus la marge d'un créneau glissé).
 */
export function currentPublicationSlot(input: {
	now: Date | number;
	spec: CadenceSpec;
	timeZone?: string;
	lookbackDays?: number;
}): Occurrence | null {
	const nowMs = typeof input.now === 'number' ? input.now : input.now.getTime();
	const lookbackMs = (input.lookbackDays ?? 8) * 24 * 60 * 60 * 1000;
	const occurrences = dueOccurrences({
		cadence: 'weekly',
		spec: input.spec,
		since: nowMs - lookbackMs,
		until: nowMs,
		timeZone: input.timeZone ?? BUSINESS_TIMEZONE
	});
	return occurrences.length === 0 ? null : occurrences[occurrences.length - 1];
}

// ── L'état d'un projet dans le créneau ──────────────────────────────

/**
 * Où en est un projet pour ce créneau.
 *
 *   - `ready`    — son run hebdo est terminal et intégralement réussi ;
 *   - `degraded` — terminal, mais `partial`/`failed`/`cancelled` : le rapport peut partir,
 *                  et il devra dire que ce projet repose sur une semaine trouée ;
 *   - `waiting`  — run ouvert, steps encore en vol : c'est ce qu'on ATTEND, jusqu'à
 *                  l'échéance ;
 *   - `missing`  — aucun run pour ce créneau, alors que le projet en attendait un. Distinct
 *                  de `waiting` : ici ce n'est pas lent, c'est absent (planification qui a
 *                  échoué, projet créé après le créneau) ;
 *   - `paused`   — aucun run, et une DÉCISION humaine couvre sa cadence hebdo. Écarté du
 *                  périmètre attendu, jamais compté comme incident.
 */
export const READINESS_STATES = ['ready', 'degraded', 'waiting', 'missing', 'paused'] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

/** Statuts de run TERMINAUX : plus rien ne les fera bouger, donc plus rien à attendre. */
const TERMINAL_RUN_STATUSES = new Set(['success', 'partial', 'failed', 'cancelled']);

export interface ProjectRunInput {
	projectSlug: string;
	/** Statut du run hebdo de CE créneau, ou `null` si aucun run n'existe. */
	runStatus: string | null;
	runId: string | null;
	/** La cadence hebdo de ce projet est-elle suspendue (DASH-006 lot 2) ? */
	paused: boolean;
	/** La raison de la pause, telle qu'elle a été journalisée. */
	pauseReason?: string | null;
}

/**
 * L'état d'un projet, dérivé de son run et de sa pause.
 *
 * ⚠️ **Un run existant l'emporte sur la pause.** Une pause posée MERCREDI ne rétroactive pas
 * le lundi : le run a tourné, ses steps ont écrit, le rapport doit en parler. Ne consulter la
 * pause qu'en l'absence de run est ce qui empêche une décision d'aujourd'hui d'effacer le
 * travail d'avant-hier.
 *
 * ⚠️ `cancelled` est `degraded`, pas `paused` : l'annulation est une décision portée sur UN
 * run (JOB-007), pas une suspension déclarée de la cadence. Les confondre ferait disparaître
 * du périmètre attendu un projet dont on a juste interrompu la semaine.
 */
export function classifyProjectReadiness(input: ProjectRunInput): ReadinessState {
	if (input.runStatus === null) return input.paused ? 'paused' : 'missing';
	if (!TERMINAL_RUN_STATUSES.has(input.runStatus)) return 'waiting';
	return input.runStatus === 'success' ? 'ready' : 'degraded';
}

// ── La décision ─────────────────────────────────────────────────────

export interface ReadinessProject {
	projectSlug: string;
	state: ReadinessState;
	runStatus: string | null;
	runId: string | null;
	/** UNE phrase qui dit ce qui manque — jamais un état muet (doctrine `BlindSpot`). */
	note: string | null;
}

/**
 * Ce sur quoi la publication s'est appuyée, tel qu'il sera PERSISTÉ (`readiness_json`).
 *
 * C'est la matière de « notifier disponibilité et incidents » : TEL-002 n'aura rien à
 * recalculer, et surtout rien à deviner. Un statut `partial` sans cette structure serait un
 * verdict sans motif — inattaquable, donc incroyable.
 */
export interface PublicationReadiness {
	periodSlot: string;
	deadlineMinutes: number;
	/** Projets ATTENDUS = parc non archivé moins les cadences suspendues. */
	expected: number;
	ready: number;
	degraded: number;
	waiting: number;
	missing: number;
	/** Écartés par une pause : jamais tus (doctrine `pausedCadences` du scheduler). */
	paused: string[];
	byProject: ReadinessProject[];
	/** Slugs qui EMPÊCHENT de publier (`waiting` + `missing`), avant échéance. */
	blockers: string[];
	/** Ce que la publication devra annoncer : dégradations et attentes non résolues. */
	incidents: Array<{ projectSlug: string; kind: 'degraded' | 'waiting' | 'missing'; detail: string }>;
}

export type PublicationAction = 'publish' | 'wait' | 'already_published';

/**
 * Pourquoi la publication part, attend, ou n'a rien à faire. Vocabulaire fermé : c'est ce
 * qui remonte au tick, aux logs et aux preuves, donc il ne doit pas être une phrase libre.
 */
export type PublicationReason =
	| 'already_published'
	| 'slot_not_reached'
	| 'awaiting_steps'
	| 'all_steps_terminal'
	| 'deadline_reached';

export interface PublicationDecision {
	action: PublicationAction;
	/** Renseigné **ssi** `action === 'publish'`. Un statut sur une attente n'aurait pas de sens. */
	status: PublicationStatus | null;
	reason: PublicationReason;
	/** Instant de l'échéance (ms) — le `due_at` qui sera écrit, et la moitié du SLO. */
	dueAtMs: number;
	deadlineReached: boolean;
	readiness: PublicationReadiness;
}

export interface PublicationDecisionInput {
	periodSlot: string;
	/** Instant du créneau (09:00 local converti par `schedule-state`). */
	slotAtMs: number;
	now: Date | number;
	deadlineMinutes: number;
	projects: ProjectRunInput[];
	/** Un rapport existe-t-il DÉJÀ pour ce créneau ? Un fait lu en base, jamais supposé. */
	alreadyPublished: boolean;
}

/**
 * Publier, ou attendre.
 *
 * L'ordre des trois gardes est load-bearing :
 *
 *   1. **déjà publié** — avant tout le reste, et surtout avant de lire l'état des runs : un
 *      créneau publié est clos, et recalculer sa préparation ne pourrait que donner envie de
 *      le réécrire. C'est ce qui rend le tick horaire gratuit 167 heures sur 168.
 *   2. **créneau non atteint** — on ne publie pas un lundi qui n'a pas eu lieu. Sans cette
 *      garde, un `now` du dimanche publierait le rapport du lendemain avec un parc où rien
 *      n'a encore tourné : `complete` serait alors impossible, et `partial` mensonger.
 *   3. **attente bornée** — tant qu'un projet attendu a des steps en vol, on attend ; passée
 *      l'échéance, on publie quand même. C'est littéralement « attendre les steps
 *      obligatoires avec deadline » : sans borne le rapport pourrait ne jamais sortir (un
 *      run bloqué suffirait), et sans attente il sortirait toujours vide.
 *
 * ⭐ **`complete` exige un périmètre attendu NON VIDE.** Un parc entièrement suspendu (ou
 * vide) rend `blockers = []` et `degraded = 0` : le calcul naïf annoncerait un rapport
 * complet sur zéro projet examiné. C'est la règle DASH-002 (« jamais regardé ≠ rien à
 * signaler ») portée au statut de publication — la même faute que REP-001 ferme dans ses
 * sections.
 */
export function decidePublication(input: PublicationDecisionInput): PublicationDecision {
	const nowMs = typeof input.now === 'number' ? input.now : input.now.getTime();
	const dueAtMs = input.slotAtMs + input.deadlineMinutes * 60 * 1000;
	const deadlineReached = nowMs >= dueAtMs;
	const readiness = summarizeReadiness({
		periodSlot: input.periodSlot,
		deadlineMinutes: input.deadlineMinutes,
		projects: input.projects
	});

	if (input.alreadyPublished) {
		return {
			action: 'already_published',
			status: null,
			reason: 'already_published',
			dueAtMs,
			deadlineReached,
			readiness
		};
	}

	if (nowMs < input.slotAtMs) {
		return {
			action: 'wait',
			status: null,
			reason: 'slot_not_reached',
			dueAtMs,
			deadlineReached,
			readiness
		};
	}

	if (readiness.blockers.length > 0 && !deadlineReached) {
		return {
			action: 'wait',
			status: null,
			reason: 'awaiting_steps',
			dueAtMs,
			deadlineReached,
			readiness
		};
	}

	const complete =
		readiness.expected > 0 && readiness.blockers.length === 0 && readiness.degraded === 0;

	return {
		action: 'publish',
		status: complete ? 'complete' : 'partial',
		reason: readiness.blockers.length > 0 ? 'deadline_reached' : 'all_steps_terminal',
		dueAtMs,
		deadlineReached,
		readiness
	};
}

/**
 * Réduit les runs du créneau à la structure persistée.
 *
 * Les projets suspendus sortent du DÉNOMINATEUR (`expected`) au lieu de compter comme un
 * manque : le scheduler ne leur a planifié aucun run, donc attendre le leur serait attendre
 * ce que personne n'a demandé — et un projet gelé trois mois ferait `partial` chaque semaine
 * jusqu'à vider le statut de sa valeur discriminante. Ils restent NOMMÉS (`paused`), et le
 * rapport lui-même porte déjà leur angle mort (`BlindSpot` de REP-001).
 */
export function summarizeReadiness(input: {
	periodSlot: string;
	deadlineMinutes: number;
	projects: ProjectRunInput[];
}): PublicationReadiness {
	const byProject: ReadinessProject[] = [];
	const paused: string[] = [];
	const blockers: string[] = [];
	const incidents: PublicationReadiness['incidents'] = [];
	let ready = 0;
	let degraded = 0;
	let waiting = 0;
	let missing = 0;

	for (const project of [...input.projects].sort((a, b) =>
		a.projectSlug.localeCompare(b.projectSlug)
	)) {
		const state = classifyProjectReadiness(project);
		let note: string | null = null;

		switch (state) {
			case 'ready':
				ready += 1;
				break;
			case 'degraded':
				degraded += 1;
				note = `run hebdo ${project.runStatus} : la semaine de ce projet est trouée`;
				incidents.push({ projectSlug: project.projectSlug, kind: 'degraded', detail: note });
				break;
			case 'waiting':
				waiting += 1;
				note = `run hebdo ${project.runStatus} : des steps sont encore en vol`;
				blockers.push(project.projectSlug);
				incidents.push({ projectSlug: project.projectSlug, kind: 'waiting', detail: note });
				break;
			case 'missing':
				missing += 1;
				note = 'aucun run hebdo pour ce créneau — la planification ne l’a pas produit';
				blockers.push(project.projectSlug);
				incidents.push({ projectSlug: project.projectSlug, kind: 'missing', detail: note });
				break;
			case 'paused':
				paused.push(project.projectSlug);
				note = `cadence hebdo suspendue : ${project.pauseReason ?? 'sans raison journalisée'}`;
				break;
		}

		byProject.push({
			projectSlug: project.projectSlug,
			state,
			runStatus: project.runStatus,
			runId: project.runId,
			note
		});
	}

	return {
		periodSlot: input.periodSlot,
		deadlineMinutes: input.deadlineMinutes,
		expected: ready + degraded + waiting + missing,
		ready,
		degraded,
		waiting,
		missing,
		paused,
		byProject,
		blockers,
		incidents
	};
}

// ── Le SLO, dérivé de deux faits ────────────────────────────────────

export interface SloVerdict {
	/** `published_at <= due_at`. Comparaison LEXICALE : deux chaînes canoniques UTC. */
	met: boolean;
	/** Retard sur l'échéance (ms), 0 si tenue. */
	lateMs: number;
	/** Délai entre le créneau et la publication (ms) — la mesure, indépendamment du verdict. */
	latencyMs: number;
}

/**
 * « Le SLO avant 10:00 est mesuré », en une fonction et sans colonne dédiée.
 *
 * Les deux entrées sont des FAITS écrits une fois pour toutes ; le verdict, lui, se recalcule
 * à chaque lecture. Un `slo_met` persisté serait faux le jour où l'échéance change de valeur
 * — même piège que le `status` que JOB-006 a refusé d'ajouter à un job, et que le résultat
 * d'inspection qu'IDX-004 dérive au lieu de le stocker.
 *
 * ⚠️ `parseMs` est fourni par l'appelant (`dbTimestampToMs`) : ce module reste pur, et la
 * conversion « format DB → instant » n'a qu'une seule implémentation, celle de
 * `timestamps.ts` qui documente le piège du `Z` manquant.
 */
export function deriveSlo(input: {
	slotAt: string;
	dueAt: string;
	publishedAt: string;
	parseMs: (value: string) => number;
}): SloVerdict {
	const met = input.publishedAt <= input.dueAt;
	const due = input.parseMs(input.dueAt);
	const slot = input.parseMs(input.slotAt);
	const published = input.parseMs(input.publishedAt);
	const lateMs = Number.isFinite(due) && Number.isFinite(published) ? Math.max(0, published - due) : 0;
	const latencyMs =
		Number.isFinite(slot) && Number.isFinite(published) ? Math.max(0, published - slot) : 0;
	return { met, lateMs, latencyMs };
}

// ── L'annonce (disponibilité et incidents) ──────────────────────────

export interface PublicationAnnouncement {
	/** UNE ligne : ce qu'un canal de notification affichera en titre. */
	headline: string;
	/** Le détail, déjà rendu — jamais un objet à re-formater côté canal. */
	lines: string[];
	/** Y a-t-il quelque chose qui demande un geste ? Décide de l'urgence côté canal. */
	hasIncidents: boolean;
}

/**
 * L'annonce de disponibilité et d'incidents, comme PROJECTION du rapport publié.
 *
 * ⚠️ **Aucun envoi ici, et c'est la limite exacte du lot.** Le canal (Telegram) est TEL-001,
 * BLOCKED : écrire un envoi maintenant obligerait à choisir un transport (email de secours)
 * que TEL-002 devrait ensuite dédupliquer avec le vrai. Ce lot rend donc l'annonce
 * *disponible* — dérivable de la ligne publiée, à tout moment, par quiconque — et le tick la
 * journalise. Ce qui manque est le tuyau, pas le message.
 *
 * Même discipline que `renderWeeklyReportText` : le seul paramètre est ce qui est persisté,
 * donc l'annonce ne peut rien affirmer que la base ne porte pas.
 */
export function renderPublicationAnnouncement(input: {
	periodSlot: string;
	status: PublicationStatus;
	slo: SloVerdict;
	readiness: PublicationReadiness;
	/** La phrase d'en-tête du rapport (REP-001) — reprise, jamais réécrite. */
	headline: string;
}): PublicationAnnouncement {
	const { readiness } = input;
	const sloLabel = input.slo.met
		? `SLO tenu (échéance +${readiness.deadlineMinutes} min)`
		: `SLO manqué de ${Math.round(input.slo.lateMs / 60000)} min`;

	const lines: string[] = [
		`Rapport hebdomadaire ${input.periodSlot} — ${input.status.toUpperCase()} · ${sloLabel}`,
		input.headline,
		`Projets attendus : ${readiness.expected} · prêts ${readiness.ready} · dégradés ${readiness.degraded} · en attente ${readiness.waiting} · absents ${readiness.missing}`
	];

	// Les projets écartés par une pause sont annoncés AVANT les incidents, et distinctement :
	// une décision assumée n'a rien à faire dans la même liste que ce qui a cassé.
	if (readiness.paused.length > 0) {
		lines.push(
			`Écartés par une pause (décision, pas incident) : ${readiness.paused.join(', ')}`
		);
	}

	if (readiness.incidents.length === 0) {
		lines.push('Aucun incident sur le périmètre attendu.');
	} else {
		lines.push(`Incidents (${readiness.incidents.length}) :`);
		for (const incident of readiness.incidents) {
			lines.push(`  · ${incident.projectSlug} — ${incident.detail}`);
		}
	}

	return {
		headline: lines[0],
		lines,
		hasIncidents: readiness.incidents.length > 0
	};
}
