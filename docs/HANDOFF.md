# HANDOFF — 2026-07-25

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

## Reprendre ici
E00 sur `feat/cockpit` — **DASH-003 lot 1 livré**. `/projects/[slug]` est le cockpit projet : santé
à deux axes (la même que l'accueil, jamais recalculée), panneaux GSC / Indexation / Diagnostic avec
période + fraîcheur + source, timeline runs + diagnostics + décisions. Le calendrier de contenus a
déménagé en `/projects/[slug]/content`.
⚠️ **Jamais vu à l'œil** (pas de session admin) — tout est prouvé côté données, rien côté rendu.
Prochain : **DASH-003 lot 2** (onglets Mots-clés / Rapports / Automatisations — read-models à
écrire d'abord) ou **DASH-006** (vue automatisations, qui donnerait sa liste au compteur
`runs_period`, muet depuis DASH-002).
Commit : (à faire) [hub] add: DASH-003 lot 1, cockpit projet et timeline des décisions
