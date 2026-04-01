# Epic 4 : Dashboard admin (UI Skeleton)

**Statut :** DONE
**Complexite :** L

## Description

Interface admin pour visualiser, filtrer et gerer tous les contenus. Skeleton UI v4 + Tailwind CSS v4. Desktop-first.

## Taches

- [x] Skeleton UI v4 + Tailwind CSS v4 (Vite plugin)
- [x] Theme custom Jon Labs (couleurs primaires #00D9A3, surfaces, statuts)
- [x] Layout admin : sidebar custom (nav, user profile, logout) + main content
- [x] Page dashboard (`/`) : 5 compteurs reels + 10 derniers contenus (ContentCard)
- [x] Page projets (`/projects`) : grille de cards avec compteurs par projet
- [x] Page nouveau projet (`/projects/new`) : formulaire avec palette couleurs
- [x] Page detail projet (`/projects/[slug]`) : tableau des contenus + filtres type/statut dans l'URL
- [x] Page detail contenu (`/content/[id]`) : rendu markdown, metadonnees JSON, commentaires, historique statut
- [x] Composant StatusBadge : badge colore + mode interactif (dropdown pour changer le statut)
- [x] Composant ContentCard : card resume (titre, projet pill, type, statut, date)
- [x] Composant ProjectPill : pill avec couleur du projet
- [x] Filtres persistants dans l'URL (query params type + status)

## Composants crees

| Composant | Fichier | Description |
|-----------|---------|-------------|
| StatusBadge | `src/lib/components/StatusBadge.svelte` | Badge colore par statut, mode interactif avec dropdown |
| ProjectPill | `src/lib/components/ProjectPill.svelte` | Pill avec couleur du projet (style inline) |
| ContentCard | `src/lib/components/ContentCard.svelte` | Card resume d'un contenu avec lien vers detail |

## Notes

- Skeleton UI v4 n'a pas d'AppShell/AppRail/Table natifs → layout et table custom avec Tailwind
- Design minimaliste (Linear/Notion inspired)
- Pas de dark mode en MVP
