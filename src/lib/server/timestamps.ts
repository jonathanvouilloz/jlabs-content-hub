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

/** Même instant décalé de `ms` (backoff, bail…), au format DB. */
export function toDbTimestampPlus(ms: number, from: Date | string = new Date()): string {
	const base = typeof from === 'string' ? new Date(from) : from;
	if (Number.isNaN(base.getTime())) {
		throw new Error(`toDbTimestampPlus : date "${String(from)}" invalide.`);
	}
	return toDbTimestamp(new Date(base.getTime() + ms));
}
