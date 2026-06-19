#!/usr/bin/env python3
"""
site_linker.py — Analyseur de maillage interne pour sites Astro/MDX
Usage  : python site_linker.py /chemin/vers/site [--output ./output]
Outputs: rapport-maillage.md  · graph.html (D3 force-graph)  · graph-data.json

Deps   : pip install python-frontmatter
"""

import re
import json
import argparse
import sys
from pathlib import Path
from collections import defaultdict
from datetime import datetime

try:
    import frontmatter as fm_lib
except ImportError:
    sys.exit("[!] Dependance manquante : pip install python-frontmatter")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Répertoires où chercher le contenu (ordre de priorité pour la dérivation de slug)
CONTENT_DIRS = ["src/content", "src/pages", "content", "pages"]

MDX_EXTENSIONS = {".mdx", ".md", ".astro"}

# Dossiers à ignorer complètement
SKIP_DIRS = {".git", "node_modules", "dist", ".astro", ".next", "build", "__pycache__", ".vercel", "public"}

# Routes dynamiques Astro (contiennent des brackets) → ignorées
DYNAMIC_ROUTE_RE = re.compile(r"\[.+\]")

# Extensions à ne pas traiter comme des liens (images, assets, fonts)
ASSET_EXTENSIONS = {
    ".webp", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".avif", ".ico",
    ".mp4", ".webm", ".mp3", ".pdf", ".woff", ".woff2", ".ttf", ".eot",
}

# Collections de contenu sans route Astro → exclues en mode Astro
ASTRO_SKIP_COLLECTIONS = {"linkedin"}

# Ancres génériques sans valeur sémantique
WEAK_ANCHORS = {
    "ici", "cliquez ici", "click here", "here", "ici →", "→", "en savoir plus",
    "lire la suite", "voir plus", "voir ici", "read more", "learn more", "this",
    "ce lien", "cet article", "ce post", "plus d'infos", "more info", "voir", "link",
    "lien", "suite", "continuer", "continue", "go", "details", "détails", "page",
}

# Palette de couleurs par cluster (catégorie/tag)
CLUSTER_COLORS = [
    "#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6",
    "#06b6d4", "#f97316", "#84cc16", "#ec4899", "#14b8a6",
    "#a855f7", "#0ea5e9", "#d946ef", "#22c55e", "#fb923c",
]


# ---------------------------------------------------------------------------
# Utilitaires
# ---------------------------------------------------------------------------

def should_skip_file(path: Path) -> bool:
    for part in path.parts:
        if part in SKIP_DIRS:
            return True
        # Dossiers cachés : .briefs/, .seo-data/, .codex/, etc.
        if part.startswith(".") and len(part) > 1:
            return True
    if DYNAMIC_ROUTE_RE.search(path.name):
        return True
    return False


def normalize_slug(slug: str) -> str:
    """Normalise un slug : retire anchor (#), query (?), assure trailing slash."""
    slug = slug.split("#")[0].split("?")[0].strip()
    if slug and not slug.endswith("/"):
        slug += "/"
    return slug or "/"


def derive_slug_from_path(file_path: Path, site_root: Path) -> str:
    """Dérive le slug URL depuis le chemin de fichier."""
    for content_dir in CONTENT_DIRS:
        base = site_root / content_dir
        try:
            rel = file_path.relative_to(base)
        except ValueError:
            continue
        parts = list(rel.with_suffix("").parts)
        if parts and parts[-1] == "index":
            parts = parts[:-1]
        return "/" + "/".join(parts) + "/" if parts else "/"

    # Fallback : relatif à la racine
    try:
        rel = file_path.relative_to(site_root)
        parts = list(rel.with_suffix("").parts)
        if parts and parts[-1] == "index":
            parts = parts[:-1]
        return "/" + "/".join(parts) + "/" if parts else "/"
    except ValueError:
        return "/" + file_path.stem + "/"


def extract_links_from_body(body: str) -> list[dict]:
    """Extrait les liens internes du body markdown + JSX."""
    links = []
    seen_hrefs: dict[str, str] = {}

    def is_asset(href: str) -> bool:
        ext = "." + href.rsplit(".", 1)[-1].lower() if "." in href.split("/")[-1] else ""
        return ext in ASSET_EXTENSIONS

    # Markdown : [texte](/chemin)  ou  [texte](/chemin "title")
    for m in re.finditer(r'\[([^\]]+)\]\((/[^)\s"\'#?]*[^)\s"\']*)', body):
        anchor = m.group(1).strip()
        href_raw = m.group(2)
        if is_asset(href_raw):
            continue
        href = normalize_slug(href_raw)
        if href not in seen_hrefs:
            seen_hrefs[href] = anchor
        elif not seen_hrefs[href] and anchor:
            seen_hrefs[href] = anchor

    # JSX/HTML : href="/chemin"  (liens sans balise markdown visible)
    for m in re.finditer(r'href=["\']([^"\']+)["\']', body):
        href_raw = m.group(1)
        if not href_raw.startswith("/") or href_raw.startswith("//"):
            continue
        if is_asset(href_raw):
            continue
        href = normalize_slug(href_raw)
        if href not in seen_hrefs:
            seen_hrefs[href] = ""

    for href, anchor in seen_hrefs.items():
        links.append({
            "anchor": anchor,
            "href": href,
            "is_weak": anchor.lower() in WEAK_ANCHORS,
        })

    return links


# ---------------------------------------------------------------------------
# Crawler
# ---------------------------------------------------------------------------

def crawl_site(site_root: Path, content_dirs: list[str] | None = None) -> dict[str, dict]:
    """Parse les fichiers de contenu, retourne un dict slug → node.

    Mode Astro (auto-détecté via astro.config.mjs) : restreint la recherche à src/
    afin d'exclure docs/, .briefs/, linkedin/ racine et autres artefacts non-web.
    Passe --content-dirs pour surcharger manuellement.
    """
    nodes: dict[str, dict] = {}

    # Détermine les racines de recherche
    is_astro = (site_root / "astro.config.mjs").exists() or (site_root / "astro.config.ts").exists()
    if content_dirs:
        search_roots = [site_root / d for d in content_dirs]
        print(f"  [~] Mode manuel : {content_dirs}")
    elif is_astro:
        # .md/.mdx depuis src/content/, .astro depuis src/pages/ (gere plus bas)
        search_roots = [site_root / "src" / "content"]
        print("  [~] Site Astro detecte — .md/mdx depuis src/content/, .astro depuis src/pages/")
    else:
        search_roots = [site_root]

    all_files = []
    for root in search_roots:
        if not root.exists():
            print(f"  [!] Dossier introuvable : {root}")
            continue
        for ext in MDX_EXTENSIONS:
            # En mode Astro, les .astro ne sont des pages que dans src/pages/
            # (les layouts/components dans src/layouts/ ou src/components/ ne sont pas des routes)
            if ext == ".astro" and is_astro and not content_dirs:
                astro_pages_root = site_root / "src" / "pages"
                if astro_pages_root.exists():
                    all_files.extend(f for f in astro_pages_root.rglob("*.astro") if not should_skip_file(f))
            else:
                all_files.extend(f for f in root.rglob(f"*{ext}") if not should_skip_file(f))

    # Déduplique (un fichier peut matcher plusieurs extensions glob)
    all_files = list(dict.fromkeys(all_files))
    print(f"  [~] {len(all_files)} fichiers trouves")

    skipped_drafts = 0

    for file_path in all_files:
        is_astro_file = file_path.suffix == ".astro"

        if is_astro_file:
            # Les fichiers .astro ont un bloc --- avec du JS/TS, pas du YAML.
            # On extrait uniquement le template (après le 2e ---) pour les liens.
            try:
                raw = file_path.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            # Retire le script block Astro (--- JS code ---)
            body = re.sub(r"^---[\s\S]*?---\s*", "", raw, count=1)
            meta: dict = {}
            title = file_path.stem.replace("-", " ").title()
            category = "pages-statiques"
        else:
            try:
                post = fm_lib.load(str(file_path))
                meta = post.metadata or {}
                body = post.content or ""
            except Exception:
                try:
                    raw = file_path.read_text(encoding="utf-8", errors="ignore")
                    body = re.sub(r"^---\n.*?\n---\n", "", raw, flags=re.DOTALL)
                    meta = {}
                except Exception:
                    continue

            # Filtrage draft
            if meta.get("draft") is True:
                skipped_drafts += 1
                continue

            # Exclure les collections sans route Astro
            if is_astro and not content_dirs:
                collection = file_path.parent.name
                if collection in ASTRO_SKIP_COLLECTIONS:
                    continue

            title = str(meta.get("title") or meta.get("name") or file_path.stem)
            category = meta.get("category") or meta.get("categories") or ""
            if isinstance(category, list):
                category = category[0] if category else ""
            category = str(category)

        # Slug
        raw_slug = meta.get("slug") or meta.get("permalink") or ""
        if raw_slug:
            slug = normalize_slug(str(raw_slug) if str(raw_slug).startswith("/") else "/" + str(raw_slug))
        else:
            slug = derive_slug_from_path(file_path, site_root)

        tags = meta.get("tags") or []
        if isinstance(tags, str):
            tags = [tags]
        tags = [str(t) for t in tags]

        description = str(meta.get("description") or meta.get("excerpt") or "")[:250]

        # Liens internes
        links = extract_links_from_body(body)

        # Preview du body (sans markdown/JSX)
        clean = re.sub(r"[#*`\[\]_<>]", "", body)
        clean = re.sub(r"\s+", " ", clean).strip()[:200]

        nodes[slug] = {
            "slug": slug,
            "title": title,
            "file": str(file_path.relative_to(site_root)).replace("\\", "/"),
            "category": category,
            "tags": tags,
            "description": description,
            "body_preview": clean,
            "links": links,
        }

    if skipped_drafts:
        print(f"  [~] {skipped_drafts} drafts ignores (draft: true)")
    if is_astro and not content_dirs:
        skipped_cols = ASTRO_SKIP_COLLECTIONS
        if skipped_cols:
            print(f"  [~] Collections sans route ignorees : {', '.join(skipped_cols)}")

    return nodes


# ---------------------------------------------------------------------------
# Analyse
# ---------------------------------------------------------------------------

def analyze(nodes: dict) -> dict:
    all_slugs = set(nodes.keys())

    out_map: dict[str, list[str]] = defaultdict(list)
    in_map: dict[str, list[str]] = defaultdict(list)
    weak_map: dict[str, list[tuple[str, str]]] = defaultdict(list)
    broken_map: dict[str, list[str]] = defaultdict(list)

    for slug, node in nodes.items():
        for link in node["links"]:
            href = link["href"]
            is_internal = href in all_slugs

            if is_internal:
                out_map[slug].append(href)
                in_map[href].append(slug)
            elif not href.startswith("http") and href != "/" and len(href) > 1:
                broken_map[slug].append(href)

            if link["is_weak"] and link["anchor"] and is_internal:
                weak_map[slug].append((link["anchor"], href))

    orphans = sorted(
        slug for slug in all_slugs
        if not in_map[slug] and slug != "/"
    )

    no_outlinks = sorted(
        slug for slug in all_slugs
        if not out_map[slug]
    )

    categories: dict[str, list[str]] = defaultdict(list)
    for slug, node in nodes.items():
        cat = node["category"] or "sans-catégorie"
        categories[cat].append(slug)

    # Hub score = nb de liens entrants
    top_pages = sorted(
        ((slug, len(in_map[slug])) for slug in all_slugs),
        key=lambda x: -x[1]
    )[:15]

    # Liens croisés entre catégories
    cross_links: dict[tuple[str, str], int] = defaultdict(int)
    for slug, targets in out_map.items():
        src_cat = nodes[slug]["category"] or "sans-catégorie"
        for t in targets:
            dst_cat = nodes[t]["category"] or "sans-catégorie"
            if src_cat != dst_cat:
                cross_links[(src_cat, dst_cat)] += 1

    return {
        "total_pages": len(nodes),
        "total_links": sum(len(v) for v in out_map.values()),
        "orphans": orphans,
        "no_outlinks": no_outlinks,
        "weak_anchors": dict(weak_map),
        "broken_links": dict(broken_map),
        "in_map": dict(in_map),
        "out_map": dict(out_map),
        "categories": dict(categories),
        "top_pages": top_pages,
        "cross_links": {f"{a} → {b}": c for (a, b), c in cross_links.items()},
    }


# ---------------------------------------------------------------------------
# Rapport Markdown
# ---------------------------------------------------------------------------

def generate_report(nodes: dict, a: dict, site_root: Path) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    avg_links = a["total_links"] / max(a["total_pages"], 1)
    L = []

    L += [
        f"# Rapport de maillage interne",
        f"",
        f"**Site :** `{site_root}`  ",
        f"**Généré le :** {now}  ",
        f"**Pages analysées :** {a['total_pages']}  ",
        f"**Liens internes totaux :** {a['total_links']}  ",
        f"**Liens par page (moyenne) :** {avg_links:.1f}  ",
    ]

    # Santé globale
    def status(val: int, warn: int, crit: int) -> str:
        return "🔴" if val >= crit else "🟡" if val >= warn else "🟢"

    n = a["total_pages"]
    L += [
        "",
        "## Santé globale",
        "",
        "| Métrique | Valeur | % | État |",
        "|----------|--------|---|------|",
        f"| Pages orphelines (0 lien entrant) | {len(a['orphans'])} | {len(a['orphans'])/max(n,1)*100:.0f}% | {status(len(a['orphans']), n//10, n//5)} |",
        f"| Pages sans liens sortants | {len(a['no_outlinks'])} | {len(a['no_outlinks'])/max(n,1)*100:.0f}% | {status(len(a['no_outlinks']), n//10, n//5)} |",
        f"| Pages avec ancres faibles | {len(a['weak_anchors'])} | {len(a['weak_anchors'])/max(n,1)*100:.0f}% | {status(len(a['weak_anchors']), 3, 8)} |",
        f"| Pages avec liens cassés | {len(a['broken_links'])} | — | {'🔴' if a['broken_links'] else '🟢'} |",
    ]

    # Clusters sémantiques
    L += ["", "## Clusters sémantiques", ""]
    for cat, slugs in sorted(a["categories"].items(), key=lambda x: -len(x[1])):
        internal_links = sum(
            1 for s in slugs for t in a["out_map"].get(s, []) if t in set(slugs)
        )
        total_out = sum(len(a["out_map"].get(s, [])) for s in slugs)
        density = internal_links / max(total_out, 1) * 100
        orphans_in_cat = [s for s in slugs if s in set(a["orphans"])]

        L.append(f"### {cat} ({len(slugs)} pages · densité intra-cluster {density:.0f}%)")
        L.append("")
        L.append("| Slug | Titre | ← entrants | → sortants |")
        L.append("|------|-------|-----------|-----------|")
        for slug in sorted(slugs):
            node = nodes[slug]
            inc = len(a["in_map"].get(slug, []))
            out = len(a["out_map"].get(slug, []))
            flags = " 🔴" if slug in set(a["orphans"]) else ""
            L.append(f"| `{slug}` | {node['title']}{flags} | {inc} | {out} |")
        if orphans_in_cat:
            L.append(f"\n⚠️ {len(orphans_in_cat)} page(s) orpheline(s) dans ce cluster.")
        L.append("")

    # Liens croisés entre clusters
    if a["cross_links"]:
        L += ["## Liens inter-clusters", ""]
        for pair, count in sorted(a["cross_links"].items(), key=lambda x: -x[1])[:20]:
            L.append(f"- **{pair}** : {count} lien(s)")
        L.append("")

    # Orphelines
    L += ["## Pages orphelines (0 lien entrant)", ""]
    if a["orphans"]:
        L.append("Ces pages ne reçoivent aucun lien interne — invisibles pour le maillage et le PageRank.\n")
        for slug in a["orphans"]:
            node = nodes[slug]
            L.append(f"- `{slug}` — **{node['title']}** (`{node['file']}`)")
    else:
        L.append("✅ Aucune page orpheline.")
    L.append("")

    # Culs-de-sac
    L += ["## Culs-de-sac (0 lien sortant)", ""]
    if a["no_outlinks"]:
        L.append("Ces pages ne renvoient vers rien — le jus PageRank s'y accumule sans circuler.\n")
        for slug in a["no_outlinks"]:
            node = nodes[slug]
            inc = len(a["in_map"].get(slug, []))
            L.append(f"- `{slug}` — **{node['title']}** (←{inc}) | `{node['file']}`")
    else:
        L.append("✅ Toutes les pages ont au moins un lien sortant.")
    L.append("")

    # Ancres faibles
    L += ["## Ancres non optimisées", ""]
    if a["weak_anchors"]:
        L.append("Ces ancres n'ont pas de valeur sémantique pour Google (remplacer par des ancres descriptives).\n")
        for slug, weak_list in sorted(a["weak_anchors"].items()):
            node = nodes[slug]
            L.append(f"### `{slug}` — {node['title']}")
            for anchor, href in weak_list:
                L.append(f'- Ancre **"{anchor}"** → `{href}` _(remplacer par un texte descriptif)_')
            L.append("")
    else:
        L.append("✅ Aucune ancre générique détectée.")
    L.append("")

    # Liens cassés
    L += ["## Liens internes cassés", ""]
    if a["broken_links"]:
        L.append("Ces liens pointent vers des slugs absents du site (slug renommé, page supprimée, typo).\n")
        for slug, broken in sorted(a["broken_links"].items()):
            node = nodes[slug]
            L.append(f"### `{slug}` — {node['title']}")
            for href in broken:
                L.append(f"- `{href}` — slug introuvable")
            L.append("")
    else:
        L.append("✅ Aucun lien cassé.")
    L.append("")

    # Top hubs
    L += ["## Top pages (hubs de maillage)", ""]
    L.append("| # | Slug | Titre | ← entrants | → sortants |")
    L.append("|---|------|-------|-----------|-----------|")
    for i, (slug, score) in enumerate(a["top_pages"], 1):
        node = nodes.get(slug, {})
        out = len(a["out_map"].get(slug, []))
        L.append(f"| {i} | `{slug}` | {node.get('title', '?')} | {score} | {out} |")
    L.append("")

    # Suggestions IA
    L += [
        "## Suggestions pour l'IA",
        "",
        "Ce rapport est conçu pour être analysé par un LLM. Points d'attention recommandés :",
        "",
        "1. **Orphelines prioritaires** : lesquelles méritent des liens depuis les pages à fort trafic ?",
        "2. **Clusters sous-connectés** : quels clusters ont une densité intra < 30% ? Quelles pages pourraient se lier entre elles ?",
        "3. **Ancres à réécrire** : propose des ancres descriptives pour chaque lien faible listé ci-dessus.",
        "4. **Culs-de-sac** : quelles pages de la même catégorie pourraient être liées en bas d'article ?",
        "5. **Déséquilibre entrants/sortants** : pages avec beaucoup de liens entrants mais peu de sortants = PageRank bloqué.",
        "",
    ]

    # Détail complet
    L += ["## Détail complet par page", "", "<details><summary>Cliquer pour déplier</summary>", ""]
    for slug in sorted(nodes.keys()):
        node = nodes[slug]
        inc = a["in_map"].get(slug, [])
        out = a["out_map"].get(slug, [])
        L.append(f"### `{slug}`")
        L.append(f"**Titre :** {node['title']}  ")
        L.append(f"**Fichier :** `{node['file']}`  ")
        if node["category"]:
            L.append(f"**Catégorie :** {node['category']}  ")
        if node["tags"]:
            L.append(f"**Tags :** {', '.join(node['tags'])}  ")
        L.append(f"**Liens :** ←{len(inc)} entrants · →{len(out)} sortants")
        if node["description"]:
            L.append(f"\n> {node['description']}")
        if inc:
            L.append("\n**Reçoit des liens de :**")
            for s in inc[:8]:
                L.append(f"- `{s}`")
        if out:
            L.append("\n**Pointe vers :**")
            for link in [l for l in node["links"] if l["href"] in set(nodes.keys())][:8]:
                flag = " ⚠️" if link["is_weak"] and link["anchor"] else ""
                anchor = link["anchor"] or link["href"]
                L.append(f'- [{anchor}]({link["href"]}){flag}')
        L.append("")
    L.append("</details>")

    return "\n".join(L)


# ---------------------------------------------------------------------------
# Visualisation D3
# ---------------------------------------------------------------------------

def generate_d3_html(nodes: dict, a: dict) -> str:
    # Couleur par catégorie
    cats = list(a["categories"].keys())
    cat_color = {cat: CLUSTER_COLORS[i % len(CLUSTER_COLORS)] for i, cat in enumerate(cats)}

    orphan_set = set(a["orphans"])
    no_out_set = set(a["no_outlinks"])
    weak_set = set(a["weak_anchors"].keys())
    broken_set = set(a["broken_links"].keys())

    d3_nodes = []
    for slug, node in nodes.items():
        inc = len(a["in_map"].get(slug, []))
        cat = node["category"] or "sans-catégorie"
        color = cat_color.get(cat, "#94a3b8")
        if slug in orphan_set:
            color = "#ef4444"
        elif slug in no_out_set:
            color = "#f97316"
        d3_nodes.append({
            "id": slug,
            "title": node["title"],
            "category": cat,
            "color": color,
            "size": max(6, min(28, 6 + inc * 3)),
            "inLinks": inc,
            "outLinks": len(a["out_map"].get(slug, [])),
            "isOrphan": slug in orphan_set,
            "hasWeakAnchors": slug in weak_set,
            "hasBroken": slug in broken_set,
            "file": node["file"],
        })

    d3_edges = [
        {"source": src, "target": tgt}
        for src, targets in a["out_map"].items()
        for tgt in targets
        if tgt in nodes
    ]

    legend_items = "".join(
        f'<div class="leg-item"><span class="dot" style="background:{color}"></span><span>{cat}</span></div>'
        for cat, color in cat_color.items()
    )

    stats_summary = (
        f"{a['total_pages']} pages · "
        f"{a['total_links']} liens · "
        f"{len(a['orphans'])} orphelines · "
        f"{len(a['no_outlinks'])} culs-de-sac"
    )

    graph_json = json.dumps({"nodes": d3_nodes, "links": d3_edges}, ensure_ascii=False)

    return f"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Maillage — {len(nodes)} pages</title>
<style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
body {{ background:#0f172a; color:#e2e8f0; font-family:-apple-system,sans-serif; overflow:hidden; }}
svg {{ width:100vw; height:100vh; display:block; }}

#panel {{
  position:fixed; top:14px; left:14px; background:#1e293b; border:1px solid #334155;
  border-radius:10px; padding:14px 16px; width:220px; font-size:13px;
  box-shadow:0 4px 24px rgba(0,0,0,.5);
}}
#panel h3 {{ font-size:14px; color:#f8fafc; margin-bottom:10px; letter-spacing:.3px; }}
.stat {{ display:flex; justify-content:space-between; margin-bottom:5px; color:#94a3b8; }}
.stat b {{ color:#f1f5f9; }}
hr {{ border:none; border-top:1px solid #334155; margin:10px 0; }}
.leg-item {{ display:flex; align-items:center; gap:7px; margin-bottom:5px; font-size:12px; color:#cbd5e1; }}
.dot {{ width:9px; height:9px; border-radius:50%; flex-shrink:0; }}
#search {{
  width:100%; margin-top:10px; padding:6px 9px; background:#0f172a; border:1px solid #334155;
  border-radius:6px; color:#e2e8f0; font-size:13px; outline:none;
}}
#search:focus {{ border-color:#6366f1; }}

.tooltip {{
  position:fixed; background:#1e293b; border:1px solid #334155; border-radius:8px;
  padding:10px 13px; font-size:13px; pointer-events:none; opacity:0;
  transition:opacity .12s; max-width:270px; line-height:1.65;
  box-shadow:0 4px 20px rgba(0,0,0,.6); z-index:100;
}}
.tooltip .t-title {{ color:#f1f5f9; font-weight:600; margin-bottom:3px; }}
.tooltip .t-slug {{ color:#94a3b8; font-family:monospace; font-size:11px; }}
.tooltip .t-meta {{ color:#94a3b8; margin-top:6px; font-size:12px; }}
.badge {{
  display:inline-block; padding:1px 6px; border-radius:4px; font-size:11px;
  margin:3px 3px 0 0;
}}
.b-red {{ background:#ef4444; color:#fff; }}
.b-orange {{ background:#f97316; color:#fff; }}
.b-yellow {{ background:#eab308; color:#000; }}
.b-purple {{ background:#8b5cf6; color:#fff; }}
</style>
</head>
<body>
<div id="panel">
  <h3>🕸 Maillage interne</h3>
  <div class="stat"><span>{stats_summary}</span></div>
  <hr>
  <div id="legend">{legend_items}</div>
  <hr>
  <div class="stat"><span>🔴 Orphelines</span><b>{len(a['orphans'])}</b></div>
  <div class="stat"><span>🟠 Culs-de-sac</span><b>{len(a['no_outlinks'])}</b></div>
  <div class="stat"><span>⚠️ Ancres faibles</span><b>{len(a['weak_anchors'])}</b></div>
  <div class="stat"><span>💥 Liens cassés</span><b>{len(a['broken_links'])}</b></div>
  <input id="search" placeholder="Filtrer…" type="text">
</div>
<svg id="g"></svg>
<div class="tooltip" id="tip"></div>

<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script>
const DATA = {graph_json};

const svg = d3.select("#g");
let W = window.innerWidth, H = window.innerHeight;
svg.attr("viewBox", [0, 0, W, H]);

const g = svg.append("g");

const zoom = d3.zoom().scaleExtent([0.05, 6]).on("zoom", e => g.attr("transform", e.transform));
svg.call(zoom);

const sim = d3.forceSimulation(DATA.nodes)
  .force("link", d3.forceLink(DATA.links).id(d => d.id).distance(90).strength(0.25))
  .force("charge", d3.forceManyBody().strength(-250).distanceMax(400))
  .force("center", d3.forceCenter(W / 2, H / 2))
  .force("collide", d3.forceCollide(d => d.size + 10));

// Edges
const link = g.append("g")
  .attr("stroke", "#1e3a5f")
  .attr("stroke-opacity", 0.6)
  .selectAll("line")
  .data(DATA.links)
  .join("line")
  .attr("stroke-width", 1.2)
  .attr("marker-end", "url(#arrow)");

// Arrow marker
svg.append("defs").append("marker")
  .attr("id", "arrow")
  .attr("viewBox", "0 -4 8 8")
  .attr("refX", 12).attr("refY", 0)
  .attr("markerWidth", 5).attr("markerHeight", 5)
  .attr("orient", "auto")
  .append("path").attr("d", "M0,-4L8,0L0,4").attr("fill", "#334155");

// Nodes
const node = g.append("g")
  .selectAll(".nd")
  .data(DATA.nodes)
  .join("g")
  .attr("class", "nd")
  .call(d3.drag()
    .on("start", (e, d) => {{ if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }})
    .on("drag",  (e, d) => {{ d.fx = e.x; d.fy = e.y; }})
    .on("end",   (e, d) => {{ if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }}));

node.append("circle")
  .attr("r", d => d.size)
  .attr("fill", d => d.color)
  .attr("stroke", d => d.isOrphan ? "#fca5a5" : "#0f172a")
  .attr("stroke-width", d => d.isOrphan ? 2.5 : 1.5)
  .style("cursor", "pointer");

node.append("text")
  .attr("dy", d => d.size + 13)
  .attr("text-anchor", "middle")
  .attr("font-size", "10px")
  .attr("fill", "#64748b")
  .attr("pointer-events", "none")
  .text(d => d.title.length > 22 ? d.title.slice(0, 22) + "…" : d.title);

// Tooltip
const tip = document.getElementById("tip");

node.on("mouseover", (e, d) => {{
  const badges = [
    d.isOrphan      ? '<span class="badge b-red">orpheline</span>'    : "",
    d.outLinks === 0 ? '<span class="badge b-orange">cul-de-sac</span>' : "",
    d.hasWeakAnchors ? '<span class="badge b-yellow">ancres ⚠️</span>'  : "",
    d.hasBroken      ? '<span class="badge b-purple">liens cassés</span>' : "",
  ].join("");
  tip.style.opacity = 1;
  tip.innerHTML = `
    <div class="t-title">${{d.title}}</div>
    <div class="t-slug">${{d.id}}</div>
    <div class="t-meta">📂 ${{d.category}} &nbsp;·&nbsp; ← ${{d.inLinks}} &nbsp; → ${{d.outLinks}}</div>
    ${{badges ? `<div style="margin-top:4px">${{badges}}</div>` : ""}}
    <div class="t-meta" style="font-size:10px;margin-top:6px;color:#475569">${{d.file}}</div>
  `;
}})
.on("mousemove", e => {{
  tip.style.left = (e.clientX + 16) + "px";
  tip.style.top  = (e.clientY - 10) + "px";
}})
.on("mouseout", () => {{ tip.style.opacity = 0; }});

// Tick
sim.on("tick", () => {{
  link
    .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
    .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
  node.attr("transform", d => `translate(${{d.x}},${{d.y}})`);
}});

// Search
document.getElementById("search").addEventListener("input", function() {{
  const q = this.value.toLowerCase();
  node.select("circle").attr("opacity", d => !q || d.id.includes(q) || d.title.toLowerCase().includes(q) ? 1 : 0.08);
  node.select("text").attr("opacity",   d => !q || d.id.includes(q) || d.title.toLowerCase().includes(q) ? 1 : 0.05);
  link.attr("opacity", d =>
    !q || d.source.id?.includes(q) || d.target.id?.includes(q) ? 0.6 : 0.04);
}});

// Resize
window.addEventListener("resize", () => {{
  W = window.innerWidth; H = window.innerHeight;
  svg.attr("viewBox", [0, 0, W, H]);
  sim.force("center", d3.forceCenter(W / 2, H / 2)).alpha(0.1).restart();
}});
</script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Analyseur de maillage interne pour sites Astro/MDX"
    )
    parser.add_argument("site", help="Chemin vers la racine du site a analyser")
    parser.add_argument("--output", default="./linker-output", help="Dossier de sortie (defaut : ./linker-output)")
    parser.add_argument(
        "--content-dirs",
        default=None,
        help="Dossiers a scanner, separes par virgule (ex: src/content/blog,src/pages). "
             "Defaut : auto-detection Astro (src/) ou scan complet.",
    )
    args = parser.parse_args()

    site_root = Path(args.site).resolve()
    output_dir = Path(args.output).resolve()

    if not site_root.exists():
        sys.exit(f"[!] Site introuvable : {site_root}")

    content_dirs = [d.strip() for d in args.content_dirs.split(",")] if args.content_dirs else None

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n[*] Analyse de {site_root}")
    print("    Crawl en cours...")

    nodes = crawl_site(site_root, content_dirs=content_dirs)
    if not nodes:
        sys.exit("[!] Aucun fichier trouve. Verifie le chemin ou --content-dirs.")

    print("    Construction du graphe de liens...")
    analysis = analyze(nodes)

    n_orphans = len(analysis["orphans"])
    n_no_out  = len(analysis["no_outlinks"])
    n_weak    = len(analysis["weak_anchors"])
    n_broken  = len(analysis["broken_links"])

    print(f"\n[=] Resultats")
    print(f"    Pages           : {analysis['total_pages']}")
    print(f"    Liens internes  : {analysis['total_links']}")
    print(f"    Orphelines      : {n_orphans}")
    print(f"    Culs-de-sac     : {n_no_out}")
    print(f"    Ancres faibles  : {n_weak}")
    print(f"    Liens casses    : {n_broken}")

    # Rapport Markdown
    report_path = output_dir / "rapport-maillage.md"
    report_path.write_text(generate_report(nodes, analysis, site_root), encoding="utf-8")
    print(f"\n[+] Rapport Markdown  ->  {report_path}")

    # Visualisation D3
    html_path = output_dir / "graph.html"
    html_path.write_text(generate_d3_html(nodes, analysis), encoding="utf-8")
    print(f"[+] Graph D3          ->  {html_path}")

    # JSON brut (debug / extension future)
    json_path = output_dir / "graph-data.json"
    json_path.write_text(
        json.dumps({
            "nodes": nodes,
            "stats": {
                k: v for k, v in analysis.items()
                if k not in ("in_map", "out_map")
            },
        }, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"[+] JSON donnees      ->  {json_path}")

    print(f"\n[>] Ouvre le graphe : {html_path}\n")


if __name__ == "__main__":
    main()
