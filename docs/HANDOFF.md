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

✅ **Semaine `2026-07-06` réparée** (2026-07-23) : un seul pull des 6 projets, **+28 670
impressions** (82 229 → 110 899). `spinlink` est ressorti **inchangé** — la contre-épreuve du « 5
sur 6 ». Le diff de `jonlabs` pour `2026-07-13`, qui affirmait +84,3 % contre une base sous-comptée,
a été recalculé à **+35,3 %**. Détail → le bloc DASH-004+005 du fichier feature.

⚠️ **Pas encore refait** : la **détection**. Les 13 findings ont été décidés sur les mesures
sous-comptées ; ils seront re-décidés au prochain run hebdo, sur la donnée réparée — et c'est là que
`barberconcept` écrira ses **50 findings** (décision maintenue).
