# Plan de redesign — JLabs Content Hub

> Style cible : Linear / Vercel Dashboard — minimaliste, outil pro, zero friction
> Date : 2026-04-07

---

## Phase 1 — Fondations (sequentiel, prerequis pour tout le reste)

### 1.1 Design tokens centralises
> Fichier : `src/lib/config/design-tokens.ts`

- Status colors (draft, review, approved, published) — une seule source de verite
- Spacing scale (4/8/12/16/24/32/48)
- Border radius (`rounded-md` partout, plus de pill-shaped sauf pills/badges)
- Shadow scale (none, sm, md)
- Transition defaults (150ms ease-out)
- Exporter des helpers : `statusColor()`, `statusLabel()`, `statusIcon()`

### 1.2 Systeme d'icones Lucide
> Fichier : `src/lib/components/ui/Icon.svelte`

- Installer `lucide-svelte`
- Composant `<Icon name="star" size={16} />` avec props standardisees
- Remplacer TOUS les SVG inline dans l'app (sidebar, cards, badges, nav)
- Icones cles : grid, file-text, linkedin, map-pin, star, settings, calendar, plus, search, filter, check, x, chevron-down, refresh-cw, send, save, trash

### 1.3 Composants UI de base
> Dossier : `src/lib/components/ui/`

| Composant | Role | Utilise dans |
|-----------|------|--------------|
| `PageHeader.svelte` | Titre + sous-titre + actions slot | Toutes les pages |
| `StatCard.svelte` | KPI : label + valeur + icone optionnel | Dashboard, projet |
| `EmptyState.svelte` | Icone + message + CTA | Listes vides partout |
| `Badge.svelte` | Status, type, compteur | Partout (remplace StatusBadge) |
| `Button.svelte` | Variantes : primary, secondary, ghost, danger | Partout |

---

## Phase 2 — Layout global (sequentiel, impacte toutes les pages)

### 2.1 Sidebar globale (remplace navbar top + sidebar projet)

**Structure :**
```
[Logo JL]                    <- compact, pas de texte long
---
[Dashboard]                  <- icone + label
[Calendrier]                 <- icone + label
---
PROJETS                      <- section label
  [BarberConcept]   (dot)    <- projet avec couleur
  [PhysioPommier]   (dot)
  [+ Nouveau]
---
[Settings]                   <- bas de sidebar
[User avatar + logout]
```

**Dans un projet (sous-nav inline) :**
```
  [BarberConcept]   (dot)    <- actif, expanded
    Vue d'ensemble
    Articles (12)
    LinkedIn (8)
    GMB (15)
    Avis Google (3)           <- badge si pending
    Parametres
```

- Largeur : 240px desktop, 56px collapsed (icones seuls), drawer mobile
- Toggle collapse via bouton ou breakpoint < 1024px
- Fichier : refonte complete de `src/routes/(app)/+layout.svelte`
- Supprimer : `src/routes/(app)/projects/[slug]/+layout.svelte` (fusionner dans le layout global)

### 2.2 Zone de contenu principale

- Padding : `px-8 py-6` (desktop), `px-4 py-4` (mobile)
- Max-width : `max-w-6xl` pour le contenu texte, full-width pour les tableaux/calendrier
- Background : `bg-surface-50`
- Panneaux : `bg-white rounded-lg border border-surface-200`

---

## Phase 3 — Pages (parallelisable, chaque page est independante)

### 3A. Dashboard (refonte complete)
> Fichier : `src/routes/(app)/+page.svelte`

**Layout cible :**
```
[Bonjour Jonathan]                    <- greeting simple

[Stats en ligne] ─────────────────    <- 3-4 KPIs max, pas 5 cartes
  12 contenus  |  3 en review  |  2 avis a repondre

[A faire] ────────────────────────    <- section prioritaire
  - 3 avis Google en attente (BarberConcept)     [Voir →]
  - 2 articles en review (PhysioPommier)         [Voir →]
  - 1 post LinkedIn planifie aujourd'hui         [Voir →]

[Activite recente] ───────────────    <- feed chronologique compact
  Aujourd'hui
    Article "Entretien barbe" → published         14:30
    Post LinkedIn #3 cree                         11:20
  Hier
    3 avis Google synchronises (BarberConcept)    09:00
```

- Pas de grille de cartes — liste actionnable
- Chaque item cliquable mene directement a la page

### 3B. Liste projets
> Fichier : `src/routes/(app)/projects/+page.svelte`

- Grille de cartes plus clean : image/couleur + nom + stats inline
- Hover subtle (`translate-y-[-1px] shadow-sm`)
- Quick actions au hover (ouvrir, parametres)

### 3C. Page projet (vue d'ensemble)
> Fichier : `src/routes/(app)/projects/[slug]/+page.svelte`

- Header compact : nom + description + actions
- Stats en ligne (pas 4 cartes)
- Tableau des contenus avec filtres inline (type, status)
- Section "Prochaines publications" compacte

### 3D. Pages contenu (articles, linkedin, gmb)
> Fichiers : `articles/+page.svelte`, `linkedin/+page.svelte`, `gmb/+page.svelte`

- Structure identique pour les 3 : PageHeader + filtres + ContentTable
- Alertes de connexion integrees proprement (pas un bloc amber)
- Toggle actifs/publies via tabs, pas 2 sections

### 3E. Avis Google (refonte)
> Fichier : `reviews/+page.svelte`

- Garder le split 2 colonnes mais ameliorer
- Liste gauche : plus compact, rating en couleur de fond subtile
- Detail droit : meilleur espacement, boutons alignes
- Batch reply : barre de progression plus visible
- Filtre location : integre dans un toolbar propre

### 3F. Calendrier
> Fichier : `calendar/+page.svelte`

- Toolbar filtres sur une seule ligne
- Grille calendrier plus aeree
- Items du calendrier : pastille couleur + texte tronque
- Vue liste : tableau compact

### 3G. Detail contenu
> Fichier : `content/[id]/+page.svelte`

- Layout 2 colonnes : contenu principal (gauche 65%) + meta sidebar (droite 35%)
- Meta sidebar : status, dates, projet, tags, actions de publication
- Commentaires en bas du contenu principal

### 3H. Login
> Fichier : `(auth)/login/+page.svelte`

- Centrage vertical, card etroite (400px max)
- Logo + "Content Hub" sobre
- Inputs plus grands (h-11), labels visibles
- Bouton full-width

### 3I. Vue client (publique)
> Fichiers : `view/[project_slug]/+page.svelte`

- Plus propre mais pas prioritaire (clients voient rarement)
- Appliquer les memes tokens et composants

---

## Phase 4 — Polish (parallelisable)

### 4A. Animations & transitions
- Page transitions : fade 150ms
- Sidebar collapse : 200ms ease-out
- Cards hover : `transition-all duration-150`
- Boutons : scale(0.98) on press
- Loading states : skeleton shimmer sur les tableaux

### 4B. Responsive mobile
- Sidebar → drawer (hamburger menu)
- Tableaux → cartes empilees sur mobile
- Calendrier → vue liste par defaut sur mobile
- Touch targets : min 44px sur tous les boutons

### 4C. Accessibilite
- Focus rings visibles (`ring-2 ring-primary-400 ring-offset-2`)
- aria-labels sur les boutons icone-only
- Hierarchie headings correcte (h1 > h2 > h3)
- Contraste 4.5:1 verifie sur toutes les couleurs

---

## Ordre d'execution

```
Phase 1 (sequentiel) ──────────────────────────────────
  1.1 Design tokens
  1.2 Icones Lucide          (depend de 1.1 pour les couleurs)
  1.3 Composants UI de base  (depend de 1.1 + 1.2)

Phase 2 (sequentiel) ──────────────────────────────────
  2.1 Sidebar globale        (depend de 1.*)
  2.2 Zone contenu           (depend de 2.1)

Phase 3 (PARALLELE) ───────────────────────────────────
  ┌─ 3A. Dashboard
  ├─ 3B. Liste projets
  ├─ 3C. Page projet
  ├─ 3D. Pages contenu (articles/linkedin/gmb)
  ├─ 3E. Avis Google
  ├─ 3F. Calendrier
  ├─ 3G. Detail contenu
  ├─ 3H. Login
  └─ 3I. Vue client

Phase 4 (PARALLELE) ───────────────────────────────────
  ┌─ 4A. Animations
  ├─ 4B. Responsive
  └─ 4C. Accessibilite
```

## Estimation de scope

| Phase | Fichiers touches | Complexite |
|-------|-----------------|------------|
| 1. Fondations | ~8 nouveaux + refactor badges/status dans ~10 fichiers | M |
| 2. Layout | 2 layouts majeurs + app.css | L |
| 3. Pages | ~12 pages + ~6 composants | XL |
| 4. Polish | CSS + tweaks sur toutes les pages | M |

**Approche recommandee :** Phase 1 → Phase 2 → Phase 3 (par lots de 2-3 pages) → Phase 4

---

## References design

- **Linear** : sidebar, dashboard inbox, navigation projet
- **Vercel Dashboard** : stats compactes, tableaux propres, typographie
- **Notion** : sidebar collapsible, hierarchie de pages
- **Cal.com** : calendrier editorial, filtres inline
