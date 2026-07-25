# HANDOFF — 2026-07-25

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

## Reprendre ici
E00 sur `feat/cockpit` — **DASH-002, IDX-001, IDX-002, IDX-005 et IDX-004 lot 1 livrés**. La
branche d'indexation du graphe hebdo est fermée (`sitemap` → `url_inspection` → `index_transition`,
arête finale obligatoire) et `index_selection` (59ᵉ table) porte les décisions de dépense de quota.
Prochain : **IDX-004 lot 2** — cadence quotidienne `scope: 'due'`, `scheduleIndexChecks` appelé
depuis `src/routes/api/content/[id]/status/+server.ts` (J+3/J+7/J+28), et CLI d'audit borné
`scripts/inspect-urls.ts`. Sinon **DASH-003** (cockpit projet), encore bloqué par DASH-001 seul.
Détail, pièges et Carte du code → le fichier feature.
Commit : `48511b1` [hub] add: IDX-004 lot 1, politique de sélection et quotas d'inspection
