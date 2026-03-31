# Plan d'execution — JLabs Content Hub

> Derniere mise a jour : 2026-03-31

## Epics

| # | Epic | Complexite | Statut | Detail |
|---|------|-----------|--------|--------|
| 1 | Init projet + Schema DB | S | DONE | [init-schema.md](features/init-schema.md) |
| 2 | API REST (contenu, projets, commentaires) | M | DONE | [api-routes.md](features/api-routes.md) |
| 3 | Auth admin (Better Auth) | S | DONE | [auth.md](features/auth.md) |
| 4 | Dashboard admin (UI Skeleton) | L | TODO | [dashboard-admin.md](features/dashboard-admin.md) |
| 5 | Calendrier editorial | M | TODO | [calendrier.md](features/calendrier.md) |
| 6 | Acces client + commentaires | M | TODO | [acces-client.md](features/acces-client.md) |
| 7 | GitHub sync (backup) | S | DONE | [github-sync.md](features/github-sync.md) |
| 8 | Migration contenu existant | S | TODO | [migration.md](features/migration.md) |
| 9 | Deploiement Vercel + Turso | S | TODO | [deploiement.md](features/deploiement.md) |

## Ordre d'execution recommande

```
1. Init + Schema DB .............. DONE
2. API REST ...................... DONE
3. Auth admin .................... DONE (Skeleton UI + Tailwind + Better Auth + login + layout)
4. Deploiement Vercel + Turso .... deployer tot pour iterer en prod
5. Dashboard admin (UI) .......... coeur du produit
6. Calendrier editorial .......... vue calendrier + filtres
7. Acces client + commentaires ... partager avec les clients
8. Migration contenu existant .... importer barberconcept + physiopommier
9. GitHub sync ................... DONE (service Octokit, sync async)
```

## Prochaines etapes

1. Deployer sur Vercel + configurer Turso prod
2. `POST /api/setup` pour creer le compte admin + seed
3. Dashboard admin : pages projets, vue liste contenus, detail contenu
4. Calendrier editorial : grille mensuelle avec filtres
