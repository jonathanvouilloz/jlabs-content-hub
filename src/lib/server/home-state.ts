/**
 * DASH-002 — Accueil cross-projet : le JUGEMENT (pur).
 *
 * Module PUR (zéro import db/`$env`/réseau), même paire que `gsc-windows-state.ts` /
 * `gsc-windows.ts` : ici on décide **ce qu'un projet vaut** et **ce qu'un compteur
 * ouvre** ; `home.ts` lit la base et exécute.
 *
 * Les trois acceptations DASH-002 vivent ici, structurellement :
 *
 *   1. « une intégration cassée est distincte d'une baisse de performance » →
 *      `classifyProject` tient DEUX axes qui ne fusionnent jamais en un score :
 *      `pipeline` (est-ce que la donnée arrive ?) et `signal` (que dit la donnée ?).
 *      Et surtout : un pipeline cassé rend le signal **inconnu**, jamais bon — « 0
 *      nouveau finding » sur une collecte morte ne veut pas dire « tout va bien »,
 *      ça veut dire qu'on ne sait pas. C'est la même doctrine que §10.3 (« une
 *      fenêtre absente n'est pas des zéros ») portée à l'échelle du projet.
 *   2. « chaque compteur ouvre une liste filtrée cohérente » → un compteur n'est pas
 *      un nombre + un lien écrits séparément : `buildCounter` produit les deux depuis
 *      le MÊME descripteur de filtre, et `home.ts` COMPTE avec ce descripteur. Le
 *      nombre et la liste ne peuvent donc pas décrire deux ensembles différents. Un
 *      compteur dont la liste cible ne saurait pas reproduire le filtre n'a **pas de
 *      lien** (`href: null`) plutôt qu'un lien qui mentirait.
 *   3. « Jonathan identifie en moins d'une minute les projets nécessitant une
 *      action » → `rankProjects` donne un ordre TOTAL et déterministe, et chaque
 *      carte porte UNE phrase (`headline`) qui nomme l'axe en cause.
 *
 * Fenêtre : 7 jours GLISSANTS. `finding_events` est horodaté à la seconde (contrairement
 * au canon GSC, hebdomadaire) : une fenêtre glissante y est une vraie précision, pas une
 * précision inventée. Elle couvre toujours le dernier run hebdo du lundi, quel que soit
 * le jour où l'écran est ouvert.
 *
 * DASH-003 lot 2 — la PAUSE entre dans la santé. `/automations` savait depuis DASH-006
 * qu'« une décision n'est pas une panne » ; l'accueil, lui, ne connaissait pas
 * `automation_pauses` du tout. Un projet volontairement suspendu s'y lisait donc comme
 * un pipeline qui a cessé de livrer : collecte en retard, badge rouge, zéro finding —
 * exactement la confusion que DASH-006 supprime, réintroduite sur l'écran qu'on lit en
 * premier. Les trois imports ajoutés sont des modules PURS (`pause-state`,
 * `schedule-state`, `job-limits`), les mêmes que `pause-state.ts` s'autorise : la règle
 * « zéro import db/`$env`/réseau » tient.
 */

import {
	pausedProviders,
	resolveCadencePause,
	type ActivePause,
	type PauseScope,
	type PauseStates
} from './pause-state.js';
import { SCHEDULE_CADENCES, catalogFor, type ScheduleCadence } from './schedule-state.js';
import { providerForJobType, type JobProvider } from './job-limits.js';

// ── Fenêtre de la période ───────────────────────────────────────────

/** Fenêtre par défaut de l'accueil, en jours glissants. */
export const DEFAULT_WINDOW_DAYS = 7;

/** Bornes acceptées : au-delà de 90 j la page cesse d'être un « ce qui vient de se passer ». */
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 90;

/**
 * Normalise la fenêtre demandée. Une valeur illisible retombe sur le DÉFAUT (et non
 * sur 0 ni sur le max) : contrairement au filtre de statut de DASH-005 — où rendre le
 * défaut ferait croire à l'utilisateur qu'il regarde son filtre —, la fenêtre n'est pas
 * un filtre d'ensemble mais une échelle de lecture, et une page vide serait ici un
 * mode de panne muet.
 */
export function normalizeWindowDays(raw: unknown): number {
	const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
	if (!Number.isFinite(n)) return DEFAULT_WINDOW_DAYS;
	return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.floor(n)));
}

// ── Fraîcheur (jamais « 0 » pour « jamais ») ─────────────────────────

export type FreshnessState = 'fresh' | 'stale' | 'never';

export interface Freshness {
	state: FreshnessState;
	/** Âge en heures — `null` si jamais collecté. JAMAIS 0 : « jamais » n'est pas « à l'instant ». */
	ageHours: number | null;
	/** Horodatage source, rendu tel quel pour que l'écran n'ait rien à recalculer. */
	lastSuccessAt: string | null;
}

/**
 * Dérive la fraîcheur d'un flux à partir de son dernier succès.
 *
 * `never` est un état À PART, pas un âge infini : une intégration jamais collectée et
 * une intégration en retard de trois semaines demandent deux gestes différents (brancher
 * vs réparer). `ageHours` reste `null` dans ce cas — l'acceptation DASH-001 « l'état des
 * données n'est jamais confondu avec une valeur zéro » commence par ne pas écrire 0.
 *
 * Comparaison sur des horodatages au FORMAT DB (`YYYY-MM-DD HH:MM:SS`, UTC) : on les
 * parse explicitement en UTC, jamais via `new Date(s)` seul, qui les lirait en heure
 * locale et décalerait tous les âges de l'offset du serveur.
 */
export function deriveFreshness(input: {
	lastSuccessAt: string | null | undefined;
	now: Date;
	staleAfterHours: number;
}): Freshness {
	const raw = input.lastSuccessAt ?? null;
	if (!raw) return { state: 'never', ageHours: null, lastSuccessAt: null };
	const ms = parseDbTimestampMs(raw);
	if (ms === null) return { state: 'never', ageHours: null, lastSuccessAt: raw };
	const ageHours = (input.now.getTime() - ms) / 3_600_000;
	return {
		state: ageHours > input.staleAfterHours ? 'stale' : 'fresh',
		ageHours,
		lastSuccessAt: raw
	};
}

/** `YYYY-MM-DD HH:MM:SS` (format DB) ou ISO → ms epoch UTC ; `null` si illisible. */
export function parseDbTimestampMs(value: string): number | null {
	const s = value.trim();
	if (!s) return null;
	const iso = s.includes('T') ? s : s.replace(' ', 'T');
	const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
	const ms = Date.parse(withZone);
	return Number.isNaN(ms) ? null : ms;
}

// ── Activité de la période (nouveaux / aggravés / améliorés / résolus) ──

/**
 * Les `event_type` de `finding_events` que l'accueil regroupe. Ce sont les valeurs
 * réelles écrites par `recordFindingEvent` — pas un vocabulaire parallèle : le compteur
 * et la liste liée lisent la MÊME table avec le MÊME type d'événement.
 */
export const ACTIVITY_EVENTS = ['created', 'aggravated', 'improved', 'resolved'] as const;
export type ActivityEvent = (typeof ACTIVITY_EVENTS)[number];

export type ActivityCounts = Record<ActivityEvent, number>;

export function emptyActivity(): ActivityCounts {
	return { created: 0, aggravated: 0, improved: 0, resolved: 0 };
}

/**
 * Regroupe des lignes `(eventType, n)` en compteurs d'activité.
 *
 * Les `event_type` hors catalogue (`agent_comment`, `snoozed`, `validated`…) sont
 * IGNORÉS et non repliés sur un « autre » : un commentaire d'agent n'est pas une
 * aggravation, et les additionner ferait gonfler la période d'un bruit que personne ne
 * peut ouvrir. Ils restent lisibles sur la vue finding (§13.3).
 */
export function groupActivity(rows: { eventType: string; n: number }[]): ActivityCounts {
	const out = emptyActivity();
	for (const row of rows) {
		if ((ACTIVITY_EVENTS as readonly string[]).includes(row.eventType)) {
			out[row.eventType as ActivityEvent] += row.n;
		}
	}
	return out;
}

// ── Pauses : ce qui s'est arrêté PAR DÉCISION (DASH-003 lot 2) ───────

/**
 * Le provider dont la fraîcheur porte le pipeline de ce produit.
 *
 * Déplacé de `home.ts` : la règle « une pause GSC explique le retard de collecte » est un
 * JUGEMENT, elle doit vivre là où le jugement vit. Deux définitions du provider de
 * fraîcheur — une pour lire la dernière collecte, une pour décider si la pause l'explique —
 * finiraient par désigner deux providers différents.
 */
export const FRESHNESS_PROVIDER: JobProvider = 'gsc';

/**
 * Ce qui, sur CE projet, est suspendu par décision — et depuis quand, par qui, pourquoi.
 *
 * Un champ dédié plutôt qu'une valeur d'axe supplémentaire : un enum ne peut porter ni la
 * raison, ni l'auteur, ni l'échéance, et c'est exactement ce qu'il faut lire pour savoir
 * s'il faut lever la pause ou la laisser courir. Même vocabulaire que `CadenceVerdict.pause`
 * (`automations-state.ts`) — réutilisé, jamais recopié.
 */
export interface ProjectPause {
	/**
	 * La portée qui l'emporte, donc celle qu'il faudra LEVER. `resolveCadencePause` rend
	 * déjà la plus large quand les deux existent : proposer « Reprendre » sur la cadence
	 * alors qu'un gel projet subsiste ferait cliquer dans le vide.
	 */
	scope: PauseScope;
	reason: string;
	actor: string;
	/** Quand la décision a été prise (format DB). */
	since: string;
	/** Échéance, ou `null` si la pause court jusqu'à reprise explicite. */
	until: string | null;
	/** Les cadences de ce projet réellement suspendues (câblées ET activées). */
	cadences: ScheduleCadence[];
	/**
	 * Toutes les cadences câblées et activées de ce projet sont suspendues — donc plus rien
	 * n'est planifié ici. C'est la SEULE condition du badge `paused` : une pause partielle
	 * se dit dans les raisons, elle ne repeint pas le projet.
	 */
	full: boolean;
	/**
	 * Providers suspendus globalement qui coupent au moins un job de ce projet. ⚠️ Une pause
	 * provider ne suspend AUCUNE cadence (le run s'ouvre, seuls ses jobs sautent) : elle
	 * n'entre donc jamais dans `full`. L'y faire entrer ferait virer les six cartes d'un coup
	 * sur une coupure `gsc`, alors que `findings:lifecycle` produit toujours.
	 */
	providers: JobProvider[];
	/**
	 * Les types de job que cette pause empêche réellement de tourner, TOUTES cadences
	 * confondues. Un type n'y entre que si **chacune** des cadences câblées et activées qui
	 * l'enfilent est neutralisée : `detect:index_transition` est au catalogue `daily` ET
	 * `weekly`, donc suspendre le hebdo ne le suspend pas — il tournera demain.
	 *
	 * ⚠️ La propagation JOB-004 y est comptée : un prérequis OBLIGATOIRE mort fait passer son
	 * dépendant en `skipped`. Couper `gsc` ne suspend aucun détecteur *directement* (aucun ne
	 * sort de Postgres) et les suspend pourtant tous — c'est ce que DASH-006 a prouvé en base.
	 * Ne compter que le provider du job lui-même annoncerait un travail qui n'aura pas lieu.
	 */
	suspendedJobTypes: string[];
	/**
	 * La pause explique-t-elle qu'aucune collecte fraîche ne soit arrivée ?
	 *
	 * Vrai seulement si **tous** les jobs du provider de fraîcheur sont suspendus. Se contenter
	 * d'« au moins un » serait plus simple et faux : `collect:url_inspection` (quotidien) et
	 * `collect:gsc_query_page` (hebdo) rafraîchissent tous deux `project_integrations` via
	 * `syncGscIntegration`, donc suspendre le seul quotidien laisse la fraîcheur se renouveler
	 * chaque lundi — et un vrai retard s'y lirait « c'est normal, c'est en pause ».
	 */
	suspendsFreshness: boolean;
}

/** Les cadences CÂBLÉES (celles qui mettent réellement quelque chose en file) et activées. */
function activeCadences(enabledByCadence: Record<ScheduleCadence, boolean>): ScheduleCadence[] {
	return SCHEDULE_CADENCES.filter((c) => catalogFor(c).length > 0 && enabledByCadence[c]);
}

/**
 * Les types de job d'UNE cadence qui ne tourneront pas, pause donnée.
 *
 * Trois causes, celles de `resolveJobPause` puis celle de JOB-004 : la cadence est suspendue
 * (tout tombe) · le provider du job est coupé · un prérequis OBLIGATOIRE est déjà tombé — un
 * prérequis mort fait passer son dépendant en `skipped`, un optionnel ne bloque personne.
 *
 * Une seule passe suffit : `validateCatalogGraph` garantit qu'un prérequis est déclaré AVANT
 * son dépendant, donc la propagation se fait dans l'ordre de lecture, même en profondeur 3.
 */
function deadJobTypes(input: {
	cadence: ScheduleCadence;
	cadencePaused: boolean;
	pausedProviders: ReadonlySet<JobProvider>;
}): Set<string> {
	const entries = catalogFor(input.cadence);
	const dead = new Set<string>();
	for (const entry of entries) {
		if (input.cadencePaused) {
			dead.add(entry.jobType);
			continue;
		}
		const providerDown = input.pausedProviders.has(providerForJobType(entry.jobType));
		const requiredDown = (entry.dependsOn ?? []).some(
			(d) => d.required !== false && dead.has(d.jobType)
		);
		if (providerDown || requiredDown) dead.add(entry.jobType);
	}
	return dead;
}

/**
 * Résume l'état de pause d'un projet.
 *
 * Ne réimplémente RIEN : l'union `project`/`project_cadence` et l'expiration `until` dérivée
 * ont déjà été faites par `derivePauseStates`/`resolveCadencePause`. Une seconde
 * implémentation de l'expiration, c'est précisément la divergence que DASH-006 a supprimée.
 *
 * ⚠️ Seules les cadences CÂBLÉES comptent. Suspendre `monthly` — dont le catalogue est vide —
 * est une décision sans effet : elle ne doit rien colorer, sinon l'écran signalerait un arrêt
 * là où rien ne tournait de toute façon.
 *
 * ⚠️ Une cadence DÉSACTIVÉE est hors du décompte, comme dans `classifyCadence` où `disabled`
 * précède `paused` : la configuration et la décision restent deux causes distinctes du silence.
 *
 * Rend `null` quand rien n'est suspendu — un `ProjectPause` vide se lirait « suspendu, sans
 * rien de suspendu ».
 */
export function summarizeProjectPause(input: {
	projectId: string;
	states: PauseStates;
	enabledByCadence: Record<ScheduleCadence, boolean>;
}): ProjectPause | null {
	const considered = activeCadences(input.enabledByCadence);

	const paused: ScheduleCadence[] = [];
	let widest: ActivePause | null = null;
	for (const cadence of considered) {
		const verdict = resolveCadencePause({
			states: input.states,
			projectId: input.projectId,
			cadence
		});
		if (!verdict.paused || !verdict.by) continue;
		paused.push(cadence);
		// `project` l'emporte sur `project_cadence` : c'est la portée à lever.
		if (!widest || (widest.target.scope !== 'project' && verdict.by.target.scope === 'project')) {
			widest = verdict.by;
		}
	}

	// Les providers de ce projet, dérivés du CATALOGUE de ses cadences câblées et activées :
	// une coupure `dataforseo` ne concerne pas un projet dont aucun job n'en dépend.
	const used = new Set<JobProvider>(
		considered.flatMap((c) => catalogFor(c).map((e) => providerForJobType(e.jobType)))
	);
	const providers = pausedProviders(input.states).filter((p) => used.has(p));

	if (paused.length === 0 && providers.length === 0) return null;

	// Un type de job n'est suspendu que si TOUTES les cadences câblées qui l'enfilent le sont.
	const providerSet = new Set(providers);
	const enqueued = new Map<string, number>();
	const neutralized = new Map<string, number>();
	for (const cadence of considered) {
		const dead = deadJobTypes({
			cadence,
			cadencePaused: paused.includes(cadence),
			pausedProviders: providerSet
		});
		for (const entry of catalogFor(cadence)) {
			enqueued.set(entry.jobType, (enqueued.get(entry.jobType) ?? 0) + 1);
			if (dead.has(entry.jobType)) {
				neutralized.set(entry.jobType, (neutralized.get(entry.jobType) ?? 0) + 1);
			}
		}
	}
	const suspendedJobTypes = [...enqueued]
		.filter(([jobType, total]) => (neutralized.get(jobType) ?? 0) === total)
		.map(([jobType]) => jobType);

	// La fraîcheur ne se renouvelle plus que si TOUS les jobs du provider de fraîcheur sont
	// suspendus — pas « au moins un » : deux collecteurs distincts la rafraîchissent.
	const freshnessJobs = [...enqueued.keys()].filter(
		(t) => providerForJobType(t) === FRESHNESS_PROVIDER
	);
	const suspendsFreshness =
		freshnessJobs.length > 0 && freshnessJobs.every((t) => suspendedJobTypes.includes(t));

	// Aucune cadence suspendue mais un provider coupé : c'est la pause provider qui parle.
	const source =
		widest ??
		[...input.states.values()].find(
			(p) => p.target.scope === 'provider' && providers.includes(p.target.provider as JobProvider)
		) ??
		null;
	if (!source) return null;

	return {
		scope: source.target.scope,
		reason: source.reason,
		actor: source.actor,
		since: source.since,
		until: source.until,
		cadences: paused,
		full: considered.length > 0 && paused.length === considered.length,
		providers,
		suspendedJobTypes,
		suspendsFreshness
	};
}

/**
 * La pause explique-t-elle qu'aucune collecte de fraîcheur ne soit arrivée ?
 *
 * Prédicat nommé plutôt qu'un accès direct au champ : c'est LA question que `classifyPipeline`
 * pose, et lui donner un nom empêche qu'on la remplace un jour par une approximation
 * (« le provider est coupé », « une cadence est suspendue ») qui silencierait un vrai retard.
 */
export function pauseSuspendsFreshness(pause: ProjectPause | null | undefined): boolean {
	return pause?.suspendsFreshness ?? false;
}

/** Libellé de portée, pour que la phrase dise ce qu'il faudra lever. */
export function pauseScopeLabel(scope: PauseScope): string {
	switch (scope) {
		case 'project':
			return 'projet gelé';
		case 'project_cadence':
			return 'cadence suspendue';
		case 'provider':
			return 'provider coupé';
	}
}

// ── Couverture de diagnostic (« jamais regardé » ≠ « rien à signaler ») ──

export type DiagnosisState = 'none' | 'partial' | 'full';

/** Un domaine de diagnostic ATTENDU pour le projet, et son dernier passage réussi. */
export interface DetectorCoverage {
	/** Type de job détecteur, ex. `detect:keyword_opportunity`. */
	detector: string;
	/** Dernier succès, format DB — `null` si ce détecteur n'a JAMAIS tourné sur ce projet. */
	lastSuccessAt: string | null;
}

export interface DiagnosisCoverage {
	state: DiagnosisState;
	/** Les détecteurs attendus qui n'ont jamais tourné. Vide si couverture complète. */
	neverRan: string[];
	/** Les détecteurs attendus qui ont tourné au moins une fois. */
	ranCount: number;
	expectedCount: number;
	/**
	 * Les détecteurs attendus qui ne tourneront plus tant que la pause court (DASH-003 lot 2).
	 *
	 * Distinct de `neverRan` : ici la couverture ne progresse plus **par décision**, alors que
	 * `neverRan` dit qu'elle n'a jamais commencé. Et distinct d'`expectedCount === 0`, qui dit
	 * « rien n'est planifié » : ici c'est planifié, et suspendu.
	 */
	suspended: string[];
}

/**
 * Nom lisible d'un détecteur, pour que la carte nomme le domaine et pas un type de job.
 * Un détecteur inconnu retombe sur son propre type : mieux vaut un nom technique affiché
 * qu'un domaine silencieusement absent de la phrase.
 */
const DETECTOR_LABELS: Record<string, string> = {
	'detect:keyword_opportunity': 'opportunités de mots-clés',
	'detect:keyword_decline': 'baisses de mots-clés',
	'detect:query_turnover': 'requêtes nouvelles et perdues',
	'detect:cannibalization': 'conflits de cannibalisation',
	'detect:index_transition': 'transitions d’indexation',
	'detect:review_pending': 'avis sans réponse'
};

export function detectorLabel(detector: string): string {
	return DETECTOR_LABELS[detector] ?? detector;
}

/**
 * Dérive la couverture de diagnostic d'un projet.
 *
 * Le pipeline dit si la donnée ARRIVE ; il ne dit rien de ce qu'on en a fait. Un projet
 * peut avoir une collecte GSC parfaitement fraîche et n'avoir jamais été passé au moindre
 * détecteur — c'est le cas de `barberconcept` au 2026-07-26. Ses zéro findings ne sont pas
 * un bulletin de santé : c'est une page blanche.
 *
 * `expected` est la liste des détecteurs que le CATALOGUE prévoit pour ce projet (même
 * source que ce que le scheduler enfile). Un projet dont on aurait désactivé la cadence
 * n'a donc aucun détecteur attendu → `none`, pas `full` : couper la planification ne rend
 * pas un projet sain, ça arrête juste de le regarder.
 *
 * DASH-003 lot 2 — `state` ne bouge PAS sous pause. Ce qui a été examiné l'a été : la
 * couverture acquise reste vraie, elle cesse seulement d'être renouvelée. La rabaisser
 * effacerait un passage réel, ce qui serait mentir dans l'autre sens.
 */
export function deriveDiagnosisCoverage(
	expected: DetectorCoverage[],
	pause?: ProjectPause | null
): DiagnosisCoverage {
	const neverRan = expected.filter((d) => !d.lastSuccessAt).map((d) => d.detector);
	const ranCount = expected.length - neverRan.length;
	const state: DiagnosisState =
		ranCount === 0 ? 'none' : neverRan.length === 0 ? 'full' : 'partial';
	// Intersection avec les détecteurs ATTENDUS : une pause peut neutraliser un détecteur que
	// ce projet n'attend pas (cadence désactivée chez lui), et l'annoncer suspendu nommerait
	// un domaine dont personne ici n'attendait rien.
	const expectedSet = new Set(expected.map((d) => d.detector));
	const suspended = (pause?.suspendedJobTypes ?? []).filter((d) => expectedSet.has(d));
	return { state, neverRan, ranCount, expectedCount: expected.length, suspended };
}

// ── Compteurs : le nombre ET son lien, depuis un seul descripteur ────

/**
 * Ce qu'un compteur compte. C'est le descripteur qui sert À LA FOIS à requêter (côté
 * `home.ts`) et à écrire le lien (`counterHref`) — l'acceptation « chaque compteur ouvre
 * une liste filtrée cohérente » ne peut donc pas se perdre : il n'existe pas deux
 * endroits où le filtre est écrit.
 */
export type CounterFilter =
	| { kind: 'findings_activity'; event: ActivityEvent; sinceDb: string; projectSlug?: string | null }
	| { kind: 'findings_open'; severities?: readonly string[]; projectSlug?: string | null }
	| { kind: 'proposals_pending'; projectSlug?: string | null }
	| { kind: 'reviews_unanswered'; projectSlug?: string | null }
	| { kind: 'jobs_failed'; projectSlug?: string | null }
	| { kind: 'runs_period'; status: string; sinceDb: string; projectSlug?: string | null };

export interface Counter {
	/** Libellé court, tel qu'affiché. */
	label: string;
	count: number;
	/**
	 * Liste filtrée qui reproduit EXACTEMENT ce que `count` a compté — ou `null` quand
	 * aucune liste existante ne sait le reproduire. Un compteur sans lien reste un
	 * chiffre lisible ; un lien vers un autre ensemble serait un mensonge cliquable.
	 */
	href: string | null;
	filter: CounterFilter;
}

/** Tous les statuts de finding, pour un lien qui doit ignorer le défaut « actifs » de l'inbox. */
const ALL_FINDING_STATUSES =
	'open,acknowledged,planned,in_progress,resolved,dismissed,snoozed,reopened';

function withProject(params: URLSearchParams, projectSlug?: string | null): URLSearchParams {
	if (projectSlug) params.set('project', projectSlug);
	return params;
}

/**
 * L'IDENTITÉ d'un compteur, stable d'une semaine à l'autre (REP-004).
 *
 * ⚠️ **Ni `sinceDb` ni `projectSlug` n'entrent dans la clé, et c'est tout l'intérêt.** Le
 * descripteur porte la borne de période parce que le lien doit la reproduire ; l'identité, elle,
 * doit survivre au fait que cette borne change chaque lundi. Comparer deux rapports appariera
 * `findings_activity.created` avec `findings_activity.created`, jamais deux libellés qui se
 * ressemblent — un compteur ne se reconnaît pas à sa prose (elle, elle a le droit de changer).
 */
export function counterKey(filter: CounterFilter): string {
	switch (filter.kind) {
		case 'findings_activity':
			return `findings_activity.${filter.event}`;
		case 'runs_period':
			return `runs_period.${filter.status}`;
		case 'findings_open':
		case 'proposals_pending':
		case 'reviews_unanswered':
		case 'jobs_failed':
			return filter.kind;
	}
}

/**
 * Le lien qui reproduit un filtre.
 *
 * `findings_activity` vise l'onglet findings de l'inbox avec `event` + `since` — les deux
 * paramètres que `listFindings`/`countFindings` appliquent via la MÊME clause EXISTS sur
 * `finding_events` que le compteur. Et il force `fstatus` sur TOUS les statuts : sans ça,
 * le défaut de l'inbox (statuts actifs) écarterait précisément les findings `resolved`
 * que le compteur « résolus » vient de compter.
 */
export function counterHref(filter: CounterFilter): string | null {
	switch (filter.kind) {
		case 'findings_activity': {
			const p = withProject(new URLSearchParams(), filter.projectSlug);
			p.set('tab', 'findings');
			p.set('event', filter.event);
			p.set('since', filter.sinceDb);
			p.set('fstatus', ALL_FINDING_STATUSES);
			return `/inbox?${p.toString()}`;
		}
		case 'findings_open': {
			const p = withProject(new URLSearchParams(), filter.projectSlug);
			p.set('tab', 'findings');
			// Pas de `fstatus` : le défaut de l'inbox EST « les statuts actifs », soit
			// exactement ce que ce compteur compte. L'écrire à la main ferait deux
			// définitions du même ensemble, qui divergeraient au premier ajout de statut.
			return `/inbox?${p.toString()}`;
		}
		case 'proposals_pending': {
			const p = withProject(new URLSearchParams(), filter.projectSlug);
			p.set('status', 'proposed');
			return `/inbox?${p.toString()}`;
		}
		case 'reviews_unanswered':
			// La liste des avis est PAR PROJET (`/projects/[slug]/reviews`) : il n'existe
			// aucune vue cross-projet des avis. Sans slug, ce compteur n'a donc pas de
			// liste cohérente à ouvrir — il reste un chiffre.
			return filter.projectSlug ? `/projects/${filter.projectSlug}/reviews` : null;
		case 'jobs_failed': {
			const p = withProject(new URLSearchParams(), filter.projectSlug);
			p.set('status', 'dead');
			return `/jobs?${p.toString()}`;
		}
		case 'runs_period': {
			// DASH-006 — il existe enfin une liste de RUNS (`/automations`), et elle
			// applique le même `created_at >= since` + `status` que ce compteur. Tant
			// qu'elle n'existait pas, ce compteur restait muet : `/jobs` liste des
			// jobs, et l'y envoyer aurait ouvert un autre ensemble que celui compté.
			const p = withProject(new URLSearchParams(), filter.projectSlug);
			p.set('status', filter.status);
			p.set('since', filter.sinceDb);
			return `/automations?${p.toString()}`;
		}
	}
}

export function buildCounter(label: string, count: number, filter: CounterFilter): Counter {
	return { label, count, href: counterHref(filter), filter };
}

// ── Santé d'un projet : DEUX axes qui ne fusionnent jamais ───────────

export type PipelineState = 'ok' | 'degraded' | 'broken' | 'unknown';
export type SignalState = 'ok' | 'watch' | 'at_risk' | 'unknown';
/**
 * `paused` (DASH-003 lot 2) est un état À PART, ni `ok` ni `broken` ni `unknown`.
 *
 * `unknown` aurait pu passer pour suffisant — un projet suspendu ne dit effectivement plus
 * rien. Mais `unknown` veut dire « muet, et je ne sais pas pourquoi », le contraire exact de
 * ce qui est vrai ici. Et l'argument qui tranche est un effet de bord : `STATE_RANK` place
 * `unknown` en 3ᵉ position, donc un projet volontairement suspendu passerait DEVANT un
 * projet à surveiller. Un arrêt volontaire ne prend pas la tête de la file.
 */
export type ProjectState = 'ok' | 'watch' | 'at_risk' | 'broken' | 'unknown' | 'paused';

export interface AxisVerdict<S extends string> {
	state: S;
	/** Raisons lisibles, dans l'ordre de gravité. Vide = rien à dire. */
	reasons: string[];
}

export interface IntegrationSummary {
	provider: string;
	/** `project_integrations.health_status` : healthy | degraded | down | unknown. */
	healthStatus: string;
	/** `project_integrations.status` : inactive | active | error | revoked. */
	status: string;
	enabled: boolean;
	lastSuccessAt: string | null;
	lastErrorCode: string | null;
}

export interface ProjectCardInput {
	projectId: string;
	slug: string;
	name: string;
	color: string | null;
	integrations: IntegrationSummary[];
	/** Findings ouverts par sévérité (les statuts ACTIFS uniquement). */
	openBySeverity: Record<string, number>;
	activity: ActivityCounts;
	proposalsPending: number;
	reviewsUnanswered: number;
	/** Jobs en dead-letter — un travail qui ne repartira pas tout seul. */
	jobsDead: number;
	/** Dernier succès de collecte GSC (canon), `null` si jamais collecté. */
	gscLastSuccessAt: string | null;
	/**
	 * Les détecteurs ATTENDUS pour ce projet et leur dernier passage réussi. C'est ce qui
	 * empêche « zéro finding » de se lire « zéro problème » sur un projet jamais examiné.
	 */
	detectors: DetectorCoverage[];
	/**
	 * Ce qui est suspendu par décision sur ce projet, ou `null`. OPTIONNEL : un appelant qui
	 * ne connaît pas les pauses obtient exactement la carte d'avant DASH-003 lot 2.
	 */
	pause?: ProjectPause | null;
	/** Borne basse de la période, au format DB — celle SOUS LAQUELLE l'activité a été comptée. */
	sinceDb: string;
	now: Date;
	staleAfterHours: number;
}

export interface ProjectCard {
	projectId: string;
	slug: string;
	name: string;
	color: string | null;
	state: ProjectState;
	pipeline: AxisVerdict<PipelineState>;
	signal: AxisVerdict<SignalState>;
	freshness: Freshness;
	/** Ce qui a réellement été examiné — rendu à l'écran, pas seulement pris en compte. */
	diagnosis: DiagnosisCoverage;
	/** Ce qui est arrêté PAR DÉCISION — avec sa raison, son auteur et sa date. `null` si rien. */
	pause: ProjectPause | null;
	/** UNE phrase qui nomme l'axe en cause — ce qu'on lit en moins d'une minute. */
	headline: string;
	openBySeverity: Record<string, number>;
	openTotal: number;
	activity: ActivityCounts;
	proposalsPending: number;
	reviewsUnanswered: number;
	jobsDead: number;
	counters: Counter[];
}

/** Sévérités qui font basculer le signal (les autres sont du bruit informatif). */
const CRITICAL_SEVERITIES = ['critical'] as const;
const HIGH_SEVERITIES = ['high'] as const;

function sumSeverities(map: Record<string, number>, keys: readonly string[]): number {
	return keys.reduce((acc, k) => acc + (map[k] ?? 0), 0);
}

function sumAll(map: Record<string, number>): number {
	return Object.values(map).reduce((acc, n) => acc + n, 0);
}

/**
 * L'axe PIPELINE : est-ce que la donnée arrive ?
 *
 * Une intégration `error`/`revoked` ou `health_status='down'` casse le pipeline —
 * indépendamment de ce que les findings racontent. Une intégration `degraded`, une
 * collecte GSC en retard ou des jobs en dead-letter le dégradent. Une intégration
 * `inactive`/jamais collectée n'est PAS une panne : c'est un flux qu'on n'a pas branché,
 * et le confondre avec une panne ferait crier six projets pour un provider qu'on n'utilise
 * pas encore.
 *
 * DASH-003 lot 2 — la PAUSE entre à un seul endroit : la fraîcheur. L'ordre des règles est
 * celui de **ce qui survit à la reprise**. Un credential révoqué reste `broken` sous pause
 * (le jour où on reprend, la panne est encore là) ; un job en dead-letter reste une
 * dégradation (il ne repartira pas parce qu'on a suspendu la cadence) ; mais un retard de
 * collecte sous pause n'est pas un symptôme, c'est la conséquence ATTENDUE de la décision.
 */
export function classifyPipeline(input: {
	integrations: IntegrationSummary[];
	freshness: Freshness;
	jobsDead: number;
	pause?: ProjectPause | null;
}): AxisVerdict<PipelineState> {
	const reasons: string[] = [];
	let state: PipelineState = 'ok';

	const broken = input.integrations.filter(
		(i) => i.status === 'error' || i.status === 'revoked' || i.healthStatus === 'down'
	);
	const degraded = input.integrations.filter(
		(i) => !broken.includes(i) && i.enabled && i.healthStatus === 'degraded'
	);

	for (const i of broken) {
		reasons.push(
			`intégration ${i.provider} ${i.status === 'revoked' ? 'révoquée' : 'en erreur'}` +
				(i.lastErrorCode ? ` (${i.lastErrorCode})` : '')
		);
	}
	for (const i of degraded) reasons.push(`intégration ${i.provider} dégradée`);

	if (broken.length > 0) state = 'broken';
	else if (degraded.length > 0) state = 'degraded';

	// Fraîcheur de la collecte : le retard est une DÉGRADATION, jamais une panne — GSC
	// complète ses données après coup, et une semaine de retard n'est pas un credential mort.
	//
	// ⚠️ Sauf si une pause l'explique. Reprocher « collecte en retard » à un flux qu'on a
	// soi-même suspendu, c'est demander de réparer une décision — et c'est exactement ce que
	// DASH-006 a supprimé sur `/automations`. On le DIT quand même (le silence n'est pas
	// l'absence de cause), mais on ne dégrade pas.
	const freshnessPaused = pauseSuspendsFreshness(input.pause);
	if (input.freshness.state === 'stale') {
		if (freshnessPaused && input.pause) {
			reasons.push(
				`collecte suspendue depuis ${input.pause.since} — ${input.pause.reason} (${pauseScopeLabel(input.pause.scope)})`
			);
		} else {
			reasons.push(
				`collecte GSC en retard (dernier succès ${input.freshness.lastSuccessAt ?? 'inconnu'})`
			);
			if (state === 'ok') state = 'degraded';
		}
	}

	if (input.jobsDead > 0) {
		reasons.push(`${input.jobsDead} job${input.jobsDead > 1 ? 's' : ''} en dead-letter`);
		if (state === 'ok') state = 'degraded';
	}

	// Aucune intégration déclarée ET jamais collecté : on ne sait rien de ce projet.
	// « unknown » et non « ok » — c'est la même règle que §10.3 : l'absence n'est pas un bon état.
	if (state === 'ok' && input.integrations.length === 0 && input.freshness.state === 'never') {
		return { state: 'unknown', reasons: ['aucune intégration déclarée, aucune collecte'] };
	}

	// Tout est suspendu et rien n'est cassé : plus rien n'arrivera, donc l'axe ne peut pas
	// rester `ok`. Même forme et même raison que la règle juste au-dessus — l'absence de
	// donnée n'est pas un bon état, qu'elle vienne d'un flux jamais branché ou d'un arrêt
	// volontaire. La CAUSE, elle, est dite : c'est ce qui les distingue à l'écran.
	if (state === 'ok' && input.pause?.full) {
		return {
			state: 'unknown',
			reasons: [
				`collecte suspendue par décision — plus rien n’arrive (${pauseScopeLabel(input.pause.scope)}, ${input.pause.reason})`
			]
		};
	}

	return { state, reasons };
}

/**
 * L'axe SIGNAL : que dit la donnée ?
 *
 * ⚠️ Le cœur de l'acceptation « une intégration cassée est distincte d'une baisse de
 * performance » : quand le pipeline est cassé ou en retard, le signal devient
 * **`unknown`**, pas `ok`. Sans cette règle, un projet dont la collecte est morte
 * afficherait « 0 nouveau finding » et se lirait comme le projet le plus sain du
 * portefeuille — le pire mode de panne, celui qui ne se plaint pas.
 *
 * ⚠️ Même règle, DEUXIÈME cause, et c'est celle qui manquait : un pipeline sain ne
 * suffit pas, encore faut-il que quelque chose ait REGARDÉ. `barberconcept` collectait
 * bien et s'affichait « Sain » sans avoir jamais été diagnostiqué — zéro finding s'y
 * lisait « zéro problème » alors que ça voulait dire « jamais ouvert le dossier ».
 * D'où l'invariant : **`ok` n'est atteignable que sur un diagnostic complet.** Une
 * couverture partielle laisse passer ce qui est POSITIVEMENT su (un critique reste un
 * critique) mais ne peut plus conclure au vert — l'absence de finding n'est une bonne
 * nouvelle que dans les domaines réellement examinés.
 *
 * Trois degrés, et ils ne se valent pas : rien d'examiné → `unknown` (on ne sait rien) ;
 * partiellement examiné sans rien trouver → `watch` (on ne peut pas conclure) ; tout
 * examiné → le verdict des findings, `ok` compris.
 */
export function classifySignal(input: {
	openBySeverity: Record<string, number>;
	activity: ActivityCounts;
	pipeline: PipelineState;
	diagnosis: DiagnosisCoverage;
}): AxisVerdict<SignalState> {
	const critical = sumSeverities(input.openBySeverity, CRITICAL_SEVERITIES);
	const high = sumSeverities(input.openBySeverity, HIGH_SEVERITIES);

	if (input.pipeline === 'broken' || input.pipeline === 'unknown') {
		const reasons = [
			input.pipeline === 'broken'
				? 'signal non fiable : la collecte est cassée'
				: 'signal non fiable : rien n’est collecté'
		];
		// Ce qui est DÉJÀ connu reste dit — un finding critique découvert avant la panne
		// ne disparaît pas parce que la collecte est tombée depuis.
		if (critical > 0) reasons.push(`${critical} finding critique déjà ouvert`);
		return { state: 'unknown', reasons };
	}

	// Jamais diagnostiqué : on ne sait rien, et le dire est le seul verdict honnête. Ce cas
	// est distinct du pipeline cassé — ici la donnée arrive, personne ne l'a jugée.
	if (input.diagnosis.state === 'none') {
		// « signal absent » et non « non fiable » (le cas pipeline cassé juste au-dessus) :
		// là-bas une mesure existe mais ne vaut rien, ici il n'y en a jamais eu.
		const reasons = [
			input.diagnosis.expectedCount === 0
				? 'signal absent : aucun diagnostic n’est planifié sur ce projet'
				: 'signal absent : aucun diagnostic n’a jamais tourné sur ce projet'
		];
		if (critical > 0) reasons.push(`${critical} finding critique déjà ouvert`);
		return { state: 'unknown', reasons };
	}

	const reasons: string[] = [];
	if (critical > 0) reasons.push(`${critical} finding${critical > 1 ? 's' : ''} critique${critical > 1 ? 's' : ''}`);
	if (high > 0) reasons.push(`${high} finding${high > 1 ? 's' : ''} de sévérité haute`);
	if (input.activity.aggravated > 0) reasons.push(`${input.activity.aggravated} aggravé${input.activity.aggravated > 1 ? 's' : ''} sur la période`);

	let state: SignalState = 'ok';
	if (critical > 0 || input.activity.aggravated > 0) state = 'at_risk';
	else if (high > 0) state = 'watch';

	// Diagnostic incomplet : ce qui a été trouvé reste vrai, mais « rien trouvé » ne vaut
	// que pour les domaines examinés. Un `ok` affirmerait ici plus que la mesure → `watch`,
	// « je ne peux pas dire que c'est propre ». Un `watch`/`at_risk` déjà acquis est
	// conservé : il repose sur des findings réels, que l'angle mort ne rend pas moins vrais.
	//
	// `watch` et NON `unknown` : `unknown` est réservé au cas où l'on ne sait RIEN. Les
	// confondre remplirait l'écran d'une seule couleur — au 2026-07-26,
	// `detect:index_transition` n'ayant jamais tourné nulle part, les six projets viraient
	// au violet et « 6 à traiter sur 6 » ne distinguait plus le projet jamais ouvert de
	// celui qu'on suit depuis des semaines. Un cockpit uniforme ne se lit pas « en moins
	// d'une minute » : il ne se lit plus du tout.
	if (input.diagnosis.state === 'partial') {
		const domains = input.diagnosis.neverRan.map(detectorLabel).join(', ');
		reasons.push(`diagnostic incomplet : ${domains} — jamais exécuté`);
		if (state === 'ok') state = 'watch';
	}

	// Diagnostic SUSPENDU : la couverture acquise reste vraie, mais elle ne se renouvelle plus.
	// Un `ok` dirait « rien à signaler » d'un domaine que plus personne n'examine. `watch` pour
	// la même raison que le cas `partial` juste au-dessus — et non `unknown`, réservé au « je ne
	// sais RIEN » : ce qui a déjà été trouvé ici reste connu.
	if (input.diagnosis.suspended.length > 0) {
		const domains = input.diagnosis.suspended.map(detectorLabel).join(', ');
		reasons.push(`diagnostic suspendu : ${domains} — ne tournera pas tant que la pause court`);
		if (state === 'ok') state = 'watch';
	}

	// Une collecte dégradée n'annule pas le signal (la donnée arrive, en retard) mais on
	// le dit : lire « ok » sur des mesures d'une semaine de trop serait trompeur.
	if (input.pipeline === 'degraded' && state === 'ok') {
		reasons.push('signal calculé sur des données en retard');
	}

	return { state, reasons };
}

/**
 * L'état global d'un projet = le PIRE des deux axes, mais l'axe reste nommé.
 *
 * Un seul badge sans son axe ferait exactement ce que l'acceptation interdit : confondre
 * « le SEO baisse » et « la collecte est morte ». D'où `headline`, qui dit toujours
 * lequel des deux parle.
 */
export function classifyProject(input: ProjectCardInput): ProjectCard {
	const freshness = deriveFreshness({
		lastSuccessAt: input.gscLastSuccessAt,
		now: input.now,
		staleAfterHours: input.staleAfterHours
	});
	const pause = input.pause ?? null;
	const pipeline = classifyPipeline({
		integrations: input.integrations,
		freshness,
		jobsDead: input.jobsDead,
		pause
	});
	const diagnosis = deriveDiagnosisCoverage(input.detectors, pause);
	const signal = classifySignal({
		openBySeverity: input.openBySeverity,
		activity: input.activity,
		pipeline: pipeline.state,
		diagnosis
	});

	let state: ProjectState;
	if (pipeline.state === 'broken') state = 'broken';
	else if (signal.state === 'at_risk') state = 'at_risk';
	// La pause vient APRÈS `broken` et `at_risk` : elle arrête de REGARDER, elle n'annule pas
	// ce qui est DÉJÀ su. Un credential mort et un critique ouvert restent vrais sous pause —
	// même doctrine que `classifySignal`, qui conserve « X critique déjà ouvert » sous un
	// pipeline cassé. Et AVANT `unknown` : nommer la cause bat nommer le symptôme.
	else if (pause?.full) state = 'paused';
	else if (pipeline.state === 'unknown' || signal.state === 'unknown') state = 'unknown';
	else if (signal.state === 'watch' || pipeline.state === 'degraded') state = 'watch';
	else state = 'ok';

	const headline = buildHeadline({ state, pipeline, signal, pause });

	return {
		projectId: input.projectId,
		slug: input.slug,
		name: input.name,
		color: input.color,
		state,
		pipeline,
		signal,
		freshness,
		diagnosis,
		pause,
		headline,
		openBySeverity: input.openBySeverity,
		openTotal: sumAll(input.openBySeverity),
		activity: input.activity,
		proposalsPending: input.proposalsPending,
		reviewsUnanswered: input.reviewsUnanswered,
		jobsDead: input.jobsDead,
		counters: buildProjectCounters(input)
	};
}

/**
 * Les compteurs d'une carte, construits ICI et non dans le template.
 *
 * Chaque compteur naît d'un `CounterFilter` : le nombre que `home.ts` a compté et le lien
 * que l'écran affiche viennent du même descripteur, donc du même filtre. Une règle qui ne
 * vivrait que dans un `{#if}` se perdrait au premier refactor — même doctrine que
 * l'exclusion des L4 dans le module pur de DASH-005.
 */
export function buildProjectCounters(input: ProjectCardInput): Counter[] {
	const slug = input.slug;
	const counters: Counter[] = [
		buildCounter('ouverts', sumAll(input.openBySeverity), {
			kind: 'findings_open',
			projectSlug: slug
		}),
		buildCounter('nouveaux', input.activity.created, {
			kind: 'findings_activity',
			event: 'created',
			sinceDb: input.sinceDb,
			projectSlug: slug
		}),
		buildCounter('aggravés', input.activity.aggravated, {
			kind: 'findings_activity',
			event: 'aggravated',
			sinceDb: input.sinceDb,
			projectSlug: slug
		}),
		buildCounter('résolus', input.activity.resolved, {
			kind: 'findings_activity',
			event: 'resolved',
			sinceDb: input.sinceDb,
			projectSlug: slug
		}),
		buildCounter('à valider', input.proposalsPending, {
			kind: 'proposals_pending',
			projectSlug: slug
		}),
		buildCounter('avis sans réponse', input.reviewsUnanswered, {
			kind: 'reviews_unanswered',
			projectSlug: slug
		})
	];
	// Le dead-letter n'apparaît que s'il y en a : un « 0 en dead-letter » sur six lignes
	// est du bruit qui pousse hors de l'écran ce qui demande vraiment une action.
	if (input.jobsDead > 0) {
		counters.push(buildCounter('dead-letter', input.jobsDead, { kind: 'jobs_failed', projectSlug: slug }));
	}
	return counters;
}

/** La phrase de la carte : elle nomme TOUJOURS l'axe, jamais un score nu. */
export function buildHeadline(input: {
	state: ProjectState;
	pipeline: AxisVerdict<PipelineState>;
	signal: AxisVerdict<SignalState>;
	pause?: ProjectPause | null;
}): string {
	switch (input.state) {
		case 'paused': {
			// La phrase nomme la DÉCISION : sa portée (donc ce qu'il faudra lever), sa raison,
			// son auteur et sa date. Un « Suspendu » nu obligerait à ouvrir `/automations` pour
			// savoir si c'est voulu, ce qui est précisément la question qu'on vient de répondre.
			const p = input.pause;
			if (!p) return 'Suspendu — décision d’exploitation';
			const terme = p.until ? `, jusqu’au ${p.until}` : '';
			return `Suspendu — ${p.reason} (${pauseScopeLabel(p.scope)}, par ${p.actor} le ${p.since}${terme})`;
		}
		case 'broken':
			return `Collecte à réparer — ${input.pipeline.reasons[0] ?? 'intégration cassée'}`;
		case 'at_risk':
			return `Performance à traiter — ${input.signal.reasons[0] ?? 'signal dégradé'}`;
		case 'unknown':
			return input.pipeline.state === 'unknown'
				? `État inconnu — ${input.pipeline.reasons[0] ?? 'aucune donnée'}`
				: `État inconnu — ${input.signal.reasons[0] ?? 'signal non fiable'}`;
		case 'watch':
			return `À surveiller — ${input.signal.reasons[0] ?? input.pipeline.reasons[0] ?? 'signal faible'}`;
		case 'ok':
			// Nomme les deux axes, comme les quatre cas au-dessus. « Rien à traiter » était le seul
			// verdict nu du switch, et il portait plus loin que ce qu'il mesure : la santé ne lit
			// que la DONNÉE, jamais la file de décisions. Un projet sans alerte peut avoir des
			// propositions en attente — l'accueil affichait « rien à traiter » à côté d'un
			// compteur « 4 à valider », chacun disant vrai et le lecteur devant trancher.
			return 'Collecte et performance au vert';
	}
}

// ── Priorisation : un ordre TOTAL, jamais un tri instable ────────────

/**
 * Rang de tri d'un état. `unknown` passe AVANT `watch` — délibérément : ne pas savoir
 * est plus urgent qu'un signal faible connu. Un projet muet est le seul qui puisse
 * cacher n'importe quoi, et c'est exactement ce que l'accueil existe pour éviter.
 */
const STATE_RANK: Record<ProjectState, number> = {
	broken: 0,
	at_risk: 1,
	unknown: 2,
	watch: 3,
	ok: 4,
	// APRÈS `ok`, et c'est l'argument qui a fait de `paused` un état à part : un projet
	// volontairement suspendu ne demande aucune action, il ne doit donc jamais remonter en
	// tête de la liste « à traiter ». Le ranger sous `unknown` l'y aurait mis chaque fois.
	paused: 5
};

export function stateRank(state: ProjectState): number {
	return STATE_RANK[state];
}

/**
 * Trie les cartes par urgence, avec un ordre TOTAL : à égalité sur tous les critères
 * métier, on retombe sur le `slug`. Sans cette dernière clé, deux projets équivalents
 * pourraient permuter d'un chargement à l'autre — et un écran dont les lignes bougent
 * sans que rien n'ait changé n'est plus lisible « en moins d'une minute ».
 */
export function rankProjects(cards: ProjectCard[]): ProjectCard[] {
	return [...cards].sort((a, b) => {
		const byState = stateRank(a.state) - stateRank(b.state);
		if (byState !== 0) return byState;
		const byCritical =
			sumSeverities(b.openBySeverity, CRITICAL_SEVERITIES) -
			sumSeverities(a.openBySeverity, CRITICAL_SEVERITIES);
		if (byCritical !== 0) return byCritical;
		const byHigh =
			sumSeverities(b.openBySeverity, HIGH_SEVERITIES) - sumSeverities(a.openBySeverity, HIGH_SEVERITIES);
		if (byHigh !== 0) return byHigh;
		const byAggravated = b.activity.aggravated - a.activity.aggravated;
		if (byAggravated !== 0) return byAggravated;
		const byProposals = b.proposalsPending - a.proposalsPending;
		if (byProposals !== 0) return byProposals;
		return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
	});
}

/**
 * Les projets qui demandent une action — tout sauf `ok` **et `paused`**.
 *
 * Une décision n'est pas une tâche : un projet qu'on a soi-même suspendu n'a rien à traiter,
 * l'y laisser rendrait la liste « à traiter » ininterrompue tant que la pause court. Il reste
 * évidemment dans le portefeuille, avec son badge et sa raison.
 */
export function needsAction(state: ProjectState): boolean {
	return state !== 'ok' && state !== 'paused';
}

export function projectsNeedingAction(cards: ProjectCard[]): ProjectCard[] {
	return rankProjects(cards).filter((c) => needsAction(c.state));
}

// ── Santé globale du portefeuille ───────────────────────────────────

export interface PortfolioHealth {
	total: number;
	byState: Record<ProjectState, number>;
	/** Projets à traiter (tout sauf `ok`). */
	needingAction: number;
	/**
	 * L'état du portefeuille = le pire état représenté. Une moyenne serait pire qu'inutile :
	 * cinq projets sains ne compensent pas une collecte morte, ils la diluent.
	 */
	worst: ProjectState;
}

export function summarizePortfolio(cards: ProjectCard[]): PortfolioHealth {
	const byState: Record<ProjectState, number> = {
		ok: 0,
		watch: 0,
		at_risk: 0,
		broken: 0,
		unknown: 0,
		paused: 0
	};
	for (const c of cards) byState[c.state] += 1;
	// `paused` n'entre PAS dans l'échelle de gravité : une décision n'est pas une panne, et
	// un projet suspendu au milieu de cinq projets sains ne doit pas teinter le portefeuille.
	const worst =
		(['broken', 'at_risk', 'unknown', 'watch'] as ProjectState[]).find((s) => byState[s] > 0) ?? 'ok';
	return {
		total: cards.length,
		byState,
		needingAction: cards.filter((c) => needsAction(c.state)).length,
		// …mais un parc ENTIÈREMENT suspendu n'est pas « au vert ». Rendre `ok` ici afficherait
		// « tout va bien » sur un monitoring que plus personne ne fait tourner.
		worst:
			cards.length === 0
				? 'unknown'
				: worst === 'ok' && byState.paused === cards.length
					? 'paused'
					: worst
	};
}

// ── Coûts : un gate INERTE, pas un zéro ─────────────────────────────

export type CostSummary =
	| {
			instrumented: false;
			reason: 'not_instrumented';
			/** Ce qui manque, dit à l'écran plutôt que masqué derrière un `0`. */
			detail: string;
	  }
	| { instrumented: true; runs: number; totals: Record<string, number> };

/**
 * Résume les coûts de la période — et dit HONNÊTEMENT quand il n'y en a pas à résumer.
 *
 * `monitoring_runs.cost_json` existe depuis DATA-003 mais **rien ne l'écrit** : seul
 * `createRun` l'accepte, et aucun appelant ne le passe. Afficher « 0 CHF » serait
 * exactement ce que l'acceptation DASH-001 interdit — confondre « pas instrumenté » avec
 * « gratuit ». Le gate se réveillera SEUL le jour où un run portera un coût (même
 * doctrine que le YoY inerte de GSC-004 : câblé, pas inventé).
 *
 * Un `cost_json` illisible n'est pas compté et ne fait pas échouer la page : un JSON
 * cassé dans une colonne d'agrégat ne doit pas coûter l'accueil entier.
 */
export function summarizeCosts(runs: { costJson: string | null }[]): CostSummary {
	const totals: Record<string, number> = {};
	let instrumentedRuns = 0;

	for (const run of runs) {
		if (!run.costJson) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(run.costJson);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
		let counted = false;
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === 'number' && Number.isFinite(value)) {
				totals[key] = (totals[key] ?? 0) + value;
				counted = true;
			}
		}
		if (counted) instrumentedRuns += 1;
	}

	if (instrumentedRuns === 0) {
		return {
			instrumented: false,
			reason: 'not_instrumented',
			detail:
				'aucun run ne porte de coût : `monitoring_runs.cost_json` n’est écrit par aucun producteur (dette nommée, pas un zéro)'
		};
	}
	return { instrumented: true, runs: instrumentedRuns, totals };
}
