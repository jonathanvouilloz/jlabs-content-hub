/**
 * GSC-001 — Chiffrement symétrique, sans runtime.
 *
 * Module PUR (zéro import `$env`, zéro db) : la clé est un PARAMÈTRE, pas une
 * lecture d'environnement. `crypto.ts` en reste l'entrée applicative (il lit
 * `env.ENCRYPTION_KEY` et délègue ici) ; ses appelants ne changent pas.
 *
 * Pourquoi cette scission. `crypto.ts` importe `$env/dynamic/private` de façon
 * STATIQUE, donc tout module qui déchiffre un service account devient
 * inchargeable hors runtime SvelteKit — et aucune preuve sur Neon n'est alors
 * possible. C'est le second blocage rencontré en AGT-000 (`proposals.ts` /
 * `policies.ts` importaient `db` statiquement), à l'identique : la correction est
 * la même, on rend la dépendance injectable au lieu de la subir.
 *
 * Format inchangé — `iv:authTag:ciphertext` en hexadécimal, AES-256-GCM, clé
 * dérivée par scrypt avec le sel historique `'salt'`. Toute modification de la
 * dérivation rendrait ILLISIBLES les secrets déjà en base (6 service accounts,
 * les jetons GMB et LinkedIn) : ce module reproduit l'existant au bit près.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Sel historique de la dérivation. Constant et non paramétrable À DESSEIN : le
 * rendre configurable inviterait à en changer, ce qui condamnerait les secrets
 * déjà chiffrés. Une rotation de clé est une migration, pas une option.
 */
const SCRYPT_SALT = 'salt';

function deriveKey(secret: string): Buffer {
	if (!secret) throw new Error('Clé de chiffrement absente.');
	return scryptSync(secret, SCRYPT_SALT, 32);
}

/** Chiffre `plaintext` avec `secret`. Rend `iv:authTag:ciphertext` (hex). */
export function encryptWith(secret: string, plaintext: string): string {
	const key = deriveKey(secret);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Déchiffre une valeur produite par `encryptWith`.
 *
 * Une entrée malformée lève une erreur NOMMÉE plutôt que de laisser remonter un
 * `TypeError` de `Buffer.from(undefined)` : ce module manipule des secrets, et un
 * message d'erreur ne doit jamais donner à voir ce qu'il a tenté de lire.
 */
export function decryptWith(secret: string, encrypted: string): string {
	const key = deriveKey(secret);
	const parts = encrypted.split(':');
	if (parts.length !== 3) {
		throw new Error('Valeur chiffrée malformée (attendu iv:authTag:ciphertext).');
	}
	const [ivHex, authTagHex, ciphertextHex] = parts;
	const iv = Buffer.from(ivHex, 'hex');
	const authTag = Buffer.from(authTagHex, 'hex');
	const ciphertext = Buffer.from(ciphertextHex, 'hex');
	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(authTag);
	return decipher.update(ciphertext) + decipher.final('utf8');
}
