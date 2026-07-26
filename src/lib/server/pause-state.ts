/**
 * DASH-006 lot 2 — Pauses d'automatisation : le JUGEMENT, sans base ni horloge implicite.
 *
 * Ce que ce module existe pour tenir, et que le lot 1 ne pouvait pas :
 * **arrêter volontairement une automatisation sans que ça ressemble à une panne.**
 *
 * `/automations` sait dire qu'un créneau n'a pas été tiré. Il ne savait pas dire
 * *pourquoi* — et les deux causes n'ont rien à voir : un cron mort est un incident,
 * un projet suspendu est une décision. Les confondre, c'est soit s'alarmer pour rien,
 * soit ranger un vrai incident sous « c'est normal ».
 *
 * Trois idées portent tout le reste :
 *
 *  1. **Une pause est une DÉCISION, jamais une configuration.** Elle a un auteur, une
 *     cause, une date. C'est pourquoi elle vit dans un journal APPEND-ONLY et que
 *     l'état effectif se DÉRIVE de son dernier événement — au lieu d'un booléen qu'un
 *     recalcul (`project_projections`) effacerait sans bruit.
 *
 *  2. **L'expiration se dérive, elle ne s'écrit pas.** Une pause `until` échue n'est
 *     plus active à la lecture, sans qu'aucune ligne ne bouge. Aucun job de réveil,
 *     donc aucun moyen qu'une pause « expirée en base » et une pause « expirée à
 *     l'écran » se contredisent — c'est la discipline de `isSnoozeExpired` (FIND-003).
 *
 *  3. **Une pause provider ne suspend AUCUNE cadence.** Le run s'ouvre, et seuls les
 *     jobs de ce provider sont sautés. C'est l'acceptation BACKLOG « la désactivation
 *     d'un provider n'annule pas les autres steps », littéralement : couper GSC ne doit
 *     pas priver le projet de `findings:lifecycle`, qui ne sort pas de Postgres.
 *
 * Aucun import de runtime (ni db, ni `$env`) : les trois imports sont des modules purs
 * eux aussi (`schedule-state`, `job-limits`, `timestamps`). Même discipline que
 * `automations-state.ts`, `finding-state.ts` et `job-limits.ts` — et `now` est toujours
 * INJECTÉ, jamais lu.
 */

import { normalizeDbTimestamp } from './timestamps.js';
import { SCHEDULE_CADENCES, type ScheduleCadence, type CadenceSpec } from './schedule-state.js';
import { JOB_PROVIDERS, providerForJobType, type JobProvider } from './job-limits.js';

// ── Vocabulaire ─────────────────────────────────────────────────────

/**
 * Les trois portées d'une pause. Ce ne sont pas trois dispositifs : c'est une seule
 * mécanique (un journal, un dérivateur) déclinée sur trois cibles.
 *
 *  - `project_cadence` — « suspendre le hebdo de barberconcept » ;
 *  - `project`         — « geler ce client » (toutes ses cadences d'un geste) ;
 *  - `provider`        — « couper GSC », transverse à TOUS les projets.
 */
export const PAUSE_SCOPES = ['project_cadence', 'project', 'provider'] as const;
export type PauseScope = (typeof PAUSE_SCOPES)[number];

/** Le journal ne connaît que deux verbes. Tout le reste est de la dérivation. */
export const PAUSE_EVENT_TYPES = ['paused', 'resumed'] as const;
export type PauseEventType = (typeof PAUSE_EVENT_TYPES)[number];

/** Auteurs légitimes (miroir de `FINDING_ACTORS`). Un `user:` porte l'email en suffixe. */
export const PAUSE_ACTORS = ['user', 'system', 'schedule', 'agent'] as const;

/** Longueur maximale d'une raison — alignée sur l'endpoint des findings. */
export const PAUSE_REASON_MAX = 500;

// ── Cible d'une pause ───────────────────────────────────────────────

/**
 * La cible, sous forme normalisée. Les champs non pertinents pour le `scope` sont
 * `null` — et `normalizePauseTarget` les FORCE à null plutôt que de les tolérer :
 * une ligne `scope='project'` qui traînerait une `cadence` produirait deux clés pour
 * une seule décision, donc une pause qu'on croit levée et qui ne l'est pas.
 */
export interface PauseTarget {
	scope: PauseScope;
	projectId: string | null;
	cadence: ScheduleCadence | null;
	provider: JobProvider | null;
}

export interface RawPauseTarget {
	scope: string;
	projectId?: string | null;
	cadence?: string | null;
	provider?: string | null;
}

export function isPauseScope(value: unknown): value is PauseScope {
	return typeof value === 'string' && (PAUSE_SCOPES as readonly string[]).includes(value);
}

export function isPauseEventType(value: unknown): value is PauseEventType {
	return typeof value === 'string' && (PAUSE_EVENT_TYPES as readonly string[]).includes(value);
}

export function isScheduleCadence(value: unknown): value is ScheduleCadence {
	return typeof value === 'string' && (SCHEDULE_CADENCES as readonly string[]).includes(value);
}

export function isJobProvider(value: unknown): value is JobProvider {
	return typeof value === 'string' && (JOB_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Valide et normalise une cible. STRICTE, à l'inverse de `resolveScheduleConfig` :
 * là-bas, tolérer une valeur douteuse évitait d'éteindre une planification par
 * accident ; ici, tolérer une cible incomplète écrirait une décision qui ne
 * s'appliquerait à rien — une pause qui ne met rien en pause est pire qu'un refus,
 * parce qu'elle a l'air d'avoir marché.
 *
 * @throws si le scope est inconnu ou si la cible ne porte pas ce que son scope exige.
 */
export function normalizePauseTarget(raw: RawPauseTarget): PauseTarget {
	if (!isPauseScope(raw.scope)) {
		throw new Error(
			`Pause : scope inconnu « ${String(raw.scope)} » (attendu ${PAUSE_SCOPES.join(' | ')}).`
		);
	}

	if (raw.scope === 'provider') {
		if (!isJobProvider(raw.provider)) {
			throw new Error(
				`Pause provider : provider inconnu « ${String(raw.provider)} » (attendu ${JOB_PROVIDERS.join(' | ')}).`
			);
		}
		// `none` n'est pas un provider : c'est l'absence de provider. Le mettre en pause
		// suspendrait tout ce qui ne sort pas du réseau (détecteurs, veilles, producteur)
		// sous un libellé qui promet le contraire.
		if (raw.provider === 'none') {
			throw new Error('Pause provider : « none » n’est pas un provider, c’est son absence.');
		}
		return { scope: 'provider', projectId: null, cadence: null, provider: raw.provider };
	}

	const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
	if (!projectId) throw new Error(`Pause ${raw.scope} : projectId manquant.`);

	if (raw.scope === 'project') {
		return { scope: 'project', projectId, cadence: null, provider: null };
	}

	if (!isScheduleCadence(raw.cadence)) {
		throw new Error(
			`Pause project_cadence : cadence inconnue « ${String(raw.cadence)} » (attendu ${SCHEDULE_CADENCES.join(' | ')}).`
		);
	}
	return { scope: 'project_cadence', projectId, cadence: raw.cadence, provider: null };
}

/**
 * Séparateur de clé : ASCII Unit Separator (0x1F), comme `FINDING_FINGERPRINT_SEP`.
 * Non imprimable, donc absent d'un id de projet, d'une cadence ou d'un provider légitimes.
 */
export const PAUSE_KEY_SEP = '\x1f';


/**
 * Clé canonique d'une cible : c'est elle qui décide quels événements se répondent.
 * Deux gestes sur la même clé forment une histoire (pause → reprise → pause) ; deux
 * clés différentes ne se lèvent jamais l'une l'autre.
 *
 * @throws si une partie contient le séparateur réservé — sans quoi la collision serait
 *         SILENCIEUSE, et une reprise lèverait une pause qui n'est pas la sienne.
 */
export function pauseKey(target: PauseTarget): string {
	const parts = [target.scope, target.projectId ?? '', target.cadence ?? '', target.provider ?? ''];
	parts.forEach((p, i) => {
		if (p.includes(PAUSE_KEY_SEP)) {
			throw new Error(`Clé de pause : partie #${i} contient le séparateur réservé.`);
		}
	});
	return parts.join(PAUSE_KEY_SEP);
}

// ── Dérivation de l'état effectif ───────────────────────────────────

/** Un événement du journal, réduit à ce dont la dérivation a besoin. */
export interface PauseEventRow {
	id: string;
	scope: string;
	projectId: string | null;
	cadence: string | null;
	provider: string | null;
	eventType: string;
	reason: string;
	/** Échéance au format DB, ou null (pause sans terme). */
	until: string | null;
	actor: string;
	createdAt: string;
}

/** Une pause ACTIVE à l'instant considéré. */
export interface ActivePause {
	key: string;
	target: PauseTarget;
	reason: string;
	actor: string;
	/** Quand la décision a été prise (format DB). */
	since: string;
	/** Échéance, ou null si la pause court jusqu'à reprise explicite. */
	until: string | null;
	/** L'événement qui porte la décision — pour pointer le journal depuis l'écran. */
	eventId: string;
}

/** Map clé canonique → pause active. Une clé absente = pas en pause. */
export type PauseStates = Map<string, ActivePause>;

/**
 * État effectif, dérivé du DERNIER événement de chaque cible.
 *
 * `rows` doit contenir au plus une ligne par clé (c'est ce que rend le `DISTINCT ON`
 * de `loadPauseStates`) ; si plusieurs arrivent, la plus récente gagne — comparaison
 * lexicale sur `created_at`, sûre parce que la colonne est homogène (`toDbTimestamp`).
 *
 * Trois façons de N'ÊTRE PAS en pause, et une seule d'y être :
 *   - dernier événement `resumed` → levée ;
 *   - dernier événement `paused` avec `until` échu → **expirée, sans écriture** ;
 *   - aucune ligne → jamais suspendue.
 *
 * Une ligne illisible (scope inconnu, cible incomplète) est ÉCARTÉE, jamais levée en
 * exception : un enregistrement corrompu ne doit pas empêcher de lire l'état des cinq
 * autres projets. Elle se lit alors « pas en pause » — le défaut sûr, puisqu'une pause
 * fantôme éteindrait un monitoring que personne n'a demandé d'éteindre.
 */
export function derivePauseStates(rows: PauseEventRow[], now: Date | string): PauseStates {
	// ⚠️ `normalizeDbTimestamp`, pas `toDbTimestamp` : une chaîne déjà au format DB ne
	// doit pas être re-parsée en heure locale (cf. timestamps.ts). Sinon une pause
	// échéant à 12:00 se lirait active jusqu'à 14:00 à Zurich.
	const nowDb = normalizeDbTimestamp(now);
	const latest = new Map<string, { row: PauseEventRow; target: PauseTarget }>();

	for (const row of rows) {
		let target: PauseTarget;
		let key: string;
		try {
			target = normalizePauseTarget(row);
			key = pauseKey(target);
		} catch {
			continue; // ligne illisible : écartée, jamais fatale.
		}
		if (!isPauseEventType(row.eventType)) continue;

		const previous = latest.get(key);
		if (!previous || row.createdAt > previous.row.createdAt) {
			latest.set(key, { row, target });
		}
	}

	const states: PauseStates = new Map();
	for (const [key, { row, target }] of latest) {
		if (row.eventType !== 'paused') continue;
		// L'expiration est DÉRIVÉE : `until <= now` ⇒ la pause n'est plus active, et
		// aucune ligne n'a bougé. Borne `<=` comme `isSnoozeExpired` : une échéance
		// atteinte est atteinte.
		if (row.until && row.until <= nowDb) continue;

		states.set(key, {
			key,
			target,
			reason: row.reason,
			actor: row.actor,
			since: row.createdAt,
			until: row.until,
			eventId: row.id
		});
	}
	return states;
}

// ── Résolution : qu'est-ce qui est effectivement suspendu ───────────

export interface CadencePauseVerdict {
	paused: boolean;
	/**
	 * La pause qui l'emporte. `scope` dit à l'écran s'il faut proposer « Reprendre »
	 * ici ou renvoyer vers la pause de portée supérieure.
	 */
	by: ActivePause | null;
}

/**
 * Une cadence est en pause si `project_cadence` OU `project` la couvre.
 *
 * **Union, pas préséance** : il n'y a rien à arbitrer, donc rien qui puisse diverger
 * entre l'écran et le scheduler. Quand les deux existent, on rend la plus LARGE
 * (`project`) — c'est celle qu'il faudra lever pour que la cadence reparte, donc la
 * seule dont le libellé ne mente pas. Proposer « Reprendre » sur la cadence alors
 * qu'un gel projet subsiste ferait cliquer dans le vide.
 *
 * Une pause `provider` n'apparaît JAMAIS ici : elle ne suspend pas le cadran, elle
 * saute des jobs (cf. `resolveJobPause`).
 */
export function resolveCadencePause(input: {
	states: PauseStates;
	projectId: string;
	cadence: ScheduleCadence;
}): CadencePauseVerdict {
	const { states, projectId, cadence } = input;

	const projectWide = states.get(
		pauseKey({ scope: 'project', projectId, cadence: null, provider: null })
	);
	if (projectWide) return { paused: true, by: projectWide };

	const perCadence = states.get(
		pauseKey({ scope: 'project_cadence', projectId, cadence, provider: null })
	);
	if (perCadence) return { paused: true, by: perCadence };

	return { paused: false, by: null };
}

/** Pause active d'un provider, ou null. */
export function resolveProviderPause(input: {
	states: PauseStates;
	provider: JobProvider;
}): ActivePause | null {
	if (input.provider === 'none') return null; // l'absence de provider ne se suspend pas.
	return (
		input.states.get(
			pauseKey({ scope: 'provider', projectId: null, cadence: null, provider: input.provider })
		) ?? null
	);
}

export interface JobPauseVerdict {
	paused: boolean;
	by: ActivePause | null;
	/** Motif lisible, écrit tel quel dans `jobs.last_error_message` et `job_attempts`. */
	reason: string | null;
}

/**
 * Un job DÉJÀ EN FILE doit-il être sauté ?
 *
 * Trois causes, dans l'ordre où elles se constatent :
 *   1. son provider est suspendu (`providerForJobType` — jamais une table de types
 *      recopiée ici : deux listes divergeraient au premier handler ajouté) ;
 *   2. son projet est gelé ;
 *   3. la cadence QUI L'A PRODUIT est suspendue.
 *
 * ⚠️ `runType` vient de `monitoring_runs.run_type`, pas du job : un job sans run
 * (`post_publish`, relance manuelle) n'appartient à aucun cadran et **échappe** donc
 * à une pause de cadence. C'est voulu — suspendre le hebdo ne doit pas annuler une
 * vérification J+3 posée à la publication, qui n'a rien à voir avec le cadran.
 */
export function resolveJobPause(input: {
	states: PauseStates;
	projectId: string;
	jobType: string;
	/** `run_type` du run porteur, ou null si le job n'est rattaché à aucun run. */
	runType?: string | null;
}): JobPauseVerdict {
	const { states, projectId, jobType } = input;

	const provider = providerForJobType(jobType);
	const providerPause = resolveProviderPause({ states, provider });
	if (providerPause) {
		return {
			paused: true,
			by: providerPause,
			reason: `Provider ${provider} en pause : ${providerPause.reason}`
		};
	}

	const projectWide = states.get(
		pauseKey({ scope: 'project', projectId, cadence: null, provider: null })
	);
	if (projectWide) {
		return { paused: true, by: projectWide, reason: `Projet en pause : ${projectWide.reason}` };
	}

	if (isScheduleCadence(input.runType)) {
		const perCadence = states.get(
			pauseKey({ scope: 'project_cadence', projectId, cadence: input.runType, provider: null })
		);
		if (perCadence) {
			return {
				paused: true,
				by: perCadence,
				reason: `Cadence ${input.runType} en pause : ${perCadence.reason}`
			};
		}
	}

	return { paused: false, by: null, reason: null };
}

/** Providers effectivement suspendus à cet instant (cohorte exclue de la réclamation). */
export function pausedProviders(states: PauseStates): JobProvider[] {
	return JOB_PROVIDERS.filter((p) => resolveProviderPause({ states, provider: p }) !== null);
}

// ── Application à la planification ──────────────────────────────────

/**
 * Superpose la pause à la configuration : `enabled && !paused`.
 *
 * ⚠️ La pause n'est PAS écrite dans la configuration (`loadProjectScheduleConfig`
 * reste intacte). Les deux causes du silence — « désactivée » (configuration) et
 * « en pause » (décision) — doivent rester lisibles séparément, sinon l'écran ne
 * saurait plus laquelle nommer, ni laquelle un bouton peut lever.
 *
 * Le scheduler, lui, n'a pas à faire la différence : dans les deux cas, aucune
 * occurrence n'est due.
 */
export function applyPauseToSpec(spec: CadenceSpec, paused: boolean): CadenceSpec {
	if (!paused) return spec;
	return { ...spec, enabled: false };
}

// ── Formulation des causes (journal lisible) ────────────────────────

/** Code d'erreur porté par un job sauté pour cause de pause (miroir `DependencySkipped`). */
export const PAUSE_SKIP_CODE = 'PausedByOperator';

/** Acteur des écritures de la passe automatique (miroir `system:dependency`). */
export const PAUSE_SKIP_ACTOR = 'system:pause';

/**
 * Normalise une raison saisie. Obligatoire, bornée : c'est ce qui rend le journal
 * relisible dans trois semaines, quand plus personne ne se souviendra pourquoi le
 * hebdo de ce client était éteint.
 *
 * @throws si la raison est vide après nettoyage.
 */
export function normalizePauseReason(raw: unknown): string {
	const reason = typeof raw === 'string' ? raw.trim().slice(0, PAUSE_REASON_MAX) : '';
	if (!reason) throw new Error('Une raison est requise.');
	return reason;
}

/** Libellé court d'une cible, pour les écrans et les logs. */
export function describePauseTarget(target: PauseTarget, projectSlug?: string | null): string {
	switch (target.scope) {
		case 'provider':
			return `provider ${target.provider}`;
		case 'project':
			return `projet ${projectSlug ?? target.projectId}`;
		case 'project_cadence':
			return `${projectSlug ?? target.projectId} · ${target.cadence}`;
	}
}
