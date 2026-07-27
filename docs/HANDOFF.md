# HANDOFF — 2026-07-27

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | EN ATTENTE (Jonathan, infra) |

## Reprendre ici
**FIND-005 livré** — le cockpit sait enfin voir une **baisse** : il n'avait que deux détecteurs
(`keyword_opportunity`, `index_transition`) pour six écrans. Suivant : **FIND-006** (nouvelles
et perdues — `vanished`/`appeared` sont déjà comptés) ou **REP-001** (rapport hebdo
déterministe, qui débloque le rapport du lundi et l'onglet Rapports).

**Gate M2, ce qui reste :** détecteurs `new_query`/`lost_query`/`ctr_gap`/`cannibalization`
(FIND-006→008) et **tout E07** (REP-001→004). Le reste de la gate est coché.

⚠️ **Le cockpit n'est PAS en prod** : `main` = socle epics 1-23 sur Neon, ni `/jobs`, ni
`/inbox`, ni cron `tick`. `npm run db:push` depuis `main` = risque de PROD (29 tables déclarées,
60 en base).
⚠️ **Au premier run du nouveau détecteur, les 9 projets passent de `ok` à `watch`** (couverture
de diagnostic `partial` : il n'a jamais tourné). Se résorbe seul au premier tick hebdo.
⚠️ **La prod écrit dans la même base** → toute assertion « base rendue à l'identique » sur
`gsc_query_page_observations` est racée (`dash-002-home-proof` en porte une).

Commit : `0854621` (E00) · prod : `e5efc83` sur `main`
