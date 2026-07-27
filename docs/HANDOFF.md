# HANDOFF — 2026-07-27

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Mise en prod du cockpit (`feat/cockpit` → `main`) | plan : `~/.claude/plans/ok-go-pour-que-reflective-pinwheel.md` | **EN COURS — étape 2/5** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | EN ATTENTE (Jonathan, infra) |

## Reprendre ici
**Mise en prod du cockpit, étape 2 sur 5 : la revue visuelle.** Étapes 1 et 3 faites — les
**9 cadences hebdo sont en pause en base** (via le nouveau `scripts/pauses.ts`) et le cron
`gmb-reviews` est dans `vercel.json`. Vérifications d'avant-merge vertes : **1419 tests**,
**0 erreur / 42 warnings**.
Suivant : `npm run dev`, login `contact@jonlabs.ch` (mot de passe saisi par Jonathan), parcourir
`/`, `/inbox`, `/jobs`, `/reports`, `/automations`, un projet et ses 8 onglets — **navigation
seule**. Puis étape 4 (`git push origin feat/cockpit` → preview Vercel, merge `--ff-only`) et
étape 5 (observer le premier tick, reprendre `lecureux` en canary).
Après la prod : **portage de `/positions` sur le canon** (débloque FIND-007) ou **AGT-001**.

⚠️ **Le `.env` local pointe la base de PROD.** La revue visuelle est en lecture : approuver,
rejeter, relancer un job, poser une pause depuis l'UI ou répondre à un avis écrirait dans la
vraie base.
⚠️ **La cadence `daily` reste ACTIVE, et c'est un choix** (veilles qui expirent, échéances
d'inspection honorées). La suspendre est un geste explicite : `--cadence daily --pause-all`.
⚠️ **Le tick publiera le rapport même avec les 9 projets en pause** — une pause de cadence
empêche `planDueJobs` d'ouvrir le run, pas le drain ni REP-003. Premier rapport = constat
d'absence, **révisable** (`rep-003-publish.ts --revise <slot> --reason "…"`).
⚠️ **`MAX_JOBS_PER_TICK = 25` est une constante de la route**, pas un réglage `system_settings` :
la changer demande un redéploiement (contrairement aux limites JOB-006).
⚠️ **Double navigation à trancher** : la sidebar garde 12 entrées projet, la barre d'onglets en
pose 8, avec des libellés divergents (« Avis » / « Avis Google », « Présence locale » / « Fiche
Google ») et sans Indexation côté sidebar.
⚠️ **La page de login annonce encore « Content Hub / Jon Labs »**, pas seo-stats.
⚠️ **E08 (avis GMB) = 8 tickets, 0 livré.** Le cron rétablit la *synchro* ; il n'existe toujours
aucun job `collect:gmb_reviews` ni finding « avis sans réponse ». 3 avis en attente aujourd'hui.
⚠️ **Approuver n'exécute rien** (`proposal_approvals` = 0) et **rien n'est notifié** (TEL-001/002
BLOCKED) : le rapport est publié, son annonce journalisée, jamais envoyée.
⚠️ **Le DDL est déjà en base** (61 tables) : le merge ne touche pas au schéma — il **supprime**
le risque `npm run db:push` (`main` déclare 29 tables pour 61 en base).
⚠️ **Ne PAS lancer Prettier** (non configuré : reformate ~10 000 lignes au lieu du style maison).
⚠️ **Ne PAS piper un script de preuve dans `head`** (SIGPIPE laisse des lignes de test en base).
⚠️ **Bash ne connaît pas les here-strings PowerShell** (`@'…'@`) : heredoc pour un message de
commit multi-ligne.
⚠️ **Quatre refus de chiffrer dans la comparaison de rapports**, à ne pas « corriger » : sections
d'ACTIVITÉ, listes PLAFONNÉES, schéma ou fenêtre différents (GSC-004), détail purgé.
⚠️ **Le SLO d'un créneau se dérive de sa PREMIÈRE publication** (`firstPublishedAt`) : réviser ne
réécrit pas la ponctualité du cron.
⚠️ **La séquence d'archivage a QUATRE étapes et l'ordre EST la garantie** : `--export` →
`/seo-archive --projet _global` → `--confirm` → `--purge`. Le bloc ```json d'une note du vault ne
doit jamais être reformaté (un prettify casse l'empreinte, donc la purge).
⚠️ **La rétention du détail est DÉSACTIVÉE par défaut** (`report.detail_retention_weeks` = `null`,
plancher 4 semaines) ; `system_settings` est **vide**, donc tout est aux défauts du code.
⚠️ **`/report/[slug]/[period]` n'a rien à voir avec `/reports`** : rapport client legacy vs
rapport interne cross-projet.
⚠️ **Hors repo (couche skills)** : `~/.claude/skills/seo-archive/` a changé au lot REP-004 lot 2
(wrapper `weekly-report`, défaut de vault corrigé) — non commité ici.

Commit : `803256d` (garde-fou de mise en prod) · précédent `2f95143` (recap REP-004 · CLÔTURÉ) ·
prod : `e5efc83` sur `main`
