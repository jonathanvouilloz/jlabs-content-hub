# HANDOFF — 2026-07-26

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Cutover Turso → Neon (Phase 5A) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 5A | **EN ATTENTE (Jonathan)** |
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

## Reprendre ici
**Cutover d'abord** — `main` porte encore le code libsql, la prod tourne sur Turso. Données déjà
rattrapées ; restent 2 gestes manuels : variable Vercel `DATABASE_URL` → Neon, **puis**
`git merge --ff-only feat/neon` sur `main`.
**Puis E00** — DASH-003 lot 2 (trancher quels onglets) ou DASH-006.
Commit : `d1ced4a` [hub] fix: un projet jamais diagnostiqué ne se lit plus « Sain »
