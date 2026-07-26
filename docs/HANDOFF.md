# HANDOFF — 2026-07-26

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Cutover Turso → Neon (Phase 5A) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 5A | **EN ATTENTE (Jonathan)** |
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

## Reprendre ici
**Cutover d'abord** — 2 gestes manuels : variable Vercel `DATABASE_URL` → Neon, **puis**
`git merge --ff-only feat/neon` sur `main`. Sans lui, aucune automatisation ne tourne en prod.
**Puis E00** — **DASH-006 est CLOS** (lot 2 : pause/reprise auditable). Suivant : **DASH-003 lot 2**
(trancher **quels onglets** — le BACKLOG et le bloc DASH-003 lot 1 ne listent pas les mêmes, et
`project-cockpit-state.ts` n'a toujours pas été revu), ou **E11/exécution** (approuver n'exécute rien).
Commit : `95db447` [hub] add: une automatisation s'arrête sur décision, pas sur panne (DASH-006 lot 2)
