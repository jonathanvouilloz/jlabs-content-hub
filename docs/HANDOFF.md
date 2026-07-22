# HANDOFF — 2026-07-22

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

## Reprendre ici
E00 sur `feat/cockpit` — **JOB-005 livré** : un tick horaire (`/api/cron/tick`) planifie les cadences
en heure métier `Europe/Zurich` (DST comprise, zéro DDL) **et draine la file** — la queue ne dépend
plus d'un lancement manuel. Prochain : l'**agent réel** (findings → `action_proposals`, policies
DATA-007), ou **JOB-006** (prévenir le 429), ou **JOB-004** (DAG de steps).

⚠️ **Avant de déployer** : le premier tick planifiera le hebdo des 6 projets — dont **barberconcept**,
qui n'a jamais été détecté et écrira **50 findings d'un coup**. Décision à prendre (laisser partir, ou
désactiver `weekly` pour ce projet via `project_projections.payload.schedules`).

Reste à constater de visu le rendu de `/jobs` (session admin — inchangé depuis JOB-007).

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · [DECISIONS.md](DECISIONS.md).
