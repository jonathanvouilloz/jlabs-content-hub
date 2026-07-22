# HANDOFF — 2026-07-22

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · [DECISIONS.md](DECISIONS.md).

## Reprendre ici
E00 sur `feat/cockpit` — **JOB-007** : console d'exploitation des jobs (lister queued/running/failed/
dead, retry ciblé, annulation, inspection). Toute la donnée existe déjà : `jobs` + `job_attempts`
(chronologie append-only) + `last_error_class`/`deferrals`/`requeued_count`, et les fonctions
`listDeadJobs`/`requeueDeadJob` que la page n'aura qu'à appeler — voir `scripts/jobs-inspect.ts` et
`scripts/jobs-requeue.ts`, qui rendent déjà la même chose en CLI. Alternative : l'**agent réel** qui
lit les findings et produit des `action_proposals` gouvernées par les policies DATA-007.
Contexte, pièges et carte du code → le fichier feature. JOB-003 vient de fermer le trou « toute
erreur traitée pareil » et débloque JOB-006, JOB-007, IDX-007 et GMB-006.

**À trancher avant JOB-007 :** 22 lignes de test `__test_claim` (dont **7 en dead-letter**) traînent
dans la vraie file, héritées d'exécutions dont le nettoyage échouait en silence (corrigé). Elles
pollueront la console. Purge proposée, non exécutée.
