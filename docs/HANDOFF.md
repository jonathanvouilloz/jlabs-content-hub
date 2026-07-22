# HANDOFF — 2026-07-22

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

## Reprendre ici
E00 sur `feat/cockpit` — **JOB-005 livré** : le tick horaire planifie (DST comprise) **et draine** la
file. Prochain : l'**agent réel** (findings → `action_proposals`, policies DATA-007), ou JOB-006/JOB-004.
⚠️ Avant de déployer : trancher **barberconcept** (50 findings au 1er hebdo) — détail dans le feature file.
Commit : `2ea6974` [hub] add: JOB-005 scheduler timezone-aware + tick horaire qui draine la file.
