# HANDOFF — 2026-07-25

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

## Reprendre ici
E00 sur `feat/cockpit` — **le cockpit a été vu à l'œil pour la première fois** (DASH-002 + DASH-003
lot 1). Les invariants tiennent à l'écran ; 4 correctifs verbaux livrés, zéro DDL, aucun calcul touché.
⚠️ **Un point produit à trancher avant tout** : `barberconcept` s'affiche **« Sain » sans avoir jamais
été diagnostiqué** (zéro finding se lit « zéro problème ») — correctif pressenti : un domaine de
diagnostic en état `never` force `signal: unknown`.
Ensuite : **DASH-003 lot 2** (clarifier d'abord quels onglets — BACKLOG et feature file divergent) ou
**DASH-006** (débloqué, JOB-007 est DONE malgré le `BLOCKED` du BACKLOG).
Commit : `c6c05d5` [hub] fix: le cockpit dit ce qu'il mesure (revue visuelle DASH-002/003)
