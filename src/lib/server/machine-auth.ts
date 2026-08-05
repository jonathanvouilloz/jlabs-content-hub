import { createHash, timingSafeEqual } from 'node:crypto';

export interface MachineCredential {
	id: string;
	tokenHash: string;
	scopes: string[];
	notBefore?: string;
	expiresAt?: string;
	revokedAt?: string;
}

export type MachineAuthResult =
	| { ok: true; credential: { id: string; scopes: readonly string[] } }
	| { ok: false; status: 401 | 403; code: 'missing' | 'invalid' | 'revoked' | 'expired' | 'not_active' | 'forbidden' | 'misconfigured' };

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function parseMachineCredentials(raw: string | undefined): MachineCredential[] {
	if (!raw) return [];
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error('MACHINE_CREDENTIALS_JSON doit être un tableau JSON valide.');
	}
	if (!Array.isArray(value)) throw new Error('MACHINE_CREDENTIALS_JSON doit être un tableau.');
	const seen = new Set<string>();
	return value.map((entry, index) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Credential machine ${index} invalide.`);
		const row = entry as Record<string, unknown>;
		if ('token' in row || 'secret' in row || 'apiKey' in row) throw new Error(`Credential machine ${index}: aucun secret en clair n'est accepté.`);
		if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.id)) throw new Error(`Credential machine ${index}: id invalide.`);
		if (seen.has(row.id)) throw new Error(`Credential machine dupliqué: ${row.id}.`);
		seen.add(row.id);
		if (typeof row.tokenHash !== 'string' || !SHA256_HEX.test(row.tokenHash)) throw new Error(`Credential machine ${row.id}: tokenHash SHA-256 hex requis.`);
		if (!Array.isArray(row.scopes) || row.scopes.length === 0 || !row.scopes.every((scope) => typeof scope === 'string' && scope.length > 0)) throw new Error(`Credential machine ${row.id}: scopes non vides requis.`);
		for (const field of ['notBefore', 'expiresAt', 'revokedAt'] as const) {
			if (row[field] !== undefined && (typeof row[field] !== 'string' || Number.isNaN(Date.parse(row[field] as string)))) throw new Error(`Credential machine ${row.id}: ${field} invalide.`);
		}
		return {
			id: row.id,
			tokenHash: row.tokenHash,
			scopes: [...new Set(row.scopes as string[])],
			notBefore: row.notBefore as string | undefined,
			expiresAt: row.expiresAt as string | undefined,
			revokedAt: row.revokedAt as string | undefined
		};
	});
}

function hashesEqual(actual: string, expectedHex: string): boolean {
	const actualHash = createHash('sha256').update(actual).digest();
	const expected = Buffer.from(expectedHex, 'hex');
	return actualHash.length === expected.length && timingSafeEqual(actualHash, expected);
}

export function authenticateMachineBearer(
	authorization: string | null,
	requiredScope: string,
	rawCredentials: string | undefined,
	now = new Date()
): MachineAuthResult {
	if (!authorization?.startsWith('Bearer ')) return { ok: false, status: 401, code: 'missing' };
	let credentials: MachineCredential[];
	try {
		credentials = parseMachineCredentials(rawCredentials);
	} catch {
		return { ok: false, status: 401, code: 'misconfigured' };
	}
	const bearer = authorization.slice(7);
	const separator = bearer.indexOf('.');
	if (separator <= 0 || separator === bearer.length - 1) return { ok: false, status: 401, code: 'invalid' };
	const id = bearer.slice(0, separator);
	const secret = bearer.slice(separator + 1);
	const credential = credentials.find((candidate) => candidate.id === id);
	if (!credential || !hashesEqual(secret, credential.tokenHash)) return { ok: false, status: 401, code: 'invalid' };
	const at = now.getTime();
	if (credential.revokedAt && Date.parse(credential.revokedAt) <= at) return { ok: false, status: 401, code: 'revoked' };
	if (credential.notBefore && Date.parse(credential.notBefore) > at) return { ok: false, status: 401, code: 'not_active' };
	if (credential.expiresAt && Date.parse(credential.expiresAt) <= at) return { ok: false, status: 401, code: 'expired' };
	if (!credential.scopes.includes(requiredScope) && !credential.scopes.includes('*')) return { ok: false, status: 403, code: 'forbidden' };
	return { ok: true, credential: { id: credential.id, scopes: credential.scopes } };
}
