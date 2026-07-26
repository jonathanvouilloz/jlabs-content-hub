# HANDOFF — 2026-07-26

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Cutover Turso → Neon (Phase 5A) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 5A | **EN ATTENTE (Jonathan)** |
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

## Reprendre ici

**1. Cutover (prioritaire, 2 gestes, il faut Jonathan).** Découvert le 2026-07-26 : `main` — ce que
Vercel déploie — porte **encore le code libsql**, donc **Turso est toujours la base de production**.
La migration Neon vit sur `feat/neon`, absorbée dans `feat/cockpit`. Les docs disaient « migration
terminée » : vrai pour la branche, faux pour la prod.
Fait aujourd'hui : **222 lignes de dérive prod rattrapées** dans Neon (dont un article publié le
2026-07-24), 79 FK vérifiées 0 orphelin, arbre de bascule typecheck 0 erreur.
Reste, dans cet ordre : **(a)** Vercel Production `DATABASE_URL` → Neon + supprimer
`DATABASE_AUTH_TOKEN` ; **(b)** `git switch main && git merge --ff-only feat/neon && git push origin main`.
L'ordre donne zéro coupure — détail, vérifs et rollback → `NEON-MIGRATION.md` § Phase 5A.
⚠️ Après le merge, **ne jamais lancer `db:push` depuis `main`** (29 tables déclarées contre 59 en base).

**2. E00 sur `feat/cockpit`** (commits non poussés). Le cockpit a été vu à l'œil (DASH-002 +
DASH-003 lot 1) ; les invariants tiennent, 4 correctifs verbaux livrés.
✅ **Point produit tranché le 2026-07-26** : un projet jamais diagnostiqué ne se lit plus « Sain ».
`ok` n'est atteignable que sur un diagnostic complet ; rien d'examiné → `unknown`, partiellement
examiné sans rien trouver → `watch`. État réel : 3 projets `unknown` (0/2 détecteurs), 3 `watch`
(indexation jamais examinée). Détail → `features/e00-fondations-cockpit.md`, session 2026-07-26.
Ensuite : **DASH-003 lot 2** (clarifier d'abord quels onglets — BACKLOG et feature file divergent) ou
**DASH-006** (débloqué, JOB-007 est DONE malgré le `BLOCKED` du BACKLOG).
⚠️ La règle de couverture ne vaut que pour l'accueil : `project-cockpit-state.ts` (DASH-003) porte
son propre jugement, non revu — à vérifier quand DASH-003 reprendra.
