# HANDOFF — 2026-07-21

## Chantiers actifs
| Chantier | Fichier | Statut |
|---|---|---|
| Reconstruction agentique (cockpit) | [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) | **PROCHAIN** — implémentation à démarrer (premier lot §9) |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | QUASI FINI — P4 données ✅ vérifiée · reste P6 (roter password + décommissionner Turso), *reporté* |

## Décision verrouillée (2026-07-21)
**UI cockpit neuve from-scratch, backend gardé intact.** Nouveau groupe de routes `src/routes/(cockpit)/`
qui consomme les 71 endpoints `/api/*` + le schéma Neon (29 tables, migré+vérifié) + intégrations/auth/crons.
L'ancien `(app)/` est gelé puis retiré à parité. Stack gardée : SvelteKit 2 / Svelte 5 / Tailwind v4 / Skeleton v4.
Détail + alternatives → `docs/DECISIONS.md` (ligne 2026-07-21 UI).

## Reprendre ici
**Démarrer l'implémentation agentique** : lire `docs/BACKLOG.md` §9 (premier lot) + les epics E00→E13, choisir le
point d'entrée, et scaffolder le groupe de routes `(cockpit)/`. Le backend ne bouge pas.
Séparément et plus tard : Phase 6 (rotation password Neon `npg_k4teo0HIxPKF…`, côté console Neon).

**Commit :** `92835a5` [hub] docs: refonte doc seo-stats (cockpit agentique) + rangement — *changements de cette session non commités*
**Branche :** `feat/neon` (non mergée dans `main`, décision en attente).
**Note tooling :** `@libsql/client` réinstallé en `--no-save` (package.json intact) ; `scripts/migrate/` (4 scripts export/reconcile/verify/flip) ajouté ; `.env` local repointé Turso→Neon (gitignoré).
