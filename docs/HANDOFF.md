# HANDOFF — 2026-07-25

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

## Reprendre ici
E00 sur `feat/cockpit`. **IDX-001 + IDX-002 livrés** (enchaînés), après DASH-002.

**IDX-001 — inventaire sitemap.** `collect:sitemap` parcourt l'arbre XML (index → enfants, bornes
dures, cycle stoppé), écrit 1 ligne par **fichier** (`sitemap_observations` : un sitemap injoignable
ou malformé est un **fait persisté** avec `errors > 0`, plus un `catch {}`) et 1 par **URL**
(`sitemap_url_observations`, **seul DDL** du lot : 57 → **58 tables**). Le diff de deux dates est une
**fonction pure** (`diffInventories`) donc rejouable. **Rien n'est écrit avant que tout l'arbre soit
parcouru** — la preuve mesure le faux signal évité (un run tronqué annonce des retraits fantômes).

**IDX-002 — inspection persistante.** `collect:url_inspection` remplit les 7 colonnes de
`index_observations` + un payload borné (SPEC §9.2), avec **zéro DDL**. Une **erreur provider n'écrit
rien et ne se lit jamais « non indexé »** (union discriminée `InspectionOutcome`) ; elle remonte
**structurée** via `toGscApiError`, donc les 7 classes JOB-003 sont exactes. Rerun du jour =
rafraîchit, jour antérieur = intact. Lecture par `indexing-read.ts`, **sans réseau**.

Prochain : **IDX-004** (politique de sélection/quotas — débloqué : IDX-001 donne la source, IDX-002
l'exécutant) · **IDX-005** (détecteur de transitions, débloqué) · **DASH-003** (cockpit projet).

⚠️ **Pièges vivants** : `= ANY` interdit avec Neon (bornes / `inArray`) · **`collect:url_inspection`
n'est PAS au catalogue hebdo** (attend IDX-004 ; un payload sans `urls` ne fait rien et le dit) ·
le **refroidissement est partagé** avec la collecte GSC (même service account) — un 429 d'inspection
met aussi `collect:gsc_query_page` au repos · **aucun écran ne consomme encore `indexing-read.ts`**
(c'est DASH-003) · `indexing.ts` reste dette datée (ne pas l'appeler, ne pas l'importer dans un
runner `tsx`) · un inventaire sitemap partiel ne doit **jamais** être écrit · l'accueil et
`/windows` n'ont jamais été vus à l'œil (pas de session admin) · `npm run build` échoue à
l'adaptateur Vercel sous Windows (**préexistant**) · `gsc-002` non rejoué (quota).

Commits : `ebf127b` (IDX-001) · `PENDING-IDX-002` (IDX-002)
