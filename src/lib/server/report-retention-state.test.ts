/**
 * REP-004 lot 2 — les invariants de la rétention du détail.
 *
 * Chaque bloc porte une CONTRE-ÉPREUVE : ce qui distingue l'état correct de l'état voisin qu'on
 * aurait écrit sans y penser. Ici la paire à ne jamais confondre est **« vieux » et
 * « jetable »** — un rapport ne se régénère pas, donc l'âge seul n'autorise rien : il faut que
 * le détail existe ailleurs.
 */
import { describe, expect, it } from 'vitest';
import { dbTimestampToMs } from './timestamps.js';
import {
	archiveFileName,
	deriveDetailState,
	describeDetailState,
	MIN_DETAIL_RETENTION_WEEKS,
	parseArchiveFileName,
	planDetailPurge,
	resolveDetailRetentionWeeks,
	type DetailColumns,
	type RetentionCandidate
} from './report-retention-state.js';

const NOW = Date.parse('2026-07-27T08:00:00Z');
const WEEK = 7 * 86_400_000;

function columns(over: Partial<DetailColumns> = {}): DetailColumns {
	return {
		hasPayload: true,
		payloadBytes: 28_000,
		payloadDigest: 'a'.repeat(64),
		payloadArchivedAt: null,
		payloadArchiveRef: null,
		payloadPurgedAt: null,
		...over
	};
}

function candidate(over: Partial<RetentionCandidate> = {}): RetentionCandidate {
	return {
		id: 'r1',
		periodSlot: '2026-01-05T09:00',
		revision: 1,
		slotAt: '2026-01-05 08:00:00',
		detail: { kind: 'stored', bytes: 28_000 },
		...over
	};
}

const plan = (candidates: RetentionCandidate[], retentionWeeks: number | null) =>
	planDetailPurge({
		candidates,
		retentionWeeks,
		nowMs: NOW,
		parseMs: dbTimestampToMs
	});

// ════════════════════════════════════════════════════════════════════

describe('resolveDetailRetentionWeeks — le pire cas d’une valeur illisible est « on garde »', () => {
	it('rend null (conserver sans limite) sur une clé absente ou vide', () => {
		expect(resolveDetailRetentionWeeks(null)).toBeNull();
		expect(resolveDetailRetentionWeeks(undefined)).toBeNull();
		expect(resolveDetailRetentionWeeks('')).toBeNull();
	});

	it('accepte un nombre nu comme un objet {weeks}', () => {
		expect(resolveDetailRetentionWeeks('52')).toBe(52);
		expect(resolveDetailRetentionWeeks('{"weeks":52}')).toBe(52);
	});

	it('CONTRE-ÉPREUVE : une valeur corrompue ne devient JAMAIS une fenêtre courte', () => {
		// Le sens de la panne est décidé ici : une valeur illisible qui vaudrait « 4 semaines »
		// purgerait sur un malentendu, et un rapport purgé ne revient pas.
		expect(resolveDetailRetentionWeeks('n’importe quoi')).toBeNull();
		expect(resolveDetailRetentionWeeks('{"weeks":"beaucoup"}')).toBeNull();
		expect(resolveDetailRetentionWeeks('{"weeks":null}')).toBeNull();
		expect(resolveDetailRetentionWeeks('-12')).toBeNull();
		expect(resolveDetailRetentionWeeks('0')).toBeNull();
	});

	it('remonte au plancher plutôt que de laisser purger le rapport de la semaine dernière', () => {
		expect(resolveDetailRetentionWeeks('1')).toBe(MIN_DETAIL_RETENTION_WEEKS);
		expect(resolveDetailRetentionWeeks('{"weeks":2}')).toBe(MIN_DETAIL_RETENTION_WEEKS);
		expect(MIN_DETAIL_RETENTION_WEEKS).toBeGreaterThanOrEqual(4);
	});
});

describe('deriveDetailState — trois états, jamais trois booléens', () => {
	it('distingue « en base », « en base et archivé », « purgé »', () => {
		expect(deriveDetailState(columns()).kind).toBe('stored');
		expect(
			deriveDetailState(
				columns({
					payloadArchivedAt: '2026-07-01 09:00:00',
					payloadArchiveRef: '00-Inbox/x.md'
				})
			).kind
		).toBe('archived');
		expect(
			deriveDetailState(
				columns({
					hasPayload: false,
					payloadArchivedAt: '2026-07-01 09:00:00',
					payloadArchiveRef: '00-Inbox/x.md',
					payloadPurgedAt: '2026-07-02 09:00:00'
				})
			).kind
		).toBe('purged');
	});

	it('CONTRE-ÉPREUVE : une ligne sans payload n’est jamais « stored », même sans archive', () => {
		// Cet état est interdit en base (CHECK). S'il existait quand même, le lire « stored »
		// ferait croire que le détail est là et ferait échouer sa lecture plus loin.
		const state = deriveDetailState(
			columns({
				hasPayload: false,
				payloadArchivedAt: null,
				payloadArchiveRef: null
			})
		);
		expect(state.kind).toBe('purged');
	});

	it('ne commente pas le cas nominal autrement que par un fait', () => {
		expect(describeDetailState({ kind: 'stored', bytes: null })).toContain('conservé en base');
	});
});

describe('planDetailPurge — l’âge n’autorise rien, l’archive autorise', () => {
	it('⭐ retient un détail TRÈS vieux mais jamais archivé', () => {
		// Le cœur du lot : un rapport ne se régénère pas (REP-003 l'a construit sur l'état du parc
		// de ce créneau-là). Purger sans archive n'est pas une rétention, c'est une perte.
		const p = plan([candidate({ slotAt: '2020-01-06 08:00:00' })], 4);
		expect(p.purge).toHaveLength(0);
		expect(p.hold[0].reason).toBe('not_archived');
		expect(p.hold[0].ageDays).toBeGreaterThan(2000);
	});

	it('purge un détail vieux ET archivé', () => {
		const p = plan(
			[
				candidate({
					slotAt: '2020-01-06 08:00:00',
					detail: {
						kind: 'archived',
						bytes: 28_000,
						archivedAt: '2026-07-01 09:00:00',
						archiveRef: '00-Inbox/2020-01-06-_global-weekly-report.md'
					}
				})
			],
			4
		);
		expect(p.purge).toHaveLength(1);
		expect(p.hold).toHaveLength(0);
		expect(p.bytes).toBe(28_000);
		expect(p.bytesKnown).toBe(true);
	});

	it('CONTRE-ÉPREUVE : archivé mais DANS la fenêtre → conservé', () => {
		const recent = new Date(NOW - 2 * WEEK).toISOString().slice(0, 19).replace('T', ' ');
		const p = plan(
			[
				candidate({
					slotAt: recent,
					detail: {
						kind: 'archived',
						bytes: 1,
						archivedAt: '2026-07-20 09:00:00',
						archiveRef: '00-Inbox/x.md'
					}
				})
			],
			4
		);
		expect(p.purge).toHaveLength(0);
		expect(p.hold[0].reason).toBe('within_retention');
	});

	it('rétention désactivée : rien n’est purgeable, et la phrase le dit sans chiffrer', () => {
		const p = plan([candidate({ slotAt: '2020-01-06 08:00:00' })], null);
		expect(p.purge).toHaveLength(0);
		expect(p.hold[0].reason).toBe('retention_disabled');
		expect(p.retentionWeeks).toBeNull();
		expect(p.cutoffMs).toBeNull();
		expect(p.headline).toContain('désactivée');
	});

	it('une ligne déjà purgée n’est pas « du travail à faire »', () => {
		const p = plan(
			[
				candidate({
					slotAt: '2020-01-06 08:00:00',
					detail: {
						kind: 'purged',
						bytes: 28_000,
						archivedAt: '2026-07-01 09:00:00',
						archiveRef: '00-Inbox/x.md',
						purgedAt: '2026-07-02 09:00:00',
						digest: 'b'.repeat(64)
					}
				})
			],
			4
		);
		expect(p.purge).toHaveLength(0);
		expect(p.hold[0].reason).toBe('already_purged');
	});

	it('⚠️ un créneau ILLISIBLE est conservé, avec un âge null (jamais 0)', () => {
		const p = plan(
			[
				candidate({
					slotAt: 'pas une date',
					detail: {
						kind: 'archived',
						bytes: 10,
						archivedAt: '2026-07-01 09:00:00',
						archiveRef: '00-Inbox/x.md'
					}
				})
			],
			4
		);
		expect(p.purge).toHaveLength(0);
		expect(p.hold[0].reason).toBe('within_retention');
		expect(p.hold[0].ageDays).toBeNull();
	});

	it('le total d’octets libérables est une BORNE INFÉRIEURE quand une taille manque', () => {
		const archived = (bytes: number | null) =>
			candidate({
				id: `id-${bytes}`,
				slotAt: '2020-01-06 08:00:00',
				detail: {
					kind: 'archived',
					bytes,
					archivedAt: '2026-07-01 09:00:00',
					archiveRef: '00-Inbox/x.md'
				}
			});
		const p = plan([archived(1000), archived(null)], 4);
		expect(p.purge).toHaveLength(2);
		expect(p.bytes).toBe(1000);
		expect(p.bytesKnown).toBe(false);
		expect(p.headline).toContain('au moins');
	});

	it('chaque RÉVISION se décide seule : archiver l’une ne couvre pas l’autre', () => {
		const p = plan(
			[
				candidate({
					id: 'rev1',
					revision: 1,
					slotAt: '2020-01-06 08:00:00',
					detail: {
						kind: 'archived',
						bytes: 10,
						archivedAt: '2026-07-01 09:00:00',
						archiveRef: '00-Inbox/x-r1.md'
					}
				}),
				candidate({ id: 'rev2', revision: 2, slotAt: '2020-01-06 08:00:00' })
			],
			4
		);
		expect(p.purge.map((e) => e.id)).toEqual(['rev1']);
		expect(p.hold.map((h) => h.reason)).toEqual(['not_archived']);
	});
});

describe('archiveFileName — un nom de fichier n’a pas le droit de porter un « : »', () => {
	it('encode le créneau sans deux-points et se relit', () => {
		const name = archiveFileName('2026-07-27T09:00', 3);
		expect(name).toBe('weekly-report-2026-07-27-0900-r3.json');
		expect(name).not.toContain(':');
		expect(parseArchiveFileName(name)).toEqual({
			periodSlot: '2026-07-27T09:00',
			revision: 3
		});
	});

	it('CONTRE-ÉPREUVE : un nom hors convention n’est pas deviné', () => {
		expect(parseArchiveFileName('weekly-report.json')).toBeNull();
		expect(parseArchiveFileName('gsc-example-30d.json')).toBeNull();
	});
});
