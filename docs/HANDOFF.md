# HANDOFF — 2026-07-22

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · décision UI → [DECISIONS.md](DECISIONS.md) (2026-07-21).

## Reprendre ici
E00 sur `feat/cockpit` — fondations + IDX-008 + DATA-001→004 + **MIGRATE/backfill EXÉCUTÉ EN DB RÉELLE (2026-07-22)**. Le backfill legacy→observations a tourné sur Neon : **73009** `gsc_query_page_observations` · **3300** `gsc_page_observations` (rollup) · **0** `gmb_insight` (source vide) · **137** `keyword_rank_observations`. `verify-backfill` = **5/5 PASS** (clés distinctes = obs, Σ impressions rollup conservée, keyword_rank ⊆ watchlist). `data-001-cartography post-backfill` = **45 tables, zéro dérive**. Correctif au passage : `CHUNK` 5000→4000 (débordait la limite Postgres 65535 params bind sur les tables 16 colonnes). **Prochain = DATA-005** (`findings`/`finding_events`, désormais débloqué). **CONTRACT différé** (l'app lit encore `gsc_query_page_data` + `gmb_insights_daily`). `ai_jobs → jobs` reste **écarté** (voir feature file § Décisions).
Commits : `256c1a2` IDX-008 · `d7484a9` DATA-001 · `b6df05e` DATA-002 · `1ab115f` DATA-003 · `7d3ae9c` DATA-004 · `4696919` migrate/backfill · `7cb94c1` fix chunk + snapshot post-backfill.
