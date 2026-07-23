# Plan d'execution — seo-stats

> Derniere mise a jour : 2026-07-21
> **Cap actuel :** refonte **cockpit agentique de monitoring** (SPEC : [SPEC.md](SPEC.md) · execution : [BACKLOG.md](BACKLOG.md)).
> Ce fichier ne garde que **l'historique du socle livré** (Phases 1-2, epics 1-23). La suite (E00→E13)
> vit dans **[BACKLOG.md](BACKLOG.md)**, pas ici. Le pivot jokiSEO (2026-06-24) est archivé (`_archive/PRD-jokiseo.md`).
>
> **Pré-requis transverse en cours :** migration données Turso → Neon (voir [NEON-MIGRATION.md](NEON-MIGRATION.md) Phase 4)
> avant de démarrer la reconstruction du BACKLOG.

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

## Phase 3+ — Refonte agentique → voir [BACKLOG.md](BACKLOG.md)

La suite n'est plus planifiée ici. Le cadrage jokiSEO (epics 24-32) a été **absorbé et dépassé** par la
refonte « cockpit agentique de monitoring » du 2026-07-21 :

- **Quoi** : déléguer 90% du monitoring SEO/présence-locale récurrent à des agents, findings persistants,
  validation humaine des actions sensibles.
- **Vision complète** : [SPEC.md](SPEC.md) (23 sections, décisions validées).
- **Exécution** : [BACKLOG.md](BACKLOG.md) — 14 epics `E00→E13`, jalons `M0→M6`, premier lot exécutable (§9).
- **Statut (2026-07-23)** : **E00 EN COURS** sur `feat/cockpit` — fondations (GOV-003/005 + OPS-001) +
  **IDX-008** + **DATA-001→008** livrés (cartographie, intégrations/projections, orchestration+queue,
  10 observations + backfill exécuté, findings, proposals/approvals/agent_runs, policies d'automatisation,
  rétention/purge en expand+dry-run), puis la **chaîne agentique bouclée** : **FIND-001/004** (1er
  détecteur déterministe) et **FIND-003** (cycle de vie : les findings se ferment, se rouvrent et se
  mettent en veille seuls). **La queue est complète** : **JOB-001** (réclamation atomique),
  **JOB-002** (bail vivant, worker mort, journal `job_attempts`, exactly-once des effets),
  **JOB-003** (erreur classée, backoff jitté, dead-letter reprenable), **JOB-007** (console
  d'exploitation `/jobs` : liste, chronologie, retry ciblé, annulation auditée) et **JOB-005**
  (scheduler timezone-aware : tick horaire `/api/cron/tick` qui planifie les cadences
  `Europe/Zurich` — DST comprise, zéro DDL — **et draine la file** : plus rien ne dépend d'un
  lancement manuel). **La chaîne de décision est fermée** : **AGT-000** (producteur déterministe
  findings → `action_proposals`, niveaux L0–L4 figés, payload stable donc dédup réelle, plafond par
  projet, auto-approbation bornée à L2 sous policy explicite ; job `propose:actions` planifié le
  lundi après le détecteur). **L'ordonnancement et la capacité sont fermés** : **JOB-004**
  (dépendances réelles entre jobs — un prérequis obligatoire mort fait `skipped` son dépendant et
  `partial` son run) et **JOB-006** (plafonds global/projet/provider, **tour d'équité** pour qu'un
  gros projet ne prenne pas tout un tick, **refroidissement provider** qui met toute la cohorte au
  repos sur un `quota`, plafonds réglables **sans redéploiement**). DB à **58 tables, zéro dérive**
  (`system_settings`, seul DDL depuis JOB-003) · test **575/575**. Prochain : l'**inbox UI**
  (E11/DASH-005) qui affichera findings ET propositions, et les **collecteurs E03** — qui donneront
  de vrais consommateurs aux budgets provider armés par JOB-006.
  Détail → [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md).
- **Correspondances** : les douleurs jokiSEO (avis full-auto, rang réel, cannibalisation, indexation) sont
  reprises et élargies dans E04/E05/E08 du BACKLOG. L'epic 23 (positions GSC) reste livré en prod.

> Ne pas rouvrir les epics 24-32 : le BACKLOG les remplace.
