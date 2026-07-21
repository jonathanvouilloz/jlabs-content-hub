# HANDOFF — 2026-07-22

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · décision UI → [DECISIONS.md](DECISIONS.md) (2026-07-21).

## Reprendre ici
E00 sur `feat/cockpit` — fondations + IDX-008 + DATA-001→004 + **MIGRATE/backfill écrit (code)**. Le backfill legacy→observations (DATA-004) est **codé et testé** : module pur `observation-backfill.ts` (rollup page pondéré, sélection représentative keyword) + runner `scripts/backfill-observations.ts` (idempotent, dédup intra-lot GSC, `--dry-run`) + vérif `scripts/verify-backfill.ts`. Portée : `gsc_query_page_data`→`gsc_query_page_observations` (1:1) + rollup→`gsc_page_observations`, `gmb_insights_daily`→`gmb_insight_observations`, `tracked_keywords`×GSC→`keyword_rank_observations` (watchlist). `npm run test` = **70/70**, `check` = 0 err / 42 warn. **Dry-run OK** (73009/3300/0/137 — GMB source vide). **Prochain = EXÉCUTION DB réelle** (accès Neon, hors session code) : run réel → `verify-backfill` → `data-001-cartography post-backfill`. Puis **DATA-005** (`findings`/`finding_events`). **CONTRACT différé** (l'app lit encore le legacy). `ai_jobs → jobs` reste **écarté** (voir feature file § Décisions).
Commits : `256c1a2` IDX-008 · `d7484a9` DATA-001 · `b6df05e` DATA-002 · `1ab115f` DATA-003 · `7d3ae9c` DATA-004 · _(migrate/backfill : à committer)_.
