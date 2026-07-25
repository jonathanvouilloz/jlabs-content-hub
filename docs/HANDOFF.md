# HANDOFF — 2026-07-25

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

## Reprendre ici
E00 sur `feat/cockpit` — **IDX-004 lot 2 livré, IDX-004 est CLOS**. Une publication d'article pose
ses échéances J+3/J+7/J+28 (aucun quota consommé), la cadence quotidienne `scope: 'due'` les honore
et détecte dans la foulée, et `scripts/inspect-urls.ts` permet un audit manuel borné (dry-run par
défaut).
Prochain : **DASH-003** (cockpit projet) — le seul écran qui lira `indexing-read.ts` et
`index_selection`, aujourd'hui invisibles. Toujours bloqué par DASH-001 seul.
Commit : (à faire) [hub] add: IDX-004 lot 2, échéances post-publication et audit manuel borné
