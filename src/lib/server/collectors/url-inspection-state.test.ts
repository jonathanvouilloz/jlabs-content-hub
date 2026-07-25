import { describe, it, expect } from 'vitest';
import {
	MAX_PAYLOAD_LIST_ITEMS,
	MAX_URLS_PER_JOB,
	canonicalMismatch,
	capUrls,
	classifyCoverage,
	parseInspectionResult
} from './url-inspection-state.js';

/** Une réponse Google réaliste. */
function response(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
	return {
		inspectionResult: {
			indexStatusResult: {
				verdict: 'PASS',
				coverageState: 'Submitted and indexed',
				indexingState: 'INDEXING_ALLOWED',
				robotsState: 'INDEXING_ALLOWED',
				googleCanonical: 'https://x.ch/a',
				userCanonical: 'https://x.ch/a',
				lastCrawlTime: '2026-07-20T04:12:33Z',
				pageFetchState: 'SUCCESSFUL',
				crawledAs: 'MOBILE',
				sitemap: ['https://x.ch/sitemap.xml'],
				referringUrls: ['https://x.ch/', 'https://x.ch/blog'],
				...over
			},
			mobileUsabilityResult: { verdict: 'PASS' },
			richResultsResult: { verdict: 'NEUTRAL' },
			...extra
		}
	};
}

describe('parsing : colonnes normalisées vs payload borné', () => {
	it('remplit les 7 colonnes de index_observations', () => {
		const { normalized, understood } = parseInspectionResult(response());
		expect(understood).toBe(true);
		expect(normalized).toEqual({
			verdict: 'PASS',
			coverageState: 'Submitted and indexed',
			indexingState: 'INDEXING_ALLOWED',
			robotsState: 'INDEXING_ALLOWED',
			googleCanonical: 'https://x.ch/a',
			userCanonical: 'https://x.ch/a',
			lastCrawlAt: '2026-07-20T04:12:33Z'
		});
	});

	it('met en payload ce que SPEC §9.2 exige mais qu’aucune colonne ne porte', () => {
		const { payload } = parseInspectionResult(response());
		expect(payload.pageFetchState).toBe('SUCCESSFUL');
		expect(payload.crawledAs).toBe('MOBILE');
		expect(payload.sitemaps).toEqual(['https://x.ch/sitemap.xml']);
		expect(payload.referringUrls).toEqual(['https://x.ch/', 'https://x.ch/blog']);
		expect(payload.mobileUsability).toEqual({ verdict: 'PASS' });
		expect(payload.richResults).toEqual({ verdict: 'NEUTRAL' });
	});

	it('une réponse sans inspectionResult n’est PAS un résultat vide — elle n’est pas comprise', () => {
		// Le point : rendre `understood: false` permet au collecteur de NE RIEN écrire. Écrire
		// des null créerait une observation qui se lirait comme « Google ne connaît pas cette page ».
		expect(parseInspectionResult({}).understood).toBe(false);
		expect(parseInspectionResult(null).understood).toBe(false);
		expect(parseInspectionResult('pas un objet').understood).toBe(false);
		expect(parseInspectionResult({ inspectionResult: {} }).understood).toBe(false);
	});

	it('une réponse partielle est une DONNÉE, pas une panne', () => {
		const { normalized, understood } = parseInspectionResult({
			inspectionResult: { indexStatusResult: { coverageState: 'Crawled - currently not indexed' } }
		});
		expect(understood).toBe(true);
		expect(normalized.coverageState).toBe('Crawled - currently not indexed');
		expect(normalized.verdict).toBeNull();
		expect(normalized.googleCanonical).toBeNull();
	});

	it('un referringUrls géant est TRONQUÉ et le dit — il ne fait pas échouer la collecte', () => {
		const many = Array.from({ length: 500 }, (_, i) => `https://x.ch/p${i}`);
		const { payload } = parseInspectionResult(response({ referringUrls: many }));
		expect(payload.referringUrls).toHaveLength(MAX_PAYLOAD_LIST_ITEMS);
		expect(payload.truncated).toEqual([
			{ field: 'referringUrls', kept: MAX_PAYLOAD_LIST_ITEMS, dropped: 500 - MAX_PAYLOAD_LIST_ITEMS }
		]);
	});

	it('le payload tronqué tient largement sous le plafond de 32 Ko', () => {
		const many = Array.from({ length: 5000 }, (_, i) => `https://x.ch/tres/longue/url/numero/${i}`);
		const { payload } = parseInspectionResult(response({ referringUrls: many, sitemap: many }));
		const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
		expect(bytes).toBeLessThan(32 * 1024);
	});

	it('ignore les entrées non-chaînes d’une liste au lieu de les recopier', () => {
		const { payload } = parseInspectionResult(response({ referringUrls: ['https://x.ch/', 42, null] }));
		expect(payload.referringUrls).toEqual(['https://x.ch/']);
	});
});

describe('classification de coverage', () => {
	it('« excluded » est une classe À PART — pas un « non indexé »', () => {
		// « Excluded by 'noindex' tag » est une décision du site qu'on respecte ; « Crawled -
		// currently not indexed » est un problème à traiter. Deux gestes différents.
		expect(classifyCoverage("Excluded by 'noindex' tag")).toBe('excluded');
		expect(classifyCoverage('Alternate page with proper canonical tag')).toBe('excluded');
		expect(classifyCoverage('Crawled - currently not indexed')).toBe('not_indexed');
		expect(classifyCoverage('Discovered - currently not indexed')).toBe('not_indexed');
		expect(classifyCoverage('URL is unknown to Google')).toBe('not_indexed');
	});

	it('reconnaît l’indexation', () => {
		expect(classifyCoverage('Submitted and indexed')).toBe('indexed');
		expect(classifyCoverage('Indexed, not submitted in sitemap')).toBe('indexed');
	});

	it('ne pas savoir n’est PAS « non indexé »', () => {
		expect(classifyCoverage(null)).toBe('unknown');
		expect(classifyCoverage('')).toBe('unknown');
		expect(classifyCoverage('Quelque chose de neuf chez Google')).toBe('unknown');
	});
});

describe('conflit de canonical', () => {
	it('détecte la divergence Google / site', () => {
		const { normalized } = parseInspectionResult(
			response({ googleCanonical: 'https://x.ch/autre', userCanonical: 'https://x.ch/a' })
		);
		expect(canonicalMismatch(normalized)).toBe(true);
	});

	it('rend null quand l’un manque — « incomparable » n’est pas « d’accord »', () => {
		const { normalized } = parseInspectionResult(response({ googleCanonical: undefined }));
		expect(canonicalMismatch(normalized)).toBeNull();
	});

	it('faux quand les deux concordent', () => {
		const { normalized } = parseInspectionResult(response());
		expect(canonicalMismatch(normalized)).toBe(false);
	});
});

describe('plafond d’URLs par job (la POLITIQUE est à IDX-004, pas ici)', () => {
	it('déduplique en conservant l’ordre — deux fois la même URL = deux fois le quota', () => {
		const r = capUrls(['https://x.ch/a', 'https://x.ch/b', 'https://x.ch/a']);
		expect(r.kept).toEqual(['https://x.ch/a', 'https://x.ch/b']);
		expect(r.truncated).toBe(false);
	});

	it('ignore les entrées vides', () => {
		expect(capUrls(['', '   ', 'https://x.ch/a']).kept).toEqual(['https://x.ch/a']);
	});

	it('plafonne et DIT ce qui est écarté', () => {
		const urls = Array.from({ length: 10 }, (_, i) => `https://x.ch/${i}`);
		const r = capUrls(urls, 4);
		expect(r.kept).toHaveLength(4);
		expect(r.truncated).toBe(true);
		expect(r.dropped).toBe(6);
	});

	it('un cap demandé au-delà du plafond dur est ramené au plafond dur', () => {
		const urls = Array.from({ length: MAX_URLS_PER_JOB + 50 }, (_, i) => `https://x.ch/${i}`);
		const r = capUrls(urls, 100_000);
		expect(r.kept).toHaveLength(MAX_URLS_PER_JOB);
		expect(r.truncated).toBe(true);
		expect(r.dropped).toBe(50);
	});

	it('un cap absurde ne rend jamais une liste vide (0 → 1)', () => {
		expect(capUrls(['https://x.ch/a'], 0).kept).toHaveLength(1);
		expect(capUrls(['https://x.ch/a'], -5).kept).toHaveLength(1);
	});
});
