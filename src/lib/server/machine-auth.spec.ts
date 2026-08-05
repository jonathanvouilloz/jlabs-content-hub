import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authenticateMachineBearer, parseMachineCredentials } from './machine-auth';
import { createClientToken, clientTokenStorageCandidates, clientTokenStorageValue } from './client-token';

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const now = new Date('2026-08-01T12:00:00.000Z');
const credentials = JSON.stringify([
	{
		id: 'hermes-2026-08',
		tokenHash: hash('new-secret'),
		scopes: ['projects:read', 'projects:write', 'content:read', 'content:write'],
		notBefore: '2026-08-01T00:00:00.000Z',
		expiresAt: '2026-09-01T00:00:00.000Z'
	},
	{
		id: 'hermes-2026-07',
		tokenHash: hash('old-secret'),
		scopes: ['projects:read'],
		expiresAt: '2026-08-03T00:00:00.000Z'
	},
	{
		id: 'revoked',
		tokenHash: hash('revoked-secret'),
		scopes: ['projects:read'],
		revokedAt: '2026-08-01T10:00:00.000Z'
	}
]);

describe('authentification machine', () => {
	it('répond 401 sans bearer ou avec un secret inconnu', () => {
		expect(authenticateMachineBearer(null, 'projects:read', credentials, now)).toMatchObject({ ok: false, status: 401 });
		expect(authenticateMachineBearer('Bearer hermes-2026-08.wrong', 'projects:read', credentials, now)).toMatchObject({ ok: false, status: 401 });
	});

	it('répond 403 quand le credential valide ne porte pas le scope', () => {
		expect(authenticateMachineBearer('Bearer hermes-2026-07.old-secret', 'projects:write', credentials, now)).toMatchObject({ ok: false, status: 403 });
	});

	it('accepte simultanément ancien et nouveau credentials pendant la rotation', () => {
		expect(authenticateMachineBearer('Bearer hermes-2026-07.old-secret', 'projects:read', credentials, now)).toMatchObject({ ok: true, credential: { id: 'hermes-2026-07' } });
		expect(authenticateMachineBearer('Bearer hermes-2026-08.new-secret', 'projects:read', credentials, now)).toMatchObject({ ok: true, credential: { id: 'hermes-2026-08' } });
	});

	it('refuse immédiatement un credential révoqué', () => {
		expect(authenticateMachineBearer('Bearer revoked.revoked-secret', 'projects:read', credentials, now)).toMatchObject({ ok: false, status: 401, code: 'revoked' });
	});

	it('refuse un credential expiré ou pas encore actif', () => {
		expect(authenticateMachineBearer('Bearer hermes-2026-07.old-secret', 'projects:read', credentials, new Date('2026-08-04T00:00:00Z'))).toMatchObject({ ok: false, status: 401, code: 'expired' });
		expect(authenticateMachineBearer('Bearer hermes-2026-08.new-secret', 'projects:read', credentials, new Date('2026-07-31T00:00:00Z'))).toMatchObject({ ok: false, status: 401, code: 'not_active' });
	});

	it('rejette une configuration qui contient un secret en clair', () => {
		expect(() => parseMachineCredentials(JSON.stringify([{ id: 'bad', token: 'plaintext', tokenHash: hash('x'), scopes: ['projects:read'] }]))).toThrow(/clair/i);
	});

	it('ne persiste qu’un hash expirant des nouveaux tokens client', () => {
		const token = createClientToken(now, 30);
		expect(token.raw).toMatch(/^stc_[0-9]+_[a-f0-9]+$/);
		expect(token.stored).toMatch(/^v2:[0-9]+:[a-f0-9]{64}$/);
		expect(token.stored).not.toContain(token.raw);
		expect(clientTokenStorageValue(token.raw, new Date('2026-08-15T00:00:00Z'))).toBe(token.stored);
		expect(clientTokenStorageValue(token.raw, new Date('2026-09-02T00:00:00Z'))).toBeNull();
	});

	it('refuse qu’un vérificateur stocké soit lui-même présenté comme bearer', () => {
		const token = createClientToken(now, 30);
		expect(clientTokenStorageValue(token.stored, now)).toBeNull();
		expect(clientTokenStorageValue(`v1:${hash('legacy-secret')}`, now)).toBeNull();
		expect(clientTokenStorageCandidates(token.stored, now)).toEqual([]);
	});

	it('garde les tokens legacy utilisables avant et après leur backfill hashé', () => {
		const legacy = 'a'.repeat(48);
		expect(clientTokenStorageCandidates(legacy, now)).toEqual([
			`v1:${hash(legacy)}`,
			legacy
		]);
	});
});
