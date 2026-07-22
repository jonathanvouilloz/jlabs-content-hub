# HANDOFF — 2026-07-22

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

## Reprendre ici
E00 sur `feat/cockpit` — **JOB-004 livré** : `detect → propose` est enfin une **vraie dépendance**
(garde dans `claimJob`), un prérequis obligatoire mort **saute** son dépendant (`skipped`) au lieu de
le laisser `queued` à vie, et le run le dit (`partial`, donnée manquante nommée). Un prérequis
**optionnel** mort ne bloque personne. Prochain : **JOB-006** (prévenir le 429), ou l'**inbox UI**
(E11/DASH-005) qui affiche findings ET propositions — tout est en base, rien ne le montre encore.
⚠️ Avant de déployer : `barberconcept` écrira ses 50 findings au 1er tick (décidé : on laisse aller) ;
son `propose:actions` attendra désormais la fin de cette détection.
Commit : `c0d3dd4` [hub] add: JOB-004 dépendances entre jobs.
