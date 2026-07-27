# HANDOFF — 2026-07-27

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | EN ATTENTE (Jonathan, infra) |

## Reprendre ici
**DASH-003 lot 2 chantier 3 livré** — `weekly_reports` a enfin un lecteur : **`/reports`** (liste
des créneaux publiés) et **`/reports/[slot]`** (le rapport entier). Le point du lot n'est pas
l'écran mais le **gardien de l'invariant** : « absent ≠ zéro » était structurel côté données
(REP-001) et **défaisable en un caractère** dans un template — `sectionView` rend une union
discriminée, donc une section absente n'a **aucun champ** où loger un `0`. Prouvé sur un rapport
réel : `indexation` et `traffic_conversions` sortent `not_wired` sans compteur, pendant que
**4 sections présentes et vides** portent bien les leurs.
Suivant : **REP-004** (historique et comparaison — la seule chose qui rendrait un `partial`
révisable, et l'écran le dit désormais à chaque ligne). Sinon le portage de **`/positions`** sur
le canon (cf. piège « Mots-clés »).

⚠️ **« Mots-clés » (SPEC §13.2) n'est PAS un onglet à créer** : `/projects/[slug]/positions`
répond déjà à la même question, mais sur les tables **legacy** (`gsc-analytics.ts`). En créer un
second ferait deux écrans, deux sources, une divergence garantie. Le geste est un **portage**.
⚠️ **Le premier rapport que Jonathan verra sera un constat d'absence** : sur un parc sans run
hebdo, le chemin nominal est `deadline_reached` → **`partial`, 9 projets `missing`** — et il ne
sera **jamais réécrit** (republier est un no-op, graine de REP-004).
⚠️ **`/report/[slug]/[period]` n'a rien à voir avec `/reports`** : le premier est le rapport
client legacy (par projet, hors `(app)`), le second le rapport interne cross-projet.
⚠️ **La liste ne doit jamais charger `payload_json`** (28 kio par rapport) — le défaire ne
casserait aucun test, seulement l'écran.
⚠️ **Le SLO de 10:00 : 81 jobs hebdo** (9 projets × 9 entrées) pour `MAX_JOBS_PER_TICK = 25` —
**déjà cassé à 72**. Leviers : le plafond par tick (les 4 détecteurs sont `provider: 'none'`) ou
`report.publish_deadline_minutes` (`system_settings`, sans redéploiement).
⚠️ **Ne PAS piper un script de preuve dans `head`** : le SIGPIPE tue le process avant le
nettoyage et laisse des lignes de test en base. Utiliser `tail`.
⚠️ **Une découverte `new_query` non traitée s'auto-résout** au bout de 4 semaines ; personne n'est
prévenu. **`LOST = 0` sur les 9 projets** — ne pas baisser le seuil sans relire la mesure FIND-006.
⚠️ **`barberconcept` a UN problème d'architecture éditoriale, pas 25 problèmes ponctuels**
(FIND-008 : 180 conflits retenus, 25 écrits).
⚠️ **L'annonce de disponibilité est produite, pas envoyée** (TEL-001 BLOCKED ; envoi = TEL-002).
⚠️ **Le cockpit n'est PAS en prod** : `main` = socle epics 1-23 sur Neon, ni `/jobs`, ni `/inbox`,
ni `/reports`, ni cron `tick`. `npm run db:push` depuis `main` = risque de PROD (29 tables
déclarées, 61 en base).
⚠️ **Aucun écran n'a jamais été vu à l'œil** (pas de session admin) — et `/reports` est le premier
dont toute la valeur est dans le rendu.
⚠️ **La prod écrit dans la même base** → toute assertion « base rendue à l'identique » sur
`gsc_query_page_observations` est racée.

Commit : *(en cours)* · précédent `351803d` (E00) · prod : `e5efc83` sur `main`
