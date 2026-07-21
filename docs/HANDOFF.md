# HANDOFF — 2026-07-21

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · décision UI → [DECISIONS.md](DECISIONS.md) (2026-07-21).

## Reprendre ici
E00 sur `feat/cockpit` — fondations + **IDX-008** + **DATA-001** + **DATA-002 faits**. DATA-002 (phase expand) = 2 tables socles `project_integrations` + `project_projections` (SPEC §7.1/§7.2) + helpers (dedup hash, garde anti-secret, santé) ; DB à 32 tables, zéro dérive. Prochain : **DATA-003** (`monitoring_runs`/`monitoring_steps`/`jobs`, SPEC §7.3/§7.4). En attente : migrate/contract (backfill vers les nouvelles tables) · **DATA-001b** (fixture, différée) · décision de marque sur 3 chaînes `jlabs-content-hub` client-facing.
Commit : `256c1a2` IDX-008 · `d7484a9` DATA-001. DATA-002 = à committer.
