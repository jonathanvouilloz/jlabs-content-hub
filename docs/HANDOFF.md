# HANDOFF — 2026-07-21

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · décision UI → [DECISIONS.md](DECISIONS.md) (2026-07-21).

## Reprendre ici
E00 sur `feat/cockpit` — fondations + **IDX-008** + **DATA-001** + **DATA-002** + **DATA-003** + **DATA-004 faits**. DATA-004 (phase expand) = le **modèle d'observations** (SPEC §7.5), **10 tables** (`gsc_query_page`/`gsc_page`/`index`/`sitemap`/`plausible_page`/`keyword_rank`/`backlink`/`ai_visibility`/`gmb_review`/`gmb_insight` _observations_) + helpers purs (`observation-state.ts`) + upserts idempotents des 5 tables ancrées (`observations.ts`) ; DB à **45 tables, zéro dérive**, 57/57 tests. Prochain : **migrate/contract** débloqué côté observations — backfill **par lots** `gsc_query_page_data` (73k, **dédupliquer d'abord**) + `gsc_snapshots` → observations, `gmb_insights_daily` → `gmb_insight_observations`, positions epic 23 → `keyword_rank_observations`. Puis **DATA-005** (`findings`/`finding_events`, désormais débloqué). Le morceau `ai_jobs → jobs` est **écarté** (result-store vivant ≠ pull-queue durable — voir feature file § Décisions).
Commits : `256c1a2` IDX-008 · `d7484a9` DATA-001 · `b6df05e` DATA-002 · `1ab115f` DATA-003 · `7d3ae9c` DATA-004.
