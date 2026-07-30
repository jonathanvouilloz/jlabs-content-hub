/**
 * GMB — résolution du CIBLAGE par établissement, la partie pure.
 *
 * Un post GMB peut viser toutes les fiches d'un projet ou une seule. Le skill `/gmb-generate`
 * écrit ce choix dans `target_location` (`"all"` ou `"locations/{id}"`, cf.
 * `_gmb-shared/references/draft-schema.md`), et jusqu'ici PERSONNE ne le lisait :
 *
 * 1. `api/content/+server.ts` reconstruisait `meta` depuis une liste blanche de 7 clés où
 *    `target_location` ne figurait pas — le champ était jeté à l'insertion ;
 * 2. le cron interrogeait `meta.target_locations` (pluriel, jamais écrit par personne) ;
 * 3. faute de cible, l'ancien `resolveTargetLocations` retombait sur TOUTES les fiches.
 *
 * Mesuré sur `barberconcept` le 2026-07-30 : 18 posts sur 20 portaient une cible dans leur
 * `body`, 0 dans leur `meta`, et les 168 lignes de `publish_logs` se répartissent en exactement
 * 28 tentatives par fiche sur 6 fiches. Des posts qui nommaient Cornavin ont été publiés à Sion.
 *
 * ⚠️ **LA règle de ce module : une cible illisible n'est JAMAIS « toutes les fiches ».**
 * C'est le fond du bug — la valeur par défaut la plus permissive servait aussi de sortie
 * d'erreur, donc une cible cassée était indiscernable d'une absence de cible. `unresolved` est
 * un état nommé, qui refuse de publier et dit sur quoi il a buté. Le pire cas devient « rien
 * n'est publié et ça se voit », jamais « tout est publié partout en silence ».
 *
 * ⚠️ **Le hub ne connaît QUE l'ID Google** (`project_gmb_locations.gmb_location_id`, ex.
 * `locations/9613432581015768943`). Les `fiche_id` du repo (`barber-sion`) lui sont étrangers :
 * le mapping vit dans `docs/channels/gmb.md` côté projet, et c'est `/publish-hub` qui doit
 * l'appliquer AVANT d'envoyer. Une cible en slug de repo tombe donc en `unresolved` — à dessein.
 */

/** Une fiche du projet, réduite à ce dont la résolution a besoin. */
export interface TargetableLocation {
	gmbLocationId: string;
	label: string;
}

export type LocationTargetResolution<T extends TargetableLocation> =
	/** Aucune cible déclarée : le post s'applique à tout le projet. */
	| { kind: 'all'; locations: T[] }
	/** Cible déclarée et reconnue. */
	| { kind: 'targeted'; locations: T[]; target: string }
	/** Le projet n'a aucune fiche déclarée. Rien à faire, et ce n'est pas une erreur de ciblage. */
	| { kind: 'no_locations' }
	/** Cible déclarée mais inconnue du projet. On ne publie pas. */
	| { kind: 'unresolved'; target: string; known: string[] };

/** `"all"`, `"ALL"`, `""`, `"*"` — toutes les façons de dire « pas de ciblage ». */
const ALL_TOKENS = new Set(['', 'all', '*', 'toutes', 'tous']);

/**
 * Ramène une cible à sa forme comparable : l'identifiant nu, sans préfixe `locations/`.
 *
 * Google écrit `locations/123`, le hub stocke `locations/123`, mais un producteur peut n'avoir
 * que `123`. Comparer les deux formes évite de rejeter une cible juste sur un préfixe absent —
 * sans jamais rendre équivalents deux identifiants réellement différents.
 */
export function normalizeLocationTarget(raw: string): string {
	const trimmed = raw.trim();
	const withoutPrefix = trimmed.startsWith('locations/') ? trimmed.slice('locations/'.length) : trimmed;
	return withoutPrefix.trim().toLowerCase();
}

/**
 * Extrait les cibles déclarées dans le `meta` d'un contenu, quelle qu'en soit la forme.
 *
 * Deux formes acceptées et une seule canonique : `target_location` (chaîne, ce que les skills
 * produisent) fait foi ; `target_locations` (tableau) est lu parce que `resolveTargetLocations`
 * l'interrogeait depuis toujours — le retirer casserait un contenu qui l'utiliserait vraiment.
 * Rendre `[]` signifie « aucune cible », jamais « cible vide ».
 */
export function readLocationTargets(meta: unknown): string[] {
	if (!meta || typeof meta !== 'object') return [];
	const record = meta as Record<string, unknown>;

	const raw: unknown[] = [];
	if (typeof record.target_location === 'string') raw.push(record.target_location);
	if (Array.isArray(record.target_locations)) raw.push(...record.target_locations);

	const targets = raw
		.filter((t): t is string => typeof t === 'string')
		.map((t) => t.trim())
		.filter((t) => t.length > 0);

	// Une seule mention de « toutes » suffit : un post commun ne devient pas ciblé parce qu'une
	// seconde clé traîne. Cibler tout ET une fiche est une contradiction, résolue vers le plus large.
	if (targets.some((t) => ALL_TOKENS.has(t.toLowerCase()))) return [];

	return targets;
}

/**
 * Confronte les cibles déclarées aux fiches réellement déclarées sur le projet.
 *
 * Pure : aucune lecture de base, donc rejouable et testable. `locations` vient de l'appelant.
 */
export function resolveLocationTargets<T extends TargetableLocation>(
	locations: T[],
	meta: unknown
): LocationTargetResolution<T> {
	if (locations.length === 0) return { kind: 'no_locations' };

	const targets = readLocationTargets(meta);
	if (targets.length === 0) return { kind: 'all', locations };

	const wanted = new Set(targets.map(normalizeLocationTarget));
	const matched = locations.filter((loc) => wanted.has(normalizeLocationTarget(loc.gmbLocationId)));

	if (matched.length === 0) {
		return {
			kind: 'unresolved',
			target: targets.join(', '),
			known: locations.map((l) => l.gmbLocationId)
		};
	}

	return { kind: 'targeted', locations: matched, target: targets.join(', ') };
}

/**
 * Le message porté par un refus de publier, destiné à `publish_logs.error_message`.
 *
 * Il NOMME la cible reçue et les fiches connues : sans les deux, l'exploitant lit « ça n'a pas
 * publié » sans pouvoir décider si le tort est au contenu ou à la déclaration des fiches.
 */
export function describeUnresolvedTarget(target: string, known: string[]): string {
	return (
		`Ciblage GMB non résolu : "${target}" ne correspond à aucune fiche du projet. ` +
		`Fiches déclarées : ${known.join(', ') || 'aucune'}. ` +
		`Le hub n'accepte que l'ID Google (locations/…) — un fiche_id de repo doit être ` +
		`converti par /publish-hub via docs/channels/gmb.md avant l'envoi.`
	);
}
