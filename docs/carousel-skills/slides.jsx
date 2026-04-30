// Slides for Barber Concept Media carousel
// 3 directions × 6 slides each
// Format Story 1080x1920 rendered at scale via CSS transform in artboard

// ─── Tokens ───────────────────────────────────────────────────
const BC = {
  ink: '#0a0a0a',        // deep black
  bone: '#f4f0e8',       // warm bone / off-white
  paper: '#ebe4d4',      // slightly darker paper
  brass: '#b08d57',      // brass/gold accent
  brassHi: '#d4a96a',    // lighter brass
  muted: '#6b6660',
  line: 'rgba(10,10,10,0.12)',
  lineOnInk: 'rgba(244,240,232,0.18)',
};

const FONTS = {
  display: '"Fraunces", "Playfair Display", Georgia, serif',
  sans: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
  mono: '"JetBrains Mono", "SF Mono", Menlo, monospace',
};

// ─── Frame ────────────────────────────────────────────────────
// The actual story is 1080×1920; we render at that size and let the
// Artboard shrink via transform.
const STORY_W = 1080;
const STORY_H = 1920;

function StoryFrame({ bg = BC.bone, ink = BC.ink, children, paginator, idx, total, brand = true }) {
  return (
    <div style={{
      width: STORY_W, height: STORY_H,
      background: bg, color: ink,
      position: 'relative', overflow: 'hidden',
      fontFamily: FONTS.sans,
    }}>
      {/* safe-zone guides (invisible in design, useful for you) */}
      {/* top bar: brand + paginator */}
      {brand && (
        <div style={{
          position: 'absolute', top: 80, left: 80, right: 80,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          fontFamily: FONTS.mono, fontSize: 22, letterSpacing: 1.5,
          textTransform: 'uppercase',
          color: ink, opacity: 0.7,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <BCLogo color={ink} size={28} />
            <span>Barber Concept Media</span>
          </div>
          {paginator !== false && (
            <span>{String(idx).padStart(2,'0')} / {String(total).padStart(2,'0')}</span>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

// Simple brand mark — razor glyph + initials
function BCLogo({ color = BC.ink, size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="15" stroke={color} strokeWidth="1.5"/>
      <path d="M10 22 L22 10 M10 10 L22 22" stroke={color} strokeWidth="1.5"/>
      <circle cx="16" cy="16" r="3" fill={color}/>
    </svg>
  );
}

// ─── Abstract shapes ─────────────────────────────────────────
function OrbShape({ size = 400, color = BC.brass, style }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `radial-gradient(circle at 35% 30%, ${color}ee, ${color}22 70%)`,
      ...style,
    }}/>
  );
}

function RingShape({ size = 400, color = BC.brass, thickness = 2, style }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      border: `${thickness}px solid ${color}`,
      ...style,
    }}/>
  );
}

function GridBg({ color = BC.ink, opacity = 0.05 }) {
  const svg = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Cpath d='M60 0H0v60' stroke='${encodeURIComponent(color)}' stroke-width='1' fill='none'/%3E%3C/svg%3E")`;
  return (
    <div style={{
      position: 'absolute', inset: 0,
      backgroundImage: svg, backgroundSize: '60px 60px',
      opacity,
      pointerEvents: 'none',
    }}/>
  );
}

// ─── CTA card (shared) ───────────────────────────────────────
function CTABlock({ copy, ink = BC.ink, accent = BC.brass, buttonLabel }) {
  return (
    <div style={{
      position: 'absolute', left: 80, right: 80, bottom: 120,
      display: 'flex', flexDirection: 'column', gap: 32,
    }}>
      <div style={{
        fontFamily: FONTS.display,
        fontSize: 84, lineHeight: 0.95, letterSpacing: -2,
        color: ink,
        fontWeight: 400,
      }}>
        {copy}
      </div>
      <div style={{
        background: ink, color: BC.bone,
        padding: '36px 48px', borderRadius: 4,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontFamily: FONTS.sans, fontWeight: 600, fontSize: 32,
        letterSpacing: -0.3,
      }}>
        <span>{buttonLabel}</span>
        <span style={{
          width: 56, height: 56, borderRadius: '50%',
          background: accent, color: ink,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 28, fontWeight: 700,
        }}>→</span>
      </div>
      <div style={{
        fontFamily: FONTS.mono, fontSize: 20, letterSpacing: 1,
        color: ink, opacity: 0.5, textTransform: 'uppercase',
        textAlign: 'center',
      }}>
        barbermedia.ch · Genève · Lausanne · Sion
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DIRECTION A — "PROOF-DRIVEN"
// Stats-first. Each slide a single massive number.
// Light bone background, serif numerals, brass accent.
// ═══════════════════════════════════════════════════════════════

function A_Slide({ idx, total, eyebrow, stat, unit, description, bg = BC.bone, ink = BC.ink, accent = BC.brass, copy }) {
  return (
    <StoryFrame idx={idx} total={total} bg={bg} ink={ink}>
      <GridBg color={ink} opacity={0.04}/>

      {/* eyebrow */}
      <div style={{
        position: 'absolute', top: 280, left: 80, right: 80,
        fontFamily: FONTS.mono, fontSize: 28, letterSpacing: 3,
        textTransform: 'uppercase', color: ink, opacity: 0.55,
      }}>
        {eyebrow}
      </div>

      {/* big stat */}
      <div style={{
        position: 'absolute', top: 380, left: 80, right: 80,
        fontFamily: FONTS.display,
        fontSize: 420, lineHeight: 0.82,
        letterSpacing: -18,
        fontWeight: 300,
        color: ink,
        fontFeatureSettings: '"lnum", "tnum"',
      }}>
        {stat}
        {unit && <span style={{
          fontSize: 120, letterSpacing: -4, color: accent,
          marginLeft: 8,
        }}>{unit}</span>}
      </div>

      {/* supporting copy */}
      <div style={{
        position: 'absolute', bottom: 380, left: 80, right: 80,
        fontFamily: FONTS.sans, fontSize: 42, lineHeight: 1.25,
        letterSpacing: -0.5, fontWeight: 400,
        color: ink, maxWidth: 820,
      }}>
        {description}
      </div>

      {/* accent rule */}
      <div style={{
        position: 'absolute', bottom: 340, left: 80,
        width: 120, height: 4, background: accent,
      }}/>

      {/* footer pager */}
      <div style={{
        position: 'absolute', bottom: 120, left: 80, right: 80,
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        fontFamily: FONTS.mono, fontSize: 22, color: ink, opacity: 0.55,
        letterSpacing: 1, textTransform: 'uppercase',
      }}>
        <span>{copy || 'Swipe →'}</span>
        <div style={{ display: 'flex', gap: 10 }}>
          {Array.from({ length: total }).map((_, i) => (
            <div key={i} style={{
              width: i + 1 === idx ? 32 : 8, height: 8,
              background: i + 1 === idx ? ink : ink,
              opacity: i + 1 === idx ? 1 : 0.2,
              borderRadius: 4, transition: 'all .2s',
            }}/>
          ))}
        </div>
      </div>
    </StoryFrame>
  );
}

function A_Slide1_Hero({ idx, total, copy }) {
  return (
    <StoryFrame idx={idx} total={total} bg={BC.ink} ink={BC.bone}>
      <GridBg color={BC.bone} opacity={0.08}/>

      {/* brass orb behind */}
      <div style={{ position: 'absolute', top: -160, right: -160 }}>
        <OrbShape size={900} color={BC.brass}/>
      </div>

      <div style={{
        position: 'absolute', top: 560, left: 80, right: 80,
      }}>
        <div style={{
          fontFamily: FONTS.mono, fontSize: 28, letterSpacing: 4,
          textTransform: 'uppercase', color: BC.brass, marginBottom: 48,
        }}>
          Édition 2026 — Le guide
        </div>
        <h1 style={{
          fontFamily: FONTS.display,
          fontSize: 180, lineHeight: 0.88, letterSpacing: -6,
          fontWeight: 300,
          color: BC.bone, margin: 0,
        }}>
          Toucher <br/>
          <em style={{ color: BC.brassHi, fontStyle: 'italic' }}>un homme</em><br/>
          qui écoute.
        </h1>
        <div style={{
          marginTop: 56,
          fontFamily: FONTS.sans, fontSize: 36, lineHeight: 1.3,
          color: BC.bone, opacity: 0.75, maxWidth: 820,
          letterSpacing: -0.2,
        }}>
          {copy || 'Le guide complet de la publicité locale en salons de barbier — Suisse romande.'}
        </div>
      </div>

      {/* bottom rail */}
      <div style={{
        position: 'absolute', bottom: 120, left: 80, right: 80,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontFamily: FONTS.mono, fontSize: 22, color: BC.bone, opacity: 0.6,
        letterSpacing: 1.5, textTransform: 'uppercase',
        paddingTop: 32, borderTop: `1px solid ${BC.lineOnInk}`,
      }}>
        <span>barbermedia.ch</span>
        <span>Swipe pour découvrir →</span>
      </div>
    </StoryFrame>
  );
}

function A_Slide6_CTA({ idx, total, copy }) {
  return (
    <StoryFrame idx={idx} total={total} bg={BC.bone} ink={BC.ink}>
      <GridBg color={BC.ink} opacity={0.05}/>

      {/* brass arc */}
      <div style={{ position: 'absolute', top: -400, left: -200 }}>
        <RingShape size={1200} color={BC.brass} thickness={1}/>
      </div>
      <div style={{ position: 'absolute', top: -250, left: -50 }}>
        <RingShape size={900} color={BC.brass} thickness={1}/>
      </div>

      <div style={{
        position: 'absolute', top: 380, left: 80, right: 80,
      }}>
        <div style={{
          fontFamily: FONTS.mono, fontSize: 28, letterSpacing: 4,
          textTransform: 'uppercase', color: BC.brass, marginBottom: 48,
        }}>
          06 — Passez à l'action
        </div>
        <h2 style={{
          fontFamily: FONTS.display,
          fontSize: 140, lineHeight: 0.9, letterSpacing: -4,
          fontWeight: 300, color: BC.ink, margin: 0,
        }}>
          Le guide <br/>
          <em style={{ fontStyle: 'italic', color: BC.brass }}>gratuit</em>
          <span style={{ color: BC.ink }}>, </span><br/>
          chez vous <br/>
          en 10 secondes.
        </h2>
      </div>

      <div style={{
        position: 'absolute', bottom: 360, left: 80, right: 80,
        fontFamily: FONTS.sans, fontSize: 34, lineHeight: 1.3,
        color: BC.ink, opacity: 0.75, letterSpacing: -0.2,
      }}>
        {copy || '32 pages · benchmarks sectoriels · grille tarifaire · checklist créative.'}
      </div>

      {/* CTA button */}
      <div style={{
        position: 'absolute', bottom: 140, left: 80, right: 80,
        background: BC.ink, color: BC.bone,
        padding: '44px 56px', borderRadius: 4,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontFamily: FONTS.sans, fontWeight: 600, fontSize: 40,
        letterSpacing: -0.5,
      }}>
        <span>Télécharger le guide</span>
        <div style={{
          width: 72, height: 72, borderRadius: '50%',
          background: BC.brass, color: BC.ink,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 36, fontWeight: 700,
        }}>→</div>
      </div>
    </StoryFrame>
  );
}

// ═══════════════════════════════════════════════════════════════
// DIRECTION B — "ANTI-SCROLL"
// Opposition classique vs Barber. Split layouts, strikethrough.
// ═══════════════════════════════════════════════════════════════

function B_Slide_Split({ idx, total, eyebrow, badLabel, badStat, badNote, goodLabel, goodStat, goodNote, copy }) {
  return (
    <StoryFrame idx={idx} total={total} bg={BC.bone} ink={BC.ink}>
      <div style={{
        position: 'absolute', top: 260, left: 80, right: 80,
        fontFamily: FONTS.mono, fontSize: 26, letterSpacing: 3,
        textTransform: 'uppercase', color: BC.muted,
      }}>
        {eyebrow}
      </div>

      {/* BAD half — paper, struck through */}
      <div style={{
        position: 'absolute', top: 360, left: 80, right: 80, height: 560,
        background: BC.paper, padding: '48px 56px',
        borderRadius: 4,
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      }}>
        <div style={{
          fontFamily: FONTS.mono, fontSize: 24, letterSpacing: 2,
          textTransform: 'uppercase', color: BC.muted,
          display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <span style={{
            width: 12, height: 12, borderRadius: 6, background: '#c44',
          }}/>
          {badLabel}
        </div>
        <div style={{
          fontFamily: FONTS.display, fontSize: 180, lineHeight: 0.9,
          letterSpacing: -6, fontWeight: 300, color: BC.muted,
          textDecoration: 'line-through',
          textDecorationColor: '#c44',
          textDecorationThickness: 6,
        }}>
          {badStat}
        </div>
        <div style={{
          fontFamily: FONTS.sans, fontSize: 30, lineHeight: 1.3,
          color: BC.muted, letterSpacing: -0.2,
        }}>
          {badNote}
        </div>
      </div>

      {/* GOOD half — ink, confident */}
      <div style={{
        position: 'absolute', top: 960, left: 80, right: 80, height: 560,
        background: BC.ink, color: BC.bone,
        padding: '48px 56px', borderRadius: 4,
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      }}>
        <div style={{
          fontFamily: FONTS.mono, fontSize: 24, letterSpacing: 2,
          textTransform: 'uppercase', color: BC.brass,
          display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <span style={{
            width: 12, height: 12, borderRadius: 6, background: BC.brass,
          }}/>
          {goodLabel}
        </div>
        <div style={{
          fontFamily: FONTS.display, fontSize: 200, lineHeight: 0.88,
          letterSpacing: -8, fontWeight: 400, color: BC.bone,
        }}>
          {goodStat}
        </div>
        <div style={{
          fontFamily: FONTS.sans, fontSize: 32, lineHeight: 1.3,
          color: BC.bone, opacity: 0.85, letterSpacing: -0.2,
        }}>
          {goodNote}
        </div>
      </div>

      {/* pager */}
      <div style={{
        position: 'absolute', bottom: 120, left: 80, right: 80,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontFamily: FONTS.mono, fontSize: 22, color: BC.ink, opacity: 0.6,
        letterSpacing: 1, textTransform: 'uppercase',
      }}>
        <span>{copy || 'Comparez →'}</span>
        <div style={{ display: 'flex', gap: 10 }}>
          {Array.from({ length: total }).map((_, i) => (
            <div key={i} style={{
              width: i + 1 === idx ? 32 : 8, height: 8,
              background: BC.ink,
              opacity: i + 1 === idx ? 1 : 0.2,
              borderRadius: 4,
            }}/>
          ))}
        </div>
      </div>
    </StoryFrame>
  );
}

function B_Slide1_Hero({ idx, total, copy }) {
  return (
    <StoryFrame idx={idx} total={total} bg={BC.bone} ink={BC.ink}>
      <GridBg color={BC.ink} opacity={0.04}/>

      <div style={{
        position: 'absolute', top: 480, left: 80, right: 80,
      }}>
        <div style={{
          fontFamily: FONTS.mono, fontSize: 28, letterSpacing: 4,
          textTransform: 'uppercase', color: BC.brass, marginBottom: 64,
        }}>
          Publicité locale · 2026
        </div>
        <h1 style={{
          fontFamily: FONTS.display, margin: 0,
          fontSize: 220, lineHeight: 0.85, letterSpacing: -8,
          fontWeight: 300,
        }}>
          Votre pub
          <br/>
          <span style={{ position: 'relative' }}>
            scrollée.
            <svg style={{
              position: 'absolute', left: -10, right: -10, top: '40%',
              width: 'calc(100% + 20px)', height: 40,
            }} viewBox="0 0 600 40" preserveAspectRatio="none">
              <path d="M5 25 Q 150 5, 300 20 T 595 18" stroke={BC.brass} strokeWidth="8" fill="none" strokeLinecap="round"/>
            </svg>
          </span>
          <br/>
          <em style={{ fontStyle: 'italic' }}>ou vue ?</em>
        </h1>

        <div style={{
          marginTop: 72,
          fontFamily: FONTS.sans, fontSize: 36, lineHeight: 1.3,
          color: BC.ink, opacity: 0.75, maxWidth: 840,
          letterSpacing: -0.2,
        }}>
          {copy || 'On vous paie en impressions. Nous, on facture des regards.'}
        </div>
      </div>

      <div style={{
        position: 'absolute', bottom: 120, left: 80, right: 80,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontFamily: FONTS.mono, fontSize: 22, color: BC.ink, opacity: 0.6,
        letterSpacing: 1.5, textTransform: 'uppercase',
        paddingTop: 32, borderTop: `1px solid ${BC.line}`,
      }}>
        <span>Le guide — 01/06</span>
        <span>Swipe →</span>
      </div>
    </StoryFrame>
  );
}

function B_Slide6_CTA({ idx, total, copy }) {
  return (
    <StoryFrame idx={idx} total={total} bg={BC.ink} ink={BC.bone}>
      <div style={{ position: 'absolute', top: -300, right: -300 }}>
        <OrbShape size={1100} color={BC.brass}/>
      </div>
      <GridBg color={BC.bone} opacity={0.06}/>

      <div style={{
        position: 'absolute', top: 420, left: 80, right: 80,
      }}>
        <div style={{
          fontFamily: FONTS.mono, fontSize: 28, letterSpacing: 4,
          textTransform: 'uppercase', color: BC.brassHi, marginBottom: 56,
        }}>
          Le guide complet · offert
        </div>
        <h2 style={{
          fontFamily: FONTS.display, margin: 0,
          fontSize: 160, lineHeight: 0.88, letterSpacing: -5,
          fontWeight: 300, color: BC.bone,
        }}>
          Arrêtez <br/>
          de payer <br/>
          <em style={{ fontStyle: 'italic', color: BC.brassHi }}>des bots.</em>
        </h2>
        <div style={{
          marginTop: 64,
          fontFamily: FONTS.sans, fontSize: 34, lineHeight: 1.3,
          color: BC.bone, opacity: 0.8, maxWidth: 860,
          letterSpacing: -0.2,
        }}>
          {copy || 'Recevez le guide 2026 de la publicité locale en Suisse romande. 32 pages, benchmarks, tarifs.'}
        </div>
      </div>

      <div style={{
        position: 'absolute', bottom: 140, left: 80, right: 80,
        background: BC.brass, color: BC.ink,
        padding: '44px 56px', borderRadius: 4,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontFamily: FONTS.sans, fontWeight: 700, fontSize: 40,
        letterSpacing: -0.5,
      }}>
        <span>Télécharger le guide</span>
        <div style={{
          width: 72, height: 72, borderRadius: '50%',
          background: BC.ink, color: BC.brass,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 36, fontWeight: 700,
        }}>→</div>
      </div>
    </StoryFrame>
  );
}

// ═══════════════════════════════════════════════════════════════
// DIRECTION C — "EDITORIAL"
// Magazine-style. Typo XL italique, numérotation romaine, rails.
// ═══════════════════════════════════════════════════════════════

function C_Slide({ idx, total, roman, kicker, headline, body, cite, accent = BC.brass, copy }) {
  return (
    <StoryFrame idx={idx} total={total} bg={BC.bone} ink={BC.ink} paginator={false}>
      {/* vertical rule */}
      <div style={{
        position: 'absolute', left: 80, top: 220, bottom: 220,
        width: 1, background: BC.line,
      }}/>

      {/* roman numeral */}
      <div style={{
        position: 'absolute', top: 260, left: 120,
        fontFamily: FONTS.display, fontStyle: 'italic',
        fontSize: 48, color: BC.ink, opacity: 0.4,
        letterSpacing: -1,
      }}>
        {roman}
      </div>

      {/* kicker */}
      <div style={{
        position: 'absolute', top: 340, left: 120, right: 80,
        fontFamily: FONTS.mono, fontSize: 26, letterSpacing: 3,
        textTransform: 'uppercase', color: accent,
      }}>
        {kicker}
      </div>

      {/* headline */}
      <div style={{
        position: 'absolute', top: 420, left: 120, right: 80,
      }}>
        <h2 style={{
          fontFamily: FONTS.display, margin: 0,
          fontSize: 140, lineHeight: 0.92, letterSpacing: -4,
          fontWeight: 300, color: BC.ink,
        }}>
          {headline}
        </h2>
      </div>

      {/* body */}
      <div style={{
        position: 'absolute', bottom: 480, left: 120, right: 120,
        fontFamily: FONTS.display, fontStyle: 'italic',
        fontSize: 42, lineHeight: 1.35, color: BC.ink,
        letterSpacing: -0.3, maxWidth: 820,
      }}>
        {body}
      </div>

      {/* cite */}
      {cite && (
        <div style={{
          position: 'absolute', bottom: 380, left: 120, right: 80,
          fontFamily: FONTS.mono, fontSize: 22, letterSpacing: 2,
          textTransform: 'uppercase', color: BC.muted,
        }}>
          — {cite}
        </div>
      )}

      {/* footer rail */}
      <div style={{
        position: 'absolute', bottom: 120, left: 80, right: 80,
        paddingTop: 32, borderTop: `1px solid ${BC.line}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontFamily: FONTS.mono, fontSize: 22, letterSpacing: 1.5,
        textTransform: 'uppercase', color: BC.ink, opacity: 0.6,
      }}>
        <span>Barber Concept Media · Le Guide</span>
        <span>{String(idx).padStart(2,'0')}/{String(total).padStart(2,'0')}</span>
      </div>
    </StoryFrame>
  );
}

function C_Slide1_Cover({ idx, total, copy }) {
  return (
    <StoryFrame idx={idx} total={total} bg={BC.bone} ink={BC.ink} paginator={false}>
      {/* top masthead */}
      <div style={{
        position: 'absolute', top: 80, left: 80, right: 80,
        paddingBottom: 24, borderBottom: `1px solid ${BC.line}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        fontFamily: FONTS.mono, fontSize: 22, letterSpacing: 2,
        textTransform: 'uppercase',
      }}>
        <span style={{ fontWeight: 700 }}>Barber Concept · Media</span>
        <span style={{ opacity: 0.6 }}>N° 01 · 2026</span>
      </div>

      {/* ISSUE / CHF / PAGES rail */}
      <div style={{
        position: 'absolute', top: 180, left: 80, right: 80,
        display: 'flex', justifyContent: 'space-between',
        fontFamily: FONTS.mono, fontSize: 20, letterSpacing: 1.5,
        color: BC.muted, textTransform: 'uppercase',
      }}>
        <span>Genève · Lausanne · Sion</span>
        <span>Gratuit · 32 pages</span>
      </div>

      {/* giant headline */}
      <div style={{
        position: 'absolute', top: 380, left: 80, right: 80,
      }}>
        <div style={{
          fontFamily: FONTS.display, fontStyle: 'italic',
          fontSize: 56, color: BC.brass, marginBottom: 32,
          letterSpacing: -1,
        }}>
          Le guide
        </div>
        <h1 style={{
          fontFamily: FONTS.display, margin: 0,
          fontSize: 280, lineHeight: 0.82, letterSpacing: -12,
          fontWeight: 300, color: BC.ink,
        }}>
          Parler <br/>
          aux <br/>
          <em style={{ fontStyle: 'italic' }}>hommes</em>.
        </h1>
      </div>

      {/* sub */}
      <div style={{
        position: 'absolute', bottom: 340, left: 80, right: 80,
        fontFamily: FONTS.sans, fontSize: 38, lineHeight: 1.3,
        color: BC.ink, opacity: 0.75, maxWidth: 820,
        letterSpacing: -0.3,
      }}>
        {copy || 'Comment les commerces locaux de Suisse romande captent une audience masculine, 30 minutes d\'affilée, sans AdBlocker.'}
      </div>

      {/* bottom rail */}
      <div style={{
        position: 'absolute', bottom: 120, left: 80, right: 80,
        paddingTop: 32, borderTop: `1px solid ${BC.line}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontFamily: FONTS.mono, fontSize: 22, letterSpacing: 2,
        textTransform: 'uppercase', color: BC.ink,
      }}>
        <span>Édition inaugurale</span>
        <span style={{ color: BC.brass }}>Swipe →</span>
      </div>
    </StoryFrame>
  );
}

function C_Slide6_CTA({ idx, total, copy }) {
  return (
    <StoryFrame idx={idx} total={total} bg={BC.bone} ink={BC.ink} paginator={false}>
      {/* top masthead */}
      <div style={{
        position: 'absolute', top: 80, left: 80, right: 80,
        paddingBottom: 24, borderBottom: `1px solid ${BC.line}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        fontFamily: FONTS.mono, fontSize: 22, letterSpacing: 2,
        textTransform: 'uppercase',
      }}>
        <span style={{ fontWeight: 700 }}>Dernière page</span>
        <span style={{ opacity: 0.6 }}>Colophon · 06</span>
      </div>

      <div style={{
        position: 'absolute', top: 320, left: 80, right: 80,
      }}>
        <div style={{
          fontFamily: FONTS.display, fontStyle: 'italic',
          fontSize: 48, color: BC.brass, marginBottom: 24,
        }}>
          Pour conclure —
        </div>
        <h2 style={{
          fontFamily: FONTS.display, margin: 0,
          fontSize: 170, lineHeight: 0.88, letterSpacing: -5,
          fontWeight: 300, color: BC.ink,
        }}>
          Emportez <br/>
          le guide <br/>
          <em style={{ fontStyle: 'italic' }}>chez vous.</em>
        </h2>
      </div>

      <div style={{
        position: 'absolute', bottom: 460, left: 80, right: 80,
        fontFamily: FONTS.display, fontStyle: 'italic',
        fontSize: 40, lineHeight: 1.35, color: BC.ink,
        letterSpacing: -0.3, opacity: 0.85,
      }}>
        {copy || '32 pages d\'analyses, benchmarks sectoriels, grille tarifaire complète et checklist créative pour vos visuels 1920×1080.'}
      </div>

      {/* CTA — bordered, not filled */}
      <div style={{
        position: 'absolute', bottom: 200, left: 80, right: 80,
        border: `2px solid ${BC.ink}`,
        padding: '40px 48px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontFamily: FONTS.display, fontStyle: 'italic', fontWeight: 400,
        fontSize: 44, letterSpacing: -0.5, color: BC.ink,
      }}>
        <span>Télécharger le guide</span>
        <div style={{
          width: 72, height: 72, borderRadius: '50%',
          border: `2px solid ${BC.ink}`, color: BC.ink,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 36, fontWeight: 300, fontStyle: 'normal',
        }}>→</div>
      </div>

      {/* bottom rail */}
      <div style={{
        position: 'absolute', bottom: 120, left: 80, right: 80,
        display: 'flex', justifyContent: 'space-between',
        fontFamily: FONTS.mono, fontSize: 20, letterSpacing: 2,
        textTransform: 'uppercase', color: BC.muted,
      }}>
        <span>barbermedia.ch</span>
        <span>info@barbermedia.ch</span>
      </div>
    </StoryFrame>
  );
}

// ═══════════════════════════════════════════════════════════════
// Direction builders — consume editable copy map
// ═══════════════════════════════════════════════════════════════

function DirectionA({ copy }) {
  const total = 6;
  return [
    <A_Slide1_Hero key="a1" idx={1} total={total} copy={copy.a1}/>,
    <A_Slide key="a2" idx={2} total={total}
      eyebrow="01 — L'audience"
      stat="8 400" unit="/mois"
      description={copy.a2 || "Hommes 18–35 ans, actifs urbains, touchés chaque mois dans nos 6 salons de Suisse romande."}/>,
    <A_Slide key="a3" idx={3} total={total}
      eyebrow="02 — L'attention"
      stat="30" unit="min"
      description={copy.a3 || "C'est le temps qu'un client passe immobile face à votre publicité. Sans AdBlocker. Sans skip. Sans scroll."}/>,
    <A_Slide key="a4" idx={4} total={total}
      eyebrow="03 — La répétition"
      stat="×6"
      description={copy.a4 || "Chaque visiteur voit votre publicité 6 fois par visite. Les clients fidèles la revoient 12 à 18 fois par mois."}/>,
    <A_Slide key="a5" idx={5} total={total}
      eyebrow="04 — Le ticket d'entrée"
      stat="135" unit="CHF"
      description={copy.a5 || "C'est tout ce qu'il faut pour lancer votre première campagne sur un salon. Résiliable à 30 jours."}/>,
    <A_Slide6_CTA key="a6" idx={6} total={total} copy={copy.a6}/>,
  ];
}

function DirectionB({ copy }) {
  const total = 6;
  return [
    <B_Slide1_Hero key="b1" idx={1} total={total} copy={copy.b1}/>,
    <B_Slide_Split key="b2" idx={2} total={total}
      eyebrow="01 — L'attention"
      badLabel="Publicité mobile" badStat="1,7s" badNote="La durée moyenne d'une impression sur Instagram avant le scroll."
      goodLabel="Barber Concept Media" goodStat="30 min" goodNote="Votre pub, en face d'un client immobile. Six fois par visite."
      copy={copy.b2}/>,
    <B_Slide_Split key="b3" idx={3} total={total}
      eyebrow="02 — Les vues réelles"
      badLabel="Trafic digital classique" badStat="40 %" badNote="Trafic bot ou frauduleux sur les plateformes d'ads."
      goodLabel="Notre réseau DOOH" goodStat="100 %" goodNote="Vues humaines vérifiées. Zéro impression fantôme."
      copy={copy.b3}/>,
    <B_Slide_Split key="b4" idx={4} total={total}
      eyebrow="03 — Le souvenir"
      badLabel="Recall publicitaire" badStat="< 10 %" badNote="Le taux de mémorisation d'une pub digitale classique."
      goodLabel="Dans un salon Barber" goodStat="×6" goodNote="Répétitions par visite. Mémorisation multipliée, sans être agressif."
      copy={copy.b4}/>,
    <B_Slide_Split key="b5" idx={5} total={total}
      eyebrow="04 — Le ciblage"
      badLabel="Ciblage algorithmique" badStat="?" badNote="Une boîte noire. Vous payez pour un profil supposé."
      goodLabel="Ciblage quartier" goodStat="6" goodNote="Salons. Vous choisissez précisément votre zone : Genève, Lausanne, Sion."
      copy={copy.b5}/>,
    <B_Slide6_CTA key="b6" idx={6} total={total} copy={copy.b6}/>,
  ];
}

function DirectionC({ copy }) {
  const total = 6;
  return [
    <C_Slide1_Cover key="c1" idx={1} total={total} copy={copy.c1}/>,
    <C_Slide key="c2" idx={2} total={total}
      roman="I."
      kicker="Chapitre un — Le lieu"
      headline={<>Un fauteuil. <em style={{fontStyle:'italic'}}>Un miroir.</em><br/>Trente minutes.</>}
      body={copy.c2 || "Dans un salon de barbier, le temps ralentit. Le client est assis, captif, à regarder droit devant lui. C'est exactement là que vit votre publicité."}
      cite="Les salons Barber Concept — Genève · Lausanne · Sion"/>,
    <C_Slide key="c3" idx={3} total={total}
      roman="II."
      kicker="Chapitre deux — Les hommes"
      headline={<>Ceux qui <em style={{fontStyle:'italic'}}>investissent</em><br/>dans leur image.</>}
      body={copy.c3 || "Ce ne sont pas des spectateurs passifs. Ils reviennent 2 à 3 fois par mois. Ils ont un panier moyen de 40 CHF. Ils dépensent. Ils recommandent."}
      cite="Audience type · 18–35 ans · actifs urbains"/>,
    <C_Slide key="c4" idx={4} total={total}
      roman="III."
      kicker="Chapitre trois — Le réseau"
      headline={<>Six salons. <em style={{fontStyle:'italic'}}>Trois villes.</em><br/>Votre quartier.</>}
      body={copy.c4 || "Cornavin, Jonction, Eaux-Vives, Rive à Genève. Lausanne centre. Sion centre. Vous choisissez. Nous diffusons. Aucune fuite hors de votre zone."}
      cite="24 écrans · 8 400 clients par mois"/>,
    <C_Slide key="c5" idx={5} total={total}
      roman="IV."
      kicker="Chapitre quatre — La méthode"
      headline={<>Trois étapes, <em style={{fontStyle:'italic'}}>zéro friction.</em></>}
      body={copy.c5 || "Choisissez votre formule. Envoyez votre visuel 1920×1080. Diffusion en 48 heures. Rapport mensuel, QR tracking, page annonceur — tout est compris."}
      cite="Service clé en main · résiliable à 30 jours"/>,
    <C_Slide6_CTA key="c6" idx={6} total={total} copy={copy.c6}/>,
  ];
}

Object.assign(window, {
  BC, FONTS, STORY_W, STORY_H,
  DirectionA, DirectionB, DirectionC,
});
