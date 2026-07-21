# HANDOFF — 2026-07-21

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · décision UI → [DECISIONS.md](DECISIONS.md) (2026-07-21).

## Reprendre ici
E00 sur `feat/cockpit` — fondations + **IDX-008** + **DATA-001** + **DATA-002** + **DATA-003 faits**. DATA-003 (phase expand) = 3 tables d'orchestration `monitoring_runs` + `monitoring_steps` + `jobs` (SPEC §7.3/§7.4/§6.2/§8.3) + helpers purs (`monitoring-state.ts`) + écriture concurrency-safe (`monitoring.ts`) ; DB à **35 tables, zéro dérive**, 40/40 tests. Prochain : **migrate/contract** (`ai_jobs`→`jobs`, `gsc_*`/`gmb_insights_daily`→observations) puis **JOB-001** (réclamation atomique `FOR UPDATE SKIP LOCKED`, consomme `idx_jobs_claim`). En attente : **DATA-001b** (fixture, différée) · décision de marque sur 3 chaînes `jlabs-content-hub` client-facing.
Commit : `256c1a2` IDX-008 · `d7484a9` DATA-001 · `b6df05e` DATA-002. DATA-003 = à committer.
