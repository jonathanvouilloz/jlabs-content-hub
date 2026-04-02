import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '$env/dynamic/private';

function getKey(): Buffer {
	const key = env.ENCRYPTION_KEY;
	if (!key) throw new Error('ENCRYPTION_KEY env var is not set');
	return scryptSync(key, 'salt', 32);
}

export function encrypt(plaintext: string): string {
	const key = getKey();
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(encrypted: string): string {
	const key = getKey();
	const [ivHex, authTagHex, ciphertextHex] = encrypted.split(':');
	const iv = Buffer.from(ivHex, 'hex');
	const authTag = Buffer.from(authTagHex, 'hex');
	const ciphertext = Buffer.from(ciphertextHex, 'hex');
	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(authTag);
	return decipher.update(ciphertext) + decipher.final('utf8');
}
