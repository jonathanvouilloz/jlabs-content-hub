# HANDOFF — index de reprise

> Index léger des features actives. Mis à jour par `/wrap-session`. Dernière maj : 2026-06-24.

> **Pivot 2026-06-24 — jokiSEO.** Le produit devient un cockpit SEO & présence locale. Vision : [PRD-jokiseo.md](PRD-jokiseo.md). Plan : [PLAN.md](PLAN.md) Phase 3 (epics 24-32). Décisions : refactor in-place, Turso conservé, DataForSEO comme fournisseur SEO ([DECISIONS.md](DECISIONS.md), 2026-06-24).

## Features actives

| Epic | Feature | Fichier | Statut |
|------|---------|---------|--------|
| 23 | Suivi de positions mots-clés (SEO) | [features/keyword-position-tracking.md](features/keyword-position-tracking.md) | **ABSORBÉ → epic 27** (code livré, fonctionnel) |
| 24-32 | Refactor jokiSEO | _fichiers `features/` à créer au fil de l'eau_ | **TODO** (cadrage fait dans PRD + PLAN) |

> Les epics 1 à 22 sont DONE (voir [PLAN.md](PLAN.md)). L'epic 23 est livré et reste en prod ; il n'est plus poursuivi en l'état.

## Reprendre ici

**Phase 3 — jokiSEO.** Vision et plan d'epics écrits (PRD-jokiseo.md + PLAN.md Phase 3).
**Prochaine étape :** démarrer l'**epic 24 — Focus & IA** (retrait surface Articles/LinkedIn, nav 2 piliers SEO/Présence locale, cockpit projet unifié) — le cadre qui conditionne tout le reste. Puis **epic 25** (couche providers DataForSEO + runner de jobs) avant les deux douleurs prioritaires (26 avis full-auto, 27 rang réel).
