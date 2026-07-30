# HANDOFF — 2026-07-30

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Mise en prod du cockpit (`feat/cockpit` → `main`) | plan : `~/.claude/plans/ok-go-pour-que-reflective-pinwheel.md` | **EN COURS — étape 5/5** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | EN ATTENTE (Jonathan, infra) |

> Clôturé le 2026-07-28 : **Avis GMB (E08/GMB-002)**, lots 1 et 2 — recap dans
> [features/gmb-002-reviews.md](features/gmb-002-reviews.md). **E08 reste à 1 ticket sur 8.**

## Reprendre ici

🆕 **2026-07-30 — la dérive de publication est arrêtée à la source, et `main` est en prod.**
`origin/main` = **`d222c39`** (8 commits poussés), `/api/whoami` répond
`{"env":"production","version":"d222c39","project_count":9}`. Le déploiement retire
**`/api/cron/gmb-reviews`** de `vercel.json` (**4 crons** désormais : `tick`, `gmb-publish`,
`linkedin-publish`, `gmb-weekly-digest`) — l'ancien collecteur qui réinsérait des lignes en
ancien format ne tourne plus, et le ciblage GMB par établissement (`ffba18e`) est actif.

✅ **`gmb_reviews` est dédupliquée et normalisée** (`scripts/dedupe-gmb-reviews.ts`, dry-run par
défaut). 28 lignes en ancien format sur `barberconcept` : **9 supprimées** (jumelles dominées sur
les 13 colonnes de contenu), **19 normalisées** (§4 de `manual-gmb-002.sql`, mot pour mot, même
transaction). Reste **3 208 avis, 0 en ancien format** ; second run : 0 à faire. Le compte d'avis
en attente passe de 527 à **518** — 527 comptait 9 doublons deux fois. `physiopommier` : 3.
⚠️ **La règle de suppression est la DOMINATION, pas l'ancienneté** : une ligne en ancien format
n'est supprimée que si sa jumelle porte la même valeur ou davantage sur chaque colonne de contenu.
Une ligne qui porte quoi que ce soit d'unique (`draft_reply` rédigé, `mentioned_employees`,
réponse distante lue) est **retenue** et le script **refuse d'écrire** tant qu'il en reste une.
⚠️ **`last_seen_at` est hors comparaison** : elle dit quand la ligne a été vue, pas ce qu'elle
porte, et vaut NULL sur toutes les lignes de l'ancien collecteur par construction.
⚠️ **Vérifié avant suppression : 0 finding ne pointait une ligne en ancien format** — les 17
findings d'avis portent déjà la clé normalisée (`findings.entity_key`, pas `entity_id`).
✅ **Les « 88 divergents » n'existent pas : il y en a ZÉRO.** Vérifié contre l'API Google, fiche
par fiche — **88 sur 88 sont absents de Google aujourd'hui** (Lausanne 36 · Rive 25 · Eaux Vives
23 · Jonction 3 · Cornavin 1, et 0 encore présent). Ce ne sont pas des désaccords hub↔Google :
ce sont des avis **répondus puis disparus** de Google. Leur `replied_at` est en ISO avec
millisecondes — la signature de `reviews/backfill`, qui y écrivait le `replyTime` **de Google** ;
ces avis avaient donc bien une réponse **chez Google** avant de disparaître.
⚠️ **Le chiffre de 88 venait du prédicat NU** (`replied_at NOT NULL AND remote_reply_at IS NULL`)
appliqué à des lignes dont `last_seen_at IS NULL` : « je n'ai pas regardé » se lisait « Google dit
non ». Même classe d'erreur qu'« absent ≠ zéro », sur une colonne au lieu d'une section.
✅ **Le détecteur ne s'y est jamais laissé prendre** : `review-pending-state.ts` fait
`!row.lastSeenAt ⇒ neverSeen, continue` **avant** le compteur `divergent`. Rien à corriger dans
le code de production.
🆕 **`scripts/reviews-divergence.ts`** (lecture seule, sans `--execute`) rend cette partition
interrogeable pour qu'un audit ne retape plus le prédicat nu : `RÉELLE` / `DISPARUE` / `NON LUE` /
`HORS`, plus `--probe` qui tranche les indécidables en interrogeant Google sans rien écrire.
⚠️ **Aujourd'hui les 6 fiches sont `HORS`** (dernière synchro le 2026-07-28 08:30, seuil de
fraîcheur 48 h) : `collect:gmb_reviews` n'a pas encore tourné en tant que job. C'est le premier
tick quotidien qui les rafraîchira.
⚠️ **14 avis existent chez Google et pas en base** (Eaux Vives 8 · Rive 3 · Lausanne 2 · Sion 1) —
arrivés depuis le 2026-07-29 21:45. Attendu : la collecte n'a pas tourné depuis.

**Prochaine étape inchangée : observer le premier tick en prod** (étape 5/5), puis reprendre
`lecureux` en canary. À surveiller en plus au lendemain : `collect:gmb_reviews` passe désormais
**uniquement** par la file (catalogue quotidien, 07:00 `Europe/Zurich`) — `max(created_at)` de
`gmb_reviews` doit bouger pour `physiopommier` et `bisrepetita`, et **aucune** nouvelle ligne ne
doit réapparaître avec un `review_id` contenant un `/`.

---

🆕 **2026-07-28 — E08 lot 2 (GMB-002) est LIVRÉ, et GMB-002 est CLOS.** `detect:review_pending`
produit `review_pending_sla` et `negative_review` : un avis sans réponse cesse d'être un fait
interrogeable et devient un **finding décidable**. **Zéro DDL** (types et `entity_type` déjà au
vocabulaire). Au catalogue **quotidien**, arête **obligatoire** depuis `collect:gmb_reviews`,
provider `none`. Détail, pièges et mesures → `docs/features/gmb-002-reviews.md`.

✅ **Premier run réel sur `barberconcept` : 17 findings** (13 SLA + 4 négatifs, dont **3
notifiables** §14.3), tous `open`. Répartition : Eaux Vives 6 · Jonction 5 · Cornavin 4 · Sion 2
· **Lausanne 0**. **Lausanne à 0 est la contre-épreuve** — la fiche qui répond (301/302) ne
produit rien, celles qui ont décroché produisent tout. Le **2★ de Sion du 18/07** est `critical`,
notifiable, en tête de liste. `physiopommier` : **1 SLA** (l'avis du 15/03, « réellement
oublié »). `jonlabs` et `bisrepetita` : **0**, tous leurs avis sont répondus. Second run à
l'identique : **0 créé, 17 rafraîchis**, 17 événements `created` seulement.

**Prochaine étape : la mise en prod (étape 5/5) et la reprise des cadences hebdo** — observer un
tick, puis reprendre `lecureux` en canary. Ensuite au choix : le **portage de `/positions` sur le
canon** (débloque FIND-007) ou **AGT-001** (approuver n'exécute toujours rien).

**Reste ouvert sur E08 (décidé avec Jonathan, session suivante)** : sortir la liste exportable des
non-répondus 2025-2026 par fiche pour que Barber Concept rattrape · arbitrer une fenêtre
d'affichage sur `/projects/[slug]/reviews` et `/api/reviews/pending` (499 entrées).
⚠️ **Ne PAS confondre cette fenêtre d'affichage avec `slaLookbackDays`** : borner l'écran cache un
fait vérifié contre l'API Google, borner le détecteur choisit ce qu'on **alerte**.
⚠️ **La borne de lecture est le MAX des deux fenêtres (365 j), donc `outOfWindow` vaut
structurellement 0** : ~1 700 avis de `barberconcept` ne sont pas « lus puis écartés », ils ne
sont **pas lus**. Le CLI dit depuis quelle date il lit.
⚠️ **Une preuve doit tourner sur un projet vierge sur TROIS points** (aucune fiche réelle, aucun
finding d'avis, aucun finding en veille) : `reconcileDetectionRun` et `expireSnoozes` travaillent
à l'échelle du **projet**. La preuve le vérifie elle-même et refuse de démarrer sinon.
⚠️ **`DETECTOR_JOB_TYPES` est dérivé du catalogue** : les 9 projets passent de `full` à `partial`
sur l'accueil tant que le nouveau job n'a pas tourné. Attendu, pas une régression.
⚠️ **L'auth provider ne doit pas passer par `$env`** : un handler qui importe `gmb.ts` marche
sur Vercel et meurt en dead-letter dès qu'un worker local le réclame. Utiliser `gmb-auth.ts`.

---

✅ **LE COCKPIT EST EN PRODUCTION** depuis le 2026-07-27 ~19:40 UTC. `main` = `7a8e04b`
(fast-forward de `feat/cockpit`, **113 commits**), `/api/whoami` répond
`{"env":"production","version":"7a8e04b","project_count":9}`. Étapes 1 à 4 faites : les
**9 cadences hebdo sont en pause en base** (`scripts/pauses.ts`, raison « reprise projet par
projet »), `vercel.json` déclare **4 crons** (`tick` horaire, `gmb-publish`,
`linkedin-publish`, `gmb-weekly-digest` — **`gmb-reviews` en a été RETIRÉ par GMB-002**, les
avis passent désormais par la file), le preview Vercel a été vérifié vert avant le merge, revue
visuelle RAS.

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
**par détecteur** — `barberconcept`, jamais diagnostiqué, peut écrire jusqu'à 150 findings. S'y
ajoute le quotidien, mais il ne surprendra plus : `detect:review_pending` a déjà écrit ses 17
findings à la main sur `barberconcept` et n'a plus qu'à les rafraîchir.
⚠️ **`MAX_JOBS_PER_TICK = 25` est une constante de la route**, pas un réglage `system_settings` :
la changer demande un redéploiement (contrairement aux limites JOB-006). 63 jobs hebdo si les 9
projets repartent ensemble — d'où la reprise un par un.
⚠️ **Deux défauts connus partis en prod tels quels** (revue visuelle RAS, décision assumée) :
la **double navigation** (sidebar 12 entrées vs barre d'onglets 8, libellés divergents « Avis » /
« Avis Google », « Présence locale » / « Fiche Google », pas d'Indexation côté sidebar) et la
**page de login qui annonce encore « Content Hub / Jon Labs »**.
⚠️ **E08 (avis GMB) = 8 tickets, 1 livré (GMB-002, lots 1 ET 2).** La collecte tourne et le
détecteur écrit ses findings ; ce qui manque encore, c'est tout le reste de l'epic — projection
de contexte, brouillons, quality gate, policy d'envoi (GMB-003 à GMB-008).
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

Commit : `a5a04c3` (= `main` = `origin/main`) · `d222c39` = déploiement de prod observé
