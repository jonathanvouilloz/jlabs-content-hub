import { describe, it, expect } from 'vitest';
import { toDbTimestamp, toDbTimestampPlus } from './timestamps.js';

describe('toDbTimestamp (format des defaults SQL)', () => {
	it('produit exactement `YYYY-MM-DD HH:MM:SS` en UTC', () => {
		expect(toDbTimestamp(new Date('2026-07-22T09:30:15.482Z'))).toBe('2026-07-22 09:30:15');
	});

	it('accepte une chaîne ISO', () => {
		expect(toDbTimestamp('2026-01-02T03:04:05Z')).toBe('2026-01-02 03:04:05');
	});

	it('rejette une date invalide plutôt que d’écrire "Invalid Date"', () => {
		expect(() => toDbTimestamp('pas-une-date')).toThrow(/invalide/);
	});

	it('reste comparable LEXICALEMENT au format du default SQL', () => {
		// Le piège : en ISO, 'T' (0x54) > ' ' (0x20) → un horodatage ISO du matin
		// paraîtrait POSTÉRIEUR à un horodatage DB du soir, le même jour.
		const isoMorning = new Date('2026-07-22T09:00:00Z').toISOString();
		const dbEvening = '2026-07-22 23:00:00';
		expect(isoMorning > dbEvening).toBe(true); // le bug qu'on évite
		expect(toDbTimestamp('2026-07-22T09:00:00Z') < dbEvening).toBe(true); // le comportement correct
	});

	it('tri chronologique = tri lexicographique', () => {
		const stamps = [
			toDbTimestamp('2026-07-22T23:00:00Z'),
			toDbTimestamp('2026-07-22T09:00:00Z'),
			toDbTimestamp('2026-07-23T00:00:00Z')
		];
		expect([...stamps].sort()).toEqual([
			'2026-07-22 09:00:00',
			'2026-07-22 23:00:00',
			'2026-07-23 00:00:00'
		]);
	});
});

describe('toDbTimestampPlus (backoff, bail)', () => {
	it('décale du nombre de millisecondes demandé', () => {
		expect(toDbTimestampPlus(90_000, '2026-07-22T09:00:00Z')).toBe('2026-07-22 09:01:30');
	});

	it('un décalage négatif ramène en arrière', () => {
		expect(toDbTimestampPlus(-60_000, '2026-07-22T09:00:00Z')).toBe('2026-07-22 08:59:00');
	});

	it('rejette une base invalide', () => {
		expect(() => toDbTimestampPlus(1000, 'nope')).toThrow(/invalide/);
	});
});
