# HANDOFF — 2026-07-26

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Cutover Turso → Neon (Phase 5A) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 5A | **DONE (2026-07-26 14:35 UTC)** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | **EN ATTENTE (Jonathan, infra)** |
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

## Reprendre ici
**Cutover fait** — `main` = `e5efc83`, la prod tourne sur Neon (`/api/whoami` → `version: e5efc83`,
6 projets). Turso figé au 2026-07-26 09:00 UTC, plus lu ni écrit. ⚠️ **Ce qui est déployé, c'est le
socle epics 1-23 sur Neon — PAS le cockpit** : `main` n'a ni `/jobs`, ni `/inbox`, ni le cron `tick`.

**Puis E00** — **DASH-003 lot 2, chantier 1 livré** : la pause entre dans la santé de `/` et de
`/projects/[slug]` (`paused` est un 6ᵉ état de projet, rangé **après `ok`** ; une panne réelle sous
pause reste `broken`). L'arbitrage « quels onglets » est tranché sur pièces : Rapports (REP-\*) et
Analytics (ANA-\*) n'ont **aucun read-model** → hors lot ; Automatisations est livré en cross-projet
depuis DASH-006. Suivant : **chantier 2 — l'onglet Indexation** (`/projects/[slug]/indexing`), le
seul read-model écrit et sans lecteur d'écran (`indexing-read.ts`, `index_selection` — 4 tickets E04
résumés en 4 lignes aujourd'hui). Sinon **E11/exécution** (approuver n'exécute rien : ni runner de
skills — AGT-008 BLOCKED —, ni client d'écriture provider — IDX-007 BLOCKED).

**À la main de Jonathan, hors code :**
1. **Login réel** dans le navigateur — `get-session` prouve que l'adaptateur Better Auth `pg` répond,
   pas que la lecture du hash dans `account` marche.
2. **Cron `gmb-publish` du 2026-07-27 09:00 UTC** — premier tir automatique sur Neon (puis
   `gmb-weekly-digest` lundi 08:00).
3. **`hub.jonlabs.ch` ne résout pas** (NXDOMAIN). Sans rapport avec le cutover, mais les docs le
   citent comme URL de prod. L'URL qui répond : `jlabs-content-hub.vercel.app`.

⚠️ **`npm run db:push` depuis `main` = risque de PROD** : `main` déclare 29 tables, Neon en porte 60.

Commit : `ff2efc5` (E00) · prod : `e5efc83` sur `main`
Cerveau : `5d5dbbb` — journal `10-Projets/seo-stats/seo-stats-log.md` (entrée DASH-006).
