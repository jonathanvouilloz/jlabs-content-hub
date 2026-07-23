import { describe, it, expect } from 'vitest';
import {
	CADENCE_LABEL,
	CAPACITY_STATE_LABEL,
	CLASS_LABEL,
	HOLD_REASON_LABEL,
	OUTCOME_LABEL,
	PROVIDER_LABEL,
	STATUS_LABEL,
	formatDbTime,
	formatDbTimestamp,
	formatDuration,
	formatEpochUtc,
	formatQuota,
	formatRelative,
	formatScheduleSlot,
	parseDbTimestamp
} from './job-format.js';
// Imports RELATIFS : les vocabulaires vivent avec la file (côté serveur), et ce
// test vérifie justement qu'aucun d'eux n'a perdu sa traduction. L'alias `$lib`
// n'est pas résolu hors runtime SvelteKit.
import { ATTEMPT_OUTCOMES } from '../server/job-state.js';
import { ERROR_CLASSES } from '../server/job-retry.js';
import { JOB_STATUSES } from '../server/monitoring-state.js';
import { SCHEDULE_CADENCES } from '../server/schedule-state.js';
import { ADMISSION_HOLD_REASONS, JOB_PROVIDERS } from '../server/job-limits.js';

// ── Formats ─────────────────────────────────────────────────────────

describe('formats des colonnes text', () => {
	it('horodatage DB → date courte, sans reparse', () => {
		expect(formatDbTimestamp('2026-07-22 09:02:11')).toBe('22.07 09:02');
		expect(formatDbTimestamp(null)).toBe('—');
	});

	it('tolère un ISO résiduel plutôt que de rendre illisible', () => {
		expect(formatDbTimestamp('2026-07-22T09:02:11.000Z')).toBe('22.07 09:02');
	});

	it('heure seule pour la chronologie', () => {
		expect(formatDbTime('2026-07-22 09:02:11')).toBe('09:02:11');
		expect(formatDbTime(null)).toBe('…');
	});

	it('durées', () => {
		expect(formatDuration(840)).toBe('840 ms');
		expect(formatDuration(12_000)).toBe('12 s');
		expect(formatDuration(243_000)).toBe('4 min 03 s');
		expect(formatDuration(4_320_000)).toBe('1 h 12 min');
		expect(formatDuration(null)).toBe('—');
		expect(formatDuration(-5)).toBe('—');
	});

	it('parse un horodatage DB comme de l’UTC, jamais comme de l’heure locale', () => {
		expect(parseDbTimestamp('2026-07-22 09:00:00')).toBe(Date.parse('2026-07-22T09:00:00Z'));
		expect(parseDbTimestamp('pas une date')).toBeNull();
		expect(parseDbTimestamp(null)).toBeNull();
	});

	it('écart relatif, avec « now » injecté (donc rejouable)', () => {
		const now = new Date('2026-07-22T09:00:00Z');
		expect(formatRelative('2026-07-22 09:04:00', now)).toBe('dans 4 min 00 s');
		expect(formatRelative('2026-07-22 07:00:00', now)).toBe('il y a 2 h 00 min');
		expect(formatRelative(null, now)).toBe('—');
	});

	it('créneau planifié : jour de semaine + heure LOCALE (jamais reconverti)', () => {
		expect(formatScheduleSlot('2026-07-20T09:00')).toBe('lun 20.07 09:00');
		expect(formatScheduleSlot('2026-10-26T09:00')).toBe('lun 26.10 09:00');
		expect(formatScheduleSlot(null)).toBe('—');
	});
});

// ── Libellés ────────────────────────────────────────────────────────

describe('libellés partagés CLI ↔ console', () => {
	it('chaque issue du journal a un libellé — sinon la console afficherait un mot de machine', () => {
		for (const outcome of ATTEMPT_OUTCOMES) {
			expect(OUTCOME_LABEL[outcome]).toBeTruthy();
		}
	});

	it('chaque classe d’erreur a un libellé', () => {
		for (const c of ERROR_CLASSES) {
			expect(CLASS_LABEL[c]).toBeTruthy();
		}
	});

	it('chaque statut de job a un libellé', () => {
		for (const s of JOB_STATUSES) {
			expect(STATUS_LABEL[s]).toBeTruthy();
		}
	});

	it('chaque cadence de planification a un libellé', () => {
		for (const c of SCHEDULE_CADENCES) {
			expect(CADENCE_LABEL[c]).toBeTruthy();
		}
	});

	it('chaque provider a un libellé (JOB-006)', () => {
		for (const p of JOB_PROVIDERS) {
			expect(PROVIDER_LABEL[p]).toBeTruthy();
		}
	});

	it('chaque cause de retenue a un libellé (JOB-006)', () => {
		for (const r of ADMISSION_HOLD_REASONS) {
			expect(HOLD_REASON_LABEL[r]).toBeTruthy();
		}
	});

	it('chaque état de capacité a un libellé, dont le `quota_limited` de la SPEC §17.1', () => {
		for (const s of ['ok', 'saturated', 'quota_limited']) {
			expect(CAPACITY_STATE_LABEL[s]).toBeTruthy();
		}
	});
});

describe('formatQuota', () => {
	it('rend usage/plafond', () => {
		expect(formatQuota(3, 10)).toBe('3/10');
	});

	it('un plafond à 0 se rend ∞, jamais « /0 »', () => {
		// « 3/0 » se lirait comme une saturation là où il n'y a AUCUNE borne.
		expect(formatQuota(3, 0)).toBe('3/∞');
	});
});

describe('formatEpochUtc', () => {
	it('rend un instant epoch comme les horodatages de la file (UTC)', () => {
		expect(formatEpochUtc(Date.parse('2026-07-22T09:02:11Z'))).toBe(
			formatDbTimestamp('2026-07-22 09:02:11')
		);
	});

	it('null ou non fini → tiret, jamais « Invalid Date »', () => {
		expect(formatEpochUtc(null)).toBe('—');
		expect(formatEpochUtc(Number.NaN)).toBe('—');
	});
});
