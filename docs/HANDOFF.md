# HANDOFF — 2026-07-21

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · décision UI → [DECISIONS.md](DECISIONS.md) (2026-07-21).

## Reprendre ici
E00 sur `feat/cockpit` — fondations + **IDX-008** + **DATA-001 faits**. DATA-001 = cartographie du schéma → `docs/DATA-001-cartography.md` (30 tables, zéro dérive modèle↔DB, sort par table, expand/migrate/contract ; gros morceau = `gsc_query_page_data` 73k). Prochain : **DATA-002** (`project_integrations` + `project_projections`). En attente : **DATA-001b** (fixture anonymisée, différée) · décision de marque sur 3 chaînes `jlabs-content-hub` client-facing.
Commit : `256c1a2` IDX-008 · code fondations `3d9be7d`. DATA-001 = à committer.
