import { createHash, randomBytes } from 'node:crypto';

const RAW_TOKEN = /^stc_([0-9]+)_([a-f0-9]{48})$/;
const STORED_TOKEN = /^v[12]:/;
const LEGACY_RAW_TOKEN = /^[a-f0-9]{48}$/;

function hash(raw: string): string {
	return createHash('sha256').update(raw).digest('hex');
}

export function createClientToken(now = new Date(), ttlDays = 90): { raw: string; stored: string; expiresAt: Date } {
	const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
	const expiresEpoch = Math.floor(expiresAt.getTime() / 1000);
	const raw = `stc_${expiresEpoch}_${randomBytes(24).toString('hex')}`;
	return { raw, stored: `v2:${expiresEpoch}:${hash(raw)}`, expiresAt };
}

/**
 * Dérive la valeur cherchée en base sans jamais persister le bearer brut.
 * Les anciens tokens restent lisibles pendant la transition ; tout token v2 est
 * hashé, expire à la date embarquée et est révoqué dès que sa valeur stockée est remplacée.
 */
export function clientTokenStorageValue(raw: string, now = new Date()): string | null {
	if (STORED_TOKEN.test(raw)) return null;
	const match = RAW_TOKEN.exec(raw);
	if (!match) return LEGACY_RAW_TOKEN.test(raw) ? `v1:${hash(raw)}` : null;
	const expiresEpoch = Number(match[1]);
	if (!Number.isSafeInteger(expiresEpoch) || expiresEpoch * 1000 <= now.getTime()) return null;
	return `v2:${expiresEpoch}:${hash(raw)}`;
}

/**
 * Candidats de lecture pendant la transition additive : un ancien bearer hex peut
 * correspondre soit à une ligne déjà backfillée (`v1:`), soit à une ligne brute
 * pas encore migrée. Les vérificateurs `v1:`/`v2:` ne sont jamais des bearers.
 */
export function clientTokenStorageCandidates(raw: string, now = new Date()): string[] {
	if (STORED_TOKEN.test(raw)) return [];
	if (LEGACY_RAW_TOKEN.test(raw)) return [`v1:${hash(raw)}`, raw];
	const stored = clientTokenStorageValue(raw, now);
	return stored ? [stored] : [];
}
