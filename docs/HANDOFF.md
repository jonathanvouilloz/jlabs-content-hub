# HANDOFF — 2026-07-22 (DATA-005)

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · décision UI → [DECISIONS.md](DECISIONS.md) (2026-07-21).

## Reprendre ici
E00 sur `feat/cockpit` — fondations + IDX-008 + DATA-001→005 + MIGRATE/backfill exécuté en DB réelle. **DATA-005 FAIT (2026-07-22)** : `findings` + `finding_events` (SPEC §7.6/§7.7) posées et **appliquées sur Neon**. Un finding = interprétation déterministe persistante (fingerprint stable, unique `(project_id, fingerprint)` → même problème/2 semaines = même finding) ; `finding_events` = journal append-only (event_type + reason + actor). Helpers purs `finding-state.ts` (fingerprint, scoring §10.2, dérivation d'événements) + write-helper `findings.ts` (upsert idempotent, transition transactionnelle). `npm run test` = **97/97** · `check` = **0 err / 42 warn** · introspection = **47 tables, zéro dérive**. Statuts = 7 de §7.6 + `reopened` ; evidence = pointeurs (pas de texte libre) ; `findings` sans `schema_version` (→ `detector_version`). **Prochain = DATA-006** (débloqué : chaîne proposals/approval + 1er détecteur qui produit de vrais findings depuis les observations). **CONTRACT différé** (l'app lit encore `gsc_query_page_data` + `gmb_insights_daily`). `ai_jobs → jobs` reste **écarté** (voir feature file § Décisions).
Commits : `256c1a2` IDX-008 · `d7484a9` DATA-001 · `b6df05e` DATA-002 · `1ab115f` DATA-003 · `7d3ae9c` DATA-004 · `4696919` migrate/backfill · `7cb94c1` fix chunk + snapshot · _(DATA-005 : à committer)_.
