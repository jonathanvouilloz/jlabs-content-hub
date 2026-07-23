import { describe, expect, it } from 'vitest';
import {
	GSC_PAGE_SIZE,
	MAX_PAGES,
	assertPageBudget,
	computeTotals,
	hasMorePages,
	latestCompleteWeekStart,
	normalizeDevice,
	normalizeRows,
	previousWeekStart,
	resolveCollectionWeek,
	rowKey,
	weekEndOf,
	weekStartOf
} from './gsc-collector-state.js';

describe('semaines', () => {
	it('ramène toute date sur son lundi', () => {
		// Mercredi 2026-07-08 → lundi 2026-07-06.
		expect(weekStartOf(new Date('2026-07-08T12:00:00Z'))).toBe('2026-07-06');
		// Un lundi est son propre début de semaine.
		expect(weekStartOf(new Date('2026-07-06T00:00:00Z'))).toBe('2026-07-06');
		// Dimanche appartient encore à la semaine qui commence le lundi précédent.
		expect(weekStartOf(new Date('2026-07-12T23:59:59Z'))).toBe('2026-07-06');
	});

	it('clôt une semaine sur son dimanche', () => {
		expect(weekEndOf('2026-07-06')).toBe('2026-07-12');
	});

	it('recule d’exactement sept jours', () => {
		expect(previousWeekStart('2026-07-06')).toBe('2026-06-29');
	});

	it('respecte la latence GSC de trois jours', () => {
		// Le lundi 2026-07-20, la dernière semaine consolidée est celle du 06/07 :
		// la semaine du 13/07 vient de finir et n'est pas encore consolidée.
		expect(latestCompleteWeekStart(new Date('2026-07-20T06:30:00Z'))).toBe('2026-07-06');
		// Une semaine plus tard, elle le devient.
		expect(latestCompleteWeekStart(new Date('2026-07-27T06:30:00Z'))).toBe('2026-07-13');
	});

	it('choisit la dernière semaine complète par défaut', () => {
		const r = resolveCollectionWeek({ now: new Date('2026-07-27T09:00:00Z') });
		expect(r).toEqual({ weekStart: '2026-07-13', weekEnd: '2026-07-19', requested: false });
	});

	it('normalise une semaine demandée sur son lundi', () => {
		// Le piège : `--week 2026-07-08` (mercredi) écrirait sinon une period_start
		// qui ne tombe sur celle d'aucune autre semaine — invisible du détecteur,
		// qui groupe par period_start.
		const r = resolveCollectionWeek({ requested: '2026-07-08' });
		expect(r.weekStart).toBe('2026-07-06');
		expect(r.weekEnd).toBe('2026-07-12');
		expect(r.requested).toBe(true);
	});

	it('lève sur une semaine illisible plutôt que d’en deviner une', () => {
		expect(() => resolveCollectionWeek({ requested: 'la semaine dernière' })).toThrow(/illisible/i);
		expect(() => resolveCollectionWeek({ requested: '2026-13-45' })).toThrow(/illisible/i);
		expect(() => resolveCollectionWeek({ requested: '06-07-2026' })).toThrow(/illisible/i);
	});
});

describe('normalizeDevice', () => {
	it('rend UNKNOWN pour un device absent ou vide', () => {
		// Valeur alignée sur le chemin legacy : le device fait partie de la clé
		// unique, choisir '' ferait de la même mesure une ligne différente.
		expect(normalizeDevice(undefined)).toBe('UNKNOWN');
		expect(normalizeDevice(null)).toBe('UNKNOWN');
		expect(normalizeDevice('  ')).toBe('UNKNOWN');
	});

	it('met en capitales pour rejoindre les valeurs déjà en base', () => {
		expect(normalizeDevice('mobile')).toBe('MOBILE');
		expect(normalizeDevice('DESKTOP')).toBe('DESKTOP');
	});
});

describe('normalizeRows', () => {
	it('mappe les clés dans l’ordre des dimensions demandées', () => {
		const { rows } = normalizeRows([
			{ keys: ['pizza', 'https://a.ch/x', 'MOBILE'], clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 }
		]);
		expect(rows).toEqual([
			{ query: 'pizza', page: 'https://a.ch/x', device: 'MOBILE', clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 }
		]);
	});

	it('rend un tableau vide sur une semaine sans données', () => {
		// Acceptation GSC-002 « les lignes nulles sont testées » : une semaine à
		// zéro ligne est légitime (nouvelle propriété, site sans impression) et ne
		// doit ni échouer ni effacer quoi que ce soit.
		const { rows, duplicates, skipped } = normalizeRows([]);
		expect(rows).toEqual([]);
		expect(duplicates).toBe(0);
		expect(skipped).toBe(0);
	});

	it('déduplique sur la clé query×page×device', () => {
		// Postgres refuse deux lignes de même clé dans un même ON CONFLICT DO
		// UPDATE : un doublon ferait échouer TOUT le lot.
		const { rows, duplicates } = normalizeRows([
			{ keys: ['a', 'https://x.ch/', 'MOBILE'], clicks: 1, impressions: 10 },
			{ keys: ['a', 'https://x.ch/', 'mobile'], clicks: 2, impressions: 20 }
		]);
		expect(rows).toHaveLength(1);
		expect(duplicates).toBe(1);
		// La dernière gagne.
		expect(rows[0].clicks).toBe(2);
	});

	it('ne confond pas deux pages différentes de la même requête', () => {
		const { rows, duplicates } = normalizeRows([
			{ keys: ['a', 'https://x.ch/1', 'MOBILE'] },
			{ keys: ['a', 'https://x.ch/2', 'MOBILE'] }
		]);
		expect(rows).toHaveLength(2);
		expect(duplicates).toBe(0);
	});

	it('laisse l’URL de page BRUTE', () => {
		// La normaliser ici ferait diverger la clé unique des 73 009 lignes déjà
		// posées → des doublons que rien ne signale. C'est une affaire de lecture.
		const { rows } = normalizeRows([{ keys: ['a', 'https://X.ch/Page/?b=1#f', 'MOBILE'] }]);
		expect(rows[0].page).toBe('https://X.ch/Page/?b=1#f');
	});

	it('écarte une ligne sans requête ET sans page', () => {
		const { rows, skipped } = normalizeRows([{ keys: [] }, { keys: ['a', 'https://x.ch/'] }]);
		expect(rows).toHaveLength(1);
		expect(skipped).toBe(1);
	});

	it('garde une ligne dont seule la requête est vide', () => {
		// Une page peut être servie sans requête associée (dimension anonymisée) :
		// c'est un fait, pas un déchet.
		const { rows, skipped } = normalizeRows([{ keys: ['', 'https://x.ch/'] }]);
		expect(rows).toHaveLength(1);
		expect(skipped).toBe(0);
	});

	it('remplit les métriques absentes par zéro', () => {
		const { rows } = normalizeRows([{ keys: ['a', 'https://x.ch/', 'MOBILE'] }]);
		expect(rows[0]).toMatchObject({ clicks: 0, impressions: 0, ctr: 0, position: 0 });
	});
});

describe('rowKey', () => {
	it('distingue deux triplets qui ne diffèrent que par un champ', () => {
		const base = { query: 'a', page: 'p', device: 'MOBILE' };
		expect(rowKey(base)).not.toBe(rowKey({ ...base, query: 'b' }));
		expect(rowKey(base)).not.toBe(rowKey({ ...base, page: 'q' }));
		expect(rowKey(base)).not.toBe(rowKey({ ...base, device: 'DESKTOP' }));
	});

	it('sépare les champs plutôt que de les concaténer', () => {
		// Sans séparateur, ('ab','c') et ('a','bc') donneraient la même clé.
		expect(rowKey({ query: 'ab', page: 'c', device: 'M' })).not.toBe(
			rowKey({ query: 'a', page: 'bc', device: 'M' })
		);
	});

	it('COLLISIONNE si 0x1f apparaît dans un champ — invariant assumé', () => {
		// Documenté plutôt que masqué : la clé suppose que 0x1f (unit separator)
		// n'apparaît ni dans une requête ni dans une URL. C'est l'idiome de tout le
		// repo (`deriveObservationFingerprint`, `rollupPagesFromQueryPage`) : durcir
		// `rowKey` seul le ferait diverger du rollup, qui groupe avec le même
		// séparateur — la déduplication et l'agrégation ne seraient plus d'accord.
		expect(rowKey({ query: 'a\x1fb', page: 'p', device: 'M' })).toBe(
			rowKey({ query: 'a', page: 'b\x1fp', device: 'M' })
		);
	});
});

describe('computeTotals', () => {
	const rows = [
		{ query: 'a', page: 'p1', device: 'M', clicks: 2, impressions: 100, ctr: 0.02, position: 10 },
		{ query: 'b', page: 'p2', device: 'M', clicks: 8, impressions: 900, ctr: 0.0089, position: 2 }
	];

	it('somme les clics et les impressions', () => {
		const t = computeTotals(rows);
		expect(t.rowCount).toBe(2);
		expect(t.totalClicks).toBe(10);
		expect(t.totalImpressions).toBe(1000);
	});

	it('pondère la position par les impressions, pas par le nombre de lignes', () => {
		// Moyenne arithmétique = 6 ; pondérée = (10×100 + 2×900) / 1000 = 2.8.
		// Une requête vue 900 fois ne pèse pas comme une vue 100 fois.
		expect(computeTotals(rows).avgPosition).toBeCloseTo(2.8, 10);
	});

	it('rend le CTR global et non la moyenne des CTR', () => {
		expect(computeTotals(rows).avgCtr).toBeCloseTo(0.01, 10);
	});

	it('ne divise pas par zéro sur une semaine vide', () => {
		expect(computeTotals([])).toEqual({
			rowCount: 0,
			totalClicks: 0,
			totalImpressions: 0,
			avgCtr: 0,
			avgPosition: 0
		});
	});
});

describe('pagination', () => {
	it('continue tant qu’une page est pleine', () => {
		expect(hasMorePages(GSC_PAGE_SIZE)).toBe(true);
	});

	it('s’arrête sur une page incomplète', () => {
		expect(hasMorePages(GSC_PAGE_SIZE - 1)).toBe(false);
		expect(hasMorePages(0)).toBe(false);
	});

	it('échoue au lieu de tronquer quand la borne est atteinte', () => {
		// Une semaine silencieusement partielle serait lue comme une chute par le
		// détecteur : mieux vaut échouer fort.
		expect(() => assertPageBudget(MAX_PAGES)).toThrow(/pagination gsc anormale/i);
		expect(() => assertPageBudget(MAX_PAGES - 1)).not.toThrow();
	});
});
