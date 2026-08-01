# HANDOFF — 2026-07-31

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Mise en prod du cockpit (`feat/cockpit` → `main`) | plan : `~/.claude/plans/ok-go-pour-que-reflective-pinwheel.md` | ✅ **TERMINÉE — 5/5** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | EN ATTENTE (Jonathan, infra) |

> Clôturé le 2026-07-28 : **Avis GMB (E08/GMB-002)**, lots 1 et 2 — recap dans
> [features/gmb-002-reviews.md](features/gmb-002-reviews.md). **E08 reste à 1 ticket sur 8.**

🆕 **2026-08-01 — E08 a une carte : [`gmb-avis-pipeline.md`](gmb-avis-pipeline.md).** État réel,
cible validée, reste à faire côté hub et côté skills. À lire avant de toucher aux avis GMB.
**Deux choses à savoir tout de suite :** ⭐ **rien ne répond automatiquement** — `replyToReview` a
un seul appelant, la route API qui exige une session admin ; le hub collecte et détecte, il
n'exécute pas. ⭐ **GMB-003 n'était pas bloqué** : son état disait `BLOCKED · DATA-002` alors que
DATA-002 est DONE depuis le 21.07. Corrigé en `READY`. C'est la clé de voûte — il débloque
GMB-004→007 **et** le nouveau **GMB-009** (mentions employés dérivées).

## Reprendre ici

🆕 **2026-07-31 — LA MACHINE EST RELANCÉE : les 9 cadences hebdo sont reprises et le run hebdo
a réellement tourné sur les 9 projets.** `origin/main` = prod = **`6cc2a22`**
(`/api/whoami` → `version: 6cc2a22`). Le canary (étape 5/5) est **clos**.

**Ce qui a été fait, dans l'ordre — et l'ordre compte :**
1. **Trou GSC comblé** avant toute reprise : la semaine 13→19/07 manquait à 5 projets, au milieu
   de la fenêtre 4 semaines que lisent FIND-005/006/008 (`collect-gsc.ts --week=2026-07-13`).
   9/9 projets l'ont désormais. La semaine 20→26/07 a suivi par la file.
2. **`report.publish_deadline_minutes = 300`** (`system_settings`, échéance 14:00 locales).
3. **Reprise + run FORCÉ le soir même** au lieu d'attendre le lundi : `lecureux` en canary, puis
   les 7 petits, puis `barberconcept` seul. ⚠️ `schedule.ts --now=2026-07-27T07:05:00Z
   **--lookback-hours=1**` — la fenêtre resserrée est ce qui évite de replanifier au passage le
   run QUOTIDIEN du même créneau (14 jobs au lieu de 9 par projet).

⚠️ **Deux estimations du HANDOFF précédent étaient FAUSSES, mesures à l'appui :** le catalogue
hebdo porte **5 détecteurs / 9 entrées** (pas 4/7) depuis FIND-008, donc **81 jobs** pour 9 projets
et non 63 ; et un run se draine en **UN tick** (~7 min), pas trois — le worker enchaîne les tours
dans la même invocation, donc la profondeur 3 ne coûte plus un tick par niveau. C'est
`MAX_JOBS_PER_TICK = 25` qui commande, pas le graphe.

✅ **Résultat : 8 runs hebdo `success`, 9 jobs sur 9 chacun, zéro job non conclu.** Le parc passe
de 36 à **171 findings ouverts** (jonlabs 79 · barberconcept 22 · lecureux 17 · barbermedia 16 ·
physiopommier 11 · wildcat 9 · bisrepetita 7 · cardrank 5 · spinlink 5) et de 4 à **18 propositions**.
L'indexation quitte le zéro : **11 sitemaps · 491 URLs · 150 sélections · 145 inspections**.
⚠️ **Le run de `barberconcept` était encore `queued` à l'heure d'écrire** (posé à 22:15 UTC, tick de
23:00) — c'est le seul projet jamais diagnostiqué, jusqu'à ~175 findings d'un coup.

🆕 **Deux défauts trouvés par ce premier run réel, corrigés et déployés** (`499d338`, `6cc2a22`) :
⭐ **`gsc-auth.ts` appelait `fetch` sans plafond de temps.** Les boucles testent le signal du job
**entre** deux appels : un appel mort ne repasse par aucun test, la fonction Vercel est tuée à
300 s, et un `SIGKILL` ne repasse par aucun `finally` — la ligne reste `running` jusqu'au reaper,
qui la rend à la file pour que la tentative suivante meure pareil. Mesuré sur `cardrank` :
`collect:url_inspection` abandonné deux fois **à l'heure près** (19:04→20:01, 20:05→21:00), la 3ᵉ
tentative passant en 107 s — donc un appel MORT, pas un problème de volume. Le plafond (30 s) vit
dans `resolveFetch`, il couvre les **4** appels du module ; le dépassement devient un
`GscApiError` **504** et jamais un `AbortError` nu (c'est ce qui le fait classer `retryable` au
lieu de dead-letter) ; le signal de l'appelant est **combiné**, pas remplacé.
⭐ **Un run se disait `success` sur un sous-ensemble de ses jobs.** Un step n'est écrit qu'à
l'issue **terminale** de son job : un job encore en file n'en a aucun, et son absence était
indiscernable de son inexistence — le run hebdo de `cardrank` était `success` avec **7 steps sur
9**. ⚠️ Pas cosmétique : `classifyProjectReadiness` mappe `success` → `ready`, donc le rapport
pouvait s'annoncer **`complete` alors qu'une détection n'avait pas tourné**. C'est « absent ≠
zéro » transposé aux steps. `recomputeRunStatus` compte désormais les jobs `queued`/`running`.

**Prochaine étape : vérifier `PUBLIC_APP_URL` côté Vercel.** ⚠️ **`hub.jonlabs.ch` ne résout plus
(NXDOMAIN)** et c'est le fallback en dur de `notifications.ts` et de `/api/cron/gmb-weekly-digest`,
qui part **lundi 06:00 UTC** vers `contact@barberconcept.ch` (seul projet opt-in) avec des liens
dedans. Non lisible sans la CLI Vercel (non installée).

⚠️ **À savoir pour lire le rapport du lundi 03/08** : comme la semaine a été collectée le 31/07, le
run du 03/08 collectera **la même** (20→26/07 reste la dernière complète avec la latence de 3 j).
Il va donc **rafraîchir** au lieu de découvrir — un rapport pauvre en nouveautés sera correct.
⚠️ **Rien n'envoie ce rapport** (TEL-002 `BLOCKED` sur TEL-001) : il faut aller sur `/reports`.
⚠️ **Approuver n'exécute toujours rien** (AGT-001) : 18 propositions, **0 approbation**.
⚠️ **Le rapport du 2026-07-27 (`partial`, 9 projets `missing`) mérite une révision** maintenant que
les runs de ce créneau existent et ont réussi : `rep-003-publish.ts --revise <slot> --reason "…"`.

---

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

Commit : `6cc2a22` (= `main` = `origin/main` = déploiement de prod observé, `/api/whoami`)
