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

**2. E00 sur `feat/cockpit`** (63 commits non poussés). Le cockpit a été vu à l'œil (DASH-002 +
DASH-003 lot 1) ; les invariants tiennent, 4 correctifs verbaux livrés.
⚠️ **Point produit à trancher** : `barberconcept` s'affiche « Sain » sans avoir jamais été
diagnostiqué (zéro finding se lit « zéro problème ») — correctif pressenti : un domaine de diagnostic
en état `never` force `signal: unknown`.
Ensuite : **DASH-003 lot 2** (clarifier d'abord quels onglets — BACKLOG et feature file divergent) ou
**DASH-006** (débloqué, JOB-007 est DONE malgré le `BLOCKED` du BACKLOG).

Commit E00 le plus récent : `8d193d6` docs: wrap de session — le cockpit vu à l'œil.
