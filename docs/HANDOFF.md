# HANDOFF — 2026-07-27

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | EN ATTENTE (Jonathan, infra) |

## Reprendre ici
**REP-004 lot 1 livré** — un rapport publié cesse d'être un cul-de-sac. La **révision**
(`reviseWeeklyReport`) ajoute une ligne, n'en modifie jamais aucune : l'unique passe de
`(period_slot)` à `(period_slot, revision)`, et « un seul rapport par semaine » se déplace dans
le code — **le tick n'écrit jamais que `revision = 1`**. Et la **comparaison** de deux rapports
(`compareReports`) refuse de chiffrer ce qui n'est pas comparable : une section qui devient
disponible n'a **aucun champ chiffré** (ce serait `+13` pour un simple branchement), une section
qui devient absente non plus (ce serait `−13`, donc « treize problèmes résolus » pour une
collecte morte).
Suivant : **REP-004 lot 2** (rétention du détail + `/seo-archive` — la 3ᵉ acceptation, laissée
de côté parce qu'écrire une politique de purge pour une table à **0 ligne** serait spéculatif),
sinon le **portage de `/positions` sur le canon** (ex-onglet « Mots-clés »).

⚠️ **`ReportMetric` porte une `key` et le schéma de rapport est passé à 2.** La comparaison
n'apparie **jamais** sur le libellé : celui de la métrique L4 contient « parmi les 12 listées »,
un nombre qui bouge chaque semaine. Une clé identifie, un libellé raconte — et un libellé
réécrit devient un renommage traçable, pas une rupture de série.
⚠️ **Le SLO d'un créneau se dérive de sa PREMIÈRE publication** (`firstPublishedAt`), jamais de
la ligne lue : sinon une révision écrite le mercredi afficherait 30 h de retard et dégraderait
après coup la ponctualité du cron. La phrase le nomme (« publication d'origine ») uniquement sur
un créneau révisé.
⚠️ **Trois refus de chiffrer, à ne pas « corriger »** : sections d'ACTIVITÉ (un finding qui
sort n'est pas résolu, il a cessé d'être nouveau), listes PLAFONNÉES (un item hors des 15 se
lirait « entré »), schéma ou fenêtre différents (doctrine GSC-004).
⚠️ **`revision` ≠ `revisionCount`, `publishedAt` ≠ `firstPublishedAt`** — deux paires qu'un
raccourci d'écran rendrait fausses.
⚠️ **« Mots-clés » (SPEC §13.2) n'est PAS un onglet à créer** : `/projects/[slug]/positions`
répond déjà à la même question, mais sur les tables **legacy** (`gsc-analytics.ts`). En créer un
second ferait deux écrans, deux sources, une divergence garantie. Le geste est un **portage**.
⚠️ **Le premier rapport que Jonathan verra sera un constat d'absence** : sur un parc sans run
hebdo, le chemin nominal est `deadline_reached` → **`partial`, 9 projets `missing`**. Il est
désormais **révisable** (`--revise <slot> --reason "…"`), et sa version d'origine reste lisible.
⚠️ **`/report/[slug]/[period]` n'a rien à voir avec `/reports`** : le premier est le rapport
client legacy (par projet, hors `(app)`), le second le rapport interne cross-projet.
⚠️ **La liste ne doit jamais charger `payload_json`** (28 kio par rapport) — et `limit` compte
des **créneaux**, pas des lignes, sinon un créneau révisé deux fois occuperait trois lignes.
⚠️ **Le SLO de 10:00 : 81 jobs hebdo** (9 projets × 9 entrées) pour `MAX_JOBS_PER_TICK = 25` —
**déjà cassé à 72**. Leviers : le plafond par tick (les 4 détecteurs sont `provider: 'none'`) ou
`report.publish_deadline_minutes` (`system_settings`, sans redéploiement).
⚠️ **Ne PAS piper un script de preuve dans `head`** : le SIGPIPE tue le process avant le
nettoyage et laisse des lignes de test en base (`1997-%`, `1998-%`). Utiliser `tail`.
⚠️ **Une découverte `new_query` non traitée s'auto-résout** au bout de 4 semaines ; personne n'est
prévenu. **`LOST = 0` sur les 9 projets** — ne pas baisser le seuil sans relire la mesure FIND-006.
⚠️ **`barberconcept` a UN problème d'architecture éditoriale, pas 25 problèmes ponctuels**
(FIND-008 : 180 conflits retenus, 25 écrits).
⚠️ **L'annonce de disponibilité est produite, pas envoyée** (TEL-001 BLOCKED ; envoi = TEL-002).
⚠️ **Le cockpit n'est PAS en prod** : `main` = socle epics 1-23 sur Neon, ni `/jobs`, ni `/inbox`,
ni `/reports`, ni cron `tick`. `npm run db:push` depuis `main` = risque de PROD (29 tables
déclarées, 61 en base).
⚠️ **Aucun écran n'a jamais été vu à l'œil** (pas de session admin).
⚠️ **La prod écrit dans la même base** → toute assertion « base rendue à l'identique » sur
`gsc_query_page_observations` est racée.

Commit : `1d4a6b4` (E00) · précédent `8cd0113` · prod : `e5efc83` sur `main`
