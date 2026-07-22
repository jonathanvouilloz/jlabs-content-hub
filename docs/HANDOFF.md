# HANDOFF — 2026-07-22

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

## Reprendre ici
E00 sur `feat/cockpit` — **AGT-000 livré** : un finding devient une **proposition** typée, dotée
d'un niveau L0–L4 figé, dédupliquée par un payload stable. Prochain : **JOB-004** (DAG de steps —
le scheduler enfile `detect` puis `propose` sans rien ordonnancer), ou **JOB-006**, ou l'inbox UI.
⚠️ Avant de déployer : `barberconcept` écrira ses 50 findings au 1er tick (décidé : on laisse aller).
Commit : `a0c6f59` [hub] add: AGT-000 producteur de propositions.
