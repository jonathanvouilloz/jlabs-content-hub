# HANDOFF — 2026-07-23

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

> **Migration Turso → Neon : terminée côté code et données.** Plus de `@libsql/client` dans
> `package.json`, plus de `DATABASE_AUTH_TOKEN`, `db/index.ts` en `neon-serverless`, 58 tables
> vérifiées dans `seostats`. Ne restent que **deux gestes d'infra**, hors code et hors chemin
> critique : roter le password Neon exposé en chat les 2026-07-20/21, et supprimer la base Turso
> (dump archivé). Détail → [NEON-MIGRATION.md](NEON-MIGRATION.md).

## Reprendre ici
E00 sur `feat/cockpit` — **GSC-001 + GSC-002 livrés** : le collecteur GSC est gouverné par la file
(prérequis obligatoire du détecteur, cohorte quota `gsc`, erreurs structurées), unique lecteur GSC,
double écriture legacy. Les observations avancent enfin — `jonlabs` est passé à la semaine
`2026-07-13`, 17 semaines.

Prochain : l'**inbox UI** (E11/DASH-005) — 13 findings et 4 propositions sont en base, **rien ne les
montre** — ou **GSC-004** (fenêtres 7/28/90 j, backfill borné).

⚠️ **Décision en attente** : 5 projets sur 6 ont leur semaine `2026-07-06` **sous-comptée de ~36 %**
(tirée à la main 1 jour après sa fin, avant ce lot). Réparation = `npx tsx scripts/collect-gsc.ts
--project=all --week=2026-07-06` — un pull GSC des 6 projets d'un coup.
