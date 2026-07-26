# HANDOFF — 2026-07-26

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | EN ATTENTE (Jonathan, infra) |

## Reprendre ici
**E00 — DASH-003 lot 2 chantier 2 livré** (l'onglet Indexation : `indexing-read.ts` et
`index_selection` ont enfin un lecteur d'écran). Suivant : **DASH-007** (coûts et capacité) ou
**E11/exécution** (approuver n'exécute toujours rien — AGT-008 et IDX-007 BLOCKED).

⚠️ **Le cockpit n'est PAS en prod** : `main` = socle epics 1-23 sur Neon, ni `/jobs`, ni `/inbox`,
ni cron `tick`. `npm run db:push` depuis `main` = risque de PROD (29 tables déclarées, 60 en base).
⚠️ **La prod écrit dans la même base** → toute assertion « base rendue à l'identique » sur
`gsc_query_page_observations` est racée (`dash-002-home-proof` en porte une).

Commit : `351a380` (E00) · prod : `e5efc83` sur `main`
