import { describe, expect, it } from 'vitest';
import { decryptWith, encryptWith } from './crypto-core.js';

const KEY = 'clé-de-test-suffisamment-longue';

describe('crypto-core', () => {
	it('rend le clair après un aller-retour', () => {
		const secret = JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com' });
		expect(decryptWith(KEY, encryptWith(KEY, secret))).toBe(secret);
	});

	it('produit un IV neuf à chaque chiffrement du même clair', () => {
		// Deux chiffrés identiques trahiraient un IV constant — la faute classique
		// en GCM, où réutiliser un IV avec la même clé casse la confidentialité.
		const a = encryptWith(KEY, 'x');
		const b = encryptWith(KEY, 'x');
		expect(a).not.toBe(b);
		expect(decryptWith(KEY, a)).toBe('x');
		expect(decryptWith(KEY, b)).toBe('x');
	});

	it('respecte le format iv:authTag:ciphertext en hexadécimal', () => {
		// Le format est un CONTRAT avec les secrets déjà en base : le changer les
		// rendrait illisibles.
		const parts = encryptWith(KEY, 'x').split(':');
		expect(parts).toHaveLength(3);
		for (const p of parts) expect(p).toMatch(/^[0-9a-f]+$/);
	});

	it('refuse de déchiffrer avec une autre clé', () => {
		const enc = encryptWith(KEY, 'secret');
		expect(() => decryptWith('une-autre-clé', enc)).toThrow();
	});

	it('refuse une valeur malformée avec une erreur nommée', () => {
		expect(() => decryptWith(KEY, 'pas-un-chiffré')).toThrow(/malformée/i);
	});

	it("refuse une clé vide plutôt que d'en dériver une", () => {
		expect(() => encryptWith('', 'x')).toThrow(/clé de chiffrement absente/i);
	});

	it('détecte un authTag altéré (intégrité GCM)', () => {
		const [iv, tag, ct] = encryptWith(KEY, 'secret').split(':');
		const flipped = tag.slice(0, -1) + (tag.endsWith('0') ? '1' : '0');
		expect(() => decryptWith(KEY, `${iv}:${flipped}:${ct}`)).toThrow();
	});
});
