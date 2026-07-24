# HANDOFF — 2026-07-24

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

## Reprendre ici
E00 sur `feat/cockpit`. **GSC-004 livré** : fenêtres 7/28/90 j (canon observations, delta gardé par
comparabilité, confiance dérivée), latence GSC réglable (`system_settings` → `gsc.latency_days`),
backfill borné **reprenable** piloté par la file (`scripts/backfill-gsc.ts`, reprise dérivée sans
checkpoint), endpoint `GET /gsc/windows` + panneau `/projects/[slug]/windows`. YoY câblé mais inerte
(pas de N-1 avant 2027). **Zéro DDL** (57 tables `seostats`, `schema.ts` intact).

Prochain : **DASH-002** (accueil cross-projet) · **IDX-001/002** (sitemap, URL Inspection) ·
**DASH-003** (cockpit projet, débloqué côté fenêtres — consommera `/gsc/windows`).

⚠️ **Pièges vivants** : `= ANY` interdit avec Neon (bornes `>=`/`<=`) · le read-model lit le CANON,
jamais le legacy · le `batch` du backfill est un débit, pas un curseur (rappel = idempotent) · panneau
`/windows` non constatable sans session admin · `gsc-002` non rejoué (quota) — à rejouer au prochain
run de collecte réel.

Commit : _(à référencer)_ [hub] add: GSC-004 fenêtres de comparaison, backfill reprenable, latence réglable
