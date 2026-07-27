# HANDOFF — 2026-07-27

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | EN ATTENTE (Jonathan, infra) |

## Reprendre ici
**REP-004 lot 2 livré — REP-004 est CLOS** (3 acceptations sur 3). Un rapport peut désormais
perdre son **détail** sans perdre sa **ligne** : `payload_json` devient nullable, cinq colonnes
disent ce qu'il pesait et où il est parti, et le CHECK `weekly_reports_payload_presence_check`
interdit le seul état dangereux — un détail disparu **sans adresse ni empreinte**. La purge
n'autorise que ce qui a été **retrouvé dans le vault et vérifié au SHA-256** : un rapport ne se
régénère pas, donc `not_archived` retient une ligne quel que soit son âge.
Suivant : le **portage de `/positions` sur le canon** (ex-onglet « Mots-clés »), sinon **AGT-001**
(API agent v1) — approuver n'exécute toujours rien.

⚠️ **Rendre une colonne nullable CRÉE un état, et c'est le CHECK qui le rend sûr.** « Ligne sans
détail » se lit naïvement « rapport vide » : douze sections non branchées pour un rapport qui en
portait dix. Trois `UPDATE` nus — ceux qu'on taperait dans psql — sont refusés en base.
⚠️ **La séquence d'archivage a QUATRE étapes et l'ordre EST la garantie** :
`--export` → `/seo-archive --projet _global` → `--confirm` → `--purge`. Sauter la confirmation
ne gagne rien : la purge refuse tout ce qui n'est pas archivé.
⚠️ **Le bloc ```json d'une note du vault ne doit JAMAIS être reformaté** — un prettify casse
l'empreinte, donc la vérification, donc la purge (dans le bon sens : le hub refuse).
⚠️ **`retention` ≠ `detail`** sur `PublishedReport` : le premier dit **où vit** le détail (lisible
sans charger le payload), le second **est** le détail. Les confondre ferait payer 28 kio par ligne
de liste.
⚠️ **L'âge de rétention se compte sur `slot_at`**, jamais sur `published_at` : c'est la semaine
couverte qui vieillit. Sinon réviser un vieux créneau lui rendrait N semaines.
⚠️ **La rétention est DÉSACTIVÉE par défaut** (`report.detail_retention_weeks` = `null`), et toute
valeur illisible y retombe. `0` n'existe pas : une fenêtre à 0 se lirait « purger tout de suite ».
⚠️ **`ReportMetric` porte une `key` et le schéma de rapport est passé à 2.** La comparaison
n'apparie **jamais** sur le libellé : celui de la métrique L4 contient « parmi les 12 listées ».
⚠️ **Le SLO d'un créneau se dérive de sa PREMIÈRE publication** (`firstPublishedAt`) : réviser ne
réécrit pas la ponctualité du cron. `revision` ≠ `revisionCount`, `publishedAt` ≠ `firstPublishedAt`.
⚠️ **Quatre refus de chiffrer, à ne pas « corriger »** : sections d'ACTIVITÉ, listes PLAFONNÉES,
schéma ou fenêtre différents (GSC-004), et depuis le lot 2 **un détail purgé** (`detail_purged`) —
le comparer comme un rapport vide annoncerait un changement de template.
⚠️ **« Mots-clés » (SPEC §13.2) n'est PAS un onglet à créer** : `/projects/[slug]/positions`
répond déjà à la même question, mais sur les tables **legacy** (`gsc-analytics.ts`). Le geste est
un **portage**.
⚠️ **Le premier rapport que Jonathan verra sera un constat d'absence** (`partial`, 9 projets
`missing`). Il est **révisable** (`--revise <slot> --reason "…"`).
⚠️ **`/report/[slug]/[period]` n'a rien à voir avec `/reports`** : rapport client legacy vs
rapport interne cross-projet.
⚠️ **Le SLO de 10:00 : 81 jobs hebdo** (9 projets × 9 entrées) pour `MAX_JOBS_PER_TICK = 25` —
**déjà cassé à 72**. Leviers : le plafond par tick ou `report.publish_deadline_minutes`.
⚠️ **Ne PAS piper un script de preuve dans `head`** : le SIGPIPE tue le process avant le
nettoyage et laisse des lignes de test en base (`1997-%`, `1998-%`). Utiliser `tail`.
⚠️ **Prettier n'est PAS configuré dans ce repo** (aucun `.prettierrc`, aucune dépendance) : le
lancer reformate tout aux réglages par défaut (2 espaces, double quotes) au lieu du style maison
(tabulations, quotes simples). Ne pas le lancer.
⚠️ **Une découverte `new_query` non traitée s'auto-résout** au bout de 4 semaines. **`LOST = 0`
sur les 9 projets** — ne pas baisser le seuil sans relire la mesure FIND-006.
⚠️ **`barberconcept` a UN problème d'architecture éditoriale, pas 25 problèmes ponctuels**
(FIND-008 : 180 conflits retenus, 25 écrits).
⚠️ **L'annonce de disponibilité est produite, pas envoyée** (TEL-001 BLOCKED ; envoi = TEL-002).
⚠️ **Le cockpit n'est PAS en prod** : `main` = socle epics 1-23 sur Neon, ni `/jobs`, ni `/inbox`,
ni `/reports`, ni cron `tick`. `npm run db:push` depuis `main` = risque de PROD (29 tables
déclarées, 61 en base).
⚠️ **Aucun écran n'a jamais été vu à l'œil** (pas de session admin).
⚠️ **Hors repo (couche skills)** : `~/.claude/skills/seo-archive/` a changé avec ce lot (wrapper
`weekly-report`, défaut de vault corrigé) — non commité ici.

Commit : (REP-004 lot 2, à faire) · précédent `1d4a6b4` (E00) · prod : `e5efc83` sur `main`
