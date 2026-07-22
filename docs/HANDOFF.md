# HANDOFF — 2026-07-22

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · [DECISIONS.md](DECISIONS.md).

## Reprendre ici
E00 sur `feat/cockpit` — **JOB-007 livré** : la file a enfin une interface (`/jobs` + `/jobs/[id]`),
qui lit `jobs` + `job_attempts` et appelle les mêmes fonctions que la CLI (`requeueDeadJob`, et la
nouvelle `cancelJob`). Les 22 lignes de test `__test_claim` ont été **purgées** (script rejouable
`scripts/jobs-purge-test.ts`) : la file réelle ne contient plus que 6 jobs, tous `succeeded`.

**Prochain, au choix :** l'**agent réel** qui lit les findings et produit des `action_proposals`
gouvernées par les policies DATA-007 · **JOB-005** (scheduler timezone-aware — aujourd'hui aucun
worker ne tourne seul, tout dépend d'un lancement manuel, ce qui limite l'effet du bouton
« Relancer ») · **JOB-006** (prévenir le 429 au lieu d'y réagir). L'inbox UI (E11) reste à faire.

Commit : `[hub] add: JOB-007 console d'exploitation des jobs (liste, chronologie, retry, annulation)`.

**À faire au prochain passage devant l'écran :** le rendu des deux pages n'a pas pu être constaté
(session admin requise) — ouvrir `/jobs` une fois connecté. `npm run build` échoue par ailleurs sur
un symlink de l'adaptateur Vercel (EPERM Windows) : environnement, pas code.
