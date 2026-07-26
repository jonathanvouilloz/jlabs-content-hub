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

**Puis E00** — **DASH-006 est CLOS** (lot 2 : pause/reprise auditable). Suivant : **DASH-003 lot 2**
(trancher **quels onglets** — le BACKLOG et le bloc DASH-003 lot 1 ne listent pas les mêmes, et
`project-cockpit-state.ts` n'a toujours pas été revu), ou **E11/exécution** (approuver n'exécute rien).

**À la main de Jonathan, hors code :**
1. **Login réel** dans le navigateur — `get-session` prouve que l'adaptateur Better Auth `pg` répond,
   pas que la lecture du hash dans `account` marche.
2. **Cron `gmb-publish` du 2026-07-27 09:00 UTC** — premier tir automatique sur Neon (puis
   `gmb-weekly-digest` lundi 08:00).
3. **`hub.jonlabs.ch` ne résout pas** (NXDOMAIN). Sans rapport avec le cutover, mais les docs le
   citent comme URL de prod. L'URL qui répond : `jlabs-content-hub.vercel.app`.

⚠️ **`npm run db:push` depuis `main` = risque de PROD** : `main` déclare 29 tables, Neon en porte 60.

Commit : `f7d6f99` (E00) · prod : `e5efc83` sur `main`
Cerveau : `5d5dbbb` — journal `10-Projets/seo-stats/seo-stats-log.md` (entrée DASH-006).
