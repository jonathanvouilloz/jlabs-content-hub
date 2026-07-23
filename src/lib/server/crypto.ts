/**
 * Entrée applicative du chiffrement : lit `ENCRYPTION_KEY` et délègue à
 * `crypto-core.ts` (pur, clé en paramètre).
 *
 * La logique vit dans le core pour rester chargeable hors runtime SvelteKit —
 * sans quoi aucun module qui déchiffre un service account ne serait prouvable sur
 * Neon (cf. l'en-tête de `crypto-core.ts`). Ce fichier ne fait que fournir la clé.
 */
import { env } from '$env/dynamic/private';
import { decryptWith, encryptWith } from './crypto-core.js';

function getSecret(): string {
	const key = env.ENCRYPTION_KEY;
	if (!key) throw new Error('ENCRYPTION_KEY env var is not set');
	return key;
}

export function encrypt(plaintext: string): string {
	return encryptWith(getSecret(), plaintext);
}

export function decrypt(encrypted: string): string {
	return decryptWith(getSecret(), encrypted);
}
