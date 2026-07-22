# HANDOFF — 2026-07-22

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

## Reprendre ici
E00 sur `feat/cockpit` — **JOB-007 livré**, la queue est complète et pilotable (`/jobs`). Prochain :
l'**agent réel** (findings → `action_proposals`, policies DATA-007), ou **JOB-005** (scheduler : aucun
worker ne tourne seul aujourd'hui). Reste à constater de visu le rendu de `/jobs` (session admin).
Commit : `05e5eca` [hub] add: JOB-007 console d'exploitation des jobs.

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · [DECISIONS.md](DECISIONS.md).
