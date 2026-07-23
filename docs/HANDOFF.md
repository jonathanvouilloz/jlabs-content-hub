# HANDOFF — 2026-07-23

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

## Reprendre ici
E00 sur `feat/cockpit` — **JOB-006 livré** : la file **prévient** le 429 au lieu d'y réagir. Un échec
`quota` met **toute la cohorte** du provider au repos (`available_at` poussé, `attempts`/`deferrals`
**intacts** — ces jobs n'ont rien tenté), un **tour d'équité** empêche un gros projet de prendre tout
un tick, et les plafonds se règlent **sans redéploiement** (`system_settings`, `scripts/limits.ts`).
La garde vit **dans `claimJob`**, comme celle de JOB-004. Premier DDL depuis JOB-003 : **58 tables**.
Prochain : l'**inbox UI** (E11/DASH-005) qui affiche findings ET propositions — tout est en base,
rien ne le montre encore — ou les **collecteurs E03**, qui donneront de vrais consommateurs aux
budgets provider armés ici.

⚠️ Avant de déployer : `barberconcept` écrira toujours ses 50 findings au 1er tick hebdo (décision
maintenue) — mais il ne prendra plus le tick entier. Le budget par fenêtre compte des **jobs**, pas
des **appels API** : c'est le refroidissement qui prévient vraiment.

Commit : `(à renseigner)` [hub] add: JOB-006 limites de concurrence et quotas provider.
