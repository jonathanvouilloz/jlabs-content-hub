# HANDOFF — 2026-07-27

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | EN ATTENTE (Jonathan, infra) |

## Reprendre ici
**REP-003 livré** — le rapport du lundi **existe** désormais : déclenché par le tick sur le
créneau hebdo, il attend les steps du parc, publie `complete` ou `partial` à l'échéance, et
**survit au restart** (table `weekly_reports`, 61 tables). La publication n'est **pas** un job
de file — `jobs.project_id` est NOT NULL alors que le rapport est cross-projet. Suivant :
**REP-004** (historique et comparaison, qui donne enfin des lignes à comparer et rend la
révision d'un `partial` possible) ou **FIND-006** (nouvelles et perdues).

**Gate M2 :** tout est coché **sauf** les détecteurs `new_query`/`lost_query`/`ctr_gap`/
`cannibalization` (FIND-006→008). REP-002/004 sont P1.

⚠️ **Un rapport publié `partial` ne devient jamais `complete`** : republier est un no-op, pas
un écrasement (graine de REP-004).
⚠️ **Au premier tick après merge, le rapport de la semaine partira `partial` avec les 9 projets
`missing`** (aucun run hebdo n'a jamais tourné). C'est la mesure exacte, pas un bug.
⚠️ **Le SLO de 10:00 est structurellement à risque** : 54 jobs hebdo pour
`MAX_JOBS_PER_TICK = 25`. Leviers : le plafond par tick, ou `report.publish_deadline_minutes`
(`system_settings`, sans redéploiement) — après avoir lu la mesure.
⚠️ **L'annonce de disponibilité est produite, pas envoyée** (TEL-001 BLOCKED) ; l'envoi est
TEL-002.
⚠️ **Aucun écran ne lit `weekly_reports`** : `npx tsx scripts/rep-003-publish.ts --list |
--show [créneau] | --dry-run`. L'onglet Rapports est DASH-003 lot 2 chantier 3.
⚠️ **Le cockpit n'est PAS en prod** : `main` = socle epics 1-23 sur Neon, ni `/jobs`, ni
`/inbox`, ni cron `tick`. `npm run db:push` depuis `main` = risque de PROD (29 tables
déclarées, 61 en base).
⚠️ **La prod écrit dans la même base** → toute assertion « base rendue à l'identique » sur
`gsc_query_page_observations` est racée (`dash-002-home-proof` en porte une).

Commit : `9cf59c6` (E00, avant REP-003) · prod : `e5efc83` sur `main`
