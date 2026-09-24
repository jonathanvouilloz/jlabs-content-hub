#!/usr/bin/env python3
"""Génère SEO-FLOW-PROCESS.html depuis SEO-FLOW-PROCESS.md (source de vérité).

Extrait du markdown, par scène :
  - le diagramme ```mermaid``` ;
  - le bloc de vulgarisation ```> 📖``` (liste de termes, chaque entrée
    `- **Terme** — explication. *Pourquoi :* raison du choix technique`) ;
  - la narration ```> 🎙️``` (à dire à l'écran).

Assemble un HTML autonome (Inter Tight, verts doux) qui rend les diagrammes
via mermaid CDN, avec lightbox plein écran (clic) et zoom (+/−).
Usage :
    python scripts/generate-flow-html.py            # light (défaut)
    python scripts/generate-flow-html.py --theme dark
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MD = ROOT / "docs" / "SEO-FLOW-PROCESS.md"
HTML = ROOT / "docs" / "SEO-FLOW-PROCESS.html"

# Palette Jon Labs — verts doux, végétaux, non fluorescents
THEMES = {
    "light": {
        "bg": "#f4f7f2",
        "bg_glow": "rgba(74,124,89,.10)",
        "surface": "#ffffff",
        "surface2": "#eef3ec",
        "text": "#1c2a20",
        "muted": "#5c6f60",
        "accent": "#4a7c59",
        "accent2": "#2f5c3d",
        "border": "#d8e2d6",
        "overlay": "rgba(28,42,32,.55)",
        "on_accent": "#ffffff",
        "cluster_bkg": "rgba(238,243,236,.85)",
        "edge_label_bg": "#ffffff",
        "legend_bg": "#f0f5ef",
        "why_bg": "#e9f1e8",
    },
    "dark": {
        "bg": "#0e1512",
        "bg_glow": "rgba(127,185,138,.08)",
        "surface": "#141d18",
        "surface2": "#1a2620",
        "text": "#dce8dd",
        "muted": "#8fa396",
        "accent": "#7fb98a",
        "accent2": "#a3d9a5",
        "border": "#2a3a30",
        "overlay": "rgba(8,12,10,.78)",
        "on_accent": "#0b120d",
        "cluster_bkg": "rgba(26,38,32,.6)",
        "edge_label_bg": "#1a2620",
        "legend_bg": "#18221c",
        "why_bg": "#1d2a22",
    },
}

# Marqueur de la raison technique dans une entrée de légende
WHY_MARK = "*Pourquoi :*"


def light_md(text: str) -> str:
    """Markdown léger : **gras** → <strong>, *italique* → <em>."""
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*(.+?)\*", r"<em>\1</em>", text)
    return text


def parse_md(text: str) -> list[dict]:
    """Découpe le markdown en sections : titre h2, diagramme, légende, narration."""
    sections = []
    lines = text.splitlines()
    i = 0
    current = {"title": "Document", "diagram": None, "legend": [], "narration": None}
    while i < len(lines):
        line = lines[i]
        if line.startswith("## "):
            if current.get("diagram") or current.get("legend") or current.get("narration"):
                sections.append(current)
            current = {"title": line[3:].strip(), "diagram": None, "legend": [], "narration": None}
        elif line.strip() == "```mermaid":
            buf = []
            i += 1
            while i < len(lines) and lines[i].strip() != "```":
                buf.append(lines[i])
                i += 1
            current["diagram"] = "\n".join(buf)
        elif "📖" in line:
            # Bloc de vulgarisation : lignes consécutives "> - **Terme** — explication."
            i += 1
            while i < len(lines):
                l = lines[i].strip()
                if l.startswith(">-"):
                    l = l[2:].strip()
                elif l.startswith(">"):
                    l = l[1:].strip()
                else:
                    break
                if not l.startswith("- "):
                    break
                entry = l[2:].strip()
                m = re.match(r"\*\*(.+?)\*\*\s*[—:–]\s*(.*)$", entry)
                if m:
                    terme, desc = m.group(1), m.group(2)
                    pourquoi = None
                    if WHY_MARK in desc:
                        desc, pourquoi = desc.split(WHY_MARK, 1)
                        desc = desc.strip().rstrip("—–- ").strip()
                        pourquoi = pourquoi.strip()
                    current["legend"].append(
                        {"terme": terme, "desc": light_md(desc), "pourquoi": light_md(pourquoi) if pourquoi else None}
                    )
                i += 1
            continue
        elif "🎙️" in line:
            narr = line.replace("> 🎙️ ", "").replace("> 🎙️", "").strip()
            current["narration"] = light_md(narr)
        i += 1
    if current.get("diagram") or current.get("legend") or current.get("narration"):
        sections.append(current)
    return sections


def render_html(sections: list[dict], theme: dict) -> str:
    cards = []
    toc = []
    for idx, s in enumerate(sections, 1):
        anchor = f"scene-{idx}"
        toc.append(f'<a class="toc-link" href="#{anchor}">{idx:02d} · {s["title"]}</a>')
        body = ""
        if s.get("diagram"):
            body += (
                '<div class="diagram-wrap">'
                f'<pre class="mermaid">{s["diagram"]}</pre>'
                '<button class="zoom-btn" type="button" aria-label="Agrandir">⤢</button>'
                '<span class="hint">clic = plein écran · zoom +/−</span>'
                "</div>"
            )
        if s.get("legend"):
            items = []
            for e in s["legend"]:
                why = (
                    f'<span class="lg-why">💡 {e["pourquoi"]}</span>'
                    if e.get("pourquoi")
                    else ""
                )
                items.append(
                    f'<div class="lg"><span class="lg-term">{e["terme"]}</span>'
                    f'<span class="lg-desc">{e["desc"]}</span>{why}</div>'
                )
            body += (
                '<div class="legend">'
                '<h3 class="legend-title">📖 Comprendre cette scène</h3>'
                f'<div class="legend-grid">{"".join(items)}</div></div>'
            )
        if s.get("narration"):
            body += (
                '<div class="narration">'
                f'<span class="mic">🎙️</span><div>{s["narration"]}</div></div>'
            )
        cards.append(
            f'<section class="card" id="{anchor}">'
            f'<h2><span class="num">{idx:02d}</span>{s["title"]}</h2>{body}</section>'
        )

    return f"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SEO Jon Labs — Architecture &amp; flux de travail</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {{
    --bg: {theme["bg"]}; --surface: {theme["surface"]}; --surface2: {theme["surface2"]};
    --text: {theme["text"]}; --muted: {theme["muted"]}; --accent: {theme["accent"]};
    --accent2: {theme["accent2"]}; --border: {theme["border"]};
    --on-accent: {theme["on_accent"]}; --overlay: {theme["overlay"]};
    --legend-bg: {theme["legend_bg"]}; --why-bg: {theme["why_bg"]};
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  html {{ scroll-behavior: smooth; }}
  body {{
    background: var(--bg);
    background-image: radial-gradient(1200px 600px at 80% -10%, {theme["bg_glow"]}, transparent 60%);
    color: var(--text);
    font-family: "Inter Tight", system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.55;
    padding: 40px 20px 80px;
  }}
  .wrap {{ max-width: 1500px; margin: 0 auto; }}
  header {{ text-align: center; margin-bottom: 12px; }}
  header h1 {{ font-size: clamp(26px, 4vw, 40px); font-weight: 800; letter-spacing: -.02em; }}
  header p {{ color: var(--muted); max-width: 860px; margin: 10px auto 0; font-size: 15px; }}
  .toc {{
    display: flex; flex-wrap: wrap; gap: 8px; justify-content: center;
    margin: 28px 0 8px; padding: 14px; background: var(--surface);
    border: 1px solid var(--border); border-radius: 16px;
  }}
  .toc-link {{
    color: var(--accent2); text-decoration: none; font-size: 13px; font-weight: 600;
    padding: 6px 12px; border-radius: 999px; background: var(--surface2);
    border: 1px solid var(--border); transition: .15s;
  }}
  .toc-link:hover {{ background: color-mix(in srgb, var(--accent) 14%, var(--surface2)); }}
  .card {{
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 20px; padding: 28px 28px 22px; margin-top: 26px;
  }}
  .card h2 {{
    display: flex; align-items: center; gap: 12px;
    font-size: 21px; font-weight: 700; letter-spacing: -.01em;
    margin-bottom: 18px;
  }}
  .num {{
    background: var(--accent); color: var(--on-accent); font-weight: 800;
    font-size: 13px; border-radius: 8px; padding: 3px 9px;
  }}
  .diagram-wrap {{ position: relative; margin: 8px 0 4px; }}
  .mermaid {{ display: flex; justify-content: center; cursor: zoom-in; }}
  .mermaid svg {{ max-width: 100%; height: auto; }}
  .zoom-btn {{
    position: absolute; top: 10px; right: 10px;
    background: var(--surface2); color: var(--text);
    border: 1px solid var(--border); border-radius: 10px;
    width: 36px; height: 36px; font-size: 17px; cursor: pointer;
    opacity: 0; transition: opacity .15s;
  }}
  .diagram-wrap:hover .zoom-btn {{ opacity: 1; }}
  .hint {{
    display: block; text-align: center; color: var(--muted);
    font-size: 12px; margin-top: 6px;
  }}

  /* Légende de vulgarisation */
  .legend {{
    background: var(--legend-bg); border: 1px solid var(--border);
    border-radius: 14px; padding: 18px 18px 12px; margin-top: 20px;
  }}
  .legend-title {{
    font-size: 14px; font-weight: 700; letter-spacing: .01em;
    color: var(--accent2); margin-bottom: 12px;
  }}
  .legend-grid {{
    display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
    gap: 10px;
  }}
  .lg {{
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 12px 14px; font-size: 13.5px;
    display: flex; flex-direction: column; gap: 4px;
  }}
  .lg-term {{ font-weight: 700; color: var(--accent2); font-size: 13.5px; }}
  .lg-desc {{ color: var(--text); }}
  .lg-why {{
    background: var(--why-bg); border-radius: 8px;
    padding: 6px 9px; font-size: 12.5px; color: var(--text);
    font-style: italic; margin-top: 2px;
  }}

  .narration {{
    display: flex; gap: 12px; align-items: flex-start;
    background: var(--surface2); border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 12px; padding: 14px 16px; margin-top: 18px;
    color: var(--text); font-size: 14.5px;
  }}
  .narration .mic {{ font-size: 18px; line-height: 1.3; }}
  footer {{ text-align: center; color: var(--muted); font-size: 12.5px; margin-top: 40px; }}
  footer a {{ color: var(--accent2); }}

  /* Lightbox plein écran */
  .lb {{
    position: fixed; inset: 0; z-index: 100;
    background: var(--overlay); backdrop-filter: blur(3px);
    display: none; flex-direction: column;
  }}
  .lb.open {{ display: flex; }}
  .lb-bar {{
    display: flex; align-items: center; gap: 10px;
    padding: 10px 16px; background: var(--surface);
    border-bottom: 1px solid var(--border);
  }}
  .lb-bar button {{
    background: var(--surface2); color: var(--text);
    border: 1px solid var(--border); border-radius: 10px;
    padding: 7px 14px; font-size: 14px; font-weight: 600; cursor: pointer;
    font-family: inherit;
  }}
  .lb-bar button:hover {{ background: color-mix(in srgb, var(--accent) 14%, var(--surface2)); }}
  .lb-scale {{ color: var(--muted); font-size: 13px; margin-left: auto; }}
  .lb-stage {{
    flex: 1; overflow: auto; padding: 28px;
    display: flex; align-items: flex-start; justify-content: flex-start;
  }}
  .lb-stage svg {{
    max-width: none; height: auto;
    transform-origin: 0 0; transition: transform .12s ease-out;
    background: var(--surface); border-radius: 8px;
  }}
  .lb-title {{ font-weight: 700; font-size: 14px; }}
  @media print {{
    body {{ background: #fff; color: #111; }}
    .card {{ break-inside: avoid; border-color: #ccc; background: #fff; }}
    .zoom-btn, .hint {{ display: none; }}
  }}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>SEO Jon Labs — comment ça tourne</h1>
    <p>La boucle complète : données Google → cockpit agentique → agents IA → validation humaine → mesure.
    Chaque scène = un diagramme complet, un bloc « comprendre » (vulgarisation + pourquoi des choix) et la narration.
    <strong>Clic sur un diagramme = plein écran, zoom +/−.</strong></p>
    <nav class="toc">{''.join(toc)}</nav>
  </header>
  {''.join(cards)}
  <footer>
    Source : <code>docs/SEO-FLOW-PROCESS.md</code> (éditer là, régénérer avec
    <code>scripts/generate-flow-html.py</code>) — les diagrammes sont rendus par
    <a href="https://mermaid.js.org" target="_blank" rel="noopener">Mermaid</a>.
  </footer>
</div>

<div class="lb" id="lb" role="dialog" aria-modal="true">
  <div class="lb-bar">
    <button type="button" id="lb-close" aria-label="Fermer">✕ Fermer</button>
    <button type="button" id="lb-zoom-out" aria-label="Zoom arrière">−</button>
    <button type="button" id="lb-zoom-in" aria-label="Zoom avant">+</button>
    <button type="button" id="lb-reset" aria-label="Réinitialiser">⤾ 100 %</button>
    <span class="lb-title" id="lb-title"></span>
    <span class="lb-scale" id="lb-scale">100 %</span>
  </div>
  <div class="lb-stage" id="lb-stage"></div>
</div>

<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({{
    startOnLoad: true,
    theme: "base",
    fontFamily: '"Inter Tight", system-ui, sans-serif',
    themeVariables: {{
      background: "{theme["surface"]}",
      primaryColor: "{theme["surface2"]}",
      primaryTextColor: "{theme["text"]}",
      primaryBorderColor: "{theme["accent"]}",
      secondaryColor: "{theme["surface2"]}",
      secondaryTextColor: "{theme["text"]}",
      secondaryBorderColor: "{theme["border"]}",
      tertiaryColor: "{theme["surface2"]}",
      tertiaryTextColor: "{theme["muted"]}",
      tertiaryBorderColor: "{theme["border"]}",
      lineColor: "{theme["accent"]}",
      textColor: "{theme["text"]}",
      fontColor: "{theme["text"]}",
      edgeLabelBackground: "{theme["edge_label_bg"]}",
      clusterBkg: "{theme["cluster_bkg"]}",
      clusterBorder: "{theme["border"]}",
      clusterTitleFontSize: "15px",
      nodeBorderRadius: "10px",
      fontSize: "16px"
    }},
    flowchart: {{ curve: "basis", htmlLabels: true, padding: 16 }},
    securityLevel: "loose"
  }});

  // Lightbox : clic sur un diagramme → plein écran + zoom
  const lb = document.getElementById("lb");
  const stage = document.getElementById("lb-stage");
  const lbTitle = document.getElementById("lb-title");
  const lbScale = document.getElementById("lb-scale");
  let scale = 1;
  let current = null;

  function applyScale() {{
    if (current) {{
      current.style.transform = `scale(${{scale}})`;
      lbScale.textContent = `${{Math.round(scale * 100)}} %`;
    }}
  }}

  function openLb(box) {{
    const svg = box.querySelector("svg");
    if (!svg) return;
    const clone = svg.cloneNode(true);
    const vb = svg.viewBox.baseVal;
    if (vb && vb.width) {{
      clone.setAttribute("width", vb.width);
      clone.setAttribute("height", vb.height);
    }}
    stage.replaceChildren(clone);
    current = clone;
    scale = 1;
    applyScale();
    const card = box.closest(".card");
    lbTitle.textContent = card ? card.querySelector("h2")?.textContent?.replace(/^\\d+\\s*/, "") ?? "" : "";
    lb.classList.add("open");
    document.body.style.overflow = "hidden";
  }}

  function closeLb() {{
    lb.classList.remove("open");
    document.body.style.overflow = "";
    stage.replaceChildren();
    current = null;
  }}

  document.querySelectorAll(".diagram-wrap").forEach(wrap => {{
    const box = wrap.querySelector(".mermaid");
    const btn = wrap.querySelector(".zoom-btn");
    if (!box) return;
    box.addEventListener("click", () => openLb(box));
    btn.addEventListener("click", e => {{ e.stopPropagation(); openLb(box); }});
  }});

  document.getElementById("lb-close").addEventListener("click", closeLb);
  document.getElementById("lb-zoom-in").addEventListener("click", () => {{ scale *= 1.3; applyScale(); }});
  document.getElementById("lb-zoom-out").addEventListener("click", () => {{ scale /= 1.3; applyScale(); }});
  document.getElementById("lb-reset").addEventListener("click", () => {{ scale = 1; applyScale(); }});
  lb.addEventListener("click", e => {{ if (e.target === lb) closeLb(); }});
  document.addEventListener("keydown", e => {{ if (e.key === "Escape") closeLb(); }});
</script>
</body>
</html>
"""


def main() -> None:
    theme_name = "light"
    if "--theme" in sys.argv:
        i = sys.argv.index("--theme")
        theme_name = sys.argv[i + 1] if i + 1 < len(sys.argv) else "light"
    if theme_name not in THEMES:
        raise SystemExit(f"Theme inconnu : {theme_name} (dispo : {', '.join(THEMES)})")
    text = MD.read_text(encoding="utf-8")
    sections = parse_md(text)
    if not sections:
        raise SystemExit("Aucune section mermaid/narration trouvée dans le markdown.")
    HTML.write_text(render_html(sections, THEMES[theme_name]), encoding="utf-8")
    n_diag = sum(1 for s in sections if s.get("diagram"))
    n_leg = sum(1 for s in sections if s.get("legend"))
    n_narr = sum(1 for s in sections if s.get("narration"))
    n_terms = sum(len(s.get("legend") or []) for s in sections)
    print(f"OK → {HTML} (theme: {theme_name})")
    print(f"  {len(sections)} sections · {n_diag} diagrammes · {n_leg} légendes ({n_terms} termes) · {n_narr} narrations")


if __name__ == "__main__":
    main()
