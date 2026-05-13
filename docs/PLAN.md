# Plan d'execution — JLabs Content Hub

> Derniere mise a jour : 2026-05-11

---

## Phase 1 — MVP (DONE)

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

---

## Phase 2 — V2 Ameliorations

| # | Epic | Complexite | Statut | Commits cles |
|---|------|-----------|--------|--------------|
| 10 | UX admin — sidebar dynamique + design system | M | DONE | `556a430`, `0333da4` |
| 11 | Cartes projets redesign + image cover + calendrier | M | DONE | `fdab660` |
| 12 | Publication GMB — auth Google, cron, multi-location | L | DONE | `c3f7301`, `e7c2aa8`, `e7bac29` |
| 13 | Publication LinkedIn — OAuth, batch split, scheduling | L | DONE | `562ec01` |
| 14 | Publication CMS (Webflow) — adapter, API, JSON-LD | L | DONE | `906755d` |
| 15 | Avis Google — consultation, reponse, stockage DB, cron sync | L | DONE | `4c8a5de`, `ad19986`, `93ba9ad` |
| 16 | Profil business par projet | S | DONE | `93ba9ad` |
| 17 | Cleanup contenu MVP (DB + GitHub backup) | S | DONE | `3b6e35b`, `70baaee` |
| 18 | GMB full-auto pipeline (logs, emails, blob, auto-approve) | M | DONE | `d800f70` |
| 19 | Fix /publish-hub GMB pipeline (upsert idempotent + CSRF + /api/whoami) | S | DONE | _en cours_ |
| 20 | GSC weekly snapshots (data layer + admin page + skill /seo-weekly) | M | DONE | _en cours_ |
| 21 | SEO actions actionnables (endpoint /gsc/actions + skill /seo-actions) | S | DONE | _en cours_ |
| 22 | Gestion fiche GMB : lecture snapshot + edition infos+horaires + stats Performance API | M | DONE | _en cours_ |

---

## Prochaines etapes (V2+)

- Responsive mobile
- Pagination contenus
- Hash tokens (securite)
- Analytics / stats par projet
- GMB fiche : categories + services + photos (epic 23)
- Cron `/api/cron/gmb-profile-refresh` (daily resync profile + insights J-3)
