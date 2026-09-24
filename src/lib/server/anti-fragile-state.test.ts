import { describe, it, expect } from 'vitest';
import {
	INSPECTION_TIMEOUT_CODES,
	MIN_INSPECTION_BUDGET,
	RECURRENT_TIMEOUT_DEFAULTS,
	TIGHTENING_MULTIPLIER,
	computeTightenedBudget,
	detectRecurrentTimeout,
	isInspectionTimeoutCode,
	type TimeoutWeek
} from './anti-fragile-state.js';

const week = (weekStart: string, timedOut = false): TimeoutWeek => ({ weekStart, timedOut });

// ── Vocabulaire des codes ───────────────────────────────────────────

describe('isInspectionTimeoutCode', () => {
	it('reconnaît les deux codes de timeout', () => {
		expect(INSPECTION_TIMEOUT_CODES).toEqual(['ProviderTimeout', 'WorkerDied']);
		for (const code of INSPECTION_TIMEOUT_CODES) {
			expect(isInspectionTimeoutCode(code)).toBe(true);
		}
	});

	it('rejette tout le reste, y compris null', () => {
		for (const code of [null, undefined, '', 'quota', 'invalid_grant', 'ok']) {
			expect(isInspectionTimeoutCode(code)).toBe(false);
		}
	});
});

// ── Volet B — Détection ─────────────────────────────────────────────

describe('detectRecurrentTimeout', () => {
	it('ne juge pas récurrent un projet stable', () => {
		const v = detectRecurrentTimeout({
			weeks: [week('2026-07-27'), week('2026-08-03'), week('2026-08-10')]
		});
		expect(v.recurrent).toBe(false);
		expect(v.timedOutWeeks).toBe(0);
		expect(v.totalWeeks).toBe(3);
		expect(v.note).toContain('sous le seuil');
	});

	it('juge récurrent un projet avec timeout sur la majorité de la fenêtre', () => {
		// Le profil de wildcat/barbermedia au 10/08 : mauvais jour Google répété.
		const v = detectRecurrentTimeout({
			weeks: [week('2026-07-27'), week('2026-08-03', true), week('2026-08-10', true)]
		});
		expect(v.recurrent).toBe(true);
		expect(v.timedOutWeeks).toBe(2);
		expect(v.note).toContain('seuil 2');
	});

	it('un seul timeout sur la fenêtre ne suffit pas', () => {
		// cardrank le 03/08 : un WorkerDied isolé n'est pas un schéma récurrent.
		const v = detectRecurrentTimeout({
			weeks: [week('2026-07-27'), week('2026-08-03', true), week('2026-08-10')]
		});
		expect(v.recurrent).toBe(false);
	});

	it('ne regarde que les N dernières semaines de la fenêtre', () => {
		const v = detectRecurrentTimeout({
			weeks: [week('2026-07-20', true), week('2026-07-27'), week('2026-08-03'), week('2026-08-10')],
			windowWeeks: 3
		});
		// La semaine du 20/07 sort de la fenêtre de 3 : le timeout n'y compte plus.
		expect(v.totalWeeks).toBe(3);
		expect(v.timedOutWeeks).toBe(0);
	});

	it('respecte le seuil et la fenêtre par défaut', () => {
		expect(RECURRENT_TIMEOUT_DEFAULTS).toEqual({ windowWeeks: 3, timeoutThreshold: 2 });
	});
});

// ── Volet C — Resserrement du budget ────────────────────────────────

describe('computeTightenedBudget', () => {
	it('un projet stable garde son budget de base', () => {
		const b = computeTightenedBudget({ baseBudget: 40, recurrent: false });
		expect(b.effectiveBudget).toBe(40);
		expect(b.tightened).toBe(false);
		expect(b.multiplier).toBe(1);
	});

	it('un projet à timeouts récurrents voit son budget resserré de moitié', () => {
		const b = computeTightenedBudget({ baseBudget: 40, recurrent: true });
		expect(b.tightened).toBe(true);
		expect(b.effectiveBudget).toBe(20);
		expect(b.multiplier).toBe(TIGHTENING_MULTIPLIER);
		expect(b.note).toContain('resserré');
	});

	it('ne descend jamais sous la borne basse', () => {
		// Base 8, resserré à 4 → plancher 5 : on garde 5, pas 4.
		const b = computeTightenedBudget({ baseBudget: 8, recurrent: true });
		expect(b.effectiveBudget).toBe(MIN_INSPECTION_BUDGET);
		expect(b.tightened).toBe(true);
	});

	it('un budget déjà au plancher ne se resserre pas davantage', () => {
		const b = computeTightenedBudget({ baseBudget: MIN_INSPECTION_BUDGET, recurrent: true });
		expect(b.effectiveBudget).toBe(MIN_INSPECTION_BUDGET);
		expect(b.tightened).toBe(false);
	});

	it('est automatiquement réversible quand le projet redevient stable', () => {
		// La vertu anti-fragile : pas de geste d'écriture, le resserrement est dérivé du verdict.
		const tight = computeTightenedBudget({ baseBudget: 40, recurrent: true });
		const loose = computeTightenedBudget({ baseBudget: 40, recurrent: false });
		expect(tight.effectiveBudget).toBeLessThan(loose.effectiveBudget);
		expect(loose.effectiveBudget).toBe(40);
	});
});
