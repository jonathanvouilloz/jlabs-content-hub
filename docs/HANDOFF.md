# HANDOFF — 2026-07-27

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | EN ATTENTE (Jonathan, infra) |

## Reprendre ici
**FIND-006 livré** — le portefeuille de requêtes a enfin ses **entrées et ses sorties**
(`new_query` + `lost_query`), là où FIND-005 comptait les disparitions sans pouvoir les
traiter. Le point du lot n'est pas la détection mais le **regroupement de variantes** :
il empêche deux faux signaux symétriques (une « découverte » qui n'est que l'orthographe
d'une « perte ») — **581 évités sur le seul `barberconcept`**. Suivant : **FIND-008**
(cannibalisation, **P0**, dernière case de la gate M2) ou **FIND-007** (CTR gap, P1) ;
sinon **REP-004** (historique et comparaison).

**Gate M2 :** tout est coché **sauf** `ctr_gap` et `cannibalization` (FIND-007/008).
REP-002/004 sont P1.

⚠️ **Le parc ne perd rien aujourd'hui : `LOST = 0` sur les 9 projets** (937 disparitions
comptées et écartées sur `barberconcept`, 82 sur `lecureux` — toutes sous 50 impressions
ou moins de 2 semaines). Ne pas baisser le seuil sans avoir relu cette mesure.
⚠️ **Une découverte non traitée s'auto-résout** au bout de la fenêtre de 4 semaines : la
nouveauté est périssable, et personne n'est prévenu.
⚠️ **Un rapport publié `partial` ne devient jamais `complete`** : republier est un no-op
(graine de REP-004).
⚠️ **Au premier tick après merge : jusqu'à 150 findings par projet frais** (50
opportunités + 50 baisses + 50 nouveautés) et le rapport de la semaine part `partial`
avec les 9 projets `missing`. C'est la mesure exacte, pas un bug.
⚠️ **Le SLO de 10:00 s'éloigne : 63 jobs hebdo** (9 projets × 7 entrées) pour
`MAX_JOBS_PER_TICK = 25`. Leviers : le plafond par tick, ou
`report.publish_deadline_minutes` (`system_settings`, sans redéploiement) — après avoir
lu la mesure.
⚠️ **L'annonce de disponibilité est produite, pas envoyée** (TEL-001 BLOCKED) ; l'envoi
est TEL-002.
⚠️ **Aucun écran ne lit `weekly_reports`** ni les findings de turnover :
`npx tsx scripts/rep-003-publish.ts --list | --show [créneau] | --dry-run`. L'onglet
Rapports est DASH-003 lot 2 chantier 3.
⚠️ **Le cockpit n'est PAS en prod** : `main` = socle epics 1-23 sur Neon, ni `/jobs`, ni
`/inbox`, ni cron `tick`. `npm run db:push` depuis `main` = risque de PROD (29 tables
déclarées, 61 en base).
⚠️ **La prod écrit dans la même base** → toute assertion « base rendue à l'identique » sur
`gsc_query_page_observations` est racée (`dash-002-home-proof` en porte une).

Commit : `HEAD` (E00) · prod : `e5efc83` sur `main`
