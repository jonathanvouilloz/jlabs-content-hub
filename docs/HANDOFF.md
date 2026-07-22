# HANDOFF — 2026-07-22

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · [DECISIONS.md](DECISIONS.md).

## Reprendre ici
E00 sur `feat/cockpit` — **JOB-002** : renouvellement de bail, détection de worker mort, remise en
queue selon la politique de retry, timeout provider vs crash local. Contexte, pièges et carte du code
→ le fichier feature. FIND-003 vient de fermer le cycle de vie des findings (débloque FIND-010,
DASH-004, REP-001, AGT-005C).
Commit : `5428ec7` [hub] add: FIND-003 cycle de vie des findings.
