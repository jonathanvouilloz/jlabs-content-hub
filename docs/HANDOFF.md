# HANDOFF — 2026-07-28

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| **Avis GMB (E08) — GMB-002 synchro** | [features/gmb-002-reviews.md](features/gmb-002-reviews.md) | **LOT 1 LIVRÉ · lot 2 (findings) À FAIRE** |
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Mise en prod du cockpit (`feat/cockpit` → `main`) | plan : `~/.claude/plans/ok-go-pour-que-reflective-pinwheel.md` | **EN COURS — étape 5/5** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | EN ATTENTE (Jonathan, infra) |

## Reprendre ici

🆕 **2026-07-28 — E08 lot 1 (GMB-002) est LIVRÉ.** La synchro des avis est entrée dans la file
(`collect:gmb_reviews`, catalogue **quotidien**, provider `gmb`), elle réconcilie l'état
distant et chaque fiche porte sa santé. Chiffres après la première collecte réelle :
**382 → 3 189 avis**, **502 en attente (vrai)** contre 11 (faux), **9 fiches** avec un
`last_sync_status`. Le fantôme `physiopommier` du 15/03 est tranché : **réellement oublié**
(brouillon de mars jamais envoyé). Le **2★ de Sion du 18/07** est confirmé sans réponse.
Détail, pièges et mesures → `docs/features/gmb-002-reviews.md`.

✅ **Le chiffre de 502 a été VÉRIFIÉ contre l'API Google**, pas contre notre base : sur trois
fiches rappelées à l'état brut, Google et la base donnent le même nombre de réponses au
chiffre près (301/301, 320/320, 351/351). Aucun bug de réconciliation, aucun champ de réponse
manqué. **L'arriéré est réel et à deux vitesses** : Lausanne 1 non répondu sur 302, mais
**Eaux Vives 190/541 et Jonction 179/499** — et le trou est RÉCENT (Eaux Vives : 98 avis non
répondus sur la seule année 2025). Deux fiches sur six portent 74 % de l'arriéré.

**Prochaine étape E08 : le lot 2** — `detect:review_pending` produisant `review_pending_sla`
et `negative_review`. Sans lui, le 2★ de Sion reste un fait interrogeable mais n'entre ni dans
`/inbox` ni au rapport hebdo. Les deux types sont **déjà** dans `FINDING_TYPES`, `'review'`
dans `FINDING_ENTITY_TYPES` : aucun DDL de vocabulaire.
⚠️ Dimensionner sur **502**, pas 11 : `slaLookbackDays: 180` cadre les findings sur ~40 avis
récents actionnables et laisse les 332 d'avant 2025 en stock visible.
⚠️ **Le signal doit être lisible PAR FICHE.** Un finding agrégé au projet dirait
« barberconcept a 499 avis en retard » et noierait le fait utile — deux établissements
concentrent l'arriéré pendant qu'un troisième tient 301/302.

**Aussi en attente (décidé avec Jonathan, session suivante)** : sortir la liste exportable des
non-répondus 2025-2026 par fiche pour que Barber Concept rattrape · arbitrer une fenêtre
d'affichage sur `/projects/[slug]/reviews` et `/api/reviews/pending` (499 entrées aujourd'hui).
⚠️ **Une preuve ne doit JAMAIS poser sa sentinelle sous un projet qui a de vraies fiches** :
le collecteur parcourt tous les établissements de son projet. Appris en polluant six fiches
`barberconcept` (restaurées). La preuve le vérifie désormais elle-même.
⚠️ **L'auth provider ne doit pas passer par `$env`** : un handler qui importe `gmb.ts` marche
sur Vercel et meurt en dead-letter dès qu'un worker local le réclame. Utiliser `gmb-auth.ts`.

---

✅ **LE COCKPIT EST EN PRODUCTION** depuis le 2026-07-27 ~19:40 UTC. `main` = `7a8e04b`
(fast-forward de `feat/cockpit`, **113 commits**), `/api/whoami` répond
`{"env":"production","version":"7a8e04b","project_count":9}`. Étapes 1 à 4 faites : les
**9 cadences hebdo sont en pause en base** (`scripts/pauses.ts`, raison « reprise projet par
projet »), `vercel.json` déclare les **5 crons** (`tick` horaire, `gmb-publish`,
`linkedin-publish`, `gmb-weekly-digest`, **`gmb-reviews` 5h** — le trou des avis Google est
bouché), le preview Vercel a été vérifié vert avant le merge, revue visuelle RAS.

**Étape 5 — observer le premier tick.** Avec les 9 cadences en pause il doit : ne planifier
**aucun** run hebdo, drainer le job `queued` résiduel, et **publier le rapport de la semaine**.
À contrôler après le passage de l'heure : aucun job `running` orphelin, aucun `monitoring_runs`
ouvert sur un projet en pause, **1 ligne dans `weekly_reports`**. Puis canary : reprendre
`lecureux` (`npx tsx scripts/pauses.ts --resume lecureux --reason "…" --execute`), observer le
tick suivant, et reprendre les autres un par un — **`barberconcept` en dernier**.
Au lendemain : `max(created_at)` de `gmb_reviews` doit avoir bougé pour `physiopommier` et
`bisrepetita` (dernières synchros 2026-04-06 et 2026-05-21).

Après la prod : **portage de `/positions` sur le canon** (débloque FIND-007) ou **AGT-001**.

⚠️ **Le `.env` local pointe la base de PROD.** Tout script sans `--dry-run` écrit dans la vraie base.
⚠️ **La cadence `daily` reste ACTIVE, et c'est un choix** (veilles qui expirent, échéances
d'inspection honorées). La suspendre est un geste explicite : `--cadence daily --pause-all`.
⚠️ **Le tick publiera le rapport même avec les 9 projets en pause** — une pause de cadence
empêche `planDueJobs` d'ouvrir le run, pas le drain ni REP-003. Premier rapport = constat
d'absence (`partial`, 9 projets `missing`), jamais réécrit, mais **révisable**
(`rep-003-publish.ts --revise <slot> --reason "…"`).
⚠️ **Au premier tick d'un projet repris** : le catalogue hebdo porte 4 détecteurs, plafond 50
**par détecteur** — `barberconcept`, jamais diagnostiqué, peut écrire jusqu'à 150 findings.
⚠️ **`MAX_JOBS_PER_TICK = 25` est une constante de la route**, pas un réglage `system_settings` :
la changer demande un redéploiement (contrairement aux limites JOB-006). 63 jobs hebdo si les 9
projets repartent ensemble — d'où la reprise un par un.
⚠️ **Deux défauts connus partis en prod tels quels** (revue visuelle RAS, décision assumée) :
la **double navigation** (sidebar 12 entrées vs barre d'onglets 8, libellés divergents « Avis » /
« Avis Google », « Présence locale » / « Fiche Google », pas d'Indexation côté sidebar) et la
**page de login qui annonce encore « Content Hub / Jon Labs »**.
⚠️ **E08 (avis GMB) = 8 tickets, 1 livré (GMB-002).** `collect:gmb_reviews` existe et tourne ;
il n'existe **toujours aucun finding « avis sans réponse »** — c'est le lot 2.
⚠️ **Approuver n'exécute rien** (`proposal_approvals` = 0) et **rien n'est notifié** (TEL-001/002
BLOCKED) : le rapport est publié, son annonce journalisée, jamais envoyée.
⚠️ **`npm run db:push` n'est plus le piège qu'il était** : `main` déclare enfin les 61 tables de
la base. Le merge a supprimé l'écart 29/61.
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

Commit : `7a8e04b` (= `main` = prod) · précédent `803256d` (garde-fou de mise en prod)
