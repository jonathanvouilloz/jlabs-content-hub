/**
 * JOB-005 — Helpers PURS du scheduler (cadences, timezone métier, occurrences).
 *
 * Aucun import de runtime (ni db, ni `$env`) → testables en isolation par vitest,
 * comme `detector-state.ts`, `finding-state.ts` et `job-retry.ts`. Le seul `import`
 * est un `import type`, effacé à la compilation.
 *
 * Deux idées portent tout le reste :
 *
 *  1. **Le créneau est LOCAL, l'instant est dérivé.** Un créneau se nomme par ses
 *     champs `Europe/Zurich` (`2026-07-20T09:00`), jamais par un instant UTC. C'est
 *     ce qui rend le lundi 09:00 métier stable des deux côtés du changement d'heure
 *     (08:00 UTC en hiver, 07:00 UTC en été) — et c'est aussi ce qui rend le doublon
 *     structurellement impossible le jour du retour à l'heure d'hiver : 02:30 local
 *     n'existe qu'une fois dans le calendrier, même si l'instant correspondant, lui,
 *     se présente deux fois.
 *
 *  2. **Aucune horloge implicite.** `now`, `since`, `until` sont toujours INJECTÉS
 *     (même discipline que le `random` de `applyJitter` en JOB-003) : une fonction
 *     qui lirait `Date.now()` ne serait pas rejouable, et les deux bascules DST se
 *     testent précisément en figeant la référence.
 *
 * La timezone est traitée par `Intl.DateTimeFormat` — natif, base ICU du runtime,
 * aucune dépendance ajoutée (pas de date-fns-tz ni de table de règles à maintenir).
 */

import type { CatalogDependency } from './job-graph.js';

// ── Vocabulaire ─────────────────────────────────────────────────────

/** Timezone métier (SPEC §8.1). Les créneaux sont pensés dans celle-ci, pas en UTC. */
export const BUSINESS_TIMEZONE = 'Europe/Zurich';

/**
 * Cadences d'horloge. `post_publish` n'en est PAS une : elle se déclenche sur un
 * événement de publication, pas sur un cadran — voir `POST_PUBLISH_OFFSETS_DAYS`.
 */
export const SCHEDULE_CADENCES = ['hourly', 'daily', 'weekly', 'monthly'] as const;
export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number];

/** `run_type` du run logique ouvert par une cadence (aligné `RUN_TYPES` de monitoring-state). */
export const CADENCE_RUN_TYPE: Record<ScheduleCadence, string> = {
	hourly: 'hourly',
	daily: 'daily',
	weekly: 'weekly',
	monthly: 'monthly'
};

// ── Configuration d'une cadence ─────────────────────────────────────

export interface CadenceSpec {
	/** Une cadence désactivée ne produit aucune occurrence (ni due, ni prochaine). */
	enabled: boolean;
	/** Minute du créneau (0-59). Seule composante utile à `hourly`. */
	minute: number;
	/** Heure locale (0-23). Ignorée par `hourly`. */
	hour: number;
	/** Jour de semaine, 1 = lundi … 7 = dimanche (ISO). `weekly` uniquement. */
	weekday: number;
	/** Jour du mois (1-28, borné pour exister tous les mois). `monthly` uniquement. */
	day: number;
}

export type ScheduleConfig = Record<ScheduleCadence, CadenceSpec>;

/**
 * Défauts SPEC §8.1. Le hebdo est le seul créneau réellement spécifié (**lundi
 * 09:00 Europe/Zurich**) ; les autres sont posés hors des heures de bascule DST
 * (02:00-03:00) pour qu'un créneau quotidien ne tombe jamais dans le trou de mars.
 */
export const SCHEDULE_DEFAULTS: ScheduleConfig = {
	hourly: { enabled: true, minute: 5, hour: 0, weekday: 1, day: 1 },
	daily: { enabled: true, minute: 0, hour: 7, weekday: 1, day: 1 },
	weekly: { enabled: true, minute: 0, hour: 9, weekday: 1, day: 1 },
	monthly: { enabled: true, minute: 0, hour: 8, weekday: 1, day: 1 }
};

/** Fenêtre de rattrapage par défaut (6 h) — cf. `dueOccurrences`. */
export const DEFAULT_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/**
 * Fusionne des overrides projet avec les défauts. Idiome tolérant de
 * `resolveThresholds` (detector-state) et `resolveLifecycleConfig` (finding-state) :
 * une valeur absente, d'un mauvais type ou hors bornes retombe sur le défaut plutôt
 * que d'éteindre la planification d'un projet en silence. Une planification muette
 * est le pire des échecs : rien ne se plaint, et plus rien ne tourne.
 */
export function resolveScheduleConfig(
	overrides?: Partial<Record<ScheduleCadence, Partial<CadenceSpec>>> | null
): ScheduleConfig {
	const out = {} as ScheduleConfig;
	for (const cadence of SCHEDULE_CADENCES) {
		out[cadence] = { ...SCHEDULE_DEFAULTS[cadence] };
	}
	if (!overrides || typeof overrides !== 'object') return out;

	for (const cadence of SCHEDULE_CADENCES) {
		const raw = overrides[cadence];
		if (!raw || typeof raw !== 'object') continue;
		const spec = out[cadence];

		if (typeof raw.enabled === 'boolean') spec.enabled = raw.enabled;
		spec.minute = clampInt(raw.minute, 0, 59, spec.minute);
		spec.hour = clampInt(raw.hour, 0, 23, spec.hour);
		spec.weekday = clampInt(raw.weekday, 1, 7, spec.weekday);
		// Borné à 28 : un créneau mensuel au 31 n'existerait pas en février, et un
		// créneau qui n'existe pas ne se rattrape jamais.
		spec.day = clampInt(raw.day, 1, 28, spec.day);
	}
	return out;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	const n = Math.floor(value);
	return n >= min && n <= max ? n : fallback;
}

// ── Conversion timezone (Intl, sans dépendance) ─────────────────────

export interface ZonedFields {
	year: number;
	month: number; // 1-12
	day: number;
	hour: number;
	minute: number;
	second: number;
	/** ISO : 1 = lundi … 7 = dimanche. */
	weekday: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	let f = FORMATTERS.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23', // sans lui, minuit peut ressortir en « 24 »
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
		FORMATTERS.set(timeZone, f);
	}
	return f;
}

/** Champs civils d'un instant dans une timezone donnée. */
export function utcToZonedFields(timeZone: string, instant: Date | number): ZonedFields {
	const ms = typeof instant === 'number' ? instant : instant.getTime();
	const parts = formatterFor(timeZone).formatToParts(new Date(ms));
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');

	const year = get('year');
	const month = get('month');
	const day = get('day');
	// Le jour de semaine est dérivé des champs civils (et non lu via Intl, dont le
	// libellé dépend de la locale) : Date.UTC les traite comme une date nue.
	const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = dimanche
	return {
		year,
		month,
		day,
		hour: get('hour'),
		minute: get('minute'),
		second: get('second'),
		weekday: dow === 0 ? 7 : dow
	};
}

/**
 * Décalage de la timezone à cet instant, en ms (ex. +7 200 000 en CEST).
 * Se lit comme : « ce que les champs civils avancent sur l'instant réel ».
 */
export function zoneOffsetMs(timeZone: string, instant: Date | number): number {
	const ms = typeof instant === 'number' ? instant : instant.getTime();
	const f = utcToZonedFields(timeZone, ms);
	const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
	// L'instant est tronqué à la seconde : les champs civils n'ont pas de ms, les
	// garder ferait ressortir un offset faux de quelques centaines de ms.
	return asUtc - Math.floor(ms / 1000) * 1000;
}

export interface LocalToInstant {
	instantMs: number;
	/** Créneau local canonique (`YYYY-MM-DDTHH:MM`) — la clé d'occurrence. */
	localSlot: string;
	/**
	 * Vrai si les champs demandés n'existaient pas (trou du passage à l'heure d'été) :
	 * le créneau a GLISSÉ du montant du saut. `localSlot` porte alors l'heure réelle.
	 */
	adjusted: boolean;
	/** Vrai si les champs demandés existaient DEUX fois (retour à l'heure d'hiver). */
	ambiguous: boolean;
}

/**
 * Champs civils → instant. Le cœur DST de JOB-005.
 *
 * On ne fait pas confiance à une passe unique : aux bordures, l'offset à appliquer
 * n'est pas celui de l'instant qu'on est en train de calculer. On teste donc les
 * DEUX offsets en vigueur autour du créneau (la veille et le lendemain) et on
 * regarde lesquels se relisent bien :
 *
 *   - deux candidats valides → créneau **ambigu** (25 octobre, 02:30 arrive deux
 *     fois) : on retient le PREMIER instant (heure d'été), convention `compatible`
 *     de Temporal. Peu importe lequel au fond : la clé d'occurrence étant le
 *     créneau local, l'autre ne pourrait de toute façon pas produire un doublon ;
 *   - aucun candidat valide → créneau **inexistant** (29 mars, 02:30 n'existe pas) :
 *     on retient l'instant obtenu avec l'offset d'avant le saut, ce qui place le
 *     créneau juste après le trou (02:30 → 03:30). Il GLISSE, il n'est jamais perdu
 *     — un créneau quotidien avalé une fois l'an serait un trou de monitoring muet.
 */
export function zonedFieldsToUtc(input: {
	timeZone: string;
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}): LocalToInstant {
	const { timeZone, year, month, day, hour, minute } = input;
	const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
	const DAY_MS = 24 * 60 * 60 * 1000;

	const offBefore = zoneOffsetMs(timeZone, wanted - DAY_MS);
	const offAfter = zoneOffsetMs(timeZone, wanted + DAY_MS);

	const candidates = offBefore === offAfter ? [offBefore] : [offBefore, offAfter];
	const valid: number[] = [];
	for (const off of candidates) {
		const ts = wanted - off;
		const back = utcToZonedFields(timeZone, ts);
		if (
			back.year === year &&
			back.month === month &&
			back.day === day &&
			back.hour === hour &&
			back.minute === minute
		) {
			valid.push(ts);
		}
	}

	if (valid.length > 0) {
		const instantMs = Math.min(...valid);
		return {
			instantMs,
			localSlot: formatLocalSlot({ year, month, day, hour, minute }),
			adjusted: false,
			ambiguous: valid.length > 1
		};
	}

	// Trou : on prend l'offset d'AVANT le saut, ce qui projette le créneau juste
	// après le trou, puis on relit les champs réellement obtenus.
	const instantMs = wanted - offBefore;
	const back = utcToZonedFields(timeZone, instantMs);
	return {
		instantMs,
		localSlot: formatLocalSlot(back),
		adjusted: true,
		ambiguous: false
	};
}

/** `2026-07-20T09:00` — la clé d'occurrence, LOCALE (jamais un instant). */
export function formatLocalSlot(f: {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}): string {
	const p2 = (n: number) => String(n).padStart(2, '0');
	return `${f.year}-${p2(f.month)}-${p2(f.day)}T${p2(f.hour)}:${p2(f.minute)}`;
}

// ── Occurrences ─────────────────────────────────────────────────────

export interface Occurrence {
	cadence: ScheduleCadence;
	/** Créneau local canonique — sert de `period_end` dans la clé d'idempotence. */
	localSlot: string;
	/** Instant UTC correspondant (ms epoch). */
	instantMs: number;
	/** Le créneau a glissé (heure inexistante) — utile à l'affichage et aux preuves. */
	adjusted: boolean;
	/** Le créneau local existait deux fois (retour à l'heure d'hiver). */
	ambiguous: boolean;
}

interface OccurrenceQuery {
	cadence: ScheduleCadence;
	spec: CadenceSpec;
	timeZone?: string;
}

/**
 * Toutes les occurrences d'une cadence dans `]since, until]`.
 *
 * La fenêtre est ce qui rend le tick tolérant au retard : Vercel ne garantit pas la
 * minute exacte et un tick peut échouer, donc on regarde en arrière au lieu de
 * demander « sommes-nous pile à l'heure ? ». Rejouer une occurrence déjà tirée est
 * sans effet (clé d'idempotence), un créneau manqué est en revanche perdu pour de bon.
 */
export function dueOccurrences(
	input: OccurrenceQuery & { since: Date | number; until: Date | number }
): Occurrence[] {
	const since = toMs(input.since);
	const until = toMs(input.until);
	if (!input.spec.enabled || until <= since) return [];
	return enumerateSlots({ ...input, fromMs: since, toMs: until }).filter(
		(o) => o.instantMs > since && o.instantMs <= until
	);
}

/**
 * Prochaine occurrence STRICTEMENT après `after`, ou `null` si la cadence est
 * désactivée. C'est la réponse à « quand ce projet tourne-t-il la prochaine fois ? »,
 * calculée — donc jamais désynchronisée d'un état persisté qui aurait dérivé.
 */
export function nextOccurrence(input: OccurrenceQuery & { after: Date | number }): Occurrence | null {
	const after = toMs(input.after);
	if (!input.spec.enabled) return null;

	const horizon = HORIZON_MS[input.cadence];
	const slots = enumerateSlots({ ...input, fromMs: after, toMs: after + horizon });
	for (const slot of slots) {
		if (slot.instantMs > after) return slot;
	}
	return null;
}

/** Horizon de recherche : large de deux périodes, pour couvrir les bords de mois. */
const HORIZON_MS: Record<ScheduleCadence, number> = {
	hourly: 3 * 60 * 60 * 1000,
	daily: 3 * 24 * 60 * 60 * 1000,
	weekly: 15 * 24 * 60 * 60 * 1000,
	monthly: 70 * 24 * 60 * 60 * 1000
};

/**
 * Énumère les créneaux d'une cadence entre deux instants, triés par instant.
 *
 * On balaie en temps LOCAL (les unités civiles candidates), pas en arithmétique
 * d'instants : c'est ce qui fait que le lundi 09:00 reste le lundi 09:00 quand la
 * journée du changement d'heure dure 23 ou 25 heures.
 */
function enumerateSlots(
	input: OccurrenceQuery & { fromMs: number; toMs: number }
): Occurrence[] {
	const timeZone = input.timeZone ?? BUSINESS_TIMEZONE;
	const { cadence, spec } = input;
	const DAY_MS = 24 * 60 * 60 * 1000;

	// Marge d'un jour de chaque côté : un créneau local proche du bord peut tomber
	// dans la fenêtre une fois converti en instant.
	const from = input.fromMs - DAY_MS;
	const to = input.toMs + DAY_MS;

	const seen = new Set<string>();
	const out: Occurrence[] = [];

	// Pas de balayage : assez fin pour ne manquer aucune unité civile (une heure
	// locale pour `hourly`, un jour local sinon), même une journée de 23 h.
	const step = cadence === 'hourly' ? 30 * 60 * 1000 : 6 * 60 * 60 * 1000;

	for (let cursor = from; cursor <= to + step; cursor += step) {
		const f = utcToZonedFields(timeZone, cursor);

		if (cadence === 'weekly' && f.weekday !== spec.weekday) continue;
		if (cadence === 'monthly' && f.day !== spec.day) continue;

		const hour = cadence === 'hourly' ? f.hour : spec.hour;
		const resolved = zonedFieldsToUtc({
			timeZone,
			year: f.year,
			month: f.month,
			day: f.day,
			hour,
			minute: spec.minute
		});

		if (seen.has(resolved.localSlot)) continue;
		seen.add(resolved.localSlot);
		out.push({
			cadence,
			localSlot: resolved.localSlot,
			instantMs: resolved.instantMs,
			adjusted: resolved.adjusted,
			ambiguous: resolved.ambiguous
		});
	}

	return out.sort((a, b) => a.instantMs - b.instantMs);
}

function toMs(v: Date | number): number {
	return typeof v === 'number' ? v : v.getTime();
}

// ── Catalogue : quelle cadence met quoi en file ─────────────────────

export interface CatalogEntry {
	/** Type de job, tel que le registre de `job-runner.ts` le connaît. */
	jobType: string;
	priority: number;
	/** Charge non secrète passée au handler. */
	payload?: Record<string, unknown>;
	/**
	 * JOB-004 — prérequis DANS LA MÊME occurrence, par type. `required` vaut `true`
	 * par défaut : un prérequis obligatoire mort fait SAUTER le dépendant (run
	 * `partial`), un optionnel mort ne bloque personne.
	 *
	 * Un prérequis doit être déclaré AVANT son dépendant dans le tableau —
	 * `validateCatalogGraph` le vérifie, et `planOne` en dépend (il résout les ids
	 * au fil de la mise en file).
	 */
	dependsOn?: CatalogDependency[];
}

/**
 * Déclaratif, et volontairement INCOMPLET : seules les cadences dont un handler
 * existe vraiment mettent quelque chose en file. `hourly` et `monthly` sont
 * planifiables (leurs occurrences se calculent, leur prochaine exécution s'affiche)
 * mais ne produisent aucun job tant que les collecteurs E03 n'existent pas — le
 * runner l'annonce, plutôt que d'enfiler un type que personne ne sait exécuter.
 *
 * Les types sont ceux de `job-runner.ts` (`JOB_TYPE_*`), repris ici en littéral : ce
 * module ne connaît aucun runtime (le seul `import` est un `import type`, effacé à la
 * compilation).
 */
export const SCHEDULE_CATALOG: Record<ScheduleCadence, CatalogEntry[]> = {
	// Rien d'horaire tant que la synchronisation des avis (SPEC §8.1) n'est pas
	// portée par un handler.
	hourly: [],
	// Les veilles doivent expirer même une semaine sans détection (FIND-003).
	//
	// IDX-004 lot 2 — la passe QUOTIDIENNE des échéances. `scope: 'due'` ne lit que
	// `index_selection` : ni inventaire sitemap, ni clics (`collectCandidates` sort avant),
	// donc AUCUN prérequis ici — ni ne le pourrait, une arête vers un type absent de la
	// cadence étant rejetée par `validateCatalogGraph`. C'est aussi ce qui en fait une réserve
	// que la configuration ne peut pas désarmer : routine et échantillon n'y entrent jamais.
	//
	// Sans elle, les J+3/J+7/J+28 posés par `scheduleIndexChecks` à la publication resteraient
	// dus jusqu'au lundi suivant, et une échéance J+3 pourrait être honorée à J+9 — ce qui
	// vide de son sens l'idée même de vérifier tôt.
	//
	// L'arête vers le détecteur est OBLIGATOIRE, comme en hebdo : détecter sur une inspection
	// périmée est exactement le bug que GSC-002 a fermé côté Search Analytics. Un « toujours
	// pas indexé à J+3 » devient donc un finding le jour même, au lieu d'attendre le run hebdo.
	daily: [
		{ jobType: 'findings:lifecycle', priority: 5 },
		{
			jobType: 'collect:url_inspection',
			priority: 9,
			payload: { mode: 'policy', scope: 'due' }
		},
		{
			jobType: 'detect:index_transition',
			priority: 8,
			dependsOn: [{ jobType: 'collect:url_inspection' }]
		}
	],
	// Le run hebdo de référence (SPEC §8.1). La détection PUIS la production de
	// propositions.
	//
	// Depuis JOB-004, c'est une vraie DÉPENDANCE et plus seulement un ordre de
	// service : le producteur n'est pas réclamable tant que la détection n'a pas
	// abouti. Auparavant, deux workers concurrents ou un détecteur reporté pour
	// quota le faisaient travailler sur les findings de la SEMAINE PRÉCÉDENTE, en
	// silence — l'idempotence évitait les doublons, elle ne disait rien du décalage.
	// La `priority` reste : elle sert encore l'ordre au sein d'un même tour de drain.
	//
	// Le lien est OBLIGATOIRE (décision produit) : si la détection meurt, le
	// producteur est `skipped` et le run vaut `partial`. Le trou de la semaine est
	// alors visible, au lieu d'être masqué par des propositions fondées sur des
	// mesures périmées.
	//
	// GSC-002 — la chaîne commence désormais par la COLLECTE. Avant, le détecteur
	// partait sur des observations que plus rien ne rafraîchissait depuis le backfill
	// du 2026-07-21 : il décidait chaque semaine sur des mesures d'une semaine plus
	// vieilles, en silence. Le lien est obligatoire — pas de collecte, pas de
	// détection, et le run le DIT (`partial`) au lieu de produire des findings fondés
	// sur des chiffres périmés.
	//
	// ⚠️ Le graphe passe à la PROFONDEUR 3. Un skip se propage en N-1 passes : si la
	// collecte meurt, `detect` est sauté au tour à vide suivant et `propose`
	// seulement au tick d'APRÈS. Attendu — à ne pas diagnostiquer comme un job « qui
	// ne part pas ».
	// IDX-001 — `collect:sitemap` rejoint le run hebdo (branche `fetch_sitemap` du graphe
	// SPEC §8.2). **Aucune dépendance ENTRANTE** : deux sources indépendantes, dont une seule
	// consomme du quota Search Analytics. Les lier ferait sauter l'inventaire sitemap à cause
	// d'un 429 GSC — alors que le XML, lui, aurait été parfaitement fetchable.
	//
	// IDX-004 — la branche d'indexation se referme : `collect:url_inspection` puis
	// `detect:index_transition`. Trois choix y sont load-bearing :
	//
	//   1. Le payload porte une INTENTION (`mode: 'policy'`), pas une liste d'URLs. Le payload
	//      du catalogue est un littéral statique (`JSON.stringify(entry.payload)`), et une
	//      sélection calculée au plan le serait AVANT que `collect:sitemap` du même run ait
	//      écrit l'inventaire du jour — donc avec `new`/`changed` structurellement vides.
	//   2. Les deux prérequis de l'inspection sont **OPTIONNELS** : ils ordonnent sans bloquer.
	//      La sélection VEUT l'inventaire du jour (`new`/`changed`) et les clics (`strategic`),
	//      mais un sitemap 404 ou un 429 Search Analytics ne doit pas priver le projet de
	//      l'inspection de ses findings et de ses échéances dues. ⚠️ Optionnel ne veut pas dire
	//      sans effet : un prérequis encore `queued`/`running` fait ATTENDRE son dépendant. Un
	//      `collect:sitemap` lent décale l'inspection d'un tick, il ne l'annule pas.
	//   3. L'arête vers le détecteur est **OBLIGATOIRE** (décision produit) : détecter sur une
	//      inspection périmée est exactement le bug que GSC-002 a fermé côté Search Analytics.
	//
	// ⚠️ La branche d'indexation passe elle aussi à la PROFONDEUR 3
	// (`sitemap → url_inspection → index_transition`) : un skip s'y propage avec le même tour
	// de retard que sur la branche GSC.
	weekly: [
		{ jobType: 'collect:gsc_query_page', priority: 12 },
		{ jobType: 'collect:sitemap', priority: 11 },
		{
			jobType: 'collect:url_inspection',
			priority: 10,
			payload: { mode: 'policy', scope: 'full' },
			dependsOn: [
				{ jobType: 'collect:sitemap', required: false },
				{ jobType: 'collect:gsc_query_page', required: false }
			]
		},
		{
			jobType: 'detect:keyword_opportunity',
			priority: 10,
			payload: { weeks: 4 },
			dependsOn: [{ jobType: 'collect:gsc_query_page' }]
		},
		// FIND-005 — la baisse rejoint l'opportunité, sur la MÊME collecte et au MÊME
		// niveau du graphe : les deux détecteurs lisent `gsc_query_page_observations`,
		// n'appellent aucun provider, et n'ont rien à se dire. Les enchaîner en série
		// (`decline` après `opportunity`) ajouterait un tour de propagation de skip sans
		// aucune contrepartie — ils sont frères, pas successifs.
		//
		// L'arête vers la collecte est **OBLIGATOIRE**, comme pour les opportunités :
		// mesurer une baisse sur des observations non rafraîchies, c'est comparer une
		// fenêtre à elle-même décalée d'une semaine. Si la collecte meurt, le détecteur
		// est `skipped` et le run vaut `partial` — le trou est visible, au lieu d'être
		// masqué par une « baisse » qui n'est qu'un défaut de collecte.
		{
			jobType: 'detect:keyword_decline',
			priority: 10,
			dependsOn: [{ jobType: 'collect:gsc_query_page' }]
		},
		// FIND-006 — le renouvellement du portefeuille rejoint la fratrie : troisième
		// lecteur des mêmes observations, sans provider, sans lien avec ses deux frères.
		// Il produit DEUX types de findings (`new_query`, `lost_query`) depuis UNE passe,
		// parce que chacun est la garde de l'autre — les séparer en deux jobs ferait
		// reconstruire à chacun la moitié de l'information, et le premier décalage entre
		// eux écrirait les deux faux signaux symétriques que le regroupement empêche.
		//
		// L'arête vers la collecte est **OBLIGATOIRE**, et plus littéralement ici que
		// partout ailleurs : sans la semaine fraîche, la fenêtre courante n'a pas sa
		// dernière semaine, et TOUT le portefeuille se lit comme perdu.
		{
			jobType: 'detect:query_turnover',
			priority: 10,
			dependsOn: [{ jobType: 'collect:gsc_query_page' }]
		},
		{
			jobType: 'detect:index_transition',
			priority: 9,
			dependsOn: [{ jobType: 'collect:url_inspection' }]
		},
		{ jobType: 'propose:actions', priority: 8, dependsOn: [{ jobType: 'detect:keyword_opportunity' }] }
	],
	monthly: []
};

export function catalogFor(cadence: ScheduleCadence): CatalogEntry[] {
	return SCHEDULE_CATALOG[cadence] ?? [];
}

/** Cadences réellement câblées à au moins un job (les autres ne planifient rien). */
export function wiredCadences(): ScheduleCadence[] {
	return SCHEDULE_CADENCES.filter((c) => catalogFor(c).length > 0);
}

// ── Post-publication (événementiel, pas horloge) ────────────────────

/** Vérifications différées après publication (SPEC §8.1 « post-publication »). */
export const POST_PUBLISH_OFFSETS_DAYS = [3, 7, 28] as const;

export interface PostPublishSlot {
	offsetDays: number;
	instantMs: number;
}

/**
 * Échéances d'une publication. Pas de cadran ici : on décale l'instant de publication
 * de N jours, et le job attend son heure dans la file (`available_at`). Le scheduler
 * n'a donc rien à faire tourner entre-temps — ce qui est exactement ce qu'on veut
 * d'une infrastructure sans worker permanent.
 */
export function postPublishSlots(publishedAt: Date | number): PostPublishSlot[] {
	const base = toMs(publishedAt);
	const DAY_MS = 24 * 60 * 60 * 1000;
	return POST_PUBLISH_OFFSETS_DAYS.map((offsetDays) => ({
		offsetDays,
		instantMs: base + offsetDays * DAY_MS
	}));
}
