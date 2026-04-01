# Plan d'execution — JLabs Content Hub

> Derniere mise a jour : 2026-03-31

## Epics

| # | Epic | Complexite | Statut | Detail |
|---|------|-----------|--------|--------|
| 1 | Init projet + Schema DB | S | DONE | [init-schema.md](features/init-schema.md) |
| 2 | API REST (contenu, projets, commentaires) | M | DONE | [api-routes.md](features/api-routes.md) |
| 3 | Auth admin (Better Auth) | S | DONE | [auth.md](features/auth.md) |
| 4 | Dashboard admin (UI Skeleton) | L | DONE | [dashboard-admin.md](features/dashboard-admin.md) |
| 5 | Calendrier editorial | M | DONE | [calendrier.md](features/calendrier.md) |
| 6 | Acces client + commentaires | M | DONE | [acces-client.md](features/acces-client.md) |
| 7 | GitHub sync (backup) | S | DONE | [github-sync.md](features/github-sync.md) |
| 8 | Migration contenu existant | S | DONE | [migration.md](features/migration.md) |
| 9 | Deploiement Vercel + Turso | S | DONE | [deploiement.md](features/deploiement.md) |

## Ordre d'execution

```
1. Init + Schema DB .............. DONE
2. API REST ...................... DONE
3. Auth admin .................... DONE
4. Dashboard admin (UI) .......... DONE
5. Calendrier editorial .......... DONE
6. Deploiement Vercel + Turso .... DONE
7. Acces client + commentaires ... DONE
8. Migration contenu existant .... DONE
9. GitHub sync ................... DONE
```

## Prochaines etapes

1. Calendrier editorial : grille mensuelle avec filtres
2. Deployer sur Vercel + configurer Turso prod + domaine hub.jonlabs.ch
3. Migration : importer les 22 contenus existants en DB
4. Acces client : vue publique avec token + commentaires
