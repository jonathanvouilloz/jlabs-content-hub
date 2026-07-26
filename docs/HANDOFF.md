# HANDOFF — 2026-07-26

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Cutover Turso → Neon (Phase 5A) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 5A | **EN ATTENTE (Jonathan)** |
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

## Reprendre ici
**Cutover d'abord** — 2 gestes manuels : variable Vercel `DATABASE_URL` → Neon, **puis**
`git merge --ff-only feat/neon` sur `main`. `/automations` vient de le confirmer à l'écran :
**12 créneaux manqués sur 12**, aucun run hebdomadaire jamais tiré — le cron `/tick` vit sur
la branche, pas en prod.
**Puis E00** — DASH-006 lot 2 (pause/reprise auditable : trancher **où vit une pause**, pas dans
`project_projections` qui est recompilée) ou DASH-003 lot 2 (quels onglets).
Commit : `492d9c8` [hub] add: le cockpit voit enfin le créneau qui N'A PAS eu lieu (DASH-006 lot 1)
