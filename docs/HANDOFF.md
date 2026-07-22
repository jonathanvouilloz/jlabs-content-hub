# HANDOFF — 2026-07-22 (DATA-008)

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · décision UI → [DECISIONS.md](DECISIONS.md) (2026-07-21).

## Reprendre ici
E00 sur `feat/cockpit` — fondations + IDX-008 + DATA-001→008 + MIGRATE/backfill exécuté en DB réelle. **DATA-008 FAIT (2026-07-22)**, périmètre **expand + dry-run (aucune suppression réelle)** : `retention_policies` + `observation_aggregates` + `purge_runs` (SPEC §7.11) posées et **appliquées sur Neon**. Rétention **configurable par type** (seedée §7.11 : détail obs 24 mois agrégé avant purge, debug 90 j, agrégats/findings/décisions/audit/rapports sans limite). Invariants purs (`retention-state.ts`) : `isPurgeable` (protégé/infini jamais purgé), **`assertPurgeAuthorized` (suppression d'audit = L4 sinon throw)**, `derivePeriod` (buckets week/month/year), `computeCutoff`/`isExpired`. Runner **`scripts/purge.ts`** DRY-RUN par défaut : annonce **lignes + périodes exactes** par type (dry-run réel Neon : réf. `2030-01-01` → **76 446 lignes** + périodes 2026-03→07, protégés « conservés », audit marqué L4) ; **`--execute` REFUSE** (destructif différé). Agrégats upsert + delete par cutoff = idempotents → reprise sans double effet (`checkpoint_json`). Helper `retention.ts` (`seedRetentionPolicies`, `upsertObservationAggregate`, run tracking). `npm run test` = **172/172** · `check` = **0 err / 42 warn** · introspection = **55 tables, zéro dérive**. **Prochain =** chaîne agentique aval (**1er détecteur** déterministe → vrais findings depuis observations DATA-004, + **agent réel** → proposals gouvernés par policies DATA-007) et/ou **JOB-001** (`FOR UPDATE SKIP LOCKED`, lease, heartbeat, backoff — consomme `idx_jobs_claim`). **Activation destructive de la purge** = tâche séparée (accès + validation explicites). **CONTRACT différé** (l'app lit encore `gsc_query_page_data` + `gmb_insights_daily`). `ai_jobs → jobs` reste **écarté** (voir feature file § Décisions).
Commits : `256c1a2` IDX-008 · `d7484a9` DATA-001 · `b6df05e` DATA-002 · `1ab115f` DATA-003 · `7d3ae9c` DATA-004 · `4696919` migrate/backfill · `7cb94c1` fix chunk · `f9432ce` DATA-005 · `4c24bc9` docs DATA-005 · `16fa000` DATA-006 · `43fe9d7` docs DATA-006 · `15a92cb` DATA-007 · `a8bdd2f` docs DATA-007 · _(DATA-008 : à committer)_.
