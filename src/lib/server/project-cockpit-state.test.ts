import { describe, it, expect } from 'vitest';
import {
	buildPanel,
	buildTimeline,
	derivePanelState,
	makePeriod,
	periodLabel,
	rankPanels,
	summarizeIndexation,
	type PanelIntegration,
	type TimelineEntry
} from './project-cockpit-state.js';
import { deriveFreshness, type Freshness } from './home-state.js';

const NOW = new Date('2026-07-25T12:00:00Z');
const STALE_AFTER = 24 * 10;

function fresh(lastSuccessAt: string | null): Freshness {
	return deriveFreshness({ lastSuccessAt, now: NOW, staleAfterHours: STALE_AFTER });
}

function integration(over: Partial<PanelIntegration> = {}): PanelIntegration {
	return {
		provider: 'gsc',
		enabled: true,
		status: 'active',
		healthStatus: 'healthy',
		lastErrorCode: null,
		lastSuccessAt: '2026-07-24 09:00:00',
		...over
	};
}

// ── Acceptation 2 : « un provider désactivé n'est pas une erreur » ──

describe('derivePanelState — « non branché » n’est PAS « cassé »', () => {
	it('désactivé ⇒ inactive, même avec une erreur en mémoire', () => {
		// Une intégration éteinte peut garder le `last_error_code` d'il y a trois mois.
		// L'afficher en rouge reprocherait une panne que l'utilisateur a lui-même débranchée.
		const v = derivePanelState({
			integration: integration({ enabled: false, status: 'error', lastErrorCode: 'invalid_grant' }),
			freshness: fresh(null),
			hasData: false,
			label: 'Search Console'
		});
		expect(v.state).toBe('inactive');
		expect(v.note).toMatch(/non branché/);
	});

	it('aucune intégration ET aucune donnée ⇒ inactive', () => {
		expect(
			derivePanelState({ integration: null, freshness: fresh(null), hasData: false, label: 'X' }).state
		).toBe('inactive');
	});

	it('aucune intégration MAIS des observations ⇒ jamais inactive', () => {
		// Un projet peut collecter sans ligne `project_integrations` (compte de service
		// partagé, flux hérité). Annoncer « non branché » alors que la table déborde
		// d'observations serait un mensonge vérifiable sur l'écran d'à côté.
		const v = derivePanelState({
			integration: null,
			freshness: fresh('2026-07-24 09:00:00'),
			hasData: true,
			label: 'X'
		});
		expect(v.state).toBe('ok');
	});

	it('activée et en erreur / révoquée / down ⇒ broken, avec le code', () => {
		const err = derivePanelState({
			integration: integration({ status: 'error', lastErrorCode: 'quota' }),
			freshness: fresh('2026-07-24 09:00:00'),
			hasData: true,
			label: 'X'
		});
		expect(err.state).toBe('broken');
		expect(err.note).toContain('quota');

		for (const over of [{ status: 'revoked' }, { healthStatus: 'down' }]) {
			expect(
				derivePanelState({
					integration: integration(over),
					freshness: fresh('2026-07-24 09:00:00'),
					hasData: true,
					label: 'X'
				}).state
			).toBe('broken');
		}
	});

	it('branché mais jamais collecté ⇒ never, distinct de stale', () => {
		// Brancher et réparer ne sont pas le même geste : les deux états restent séparés.
		expect(
			derivePanelState({ integration: integration({ lastSuccessAt: null }), freshness: fresh(null), hasData: false, label: 'X' })
				.state
		).toBe('never');
		expect(
			derivePanelState({
				integration: integration(),
				freshness: fresh('2026-06-01 09:00:00'),
				hasData: true,
				label: 'X'
			}).state
		).toBe('stale');
	});

	it('un domaine INTERNE ne peut pas être « non branché »', () => {
		// Le diagnostic relit des observations déjà payées : il n'a pas de credential. Lui
		// répondre « non branché » enverrait vers une page de réglages qui ne propose rien.
		const v = derivePanelState({
			integration: null,
			external: false,
			freshness: fresh(null),
			hasData: false,
			label: 'Diagnostic'
		});
		expect(v.state).toBe('never');
		expect(v.note).not.toMatch(/branch/);
	});

	it('dégradée mais qui collecte ⇒ ok, et on le DIT', () => {
		const v = derivePanelState({
			integration: integration({ healthStatus: 'degraded' }),
			freshness: fresh('2026-07-24 09:00:00'),
			hasData: true,
			label: 'X'
		});
		expect(v.state).toBe('ok');
		expect(v.note).toMatch(/dégradée/);
	});
});

describe('rankPanels — ce qui demande un geste en tête, `inactive` en dernier', () => {
	it('trie broken → stale → never → ok → inactive', () => {
		const mk = (key: string, state: string) =>
			buildPanel({
				key,
				label: key,
				verdict: { state: state as never, note: '' },
				provenance: { period: null, freshness: fresh(null), source: 't' }
			});
		const order = rankPanels([
			mk('a', 'inactive'),
			mk('b', 'ok'),
			mk('c', 'broken'),
			mk('d', 'never'),
			mk('e', 'stale')
		]).map((p) => p.key);
		// `inactive` APRÈS `ok` : un flux qu'on n'a pas branché ne demande aucun geste.
		expect(order).toEqual(['c', 'e', 'd', 'b', 'a']);
	});
});

// ── Acceptation 1 : période, fraîcheur, source ──────────────────────

describe('ProvenanceTrio — un panneau ne peut pas exister sans sa provenance', () => {
	it('la période est nulle quand il n’y a pas de donnée, jamais une plage vide', () => {
		// Une plage inventée se lirait « rien ne s'est passé sur ces 28 jours », alors que la
		// vérité est « on n'a rien mesuré ».
		expect(makePeriod(null, null)).toBeNull();
		expect(makePeriod('2026-06-29', null)).toBeNull();
	});

	it('la période porte ses bornes RÉELLES et son libellé', () => {
		expect(makePeriod('2026-06-29', '2026-07-20')).toEqual({
			start: '2026-06-29',
			end: '2026-07-20',
			label: '2026-06-29 → 2026-07-20'
		});
		expect(periodLabel('a', 'b')).toBe('a → b');
	});

	it('buildPanel exige le trio et le rend tel quel', () => {
		const panel = buildPanel({
			key: 'gsc',
			label: 'Search Console',
			verdict: { state: 'ok', note: 'à jour' },
			provenance: {
				period: makePeriod('2026-06-29', '2026-07-20'),
				freshness: fresh('2026-07-24 09:00:00'),
				source: 'gsc_query_page_observations'
			}
		});
		expect(panel.provenance.source).toBe('gsc_query_page_observations');
		expect(panel.provenance.freshness.state).toBe('fresh');
		expect(panel.provenance.period?.label).toBe('2026-06-29 → 2026-07-20');
	});
});

// ── Indexation ──────────────────────────────────────────────────────

describe('summarizeIndexation — la couverture ne ment ni par 0 ni par excès', () => {
	const classes = (over: Partial<Record<string, number>> = {}) => ({
		indexed: 0,
		not_indexed: 0,
		excluded: 0,
		unknown: 0,
		...over
	});

	it('aucune observation ⇒ taux NULL, jamais 0 %', () => {
		// 0 % se lirait « rien n'est indexé », ce qui est une affirmation ; `null` dit « on
		// n'a pas mesuré », ce qui est un fait.
		const s = summarizeIndexation({ classes: classes(), dueRows: [] });
		expect(s.coverageRate).toBeNull();
		expect(s.urlsObserved).toBe(0);
	});

	it('`excluded` est HORS dénominateur — un noindex n’est pas un échec', () => {
		// Même règle qu'IDX-005, où `excluded` n'est jamais un `index_drop` : c'est une
		// décision du site. L'inclure ferait baisser la couverture à chaque page volontairement
		// désindexée.
		const s = summarizeIndexation({
			classes: classes({ indexed: 8, not_indexed: 2, excluded: 90 }),
			dueRows: []
		});
		expect(s.coverageRate).toBeCloseTo(0.8);
		expect(s.urlsObserved).toBe(100);
	});

	it('les échéances dues sont comptées et la plus ANCIENNE est nommée', () => {
		const s = summarizeIndexation({
			classes: classes({ indexed: 1 }),
			dueRows: [{ dueDate: '2026-07-20' }, { dueDate: '2026-07-02' }, { dueDate: '2026-07-11' }]
		});
		expect(s.dueNow).toBe(3);
		expect(s.oldestDueDate).toBe('2026-07-02');
	});
});

// ── Acceptation 3 : la timeline ─────────────────────────────────────

describe('buildTimeline — ordre TOTAL, et ce qui est coupé se dit', () => {
	const at = (ts: string, over: Partial<TimelineEntry> = {}): TimelineEntry => ({
		kind: 'run',
		id: 'x',
		at: ts,
		atMs: Date.parse(`${ts.replace(' ', 'T')}Z`),
		title: ts,
		detail: null,
		actor: null,
		href: null,
		...over
	});

	it('le plus récent d’abord', () => {
		const t = buildTimeline(
			[at('2026-07-01 10:00:00', { id: 'a' }), at('2026-07-03 10:00:00', { id: 'b' })],
			10
		);
		expect(t.entries.map((e) => e.id)).toEqual(['b', 'a']);
	});

	it('à horodatage égal : nature puis id — l’ordre ne peut pas permuter d’un appel à l’autre', () => {
		// Sans la dernière clé, deux chargements de la même page rendraient deux ordres.
		const ts = '2026-07-03 10:00:00';
		const entries = [
			at(ts, { kind: 'decision', id: 'z' }),
			at(ts, { kind: 'finding', id: 'm' }),
			at(ts, { kind: 'run', id: 'b' }),
			at(ts, { kind: 'run', id: 'a' })
		];
		const once = buildTimeline(entries, 10).entries.map((e) => e.id);
		const twice = buildTimeline([...entries].reverse(), 10).entries.map((e) => e.id);
		expect(once).toEqual(['a', 'b', 'm', 'z']);
		expect(twice).toEqual(once);
	});

	it('un horodatage illisible part à la FIN — une date cassée n’est pas une nouvelle', () => {
		const t = buildTimeline(
			[
				{ ...at('2026-07-01 10:00:00', { id: 'ok' }) },
				{ ...at('2026-07-01 10:00:00', { id: 'ko' }), at: 'jamais', atMs: null }
			],
			10
		);
		expect(t.entries.map((e) => e.id)).toEqual(['ok', 'ko']);
	});

	it('la troncature est COMPTÉE, jamais tue', () => {
		const many = Array.from({ length: 12 }, (_, i) =>
			at(`2026-07-${String(i + 1).padStart(2, '0')} 10:00:00`, { id: `e${i}` })
		);
		const t = buildTimeline(many, 5);
		expect(t.entries).toHaveLength(5);
		expect(t.truncated).toBe(7);
	});

	it('un plafond nul ne rend rien et le dit', () => {
		const t = buildTimeline([at('2026-07-01 10:00:00')], 0);
		expect(t.entries).toEqual([]);
		expect(t.truncated).toBe(1);
	});
});
