# HANDOFF — 2026-07-21

## Chantiers actifs
| Chantier | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) · [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) | **EN COURS** — bloc in-repo fait (logger/config/flags), reste §9 : GOV-001(fin), DATA-001, GSC-003, IDX-003, IDX-008 |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | QUASI FINI — P4 données ✅ vérifiée · reste P6 (roter password + décommissionner Turso), *reporté* |

## Décision verrouillée (2026-07-21)
**UI cockpit neuve from-scratch, backend gardé intact.** Nouveau groupe de routes `src/routes/(cockpit)/`
qui consomme les 71 endpoints `/api/*` + le schéma Neon (29 tables, migré+vérifié) + intégrations/auth/crons.
L'ancien `(app)/` est gelé puis retiré à parité. Stack gardée : SvelteKit 2 / Svelte 5 / Tailwind v4 / Skeleton v4.
Détail + alternatives → `docs/DECISIONS.md` (ligne 2026-07-21 UI).

## Reprendre ici
**Continuer le premier lot §9** sur la branche `feat/cockpit` : le bloc fondations in-repo est fait +
commité (`3d9be7d`). Prochain choix de bloc → `docs/features/e00-fondations-cockpit.md` §« Reste du premier
lot » : DATA-001 (cartographie schéma), IDX-008 (restreindre Indexing API, in-repo), ou les contrats skills
GSC-003/IDX-003 (hors repo). Décision de marque en attente : 3 chaînes `jlabs-content-hub` client-facing.
Séparément et plus tard : Phase 6 Neon (rotation password, côté console Neon).

**Commit :** `3d9be7d` [hub] add: fondations cockpit — logger, config, flags (GOV-003/005, OPS-001).
**Branche :** `feat/cockpit` (depuis `feat/neon`, non mergée). `feat/neon` reste figée pour le cutover P5A.
**Note tooling :** `@libsql/client` réinstallé en `--no-save` (package.json intact) ; `scripts/migrate/` (4 scripts export/reconcile/verify/flip) ajouté ; `.env` local repointé Turso→Neon (gitignoré).
