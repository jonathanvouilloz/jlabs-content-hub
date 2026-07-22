# HANDOFF — 2026-07-22

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · [DECISIONS.md](DECISIONS.md).

## Reprendre ici
E00 sur `feat/cockpit` — **JOB-003** : classification fine des erreurs (retryable / auth / quota /
permanent), backoff avec jitter, bornage des tentatives, et action de reprise depuis la dead-letter
en conservant l'historique des tentatives (`job_attempts` existe désormais pour ça). Contexte,
pièges et carte du code → le fichier feature. JOB-002 vient de fermer le trou « worker mort » et
débloque JOB-003 + JOB-007.
Commit : `<à venir>` [hub] add: JOB-002 bail, heartbeat et récupération après crash.
