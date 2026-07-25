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
 */

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
		case 'runs_period':
			// `/jobs` liste des JOBS, pas des runs : aucun écran ne liste les runs d'une
			// période. Le compteur est donc muet plutôt que faussement cliquable (la vue
			// automatisations de SPEC §13.4 lui donnera sa liste).
			return null;
	}
}

export function buildCounter(label: string, count: number, filter: CounterFilter): Counter {
	return { label, count, href: counterHref(filter), filter };
}

// ── Santé d'un projet : DEUX axes qui ne fusionnent jamais ───────────

export type PipelineState = 'ok' | 'degraded' | 'broken' | 'unknown';
export type SignalState = 'ok' | 'watch' | 'at_risk' | 'unknown';
export type ProjectState = 'ok' | 'watch' | 'at_risk' | 'broken' | 'unknown';

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
 */
export function classifyPipeline(input: {
	integrations: IntegrationSummary[];
	freshness: Freshness;
	jobsDead: number;
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
	if (input.freshness.state === 'stale') {
		reasons.push(
			`collecte GSC en retard (dernier succès ${input.freshness.lastSuccessAt ?? 'inconnu'})`
		);
		if (state === 'ok') state = 'degraded';
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
 */
export function classifySignal(input: {
	openBySeverity: Record<string, number>;
	activity: ActivityCounts;
	pipeline: PipelineState;
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

	const reasons: string[] = [];
	if (critical > 0) reasons.push(`${critical} finding${critical > 1 ? 's' : ''} critique${critical > 1 ? 's' : ''}`);
	if (high > 0) reasons.push(`${high} finding${high > 1 ? 's' : ''} de sévérité haute`);
	if (input.activity.aggravated > 0) reasons.push(`${input.activity.aggravated} aggravé${input.activity.aggravated > 1 ? 's' : ''} sur la période`);

	let state: SignalState = 'ok';
	if (critical > 0 || input.activity.aggravated > 0) state = 'at_risk';
	else if (high > 0) state = 'watch';

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
	const pipeline = classifyPipeline({
		integrations: input.integrations,
		freshness,
		jobsDead: input.jobsDead
	});
	const signal = classifySignal({
		openBySeverity: input.openBySeverity,
		activity: input.activity,
		pipeline: pipeline.state
	});

	let state: ProjectState;
	if (pipeline.state === 'broken') state = 'broken';
	else if (signal.state === 'at_risk') state = 'at_risk';
	else if (pipeline.state === 'unknown' || signal.state === 'unknown') state = 'unknown';
	else if (signal.state === 'watch' || pipeline.state === 'degraded') state = 'watch';
	else state = 'ok';

	const headline = buildHeadline({ state, pipeline, signal });

	return {
		projectId: input.projectId,
		slug: input.slug,
		name: input.name,
		color: input.color,
		state,
		pipeline,
		signal,
		freshness,
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
}): string {
	switch (input.state) {
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
	ok: 4
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

/** Les projets qui demandent une action — tout sauf `ok`. */
export function projectsNeedingAction(cards: ProjectCard[]): ProjectCard[] {
	return rankProjects(cards).filter((c) => c.state !== 'ok');
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
	const byState: Record<ProjectState, number> = { ok: 0, watch: 0, at_risk: 0, broken: 0, unknown: 0 };
	for (const c of cards) byState[c.state] += 1;
	const worst =
		(['broken', 'at_risk', 'unknown', 'watch'] as ProjectState[]).find((s) => byState[s] > 0) ?? 'ok';
	return {
		total: cards.length,
		byState,
		needingAction: cards.filter((c) => c.state !== 'ok').length,
		worst: cards.length === 0 ? 'unknown' : worst
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
