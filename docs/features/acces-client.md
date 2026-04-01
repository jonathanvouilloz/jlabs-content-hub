# Epic 6 : Acces client + commentaires

**Statut :** TODO
**Complexite :** M

## Description

Vue publique par projet accessible via un lien avec token. Le client voit son calendrier editorial, peut lire les contenus et laisser des commentaires.

## Taches

- [ ] Route `/view/[project_slug]` avec validation token (query param)
- [ ] Page calendrier client (lecture seule)
- [ ] Page detail contenu client (`/view/[project_slug]/[content_id]`)
- [ ] Rendu markdown des articles
- [ ] Section commentaires : liste + formulaire
- [ ] Premier commentaire : saisie nom + email (stocke en localStorage)
- [ ] Badge "X commentaires" cote admin
- [ ] Admin peut supprimer un commentaire
- [ ] Token invalide/expire → page 404 generique
- [ ] Design brande Jon Labs (pas un outil interne)

## Edge cases

- Client ne voit que son projet
- Drafts masques par defaut (configurable)
- localStorage indisponible → redemander nom/email a chaque fois
- Commentaire vide → bouton desactive
