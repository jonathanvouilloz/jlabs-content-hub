"""Regression tests for the static-build mode of site_linker.py."""

import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("site_linker.py")
SPEC = importlib.util.spec_from_file_location("site_linker", MODULE_PATH)
site_linker = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(site_linker)


class CrawlBuiltSiteTests(unittest.TestCase):
    def test_crawls_rendered_routes_and_resolves_rendered_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "dist"
            root.mkdir()
            (root / "en" / "about").mkdir(parents=True)
            (root / "en" / "index.html").write_text(
                '<a href="/en/about">About</a>', encoding="utf-8"
            )
            (root / "en" / "about" / "index.html").write_text(
                '<a href="/en">Home</a>', encoding="utf-8"
            )

            nodes = site_linker.crawl_built_site(root)
            analysis = site_linker.analyze(nodes)

        self.assertEqual(set(nodes), {"/en/", "/en/about/"})
        self.assertEqual(analysis["total_links"], 2)
        self.assertEqual(analysis["orphans"], [])
        self.assertEqual(analysis["broken_links"], {})

    def test_uses_main_content_not_global_navigation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "dist"
            root.mkdir()
            (root / "en" / "about").mkdir(parents=True)
            (root / "en" / "index.html").write_text(
                '<nav><a href="/en/shell">Shell</a></nav>'
                '<main><a href="/en/about">About</a></main>'
                '<footer><a href="/en/shell">Shell</a></footer>',
                encoding="utf-8",
            )
            (root / "en" / "about" / "index.html").write_text(
                '<main><a href="/en">Home</a></main>', encoding="utf-8"
            )

            analysis = site_linker.analyze(site_linker.crawl_built_site(root))

        self.assertEqual(analysis["total_links"], 2)
        self.assertEqual(analysis["broken_links"], {})


class GraphLayoutTests(unittest.TestCase):
    def test_uses_a_spacious_default_layout(self):
        nodes = {
            "/en/": {
                "title": "Home",
                "category": "pages",
                "links": [],
                "file": "en/index.html",
            }
        }
        analysis = {
            "categories": {"pages": ["/en/"]},
            "orphans": [],
            "no_outlinks": [],
            "weak_anchors": {},
            "broken_links": {},
            "in_map": {"/en/": []},
            "out_map": {"/en/": []},
            "total_pages": 1,
            "total_links": 0,
        }

        html = site_linker.generate_d3_html(nodes, analysis)

        self.assertIn("const LINK_DISTANCE = 210;", html)
        self.assertIn("strength(-1400)", html)
        self.assertIn("forceCollide(d => d.size + 30)", html)

    def test_highlights_outgoing_links_on_node_hover(self):
        nodes = {
            "/en/": {
                "title": "Home",
                "category": "pages",
                "links": [],
                "file": "en/index.html",
            }
        }
        analysis = {
            "categories": {"pages": ["/en/"]},
            "orphans": [], "no_outlinks": [], "weak_anchors": {}, "broken_links": {},
            "in_map": {"/en/": []}, "out_map": {"/en/": []},
            "total_pages": 1, "total_links": 0,
        }

        html = site_linker.generate_d3_html(nodes, analysis)

        self.assertIn("function highlightOutgoing(sourceId)", html)
        self.assertIn("edgeSourceId(edge) === sourceId", html)
        self.assertIn('highlightOutgoing(d.id);', html)


if __name__ == "__main__":
    unittest.main()
