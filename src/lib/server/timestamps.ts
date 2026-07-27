/**
 * Format canonique des colonnes temporelles (module PUR).
 *
 * Toutes les colonnes de date du schéma sont des `text` dont le DEFAULT SQL est
 * `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')` (cf. `nowText` dans
 * `db/schema.ts`). Écrire `new Date().toISOString()` dans ces mêmes colonnes y
 * mélange deux formats, et casse toute comparaison LEXICALE : au sein d'une même
 * journée, `'2026-07-22T09:00:00.000Z'` > `'2026-07-22 23:00:00'` parce que `'T'`
 * (0x54) > `' '` (0x20). Un `available_at` ISO paraîtrait ainsi indisponible
 * jusqu'au lendemain, et un `last_seen_at` ISO se trierait avant un `first_seen_at`
 * au format DB.
 *
 * Règle : toute écriture applicative d'une colonne temporelle passe par
 * `toDbTimestamp`, pour que la colonne reste homogène et comparable.
 */

/** Format exact des defaults SQL : `YYYY-MM-DD HH:MM:SS`, UTC, sans millisecondes. */
export function toDbTimestamp(date: Date | string = new Date()): string {
	const d = typeof date === 'string' ? new Date(date) : date;
	if (Number.isNaN(d.getTime())) {
		throw new Error(`toDbTimestamp : date "${String(date)}" invalide.`);
	}
	// toISOString est toujours UTC → on remplace le séparateur et coupe les ms.
	return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Forme canonique attendue : `YYYY-MM-DD HH:MM:SS`. */
const DB_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Rend une valeur comparable aux colonnes `text`, **sans jamais re-parser une chaîne
 * déjà canonique**.
 *
 * C'est la différence avec `toDbTimestamp`, et elle est load-bearing : ECMA-262 parse
 * une date-time sans `Z` ni offset en heure LOCALE. Repasser `'2026-07-26 12:00:00'`
 * (une valeur relue de la base, donc UTC) par `new Date()` puis `toISOString()` la
 * décale donc d'une à deux heures à Zurich — et le décalage change deux fois l'an.
 *
 * Règle : une valeur qui SORT de la base ou qui est déjà au format DB passe par ici ;
 * un `Date` construit par le code passe indifféremment par l'une ou l'autre.
 */
export function normalizeDbTimestamp(value: Date | string): string {
	if (typeof value === 'string' && DB_TIMESTAMP_RE.test(value)) return value;
	return toDbTimestamp(value);
}

/**
 * Format DB → instant (ms epoch). L'INVERSE de `toDbTimestamp`, et le seul chemin autorisé
 * pour faire de l'arithmétique sur une valeur relue de la base.
 *
 * Le `Z` explicite est TOUT le sujet : `new Date('2026-07-27 09:00:00')` est interprété en
 * heure LOCALE par ECMA-262, donc décalé d'une à deux heures à Zurich — et le décalage change
 * deux fois l'an. Une durée calculée ainsi (« publié combien de temps après l'échéance ? »)
 * serait fausse de 60 ou 120 minutes selon la saison, ce qui est exactement l'ordre de
 * grandeur qu'un SLO d'une heure mesure.
 *
 * Rend `NaN` sur une valeur illisible : à l'appelant de décider (jamais de valeur inventée).
 */
export function dbTimestampToMs(value: string): number {
	return new Date(`${value.replace(' ', 'T')}Z`).getTime();
}

/** Même instant décalé de `ms` (backoff, bail…), au format DB. */
export function toDbTimestampPlus(ms: number, from: Date | string = new Date()): string {
	const base = typeof from === 'string' ? new Date(from) : from;
	if (Number.isNaN(base.getTime())) {
		throw new Error(`toDbTimestampPlus : date "${String(from)}" invalide.`);
	}
	return toDbTimestamp(new Date(base.getTime() + ms));
}
