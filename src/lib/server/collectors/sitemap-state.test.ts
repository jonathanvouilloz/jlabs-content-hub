import { describe, it, expect } from 'vitest';
import {
	MAX_SITEMAP_DEPTH,
	MAX_SITEMAP_FILES,
	normalizeUrl,
	decodeXmlText,
	extractAlternates,
	parseSitemapXml,
	dedupeEntries,
	admitSitemap,
	capEntries,
	diffInventories,
	type InventoryRow,
	type SitemapEntry
} from './sitemap-state.js';

const ROOT = 'https://exemple.ch/sitemap.xml';

function urlset(body: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">${body}</urlset>`;
}

function row(over: Partial<InventoryRow> & { urlNormalized: string }): InventoryRow {
	return {
		urlNormalized: over.urlNormalized,
		lastmod: over.lastmod ?? null,
		expectedCanonical: over.expectedCanonical ?? over.urlNormalized
	};
}

describe('normalisation d’URL', () => {
	it('retire le fragment — jamais envoyé au serveur, donc jamais une page distincte', () => {
		expect(normalizeUrl('https://exemple.ch/a#section').normalized).toBe('https://exemple.ch/a');
		// Le test de l'acceptation « fragments normalisés » : les deux formes convergent.
		expect(normalizeUrl('https://exemple.ch/a#x').normalized).toBe(
			normalizeUrl('https://exemple.ch/a').normalized
		);
	});

	it('minuscule le schéma et l’hôte, retire le port par défaut', () => {
		expect(normalizeUrl('HTTPS://Exemple.CH/A').normalized).toBe('https://exemple.ch/A');
		expect(normalizeUrl('https://exemple.ch:443/a').normalized).toBe('https://exemple.ch/a');
		expect(normalizeUrl('http://exemple.ch:80/a').normalized).toBe('http://exemple.ch/a');
	});

	it('CONSERVE le slash final et la query — les retirer ferait fusionner deux pages', () => {
		expect(normalizeUrl('https://exemple.ch/a/').normalized).toBe('https://exemple.ch/a/');
		expect(normalizeUrl('https://exemple.ch/a/').normalized).not.toBe(
			normalizeUrl('https://exemple.ch/a').normalized
		);
		expect(normalizeUrl('https://exemple.ch/a?p=2').normalized).toBe('https://exemple.ch/a?p=2');
	});

	it('refuse ce qui n’est pas une URL http(s) absolue', () => {
		expect(normalizeUrl('/relative').ok).toBe(false);
		expect(normalizeUrl('ftp://exemple.ch/a').ok).toBe(false);
		expect(normalizeUrl('   ').ok).toBe(false);
		expect(normalizeUrl('pas une url').ok).toBe(false);
	});
});

describe('décodage XML', () => {
	it('traite &amp; en DERNIER (sinon &amp;lt; deviendrait <)', () => {
		expect(decodeXmlText('a&amp;lt;b')).toBe('a&lt;b');
		expect(decodeXmlText('a&lt;b&gt;c')).toBe('a<b>c');
		expect(decodeXmlText('?a=1&amp;b=2')).toBe('?a=1&b=2');
		expect(decodeXmlText('&#233;&#xe9;')).toBe('éé');
	});
});

describe('parsing : la racine décide, jamais la présence de <url>', () => {
	it('reconnaît un sitemapindex et rend ses enfants', () => {
		const xml = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://exemple.ch/s1.xml</loc></sitemap>
  <sitemap><loc>https://exemple.ch/s2.xml</loc></sitemap>
</sitemapindex>`;
		const r = parseSitemapXml({ xml, sitemapUrl: ROOT });
		expect(r.kind).toBe('index');
		expect(r.children).toEqual(['https://exemple.ch/s1.xml', 'https://exemple.ch/s2.xml']);
		expect(r.entries).toHaveLength(0);
		expect(r.errors).toHaveLength(0);
	});

	it('un corps qui n’est ni index ni urlset est une ERREUR, pas un inventaire vide', () => {
		const r = parseSitemapXml({ xml: '<html><body>oups</body></html>', sitemapUrl: ROOT });
		expect(r.kind).toBe('unknown');
		expect(r.errors.map((e) => e.kind)).toEqual(['not_xml']);
		// Le point : un 200 qui rend du HTML ne doit pas se lire comme « 0 URL ».
		expect(r.entries).toHaveLength(0);
	});

	it('un <url> sans <loc> est signalé, pas avalé', () => {
		const r = parseSitemapXml({
			xml: urlset('<url><lastmod>2026-07-01</lastmod></url><url><loc>https://exemple.ch/a</loc></url>'),
			sitemapUrl: ROOT
		});
		expect(r.entries).toHaveLength(1);
		expect(r.errors.map((e) => e.kind)).toEqual(['entry_without_loc']);
	});

	it('un <loc> relatif est signalé et l’entrée écartée', () => {
		const r = parseSitemapXml({ xml: urlset('<url><loc>/relative</loc></url>'), sitemapUrl: ROOT });
		expect(r.entries).toHaveLength(0);
		expect(r.errors[0].kind).toBe('invalid_loc');
		expect(r.errors[0].detail).toContain('/relative');
	});

	it('garde lastmod tel quel, et null quand il est absent', () => {
		const r = parseSitemapXml({
			xml: urlset(
				'<url><loc>https://exemple.ch/a</loc><lastmod>2026-07-01T10:00:00+02:00</lastmod></url>' +
					'<url><loc>https://exemple.ch/b</loc></url>'
			),
			sitemapUrl: ROOT
		});
		expect(r.entries[0].lastmod).toBe('2026-07-01T10:00:00+02:00');
		// « pas de lastmod » n'est pas « jamais modifié » : on ne l'invente pas.
		expect(r.entries[1].lastmod).toBeNull();
	});

	it('ignore un <loc> en commentaire', () => {
		const r = parseSitemapXml({
			xml: urlset('<!-- <url><loc>https://exemple.ch/fantome</loc></url> --><url><loc>https://exemple.ch/a</loc></url>'),
			sitemapUrl: ROOT
		});
		expect(r.entries.map((e) => e.urlNormalized)).toEqual(['https://exemple.ch/a']);
	});

	it('déballe le CDATA', () => {
		const r = parseSitemapXml({
			xml: urlset('<url><loc><![CDATA[https://exemple.ch/a?x=1&y=2]]></loc></url>'),
			sitemapUrl: ROOT
		});
		expect(r.entries[0].urlNormalized).toBe('https://exemple.ch/a?x=1&y=2');
	});

	it('tolère les préfixes de namespace sur les balises', () => {
		const xml = `<?xml version="1.0"?>
<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sm:url><sm:loc>https://exemple.ch/a</sm:loc></sm:url>
</sm:urlset>`;
		const r = parseSitemapXml({ xml, sitemapUrl: ROOT });
		expect(r.kind).toBe('urlset');
		expect(r.entries).toHaveLength(1);
	});

	it('expectedCanonical est l’URL normalisée — la référence qu’IDX-002 confrontera à Google', () => {
		const r = parseSitemapXml({ xml: urlset('<url><loc>https://Exemple.ch/a#x</loc></url>'), sitemapUrl: ROOT });
		expect(r.entries[0].url).toBe('https://Exemple.ch/a#x'); // ce que le site déclare
		expect(r.entries[0].expectedCanonical).toBe('https://exemple.ch/a'); // ce qu'on attend
	});
});

describe('alternates hreflang', () => {
	const XML = urlset(`<url>
			<loc>https://exemple.ch/fr/a</loc>
			<lastmod>2026-07-01</lastmod>
			<xhtml:link rel="alternate" hreflang="fr" href="https://exemple.ch/fr/a"/>
			<xhtml:link rel="alternate" hreflang="de" href="https://exemple.ch/de/a"/>
			<xhtml:link rel="alternate" hreflang="en" href="https://exemple.ch/en/a"/>
		</url>`);

	it('extrait les alternates par attributs (balises auto-fermantes)', () => {
		const alts = extractAlternates(XML);
		expect(alts.map((a) => a.hreflang)).toEqual(['fr', 'de', 'en']);
	});

	it('marque les alternates ET ignore la page qui se déclare sa propre alternate', () => {
		const r = parseSitemapXml({ xml: XML, sitemapUrl: ROOT });
		// 1 principale + 2 alternates (le hreflang="fr" pointe la principale → ignoré).
		expect(r.entries).toHaveLength(3);
		const principale = r.entries.find((e) => e.urlNormalized === 'https://exemple.ch/fr/a')!;
		expect(principale.isAlternate).toBe(false);
		expect(principale.locale).toBeNull();
		const de = r.entries.find((e) => e.urlNormalized === 'https://exemple.ch/de/a')!;
		expect(de.isAlternate).toBe(true);
		expect(de.locale).toBe('de');
	});

	it('ignore un <link> qui n’est pas rel="alternate"', () => {
		const alts = extractAlternates('<xhtml:link rel="canonical" href="https://exemple.ch/x"/>');
		expect(alts).toHaveLength(0);
	});
});

describe('déduplication AVANT insert (Postgres rejette tout le lot sur un doublon)', () => {
	function entry(url: string, isAlternate: boolean, lastmod: string | null = null): SitemapEntry {
		return {
			url,
			urlNormalized: url,
			lastmod,
			locale: isAlternate ? 'de' : null,
			expectedCanonical: url,
			isAlternate,
			sitemapUrl: ROOT
		};
	}

	it('une URL listée deux fois ne produit qu’une entrée', () => {
		const out = dedupeEntries([entry('https://exemple.ch/a', false), entry('https://exemple.ch/a', false)]);
		expect(out).toHaveLength(1);
	});

	it('la principale l’emporte sur l’alternate portant la même URL', () => {
		const out = dedupeEntries([entry('https://exemple.ch/a', true), entry('https://exemple.ch/a', false)]);
		expect(out).toHaveLength(1);
		expect(out[0].isAlternate).toBe(false);
	});
});

describe('bornes de parcours : cycle, profondeur, budget de fichiers', () => {
	it('un sitemap déjà visité est refusé — un index auto-référent ne boucle pas', () => {
		const res = admitSitemap({
			sitemapUrl: ROOT,
			depth: 1,
			visited: new Set([ROOT]),
			filesFetched: 1
		});
		expect(res.admit).toBe(false);
		if (!res.admit) expect(res.error.kind).toBe('cycle');
	});

	it('la profondeur est bornée et l’annonce', () => {
		const res = admitSitemap({
			sitemapUrl: ROOT,
			depth: MAX_SITEMAP_DEPTH + 1,
			visited: new Set(),
			filesFetched: 0
		});
		expect(res.admit).toBe(false);
		if (!res.admit) expect(res.error.kind).toBe('depth_exceeded');
	});

	it('le budget de fichiers est borné et l’annonce', () => {
		const res = admitSitemap({
			sitemapUrl: ROOT,
			depth: 1,
			visited: new Set(),
			filesFetched: MAX_SITEMAP_FILES
		});
		expect(res.admit).toBe(false);
		if (!res.admit) expect(res.error.kind).toBe('file_budget_exceeded');
	});

	it('admet un fichier neuf dans les bornes', () => {
		expect(admitSitemap({ sitemapUrl: ROOT, depth: 0, visited: new Set(), filesFetched: 0 }).admit).toBe(
			true
		);
	});

	it('le plafond d’URLs DIT ce qu’il coupe', () => {
		const entries = Array.from({ length: 5 }, (_, i) => ({
			url: `https://exemple.ch/${i}`,
			urlNormalized: `https://exemple.ch/${i}`,
			lastmod: null,
			locale: null,
			expectedCanonical: `https://exemple.ch/${i}`,
			isAlternate: false,
			sitemapUrl: ROOT
		}));
		const capped = capEntries(entries, 3);
		expect(capped.kept).toHaveLength(3);
		expect(capped.truncated).toBe(true);
		expect(capped.dropped).toBe(2);
		// Sous le plafond, rien n'est annoncé comme tronqué.
		expect(capEntries(entries, 10).truncated).toBe(false);
	});
});

describe('diff : fonction pure de deux snapshots (acceptation IDX-001)', () => {
	const prev: InventoryRow[] = [
		row({ urlNormalized: 'https://exemple.ch/a', lastmod: '2026-06-01' }),
		row({ urlNormalized: 'https://exemple.ch/b', lastmod: '2026-06-01' }),
		row({ urlNormalized: 'https://exemple.ch/c', lastmod: null })
	];
	const curr: InventoryRow[] = [
		row({ urlNormalized: 'https://exemple.ch/a', lastmod: '2026-06-01' }), // inchangée
		row({ urlNormalized: 'https://exemple.ch/b', lastmod: '2026-07-01' }), // lastmod bougé
		row({ urlNormalized: 'https://exemple.ch/d', lastmod: null }) // ajoutée ; c retirée
	];

	it('rend added / removed / changed exacts', () => {
		const d = diffInventories(prev, curr);
		expect(d.added).toEqual(['https://exemple.ch/d']);
		expect(d.removed).toEqual(['https://exemple.ch/c']);
		expect(d.changed).toHaveLength(1);
		expect(d.changed[0].urlNormalized).toBe('https://exemple.ch/b');
		expect(d.changed[0].fields).toEqual(['lastmod']);
		expect(d.unchanged).toBe(1);
	});

	it('REPRODUCTIBLE : deux appels rendent le même diff, au même ordre', () => {
		expect(JSON.stringify(diffInventories(prev, curr))).toBe(JSON.stringify(diffInventories(prev, curr)));
		// Et l'ordre d'entrée ne change pas la sortie (les listes sont triées).
		const shuffled = [...curr].reverse();
		expect(JSON.stringify(diffInventories(prev, shuffled))).toBe(JSON.stringify(diffInventories(prev, curr)));
	});

	it('un canonical qui bouge SANS lastmod est vu — c’est l’anomalie cherchée', () => {
		const d = diffInventories(
			[row({ urlNormalized: 'https://exemple.ch/a', lastmod: '2026-06-01', expectedCanonical: 'https://exemple.ch/a' })],
			[row({ urlNormalized: 'https://exemple.ch/a', lastmod: '2026-06-01', expectedCanonical: 'https://exemple.ch/autre' })]
		);
		expect(d.changed[0].fields).toEqual(['expected_canonical']);
	});

	it('un lastmod qui apparaît ou disparaît compte comme un changement', () => {
		const apparait = diffInventories(
			[row({ urlNormalized: 'https://exemple.ch/a', lastmod: null })],
			[row({ urlNormalized: 'https://exemple.ch/a', lastmod: '2026-07-01' })]
		);
		expect(apparait.changed[0].fields).toEqual(['lastmod']);
		const disparait = diffInventories(
			[row({ urlNormalized: 'https://exemple.ch/a', lastmod: '2026-07-01' })],
			[row({ urlNormalized: 'https://exemple.ch/a', lastmod: null })]
		);
		expect(disparait.changed[0].fields).toEqual(['lastmod']);
	});

	it('un inventaire courant VIDE rend tout en removed — jamais un « rien à signaler »', () => {
		const d = diffInventories(prev, []);
		expect(d.removed).toHaveLength(3);
		expect(d.added).toHaveLength(0);
		// C'est précisément pourquoi le collecteur n'écrit rien avant d'avoir tout parcouru :
		// un inventaire tronqué produirait ces trois retraits comme s'ils étaient réels.
	});

	it('le premier inventaire (aucun précédent) est tout en added, sans faux retrait', () => {
		const d = diffInventories([], curr);
		expect(d.added).toHaveLength(3);
		expect(d.removed).toHaveLength(0);
		expect(d.changed).toHaveLength(0);
	});

	it('normalisation + diff : #fragment ne crée AUCUN faux ajout d’un run à l’autre', () => {
		const run1 = parseSitemapXml({ xml: urlset('<url><loc>https://exemple.ch/a</loc></url>'), sitemapUrl: ROOT });
		const run2 = parseSitemapXml({ xml: urlset('<url><loc>https://exemple.ch/a#top</loc></url>'), sitemapUrl: ROOT });
		const toRows = (entries: SitemapEntry[]): InventoryRow[] =>
			entries.map((e) => ({
				urlNormalized: e.urlNormalized,
				lastmod: e.lastmod,
				expectedCanonical: e.expectedCanonical
			}));
		const d = diffInventories(toRows(run1.entries), toRows(run2.entries));
		expect(d.added).toHaveLength(0);
		expect(d.removed).toHaveLength(0);
		expect(d.unchanged).toBe(1);
	});
});
