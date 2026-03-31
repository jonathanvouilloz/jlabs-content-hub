# Plan d'execution — JLabs Content Hub

> Derniere mise a jour : 2026-03-31

## Epics

| # | Epic | Complexite | Statut | Detail |
|---|------|-----------|--------|--------|
| 1 | Init projet + Schema DB | S | DONE | [init-schema.md](features/init-schema.md) |
| 2 | API REST (contenu, projets, commentaires) | M | DONE | [api-routes.md](features/api-routes.md) |
| 3 | Auth admin (Better Auth) | S | EN COURS | [auth.md](features/auth.md) |
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
3. Auth admin .................... EN COURS (config Better Auth posee, UI login a faire)
4. Deploiement Vercel + Turso .... deployer tot pour iterer en prod
5. Dashboard admin (UI) .......... coeur du produit
6. Calendrier editorial .......... vue calendrier + filtres
7. Acces client + commentaires ... partager avec les clients
8. Migration contenu existant .... importer barberconcept + physiopommier
9. GitHub sync ................... DONE (service Octokit, sync async)
```

## Prochaines etapes

1. Configurer `.env` avec credentials Turso + Better Auth
2. `npm run db:push` pour creer les tables
3. Ajouter Skeleton UI + Tailwind CSS
4. Implementer la page login
5. Implementer le layout admin (AppShell + Sidebar)
