# HANDOFF — 2026-07-22 (FIND-003 — cycle de vie)

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Migration Turso → Neon | [NEON-MIGRATION.md](NEON-MIGRATION.md) | EN ATTENTE (reste P6, reporté) |

Cadre produit : [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · décision UI → [DECISIONS.md](DECISIONS.md) (2026-07-21).

## Reprendre ici
E00 sur `feat/cockpit`. La couche DATA est close, la chaîne agentique tourne
(`queue → worker → détecteur → findings`), et depuis aujourd'hui **les findings vivent un cycle** :
ils se ferment, se rouvrent et se mettent en veille tout seuls.

**FAIT 2026-07-22 — FIND-003**, sans aucune table nouvelle (55 tables, zéro dérive) : 5 colonnes
additives sur `findings` (`snoozed_until`, `snooze_reason`, `consecutive_misses`, `reopen_count`,
`dismissal_category`) + index partiel d'expiration.
- **Auto-résolution correcte malgré la troncature** : la closure d'un run = `selection.matched`
  **complet** (avant plafond `maxCandidates`), jamais les 50 écrits. Sans ça, barberconcept fermerait
  1260 findings bien vivants. Deux gardes de plus : aucune réconciliation sur un **run non
  autoritaire** (fenêtre absente / zéro observation), et **N absences consécutives** requises (défaut
  2, configurable par projet).
- **Purs** (`finding-state.ts`) : `canTransition` (graphe §10.1 gardé à l'écriture),
  `decideOnRedetection`, `decideOnAbsence`, `isSnoozeExpired`/`computeSnoozeUntil`,
  `resolveLifecycleConfig`. Nouvel événement **`unsnoozed`**.
- **IO** (`findings.ts`) sur le `transitionFinding` existant : `snoozeFinding`/`dismissFinding`/
  `reopenFinding`, `expireSnoozes`, **`reconcileDetectionRun`**.
- **Câblage** : veilles réveillées avant la détection, réconciliation après, bilan `lifecycle` dans le
  `monitoring_step` et dans le rapport du runner. Nouveau job **`findings:lifecycle`** (l'expiration
  ne dépend pas d'un run de détection).

**Décisions produit :** **le snooze tient** jusqu'à son échéance (aggravation journalisée, sans effet)
· **le dismiss vaut à vie** (`occurrence_count` monte pour la mesure FIND-010, mais seul un humain
rouvre).

**Vérifié en réel :** `npm run test` = **264/264** · `check` = **0 err / 42 warn** · introspection =
**55 tables, zéro dérive** (5/5 colonnes + index) · **`find-003-lifecycle-proof` = 37/37 sur Neon**
(persistance, auto-résolution confirmée, récidive → réouverture, veille expirée, snooze et dismiss qui
tiennent, transition illégale refusée) · détection rejouée sur les 3 projets peuplés → **0
auto-résolution abusive** · `queue → worker → expireSnoozes` démontrée.

**Prochain =** **JOB-002** (renouvellement de bail, détection de worker mort, remise en queue selon la
politique de retry, timeout provider vs crash local). Ensuite : l'**agent réel** qui lit ces findings
et produit des `action_proposals` gouvernées par les policies DATA-007, et l'**inbox UI** (E11 — les
findings vivent leur cycle, rien ne les affiche encore).

**À savoir :** FIND-003 débloque **FIND-010**, **DASH-004**, **REP-001**, **AGT-005C**. Le plafond
`maxCandidates=50` mord toujours à l'**écriture** (barberconcept : 1310 signaux, 50 écrits) — le
relever est une décision séparée. barberconcept n'a **encore aucun finding** (jamais détecté en réel).
Activation destructive de la purge (DATA-008 `--execute`) = tâche séparée. **CONTRACT différé**
(l'app lit encore `gsc_query_page_data` + `gmb_insights_daily`). `ai_jobs → jobs` reste **écarté**
(voir feature file § Décisions).

Commits : `256c1a2` IDX-008 · `d7484a9` DATA-001 · `b6df05e` DATA-002 · `1ab115f` DATA-003 · `7d3ae9c` DATA-004 · `4696919` migrate/backfill · `7cb94c1` fix chunk · `f9432ce` DATA-005 · `4c24bc9` docs DATA-005 · `16fa000` DATA-006 · `43fe9d7` docs DATA-006 · `15a92cb` DATA-007 · `a8bdd2f` docs DATA-007 · `0f78d89` DATA-008 · `c6ccc70` docs DATA-008 · `f9b7801` wrap DATA-007/008 · `9e25e5d` fix timestamps + injection db · `717bb71` FIND-001/FIND-004 détecteur · `7321f5a` JOB-001 claim atomique · `cc6a92f` docs FIND/JOB · **`5428ec7`** FIND-003 cycle de vie.
