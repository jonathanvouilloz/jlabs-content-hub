# Epic 4 : Dashboard admin (UI Skeleton)

**Statut :** TODO
**Complexite :** L

## Description

Interface admin pour visualiser, filtrer et gerer tous les contenus. Utilise Skeleton UI + Tailwind CSS. Desktop-first.

## Taches

- [ ] Installer Skeleton UI + Tailwind CSS v4
- [ ] Theme custom Jon Labs (couleurs, typographie)
- [ ] Layout admin : AppShell + AppRail (sidebar) + AppBar (header)
- [ ] Page dashboard (`/`) : vue d'ensemble avec compteurs par statut et par projet
- [ ] Page projets (`/projects`) : liste des projets avec compteurs
- [ ] Page nouveau projet (`/projects/new`) : formulaire creation
- [ ] Page detail projet (`/projects/[slug]`) : contenus du projet
- [ ] Page detail contenu (`/content/[id]`) : rendu markdown + metadonnees + commentaires
- [ ] Composant StatusBadge : badge colore cliquable pour changer le statut
- [ ] Composant ContentCard : card resume d'un contenu
- [ ] Composant ProjectPill : pill avec couleur du projet
- [ ] Vue liste : tableau triable avec filtres (projet, type, statut, periode)
- [ ] Filtres persistants dans l'URL (query params)

## Composants Skeleton UI a utiliser

- AppShell, AppBar, AppRail
- Table
- TabGroup
- Badge
- Modal
- Toast
- Avatar (initiales projet)

## Notes

- Le design doit etre minimaliste et fonctionnel (inspirations : Linear, Notion, Plausible)
- Pas de dark mode en MVP
