# HANDOFF — 2026-07-21

## Chantiers actifs
| Chantier | Fichier | Statut |
|---|---|---|
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | **EN COURS** — code fait, données à migrer (Phase 4) |
| Refonte agentique (cockpit monitoring) | [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) | EN ATTENTE — démarre après Phase 4 (premier lot §9) |

## Reprendre ici
**Phase 4 — migrer les données Turso → Neon `seostats`.** 1) trancher le slug `bis-repetita`/`bisrepetita` vs `projects.yaml` ; 2) script export Turso → transform (bool, dates) → load `seostats.*` (`projects` d'abord) ; 3) poser la FK `projects.slug → core.entities.slug` ; 4) vérif counts/échantillons. Détail complet : `NEON-MIGRATION.md` Phase 4.

**Commit :** `92835a5` [hub] docs: refonte doc seo-stats (cockpit agentique) + rangement
**Branche :** `feat/neon` (refactor + docs) — **pas encore mergée dans `main`** (décision en attente).
**Requis Phase 4 :** accès Turso (`DATABASE_AUTH_TOKEN` + URL) et `DATABASE_URL` Neon.
