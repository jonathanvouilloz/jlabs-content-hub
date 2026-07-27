# HANDOFF — 2026-07-27

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | EN ATTENTE (Jonathan, infra) |

## Reprendre ici
**REP-001 livré** — E07 était à **zéro ligne** alors que quatre tickets P0 l'attendaient. Le
cockpit sait maintenant produire un rapport hebdo **déterministe, versionné et sans LLM**, où
un provider non branché est **absent** (pas zéro) et où une section de findings vide sur un
parc jamais diagnostiqué se déclare **non examinée** (pas « rien à signaler »). Suivant :
**REP-003** (publication du rapport du lundi — dernière case P0 de la gate M2, débloquée par
ce lot) ou **REP-004** (historique et comparaison, la raison d'être du JSON versionné).

**Gate M2, ce qui reste :** détecteurs `new_query`/`lost_query`/`ctr_gap`/`cannibalization`
(FIND-006→008) et **REP-003** (REP-002/004 sont P1). Le reste de la gate est coché.

⚠️ **Le rapport n'est ni planifié, ni publié, ni stocké** : aucun cron, aucune route, aucune
table. Il s'appelle à la main (`npx tsx scripts/rep-001-preview.ts`). C'est le périmètre du
ticket — REP-003 publie, REP-004 archive.
⚠️ **Deux sections sur douze sont ABSENTES aujourd'hui, et c'est correct** : `index_observations`
est à 0 ligne et aucun projet ne déclare `plausible`.
⚠️ **Le cockpit n'est PAS en prod** : `main` = socle epics 1-23 sur Neon, ni `/jobs`, ni
`/inbox`, ni cron `tick`. `npm run db:push` depuis `main` = risque de PROD (29 tables déclarées,
60 en base).
⚠️ **Les 9 projets sont tous non-`ok`** depuis FIND-005 (couverture de diagnostic `partial` ou
`none`) : la section 2 du rapport liste donc tout le parc. Se résorbe au premier tick hebdo.
⚠️ **La prod écrit dans la même base** → toute assertion « base rendue à l'identique » sur
`gsc_query_page_observations` est racée (`dash-002-home-proof` en porte une).

Commit : `9cf59c6` (E00) · prod : `e5efc83` sur `main`
