# HANDOFF — 2026-07-22 (FIND-001/004 + JOB-001)

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · décision UI → [DECISIONS.md](DECISIONS.md) (2026-07-21).

## Reprendre ici
E00 sur `feat/cockpit`. La couche DATA (DATA-001→008) est close ; **la chaîne agentique tourne
maintenant pour de vrai** : `queue → worker → détecteur → findings`.

**FAIT 2026-07-22 — FIND-001/FIND-004 + JOB-001**, sans aucun DDL (55 tables, zéro dérive).
- **1er détecteur déterministe** `keyword_opportunity@1` : module pur `detector-state.ts` (fenêtres
  hebdo comparables, position pondérée par impressions, seuils configurables par projet, bruit
  configuré, confiance dégradée sur fenêtre incomplète, sévérité plafonnée à faible volume, preuves
  en pointeurs) + IO `detectors/keyword-opportunity.ts` (réutilise `upsertFinding`/`recordFindingEvent`)
  + runner `scripts/detect.ts` (`--dry-run` / réel, run+step de traçabilité, troncature annoncée).
- **JOB-001** : `claimJob` atomique (`FOR UPDATE SKIP LOCKED`, une seule instruction, consomme
  `idx_jobs_claim`), `completeJob`/`failJob`/`releaseJob` gardés par `lease_owner`, boucle `runWorker`
  arrêtable, `scripts/worker.ts` + `scripts/job-claim-concurrency.ts`.
- **Correctif transverse `timestamps.ts`** : format canonique `YYYY-MM-DD HH:MM:SS` (les colonnes
  `text` ont ce DEFAULT ; l'ISO cassait les comparaisons lexicales). Prédicats SQL castés.
- **Injection de client db** : `findings.ts`/`monitoring.ts` importent `db/index.js` dynamiquement →
  les runners `scripts/` réutilisent les vraies fonctions d'écriture.

**Vérifié en réel :** `npm run test` = **231/231** · `check` = **0 err / 42 warn** · introspection =
**55 tables, zéro dérive** · `job-claim-concurrency` = **21/21 sur Neon** (8 workers / 8 jobs, aucun
doublon ; arrêt gracieux sans job orphelin ; backoff puis dead-letter) · détection réelle = **13
findings** (jonlabs 10, bisrepetita 2, physiopommier 1), **0 doublon de fingerprint**, rejeu →
`occurrence_count` incrémenté sans nouvelle ligne · démo bout-en-bout `worker --enqueue` → job
`succeeded` → findings écrits.

**Prochain =** **FIND-003** (cycle de vie : auto-résolution d'un finding qui cesse de matcher, snooze,
réouverture — aujourd'hui un finding reste `open` indéfiniment) et/ou **JOB-002** (renouvellement de
bail, détection de worker mort, remise en queue). Ensuite : l'**agent réel** qui lit ces findings et
produit des `action_proposals` gouvernées par les policies DATA-007, et l'**inbox UI** (E11 — les
findings existent, rien ne les affiche encore).

**À savoir :** le plafond `maxCandidates=50` mord déjà (barberconcept : **1310** couples franchissent
les seuils) — la détection n'est pas exhaustive, le runner le dit. Activation destructive de la purge
(DATA-008 `--execute`) = tâche séparée. **CONTRACT différé** (l'app lit encore `gsc_query_page_data`
+ `gmb_insights_daily`). `ai_jobs → jobs` reste **écarté** (voir feature file § Décisions).

Commits : `256c1a2` IDX-008 · `d7484a9` DATA-001 · `b6df05e` DATA-002 · `1ab115f` DATA-003 · `7d3ae9c` DATA-004 · `4696919` migrate/backfill · `7cb94c1` fix chunk · `f9432ce` DATA-005 · `4c24bc9` docs DATA-005 · `16fa000` DATA-006 · `43fe9d7` docs DATA-006 · `15a92cb` DATA-007 · `a8bdd2f` docs DATA-007 · `0f78d89` DATA-008 · `c6ccc70` docs DATA-008 · `f9b7801` wrap DATA-007/008.
