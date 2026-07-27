import { describe, it, expect } from 'vitest';
import { dbTimestampToMs, toDbTimestamp, toDbTimestampPlus } from './timestamps.js';

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

describe('dbTimestampToMs (REP-003 — durées sur des valeurs relues)', () => {
	it('est l’inverse exact de toDbTimestamp', () => {
		const ms = Date.parse('2026-07-27T07:00:00Z');
		expect(dbTimestampToMs(toDbTimestamp(new Date(ms)))).toBe(ms);
	});

	it('⭐ lit la valeur en UTC, pas en heure locale', () => {
		// Le `Z` explicite est tout le sujet : sans lui, ECMA-262 parse en heure LOCALE, donc
		// à Zurich la même chaîne rendrait un instant décalé d'une à deux heures selon la
		// saison — l'ordre de grandeur exact du SLO d'une heure de REP-003.
		expect(dbTimestampToMs('2026-07-27 07:00:00')).toBe(Date.parse('2026-07-27T07:00:00Z'));
		expect(dbTimestampToMs('2026-01-19 08:00:00')).toBe(Date.parse('2026-01-19T08:00:00Z'));
	});

	it('une différence de 60 minutes reste 60 minutes des deux côtés du DST', () => {
		const summer =
			dbTimestampToMs('2026-07-27 08:00:00') - dbTimestampToMs('2026-07-27 07:00:00');
		const winter =
			dbTimestampToMs('2026-01-19 09:00:00') - dbTimestampToMs('2026-01-19 08:00:00');
		expect(summer).toBe(3_600_000);
		expect(winter).toBe(3_600_000);
	});

	it('rend NaN sur une valeur illisible (jamais une date inventée)', () => {
		expect(Number.isNaN(dbTimestampToMs('pas une date'))).toBe(true);
	});
});
