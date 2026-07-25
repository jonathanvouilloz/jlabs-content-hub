# HANDOFF — 2026-07-25

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

## Reprendre ici
E00 sur `feat/cockpit` — **IDX-004 lot 1 livré** (la branche d'indexation du graphe hebdo est fermée).
Prochain : **IDX-004 lot 2** — cadence quotidienne `scope: 'due'`, `scheduleIndexChecks` appelé depuis
`src/routes/api/content/[id]/status/+server.ts` (J+3/J+7/J+28), CLI `scripts/inspect-urls.ts`.
Commit : `48511b1` [hub] add: IDX-004 lot 1, politique de sélection et quotas d'inspection
