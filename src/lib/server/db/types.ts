/**
 * Type du client drizzle, isolé de `db/index.ts`.
 *
 * `db/index.ts` lit `$env/dynamic/private` au chargement : il n'est donc PAS
 * importable depuis un script `tsx` (hors runtime SvelteKit). Ce module ne contient
 * qu'un type (effacé à la compilation) et n'importe que le schéma, lui-même pur.
 * Il permet aux modules serveur d'accepter un client INJECTÉ — la même logique
 * d'écriture sert alors l'app (client `db`) et les runners `scripts/` (client Pool
 * autonome), sans dupliquer une seule requête.
 */
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import type * as schema from './schema.js';

export type AppDb = NeonDatabase<typeof schema>;
