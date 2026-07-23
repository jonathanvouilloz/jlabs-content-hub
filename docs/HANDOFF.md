# HANDOFF — 2026-07-23

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

> **Migration Turso → Neon : terminée côté code et données.** Plus de `@libsql/client` dans
> `package.json`, plus de `DATABASE_AUTH_TOKEN`, `db/index.ts` en `neon-serverless`, 58 tables
> vérifiées (57 `seostats` + 1 miroir `core`). Ne restent que **deux gestes d'infra**, hors code et
> hors chemin critique : roter le password Neon exposé en chat les 2026-07-20/21, et supprimer la
> base Turso (dump archivé). Détail → [NEON-MIGRATION.md](NEON-MIGRATION.md).

## Reprendre ici
E00 sur `feat/cockpit` — **DASH-004+005 livrés** : l'**inbox** existe (`/inbox`, deux onglets). Les
13 findings et les 4 propositions L3 sont enfin **visibles et décidables** — approuver (lié au hash
exact, idempotent), rejeter ou demander une révision, avec raison obligatoire journalisée, et
validation groupée en lots homogènes dont les **L4 sont exclues**. ⚠️ Approuver **n'exécute rien** :
aucun handler d'exécution n'existe encore.

Prochain : **GSC-004** (fenêtres 7/28/90 j, backfill borné, périodes incomplètes) · **IDX-001/002**
(sitemap, URL Inspection) · **DASH-002** (accueil cross-projet), qui a maintenant une inbox où
pointer ses compteurs.

⚠️ **Décision toujours en attente** : 5 projets sur 6 ont leur semaine `2026-07-06` **sous-comptée
de ~36 %** (tirée à la main 1 jour après sa fin). Réparation = `npx tsx scripts/collect-gsc.ts
--project=all --week=2026-07-06` — un pull GSC des 6 projets d'un coup.
