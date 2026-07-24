# HANDOFF — 2026-07-25

## Features actives
| Feature | Fichier | Statut |
|---|---|---|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |

## Reprendre ici
E00 sur `feat/cockpit`. **DASH-002 livré** : `/` est l'accueil cross-projet. Santé à **deux axes qui ne
fusionnent jamais** (`pipeline` = la donnée arrive-t-elle · `signal` = que dit-elle), un pipeline cassé
rendant le signal **`unknown` et jamais `ok`** ; compteurs dont le **nombre et le lien naissent du même
`CounterFilter`** (un compteur sans liste reproductible n'a pas de lien) ; filtre d'activité
`?event=`/`?since=` sur l'inbox (EXISTS sur `finding_events`) ; fraîcheur où « jamais collecté » ≠ 0 h ;
coûts **« non instrumentés »** et non à zéro ; quotas via `loadCapacitySnapshot`. **Zéro DDL** (57 tables
`seostats`, `schema.ts` intact).

Prochain : **IDX-001/002** (sitemap, URL Inspection) · **DASH-003** (cockpit projet, débloqué côté
fenêtres — consommera `/gsc/windows` et reprendra le panneau `/windows`). **DASH-001** reste BLOCKED
(GOV-002).

⚠️ **Pièges vivants** : `= ANY` interdit avec Neon (bornes `>=` / `inArray`) · le read-model lit le
CANON, jamais le legacy · un compteur d'activité doit compter des **problèmes** (`DISTINCT finding_id`),
pas des lignes de journal · le `batch` du backfill est un débit, pas un curseur · **l'accueil et
`/windows` n'ont jamais été vus à l'œil** (pas de session admin) · `npm run build` échoue à
l'adaptateur Vercel sur Windows (`EPERM symlink`, **préexistant**) · `gsc-002` non rejoué (quota).

Commit : `6377326` [hub] add: DASH-002 accueil cross-projet, deux axes de santé, compteurs liés à leur liste
