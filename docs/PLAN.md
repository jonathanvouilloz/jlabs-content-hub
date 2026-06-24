# Plan d'execution — jokiSEO (ex JLabs Content Hub)

> Derniere mise a jour : 2026-06-24
> **Pivot 2026-06-24 :** le produit devient **jokiSEO** (cockpit SEO & presence locale). Voir [PRD-jokiseo.md](PRD-jokiseo.md). Les phases 1-2 (MVP + V2 "Content Hub") restent l'historique ; la Phase 3 ci-dessous est la nouvelle direction.

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
| 23 | Suivi de positions mots-cles (cron GSC + watchlist + serie temporelle + rapport client) | M | ABSORBE → epic 27 | [keyword-position-tracking.md](features/keyword-position-tracking.md) |

> Epic 23 : code livre et fonctionnel (positions GSC, cannibalisation, vue client, digest). N'est plus poursuivi en l'etat — l'**epic 27** ajoute le rang SERP reel par-dessus et porte la suite.

---

## Phase 3 — jokiSEO (cockpit SEO & presence locale)

> Nouvelle direction, pivot du 2026-06-24. Source de verite : [PRD-jokiseo.md](PRD-jokiseo.md).
> Sequencage : **24 + 25** (cadre + plomberie) → **26 + 27** (les deux douleurs prioritaires) → **28→32** (expansion, reordonnables).
> Un fichier `features/` par epic, cree au fil de l'eau.

| # | Epic | Complexite | Statut | Detail |
|---|------|-----------|--------|--------|
| 24 | Focus & IA : retrait surface Articles/LinkedIn, nav 2 piliers (SEO / Presence locale), cockpit projet unifie | M | TODO | _a venir_ |
| 25 | Couche providers DataForSEO + runner de jobs (fondation API externe + taches longues/planifiees) | M | TODO | _a venir_ |
| 26 | Avis full-auto : cron sync branche + brouillon auto + envoi differe configurable + garde-fou par note | M | TODO | _a venir_ |
| 27 | Rank tracking SERP reel (DataForSEO), geolocalise, par mot-cle suivi (absorbe epic 23) | L | TODO | _a venir_ |
| 28 | Geo-grid local : rang GMB par point geographique autour de la fiche | M | TODO | _a venir_ |
| 29 | Dashboard reputation : note/sentiment/taux de reponse/leaderboard employes dans le temps | S | TODO | _a venir_ |
| 30 | Backlinks : domaines referents, nouveaux/perdus, autorite | M | TODO | _a venir_ |
| 31 | Visibilite IA / GEO : citations ChatGPT/Perplexity/AI Overviews sur requetes cibles | M | TODO | _a venir_ |
| 32 | Rapport client mensuel unifie (white-label, token + export) | M | TODO | _a venir_ |

### Garde sous le coude (LATER)
- Tracking concurrents (positions + GMB + backlinks)
- Alertes proactives (chute position, avis negatif, perte backlink) — opt-in client
- Multi-admin + roles
- Commercialisation SaaS jokiSEO (a valider apres maturite multi-client)
- Store analytique dedie si le volume time-series (geo-grid + rank quotidien) l'exige
