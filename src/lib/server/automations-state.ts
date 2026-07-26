/**
 * DASH-006 — Vue automatisations : le JUGEMENT, sans base ni horloge implicite.
 *
 * Ce que cet écran existe pour montrer, et qu'aucun autre ne peut montrer :
 * **le créneau qui n'a pas eu lieu**.
 *
 * Un job raté laisse une ligne (`jobs.status='dead'`), donc `/jobs` le voit. Un
 * TICK qui ne tourne pas ne laisse RIEN : ni run, ni job, ni erreur. L'absence
 * n'a pas de ligne. Elle ne se révèle que par une comparaison entre deux choses
 * qui ne vivent pas au même endroit — le dernier créneau **attendu** (calculé par
 * `schedule-state.ts`) et le dernier run **observé** (`monitoring_runs`). C'est
 * exactement l'acceptation BACKLOG « une panne est diagnosticable sans accès
 * serveur » : sans cette page, la seule façon de savoir que le cron s'est arrêté
 * était de remarquer que plus rien ne bougeait.
 *
 * **Deux axes qui ne fusionnent jamais** (même règle qu'à l'accueil, DASH-002) :
 *
 *   - `health` répond à « le créneau a-t-il été TIRÉ ? » — c'est la planification ;
 *   - le statut du run répond à « ce qui a été tiré a-t-il RÉUSSI ? » — c'est
 *     l'exécution, et elle a déjà ses écrans (`/jobs`, `/jobs/[id]`).
 *
 * Les fusionner peindrait en rouge un projet dont le run hebdo est parti à
 * l'heure et a échoué faute de quota — alors que l'automatisation, elle, marche
 * parfaitement. Et inversement : un projet dont le dernier run est `success`
 * mais qui n'a plus rien tiré depuis trois semaines se lirait « au vert », ce qui
 * est précisément la panne qu'on cherche.
 *
 * Aucun import de runtime (le seul est `schedule-state.ts`, pur lui aussi) :
 * testable en isolation, comme `home-state.ts` et `finding-state.ts`.
 */

import {
	BUSINESS_TIMEZONE,
	DEFAULT_LOOKBACK_MS,
	SCHEDULE_CADENCES,
	dueOccurrences,
	type CadenceSpec,
	type Occurrence,
	type ScheduleCadence
} from './schedule-state.js';
import { RUN_STATUSES } from './monitoring-state.js';
import type { CadencePauseVerdict } from './pause-state.js';

// ── Le dernier créneau attendu ──────────────────────────────────────

/**
 * Durée d'une période, par cadence. Sert UNIQUEMENT à borner la recherche en
 * arrière : `dueOccurrences` veut une fenêtre, et remonter à l'infini pour
 * trouver un créneau sur une cadence désactivée depuis six mois ne servirait
 * personne. `monthly` est majoré (31 j) — un balayage trop court manquerait un
 * créneau, un balayage trop long n'en invente aucun.
 */
export const CADENCE_PERIOD_MS: Record<ScheduleCadence, number> = {
	hourly: 60 * 60 * 1000,
	daily: 24 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000,
	monthly: 31 * 24 * 60 * 60 * 1000
};

/**
 * Dernier créneau dû à `now` (inclus), ou `null`.
 *
 * Calculé par la MÊME fonction que le scheduler (`dueOccurrences`) plutôt que
 * réimplémenté : deux énumérations de créneaux divergeraient au premier
 * changement d'heure, et l'écran accuserait alors le cron d'un créneau qu'il
 * n'a jamais eu à tirer. On regarde deux périodes en arrière, assez pour que le
 * dernier créneau soit toujours dans la fenêtre.
 */
export function lastDueOccurrence(input: {
	cadence: ScheduleCadence;
	spec: CadenceSpec;
	now: Date | number;
	timeZone?: string;
	/** Profondeur de recherche (défaut : deux périodes de la cadence). */
	horizonMs?: number;
}): Occurrence | null {
	const nowMs = typeof input.now === 'number' ? input.now : input.now.getTime();
	const horizon = input.horizonMs ?? 2 * CADENCE_PERIOD_MS[input.cadence];
	const due = dueOccurrences({
		cadence: input.cadence,
		spec: input.spec,
		since: nowMs - horizon,
		until: nowMs,
		timeZone: input.timeZone ?? BUSINESS_TIMEZONE
	});
	return due.at(-1) ?? null;
}

// ── Verdict de planification ────────────────────────────────────────

/**
 * Ce que la PLANIFICATION d'une cadence vaut. Ne dit jamais rien de la réussite
 * de ce qui a été planifié (cf. l'en-tête : deux axes).
 *
 *   - `unwired`   : la cadence se calcule mais n'enfile aucun job — rien à attendre ;
 *   - `disabled`  : la cadence est éteinte pour ce projet — muet, pas cassé ;
 *   - `paused`    : une DÉCISION humaine la suspend — muet, pas cassé, et réversible ;
 *   - `never_due` : aucun créneau ne lui a encore été dû (projet trop jeune) ;
 *   - `ok`        : le dernier créneau dû a bien ouvert son run ;
 *   - `late`      : le créneau a été manqué mais reste DANS la fenêtre de
 *                   rattrapage — le prochain tick le tirera ;
 *   - `missed`    : le créneau est manqué HORS fenêtre. Il ne reviendra jamais.
 */
export type CadenceHealth =
	| 'ok'
	| 'late'
	| 'missed'
	| 'disabled'
	| 'paused'
	| 'unwired'
	| 'never_due';

export interface CadenceVerdict {
	health: CadenceHealth;
	/** Ce qu'on affirme, en une phrase — jamais un code d'état nu. */
	reason: string;
	/**
	 * DASH-006 lot 2 — la pause qui explique le silence, quand il y en a une. Porte le
	 * scope : c'est lui qui décide si un bouton « Reprendre » a un sens ICI, ou s'il
	 * faudrait lever une pause de portée supérieure.
	 */
	pause?: {
		scope: string;
		reason: string;
		actor: string;
		since: string;
		until: string | null;
	} | null;
	/**
	 * Le prochain tick rattrapera-t-il ce créneau ? Faux dès qu'il sort de la
	 * fenêtre : `dueOccurrences` ne regarde en arrière que de `lookbackMs`, donc
	 * au-delà le créneau est perdu POUR DE BON. Promettre un rattrapage que le
	 * tick ne fera pas serait pire que de ne rien dire.
	 */
	recoverable: boolean;
}

export interface ClassifyCadenceInput {
	spec: CadenceSpec;
	/** La cadence met-elle au moins un job en file ? (`catalogFor(cadence).length > 0`) */
	wired: boolean;
	/** Dernier créneau dû, ou `null` s'il n'y en a aucun dans l'horizon. */
	lastDue: Occurrence | null;
	/**
	 * Statut du run trouvé pour CE créneau exact — la jointure se fait sur
	 * `monitoring_runs.period_end === lastDue.localSlot`, qui est ce que `planOne`
	 * y écrit. `null` = aucun run pour ce créneau, donc il n'a pas été tiré.
	 */
	runStatus: string | null;
	nowMs: number;
	/**
	 * Création du projet (ms). Un créneau antérieur ne lui a jamais été dû :
	 * l'accuser d'un run manquant reprocherait au cron une absence qui est
	 * seulement celle du projet.
	 */
	projectCreatedAtMs: number | null;
	/** Fenêtre de rattrapage du tick (défaut : celle de `planDueJobs`). */
	lookbackMs?: number;
	/**
	 * DASH-006 lot 2 — verdict de pause pour ce couple projet×cadence, tel que
	 * `resolveCadencePause` le rend. `null` = aucune décision ne le couvre.
	 */
	pause?: CadencePauseVerdict | null;
}

export function classifyCadence(input: ClassifyCadenceInput): CadenceVerdict {
	// L'ORDRE des deux premières règles est celui de `planDueJobs`, qui écarte les
	// cadences sans handler AVANT de regarder `enabled`. Inversé, l'écran dirait
	// « désactivée » d'une cadence que le scheduler n'aurait de toute façon pas
	// planifiée — deux raisons pour un même silence, dont une fausse.
	if (!input.wired) {
		return {
			health: 'unwired',
			reason: 'Aucun job câblé sur cette cadence : le créneau se calcule, il ne met rien en file.',
			recoverable: false
		};
	}
	if (!input.spec.enabled) {
		return {
			health: 'disabled',
			reason: 'Cadence désactivée pour ce projet : aucun créneau n’est tiré. Muet, pas cassé.',
			recoverable: false
		};
	}
	// DASH-006 lot 2 — la pause vient APRÈS `disabled`, et l'ordre est le même que côté
	// scheduler (`applyPauseToSpec` ne s'applique qu'à un `enabled` déjà vrai). Inversé,
	// l'écran offrirait « Reprendre » sur une cadence que la configuration éteint de
	// toute façon : le bouton marcherait, et rien ne repartirait.
	if (input.pause?.paused && input.pause.by) {
		const by = input.pause.by;
		return {
			health: 'paused',
			reason:
				by.target.scope === 'project'
					? `Projet suspendu (${by.reason}) : aucune de ses cadences n’est tirée.`
					: `Cadence suspendue (${by.reason}) : aucun créneau n’est tiré.`,
			// Reprendre ne rattrape RIEN : les créneaux tombés pendant la pause sont
			// hors fenêtre. Le promettre ferait attendre des runs qui ne viendront pas.
			recoverable: false,
			pause: {
				scope: by.target.scope,
				reason: by.reason,
				actor: by.actor,
				since: by.since,
				until: by.until
			}
		};
	}
	if (!input.lastDue) {
		return {
			health: 'never_due',
			reason: 'Aucun créneau n’a encore été dû sur cette cadence.',
			recoverable: false
		};
	}
	if (
		input.projectCreatedAtMs !== null &&
		input.lastDue.instantMs < input.projectCreatedAtMs
	) {
		return {
			health: 'never_due',
			reason: 'Le dernier créneau est antérieur à la création du projet : il ne lui a jamais été dû.',
			recoverable: false
		};
	}

	if (input.runStatus !== null) {
		return {
			health: 'ok',
			reason: 'Le dernier créneau dû a bien ouvert son run.',
			recoverable: false
		};
	}

	const lookbackMs = input.lookbackMs ?? DEFAULT_LOOKBACK_MS;
	const ageMs = input.nowMs - input.lastDue.instantMs;

	// La borne est `<= lookbackMs` et pas `<` : `dueOccurrences` retient
	// `instantMs > since`, avec `since = now - lookback`. Un créneau pile sur la
	// borne est donc déjà HORS fenêtre pour le tick — le dire rattrapable ici
	// promettrait un run qui ne partirait pas.
	if (ageMs < lookbackMs) {
		return {
			health: 'late',
			reason: 'Créneau manqué, encore dans la fenêtre de rattrapage : le prochain tick le tirera.',
			recoverable: true
		};
	}

	return {
		health: 'missed',
		reason:
			'Créneau manqué hors fenêtre de rattrapage : il ne sera jamais tiré. ' +
			'Le tick horaire ne tourne plus, ou n’a pas tourné à ce moment-là.',
		recoverable: false
	};
}

/**
 * Les états qui appellent une intervention — les seuls.
 *
 * ⚠️ `paused` n'en fait PAS partie, et c'est le point du lot 2 : une pause est une
 * décision, pas une panne. L'y ajouter ferait compter un arrêt volontaire comme un
 * cockpit cassé — c'est-à-dire remettre exactement la confusion que ce lot supprime,
 * après l'avoir supprimée.
 */
export const FAILING_HEALTHS: readonly CadenceHealth[] = ['missed', 'late'];

export function isFailing(health: CadenceHealth): boolean {
	return (FAILING_HEALTHS as readonly string[]).includes(health);
}

// ── Lignes assemblées & résumé ──────────────────────────────────────

export interface CadenceRow {
	projectId: string;
	projectSlug: string;
	projectName: string;
	cadence: ScheduleCadence;
	spec: CadenceSpec;
	wired: boolean;
	/** Créneau local du dernier créneau dû (`2026-07-20T09:00`), ou null. */
	lastDueSlot: string | null;
	/** Même créneau, en instant DB (UTC) — comparable au reste de l'écran. */
	lastDueDb: string | null;
	/** Prochain créneau local, ou null si la cadence est éteinte. */
	nextSlot: string | null;
	nextDb: string | null;
	verdict: CadenceVerdict;
	/**
	 * Le run du dernier créneau dû : son ISSUE, sur l'axe exécution. `null` quand
	 * le créneau n'a pas été tiré — et c'est alors `verdict.health` qui parle.
	 */
	lastRun: { id: string; status: string; finishedAt: string | null } | null;
	/** Dernier run RÉUSSI de cette cadence, quel que soit son créneau (SPEC §13.4). */
	lastSuccess: { id: string; slot: string | null; finishedAt: string | null } | null;
	/**
	 * DASH-006 lot 2 — la pause s'applique-t-elle ICI, ou vient-elle d'une portée
	 * supérieure ? C'est ce qui décide si la ligne peut offrir « Reprendre » : une
	 * cadence couverte par un gel de PROJET ne le peut pas, le bouton lèverait une
	 * pause qui n'est pas celle qui la retient.
	 */
	pauseScope: string | null;
}

export interface AutomationsSummary {
	/**
	 * Cadences réellement attendues (câblées, activées ET non suspendues) — le
	 * dénominateur honnête. Une cadence en pause n'est pas « attendue » : la compter
	 * ferait afficher « 11 attendues, 8 ok » sur un parc dont 3 sont éteintes exprès,
	 * et le manque se lirait comme une panne.
	 */
	expected: number;
	ok: number;
	late: number;
	missed: number;
	disabled: number;
	/** Suspendues par décision. Compteur SÉPARÉ : ni un échec, ni une désactivation. */
	paused: number;
	unwired: number;
	neverDue: number;
	/** Projets ayant au moins une cadence `missed`. */
	projectsMissing: string[];
	/** Projets ayant au moins une cadence suspendue — pour l'en-tête de l'écran. */
	projectsPaused: string[];
}

export function summarizeAutomations(rows: CadenceRow[]): AutomationsSummary {
	const out: AutomationsSummary = {
		expected: 0,
		ok: 0,
		late: 0,
		missed: 0,
		disabled: 0,
		paused: 0,
		unwired: 0,
		neverDue: 0,
		projectsMissing: [],
		projectsPaused: []
	};
	const missing = new Set<string>();
	const paused = new Set<string>();

	for (const row of rows) {
		if (row.wired && row.spec.enabled && row.verdict.health !== 'paused') out.expected += 1;
		switch (row.verdict.health) {
			case 'ok':
				out.ok += 1;
				break;
			case 'late':
				out.late += 1;
				break;
			case 'missed':
				out.missed += 1;
				missing.add(row.projectSlug);
				break;
			case 'disabled':
				out.disabled += 1;
				break;
			case 'paused':
				out.paused += 1;
				paused.add(row.projectSlug);
				break;
			case 'unwired':
				out.unwired += 1;
				break;
			case 'never_due':
				out.neverDue += 1;
				break;
		}
	}

	out.projectsMissing = [...missing].sort();
	out.projectsPaused = [...paused].sort();
	return out;
}

// ── Filtres de la liste de runs ─────────────────────────────────────

/**
 * Ce que `/automations` sait lire dans l'URL. Même discipline que
 * `normalizeJobFilters` : ce qui n'appartient pas au vocabulaire est ÉCARTÉ
 * avant d'atteindre une requête, jamais transmis ni refusé — un lien périmé doit
 * afficher la page, pas une erreur.
 */
export interface RawAutomationFilters {
	project?: string | null;
	status?: string | null;
	since?: string | null;
	cadence?: string | null;
	limit?: string | null;
	offset?: string | null;
}

export interface AutomationFilters {
	projectSlug: string | null;
	statuses: string[];
	/** Borne basse `created_at` au format DB, ou null. */
	sinceDb: string | null;
	cadence: ScheduleCadence | null;
	limit: number;
	offset: number;
}

export const RUNS_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** `YYYY-MM-DD HH:MM:SS` — le seul format que `timestamps.ts` écrit en base. */
const DB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}$/;

export function normalizeAutomationFilters(raw: RawAutomationFilters): AutomationFilters {
	const statuses = (raw.status ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter((s): s is string => (RUN_STATUSES as readonly string[]).includes(s));

	const cadence = SCHEDULE_CADENCES.find((c) => c === raw.cadence?.trim()) ?? null;

	// Une date libre n'est pas acceptée telle quelle : elle irait dans un `>=` sur
	// une colonne `text`, où une chaîne mal formée ne compare pas comme une date et
	// ferait silencieusement disparaître des lignes. Hors format → pas de borne.
	const rawSince = raw.since?.trim() ?? '';
	const sinceDb = DB_TIMESTAMP.test(rawSince) ? rawSince.replace('T', ' ') : null;

	const parsedLimit = Number(raw.limit);
	const limit =
		Number.isFinite(parsedLimit) && parsedLimit > 0
			? Math.min(Math.floor(parsedLimit), MAX_PAGE_SIZE)
			: RUNS_PAGE_SIZE;

	const parsedOffset = Number(raw.offset);
	const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? Math.floor(parsedOffset) : 0;

	return {
		statuses: [...new Set(statuses)],
		projectSlug: raw.project?.trim() || null,
		sinceDb,
		cadence,
		limit,
		offset
	};
}

/**
 * Le lien qui reproduit un filtre de runs.
 *
 * Existe pour la même raison que `counterHref` (home-state) : le compteur « runs
 * de la période » de l'accueil et cette liste doivent naître du MÊME descripteur,
 * sinon le nombre et la liste qu'il ouvre finissent par compter deux ensembles
 * différents. C'est ce qui rend `runs_period` cliquable — il était muet faute de
 * liste capable de le reproduire.
 */
export function runsHref(filter: {
	status?: string | null;
	sinceDb?: string | null;
	projectSlug?: string | null;
	cadence?: string | null;
}): string {
	const p = new URLSearchParams();
	if (filter.projectSlug) p.set('project', filter.projectSlug);
	if (filter.status) p.set('status', filter.status);
	if (filter.sinceDb) p.set('since', filter.sinceDb);
	if (filter.cadence) p.set('cadence', filter.cadence);
	const qs = p.toString();
	return qs ? `/automations?${qs}` : '/automations';
}
