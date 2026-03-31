# Epic 5 : Calendrier editorial

**Statut :** TODO
**Complexite :** M

## Description

Vue calendrier mensuelle affichant tous les contenus planifies, colores par projet. Switch entre vue calendrier et vue liste.

## Taches

- [ ] Page calendrier (`/calendar`) avec navigation mois par mois
- [ ] Composant CalendarGrid : grille mensuelle
- [ ] Composant CalendarDay : cellule du jour avec contenus
- [ ] Code couleur par projet dans les cellules
- [ ] Indicateur visuel du statut (badge)
- [ ] Switch calendrier/liste (TabGroup)
- [ ] Filtres : projet, type, statut
- [ ] Bloc "Non planifie" pour les contenus sans `planned_date`
- [ ] Etat vide si aucun contenu pour un mois

## Notes

- Les contenus sont positionnes sur le jour de leur `planned_date`
- Clic sur un contenu → navigation vers `/content/[id]`
- Vue desktop-first, responsive en V2
