# HANDOFF — index de reprise

> Index léger de l'état du projet. Dernière maj : 2026-07-21.

> **Cap 2026-07-21 — seo-stats, cockpit agentique de monitoring.** Le produit délègue 90% du monitoring
> SEO & présence locale à des agents (findings persistants + validation humaine). Vision : [SPEC.md](SPEC.md).
> Exécution : [BACKLOG.md](BACKLOG.md). Décisions : [DECISIONS.md](DECISIONS.md).
> Le pivot jokiSEO (2026-06-24) est absorbé/dépassé (archives dans `_archive/`).

## Chantier transverse en cours : migration Turso → Neon

Détail complet : [NEON-MIGRATION.md](NEON-MIGRATION.md).

| Phase | Objet | Statut |
|------|-------|--------|
| 0-2 | Neon restructuré (3 schémas `core`/`invoices`/`seostats`) + côté invoices | ✅ fait (2026-07-20) |
| 3 | Refactor **code** seo-stats Turso→Neon | ✅ **fait + commité** (branche `feat/neon`, typecheck 0 err) |
| 5 | App déplacée dans `noyau/seo-stats` | ✅ fait |
| **4** | **Migration des DONNÉES Turso → Neon `seostats`** | ⏳ **PROCHAINE ÉTAPE** |
| 6 | Roter password Neon + décommissionner Turso | ⏳ à faire |

## Reprendre ici

**Prochaine étape : Phase 4 — migrer les données de Turso vers Neon `seostats`.**

1. Trancher le slug canonique `bis-repetita` vs `bisrepetita` contre `cerveau/_system/projects.yaml` (bloquant FK).
2. Écrire le script d'export Turso → transform (bool 0/1→bool PG, dates texte→timestamptz) → load dans `seostats.*`
   (ordre FK : `projects` d'abord).
3. Poser la FK `seostats.projects.slug → core.entities.slug` une fois les slugs canonicalisés.
4. Vérif intégrité : counts par table = source, FK OK, échantillon de lignes.
5. Puis Phase 6 (rotation secret + décommission Turso).

**Ensuite seulement :** démarrer la reconstruction agentique — premier lot [BACKLOG.md](BACKLOG.md) §9
(`GOV-001`→`005`, `DATA-001`, `GSC-003`, `IDX-003`, `IDX-008`, `OPS-001`), sans provider payant.

## Socle livré (référence)

Epics 1-22 DONE, epic 23 (positions GSC) livré et en prod. Historique : [PLAN.md](PLAN.md).
Features documentées : `docs/features/*.md`.
