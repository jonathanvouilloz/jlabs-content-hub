# Feature — E00 Fondations (reconstruction agentique)

> Premier lot exécutable du BACKLOG (§9) pour la reconstruction cockpit agentique.
> SPEC source : `docs/SPEC.md` v0.2 · Backlog : `docs/BACKLOG.md` E00.
> Branche : `feat/cockpit` (depuis `feat/neon`).

## Etat session 2026-07-26 (DASH-003 lot 2 chantier 1 — la pause entre dans la santé)

**Fait :** le chantier 1 de DASH-003 lot 2. DASH-006 avait appris à `/automations` qu'« une décision
n'est pas une panne ». `grep -i pause` rendait **0 occurrence** dans `home-state.ts`, `home.ts`,
`project-cockpit-state.ts` et `project-cockpit.ts` : la leçon s'arrêtait à un écran. Sur `/` et
`/projects/[slug]`, un projet volontairement suspendu se lisait donc comme un pipeline qui a cessé de
livrer — collecte en retard, zéro finding, badge rouge — soit exactement la confusion que DASH-006
supprime, réintroduite sur l'écran qu'on lit en premier. **Zéro DDL** (60 tables), **une seule requête
ajoutée**, coût constant quel que soit le nombre de projets.

- **LE point du lot : `paused` est un 6ᵉ état de PROJET, pas une 5ᵉ valeur d'axe.** `unknown` semblait
  suffire — un projet suspendu ne dit effectivement plus rien — mais il veut dire « muet, **et je ne
  sais pas pourquoi** », le contraire exact de ce qui est vrai ici. Et l'argument qui tranche est un
  effet de bord : `STATE_RANK` place `unknown` en 3ᵉ position, donc un projet volontairement suspendu
  serait passé **devant** un projet à surveiller. Un arrêt volontaire ne prend pas la tête de la file
  → `paused` est rangé **après `ok`**, et `needsAction` l'exclut.
- **⭐ L'ordre des règles de `classifyPipeline` est celui de ce qui SURVIT à la reprise.** Un
  credential `revoked` sous pause reste `broken` (le jour où on reprend, la panne est encore là) ; un
  job en dead-letter reste une dégradation (il est **déjà** en file, la pause ne le concerne pas) ;
  seul le **retard de collecte** cesse d'être un symptôme, parce qu'il est la conséquence attendue de
  la décision. Prouvé en base : intégration `revoked` **+** gel projet ⇒ `broken`, pas `paused`.
- **⭐ La pause n'explique le retard que si TOUS les jobs du provider de fraîcheur sont suspendus.**
  La première version disait « au moins un » et elle était fausse : `collect:gsc_query_page` (hebdo)
  **et** `collect:url_inspection` (quotidien) appellent tous deux `syncGscIntegration`, donc suspendre
  le seul quotidien laisse la fraîcheur se renouveler chaque lundi — un vrai retard s'y serait lu
  « c'est normal, c'est en pause ». Trouvé par un test qui a échoué en ayant raison.
- **Le diagnostic est suspendu PAR DÉTECTEUR, jamais en bloc.** Un détecteur n'est suspendu que si
  **chacune** des cadences câblées qui l'enfilent l'est : `detect:index_transition` est aux catalogues
  `daily` **et** `weekly`, donc suspendre le hebdo ne le suspend pas — il tournera demain. Et la
  **propagation JOB-004 y est comptée** : couper `gsc` ne suspend directement aucun détecteur (aucun
  ne sort de Postgres) et les suspend pourtant tous, parce qu'un prérequis obligatoire mort fait
  passer son dépendant en `skipped` — ce que DASH-006 avait prouvé en base.
- **La couverture acquise ne BAISSE pas sous pause.** `diagnosis.state` reste `full` : ce qui a été
  examiné l'a été, la couverture cesse seulement d'être renouvelée. La rabaisser effacerait un passage
  réel — mentir dans l'autre sens. Le fait nouveau vit dans `diagnosis.suspended`, et fait passer un
  signal `ok` à `watch` (jamais `unknown`, réservé au « je ne sais RIEN »).
- **Rien n'est réimplémenté.** L'union des portées (`project` > `project_cadence`) et l'expiration
  `until` dérivée viennent de `resolveCadencePause`/`derivePauseStates`. Une seconde comparaison de
  `until` dans `home-state.ts`, c'était exactement la divergence que DASH-006 a supprimée.
- **Une seule requête, pas un N+1.** `loadPauseStates` entre dans le `Promise.all` de
  `loadHomeCockpit` avec le **`now` déjà calculé** (13 → 14 allers-retours, constant), et
  `loadExpectedDetectors` est **élargie** en `loadScheduleConfigs` — même requête sur
  `project_projections`, config complète au lieu de la seule liste de détecteurs. Surtout **pas**
  `loadProjectScheduleConfig` par projet, le N+1 assumé de `loadCadenceRows` sur `/automations`.
- **Zéro changement dans `project-cockpit.ts`** : la carte vient de `loadHomeCockpit` par slug, donc
  `pause` arrive gratuitement et l'invariant anti-divergence de DASH-003 lot 1 tient **par
  construction** — vérifié pause active (§G).

**Vérifs :** 1026 tests (**+29** sur `home-state`, dont 6 contre-épreuves) · `npm run check` 0 erreur /
42 warnings (baseline) · `scripts/dash-003-pause-health-proof.ts` **26/26 sur Neon**, base rendue à
l'identique (pauses 2→2, projets 6→6, intégrations 6→6, jobs 16→16) · non-régression `dash-002-home`,
**`dash-003-project` (l'égalité §A)**, `dash-006-automations`, `dash-006-pause`, `job-004-dag`,
`job-005-schedule`, `job-006-limits` — **0 échec chacune**.

**Prochain :** **DASH-003 lot 2 chantier 2** — l'onglet Indexation (`/projects/[slug]/indexing`), qui
donnerait enfin un lecteur d'écran à `indexing-read.ts` (`loadLatestIndexStates`, `loadIndexHistory`,
`loadIndexSeries`, `loadInspectionFreshness` — cette dernière n'a **aucun appelant nulle part**) et à
`index_selection` : 4 tickets E04 livrés, résumés aujourd'hui en 4 lignes sur la vue d'ensemble. Zéro
DDL également. Sinon **E11/exécution** — approuver une proposition n'exécute toujours rien.

**Pièges :**
- **⚠️ Un gel total + un finding critique donne le badge `paused`, pas `at_risk`.** Ce n'est pas un
  oubli : pause totale ⇒ pipeline `unknown` ⇒ signal `unknown` (règle DASH-002 préexistante), et le
  critique reste **dit** dans `signal.reasons` (« déjà ouvert ») comme sous un pipeline cassé. La
  contre-épreuve montre que le badge ne **masque** rien pour autant : ajoutez un job en dead-letter et
  le pipeline reste `degraded`, le signal reprend le droit de conclure, et la carte repasse `at_risk`.
- **⚠️ `STATE_META` a un repli `?? STATE_META.unknown`** dans les deux `.svelte`. Un `paused` oublié
  n'aurait pas planté : il aurait affiché « État inconnu » en violet sur un projet dont la cause du
  silence est connue, écrite et datée. Le badge n'aurait pas cassé — il aurait menti. Idem
  `STATE_ORDER`, sans quoi la puce « suspendus » n'existe nulle part.
- **⚠️ La preuve injecte des instants strictement croissants**, et c'est nécessaire :
  `automation_pauses.created_at` est à la **seconde** et `loadPauseStates` départage les ex æquo par
  `id DESC` — un ordre reproductible, **pas juste** (c'est écrit dans `pauses.ts`). La première
  version posait pause et reprise en moins d'une seconde et échouait en §D une fois sur deux, en
  accusant le code d'un défaut qui n'existe pas.
- **`worst` ignore `paused`** (une décision n'est pas une panne) **sauf si TOUT le parc est
  suspendu** : six projets gelés ne sont pas « au vert ».
- **Le bandeau de pause est rendu même sur une pause PARTIELLE**, qui ne porte pas le badge — c'est
  justement le cas où la cause du silence est la plus difficile à retrouver.
- Inchangé : `npm run build` échoue à l'adaptateur Vercel sous Windows (**préexistant**) · **le
  cockpit n'est toujours pas déployé** (`main` = socle epics 1-23 sur Neon, ni `/jobs`, ni `/inbox`,
  ni cron `tick`), donc une pause posée ici ne suspend rien en prod · `project-cockpit-state.ts` n'a
  **pas** été touché : il ne calcule pas la santé (il réutilise `classifyProject`), le défaut était
  en amont.

**Commit :** _(à faire)_

---

## Etat session 2026-07-26 (DASH-006 lot 2 — arrêter une automatisation sans que ça ressemble à une panne)

**Fait :** DASH-006 **lot 2**, qui ferme l'epic DASH-006. Le lot 1 avait appris au cockpit à voir le
créneau **qui n'a pas eu lieu** ; il ne savait pas dire **pourquoi**, et les deux causes n'ont rien à
voir : un cron mort est un incident, un projet suspendu est une décision. Les confondre, c'est soit
s'alarmer pour rien, soit ranger un vrai incident sous « c'est normal ». **1 seul DDL** (59 → **60**
tables).

- **LE point du lot : une pause est une DÉCISION, pas une configuration.** C'est ce qui la disqualifie
  des deux endroits où on aurait spontanément voulu l'écrire. `project_projections.payload.schedules`
  est une **projection recompilée** : une pause y serait effacée **sans bruit** à la compilation
  suivante — un monitoring qui redémarre tout seul sans que personne l'ait décidé. `system_settings`
  est un KV qui se **réécrit sur place** : le geste précédent disparaît, donc « pause et reprise sont
  auditables » devient infalsifiable. D'où `automation_pauses`, **journal append-only** calqué sur
  `finding_events`, dont l'état effectif se **dérive**. L'auditabilité est structurelle, pas
  déclarative : il n'existe aucun booléen qui puisse diverger de son historique, **parce qu'il
  n'existe aucun booléen**.
- **Trois portées, une seule mécanique** (`project_cadence` / `project` / `provider`) : un journal, un
  dérivateur. Une cadence est suspendue si **l'une des deux premières** la couvre — **union, pas
  préséance**, donc rien à arbitrer et rien qui puisse diverger entre l'écran et le scheduler. Quand
  les deux existent, c'est la **plus large** qui est nommée : c'est elle qu'il faudra lever, et
  proposer « Reprendre » sur la cadence ferait cliquer dans le vide. **Prouvé en base (section E).**
- **⭐ L'acceptation du BACKLOG, littéralement : « la désactivation d'un provider n'annule pas les
  autres steps ».** Une pause provider ne suspend **aucune** cadence — le run s'ouvre, et seuls ses
  jobs sautent. Le `skipped` n'est pas un choix esthétique : c'est le statut que
  `classifyDependencyGate` lit comme « prérequis mort », donc **la propagation JOB-004 est gratuite et
  déjà prouvée**. Vérifié sur Neon : couper `gsc` fait sauter les 3 collecteurs **et**
  `detect:keyword_opportunity` (prérequis obligatoire), pendant que `findings:lifecycle` reste
  `queued` — il ne sort pas de Postgres, il n'a aucune raison d'attendre.
- **Trois options existaient pour les jobs déjà en file, deux étaient des pièges.** Les laisser partir
  : « en pause » à l'écran ne voudrait rien dire en réalité. Les rendre seulement non réclamables :
  ils dormiraient **à vie**, et leurs dépendants obligatoires avec eux — le trou exact que JOB-004 a
  fermé. D'où **les deux** : la 4ᵉ passe `pauseOnce` **conclut** (jumelle de `reapOnce`/`settleOnce`/
  `coolDownOnce`, appelée **avant** `settleOnce` pour que le skip se propage dans le **même drain**),
  et la garde d'admission **empêche** (`provider_paused`/`project_paused` dans `claimJob`, où vit
  déjà celle de JOB-006). ⚠️ Un projet gelé est **retiré du calcul de réouverture du tour** : l'y
  laisser bloquerait l'équité du parc entier (il a du travail réclamable qu'il ne prendra jamais).
- **L'expiration est DÉRIVÉE, jamais écrite.** Une pause `until` échue n'est plus active à la lecture,
  sans qu'aucune ligne ne bouge (compté avant/après en base) — donc aucun moyen qu'une pause « expirée
  en base » et une pause « expirée à l'écran » se contredisent. Même discipline que `isSnoozeExpired`.
- **Un vrai piège de fuseau trouvé par un test, corrigé à la racine.** `new Date('2026-07-26 12:00:00')`
  est parsé en heure **locale** (ECMA-262) : repasser par `toDbTimestamp` une chaîne **déjà** au format
  DB la décalait d'une à deux heures à Zurich. Une pause échéant à 12:00 se serait lue active jusqu'à
  14:00, et le bug n'aurait été visible qu'aux abords de l'échéance, **deux fois l'an avec une
  amplitude différente**. → `normalizeDbTimestamp` dans `timestamps.ts`, sa vraie maison.

**Ce que l'écran a dit, à l'œil, en session admin :** suspendre `barberconcept/hebdomadaire` fait
passer le bandeau de **12 manqués / 12 attendues** à **11 / 11 + 1 suspendue** — la décision sort du
dénominateur **et** du décompte d'échecs, badge bleu et non rouge, dernier et prochain créneau à `—`.
La reprise revient à 12/12 **et le journal garde les deux lignes**. Refus vérifié sans raison
(« Une raison est requise. »).

**Vérifs :** 997 tests (40 neufs sur `pause-state`, + pauses dans `automations-state` et `job-limits`)
· `npm run check` 0 erreur · `scripts/apply-dash-006.ts` **60 tables, 0 unique hors PK** ·
`scripts/dash-006-pause-proof.ts` **24/24 sur Neon** (dont les 3 contre-épreuves ⭐) · non-régression
`dash-006-automations`, `job-004-dag`, `job-005-schedule`, `job-006-limits`, `job-007-console`,
`dash-002-home`, `dash-003-project` — **0 échec chacune** · base laissée **propre** (0 résidu de
preuve, 6 projets).

**Prochain :** **DASH-003 lot 2** — trancher d'abord **quels onglets** (le BACKLOG et le bloc de
session DASH-003 lot 1 de ce fichier ne listent pas les mêmes), et **revoir `project-cockpit-state.ts`**
qui traîne deux pièges hérités : il n'applique ni la règle des deux axes (DASH-006) ni celle de la
couverture de diagnostic (DASH-002). Sinon **E11/exécution** : approuver une proposition n'exécute
toujours rien.

**Pièges :**
- **⚠️ Un run dont TOUS les steps sont `skipped` se lit `success`** (`STEP_TERMINAL_OK` contient
  `skipped`, sémantique JOB-004 préexistante). Ce n'est pas faux — rien n'a échoué — mais un projet
  gelé en cours de run affichera « réussi ». C'est la règle des deux axes une fois de plus : le
  statut du run dit « rien n'a échoué », `/automations` dit **pourquoi rien n'a tourné**. Bien plus
  atteignable depuis ce lot qu'avant.
- **La pause vient APRÈS `disabled`** dans `classifyCadence`, et l'ordre réplique celui du scheduler
  (`applyPauseToSpec` ne s'applique qu'à un `enabled` déjà vrai). Inversé, l'écran offrirait un bouton
  « Reprendre » qui marche et après lequel **rien ne repart**.
- **`paused` n'entre PAS dans `FAILING_HEALTHS`** : une décision n'est pas une panne. L'y ajouter
  remettrait la confusion que ce lot supprime.
- **La preuve emprunte un slug de `core.entities`** (`bc-chenois`) faute de pouvoir en inventer un :
  `projects.slug` porte une FK cross-schéma vers le registre possédé par `invoices`, que seo-stats ne
  modifie jamais (loi n°3). Garde posée : si un projet réel porte déjà ce slug, la preuve **s'arrête**,
  et le nettoyage ne supprime que la ligne créée, **par son id, jamais par son slug**.
- **`PausedByOperator` entre au vocabulaire d'erreur** aux côtés de `DependencySkipped`. Il ne
  consomme **pas** de tentative (`attempt_no` inchangé) : le job n'a rien raté, on lui a retiré
  l'autorisation de partir — l'incrémenter le rapprocherait de la dead-letter pour une décision humaine.
- Inchangé : `RUN_TYPES` (`monitoring-state.ts`) ne contient pas `hourly` · `npm run build` échoue à
  l'adaptateur Vercel sous Windows (**préexistant**) · **le cockpit n'est toujours pas déployé**, donc
  une pause posée ici ne suspend rien en prod. ⚠️ **La raison a changé le 2026-07-26 14:35 UTC** : le
  cutover Phase 5A est fait, la prod tourne sur Neon — mais `main` porte le socle epics 1-23, **pas**
  `feat/cockpit`. Il n'y a ni `/jobs`, ni `/inbox`, ni cron `tick` en prod. « Rien n'y tourne » reste
  vrai ; ce n'est plus « rien n'est déployé ».

**Commit :** `95db447` [hub] add: une automatisation s'arrête sur décision, pas sur panne (DASH-006 lot 2)

---

## Recap epic — DASH-006 Vue automatisations et jobs (2026-07-26) · CLÔTURÉ

**Objectif** : donner au cockpit la vue des automatisations — savoir ce qui aurait dû tourner, ce qui
a tourné, ce qui a échoué, et pouvoir **arrêter volontairement** une automatisation. Les deux
acceptations du BACKLOG : « une panne est diagnostiquable sans accès serveur » et « pause et reprise
sont auditables », plus « la désactivation d'un provider n'annule pas les autres steps ».

**Livré**

- **Lot 1 — l'absence devient visible.** `/automations` croise le dernier créneau **attendu**
  (calculé par `dueOccurrences`, la fonction même du scheduler) et le run **observé**
  (`monitoring_runs.period_end`). Un job mort laisse une ligne ; un **tick qui ne tourne pas ne
  laisse rien**, et seul ce croisement le révèle. **Zéro DDL.**
- **Lot 1 — deux axes qui ne fusionnent jamais** : « le créneau a-t-il été **tiré** ? » ≠ « ce qui a
  été tiré a-t-il **réussi** ? ». `late`/`missed` se sépare sur `DEFAULT_LOOKBACK_MS` **importée** du
  scheduler, jamais recopiée.
- **Lot 1 — deux effets de bord** : le compteur « runs de la période » de l'accueil cesse d'être
  muet (nombre et URL nés du même descripteur), et `/jobs` accepte `?run=` avec bandeau visible.
- **Lot 2 — `automation_pauses`**, journal **append-only** (seul DDL de l'epic : 59 → **60** tables)
  dont l'état effectif se **dérive**. Trois portées (cadence, projet, provider) en **union, pas en
  préséance**. Raison **obligatoire dans les deux sens**, reprise comprise.
- **Lot 2 — la pause mord vraiment** : overlay au scheduler (`applyPauseToSpec`), **4ᵉ passe worker**
  `pauseOnce` qui **conclut** les jobs en file (`skipped` + `job_attempts`), et garde d'admission qui
  les **empêche** (`provider_paused` / `project_paused` dans `claimJob`).
- **Ce que l'écran a dit dès le premier chargement : 12 créneaux manqués sur 12**, aucun run
  hebdomadaire n'ayant **jamais** existé — cohérent avec le cutover en attente.

**Décisions techniques** (reportées dans `docs/DECISIONS.md`)

- **Une pause est une DÉCISION, donc un journal append-only dont l'état se dérive — jamais un
  booléen** : `project_projections` est **recompilée** (la pause y serait effacée sans bruit, et le
  monitoring redémarrerait sans que personne l'ait décidé) ; `system_settings` se **réécrit sur
  place** (l'auditabilité devient infalsifiable). Alternatives écartées : ces deux-là, plus le
  couple état+journal de `findings.status` — deux sources de vérité pour une garantie d'audit sont
  exactement ce qu'on ne veut pas.
- **Aucun unique sur la table** : rejouer un geste ne doit pas *échouer*, il ne doit *rien écrire*.
  L'idempotence vit dans la transaction (contrat d'`approveProposal`) ; une contrainte transformerait
  un double clic en erreur au lieu d'un non-événement.
- **Un job suspendu est CONCLU et empêché — les deux, pas l'un ou l'autre.** Le laisser partir vide
  « en pause » de son sens ; le rendre seulement non réclamable le fait dormir **à vie** avec ses
  dépendants obligatoires (le trou que JOB-004 avait fermé). Le statut `skipped` est ce que
  `classifyDependencyGate` lit comme prérequis mort → propagation **gratuite**. Alternatives
  écartées : `cancelled` (dit « un humain a annulé CE job »), suppression (trou d'audit).
- **L'expiration `until` est dérivée à la lecture**, jamais écrite : aucun job de réveil, donc aucun
  moyen qu'une pause « expirée en base » contredise une pause « expirée à l'écran ».
- **La jointure du lot 1 porte sur le créneau LOCAL**, pas sur un intervalle autour de l'instant : un
  intervalle apparierait un run au créneau voisin le jour du changement d'heure, précisément là où
  la question se pose.

**Problèmes rencontrés**

- **Piège de fuseau, trouvé par un test sur la borne d'échéance** : `new Date('2026-07-26 12:00:00')`
  est parsé en heure **LOCALE** (ECMA-262), donc repasser par `toDbTimestamp` une chaîne **déjà** au
  format DB la décalait d'une à deux heures à Zurich. Une pause échéant à 12:00 se serait lue active
  jusqu'à 14:00 — visible seulement aux abords de l'échéance, **deux fois l'an avec une amplitude
  différente**. → `normalizeDbTimestamp` posé dans `timestamps.ts`, sa vraie maison, pas dans le
  module appelant.
- **`listPauseJournal` mélangeait alias SQL et colonnes drizzle** : celles-ci se rendent en nom
  pleinement qualifié, que Postgres refuse dès qu'un alias existe (42P01). → conditions réécrites
  sur l'alias.
- **Le projet sentinelle de la preuve ne pouvait pas avoir un slug inventé** : `projects.slug` porte
  une FK cross-schéma vers `core.entities`, registre possédé par `invoices` que seo-stats ne modifie
  jamais (loi n°3). → la preuve **emprunte** un slug déjà déclaré mais sans projet SEO (`bc-chenois`,
  ancien slug de facturation fusionné dans `bcchenois`), avec garde anti-collision et nettoyage
  **par id, jamais par slug**.
- **Le catalogue de substitution de la preuve câblait toutes les cadences** → 200 occurrences
  horaires non suspendues faisaient échouer l'assertion B **en ayant parfaitement raison**. Corrigé
  côté harnais, pas côté code.

**Fichiers**

### Créés
- `src/lib/server/automations-state.ts` (+ `.test.ts`) — le jugement de planification, pur *(lot 1)*
- `src/lib/server/automations.ts` — lecture base (croisement créneau ↔ run, règles effectives) *(lot 1)*
- `src/routes/(app)/automations/+page.{server.ts,svelte}` — l'écran *(lots 1 et 2)*
- `src/lib/server/pause-state.ts` (+ `.test.ts`) — le jugement des pauses, pur *(lot 2)*
- `src/lib/server/pauses.ts` — lecture `DISTINCT ON` + écriture transactionnelle idempotente *(lot 2)*
- `src/lib/server/jobs-pause.ts` — la 4ᵉ passe du worker *(lot 2)*
- `src/routes/api/ops/automations/pause/+server.ts` — la seule porte humaine *(lot 2)*
- `drizzle/manual-dash-006.sql` · `scripts/apply-dash-006.ts` — le DDL et son application *(lot 2)*
- `scripts/dash-006-automations-proof.ts` (13/13) · `scripts/dash-006-pause-proof.ts` (24/24)

### Modifiés
- `src/lib/server/db/schema.ts` — table `automation_pauses` (seul DDL de l'epic)
- `src/lib/server/scheduler.ts` — overlay de pause au call site ; `pausedCadences` dans `PlanResult`
- `src/lib/server/job-runner.ts` — `pauseOnce` avant `settleOnce` ; compteur `pausedSkipped`
- `src/lib/server/job-limits.ts` — `pausedProviders`/`pausedProjectIds` dans `planAdmission`
- `src/lib/server/timestamps.ts` — `normalizeDbTimestamp`
- `src/lib/utils/job-format.ts` — libellés `paused`, `PausedByOperator`, `skipReasonLabel`
- `src/routes/api/cron/tick/+server.ts` — les cadences suspendues remontent dans la réponse
- `src/lib/server/{home,home-state,job-console,jobs-claim}.ts`, `src/routes/(app)/{+page,+layout,jobs}` *(lot 1)*

**Vérifications**

| Test | Résultat |
|---|---|
| `npm run test` | **997 passés / 997** (40 neufs sur `pause-state`, + pauses dans `automations-state` et `job-limits`) |
| `npm run check` | **0 erreur** (42 warnings préexistants) |
| `scripts/apply-dash-006.ts` | **60 tables**, 11 colonnes, `project_id` nullable, **0 unique hors PK** |
| `scripts/dash-006-pause-proof.ts` | **24/24 sur Neon**, dont les 3 contre-épreuves (reprise, propagation provider, expiration sans écriture) |
| `scripts/dash-006-automations-proof.ts` | **13/13** |
| Non-régression (`job-004-dag`, `job-005-schedule`, `job-006-limits`, `job-007-console`, `dash-002-home`, `dash-003-project`) | **0 échec chacune** |
| Revue à l'œil, session admin | **passée** — pause/reprise réelles sur `barberconcept/hebdomadaire`, refus sans raison vérifié, base laissée propre |
| `npm run build` | **échoue** à l'adaptateur Vercel sous Windows — **préexistant**, sans rapport avec l'epic |

**Dettes assumées**

- **Un run dont TOUS les steps sont `skipped` se lit `success`** (`STEP_TERMINAL_OK` contient
  `skipped`, sémantique JOB-004 préexistante). Pas faux — rien n'a échoué — mais bien plus
  atteignable depuis ce lot. À revisiter si un run entièrement suspendu devient courant.
- **`project-cockpit-state.ts` (DASH-003) n'applique ni la règle des deux axes ni celle de la
  couverture de diagnostic.** Piège hérité, à traiter quand DASH-003 lot 2 reprendra.
- **`RUN_TYPES` (`monitoring-state.ts`) ne contient pas `hourly`** alors que `CADENCE_RUN_TYPE` le
  mappe. Sans effet tant que la cadence n'est pas câblée.
- **Rien n'est déployé** : le cutover Phase 5A (variable Vercel + merge `--ff-only`) reste en
  attente, donc une pause posée aujourd'hui ne suspend rien en production — puisque rien n'y tourne.

---

## Etat session 2026-07-26 (DASH-006 lot 1 — le cockpit voit le créneau qui N'A PAS eu lieu)

**Fait :** DASH-006, **lot 1** (calendrier + runs + règles effectives). Le cockpit savait montrer
ce qui avait tourné ; il ne savait pas montrer ce qui **n'avait pas** tourné. Un job mort laisse
une ligne, et `/jobs` la voit — mais un **tick qui ne tourne pas ne laisse rien** : ni run, ni job,
ni erreur. L'absence n'a pas de ligne. **Zéro DDL.**

- **LE point du lot : la panne se révèle par un CROISEMENT, pas par une lecture.** Le dernier
  créneau **attendu** est calculé par `schedule-state.ts` — la fonction même du scheduler, jamais
  une réimplémentation, sinon les deux énumérations divergeraient au premier changement d'heure et
  l'écran accuserait le cron d'un créneau qu'il n'a jamais eu à tirer. Le run **observé** est joint
  sur `monitoring_runs.period_end`, qui porte le **créneau local** — et non sur un intervalle autour
  de l'instant, qui apparierait un run au créneau voisin le jour du changement d'heure, précisément
  là où la question se pose.
- **Deux axes qui ne fusionnent jamais**, comme à l'accueil : `health` répond « le créneau a-t-il été
  **tiré** ? », le statut du run répond « ce qui a été tiré a-t-il **réussi** ? ». Les fondre
  peindrait en rouge un projet dont le run hebdo est parti à l'heure et a échoué faute de quota — et
  en vert celui dont le dernier run est `success` mais qui n'a plus rien tiré depuis trois semaines,
  qui est la panne qu'on cherche. **Contre-épreuve en base** : poser un run `failed` sur le créneau
  manquant passe la planification à `ok` **tout en affichant l'échec** ; le retirer la fait retomber
  à `missed`.
- **`late` vs `missed` se joue sur `DEFAULT_LOOKBACK_MS`, importée du scheduler et jamais recopiée.**
  Au-delà de la fenêtre, `dueOccurrences` ne regarde plus en arrière : le créneau est perdu **pour de
  bon**. Deux valeurs distinctes feraient promettre à l'écran un rattrapage que le tick ne ferait
  pas. La bascule est testée **pile sur la borne**, du bon côté (`instantMs > since` : un créneau sur
  la borne n'est PAS repris, donc il est déjà `missed`).
- **L'ordre des règles est celui de `planDueJobs`** — non câblée avant désactivée, parce que le
  scheduler écarte les cadences sans handler **avant** de lire `enabled`. Inversé, l'écran donnerait
  deux raisons au même silence, dont une fausse. Et un créneau **antérieur à la création du projet**
  ne lui est pas reproché, sans qu'une date inconnue ne blanchisse quoi que ce soit.
- **`monitoring_runs`/`monitoring_steps` n'avaient AUCUN lecteur** depuis DATA-003. Les steps sont
  réduits à la **dernière tentative** de chaque `step_type` : un step échoué puis relancé avec succès
  se lirait sinon comme un demi-échec permanent.
- **Deux effets de bord.** (1) Le compteur « runs de la période » de l'accueil **cesse d'être muet** :
  il n'avait pas de lien faute de liste capable de reproduire son filtre — il ouvre `/automations`
  avec le même `since` et le même `status`, **nombre et URL nés du même descripteur**. (2) `/jobs`
  accepte `?run=`, compteurs d'en-tête restreints comme pour le filtre projet, et **bandeau visible** :
  un filtre actif qu'aucun contrôle n'affiche ferait lire « la file est presque vide ».

**Ce que la page a dit au premier chargement, sur les vraies données :** **12 créneaux manqués sur
12**. Le quotidien n'a plus rien tiré depuis le **23.07**, et **aucun run hebdomadaire n'a jamais
existé**, sur aucun projet. Cohérent avec le cutover en attente — `/api/cron/tick` vit sur cette
branche, pas sur `main` — donc les 8 runs quotidiens des 22-23 juillet viennent de lancements
locaux, pas du cron. **Aucune automatisation ne tourne en production**, et c'est exactement ce que
cet écran existe pour dire.

**Vérifs :** 943 tests (25 neufs sur `automations-state`) · `npm run check` 0 erreur ·
`scripts/dash-006-automations-proof.ts` **13/13 sur Neon** (dont la contre-épreuve B et la
réduction des steps) · non-régression `dash-002-home-proof`, `dash-003-project-proof`,
`job-005-schedule-proof`, `job-006-limits-proof`, `job-007-console-proof` — **0 échec chacune** ·
**page parcourue à l'œil** en session admin, y compris le clic du compteur de l'accueil (11 → 11
lignes) et `/jobs?run=` (1 job, compteurs restreints).

**Prochain :** **DASH-006 lot 2** — pause/reprise autorisée et **auditable**. Trancher d'abord **où
vit une pause** : `project_projections.payload.schedules` est une **projection recompilée**
(`source_hash`, `status current/stale`), donc une pause écrite là serait effacée sans bruit à la
prochaine compilation. Une pause est une **décision**, pas une configuration — la forme pressentie
est un journal append-only dont l'état effectif se **dérive** (comme `findings`/`finding_events`),
ce qui donne l'auditabilité par construction. Sinon **DASH-003 lot 2** (trancher quels onglets).

**Pièges :**
- **La règle des deux axes vaut pour `/automations` uniquement.** `project-cockpit-state.ts`
  (DASH-003) n'a toujours pas été revu — piège hérité de la session précédente, inchangé.
- **`RUN_TYPES` (`monitoring-state.ts`) ne contient pas `hourly`**, alors que `CADENCE_RUN_TYPE` le
  mappe. Sans effet aujourd'hui (`hourly` n'est pas câblée, donc aucun run `hourly` n'existe), mais
  câbler la cadence écrirait un `run_type` hors vocabulaire.
- **Le lot 1 n'exécute aucune action** : la page montre et filtre, elle ne met rien en pause et ne
  relance rien. Le seul geste depuis `/automations` est un lien vers `/jobs`.
- **La colonne « Type / créneau » des runs affiche `manual` et sa date brute** : `manual` et
  `post_publish` sont des `run_type` sans cadran, donc `formatScheduleSlot` rend la chaîne telle
  quelle. Voulu — mais ne pas la lire comme un créneau.
- Inchangé : `npm run build` échoue à l'adaptateur Vercel sous Windows (**préexistant**) · **rien
  n'est déployé**.

**Commit :** `492d9c8` [hub] add: le cockpit voit enfin le créneau qui N'A PAS eu lieu (DASH-006 lot 1)

---

## Etat session 2026-07-26 (DASH-002 — « jamais regardé » cesse de se lire « rien à signaler »)

**Fait :** le point produit laissé ouvert par la revue visuelle. `barberconcept` s'affichait
**« Sain »** sans avoir jamais été diagnostiqué : sa collecte GSC était fraîche, son pipeline vert,
et ses **zéro findings** se lisaient « zéro problème » alors qu'ils voulaient dire « personne n'a
jamais ouvert le dossier ». C'est la même classe de faute que DASH-002 avait déjà fermée sur l'autre
axe (« un pipeline cassé rend le signal inconnu, jamais ok ») — il en manquait la moitié : un
pipeline sain ne prouve pas qu'on ait **regardé**. **Zéro DDL.**

- **Nouvel axe dérivé : la couverture de diagnostic** (`deriveDiagnosisCoverage`, module pur). Les
  détecteurs **attendus** viennent du CATALOGUE (`SCHEDULE_CATALOG`, filtré sur `detect:*`) et non
  d'une liste écrite à la main — ajouter un détecteur l'intègre d'office à la couverture, sans quoi
  un détecteur neuf ferait passer les projets pour couverts avant d'avoir tourné une seule fois.
  Croisés au dernier job `succeeded` de ce type sur le projet.
- **L'invariant : `ok` n'est atteignable que sur un diagnostic complet.** Ce qui est POSITIVEMENT su
  passe toujours (un critique reste un critique, même avec un angle mort) ; c'est la **conclusion au
  vert** qui exige d'avoir tout examiné. L'absence de finding n'est une bonne nouvelle que dans les
  domaines réellement examinés.
- **Trois degrés, et ils ne se confondent pas.** Première version : tout ce qui n'était pas complet
  virait `unknown`. Vérifié sur Neon — `detect:index_transition` n'ayant **jamais** tourné nulle
  part, les **6 projets** passaient au violet et « 6 à traiter sur 6 » ne distinguait plus le projet
  jamais ouvert de celui suivi depuis des semaines. Un cockpit uniforme ne se lit pas « en moins
  d'une minute » : il ne se lit plus du tout. D'où la séparation retenue — rien d'examiné →
  `unknown` (on ne sait rien) · partiellement examiné sans rien trouver → **`watch`** (on ne peut
  pas conclure) · tout examiné → le verdict des findings, `ok` compris.
- **Couper la planification ne rend pas un projet sain** : `expectedCount === 0` vaut `none`, pas
  `full`. Ça vise directement la décision en attente sur `barberconcept` (désactiver `weekly`) —
  l'éteindre le rendra muet, jamais vert.
- **Rendu inchangé** : `unknown` et `watch` existaient déjà côté template (violet « État inconnu »,
  ambre « À surveiller »). Le correctif ne touche que le jugement ; la phrase de la carte nomme le
  domaine jamais exécuté (« transitions d'indexation »), pas le type de job.

**État réel après correctif** (lecture Neon) : `barberconcept`/`spinlink`/`wildcat` **unknown**
(0/2 détecteurs), `jonlabs`/`bisrepetita`/`physiopommier` **watch** (1/2 — indexation jamais
examinée). Plus aucun projet ne se déclare sain, et aucun ne le mérite encore.

**Vérifs :** 917 tests (46 sur `home-state`, dont 9 neufs) · `npm run check` 0 erreur ·
`scripts/dash-002-home-proof.ts` vert sur Neon avec une section **B-ter** qui prouve en base ce que
vitest ne peut pas : la couverture rendue correspond aux jobs détecteurs réellement réussis, et sur
un pipeline sain l'inconnu est bien imputé au diagnostic et non à la collecte.

**Prochain :** DASH-003 lot 2 — trancher d'abord **quels onglets** (le BACKLOG et le bloc de session
DASH-003 lot 1 de ce fichier ne listent pas les mêmes). Sinon DASH-006, débloqué.

**Pièges :** la règle de couverture ne vaut que pour **l'accueil**. `src/lib/server/project-cockpit-state.ts`
(DASH-003) porte son propre jugement et n'a pas été revu — il peut avoir la même faille, à vérifier
quand DASH-003 reprendra. Par ailleurs `detect:index_transition` n'a **jamais** tourné en base : les
trois projets `watch` repasseront au vert dès son premier passage, ce qui est le comportement voulu
et non une régression à venir.

**Commit :** `d1ced4a` [hub] fix: un projet jamais diagnostiqué ne se lit plus « Sain » (DASH-002)

---

## Etat session 2026-07-25 (revue visuelle — le cockpit est vu à l'œil pour la PREMIÈRE fois)

**Fait :** la revue de rendu que DASH-002 et DASH-003 traînaient tous les deux en tête de leurs
pièges (« jamais vu à l'œil, tout est prouvé côté données, rien côté rendu »). Session admin ouverte
sur `localhost:5173`, parcours réel de `/`, `/projects/{jonlabs,barberconcept}` et de tous les
chemins de sortie du lot 1 (`/windows`, `/settings`, `/inbox`, `/content`, `/jobs`). **Zéro DDL,
aucun calcul touché** : les quatre correctifs sont verbaux.

- **Le cockpit marche.** Les invariants prouvés en base tiennent aussi à l'écran : deux axes jamais
  fusionnés, trio période/fraîcheur/source sur **tous** les panneaux, `inactive` en gris avec
  « Brancher → » et non en rouge, **aucun « 0 h »** sur un domaine jamais collecté (`Période aucune
  donnée` / `Fraîcheur jamais collecté`), aucun onglet mort, et le refus de delta GSC-004 lisible
  en toutes lettres (« période précédente incomplète (longueurs incompatibles) »).
- **L'acceptation DASH-002 « chaque compteur ouvre une liste cohérente » est vérifiée EN CLIQUANT**,
  ce qu'aucune preuve ne faisait : « 4 à valider » ouvre `/inbox?project=jonlabs&status=proposed`,
  rend **exactement 4** lignes, filtre projet pré-rempli, lot homogène `L3 · moyen (4)`.
- **LE défaut du lot : « à jour » désignait deux choses opposées dans le même encadré.** Le badge
  vient de la fraîcheur de l'**intégration** (`project-cockpit-state.ts`), le caveat orange de la
  complétude de la **donnée** (`gsc-windows-state.ts`). Sur `barberconcept` : **trois « à jour »
  contre un « données pas à jour », à quinze pixels**. Les deux calculs sont justes — c'est le mot
  qui était partagé. → `collecte à jour`. C'est le vice que les deux axes évitent au niveau projet,
  reparu **à l'intérieur d'un panneau**.
- **« Rien à traiter » se lisait à côté de « 4 à valider ».** `buildHeadline` se donne pour règle de
  **nommer toujours l'axe** ; le cas `ok` était le seul verdict nu des cinq, et il portait plus loin
  que ce qu'il mesure — la santé lit la **donnée**, jamais la file de décisions. → « Collecte et
  performance au vert », et l'accueil dit « aucun en alerte » au lieu de « rien à traiter ».
- **Deux tests figeaient une tournure au lieu d'une propriété.** Ils assertent désormais le fond :
  qu'une intégration désactivée **ne ressort pas** l'erreur gardée en mémoire, et qu'un projet sain
  nomme ses axes **sans nier ses 6 findings ouverts**. C'est ce qui rendait le libellé fautif
  intouchable.
- Correctifs mineurs : `Indexation non branché` (la concaténation `${label} non branché` accordait
  au masculin quel que soit le domaine) → `Indexation : aucune intégration déclarée` ; `Parametres`
  → `Paramètres` dans la sidebar projet.
- Vérif : `npm run test` = **908/908** · `npm run check` = **0 err / 42 warn** (baseline) ·
  **`dash-003-project-proof` 25/25 sur Neon**, base rendue à l'identique · non-régression
  `dash-002-home-proof`, `dash-005-inbox-proof`, `find-003-lifecycle-proof`,
  `gsc-004-windows-proof`, `idx-004-lot2-proof` — **0 échec chacune** · **re-parcours visuel** des
  deux écrans corrigés.

**Prochain :** trancher le point produit ci-dessous (`barberconcept` « Sain »), puis **DASH-003
lot 2** (onglets restants — clarifier d'abord lesquels, cf. piège) ou **DASH-006** (vue
automatisations, débloquée).

**Pièges :**
- **⚠️ LE point produit non tranché : `barberconcept` s'affiche « Sain » alors qu'il n'a JAMAIS été
  diagnostiqué.** Son panneau Diagnostic dit « aucune collecte / aucune donnée à ce jour » (état
  `never`), mais l'axe `signal` rend `ok` = « rien à signaler », parce que zéro finding se lit
  « zéro problème ». C'est **exactement** le vice que l'invariant « pipeline cassé ⇒ signal
  `unknown`, jamais `ok` » interdit sur l'autre axe, non couvert ici : *ne pas avoir regardé* n'est
  pas *avoir regardé et rien trouvé*. Et le feature file sait déjà que ce projet écrira **50
  findings** au premier tick — le cockpit annonce donc « Sain » pour le projet qui en a le plus.
  Correction pressentie : un domaine de diagnostic en état `never` force `signal: unknown`.
  **Non appliqué** — décision produit, hors périmètre d'une revue de rendu.
- **Le compteur « avis sans réponse » est grisé sans lien sur `/` mais cliquable sur le cockpit
  projet** (→ `/reviews`). Le même compteur a une liste sur un écran et pas sur l'autre. Conforme
  à la règle DASH-002 (aucune vue **cross-projet** des avis n'existe), mais illisible tel quel.
- **La sidebar et la barre d'onglets donnent DEUX noms à la même page** : « Fenêtres » / « Performance »
  (`/windows`), « Fiche Google » / « Présence locale » (`/gmb-profile`), « Avis Google » / « Avis »
  (`/reviews`). Aligner demande de choisir un vocabulaire — décision, pas correctif.
- **« Content Hub » subsiste** dans la sidebar et sur `/login`, alors que le produit s'appelle
  `seo-stats`.
- **Deux incohérences de doc à rectifier** : `BACKLOG.md` marque **DASH-006 `BLOCKED` sur JOB-007**,
  or JOB-007 est **DONE depuis le 2026-07-22** (donc DASH-006 est jouable) ; et le lot 2 de
  DASH-003 y désigne *Réputation / Analytics / Policies* quand le feature file dit *Mots-clés /
  Rapports / Automatisations*. Deux définitions du même lot.
- **La timeline n'a toujours jamais été vue avec une DÉCISION** : la base porte 0 approbation et les
  4 propositions sont en attente, donc le chemin `decision` (point vert) reste non rendu.
- Inchangé : `npm run build` échoue à l'adaptateur Vercel sous Windows (**préexistant**) · **rien
  n'est déployé**, donc rien ne bat.

**Commit :** `c6c05d5` [hub] fix: le cockpit dit ce qu'il mesure (revue visuelle DASH-002/003)

---

## Etat session 2026-07-25 (DASH-003 lot 1 — le cockpit sait enfin MONTRER un projet)

**Fait :** DASH-003, **lot 1** (vue d'ensemble + timeline + barre d'onglets). Le cockpit savait
collecter, juger et décider ; il ne savait pas **montrer un projet**. `/projects/[slug]` était
encore le calendrier de contenus du Content Hub — que la sidebar libellait déjà « Vue d'ensemble »,
ce qui était faux. Conséquence : `indexing-read.ts` et `index_selection` n'avaient **aucun
lecteur** (piège daté depuis IDX-002), et aucune décision passée n'était consultable au niveau
projet. **Zéro DDL.**

- **LE point du lot : la carte de santé n'est PAS recalculée ici.** Elle vient de
  `loadHomeCockpit` et est retrouvée par slug. Recalculer les six domaines aurait créé **deux
  définitions de « projet à risque »** qui divergeraient au premier seuil modifié — et personne
  ne saurait laquelle croire. **Prouvé par égalité de `JSON.stringify` champ par champ** contre
  la carte de l'accueil, même fenêtre. Le coût est nul : les requêtes de l'accueil sont **déjà
  groupées par projet**, donc les refiltrer ne ferait rien gagner.
- **« Non branché » n'est pas « cassé », et l'ordre des règles EST la décision.** Une intégration
  **désactivée** rend `inactive` **quoi qu'elle porte par ailleurs** — elle peut garder un
  `last_error_code` d'il y a trois mois, et le peindre en rouge reprocherait à Jonathan une panne
  qu'il a lui-même débranchée. La contre-épreuve mesure la différence : **la même intégration,
  activée, rend `broken`** avec son code, et fait passer le projet en collecte cassée.
- **`hasData` prime sur l'absence de ligne d'intégration.** Un projet peut collecter sans ligne
  `project_integrations` (compte de service partagé, flux hérité) : annoncer « non branché » alors
  que la table déborde d'observations serait un mensonge **vérifiable sur l'écran d'à côté**.
- **Un domaine INTERNE ne peut pas être « non branché »** (`external: false`). Le diagnostic relit
  des observations déjà payées : il n'a pas de credential, et lui répondre « non branché »
  enverrait vers une page de réglages qui ne propose rien. Trouvé en lisant la sortie de la
  preuve, pas en écrivant le code.
- **Le trio période/fraîcheur/source est porté par le TYPE, pas par le template.** `buildPanel`
  exige `ProvenanceTrio` : un panneau **ne peut pas exister** sans dire d'où il sort. Et la
  période est celle **réellement couverte** par la donnée — un domaine sans donnée porte
  `period: null`, jamais une plage qui se lirait « on a regardé ces 28 jours et tout va bien ».
- **La timeline lit les décisions dans `action_proposals`, et c'est le seul choix correct.** Les
  lire dans `proposal_approvals` **manquerait tous les rejets** (un rejet ne produit aucune
  approbation) ; les lire dans `finding_events` manquerait les décisions sur une proposition
  **sans finding** — `proposals.ts` n'écrit son événement que `if (p.findingId)`. La preuve monte
  exactement cette scène : une proposition rejetée **sans finding**, **0 ligne** de journal, et
  elle apparaît quand même dans la timeline avec son niveau d'autorisation.
- **Le calendrier de contenus a DÉMÉNAGÉ, il n'a pas été réécrit** (`git mv`, `R100`) vers
  `[slug]/content`, avec son entrée propre dans la sidebar. Miroir de DASH-002 sur `/` : le legacy
  passe sous ce qui décide, aucune route supprimée. Toute « amélioration au passage » aurait rendu
  une régression invisible.
- **La barre d'onglets ne montre que ce qui existe.** Les onglets SPEC §13.2 sans read-model
  (Mots-clés, Rapports) ne sont **pas** affichés grisés : un onglet mort apprend à ne plus cliquer
  et fait passer pour cassé ce qui n'est simplement pas encore écrit.
- Vérif : `npm run test` = **908/908** (+19) · `npm run check` = **0 err / 42 warn** (baseline) ·
  **`scripts/dash-003-project-proof.ts` = 25/25 vertes sur Neon**, base rendue à l'identique
  (6 intégrations, 4 propositions, 0 approbations, 13 findings, 17 events avant comme après) ·
  **zéro appel réseau** · non-régression : `dash-002-home-proof`, `dash-005-inbox-proof`,
  `find-003-lifecycle-proof`, `gsc-004-windows-proof`, `idx-004-lot2-proof` — **0 échec chacune**.

**Acceptations DASH-003.** (1) « chaque métrique affiche période, fraîcheur et source » : le trio
est dans le type, vérifié sur **tous** les panneaux rendus, et aucun ne porte « 0 h » là où rien
n'a été collecté ; (2) « un provider désactivé n'est pas présenté comme une erreur » : `inactive`
avec contre-épreuve `broken` sur la **même** intégration ; (3) « les décisions passées sont
accessibles depuis la timeline » : y compris le cas sans finding, avec motif et niveau
d'autorisation.

**Prochain :** **DASH-003 lot 2** — les onglets restants (Mots-clés, Rapports, Automatisations),
qui demandent d'abord leurs read-models. Ou **DASH-006** (vue automatisations), qui donnerait
enfin sa liste au compteur `runs_period` (muet depuis DASH-002).

**Pièges :**
- **⚠️ Le cockpit n'a JAMAIS été vu à l'œil** (pas de session admin dans cette session de
  travail) — comme DASH-002 avant lui. Tout est prouvé côté données, **rien n'est prouvé côté
  rendu**.
- **La carte de santé ne se recalcule pas dans `project-cockpit.ts`.** Le jour où quelqu'un
  « optimise » en requêtant le projet seul, l'invariant anti-divergence tombe — et la preuve A
  est là pour le rattraper.
- **`index_selection` est optimiste** : `dueNow` vient de `loadDueSelections` (qui a déjà joint
  `index_observations`), jamais d'un `count(*)` sur la table.
- **`excluded` est hors du dénominateur de couverture** : un `noindex` est une décision du site,
  pas un échec. L'inclure ferait baisser le taux à chaque page volontairement désindexée.
- Le seuil de fraîcheur d'indexation est à **15 j** (et non 10 comme GSC) : l'inspection est une
  **sélection**, une page peut légitimement n'être revue que tous les 14 j (`sampleIntervalDays`).

**Commit :** `8a84e41` [hub] add: DASH-003 lot 1, cockpit projet et timeline des décisions

---

## Etat session 2026-07-25 (IDX-004 lot 2 — une page publiée cesse d'attendre le lundi)

**Fait :** IDX-004, **lot 2**, ce qui ferme IDX-004. Le lot 1 avait posé le registre des décisions
et son canal réservé `scope: 'due'` — mais **aucun producteur** : `post_publish` et `manual`
étaient déclarés dans le vocabulaire fermé sans que rien n'écrive une ligne, et le catalogue
quotidien ne contenait que `findings:lifecycle`. Un article publié le mardi n'était donc jamais
vérifié à J+3 : au mieux l'échantillon tournant finissait par le prendre. **Zéro DDL** — le lot
n'ajoute que des producteurs (**59 tables**, inchangé).

- **Trois rendez-vous, pas trois fois la même dépense.** `postPublishSelections` **ne passe pas
  par `allocate`**, et c'est structurel : `dedupeCandidates` fusionne par URL, donc les trois
  échéances d'une même page y deviendraient une seule ligne. La règle « une URL, un slot » vaut
  pour **une journée** — deux raisons le même jour, c'est une mesure et un appel. Trois dates
  futures sont trois rendez-vous, et c'est la clé `(url_normalized, due_date)` qui les sépare.
  Prouvé dans les deux sens : `dedupeCandidates` n'en garde **1**, la base en porte **3**.
- **L'idempotence vit dans les DATES, et c'est ce qui répare la republication.** Rejouer la même
  publication n'écrit rien (`count(*)` 3 → 3) ; **republier** (un `publishedAt` plus récent) pose
  bien trois nouvelles échéances (3 → 6). C'est exactement ce que la clé de `schedulePostPublish`
  (`` `${contentId}:J+${offsetDays}` ``, **sans `publishedAt`**) ne sait pas faire — le défaut
  réveillé au lot 1, et l'argument qui avait fait rejeter son réemploi. Elle n'est **pas
  touchée** : `post_publish:check` reste sans handler.
- **Le déclencheur ignore `autoSubmitOnPublish` — délibérément.** Ce drapeau gouverne la
  *soumission* à l'Indexing API. Ne pas vouloir pousser une URL à Google ne veut pas dire ne pas
  vouloir **savoir** si elle est indexée : c'est souvent l'inverse, et c'est le même raisonnement
  qui avait écarté `exclude_patterns` de la sélection au lot 1. La garde qui reste est le **type**
  (`article`) : un post GMB ou LinkedIn paierait du quota pour une URL qui n'existe pas.
- **Un seul `publishedAt` pour la ligne et pour les échéances.** La route calculait déjà sa date ;
  un second `new Date()` plus bas les aurait fait diverger d'un jour à la frontière d'UTC, et la
  jointure « honorée » (`observed_date >= due_date`) serait devenue fausse **pour toujours**.
  L'appel est `await` (écriture locale, sans réseau — la laisser filer masquerait une erreur de
  base) mais **sous garde** : planifier est le corollaire de publier, jamais sa condition.
- **La cadence quotidienne n'a AUCUN prérequis, et c'est un choix de fond.** Le canal `due` ne lit
  ni l'inventaire sitemap ni les clics (`collectCandidates` sort avant). Lui donner les prérequis
  optionnels de l'hebdo par symétrie l'aurait fait **attendre un tick** derrière un
  `collect:sitemap` lent, pour une passe qui n'en tire rien. L'arête vers le détecteur, elle,
  reste **obligatoire** : un « toujours pas indexé à J+3 » devient un finding le jour même au lieu
  d'attendre le lundi — sinon la moitié de la valeur du J+3 se perdait en salle d'attente.
- **L'audit manuel est borné par le même budget que la politique.** `selectManualUrls` repasse par
  `resolveBudget` (plafond projet, pool cross-projet, `jobCap`, `MAX_URLS_PER_JOB`) : coller 500
  URLs dans un terminal ne peut pas vider le pool des six projets, et donc pas envoyer les
  échéances du lendemain dans un `pool_exhausted` que personne n'aurait décidé. L'**ordre d'entrée
  est conservé** (pas de tri) : ce qui est coupé est le bas de la liste que l'humain a écrite.
- **⚠️ Le CLI est en dry-run par DÉFAUT — l'inverse du reste de l'outillage.** Les autres runners
  écrivent en base ; celui-ci dépense un quota externe payant. L'oubli d'un drapeau doit coûter
  zéro appel, pas quarante. `--execute` pour écrire et inspecter.
- Vérif : `npm run test` = **889/889** (+14 : 11 producteurs purs + 3 catalogue) · `npm run check`
  = **0 err / 42 warn** (baseline) · **`scripts/idx-004-lot2-proof.ts` = 25/25 vertes sur Neon**,
  base rendue à l'identique (**0 sélection, 0 index_obs, 0 sitemap_obs, 0 réglage** avant comme
  après) · **zéro appel Google, zéro quota consommé** · CLI en dry-run lancé pour de vrai
  (fusion du fragment, URL relative écartée, budget annoncé, **rien écrit**) · non-régression :
  `idx-004-selection-proof`, `idx-005-transition-proof`, `idx-002-inspection-proof --skip-real`,
  `idx-001-sitemap-proof`, `job-004-dag-proof`, `job-005-schedule-proof`, `job-006-limits-proof`
  — **0 échec chacune**.

**Acceptations IDX-004 — les deux dernières puces de travail sont closes.** « planifier J+3, J+7 et
J+28 » : `scheduleIndexChecks` appelée par la route de publication, prouvé qu'au jour J+3 la passe
quotidienne rend **une** URL et pas trois, et que les deux autres restent dues **intactes**.
« permettre un audit manuel borné » : `scripts/inspect-urls.ts`, dry-run par défaut, coupé au
budget projet (120 URLs → 40, `--limit=5` → 5, `0` → 0) et **jamais** au-delà.

**Prochain :** **DASH-003** (cockpit projet) — c'est le seul écran qui lira `indexing-read.ts` et
`index_selection`, aujourd'hui invisibles. Toujours bloqué par DASH-001 seul.

**Pièges :**
- **Le CLI est en dry-run par défaut**, contrairement à `detect-index.ts` et consorts qui écrivent
  sauf `--dry-run`. Ne pas « corriger » cette asymétrie : elle protège un quota payant.
- **`postPublishSelections` ne doit JAMAIS passer par `allocate`.** Le jour où quelqu'un
  l'uniformise avec les autres producteurs, deux échéances sur trois disparaissent en silence.
- **La cadence quotidienne est en profondeur 2** : un skip de l'inspection y saute la détection au
  tour à vide suivant, comme sur les autres branches.
- **Une échéance non honorée reste due jusqu'à `maxAgeDays`** (14 j par défaut), puis elle est
  **abandonnée et comptée** (`expired`). Un J+28 posé sur une page morte ne s'accumule pas.
- Inchangé depuis le lot 1 : `0` = ZÉRO dans `index-selection-state.ts` · `index_selection` est
  **optimiste** (une ligne est une intention) · au 1ᵉʳ tick hebdo, `barberconcept` écrira ses 50
  findings (décision prise : laisser partir) · `npm run build` échoue à l'adaptateur Vercel sous
  Windows (**préexistant**) · aucun écran ne lit `indexing-read.ts` ni `index_selection`
  (DASH-003) · **rien ne bat tant que ce n'est pas déployé**.

**Commit :** `fd84470` [hub] add: IDX-004 lot 2, échéances post-publication et audit manuel borné

---

## Etat session 2026-07-25 (IDX-004 lot 1 — le quota cesse d'être dépensé sans que personne l'ait décidé)

**Fait :** IDX-004, **lot 1 (noyau)**. IDX-002 savait inspecter et IDX-005 savait juger, mais
**personne ne choisissait les URLs** : `index_observations` était à **0 ligne**, donc IDX-005
entièrement inerte, et les deux types de job restaient hors catalogue. Ce lot ferme la branche
d'indexation du graphe hebdo. **Un DDL additif** (`index_selection`, table **vide** à la
création) : 58 → **59 tables `seostats`**, l'écart étant exactement celle-là.

- **Deux acceptations sur trois sont INDÉRIVABLES, et c'est ce qui justifie la table.** « Chaque
  sélection expose sa raison » : la raison est fonction de l'état **au moment du choix** (diff
  sitemap, findings actifs, clics 28 j) — rejouer la politique une semaine plus tard rend une
  autre raison, et « nouvelle page » n'est vrai qu'une fois. « Une inspection manquée est
  replanifiée sans duplication » : « manquée » veut dire **sélectionnée mais non observée**, et
  sans trace de l'intention une URL dont le quota a été payé sans rien produire (429 au 3ᵉ appel,
  bail perdu, réponse illisible) est **totalement invisible**. La 1ʳᵉ, elle, est bien une fonction
  pure — elle vit dans le module et rien d'autre.
- **La table stocke la DÉCISION, jamais le résultat.** Aucune colonne `status` : ce serait un
  second état persistant dont personne n'est propriétaire du retour (motif du `health_status`
  rejeté par JOB-006). Honorée se **dérive** : `∃ index_observations(projet, url = url_normalized,
  observed_date >= due_date)`. Le `>=` porte toute la sémantique J+N — **prouvé** : une inspection
  à J+4 n'honore pas une échéance J+7, une à J+7 l'honore.
- **LE point du lot : la sélection est persistée AVANT que la collecte parte.** C'est l'inverse de
  l'intuition et c'est délibéré — un 429 au 3ᵉ appel sur 10 laisse alors **7 intentions dues**,
  reprises au run suivant **sans écrire une seule ligne de plus** (`count(*)` 10 → 10). **Et la
  contre-épreuve MESURE le faux signal** : la même scène avec les intentions effacées (l'état
  qu'aurait laissé un code persistant *après*) rend **0 échéance due** — les 7 URLs payées
  deviennent invisibles, et la reprise ne les retrouve que **par hasard**, via l'échantillon.
- **« Réserver du quota aux vérifications urgentes » est un ORDRE et un CANAL, pas un
  pourcentage.** J'ai commencé par un `urgentReservePct` et je l'ai **supprimé** : l'urgent étant
  servi en premier et sans plafond propre, un pourcentage ne peut que **dégrader** une garantie
  déjà totale, et il ajoute un réglage qu'on peut mettre à zéro. Restent trois mécaniques
  structurelles : l'ordre des familles, le canal `scope: 'due'` (que la configuration ne peut pas
  désarmer), et `poolUrgentReserve` — **cross-projet**, pour que le projet qui tire le lundi ne
  prive pas les cinq autres. Prouvé : à pool presque plein, `full` obtient **0** et le **dit**
  (`urgent_reserve`), `due` obtient son échéance.
- **La garde d'échantillon n'est pas désactivable par réglage.** `samplePctMax` est clampé à
  `MAX_SAMPLE_PCT = 60`, donc `floor(budget × pct/100) < budget` pour tout budget ≥ 1 : l'échantillon
  ne peut **jamais** prendre le dernier slot. Mesuré **en SQL sur `bucket`**, pas sur la valeur de
  retour : 200 candidats, budget 40 → **16 lignes**, et un réglage forgé à **100 % rend 24, pas 40**.
- **⚠️ `0` veut dire ZÉRO ici, l'inverse de `job-limits.ts`** (où `0` = pas de limite). JOB-006
  gouverne une concurrence interne ; ici les plafonds gouvernent un **quota externe payant**, et
  lire `0` comme « illimité » brûlerait le pool en un job. Une valeur illisible ou négative retombe
  au défaut ; `0` est **valide** et veut dire « aucune inspection ».
- **Le pool consommé est une BORNE INFÉRIEURE, pas une mesure.** `count(index_observations WHERE
  observed_date = today)` ne compte ni les appels échoués, ni les réponses illisibles (qui
  n'écrivent rien par construction, IDX-002), ni ceux du skill `/seo-index-diagnose` et de la route
  legacy `seo-data` — qui tapent le **même** service account. D'où `dailyPoolTotal = 800` et non
  2 000 : la marge absorbe le sous-comptage. Le libellé est « au plus N », jamais « il reste N ».
- **La sélection se calcule à l'EXÉCUTION, pas au plan.** `scheduler.ts:341` fait
  `JSON.stringify(entry.payload)` : le catalogue est un **littéral**. Et une sélection calculée au
  plan le serait **avant** que `collect:sitemap` du même run ait écrit l'inventaire du jour — donc
  avec `new`/`changed` structurellement vides. Le payload porte une **intention**
  (`{ mode: 'policy', scope: 'full' }`), 40 octets.
- **La non-régression IDX-002 est portée par le DÉFAUT, pas par une condition.** `mode` absent ⇒
  `explicit` ⇒ le chemin d'avant, mot pour mot. Prouvé : un payload sans `mode` n'écrit **aucune**
  ligne de sélection.
- **Un seul `now` pour la sélection ET la collecte.** `collectUrlInspection` acceptait déjà `now`
  mais le handler ne le passait pas : un job démarré à 23:59:58 UTC aurait inscrit sa sélection au
  jour J et son observation au jour J+1, et la jointure « honorée » aurait été fausse **pour
  toujours**.
- **La forme envoyée à Google est la forme NORMALISÉE.** Sans ça, `…/page` (sitemap) et
  `…/page#top` (GSC) paieraient deux slots pour une page et produiraient **deux séries de longueur
  1**, trop courtes pour que `confirmTransition` (IDX-005) conclue jamais. La table est à 0 ligne :
  c'était maintenant ou jamais.
- **Les prérequis de l'inspection sont OPTIONNELS, celui du détecteur est OBLIGATOIRE.** Un sitemap
  404 ou un 429 Search Analytics ne doit pas priver le projet de l'inspection de ses findings et de
  ses échéances ; en revanche détecter sur une inspection périmée est le bug exact que GSC-002 a
  fermé côté Search Analytics. Le test IDX-001 « ne dépend de rien et ne bloque rien » a été
  **réécrit, pas supprimé** : l'invariant qui survit est « aucune dépendance entrante » **et** « son
  seul dépendant l'a déclaré optionnel ».
- **`strategicPages` n'est PAS redéclarée** : le sélecteur lit `decideStrategic` + `loadClicksByUrl`
  + `loadProjectTransitionOverrides`, les **mêmes** qu'IDX-005. Sinon une page serait « stratégique
  pour le détecteur » sans l'être « pour le sélecteur », et on protégerait une page qu'on
  n'inspecte jamais.
- **`indexing_credentials.exclude_patterns` n'est PAS réutilisé** : il gouverne la *soumission*
  Indexing API. Exclure une page de la soumission ne veut pas dire qu'on ne veut pas *savoir* si
  elle est indexée — souvent l'inverse.
- Vérif : `npm run test` = **875/875** (+66 : 59 `index-selection-state` + 4 rétention + 3
  catalogue) · `npm run check` = **0 err / 42 warn** (baseline) · **DDL appliqué sur Neon**
  (1 table + 3 index, 13/13 colonnes, **0 ligne** à la création), **réappliqué** = idempotent ·
  introspection = **59 tables `seostats`**, écart = cette table et rien d'autre ·
  **`scripts/idx-004-selection-proof.ts` = 42/42 vertes sur Neon**, **rejouée**, base rendue à
  l'identique (**0 sélection, 0 index_obs, 0 sitemap_obs, 13 findings, 17 events, 0 réglage** avant
  comme après) · **zéro appel Google, zéro quota consommé** · non-régression :
  `idx-005-transition-proof`, `idx-002-inspection-proof --skip-real`, `idx-001-sitemap-proof`,
  `job-006-limits-proof`, `job-004-dag-proof`, `dash-002-home-proof`, `dash-005-inbox-proof`,
  `gsc-004-windows-proof` — **0 échec chacune**.

**Acceptations couvertes.** (1) « le quota ne peut pas être consommé entièrement par
l'échantillon » : 200 candidats d'échantillon et un budget de 40 → **16 lignes `bucket='sample'`
en base**, jamais 40 ; un réglage forgé à 100 % rend **24** ; le plafond atteint se dit
(`sample_capped`) ; (2) « chaque sélection expose sa raison » : chaque ligne porte une raison du
**vocabulaire fermé** et le détail qui la **prouve** — `finding` cite son `findingId`, `new` cite
le snapshot d'origine, `changed` cite le `lastmod` **avant et après**, `sample` cite la dernière
observation ; (3) « une inspection manquée est replanifiée sans duplication » : collecte
interrompue après 3/10 → **7 dues, exactement les 7 non observées**, reprises au run suivant avec
`count(*)` **inchangé**, et les 3 honorées ne reviennent pas.

**Prochain :** **IDX-004 lot 2** — cadence quotidienne `scope: 'due'`, `scheduleIndexChecks`
appelé depuis la route de publication (J+3/J+7/J+28), CLI d'audit borné `scripts/inspect-urls.ts`.
Puis **DASH-003** (cockpit projet), toujours bloqué par DASH-001 seul.

**Pièges :**
- **`0` = ZÉRO dans `index-selection-state.ts`, `0` = illimité dans `job-limits.ts`.** Copier
  l'idiome `budget > 0 && used >= budget` de JOB-006 ferait d'un budget à 0 un budget **infini**.
- **`index_selection` est OPTIMISTE** : une ligne est une **intention**, jamais une preuve
  d'inspection. Tout comptage de fait passe par la jointure à `index_observations`. Lire la table
  seule pour compter « pages inspectées cette semaine » compterait des intentions.
- **Un prérequis OPTIONNEL fait quand même ATTENDRE** (`classifyDependencyGate` retient tant qu'il
  est `queued`/`running`). Un `collect:sitemap` lent **décale** l'inspection d'un tick, il ne
  l'annule pas. Ne pas diagnostiquer ça comme « le job ne part pas ».
- **La branche d'indexation passe à la PROFONDEUR 3** — la propagation d'un `skip` y prend un tick
  de plus, comme sur la branche GSC.
- **`collect:url_inspection` réussit à zéro URL**, donc l'arête obligatoire garantit **l'ordre, pas
  la fraîcheur**. Ce n'est pas un bug (IDX-005 borne sa portée aux URLs réellement observées) mais
  ne pas la lire comme « le détecteur ne voit jamais du périmé ».
- **`DELAY_MS = 150` pèse sur le budget de drain** : 6 projets × 40 URLs = 36 s de pause pure dans
  un `DRAIN_BUDGET_MS` de 240 s. C'est la raison du défaut prudent ; monter
  `dailyBudgetPerProject` à 200 approcherait le plafond.
- **Une preuve interrompue saute son `finally`** : vérifier alors les `due_date`/`observed_date`
  **2018-11-%** de `index_selection`, `index_observations` et `sitemap_url_observations`, les
  findings/`finding_events` dont `entity_key` commence par `https://sentinelle-idx004.test`
  (**enfants d'abord**), **et la clé `indexing.selection` de `system_settings`** (la preuve la
  sauvegarde et la restaure).
- **`strategic` n'est pas couvert par la preuve Neon** (il demande des clics GSC réels ou une
  déclaration projet), `manual`/`post_publish` non plus (pas de producteur avant le lot 2). Le
  runner le **dit** plutôt que de laisser croire à une couverture complète.
- Réveillé, **non corrigé** : `schedulePostPublish` ne peut pas reprogrammer une republication (sa
  clé d'idempotence est `` `${contentId}:J+${offsetDays}` ``, **sans `publishedAt`**, alors que son
  commentaire affirme le contraire) — c'est l'argument décisif qui a fait rejeter le réemploi de
  `post_publish:check` · `providerWindowBudget` compte des **jobs**, pas des appels (dette JOB-006
  confirmée, justification renforcée dans l'en-tête).
- **Au 1er tick hebdo, `barberconcept` écrira ses 50 findings — décision de Jonathan : laisser
  partir.** Le point cesse d'être « en attente » et devient une note d'exploitation.
- Toujours en suspens hors IDX-004 : purge destructive (DATA-008 `--execute`) · **CONTRACT différé**
  · double écriture legacy GSC (meurt avec GSC-003) · `gsc-002` non rejoué (quota) · `indexing.ts`
  reste dette datée · aucun écran ne lit `indexing-read.ts` **ni `index_selection`** (DASH-003) ·
  `npm run build` échoue à l'adaptateur Vercel sous Windows (**préexistant**) · **rien ne bat tant
  que ce n'est pas déployé**.

**Commit :** `48511b1` [hub] add: IDX-004 lot 1, politique de sélection et quotas d'inspection

---

## Etat session 2026-07-25 (IDX-005 — « je ne l'ai pas regardée » cesse de se lire « elle est guérie »)

**Fait :** IDX-005, enchaîné à IDX-002. `index_observations` portait des états depuis IDX-002, et
**rien ne les comparait dans le temps** : une page passée d'`indexed` à `not indexed` ne produisait
aucun finding — la douleur jokiSEO d'origine, celle pour laquelle tout le canon d'observations existe.
**Zéro DDL** : `findings` portait déjà `consecutive_misses`, `evidence_json`, `confidence_score` ;
la confirmation se **dérive** de la série à chaque run. **58 tables `seostats`**, `schema.ts` intact
(`git status` vide), introspection à l'appui.

- **LE piège du lot, et il vient de la nature même de l'inspection : ce détecteur n'est PAS
  autoritaire sur son projet.** `reconcileDetectionRun` balayait tous les findings d'un type et
  traitait toute absence de la closure comme une absence de signal — juste pour GSC, où chaque
  requête est réobservée chaque semaine. Ici l'inspection coûte du quota et ne couvre qu'une
  **sélection** d'URLs (IDX-004) : une page simplement non ré-inspectée serait absente de la closure
  et **auto-résolue en deux runs**, alors que rien ne prouve qu'elle est réparée. D'où le champ
  optionnel **`scope`** — hors portée, le finding est laissé **strictement intact**,
  `consecutive_misses` compris (l'incrémenter compterait un manque de mesure comme une preuve de
  guérison). Compteur **`outOfScope`** distinct de `held` : confondre les deux ferait lire « maintenu
  par décision » là où personne n'a rien décidé. Sans le champ, comportement **inchangé** —
  `keyword-opportunity.ts` n'est pas touché.
- **Et la contre-épreuve MESURE le faux signal**, elle ne l'invoque pas : la même scène rejouée
  **sans** `scope` fait passer une page jamais ré-inspectée de `open` à **`resolved`**. C'est
  exactement ce que la garde empêche d'écrire.
- **`unknown` n'est PAS un état** — la doctrine d'IDX-002 portée à la série temporelle. Une
  inspection illisible ne rompt pas un streak de `not_indexed` **et** ne le confirme pas. Sans la
  première moitié, une seule erreur de lecture repousserait indéfiniment la confirmation d'une vraie
  désindexation ; sans la seconde, un trou vaudrait preuve. Elle baisse la confiance, c'est tout.
- **`excluded` n'est pas `not_indexed`, et `indexed → excluded` n'est PAS une désindexation.**
  « Excluded by 'noindex' tag » est une décision du site qu'on respecte : aucun finding. C'est
  précisément pour ce détecteur qu'IDX-002 avait séparé les deux classes — la distinction cesse ici
  d'être théorique.
- **Une transition stable ne parle QU'UNE fois.** Le fingerprint est `(type, page, url)` : ni date,
  ni compteur, ni statut de confirmation. Trois runs sur la même désindexation → **1 finding, 1 seul
  `created`**, `occurrence_count` à 3. Le titre est stable pour la même raison (il est réécrit à
  chaque upsert : y glisser une valeur mouvante ferait bouger la ligne d'inbox chaque semaine pour un
  problème qui, lui, n'a pas bougé).
- **Une fluctuation isolée est ÉCRITE, pas cachée — mais plafonnée.** Une bascule unique donne
  `pending` : confiance 40, sévérité **plafonnée à `medium` même sur page stratégique**, et
  **jamais notifiable**. La 2ᵉ observation consécutive confirme : confiance 90, sévérité `critical`,
  `aggravated` journalisé, **même finding**. Taire le fait aurait été l'autre erreur.
- **« Page stratégique » est DÉRIVÉE (clics GSC) et surchargeable, jamais devinée.** Un projet sans
  donnée ni déclaration n'a **aucune** page stratégique — état à part, jamais « toutes » : le défaut
  permissif ferait de chaque désindexation une urgence critique, et l'alerte qui crie toujours n'est
  plus lue. Les deux côtés passent par `normalizeUrl` (IDX-001), sinon la déclaration ne rejoindrait
  jamais la mesure.
- **Le SIGNAL, pas le canal (décision de Jonathan).** §14.3 veut notifier une désindexation
  confirmée de page stratégique ; **TEL-002 est BLOCKED**. Câbler `sendCriticalError` ici aurait
  installé un second chemin de notification, avec sa propre déduplication, à défaire au branchement
  du vrai canal. Le drapeau `notifyImmediately` vit dans les preuves : interrogeable en base, le
  canal viendra le lire.
- **Trois types, une réconciliation PAR type.** `index_drop` (tombée d'`indexed`, quelle que soit la
  nuance de coverage — c'est la perte qui compte), `crawled_not_indexed`, `discovered_not_indexed`.
  Mélanger les closures ferait passer pour absente une page dont le problème a simplement **changé de
  nature**. Un `not_indexed` de nature `other` jamais indexé (404, « unknown to Google ») ne reçoit
  **aucun** type : §10.4 ne lui en donne pas, on n'en invente pas.
- Vérif : `npm run test` = **809/809** (+43 : 42 `index-transition-state` + 1 `job-limits`) ·
  `npm run check` = **0 err / 42 warn** (baseline) · **aucun DDL**, `schema.ts` inchangé,
  introspection **58 tables `seostats`** (+1 `core`) · **`scripts/idx-005-transition-proof.ts` =
  31/31 vertes sur Neon**, **rejouée 3×**, base rendue à l'identique (**13 findings, 17 events, 0
  index_obs** avant comme après) · non-régression : `idx-002-inspection-proof --skip-real`,
  `idx-001-sitemap-proof`, `find-003-lifecycle-proof`, `dash-005-inbox-proof`,
  `agt-000-proposer-proof`, `job-006-limits-proof`, `job-004-dag-proof`, `dash-002-home-proof`,
  `gsc-004-windows-proof` — **0 échec chacune**.

**Acceptations couvertes.** (1) « une transition stable crée un événement unique » : 3 runs sur la
même désindexation → **1 finding**, **1 seul `created`** au journal, `occurrence_count` à 3, et le
fingerprint persisté vaut exactement `(type, page, url)` ; (2) « une fluctuation isolée baisse la
confiance ou attend confirmation » : bascule unique → `pending`, confiance **40**, sévérité plafonnée
à `medium` malgré une page stratégique, **0 notifiable** ; confirmation arrivée → confiance **90**,
`critical`, `aggravated` — **le même finding** ; (3) « la résolution conserve l'historique complet » :
1re absence **constatée** comptée (`consecutive_misses = 1`, jamais résolue d'un coup), 2ᵉ →
auto-résolue et journalisée, puis récidive → **`reopened` du même finding** avec la chaîne
`created → resolved → reopened` intacte ; et l'absence **non constatée** ne produit rien du tout.

**Prochain :** **IDX-004** (sélection/quotas d'inspection) — c'est lui qui rend ce détecteur vivant,
et c'est lui qui posera l'arête **obligatoire** `collect:url_inspection → detect:index_transition` au
catalogue hebdo. Puis **DASH-003** (cockpit projet, désormais débloqué côté IDX-005).

**Pièges :**
- **`index_observations` est à ZÉRO ligne** (la preuve IDX-002 a nettoyé son inspection réelle dans
  son `finally`). Le détecteur est donc **entièrement inerte en production** — piège AGT-000 assumé,
  **nommé et daté**, avec un consommateur identifié : IDX-004. Le runner le **dit**
  (`aucune observation d'indexation sur la fenêtre`) au lieu de se taire.
- **`detect:index_transition` n'est PAS au catalogue hebdo**, même raison que `collect:url_inspection`.
  Ne pas l'y ajouter seul : sans arête vers l'inspection, il détecterait sur des états périmés — le
  bug exact que GSC-002 a fermé côté Search Analytics.
- **Ne JAMAIS retirer le `scope` d'un détecteur à couverture partielle.** C'est la seule chose qui
  empêche « je ne l'ai pas regardée » de se lire « elle est guérie ». La contre-épreuve C-bis existe
  pour que ce ne soit pas un argument mais une mesure.
- **`outOfScope` vaudra à peu près tout le stock tant qu'IDX-004 n'existe pas.** C'est journalisé par
  le handler et affiché par le runner : un run qui n'a rien pu juger ne doit pas se lire comme un run
  qui n'a rien trouvé.
- **Ne pas « corriger » le silence sur `not_indexed` de nature `other`.** Lui coller un type serait
  inventer un diagnostic que §10.4 ne donne pas.
- **La sévérité `critical` est RÉSERVÉE** au cas notifiable §14.3 (drop confirmé + stratégique).
  L'ouvrir plus largement viderait la notification de son sens avant même que TEL-002 existe.
- **Une preuve interrompue saute son `cleanup()`** : vérifier les `observed_date` **2018-11-%** de
  `index_observations`, et les findings/`finding_events` dont `entity_key` commence par
  `https://sentinelle-idx005.test` (**enfants d'abord**).
- Toujours en suspens hors IDX-005 : purge destructive (DATA-008 `--execute`) · **CONTRACT différé** ·
  double écriture legacy GSC (meurt avec GSC-003) · `gsc-002` non rejoué (quota) · `indexing.ts`
  reste dette datée · aucun écran ne lit `indexing-read.ts` (DASH-003) · `npm run build` échoue à
  l'adaptateur Vercel sous Windows (**préexistant**) · **rien ne bat tant que ce n'est pas déployé** ·
  au 1er tick hebdo, `barberconcept` écrira ses **50 findings**.

**Commit :** `81cd5a2` [hub] add: IDX-005 détecteur de transitions d'indexation, une absence de mesure n'est pas une guérison

---

## Etat session 2026-07-25 (IDX-002 — l'inspection cesse de confondre « credential mort » et « page inconnue de Google »)

**Fait :** IDX-002, enchaîné à IDX-001. `indexing.ts:batchInspect` inspectait déjà des URLs — et
n'en gardait **rien** : des tableaux en mémoire, consommés par une route puis jetés. Le statut
d'indexation d'une page n'existait donc que le temps d'un appel, ce qui interdisait **les trois
acceptations à la fois** : un historique, un rerun non destructeur, et un écran qui lise la base.
**Zéro DDL** : `index_observations` avait déjà les 7 colonnes exactes depuis DATA-004, et
`upsertIndexObservation` était déjà écrit — **58 tables `seostats`** (+1 `core`), `schema.ts`
non modifié depuis IDX-001.

- **LE bug de fond du legacy : une erreur provider se lisait comme un résultat.** Un credential
  mort rendait `{ verdict: null, coverageState: null, httpStatus: 0, error: '…' }`, que
  `classifyIndexStatus` classait `unknown` — **exactement comme une page réellement inconnue de
  Google**. Deux situations qui demandent des gestes opposés (réparer l'auth vs travailler la
  page) étaient indistinguables. Ici la distinction est portée par un **type** : `InspectionOutcome`
  est une union discriminée dont les deux branches ne partagent aucun champ exploitable. Prouvé en
  base : 7 tentatives en erreur → **0 observation** et l'URL **absente** ; une page vraiment non
  indexée → **1 ligne, classée `not_indexed`**.
- **Il jetait aussi une CHAÎNE, donc la file classait au petit bonheur.** `classifyJobFailure`
  cherche `status`/`reason` sur l'objet : sur une chaîne il ne trouve rien, et un quota mal classé
  part en **dead-letter permanente**. `urlInspection` passe par `toGscApiError` — déjà écrit pour
  GSC-002 — donc les erreurs sont structurées **gratuitement**. Les **7 cas** sont prouvés, dont
  les deux que Google fait à l'envers : **403 `rateLimitExceeded` → `quota`** (pas `permanent`) et
  **400 `invalid_grant` → `auth`**.
- **Et il jetait les 5/7 des champs.** Seuls `verdict` et `coverageState` survivaient, alors que
  la table a des colonnes pour `indexingState`, `robotsState`, les **deux** canonicals et
  `lastCrawlTime` depuis DATA-004. Le reste de SPEC §9.2 (`pageFetchState`, `crawledAs`,
  `sitemap`, `referringUrls`, mobile usability, rich results) va dans le **payload borné**.
- **Un `referringUrls` géant ne doit pas faire échouer sa propre collecte.** Le payload
  d'observation **jette** au-delà de 32 Ko : une page très maillée se serait donc auto-sabotée.
  Les listes sont plafonnées à 50 entrées **et la troncature est dite** (`payload.truncated`).
  Mesuré : 400 entrées → 50 gardées, payload à **2 255 octets**.
- **L'écriture est INCRÉMENTALE ici, et c'est l'inverse de GSC-002 — délibérément.** Là-bas rien
  n'est écrit avant la fin de la pagination, parce qu'une semaine partielle se lirait comme
  complète. Ici, une URL inspectée est un fait **autonome** : elle ne prétend rien sur les autres,
  et rien ne la compare à un total attendu. Écrire au fil de l'eau évite de perdre 199
  inspections **payées au quota** parce que la 200ᵉ a échoué.
- **Mais une erreur provider INTERROMPT le lot et remonte.** Absorber un 429 URL par URL
  brûlerait les 199 tentatives suivantes contre un mur — et surtout la file n'apprendrait rien.
  En relançant l'erreur structurée, le refroidissement JOB-006 met **toute la cohorte `gsc`** au
  repos, ce qui protège aussi la collecte Search Analytics du **même compte partagé**. Les URLs
  déjà écrites restent : ce sont des faits acquis, pas une transaction à annuler.
- **Une réponse 200 ILLISIBLE est un TROISIÈME état, nommé.** Ni erreur provider, ni résultat :
  `unreadable`. Rien n'est écrit pour elle (des `null` en base se liraient comme « Google ne
  connaît pas cette page ») mais le lot **continue** — rien n'indique que les URLs suivantes
  soient concernées.
- **`excluded` est une classe À PART de `not_indexed`.** « Excluded by 'noindex' tag » est une
  décision du site qu'on respecte ; « Crawled - currently not indexed » est un problème à
  traiter. Le legacy les rangeait ensemble (ce qui suffisait à son usage : ne pas resoumettre),
  mais efface la distinction dont un détecteur d'indexation a besoin.
- **Le rerun est non destructeur PARCE QUE la clé est `(projet, url, date)`.** Un rerun le même
  jour rafraîchit sa ligne ; un jour plus tard crée une **nouvelle** ligne et **ne touche pas** la
  précédente. Prouvé : 2 dates en base, l'ancienne mesure intacte, l'historique lu du plus récent
  au plus ancien.
- **`collect:url_inspection` n'est PAS au catalogue hebdo — volontairement.** Sans IDX-004,
  personne ne sait quelles URLs méritent le quota : un job planifié avec une liste vide tournerait
  pour rien chaque lundi. Il est exécutable dès maintenant, et un payload sans URLs **le dit** au
  lieu d'inventer une sélection. Même forme que `post_publish:check`, déclaré avant son handler.
- **Le plafond dur est de 200 URLs, et un `cap` forgé ne peut pas le dépasser.** Le quota est de
  2 000/jour/propriété sur un compte partagé par 6 projets ; un appel avec 5 000 URLs le brûlerait
  en un job. Les doublons sont dédupliqués avant tout appel (deux fois la même URL = deux fois le
  quota pour la même donnée), et une pause de **150 ms** tient sous les 600 req/min.
- **La lecture ne touche JAMAIS le réseau** (`indexing-read.ts`) : `DISTINCT ON (url)` rend le
  dernier état par URL en une requête. Un écran qui appelle l'API au rendu consomme du quota à
  chaque rafraîchissement et affiche un état incomparable à hier — ce que fait le legacy
  `/projects/[slug]/seo-data`. La classification reste **dérivée à la lecture**, jamais stockée,
  et `countIndexClasses` agrège **en mémoire** via `classifyCoverage` plutôt qu'en SQL : une
  reproduction SQL divergerait au premier libellé nouveau de Google.
- Vérif : `npm run test` = **766/766** (+18 `url-inspection-state`) · `npm run check` =
  **0 err / 42 warn** (baseline) · **aucun DDL**, `schema.ts` inchangé, **58 tables `seostats`**
  · **`scripts/idx-002-inspection-proof.ts` = 32/32 vertes sur Neon** (mode `--skip-real`),
  base rendue à l'identique (**441 soumissions, 6 intégrations, 0 observation sentinelle** avant
  comme après) · non-régression : `idx-001-sitemap-proof`, `job-006-limits-proof`,
  `job-005-schedule-proof`, `job-004-dag-proof`, `dash-002-home-proof`, `gsc-004-windows-proof`,
  `dash-005-inbox-proof` — **0 échec chacune**.
- **Chaîne réelle démontrée** (1 appel de quota) : inspection de `https://barberconcept.ch/` via
  la propriété **`sc-domain:barberconcept.ch`** → **`verdict=PASS`**, `coverageState='Submitted and
  indexed'`. Propriété, scope (`webmasters.readonly`, déjà dans `COMBINED_SCOPE`) et parsing de la
  vraie réponse s'accordent — la seule chose qu'un mock ne pouvait pas prouver.

**Acceptations couvertes.** (1) « chaque inspection possède un historique » : 2 dates en base pour
la même URL, la plus ancienne **intacte**, relues par `loadIndexHistory` du plus récent au plus
ancien ; (2) « un rerun ne détruit pas l'état précédent » : rerun le même jour → **0 doublon** et
mesure rafraîchie ; rerun un jour plus tard → **nouvelle ligne**, la veille inchangée ; (3) « le
statut UI est dérivé de champs persistés, pas d'un appel à la volée » : `loadLatestIndexStates`
rend l'état depuis la base avec **0 appel réseau**, une seule ligne par URL (`DISTINCT ON`) ;
(4) « distinguer erreur provider et résultat non indexé » : 7 erreurs → **0 observation** et URL
absente, contre une page non indexée → **1 ligne classée** ; les deux sont distinguables **en
base**, et les 7 classes d'erreur sont exactes côté file.

**Prochain :** **IDX-004** (politique de sélection et quotas — débloqué : l'inventaire IDX-001 lui
donne sa source, et ce collecteur son exécutant) · **IDX-005** (détecteur de transitions
d'indexation, débloqué par ce lot) · **DASH-003** (cockpit projet).

**Pièges :**
- **`collect:url_inspection` n'est pas planifié** : c'est voulu, et un job enfilé sans `urls` ne
  fait rien (il le journalise). Ne pas « corriger » ça en ajoutant une sélection par défaut —
  ce serait IDX-004 à l'aveugle, sur un seul de ses six critères.
- **Ne JAMAIS absorber une erreur provider dans la boucle.** C'est ce qui rendrait le
  refroidissement JOB-006 inopérant, et le legacy le faisait.
- **Le refroidissement est PARTAGÉ avec la collecte GSC** (même service account) : un 429
  d'inspection met aussi `collect:gsc_query_page` au repos. C'est voulu, mais à savoir avant de
  diagnostiquer une collecte GSC « qui ne part pas » le lundi.
- **`indexing.ts` reste dette datée** : `inspectUrl`/`batchInspect` servent encore les routes
  manuelles et la page `seo-data` (qui appelle donc toujours l'API au rendu). À basculer sur
  `indexing-read.ts` — non fait ici, hors périmètre IDX-002.
- **Aucun écran ne consomme encore `indexing-read.ts`** : le read-model existe, testé et prouvé,
  mais c'est DASH-003 qui l'affichera. Piège AGT-000 assumé et **nommé** — à la différence du cas
  d'origine, il a un consommateur identifié et daté.
- **`= ANY($n)` casse avec le driver Neon** — `inArray` et bornes (respecté).
- **Une preuve interrompue saute son `cleanup()`** : vérifier les `observed_date` **2018-11-%** de
  `index_observations` et les URLs `sentinelle-idx002.test`.
- Toujours en suspens hors IDX-002 : purge destructive (DATA-008 `--execute`) · **CONTRACT
  différé** · double écriture legacy GSC (meurt avec GSC-003) · `gsc-002` non rejoué (quota) ·
  `npm run build` échoue à l'adaptateur Vercel sous Windows (**préexistant**) · **rien ne bat tant
  que ce n'est pas déployé** · au 1er tick hebdo, `barberconcept` écrira ses **50 findings**.

**Commit :** `26ebaa3` [hub] add: IDX-002 collecteur URL Inspection persistant, erreur provider ≠ non indexé

---

## Etat session 2026-07-25 (IDX-001 — l'inventaire sitemap, et un `catch {}` qui rendait une acceptation impossible)

**Fait :** IDX-001. Le graphe hebdo n'avait qu'**une seule arête de collecte** (`collect:gsc_query_page`) ;
les branches `fetch_sitemap` et `inspect_priority_urls` de SPEC §8.2 n'existaient pas. L'indexation —
la douleur jokiSEO d'origine — n'était couverte que par du code legacy non gouverné. **Un DDL additif**
(`sitemap_url_observations`, table **vide** à la création) : 57 → **58 tables `seostats`**, l'écart étant
exactement celle-là.

- **Le legacy ne pouvait PAS tenir l'acceptation, structurellement.** `indexing.ts:fetchSitemapUrls`
  fait `catch {}` sur chaque sous-sitemap : « signaler les sitemaps invalides ou inaccessibles » y est
  donc **impossible par construction**, pas juste absent. Il jette aussi `lastmod` et `hreflang` (il rend
  des chaînes), et **récurse sans borne** — un index qui se référence lui-même tourne jusqu'au timeout du
  worker. Il reste en place pour les routes manuelles (dette datée, comme la double écriture GSC-002) ;
  aucun nouveau chemin ne l'appelle.
- **Une table, parce qu'aucune n'avait le grain.** `sitemap_observations` porte le **par-fichier**, à la
  forme de l'API Sitemaps de GSC (`submitted_urls`/`indexed_urls`/`errors`/`is_pending`). IDX-001 lit le
  **XML** et exige le **par-URL** : `lastmod`, locale, canonical attendu. Le `payload_json` d'une
  observation est plafonné à **32 Ko** (`MAX_OBSERVATION_PAYLOAD_BYTES`) — un inventaire n'y tient pas.
  Le « zéro DDL » des derniers lots était un **constat, pas une règle** (rappel JOB-006).
- **Snapshot complet par date, et non un journal de changements.** C'est ce qui rend le diff une
  **fonction PURE de deux listes** (`diffInventories`) : rejouer le même couple de dates rend le même
  diff, indéfiniment — « reproductible et lié à deux snapshots » au sens littéral. Un journal cumulé, lui,
  ne se rejoue pas : il faudrait le replier depuis l'origine et espérer n'avoir rien perdu.
- **L'unique porte `url_normalized`, PAS `url`.** Sans ça, `…/page` et `…/page#a` créeraient deux lignes
  pour une seule page, et le diff **inventerait un ajout à chaque run**. `url` garde la forme exacte que
  le site déclare (trace), `url_normalized` sert la comparaison. Prouvé : un 2ᵉ run où les mêmes pages
  portent des fragments produit **zéro faux ajout**.
- **Ce qui est CONSERVÉ à la normalisation est aussi un choix** : le slash final et la query string. Les
  retirer ferait fusionner deux entrées de sitemap en une, et le diff annoncerait un **retrait** là où le
  site n'a rien enlevé. Le tri des paramètres n'est pas fait non plus : deux ordres dans un même sitemap
  sont une anomalie du site, qu'IDX-005 doit pouvoir voir plutôt qu'on la masque.
- **RIEN n'est écrit avant que tout l'arbre soit parcouru** — même invariant que GSC-002, autre
  conséquence. Un inventaire coupé au 2ᵉ fichier sur 5 se lirait comme complet, et le run suivant
  annoncerait des dizaines de **retraits fantômes**. Ce n'est pas une crainte théorique : la preuve le
  **mesure** (bloc F) — un run tronqué à 1 URL annonce **4 retraits** qui n'ont jamais eu lieu. C'est
  exactement ce que la garde empêche d'écrire, et pourquoi un bail perdu fait **échouer** la collecte.
- **Un sitemap mort est un FAIT persisté, pas une exception.** L'enfant 404 obtient sa ligne
  per-fichier avec `errors > 0` et son statut HTTP — **interrogeable en SQL**, pas seulement loggé — et
  **n'empêche pas** les autres enfants d'être parcourus. Le run se déclare alors `partial` : un
  inventaire incomplet ne doit jamais se lire comme complet.
- **Injoignable et malformé ne se confondent ni ne se compensent.** Deux natures de problème, deux
  compteurs : au 2ᵉ run l'enfant mort a quitté l'index (plus aucun `fetch_failed`) mais le fichier i18n
  garde son `<url>` sans `<loc>`, donc le run **reste** `partial`. Un problème réglé ne doit pas masquer
  celui qui reste.
- **Une alternate `hreflang` n'est pas une page nouvelle.** Elle est marquée `is_alternate` avec sa
  locale ; une page qui se déclare sa **propre** alternate est ignorée. Sans cette règle, le premier run
  d'un site multilingue annoncerait autant d'« ajouts » que de langues.
- **Dédup AVANT l'insert, jamais après.** Une URL listée par deux enfants suffirait à faire rejeter
  **tout le lot** (Postgres refuse deux lignes de même clé dans un même `INSERT`) — leçon GSC-002
  appliquée. Et la principale l'emporte sur l'alternate portant la même URL.
- **Le diff se compare au dernier inventaire STRICTEMENT antérieur**, pas « au plus récent » : sinon un
  second run le même jour se comparerait à lui-même (déjà upserté) et rendrait un diff toujours vide,
  masquant ce que le premier run du jour avait vu.
- **`sitemap_url` fait partie du `set` d'upsert**, contrairement aux dimensions d'unique des autres
  domaines : une URL peut **migrer** d'un enfant à un autre lors d'une refonte de découpage sans cesser
  d'être la même page. Figer le fichier d'origine ferait mentir la traçabilité.
- **`collect:sitemap` est en parallèle de la collecte GSC, sans aucune dépendance.** Deux sources
  indépendantes, dont une seule consomme du quota Search Analytics : les lier ferait sauter l'inventaire
  sur un 429 GSC, alors que le XML aurait été parfaitement fetchable. Il est classé provider **`gsc`**
  quand même — le fetch XML ne coûte rien, mais la résolution de racine passe par le service account
  partagé, et le classer `none` le sortirait du refroidissement JOB-006.
- Vérif : `npm run test` = **748/748** (+32 : 31 `sitemap-state` + 1 catalogue) · `npm run check` =
  **0 err / 42 warn** (baseline) · **DDL appliqué sur Neon** (1 table + 3 index, 15/15 colonnes,
  **0 ligne** à la création) · introspection = **58 tables `seostats`** (+1 `core`), écart = cette table
  et rien d'autre · **`scripts/idx-001-sitemap-proof.ts` = 43/43 vertes sur Neon**, **rejouée**, base
  rendue à l'identique (**441 soumissions, 13 findings, 16 jobs, 0 observation sitemap** avant comme
  après) · non-régression : `job-005-schedule-proof`, `job-006-limits-proof`, `job-004-dag-proof`,
  `dash-002-home-proof`, `gsc-004-windows-proof`, `dash-005-inbox-proof` — **0 échec chacune**.

**Acceptations couvertes.** (1) « un sitemap diff est reproductible et lié à deux snapshots » : le diff
nomme sa date antérieure (`previousDate`), rend +1/−1/~1 exacts, et **rejouer le même couple de dates
depuis la base rend le même diff**, deux fois de suite ; (2) « redirects et fragments sont normalisés » :
`…/services` et `…/services#top` ne produisent **qu'une** ligne, aucune `url_normalized` en base ne
contient de `#`, et un run où les fragments apparaissent ailleurs ne crée **aucun faux ajout** ;
(3) « aucune URL supprimée n'est automatiquement désindexée » : le retrait de `/blog/a` est détecté et
**rien** n'est soumis (`indexing_submissions` **441 → 441**), aucun finding créé — tenu **par
construction** (ce module ne sait pas soumettre) et non par vigilance.

**Prochain :** **IDX-002** (collecteur URL Inspection persistant) — enchaîné dans la même session.
Puis **IDX-004** (politique de sélection/quotas, débloqué par cet inventaire) et **IDX-005** (détecteur
de transitions).

**Pièges :**
- **Ne jamais « corriger » le snapshot complet en journal de changements.** Le diff cesserait d'être
  rejouable, et c'est l'acceptation elle-même.
- **`indexing.ts` reste dette datée** : ne pas l'appeler depuis les nouveaux chemins, et **ne jamais
  l'importer dans un runner `tsx`** (`db` et `crypto.js` en statique).
- **Un inventaire partiel ne doit JAMAIS être écrit.** La garde vit dans le collecteur (`signal` vérifié
  à chaque itération, écriture après le parcours). La preuve montre le faux signal qu'elle évite.
- **La racine dérivée (`{propriété}/sitemap.xml`) est une CONVENTION, pas une découverte.** `robots.txt`
  la porterait mieux ; à faire quand IDX-004 aura besoin d'un inventaire exhaustif.
- **`= ANY($n)` casse avec le driver Neon** — bornes et `inArray` (respecté : le diff lit deux dates par
  égalité, jamais par liste paramétrée).
- **Une preuve interrompue saute son `cleanup()`** : vérifier les `observed_date` **2018-11-%** de
  `sitemap_url_observations` **et** `sitemap_observations` (le domaine sentinelle est
  `sentinelle-idx001.test`).
- Toujours en suspens hors IDX-001 : purge destructive (DATA-008 `--execute`) = session dédiée ·
  **CONTRACT différé** · double écriture legacy GSC (meurt avec GSC-003) · `gsc-002` non rejoué (quota) ·
  `npm run build` échoue à l'adaptateur Vercel sous Windows (**préexistant**) · **rien ne bat tant que ce
  n'est pas déployé** · au 1er tick hebdo, `barberconcept` écrira ses **50 findings** (décision maintenue)
  — et le run enfilera désormais **2 collectes** par projet au lieu d'une.

**Commit :** `ebf127b` [hub] add: IDX-001 inventaire sitemap, diff reproductible, sitemaps invalides signalés

---

## Etat session 2026-07-25 (DASH-002 — l'accueil cesse de confondre « la collecte est morte » et « tout va bien »)

**Fait :** DASH-002. La chaîne était complète et l'inbox la rendait décidable — mais **l'accueil
était encore l'ancien dashboard Content Hub** : compteurs draft/review/publiés et 10 derniers
contenus, c'est-à-dire zéro information sur ce que le cockpit détecte. Six projets, 13 findings, 4
propositions, une file gouvernée, des fenêtres de comparaison : rien de tout ça n'apparaissait sur la
page d'ouverture. **Zéro DDL** (57 tables `seostats` + 1 miroir `core`, `schema.ts` intact, vérifié par
introspection) : tout se dérive de tables existantes, y compris la notion de « période ».

- **DEUX axes qui ne fusionnent JAMAIS en un score, et c'est toute l'acceptation.** `classifyProject`
  tient `pipeline` (est-ce que la donnée arrive ?) et `signal` (que dit la donnée ?) séparés jusqu'à
  l'écran. Un badge unique aurait fait exactement ce que l'acceptation interdit : confondre « le SEO
  baisse » et « le credential est mort », qui demandent deux gestes opposés. Chaque carte porte donc
  **une phrase qui nomme l'axe** (« Collecte à réparer — … » vs « Performance à traiter — … »).
- **Un pipeline cassé rend le signal `unknown`, jamais `ok` — le cœur du lot.** Sans cette règle, un
  projet dont la collecte est morte afficherait « 0 nouveau finding » et se lirait comme **le projet le
  plus sain du portefeuille**. C'est le pire mode de panne, celui qui ne se plaint pas. Même doctrine
  que §10.3 (« une fenêtre absente n'est pas des zéros ») portée à l'échelle du projet. Ce qui était
  DÉJÀ connu reste dit (un critique découvert avant la panne ne disparaît pas).
- **Le compteur et sa liste sont le MÊME filtre, pas un nombre et un lien écrits séparément.**
  `buildCounter` produit les deux depuis un `CounterFilter` unique, et le read-model **compte avec ce
  descripteur**. La preuve ne compare pas deux nombres calculés par le même code : elle **part de
  l'URL** et la rejoue comme le loader de l'inbox le ferait. Corollaire assumé : un compteur dont
  aucune liste ne saurait reproduire le filtre **n'a pas de lien** (`href: null`) — les avis (aucune vue
  cross-projet n'existe) et les runs d'une période (§13.4 leur donnera la leur) restent des chiffres,
  plutôt que des liens qui mèneraient ailleurs.
- **Le filtre d'activité a dû naître pour que ces liens existent.** `ListFindingsInput` gagne
  `activityEvents`/`activitySince` (clause **EXISTS** sur `finding_events`, jamais une jointure — une
  jointure dupliquerait la ligne autant de fois qu'elle a d'événements et ferait mentir
  `countFindings`). Filtrer sur les ÉVÉNEMENTS et non sur `first_seen_at`/`resolved_at` : ces colonnes
  ne couvrent pas `aggravated`, et mélanger deux sources ferait diverger deux compteurs de la même ligne.
- **BUG TROUVÉ EN ÉCRIVANT LA PREUVE, latent et daté.** `loadActivity` comptait des **lignes de
  journal** (`count(*)`) là où la liste liée dédoublonne par finding. Un finding aggravé deux semaines
  de suite annonçait donc « 2 aggravés » pour **un seul problème** — et `reconcileDetectionRun` écrit un
  `aggravated` par run, si bien que **toute fenêtre de 28/90 j** rencontrait le cas. La preuve initiale
  passait par chance (aucun finding n'avait deux aggravations dans 7 j). Corrigé en
  `count(DISTINCT finding_id)` + contre-épreuve dédiée (bloc B-bis) qui seede la seconde aggravation.
- **« Jamais collecté » n'est pas un âge de 0 heure.** `deriveFreshness` rend `ageHours: null` et un
  état `never` À PART : brancher un flux et réparer un flux cassé sont deux gestes différents. Le
  template ne formate jamais `ageHours ?? 0` — l'acceptation « l'état des données n'est jamais confondu
  avec une valeur zéro » se perdrait là.
- **`unknown` se classe AVANT `watch`, délibérément.** Ne pas savoir est plus urgent qu'un signal faible
  connu : un projet muet est le seul qui puisse cacher n'importe quoi. Et l'ordre est **TOTAL** (dernière
  clé : le slug) — un écran dont les lignes permutent sans que rien n'ait changé ne se lit plus « en
  moins d'une minute ».
- **Les coûts sont « non instrumentés », pas à zéro.** `monitoring_runs.cost_json` existe depuis
  DATA-003 mais **rien ne l'écrit** (seul `createRun` l'accepte, aucun appelant ne le passe) : afficher
  « 0 » confondrait *gratuit* et *pas mesuré*. Le gate se réveillera **seul** au premier run qui portera
  un coût — même forme que le YoY inerte de GSC-004. Un `cost_json` cassé n'écroule pas la page.
- **Seuil de retard à 10 jours, pas 7.** La cadence est hebdomadaire et la latence GSC vise 8+ jours
  (GSC-002) : un seuil à 7 j ferait crier les six projets tous les dimanches sur une file parfaitement
  saine — et une alerte qui crie chaque semaine n'est plus lue.
- **La fraîcheur du pipeline est celle de GSC, pas du dernier provider quelconque.** Prendre le dernier
  succès toutes intégrations confondues ferait passer un projet pour frais **parce que LinkedIn a publié
  un post**, alors que le canon d'observations dont tout dépend n'a rien reçu.
- **Une lecture par domaine, groupée par projet.** Six projets × sept compteurs feraient 42
  allers-retours pour une page d'accueil sur un pooler serverless. Et les cumuls cross-projet sont la
  **somme des cartes**, jamais une requête de plus : le total et le détail ne peuvent pas annoncer deux
  chiffres pour la même chose.
- Vérif : `npm run test` = **716/716** (+37 `home-state`) · `npm run check` = **0 err / 42 warn**
  (baseline) · **aucun DDL**, introspection = **57 tables `seostats`** (+1 `core`), `schema.ts`
  non modifié (`git status` vide) · **`scripts/dash-002-home-proof.ts` = 44/44 vertes sur Neon**,
  **rejouée**, base rendue à l'identique (**13 findings, 17 events, 4 propositions, 6 intégrations,
  16 jobs, 75 467 observations** avant comme après) · non-régression : `dash-005-inbox-proof`,
  `agt-000-proposer-proof`, `find-003-lifecycle-proof`, `job-006-limits-proof`, `job-004-dag-proof`,
  `gsc-004-windows-proof` — **0 échec chacune** · routes sondées en dev (port 5200) : `/`,
  `/?days=28`, `/?days=bogus`, `/inbox?tab=findings&event=…&since=…` → **303** `/login`.

**Acceptations couvertes.** (1) « une intégration cassée est distincte d'une baisse de performance » :
deux projets réels, deux causes — l'un passe `broken` avec **signal `unknown`** (et non `ok` malgré 0
finding) et une phrase qui parle de collecte, l'autre `at_risk` avec **pipeline sain** et une phrase qui
parle de performance ; les deux verdicts ne partagent ni état ni phrase, prouvé en base ; (2) « chaque
compteur ouvre une liste filtrée cohérente » : les **6 compteurs liés** sont rejoués **depuis leur URL**
et rendent exactement le nombre affiché, portée cross-projet **et** portée projet — le 7ᵉ n'a pas de
lien et le dit ; (3) « Jonathan identifie en moins d'une minute les projets nécessitant une action » :
l'ordre rendu est l'ordre d'urgence (`broken` avant `at_risk`), **stable entre deux lectures**, avec les
projets à traiter isolés en tête et la santé du portefeuille au **pire** état représenté.

**Prochain :** **IDX-001/002** (sitemap, URL Inspection), qui donneront au graphe hebdo ses arêtes
profondes · **DASH-003** (cockpit projet, débloqué côté fenêtres — consommera `GET /gsc/windows` et
pourra reprendre le panneau `/windows`) · **DASH-001** (navigation/design system) reste BLOCKED par
GOV-002.

**Pièges :**
- **Le rendu visuel n'a PAS pu être constaté** (limite inchangée depuis JOB-007 : aucune session admin,
  fournir un mot de passe est exclu, le cookie Better Auth est signé). Ce qui est prouvé : le chargement
  serveur (303), la compilation (`check` 0 err + build qui compile ses 4090 modules), et le read-model
  sur Neon. **La mise en page de l'accueil n'a jamais été vue par un œil.**
- **`npm run build` échoue à l'ADAPTATEUR Vercel** (`EPERM symlink` sur `(app).func`) : limite Windows
  **préexistante**, vérifiée à l'identique sur l'arbre sans ce lot. La compilation, elle, passe. Ne pas
  diagnostiquer ça comme une régression du cockpit.
- **Un compteur ajouté doit naître d'un `CounterFilter`**, jamais d'un nombre + une URL écrits à la
  main : c'est le seul endroit où la cohérence compteur/liste est tenue, et la preuve ne rejouera que
  ce que le descripteur sait décrire.
- **Compter des PROBLÈMES, pas des lignes de journal.** Tout nouveau compteur d'activité doit
  dédoublonner par `finding_id` (cf. le bug ci-dessus), sinon il divergera de sa liste dès qu'un finding
  reçoit deux événements du même type dans la fenêtre.
- **Le seuil de 10 j est un choix, pas une constante physique** (`GSC_STALE_AFTER_HOURS`) : si la cadence
  de collecte change, il doit changer avec elle, sinon l'accueil devient soit muet soit criard.
- **`= ANY($n)` casse avec le driver Neon** — bornes `>=` et `inArray` (`IN (…)`) partout ici (rappel).
- **Une preuve interrompue saute son `cleanup()`** : vérifier alors le provider d'intégration
  `__test_dash002` (`project_integrations`) et les fingerprints `__test_dash002:%` (`findings` +
  `finding_events`, **enfants d'abord**).
- Toujours en suspens hors DASH-002 : purge destructive (DATA-008 `--execute`) = session dédiée ·
  **CONTRACT différé** · la **double écriture legacy** reste une dette datée (meurt avec GSC-003) ·
  `gsc-002` non rejoué (quota) · **rien ne bat tant que ce n'est pas déployé** · au 1er tick hebdo,
  `barberconcept` écrira ses **50 findings** (décision maintenue) — qui, désormais, **le feront passer
  en tête de l'accueil**.

**Commit :** `6377326` [hub] add: DASH-002 accueil cross-projet, deux axes de santé, compteurs liés à leur liste

---

## Etat session 2026-07-24 (GSC-004 — les fenêtres 7/28/90 j, le backfill reprenable, la latence réglable)

**Fait :** GSC-004. La comparaison n'était que **semaine-contre-semaine** ; il manquait les fenêtres
7/28/90 j, la période finale configurable, un backfill borné **reprenable**, et un signalement
d'incomplétude. Surprise à l'exploration : **une partie était déjà bâtie mais non câblée** —
`buildWindow`/`areWindowsComparable` (taggés GSC-004 dans `detector-state.ts`), la dégradation de
confiance du détecteur, et les helpers day-span de `observation-state.ts` (qui, eux, restent pour les
domaines *date-grained* : index, keyword). Le vrai reste était le **câblage** + le **backfill**.
**Zéro DDL** (`schema.ts` intact, 57 tables `seostats` + 1 `core`, zéro dérive) : la latence vit dans
`system_settings` (clé `gsc.latency_days`), le backfill n'a **aucune** table de checkpoint, et
l'incomplétude n'a **aucune** colonne.

- **Le grain est la SEMAINE, et « 90 jours » ne l'est pas.** Les observations GSC sont hebdomadaires
  (`period_start`/`period_end` = lundi→dimanche) : « 7/28/90 j » = **1 / 4 / 13 semaines complètes**,
  ancrées sur `latestCompleteWeekStart`. Une fenêtre glissante au jour près serait une précision que
  la donnée n'a pas. Les helpers `computeWindowStart`/`WINDOW_DAYS` d'`observation-state.ts` ne sont
  donc **pas** le bon outil pour GSC — ils le restent pour index/keyword, qui sont `observed_date`.
- **« Aucun delta entre longueurs incompatibles » est STRUCTUREL, pas un `{#if}`.** Le refus vit dans
  `computeWindowDelta` (module pur) : une fenêtre précédente trop courte pour égaler la courante rend
  `{ available:false, reason:'incomparable_lengths' }`. Une règle qui ne vivrait que dans un template
  se perdrait au premier refactor — même doctrine que le L4 de DASH-005 exclu dans le module pur.
- **L'incomplétude BAISSE la confiance, elle ne s'invente pas un drapeau.** `windowCompleteness`
  DÉRIVE couverture + caveats de deux manques distincts — *pas assez de semaines* (`weeks < expected`)
  et *pas la dernière semaine complète* (`current.end < latestCompleteWeekEnd`, fenêtre en retard, pas
  tronquée) — jamais une colonne stockée. Doctrine « état dérivé, jamais stocké » (JOB-004/005) : deux
  états qui divergent valent moins qu'un seul qui se recalcule.
- **La latence est réglable SANS redéploiement, et le collecteur la partage.** `latestCompleteWeekStart`
  gagne un paramètre `latencyDays` (défaut `GSC_LATENCY_DAYS`, comportement d'avant strictement
  inchangé) ; `loadGscLatencyDays` le lit dans `system_settings`. **Piège évité** : si seul le
  read-model lisait le réglage, il jugerait « pas à jour » une semaine que le collecteur tient déjà
  pour finale — donc le handler `collect:gsc_query_page` résout la même latence et la passe au
  collecteur. Une valeur illisible/négative retombe sur le défaut (jamais un décalage silencieux).
- **Le backfill est REPRENABLE SANS CHECKPOINT — la reprise est dérivée de la base.** `enqueueGscBackfill`
  ne ré-enfile que les semaines **sans observation** dans la plage (bornée), par tranches
  (`maxWeeksPerBatch`), en jobs `collect:gsc_query_page` (déjà idempotents) drainés sous quota/
  refroidissement JOB-006. Un checkpoint stocké pourrait **mentir** (une semaine « faite » dont le job
  a échoué après) ; la présence réelle d'observations, non. Conséquence assumée, prouvée en base : le
  `batch` est un **débit** (jusqu'à N jobs en vol), pas un curseur — rappeler la fonction avant que la
  tranche soit collectée re-enfile les **mêmes** semaines (idempotent, 0 doublon) ; la reprise
  **avance** dès qu'une semaine devient présente. Jamais au-delà de la dernière semaine complète (une
  semaine partielle se lirait comme une chute — le faux signal GSC-006).
- **Année N-1 : câblée mais INERTE.** `buildYoyComparison` compare la fenêtre courante aux mêmes
  semaines 52 semaines plus tôt (364 j, pour retomber sur des lundis) — cherchées parmi les paires
  RÉELLES. La donnée commençant ~2026, elle rend `{ available:false }` jusqu'en 2027, puis s'activera
  seule. Plutôt qu'un module que rien ne peut nourrir (piège AGT-000), un gate qui se réveille.
- Vérif : `npm run test` = **679/679** (+23 : 18 `gsc-windows-state` + 5 `gsc-settings`) · `npm run
  check` = **0 err / 42 warn** (baseline) · **aucun DDL**, `schema.ts` intact, **57 tables `seostats`**
  (+1 `core`), zéro dérive · **`scripts/gsc-004-windows-proof.ts` = 35/35 vertes sur Neon**, base
  rendue à l'identique (**75467 observations, 16 jobs, 13 findings, 4 propositions** avant comme après)
  · non-régression : `dash-005-inbox-proof`, `agt-000-proposer-proof`, `find-003-lifecycle-proof`,
  `job-006-limits-proof`, `job-004-dag-proof` — **0 échec chacune** · routes sondées en dev (port
  5199) : `GET /api/projects/[slug]/gsc/windows` → **401** sans auth, **200** avec la clé (barberconcept :
  16 semaines, span 7 = 859 clics / 109 060 impr, la semaine réparée) ; `/projects/[slug]/windows` →
  **303** `/login`.

**Acceptations couvertes.** (1) « aucun delta n'est calculé entre périodes de longueurs
incompatibles » : span 90 sur 8 semaines seulement → non comparable, **delta indisponible**, prouvé en
base ; (2) « le backfill est reprenable » : reprise **dérivée** des observations, idempotente,
qui **avance** quand une semaine est collectée — prouvé (2ᵉ appel = 0 doublon, collecte simulée →
nouvelle semaine enfilée) ; (3) « un manque de données baisse la confiance au lieu de produire un faux
signal » : `windowCompleteness` rend couverture < 1 + caveat explicite (tronquée / pas à jour), et le
détecteur garde sa dégradation de confiance interne (intacte, non touchée).

**Prochain :** **DASH-002** (accueil cross-projet, maintenant que l'inbox ET les fenêtres existent) ·
**IDX-001/002** (sitemap, URL Inspection) · **DASH-003** (cockpit projet), désormais débloqué côté
fenêtres — il consommera `GET /gsc/windows` et pourra remplacer/enrichir le panneau `/windows`.

**Pièges :**
- **Le read-model lit le CANON, pas le legacy.** `loadGscWindows` lit `gsc_query_page_observations`
  (même source que le détecteur) — jamais `gsc_snapshots`/`gsc_weekly_diffs`. Ne pas y brancher un
  chemin legacy : l'écran et le détecteur divergeraient, ce que GSC-002 venait de fermer.
- **`= ANY($n)` casse avec Neon** : les fenêtres et la dérivation de présence filtrent par bornes
  `>=`/`<=` sur `period_start`, jamais par liste paramétrée (rappel, respecté partout ici).
- **`batch` est un débit, pas un curseur.** Rappeler `enqueueGscBackfill` avant que la tranche soit
  collectée re-enfile les mêmes semaines (idempotent). C'est voulu : ça borne le nombre de jobs en vol
  sur un compte partagé, et ça avance tout seul à mesure que la file draine. Ne pas « corriger » ça en
  un curseur stocké — ce serait le checkpoint menteur qu'on a écarté.
- **Le panneau `/windows` n'est PAS constatable visuellement** sans session admin (limite JOB-007
  inchangée) : prouvé au chargement (303/401/200) et au `check`, jamais au rendu. DASH-003 le
  reprendra ; d'ici là c'est un panneau fonctionnel mais non relu à l'œil.
- **`gsc-002` non rejoué** (quota GSC réel, compte partagé) : justifié — le cœur du collecteur est
  inchangé (le paramètre `latencyDays` est optionnel et vaut 3 par défaut), et le chemin de lecture des
  observations est exercé par `gsc-004-windows-proof`. À rejouer au prochain vrai run de collecte.
- **Une preuve interrompue saute son `cleanup()`** : vérifier les semaines sentinelles **2018-2019**
  (`gsc_query_page_observations`), les jobs `backfill:collect:gsc_query_page:%`, et la clé
  `gsc.latency_days` de `system_settings` après toute interruption.
- Toujours en suspens hors GSC-004 : purge destructive (DATA-008 `--execute`) = session dédiée ·
  **CONTRACT différé** · la **double écriture legacy** reste une dette datée (meurt avec GSC-003) ·
  **rien ne bat tant que ce n'est pas déployé** · au 1er tick hebdo, `barberconcept` écrira ses **50
  findings** (décision maintenue).

**Commit :** `bdbbc46` [hub] add: GSC-004 fenêtres de comparaison, backfill reprenable, latence réglable

---

## Etat session 2026-07-23 (DASH-004+005 — la chaîne atteint enfin l'humain)

**Fait :** la chaîne SPEC `observations → détecteurs → findings → propositions → approbation` était
construite de bout en bout **sauf son dernier maillon**. En base : **13 findings** et **4
propositions** `meta_rewrite` **L3**, produites, scorées, gouvernées — et
`grep -rl "findings" src/routes` rendait **zéro résultat**. Aucune route, aucune page, aucun
endpoint ne les lisait : le piège AGT-000 (« un module complet que personne n'appelle »), transposé
à la couche de **sortie**. `proposals.ts` n'exposait d'ailleurs **que de l'écriture** — son seul
lecteur, `listProposalsForFinding`, ne sert qu'à la supersession. **Zéro DDL** (58 tables : 57
`seostats` + 1 miroir `core`, zéro dérive) : `changes_requested` est une **valeur** d'une colonne
`text`, et `idx_action_proposals_status` attendait « l'inbox cross-projet » depuis DATA-006.

- **L'approbation devient OPTIMISTE, et c'est ce qui rend l'acceptation vraie.** « Chaque
  approbation est liée au hash exact » ne tient pas sous concurrence si l'appelant approuve « la
  version courante, quelle qu'elle soit » : entre l'affichage et le clic, le run du lundi peut avoir
  périmé la proposition. L'écran renvoie donc le `payloadHash` **qu'il a montré** ;
  `approveProposal` compare **sous transaction** et refuse (`stale_hash` → 409) **sans rien
  écrire**. Effet de bord gratuit : c'est exactement ce qui **exclut du lot un item modifié** — la
  deuxième acceptation est obtenue par la même comparaison, sans aucune règle d'interface.
- **BUG LATENT TROUVÉ EN POSANT LA GARDE DE STATUT, et il visait la décision humaine.**
  `approveProposal` n'avait **aucune** garde de statut : une proposition **`rejected` par un humain**
  repassait `approved` au simple rappel de la fonction — et le producteur l'appelle **chaque semaine**
  sur ce que `createProposal` vient d'upserter. Une machine réécrivait donc une décision humaine, en
  silence, une fois par semaine. Rien n'avait cassé **parce qu'aucun projet n'a de policy**
  (`decideAutoApproval` refuse par défaut, l'appel n'a jamais lieu) — même forme que les dettes ISO
  « la table était vide ». Corrigé aux **deux** bouts : la garde dans `approveProposal`, et
  l'abstention dans `finding-proposer` (qui **ne lève pas** : faire échouer tout un job de production
  sur un refus parfaitement normal serait pire que le bug).
- **L'idempotence est DANS la transaction, pas dans une déduplication d'HTTP.** Une double
  soumission (double clic, rejeu réseau) écrivait deux lignes dans `proposal_approvals` — et §14.3
  fait de cette table la trace de référence : l'audit aurait dit **deux décisions** là où un humain
  n'en a pris qu'une. Si la proposition est déjà `approved` **et** porte une approbation `active` sur
  le **même hash**, l'existante est rendue telle quelle. Prouvé : deux approbations → **1 seule
  ligne**, même `approvalId`.
- **`changes_requested` : un statut, pas un éditeur de payload** (décision de Jonathan). L'autre
  option — éditer le payload à la main — était un piège à deux détentes : l'édition serait
  **`superseded` au lundi suivant** (`decideSupersession` périme tout `proposed` dont le hash a
  changé), et un champ volatil ajouté à la main ferait **exploser la dédup**, le piège central
  d'AGT-000. Le statut, lui, a un effet de bord **voulu** : `decideSupersession` ne touchant que
  `proposed`/`invalidated`, une révision demandée **survit au run hebdomadaire**. Prouvé en base.
- **Le lot est reconstruit DEPUIS LA BASE, jamais accepté du client.** `approve-batch` rejoue
  `buildApprovalLots` sur les lignes réelles et refuse si les ids demandés ne forment pas
  **exactement un** lot. Une page modifiée, une requête forgée ou un onglet resté ouvert pendant le
  run hebdo ne peuvent donc pas faire approuver ensemble deux projets ou deux niveaux. **L4 est
  exclu dans le module PUR**, pas dans un `{#if}` de template : une règle qui ne vit que dans un
  template se perd au premier refactor.
- **Un risque `null` forme sa propre classe** (`inconnu`) et ne se mélange jamais à `low` : ne pas
  savoir n'est pas savoir que c'est faible. Et **un lot d'un seul élément n'est pas un lot** — c'est
  l'action individuelle, avec un mot de plus et une confirmation de moins.
- **Une approbation TOMBÉE reste affichée.** « Il y a eu une décision, elle est tombée avec le
  payload » et « il n'y a jamais eu de décision » sont deux états qu'un écran ne doit pas confondre :
  le détail rend les approbations `invalidated` et dit **qu'elles portaient un autre payload**. La
  validité est **recalculée** par `isApprovalValid` contre le hash courant, jamais lue dans le statut
  seul.
- **Toute décision négative porte une raison, journalisée au finding** (`agent_comment`, acteur
  `user:{email}`) : un refus sans motif n'apprend rien au détecteur, qui reproduira le même finding
  la semaine suivante. C'est aussi l'acceptation DASH-004 « contester avec une raison », et la
  matière première de FIND-010.
- **Le filtre par défaut est l'inbox, mais un filtre INVALIDE ne retombe pas dessus.** Sans
  `?status`, on montre les statuts ouverts (même choix que `listFindings` avec `ACTIVE_STATUSES`).
  Avec `?status=bogus`, on rend **vide** : l'utilisateur a demandé autre chose que le défaut, lui
  rendre le défaut lui ferait croire qu'il regarde son filtre.
- Vérif : `npm run test` = **656/656** (+44) · `npm run check` = **0 err / 42 warn** (baseline) ·
  **aucun DDL**, introspection = **58 tables** (57 `seostats` + 1 `core`), zéro dérive ·
  **`scripts/dash-005-inbox-proof.ts` = 47/47 vertes sur Neon**, **rejouée trois fois**, base rendue
  à l'identique (**13 findings**, **4 propositions**, **0 approbation** avant comme après) ·
  non-régression : `agt-000-proposer-proof`, `find-003-lifecycle-proof`, `job-006-limits-proof`,
  `job-004-dag-proof` — **0 échec chacune** · **0 horodatage ISO** dans `action_proposals` et
  `proposal_approvals` · routes sondées en dev (port 5176) : `/inbox`, `/inbox?tab=findings`,
  `/inbox/proposals/[id]`, `/inbox/findings/[id]` → **303** `/login` ; les **4** endpoints
  `/api/ops/**` → **401** sans session.

**Acceptations couvertes.** DASH-005 : (1) « chaque approbation est liée au hash exact » —
l'approbation porte le hash courant, et une approbation présentée avec un hash périmé **n'écrit
rien** (statut inchangé, 0 ligne) ; (2) « modifier une proposition l'exclut du lot » — le payload
modifié change le hash, l'item est **écarté nommément** et les deux autres du lot passent ;
(3) « L4 n'a pas de bouton tout approuver » — deux L4 **parfaitement homogènes** ne forment aucun
lot ; (4) « une double soumission reste idempotente » — deux approbations, **1 seule** ligne
d'audit. DASH-004 : (1) « aucune affirmation ne manque de source identifiable » — `evidence_json`
est rendu **brut**, aucune synthèse IA sur la page ; (2) « contester avec une raison » — la raison
est **obligatoire** côté endpoint et journalisée ; (3) « l'action indique son niveau
d'autorisation » — chaque proposition affiche son niveau **et qui peut l'accorder**.

**Prochain :** **GSC-004** (fenêtres 7/28/90 j, backfill borné, périodes incomplètes) ·
**IDX-001/002** (sitemap, URL Inspection), qui donneront au graphe hebdo ses arêtes profondes ·
**DASH-002** (accueil cross-projet), maintenant que l'inbox existe pour recevoir ses compteurs.

**Pièges :**
- **Approuver n'exécute RIEN.** Aucun handler d'exécution n'existe : une approbation est une
  **décision journalisée**, pas un lancement. C'est dit à l'écran ; le jour où un exécuteur
  apparaîtra, ces propositions `approved` seront **déjà là** et partiront au premier tick.
- **`changes_requested` n'a aucune sortie automatique** — seul un humain la lève. C'est voulu (elle
  est ainsi protégée du run hebdo), mais une proposition oubliée dans cet état **y reste** et rien
  ne le signale encore.
- **Une proposition SANS `finding_id` n'a nulle part où journaliser sa raison de rejet.** Aucune
  n'existe aujourd'hui (le producteur en attache toujours un) ; à traiter quand REP-001 en produira.
- **Ne jamais approuver sans renvoyer le hash affiché.** Le paramètre est optionnel côté fonction
  (le chemin agent vient d'écrire le payload et n'a rien à comparer) mais **obligatoire côté
  endpoint** : le rendre optionnel à l'UI rouvrirait la course que ce lot vient de fermer.
- **Le rendu visuel n'a PAS pu être constaté** (limite inchangée depuis JOB-007 : aucune session
  admin ouverte, fournir un mot de passe est exclu). Une session temporaire a été frappée en base
  pour essayer, **puis supprimée** : le cookie Better Auth est signé, la voie est fermée sans le
  secret. Ce qui est prouvé : le chargement serveur (303), les endpoints (401), `npm run check` vert.
- **`= ANY($n)` casse avec le driver Neon** — tout filtre de liste en `IN (…)` paramétré (rappel).
- Toujours en suspens hors DASH-004/005 : ~~les 5 semaines `2026-07-06` sous-comptées~~ **réparées
  le 2026-07-23** (détail sous ce bloc) · purge
  destructive (DATA-008 `--execute`) = session dédiée · **CONTRACT différé** · `ai_jobs → jobs`
  **écarté** · **la double écriture legacy reste une dette datée** (meurt avec GSC-003) · **rien ne
  bat tant que ce n'est pas déployé** · au 1er tick hebdo, `barberconcept` écrira ses **50
  findings** — qui, désormais, **s'afficheront** quelque part.

**Commit :** `f1392c5` [hub] add: DASH-004+005 inbox (findings + propositions), décisions liées au hash

### Réparation de données — semaine `2026-07-06` (même session, hors code)

`npx tsx scripts/collect-gsc.ts --project=all --week=2026-07-06`, un seul pull des 6 projets. Aucun
`--dry-run` préalable : il consomme le **même** quota sur le compte partagé, donc le faire aurait
doublé la dépense pour la même donnée.

| projet | lignes | impressions | clics |
|---|---|---|---|
| `barberconcept` | 11 579 → **13 591** | 80 794 → **109 060** (+35,0 %) | 629 → **859** |
| `bisrepetita` | 57 → **65** | 110 → **146** (+32,7 %) | 1 → **2** |
| `jonlabs` | 227 → **271** | 720 → **981** (+36,3 %) | 2 → 2 |
| `physiopommier` | 75 → **82** | 261 → **296** (+13,4 %) | 14 → 14 |
| `spinlink` | 14 → 14 | 129 → 129 (**0 %**) | 4 → 4 |
| `wildcat` | 54 → **67** | 215 → **287** (+33,5 %) | 5 → **10** |

**+28 670 impressions** au total (82 229 → 110 899). **`spinlink` est rigoureusement inchangé** :
c'est la contre-épreuve du diagnostic « 5 projets sur 6 », mesurée et non supposée. Observations et
tables legacy restent au chiffre près (même tampon, une seule collecte).

**Effet de bord traité dans la foulée** : le collecteur recalcule le diff de la semaine qu'il
collecte — mais le diff de `jonlabs` pour **`2026-07-13`** avait été calculé contre l'ancien
`2026-07-06`, et affirmait **+84,3 %** d'impressions. Recalculé (DB seule, zéro quota) : **+35,3 %**
(1327 vs 981). C'est exactement le faux signal que GSC-006 interdit, dans son sens inverse — une
poussée fantôme née d'une base sous-comptée. Aucun autre diff ne se compare à cette semaine.

**Ce qui n'a PAS été refait** : la détection. Les 13 findings ont été décidés sur les mesures
sous-comptées ; ils seront re-décidés au prochain run hebdo, sur la donnée réparée. Relancer
`detect.ts` à la main aurait écrit des findings hors du chemin gouverné par la file — et fait partir
les 50 de `barberconcept` sans que la décision ait été prise.

**Trace laissée** : ces lignes portent désormais un `fetched_at` **au format DB**, alors que les
autres semaines gardent l'**ISO** du backfill du 2026-07-21. Inerte aujourd'hui (les observations se
purgent sur `period_end`, et le seul usage de `fetched_at` — `debug_payload` — n'a pas de runner),
mais à savoir : en ordre lexical, l'ISO passe **après** le format DB, donc une vieille ligne
backfillée s'y lit comme plus récente qu'une ligne fraîchement réparée.

---

## Etat session 2026-07-23 (GSC-001+002 — la file va enfin CHERCHER la donnée)

**Fait :** tout produisait, tout décidait, et **plus rien ne collectait**. Les observations avaient
été peuplées **une fois** — backfill du 2026-07-21 — puis figées : `observations.ts` (301 lignes,
5 upserts) n'était **importé par aucun appelant**, le piège AGT-000 mot pour mot. Pendant ce temps
le cron legacy `/api/cron/gsc-snapshot` pullait GSC dans une **boucle `for` sérielle hors de la
file** : sans `run_id`, sans classe d'erreur, sans plafond, sans refroidissement — et n'écrivait que
les tables legacy. Les deux séries étaient à égalité **par coïncidence** (semaine `2026-07-06` des
deux côtés) et allaient diverger au lundi suivant, le détecteur décidant alors sur des mesures d'une
semaine de plus **chaque** semaine, en silence. **Zéro DDL** (58 tables, zéro dérive).

- **Les 6 projets partagent UN service account** (`indexing-api@jonlabs.iam.gserviceaccount.com`),
  donc **un seul pool de quota** — mesuré, pas supposé. C'est exactement la prémisse sur laquelle
  JOB-006 avait armé son refroidissement provider, et `collect:gsc_query_page` en est le **premier
  consommateur réel** : le premier projet refoulé met toute la cohorte au repos au lieu que les
  cinq suivants brûlent un report chacun.
- **L'erreur devient STRUCTURÉE, et c'est le cœur du lot côté file.** `gsc-analytics.ts` jetait
  `new Error("GSC API 429 pour siteUrl=…")` — une **chaîne**. `classifyJobFailure` cherche
  `status`/`statusCode`/`code` sur l'objet, n'en trouve aucun, et ne retombait sur la bonne classe
  **que si** les 200 premiers caractères du corps Google contenaient `rateLimitExceeded`. La file
  classait donc un quota au petit bonheur — et un quota mal classé part en **dead-letter
  permanente**. `GscApiError` porte `status`, `reason` et `retryAfter` ; les 7 cas sont prouvés en
  base, dont les deux que Google fait à l'envers : **403 `rateLimitExceeded` → `quota`** (pas
  `permanent`) et **400 `invalid_grant` → `auth`**.
- **RIEN n'est écrit avant la fin de la pagination.** Un upsert n'efface jamais : une collecte
  coupée à la page 3/5 laisserait une semaine **tronquée qui se LIT comme complète**, et le
  détecteur y verrait une chute — le faux signal que GSC-006 interdit. On tamponne en mémoire, puis
  on écrit. Prouvé : un échec en cours laisse le compte **inchangé**.
- **Une semaine à zéro ligne n'efface rien** — conséquence directe du choix upsert-only, et
  différence assumée avec le legacy, qui faisait `delete` + `insert`.
- **BUG DE DONNÉES TROUVÉ EN VÉRIFIANT, antérieur à ce lot.** La recollecte de `jonlabs` semaine
  `2026-07-06` rendait **271 lignes / 981 impressions** contre **227 / 720** en base. Ce n'était pas
  le collecteur : **5 projets sur 6** ont eu cette semaine tirée **un jour après sa fin** (tous à
  10h55 le 13/07 — un backfill manuel, pas le cron, qui à cette date aurait tiré la semaine du
  29/06 vu la latence de 3 jours). La semaine la plus récente des observations — celle qui pèse le
  plus dans le détecteur — était donc **sous-comptée de 36 % en impressions**. Le collecteur la
  répare en la recollectant. Contre-épreuve : une semaine **consolidée** (`2026-06-29`) reproduit le
  snapshot legacy **au chiffre près** (261 lignes / 820 impressions) — l'arithmétique est bien celle
  du chemin historique.
- **Un seul fetch, double écriture** (décision de Jonathan). Le même tampon alimente les
  observations (canon, lues par le détecteur) **et** les tables legacy + le diff hebdo (lues par le
  dashboard et `/seo-weekly` · `/seo-actions`). Deux pulls de la même semaine consommeraient deux
  fois le quota d'un compte partagé. `gsc-snapshot` sort de `vercel.json` ; la route reste, pour le
  manuel.
- **Trois modules ont dû devenir chargeables hors runtime SvelteKit**, sans quoi aucune preuve sur
  Neon n'était possible — le second blocage d'AGT-000, à l'identique. `crypto.ts` importait `$env`
  **statiquement** → scindé en `crypto-core.ts` **pur** (clé en paramètre) + wrapper.
  `observations.ts` et `integrations.ts` importaient `db` statiquement → client injecté.
  `computeWeeklyDiff` a dû quitter `gsc-analytics.ts` (qui, lui, garde son `db` statique) pour
  `gsc-weekly-diff.ts` : le collecteur doit pouvoir le rappeler, sinon l'écran affiche des KPI figés
  au-dessus de données fraîches.
- **Deuxième bug latent corrigé avant sa première occasion de mordre** : `integrations.ts` écrivait
  ses horodatages en **ISO** dans des colonnes dont le DEFAULT est au format DB — et `computeHealth`
  **compare ces chaînes lexicalement** (`'T'` 0x54 > `' '` 0x20). Rien n'avait cassé **parce que la
  table était vide** (0 ligne, vérifié) ; ce lot est le premier à y écrire. Même correction sur
  `observations.ts`, ce qui **clôt la dette `fetched_at` en ISO** nommée dans les quatre derniers
  blocs de session.
- **Le catalogue hebdo passe à la PROFONDEUR 3** : `collect` → `detect` → `propose`, arêtes
  obligatoires. Conséquence JOB-004 à connaître : un skip se propage en **N-1 passes**, donc si la
  collecte meurt, `detect` est sauté au tour à vide suivant et `propose` seulement au tick
  **d'après**.
- **Un test qui affirmait le faux a été corrigé, pas le code.** L'assertion « `rowKey` ne
  collisionne pas » était fausse : `join('\x1f')` collisionne si `\x1f` apparaît dans un champ.
  Durcir `rowKey` seul l'aurait fait **diverger de `rollupPagesFromQueryPage`**, qui groupe avec le
  même séparateur — la déduplication et l'agrégation n'auraient plus été d'accord. L'invariant est
  désormais **documenté et testé tel qu'il est**.
- Vérif : `npm run test` = **612/612** (+37) · `npm run check` = **0 err / 42 warn** (baseline) ·
  **aucun DDL**, introspection = **58 tables, zéro dérive** ·
  **`scripts/gsc-002-collector-proof.ts` = 44/44 vertes sur Neon**, **rejouée trois fois**, base
  rendue à l'identique · non-régression : `job-006-limits-proof`, `job-005-schedule-proof`,
  `job-004-dag-proof`, `job-007-console-proof`, `job-003-retry-proof`, `job-002-recovery-proof`,
  `agt-000-proposer-proof`, `find-003-lifecycle-proof`, `job-claim-concurrency` — **0 échec
  chacune** · **13 findings** et **4 propositions** intacts · **0 horodatage ISO** · routes sondées
  en dev (port 5175) : `/api/cron/tick` → **401** sans bearer, **401** avec un mauvais, **200** avec
  le bon ; `/jobs` → **303** `/login`.
- **Chaîne réelle démontrée** : les 6 projets passent `--test-access` contre le vrai Google ; une
  collecte réelle sur `jonlabs` a écrit la semaine **`2026-07-13`** — que les observations
  **n'avaient jamais eue** — les faisant passer de **16 à 17 semaines** ; `project_integrations` a
  reçu sa **première ligne** (`healthy`, `active`, `secret_ref` pointeur) ; et la fenêtre du
  détecteur avance pour la première fois depuis le backfill : **2026-06-22 → 2026-07-19**, 1048
  observations, 487 couples.

**Acceptations couvertes.** (1) « un rerun retourne les mêmes totaux sans duplication » : deux
collectes de la même semaine → **0 ligne créée**, totaux identiques, et une mesure qui change est
**rafraîchie** et non ajoutée ; (2) « pagination et lignes nulles sont testées » : une semaine à
zéro ligne n'échoue pas et **n'efface rien**, un échec en cours de pagination n'écrit **rien**, un
doublon de clé est dédupliqué **avant** l'INSERT (Postgres refuserait tout le lot) ; (3) GSC-001
« les cinq projets peuvent être testés indépendamment, une erreur d'un projet n'affecte pas les
autres » : `--test-access` isole projet par projet, les six sont verts ; (4) GSC-001 « aucun
credential n'est stocké dans un payload de job » : `secret_ref` ne porte qu'un **pointeur**
(`indexing_credentials:{id}`) et `configuration_json` passe `assertNoInlineSecret`.

**Prochain :** l'**inbox UI** qui affiche findings ET propositions (E11/DASH-005) — tout est en
base, rien ne le montre encore · **GSC-004** (fenêtres 7/28/90 j, backfill borné, périodes
incomplètes) · **IDX-001/002** (sitemap, URL Inspection), qui donneront au graphe hebdo ses arêtes
profondes.

**Pièges :**
- **Une semaine du passé n'est PAS immuable.** GSC complète ses données après coup : recollecter
  une semaine ancienne en change légitimement les chiffres **à la hausse**. C'est une réparation,
  pas une dérive — mais un écart entre deux lectures d'une même semaine ne doit pas se
  diagnostiquer comme un bug du collecteur.
- **La latence de 3 jours ne suffit pas à consolider une semaine.** Preuve à l'appui : les semaines
  tirées **1 jour** après leur fin sont sous-comptées de ~36 % ; celles tirées **4 jours** après
  sont exactes. `latestCompleteWeekStart` vise déjà 8+ jours — **ne jamais tirer une semaine à la
  main plus tôt**, c'est ce qui a corrompu la semaine `2026-07-06` de 5 projets.
- **Les 5 semaines `2026-07-06` sous-comptées ne sont PAS encore réparées** (seul `jonlabs` a été
  recollecté, et sur `2026-07-13`). Les réparer = `npx tsx scripts/collect-gsc.ts --project=all
  --week=2026-07-06`. Décision laissée à Jonathan : c'est un pull GSC de 6 projets d'un coup.
- **La double écriture legacy est une DETTE datée**, pas un design : elle disparaît quand l'écran
  lira les observations (E06/GSC-003). Tant qu'elle vit, les deux écritures doivent rester dans la
  même foulée — sinon l'écran et le détecteur divergent, ce qu'on vient de corriger.
- **`gsc-analytics.ts` garde son `db` statique** : ne jamais l'importer depuis un module qui doit
  tourner dans un runner `tsx`. C'est pourquoi le diff a été extrait.
- **Une preuve interrompue saute son `cleanup()`** : vérifier la semaine sentinelle `2019-01-07`
  après toute interruption (`gsc_query_page_data` → `gsc_snapshots` → `gsc_weekly_diffs` →
  observations → `project_integrations`).
- **`= ANY($n)` casse avec le driver Neon** — tout filtre de liste en `IN (…)` paramétré (rappel).
- Toujours en suspens hors GSC-001/002 : purge destructive (DATA-008 `--execute`) = session dédiée ·
  **CONTRACT différé** · `ai_jobs → jobs` **écarté** · `post_publish:check` planifiable sans handler
  (E03) · **rien ne bat tant que ce n'est pas déployé** · au 1er tick hebdo, `barberconcept` écrira
  ses **50 findings** (décision maintenue) — mais désormais **après une vraie collecte**, plus sur
  des mesures figées au 2026-07-06.

**Commit :** `24fd03e` [hub] add: GSC-001+002 collecteur GSC gouverné par la file

---

## Etat session 2026-07-23 (JOB-006 — la file cesse de découvrir le 429 un job à la fois)

**Fait :** JOB-003 savait **réagir** à un quota (429 classé `quota`, tentative rendue, `deferrals`
qui borne la boucle) — mais rien ne le **prévenait**, et le trou se voyait à trois endroits. (1) Six
projets sur le même compte GSC : le premier se fait refouler, les **cinq suivants partent quand
même** et brûlent un report chacun. Rien ne disait au deuxième ce que le premier venait
d'apprendre. (2) Le tick sert 25 jobs par priorité puis ancienneté : un projet volumineux pouvait
**remplir le tick entier** et repousser les cinq autres d'une heure — l'acceptation « un site
volumineux ne monopolise pas les workers » n'était tenue par rien. (3) Aucune capacité réservée aux
avis et alertes (SLO §17.3). **Un seul DDL** : `system_settings`, table additive et vide.

- **La garde est DANS la réclamation, comme en JOB-004.** `claimJob` gagne un paramètre
  `capacity` — exclusions de types, de projets, réserve — et les applique en SQL. Ce n'est pas le
  worker qui filtre après coup : aucun appelant futur ne peut l'oublier, et deux workers concurrents
  la subissent tous les deux. Prouvé en base : le même job est refusé **avec** la garde et réclamé
  **sans** elle, alors qu'il est parfaitement disponible.
- **Une table de config, et c'est assumé.** Le « zéro DDL » des trois derniers lots était un
  **constat** (« tout était là depuis DATA-003 »), pas une règle : ici il n'y avait rien.
  L'acceptation exige des limites « configurables sans redéploiement », et sur Vercel une variable
  d'env n'est relue **qu'au redéploiement**. `gmb_settings` est bien un KV et sert déjà à des clés
  non-GMB, mais y ranger les quotas GSC ferait mentir son nom à la prochaine lecture. La table naît
  **vide** : sans ligne, `resolveLimits` rend les défauts du code — appliquer le DDL ne change donc
  **aucun** comportement, c'est y écrire qui en change un.
- **Le refroidissement est DÉRIVÉ, jamais stocké.** Un échec `quota` dans `job_attempts` (table
  append-only, déjà écrite) met **tout le provider** au repos pour sa cohorte. Aucun état de repos
  n'est persisté — même raison qu'au « zéro table de planification » de JOB-005. C'est aussi
  pourquoi ce lot **n'écrit pas** `project_integrations.health_status = 'quota_limited'` (SPEC
  §17.1) : ce serait un second état, dont personne ne serait clairement propriétaire du retour à
  `healthy`. Dette **nommée**, laissée à OPS-002.
- **Le report de capacité n'est PAS un report de JOB-003.** La passe de refroidissement pousse
  `available_at` et pose `last_error_class='quota'` / `last_error_code='QuotaLimited'`, **sans
  toucher ni `attempts` ni `deferrals`** : ces jobs n'ont pas été réclamés, ils n'ont rien tenté,
  personne ne leur doit un échec. Aucune ligne de `job_attempts` non plus — cette table dit
  « une tentative a eu lieu », et il n'y en a pas eu. Vérifié en base sur les trois jobs d'une
  cohorte, dont un d'un autre projet.
- **L'équité est un TOUR, pas un quota de drain.** Chaque projet prend au plus `perProjectPerLap`
  jobs ; quand tous ceux qui ont du travail servable ont eu leur part, un **nouveau tour s'ouvre** et
  les exclusions tombent. Un tick qui s'arrêterait avec du budget et une file pleine serait pire
  qu'un tick déséquilibré. Le calcul de réouverture vit dans le module **pur**, donc un test le
  ferme. Prouvé en base : 6 jobs pour le gros projet, 2 pour le petit, un seul drain → ordre
  `AABBAAAA`, **2 tours**.
- **BUG TROUVÉ PAR LA PREUVE, et il était grave** : `projectsWithClaimableWork` ignorait les
  **types que le worker sait traiter**. Un projet dont le seul travail en file est d'un type que ce
  worker ne gère pas comptait comme « en attente d'être servi » — et, n'étant jamais servi,
  **empêchait le tour de se rouvrir pour toujours**, affamant les projets réellement servables. Le
  compteur `throttledTicks`, ajouté quelques minutes plus tôt, est ce qui a rendu le diagnostic
  lisible. Corrigé : la photo filtre sur les types de l'appelant.
- **Un job dont le BAIL A EXPIRÉ ne compte pas comme « en cours ».** `status='running'` ne suffit
  pas : c'est la définition même de l'abandon (JOB-002), le reaper n'est simplement pas encore
  passé. Le compter occuperait une place de concurrence **au nom d'un worker mort**, et quelques
  workers morts suffiraient à geler la file jusqu'au prochain reaper. Le bail est le seul titre de
  propriété vivant.
- **`0` vaut « pas de limite », partout et sans exception** (même sémantique que `maxJobs`). Une
  limite absente ou illisible retombe sur le **défaut du code**, jamais sur « aucune limite » ni sur
  « file éteinte » — une file arrêtée en silence est le pire mode de panne, celui qui ne se plaint
  pas. `formatQuota` rend donc `3/∞` et jamais `3/0`.
- **Un type INCONNU vaut `none`, et c'est le choix INVERSE de `required` (JOB-004)** — délibérément.
  Là-bas, relâcher la garde sur ce qu'on n'avait pas su lire faisait tourner un job sur des données
  absentes. Ici, la resserrer sur un type qu'on ne connaît pas empêcherait **tout nouveau handler**
  de démarrer, alors qu'un type non déclaré reste soumis aux plafonds global et projet.
- **Un worker bridé ne doit jamais se lire comme un worker inactif** : `throttledTicks` distingue
  « la file était vide » de « on n'avait pas le droit de prendre ». Sans lui, un tick bridé produit
  exactement les mêmes statistiques qu'un tick tranquille, et l'exploitant conclut « la file est
  vide » devant une file pleine.
- Vérif : `npm run test` = **575/575** (+52) · `npm run check` = **0 err / 42 warn** (baseline) ·
  introspection = **58 tables, zéro dérive** (l'écart est `system_settings` et **uniquement** lui) ·
  **`scripts/job-006-limits-proof.ts` = 33/33 vertes sur Neon**, **rejouée trois fois**, base rendue
  à l'identique · non-régression : `job-004-dag-proof` 44, `job-005-schedule-proof` 33,
  `job-007-console-proof` 46, `job-003-retry-proof` 44, `job-002-recovery-proof` 31,
  `agt-000-proposer-proof` 41, `job-claim-concurrency` 22 — **0 échec chacune** · **13 findings** et
  **4 propositions** intacts · **0 horodatage ISO** · routes sondées en dev (port 5174) :
  `/api/cron/tick` → **401** sans bearer, **401** avec un mauvais, **200** avec le bon ; `/jobs` →
  **303** `/login`.
- **Chaîne réelle démontrée** : un tick authentifié a planifié les **6 créneaux quotidiens**
  (`findings:lifecycle`, 6 projets), les a **drainés dans la même invocation**, et le tick suivant
  n'a **rien recréé ni rien réclamé** (idempotence). Le bloc `capacity` de la réponse est exposé.

**Acceptations couvertes.** (1) « un site volumineux ne monopolise pas les workers » : deux projets,
un seul drain, ordre `AABBAAAA` — le petit est servi **dans le premier tour**, pas après le gros ;
(2) « les limites sont configurables sans redéploiement » : écrites en base par `scripts/limits.ts`,
**relues par le worker** dans la preuve (`perProjectPerLap` 5 → 2), et une valeur hors bornes est
**annoncée comme ignorée** au lieu d'être crue appliquée ; (3) « les reports continuent avec statut
`quota_limited` lorsque possible » : la cohorte entière est repoussée, `last_error_class='quota'` /
`last_error_code='QuotaLimited'`, `attempts` et `deferrals` **inchangés**, jobs toujours `queued`,
et le refroidissement expiré les rend réclamables **sans intervention**.

**Prochain :** l'**inbox UI** qui affiche findings ET propositions (E11/DASH-005) — tout est en base,
rien ne le montre encore · les **collecteurs E03**, qui donneront enfin de vrais consommateurs aux
budgets provider armés ici.

**Pièges :**
- **Le budget par fenêtre compte des JOBS, pas des APPELS API.** Une détection = N appels GSC. C'est
  un garde-fou grossier ; la vraie prévention est portée par le **refroidissement**. Le compte fin
  viendra avec E03, quand quelque chose pourra réellement l'écrire — pas avant (piège AGT-000 : un
  module complet que personne n'appelle).
- **Aucun type de job n'appelle de provider AUJOURD'HUI** (la détection lit la base, le producteur
  est déterministe). `PROVIDER_BY_JOB_TYPE` est donc **armé** pour E03 — dont `post_publish:check`,
  déjà déclaré `gsc`. C'est voulu : le harnais doit exister **avant** le premier collecteur, sinon
  le premier run sur six projets redécouvre le 429 six fois.
- **La réserve ne mord pas encore** : `reviews:sync` et `alerts:notify` n'ont pas de handler
  (E03/E06). Le mécanisme est prouvé, son cas d'usage n'existe pas encore.
- **Une preuve qui laisse tourner des jobs DOIT désarmer la capacité** (`capacityRefreshEvery: 0`).
  `job-claim-concurrency` laisse délibérément 8 jobs `running` : le plafond global (4) refusait donc
  — **correctement** — toute réclamation, et sa boucle sans `once` attendait un job qu'elle n'avait
  pas le droit de prendre. Trois processus zombies plus tard, le diagnostic a coûté cher.
- **Tuer une preuve en cours de route saute son `cleanup()`.** Quatre exécutions interrompues ont
  laissé **44 lignes `__test_claim` dans la vraie file** — que le prochain tick aurait réclamées puis
  envoyées en dead-letter. Purgées via `jobs-purge-test.ts` (dry-run vérifié, `starts_with`, jamais
  `LIKE` où `_` est un joker). Vérifier `--capacity` ou la file après toute interruption.
- **`= ANY($n)` casse avec le driver Neon** — tout filtre de liste en `IN (…)` paramétré (rappel).
- **`projectsWithClaimableWork` doit TOUJOURS refléter ce que l'appelant peut servir** (types +
  `DEPENDENCY_GATE`, importée et non recopiée). Toute divergence y fige le tour d'équité.
- Toujours en suspens hors JOB-006 : purge destructive (DATA-008 `--execute`) = session dédiée ·
  **CONTRACT différé** · `ai_jobs → jobs` **écarté** · `post_publish:check` planifiable sans handler
  (E03) · **`observations.ts` écrit encore `fetched_at` en ISO** · **rien ne bat tant que ce n'est
  pas déployé** · au 1er tick hebdo, `barberconcept` écrira ses **50 findings** (décision maintenue)
  — mais depuis ce lot il ne prendra plus le tick entier.

**Commit :** `84a18ff` [hub] add: JOB-006 limites de concurrence, équité entre projets et quotas provider

---

## Etat session 2026-07-22 (JOB-004 — l'ordre de service devient une dépendance)

**Fait :** le catalogue hebdo enfilait `detect` **puis** `propose`, et son propre commentaire le
disait : `priority: 10` contre `8` était **un ordre de SERVICE, pas une dépendance**. Rien
n'attendait rien. Deux workers, ou un détecteur reporté pour quota, et le producteur travaillait
sur les findings de la **semaine précédente** — en silence, l'idempotence évitant les doublons sans
rien dire du décalage. La colonne `jobs.depends_on` existait depuis DATA-003 (« JSON array d'ids de
jobs prérequis, §6.2 ») et **n'avait jamais été ni écrite ni lue** ; `STEP_STATUSES` portait
`skipped` depuis DATA-003 sans que personne ne l'écrive. **Zéro DDL** (57 tables, zéro dérive) :
tout était là, rien ne s'en servait.

- **La garde est DANS la réclamation, pas dans le worker.** `claimJob` gagne une condition, et c'est
  ce qui rend la promesse structurelle : aucun appelant futur ne peut l'oublier, et deux workers
  concurrents la subissent tous les deux. Un dépendant n'est pas réclamable si **un** prérequis est
  encore `queued`/`running` — obligatoire **ou optionnel**, parce que le lancer pendant que l'autre
  écrit ses données le ferait travailler sur un état à moitié posé.
- **La seconde moitié de la garde n'est pas cosmétique** : elle bloque aussi les **obligatoires
  déjà morts**. Sans elle, un dépendant dont le prérequis vient de mourir partirait **avant** que la
  passe de résolution ne l'ait marqué `skipped` — une course, et le job tournerait pour rien.
- **Un prérequis OPTIONNEL mort ne bloque personne** — c'est littéralement l'acceptation « Plausible
  indisponible ne bloque pas un rapport GSC ». Prouvé en base : prérequis `dead`, le dépendant
  optionnel s'exécute et finit `succeeded`, le dépendant obligatoire est sauté.
- **`required` vaut `true` par défaut, à tous les niveaux** (JSON sans la clé, `->> 'required'`
  valant `NULL` en SQL, catalogue sans `required`). On ne relâche jamais une garde sur ce qu'on n'a
  pas su lire — miroir exact de « une erreur illisible retombe sur `retryable` » (JOB-003).
- **`skipped` est un statut à part, pas un `cancelled`** (décision de Jonathan). `cancelled` est une
  décision **humaine**, avec un acteur et une raison au journal (JOB-007) ; ici personne n'a rien
  décidé. Les confondre ferait dire à `explainFailure` « annulé par un opérateur » là où la cause est
  ailleurs — dans le prérequis — et enverrait l'opérateur relancer le mauvais job.
- **Le skip n'est pas un cul-de-sac.** `requeueDeadJob` accepte désormais `skipped` : rien ne
  ressuscite un statut terminal, même une fois le prérequis réparé et réussi. Sans cette reprise on
  rouvrait exactement le cul-de-sac que JOB-003 avait fermé pour la dead-letter. L'ordre est dans
  `explainFailure` : **le prérequis d'abord**, le dépendant ensuite.
- **Bug trouvé en écrivant les tests (dans ce lot, corrigé avant la première ligne de base)** :
  `latestAttemptPerStep` trie sur le TEMPS, pas sur `attempt`. Le réflexe — « la tentative la plus
  haute gagne » — est **faux ici**, parce que `requeueDeadJob` remet `attempts` **à zéro** : la
  tentative qui réussit après une reprise porte un numéro **plus petit** que celle qui est morte.
  Trier sur `attempt` aurait gardé le verdict d'échec **pour toujours**. Le comparateur normalise en
  prime le séparateur (`'T'` 0x54 > `' '` 0x20), le piège que `timestamps.ts` documente.
- **Le statut de run était déjà faux avant ce lot** : `recomputeRunStatus` agrégeait **toutes** les
  lignes de `monitoring_steps`, tentatives multiples comprises. Un job mort puis repris et réussi
  laissait son run `partial` **à vie**. Réduit au dernier verdict par `step_type` — hors périmètre
  déclaré, mais c'est la moitié « calculer le statut final du run » du backlog.
- **La passe de résolution est une jumelle du reaper** : bornée, non bloquante, jouée au **démarrage**
  et à **chaque tour à vide** — donc **avant** le `break` de `once`, ce qui permet à un même tick de
  planifier, exécuter, et conclure le run. Aucun état nouveau n'est persisté : l'attente est
  **dérivée** de `depends_on` + statut des prérequis. Même raison qu'au « zéro table de
  planification » de JOB-005 — deux états qui peuvent diverger valent moins qu'un seul qui se
  recalcule.
- **Le graphe est validé UNE fois, avant toute écriture**, et pour toutes les cadences. La règle est
  plus forte qu'une absence de cycle : chaque prérequis doit être déclaré **strictement avant** son
  dépendant, ce dont `planOne` a besoin (il résout les ids au fil de la mise en file) et ce qui exclut
  du même geste l'auto-dépendance et les cycles. Une erreur y **lève** : le catalogue est un littéral
  du code, pas une donnée douteuse.
- **`enqueueJob` sérialise lui-même la colonne** (`dependsOn: JobDependency[]`, plus jamais du texte).
  La garde casse `depends_on` en `jsonb` : une valeur malformée y ferait échouer la requête de
  réclamation **entière**, donc la file, pas seulement le job fautif.
- Vérif : `npm run test` = **523/523** (+59) · `npm run check` = **0 err / 42 warn** (baseline) ·
  **aucun DDL**, introspection = **57 tables, zéro dérive** · **`scripts/job-004-dag-proof.ts` =
  45/45 vertes sur Neon**, **rejouée trois fois**, base rendue à l'identique · non-régression :
  `job-005-schedule-proof`, `job-007-console-proof`, `job-003-retry-proof`, `job-002-recovery-proof`,
  `agt-000-proposer-proof`, `job-claim-concurrency` — **0 échec chacune** · **13 findings intacts**,
  **4 propositions intactes** · routes sondées en dev : `/api/cron/tick` → 401 sans bearer, **401
  avec un mauvais**, **200 avec le bon** (0 occurrence due, aucune détection déclenchée), `/jobs` et
  `/jobs/[id]` → 303 `/login`.
- **Chaîne réelle démontrée, en UN seul drain** : le prérequis part (priority 10), meurt en
  `permanent` (403 nu) → dead-letter **à la première tentative** avec son step `failed` → le
  dépendant **optionnel** devient réclamable et réussit → le dépendant **obligatoire** ne l'est
  jamais, et c'est la passe du tour à vide qui le conclut `skipped` → **run `partial`**.

**Acceptations couvertes.** (1) « un collecteur GSC échoué bloque les détecteurs qui en dépendent » :
le dépendant n'est pas réclamable tant que le prérequis est `queued`, ni pendant qu'il `running`, ni
après sa mort — et la garde est dans la réclamation, pas dans un appelant ; (2) « Plausible
indisponible ne bloque pas un rapport GSC » : prérequis `dead` + arête optionnelle → le dépendant
s'exécute et finit `succeeded` ; (3) « le rapport indique précisément les données manquantes » : le
step sauté porte `DependencySkipped` et **nomme le prérequis et son état**, le run vaut `partial`
(ni succès, ni échec total), et le journal garde qui a décidé (`system:dependency`) et sur quelles
arêtes. Débloque **GSC-002**, **IDX-001**, **DASH-002**, **REP-001**, **OPS-002**.

**Prochain :** **JOB-006** (prévenir le 429 au lieu d'y réagir) · l'**inbox UI** qui affiche findings
ET propositions (E11/DASH-005) — tout est en base, rien ne le montre encore · les collecteurs E03,
qui donneront enfin des arêtes profondes au graphe §8.2.

**Pièges :**
- **La garde lit du JSON dans le chemin CHAUD.** Un `depends_on` malformé casserait le cast et donc
  la réclamation de **toute la file**. C'est pourquoi `enqueueJob` sérialise lui-même et n'accepte
  plus de texte libre — ne jamais écrire cette colonne à la main, ni en SQL, ni dans une preuve.
- **Ne jamais trier les tentatives d'un step par `attempt`.** `requeueDeadJob` remet le compteur à
  zéro : le verdict le plus récent peut porter le plus petit numéro. C'est `finished_at` qui fait foi.
- **Une chaîne de profondeur N se résout en N-1 passes** (le prérequis intermédiaire doit d'abord
  devenir `skipped` pour que le skip cascade). Le catalogue actuel est de profondeur 2 : une passe
  suffit. Un graphe plus profond (collecteurs E03) prendra un tick de plus par niveau — acceptable,
  mais à savoir avant de conclure qu'un job « ne part pas ».
- **`propose:actions` ne tournera plus une semaine où la détection meurt.** Conséquence assumée de la
  décision : c'est le run `partial` qui le dit, au lieu de propositions fondées sur des mesures
  périmées.
- **Un job sauté ne repart JAMAIS tout seul**, même prérequis réparé. C'est volontaire (rien ne
  ressuscite un statut terminal) et c'est pour ça que la reprise manuelle l'accepte.
- **Le catalogue doit rester déclaré dans l'ordre topologique.** `validateCatalogGraph` lève sinon —
  au démarrage de `planDueJobs`, avant toute écriture.
- **Une ligne héritée au format ISO traîne dans `monitoring_steps`** (run manuel de `detect.ts`
  d'avant sa correction). Inoffensive — le comparateur normalise le séparateur — mais nommée :
  supprimer la ligne d'un vrai run est une décision, pas un nettoyage.
- **Reste à vérifier de visu** (inchangé depuis JOB-007) : le rendu de `/jobs` et `/jobs/[id]` n'a pas
  pu être constaté — aucune session admin ouverte, et fournir un mot de passe est exclu. Le
  chargement serveur est vérifié (303 vers `/login`, `npm run check` vert).
- Toujours en suspens hors JOB-004 : purge destructive (DATA-008 `--execute`) = session dédiée ·
  **CONTRACT différé** · `ai_jobs → jobs` **écarté** · `post_publish:check` **planifiable sans
  handler** (E03) · **`observations.ts` écrit encore `fetched_at` en ISO** · **rien ne bat tant que
  ce n'est pas déployé** · au 1er tick, `barberconcept` écrira ses **50 findings** (décision de
  Jonathan : on les laisse partir) — et son `propose:actions` **attendra** désormais la fin de cette
  détection au lieu de partir en parallèle.

**Commit :** `c0d3dd4` [hub] add: JOB-004 dépendances entre jobs, skip propagé, statut de run exact

---

## Etat session 2026-07-22 (AGT-000 — un finding devient enfin une action)

**Fait :** la chaîne SPEC `observations → détecteurs → findings → PROPOSITIONS → approbation`
s'arrêtait net après `findings`. **En amont tout produisait** (13 findings en base, détectés,
scorés, avec leur cycle de vie) ; **en aval tout attendait** — `proposals.ts`/`proposal-state.ts`
(DATA-006) et `policies.ts` (DATA-007) étaient **complets et jamais appelés**, leurs 3 tables
vides. **Au milieu, rien** : `findings.ts` (609 lignes) n'exposait **que de l'écriture**. Le
producteur ferme le trou. **Zéro DDL** (57 tables, zéro dérive) : tout existait depuis DATA-006.

- **Déterministe, sans IA — délibérément.** La structure d'une proposition (type d'action, cible,
  **niveau L0–L4**, risque) sort d'une table figée, comme le détecteur sort son fait d'une
  arithmétique. Faire écrire cette structure par un modèle rendrait le **niveau d'autorisation
  lui-même** non déterministe, c'est-à-dire qu'un modèle pourrait s'accorder un L4 — précisément
  l'invariant que `canActorApprove` existe pour interdire. L'agent IA viendra *rédiger* et
  *regrouper*, sur un squelette déjà gouverné et déjà borné (SPEC §3.3, §12.2).
- **LE PIÈGE CENTRAL : le payload hashé ne doit contenir AUCUNE mesure hebdomadaire.**
  `createProposal` dédup sur `payload_hash`. Une position à la décimale dans le payload (7.4 cette
  semaine, 7.1 la suivante) produirait un hash neuf **à chaque run**, donc une proposition neuve :
  **l'inbox doublerait toutes les semaines** sans qu'aucune garde ne bronche — un mode de panne
  silencieux, progressif, et qui ne ressemble pas à un bug. Le payload ne porte donc que
  l'identité et l'intention ; les chiffres du moment vivent dans `rationale`/`expected_impact`
  (**non hashés**, donc rafraîchis à chaque run) et dans `input_hashes_json`. Un test dédié
  verrouille l'invariant : mêmes findings, mesures différentes → **payload identique**.
- **Les niveaux viennent littéralement de §12.1**, pas d'une intuition : « plan de refresh » y est
  **L2**, « modification contenu » **L3**, « 301, canonical, suppression, désindexation » **L4**.
  D'où le choix d'action de `keyword_opportunity`, tranché par la **position** : ≤ 10 → la page est
  déjà servie, c'est le snippet qui ne convertit pas → `meta_rewrite` (**L3**) ; > 10 → réécrire le
  snippet ne suffit pas, il faut d'abord gagner des places → `refresh_plan` (**L2**, un brouillon).
  **Une seule action par finding** : en proposer deux ne dirait rien de plus et doublerait l'inbox.
- **Le risque vient de l'ACTION, pas de la gravité du problème.** Un finding critique ne rend pas
  plus risqué d'écrire un brouillon. La seule modulation retenue est celle qui a un sens réel :
  toucher une page **qui reçoit déjà des clics expose un acquis** (≥ 10 clics/sem → `medium` monte
  à `high`). Écart assumé au plan, qui prévoyait `deriveRiskLevel(actionType, severity)`.
- **Plafond conservateur, conséquence directe de la décision `barberconcept`.** En laissant partir
  ses 50 findings, un producteur sans garde écrirait 50 propositions d'un coup et l'inbox de
  propositions naîtrait aussi inutilisable que celle des findings. Défauts : `minPriority = 60`
  (aligné sur `findings list --min-priority 60`, §11.2) et `maxProposals = 10` par projet et par
  run. `matched` **complet** est exposé à côté de `selected` (leçon FIND-003) et la troncature
  s'annonce avec le total réel.
- **La supersession ne réécrit jamais une décision prise.** Seules les propositions encore
  **ouvertes** (`proposed`/`invalidated`) sont périmées. Une proposition **`approved`** dont le
  payload ne reflète plus la réalité pose un vrai dilemme : la périmer efface une décision
  humaine, la laisser filer ferait exécuter une action sur un état périmé. Elle est donc
  **remontée** (`staleApproved`) et **laissée intacte** — un humain tranche.
- **Deux gardes de rang différent sur le snooze/dismiss**, et c'est voulu : `listFindings` filtre
  par défaut sur `ACTIVE_STATUSES` (un finding en veille n'est **même pas lu**), et
  `selectProposableFindings` re-filtre. Un appelant futur qui élargirait les statuts ne casserait
  donc pas la promesse de silence du snooze ni le dismiss « à vie ».
- **Bug trouvé en vérifiant (hors périmètre, corrigé)** : `proposals.ts` et `policies.ts`
  écrivaient leurs horodatages en **ISO** (`new Date().toISOString()`) dans des colonnes dont le
  DEFAULT SQL est au format DB — exactement le piège lexical que `timestamps.ts` documente
  (`'T'` 0x54 > `' '` 0x20). `proposal-state.isApprovalValid` compare ces chaînes : deux formats
  mélangés y font expirer une approbation au mauvais moment. Rien n'avait cassé **parce que les
  tables étaient vides** ; ce lot est le premier à y écrire. Corrigé avant la première ligne.
- **Second blocage trouvé en vérifiant** : `proposals.ts`/`policies.ts` importaient `db`
  **statiquement** (`db/index.js` → `$env/dynamic/private`), donc **inchargeables hors runtime
  SvelteKit** — aucune preuve sur Neon n'était possible. Passés au client injecté de `findings.ts`
  (import dynamique, `client?` optionnel) : les appelants app ne changent pas.
- Vérif : `npm run test` = **464/464** (+50) · `npm run check` = **0 err / 42 warn** (baseline) ·
  **aucun DDL**, introspection = **57 tables, zéro dérive** · **`scripts/agt-000-proposer-proof.ts`
  = 41/41 vertes sur Neon**, **rejouée deux fois**, base rendue à l'identique (**13 → 13** findings,
  **0 → 0** propositions) · non-régression : `job-005-schedule-proof`, `job-007-console-proof`,
  `job-003-retry-proof`, `job-002-recovery-proof`, `job-claim-concurrency` — **0 échec chacune** ·
  **0 horodatage ISO** dans `action_proposals`/`agent_runs`/`proposal_approvals`.
- **Chaîne réelle démontrée** : `propose:actions` enfilé sur `jonlabs` → réclamé et exécuté par
  `runWorker` (`claimed: 1, succeeded: 1`) → **4 propositions** `meta_rewrite` **L3 `proposed`**
  (aucune auto-approuvée : aucun projet n'a de policy), `agent_run` **clos `succeeded`**, tentative
  journalisée. **Rejoué : 4 → 4, 0 créée, 4 rafraîchies**, et **4** `agent_comment` au journal des
  findings — pas 8.

**Acceptations couvertes.** (1) « rejouer sur des findings inchangés ne crée aucune proposition » :
prouvé en base (2 runs → 3 propositions, `created: 0` au second) **et en production** (4 → 4) ;
(2) « un agent ne peut approuver ni L3 ni L4, et rien ne part sans policy explicite » :
`approveProposal` **lève** pour un agent sur une L3, le refus **n'écrit rien** (statut inchangé),
et `decideAutoApproval` refuse **par défaut** sans policy — l'état de tous les projets aujourd'hui ;
(3) « un finding en veille, dismissé ou résolu ne produit aucune proposition » : les deux gardes
vérifiées en base, le finding n'est **même plus lu**.

**Prochain :** **JOB-004** (DAG de steps + statut `partial` — le scheduler met `detect` puis
`propose` en file mais **n'ordonnance rien** ; c'est la seule dépendance réelle qui manque au run
hebdo) · **JOB-006** (prévenir le 429) · l'**inbox UI** qui affiche findings ET propositions
(E11/DASH-005) — tout est en base, rien ne le montre encore.

**Pièges :**
- **Ne JAMAIS mettre une mesure dans `payload_json`.** C'est lui qui est hashé, donc lui qui porte
  la dédup. Tout ajout de champ volatil (date, compteur, position, impressions) fait exploser
  l'inbox semaine après semaine, sans erreur, sans log, sans test rouge — sauf celui qui garde
  l'invariant. Les chiffres vont dans `rationale`/`expected_impact`, jamais dans le payload.
- **Le catalogue `weekly` déclenche du VRAI travail sur les 6 projets** (rappel JOB-005), et il
  enfile désormais **deux** jobs par projet.
- **`priority: 8` contre `10` est un ordre de SERVICE, pas une dépendance.** Rien n'attend la fin
  du détecteur. Si le producteur passe d'abord (deux workers, un détecteur reporté pour quota), il
  travaille sur les findings de la semaine précédente et rattrape au tick suivant — acceptable
  **parce qu'il est idempotent**. Le vrai ordre est le périmètre de **JOB-004**.
- **Une preuve qui appelle le producteur DOIT passer `findingIds`.** Sans cette restriction, elle
  écrit des propositions sur les findings de **production** du projet qui l'héberge — le type doit
  être le vrai `keyword_opportunity` (sinon aucune action n'est dérivable), donc l'isolation ne
  peut pas passer par lui. Même raison d'être que le `catalog` substituable de `planDueJobs`.
- **Le nettoyage d'une preuve va enfants d'abord** : `proposal_approvals` → `action_proposals` →
  `agent_runs` → `finding_events` → `findings`. Et les `agent_runs` **ne portent aucun marqueur de
  test** (le producteur ne doit pas savoir qu'un test l'appelle) : ils se collectent **à la volée**.
- **`observations.ts` écrit encore `fetched_at` en ISO**, dans une table **peuplée**. Pas comparé
  lexicalement aujourd'hui (le détecteur filtre sur `week_start`) — dette nommée, non corrigée.
- **Un type de finding sans correspondance ne produit RIEN**, et c'est compté (`withoutAction`).
  Les 9 autres types du catalogue §10.4 n'ont pas encore de table d'actions.
- Toujours en suspens hors AGT-000 : purge destructive (DATA-008 `--execute`) = session dédiée ·
  **CONTRACT différé** · `ai_jobs → jobs` **écarté** · `post_publish:check` **planifiable sans
  handler** (E03) · **rien ne bat tant que ce n'est pas déployé** · au 1er tick, `barberconcept`
  écrira ses **50 findings** (décision de Jonathan : on les laisse partir).

**Commit :** `a0c6f59` [hub] add: AGT-000 producteur de propositions (findings → action_proposals)

---

## Etat session 2026-07-22 (JOB-005 — la file cesse d'attendre qu'on la lance)

**Fait :** JOB-001/002/003/007 avaient tout construit — réclamation atomique, bail vivant, reaper,
erreur classée, dead-letter reprenable, console d'exploitation — et **rien ne déclenchait rien** :
chaque bloc de session depuis JOB-002 répétait le même piège (« sur Vercel aucun worker permanent »),
et dans `/jobs` le bouton **Relancer remettait un job en file que personne ne venait prendre**. Un
tick horaire planifie désormais les cadences en heure métier puis **draine la file dans la même
invocation**. **Aucun DDL** (57 tables, zéro dérive) : la planification ne persiste aucun état.

- **Le créneau est LOCAL, l'instant en est dérivé.** Toute la mécanique DST tient dans ce choix :
  un créneau se nomme par ses champs `Europe/Zurich` (`2026-07-20T09:00`), jamais par un instant.
  Le lundi 09:00 métier s'écrit alors **08:00 UTC en hiver et 07:00 UTC en été** sans que sa clé
  logique ne bouge — et le retour à l'heure d'hiver ne peut **pas** produire de doublon, puisque
  02:30 local n'existe qu'une fois au calendrier même quand l'instant, lui, se présente deux fois.
- **`zonedFieldsToUtc` ne fait pas confiance à une passe unique.** Aux bordières, l'offset à
  appliquer n'est pas celui de l'instant qu'on calcule. Les **deux** offsets en vigueur autour du
  créneau (veille / lendemain) sont testés, et on garde ceux qui **se relisent bien** : deux
  candidats valides → créneau ambigu, on prend le **premier** instant (convention `compatible` de
  Temporal) ; **zéro** candidat → créneau inexistant (29 mars, 02:30), il **GLISSE à 03:30** au lieu
  d'être escamoté. Un créneau quotidien avalé une fois l'an serait un trou de monitoring muet.
- **Zéro table de planification — assumé.** Le non-double-déclenchement n'est pas gardé par un
  `last_fired_at` (qui peut diverger, se perdre au redéploiement, ou mentir) mais par la clé
  d'idempotence du créneau local, **déjà unique en base**. Conséquence : rejouer un tick, redémarrer
  à 09:00 et **rattraper un créneau manqué sont la même opération**, sans effet la deuxième fois.
  Prouvé en base : deux planifications du même créneau → 1 run, 1 job ; un tick **en retard de
  47 min** rattrape le même créneau sans rien créer.
- **La fenêtre de rattrapage (6 h) plutôt que « sommes-nous pile à l'heure ? »** — Vercel ne
  garantit pas la minute et un tick peut échouer. Regarder en arrière coûte zéro (idempotence), un
  créneau manqué est en revanche perdu pour de bon.
- **Le tick planifie ET draine.** Un scheduler seul aurait rempli une file que personne ne vide,
  avec en prime l'illusion que ça tourne. `runWorker({once})` s'arrête au premier tour à vide, un
  `AbortController` armé à **240 s** rend la main avant `maxDuration: 300` — un SIGKILL de
  plateforme ne repasserait par aucun `finally` et laisserait un job `running` jusqu'au reaper.
- **Le cron perd sa sémantique métier.** `0 * * * *` bat, et c'est `schedule-state.ts` qui sait
  quelle heure il est à Zurich. Ça **révise consciemment la décision du 2026-04-27** (« cron horaire
  avec dedup = gaspillage ») : c'est le seul moyen d'être exact sur les deux bascules sans permuter
  deux entrées saisonnières à la main, et le tick sert **aussi** de worker et de reaper.
- **Une cadence sans handler ne planifie rien** — trouvé en regardant la sortie du premier dry-run :
  `hourly` × 6 projets × 6 heures = **36 lignes par tick** pour n'exécuter personne. Elles sont
  écartées en amont et **nommées une fois** (`cadencesWithoutJob`), au lieu d'être répétées à chaque
  créneau. Le bruit finit toujours par cacher ce qui travaille.
- **Bug trouvé en vérifiant (hors périmètre, corrigé)** : un run planifié restait **`queued` à vie**.
  `classifyRunOutcome` dérive le statut d'un run de ses **steps**, et personne n'en écrivait pour un
  job de queue — la supervision aurait montré des runs éternellement en attente **au-dessus de jobs
  réussis**. `concludeRunStep` (non bloquante, comme la passe de reaper) écrit le step et recalcule
  le run, **aux seules issues terminales** : un job encore rejouable n'a rien conclu, et lui écrire
  un `failed` ferait basculer son run en échec avant la fin de la partie.
- Vérif : `npm run test` = **414/414** (+40) · `npm run check` = **0 err / 42 warn** (baseline) ·
  **aucun DDL**, introspection = **57 tables** (56 `seostats` + `core.entities`, convention
  `data-001-cartography.ts`), zéro dérive · **`scripts/job-005-schedule-proof.ts` = 33/33 vertes sur
  Neon**, **rejouée deux fois de suite** · non-régression : `job-007-console-proof` **vert**,
  `job-003-retry-proof` **vert**, `job-002-recovery-proof` **vert**, `job-claim-concurrency` **vert**
  · **13 findings intacts** · **0 horodatage ISO** · routes sondées en dev : `/api/cron/tick` → 401
  sans bearer, **401 avec un mauvais**, 200 avec le bon, **405** en POST ; `/jobs` → 303 `/login`.
- **Chaîne réelle démontrée** : `schedule.ts --execute` a planifié le créneau quotidien de
  `bisrepetita` (run `daily`, `triggered_by='schedule'`, `period_end='2026-07-22T07:00'`) → le tick
  l'a **réclamé et exécuté** (`claimed: 1, succeeded: 1`) → job `succeeded`, tentative journalisée,
  **run conclu en `success`** avec son step.

**Acceptations couvertes.** (1) « les tests couvrent les deux changements DST » : 2026-03-29 (02:30
inexistant → glisse à 03:30 ; lundi 09:00 = 08:00 UTC avant, 07:00 UTC après) et 2026-10-25 (02:30
doublé → une seule occurrence ; la journée de 25 h ne saute aucun créneau quotidien) — 38 tests purs,
plus la vérification en base des deux régimes ; (2) « un restart à 09:00 ne crée qu'un run logique » :
deux planifications → `created` puis `reused`, **1 run et 1 job en base**, et un tick postérieur ne
rejoue pas un créneau déjà exécuté ; (3) « la prochaine exécution est visible par projet » :
`listNextOccurrences` (24 lignes = 6 projets × 4 cadences) alimente le panneau **Planification** de
`/jobs` et `scripts/schedule.ts`, en heure métier **et** en UTC. Débloque **JOB-006** et donne à
**FIND-003** son expiration de veilles récurrente.

**Prochain :** l'**agent réel** qui lit les findings et produit des `action_proposals` gouvernées par
les policies DATA-007 · **JOB-006** (prévenir le 429 au lieu d'y réagir) · **JOB-004** (DAG de steps,
statut `partial` — le scheduler ouvre un run et met ses jobs en file, il n'ordonnance encore rien).
L'inbox UI (E11) reste à faire.

**Pièges :**
- **`vercel.json` ne suffit pas : rien ne bat tant que ce n'est pas déployé.** Et au **premier tick
  après déploiement**, la fenêtre de rattrapage tire les créneaux des 6 dernières heures — attendu,
  sans doublon, mais ça inclut **barberconcept**, dont la détection hebdo écrira **50 findings d'un
  coup** (plafond `maxCandidates`, 1310 couples franchissent les seuils). Décision restée à
  Jonathan : soit on la laisse partir au premier lundi, soit on désactive `weekly` pour ce projet
  via `project_projections.payload.schedules`.
- **La cadence `weekly` déclenche une VRAIE détection sur les 6 projets.** Toute preuve doit passer
  un `catalog` de substitution (paramètre prévu pour ça) — sinon elle écrit des findings de
  production.
- **Ne jamais nommer un créneau par son instant UTC.** Toute la garantie anti-doublon vient de ce
  que la clé porte le champ **local**. Une clé en UTC ferait deux créneaux distincts d'un même
  lundi 09:00 selon la saison, et un seul le jour du retour à l'heure d'hiver.
- **Le run reste `queued` tant qu'aucun de ses jobs n'a conclu** (un job en retry n'a rien conclu).
  Le statut de fin de course est exact ; le suivi fin d'un run **en cours** est l'affaire de JOB-004.
- **Une preuve qui ouvre des runs a DEUX niveaux d'enfants** : `jobs` **et** `monitoring_steps`
  (écrits par `concludeRunStep`). Oublier les seconds fait échouer le nettoyage **après** toutes les
  vérifications — donc en laissant croire à un succès. C'est ce qui est arrivé une fois ici.
- **Le budget de drain (240 s) doit rester sous `maxDuration` (300 s)** avec de la marge : la
  plateforme tue sans repasser par les `finally`.
- **`applyJitter`, `random`, `now`, `since`** — toute cette famille reçoit son temps en injection.
  Une fonction de calendrier qui lirait `Date.now()` ne serait ni rejouable, ni testable un 29 mars.
- **Reste à vérifier de visu** (inchangé depuis JOB-007) : le rendu de `/jobs` n'a pas pu être
  constaté — aucune session admin ouverte, et fournir un mot de passe est exclu. Le chargement
  serveur, lui, est vérifié (303 vers `/login`, `npm run check` vert).
- Toujours en suspens hors JOB-005 : purge destructive (DATA-008 `--execute`) = session dédiée ·
  **CONTRACT différé** · `ai_jobs → jobs` **écarté** · `post_publish:check` est **planifiable mais
  sans handler** (E03) : ne pas l'enfiler en production, il mourrait en `NoHandlerRegistered`.

**Commit :** `2ea6974` [hub] add: JOB-005 scheduler timezone-aware + tick horaire qui draine la file

---

## Etat session 2026-07-22 (JOB-007 — la file cesse d'être invisible)

**Fait :** JOB-001/002/003 avaient tout écrit — bail, journal append-only, classe d'erreur,
dead-letter reprenable — et **rien de tout ça n'avait d'interface** : seuls `jobs-inspect.ts` et
`jobs-requeue.ts`, donc seul quelqu'un avec un `.env` et un terminal, pouvait le lire. La console
`/jobs` rend ces mêmes données et appelle ces mêmes fonctions. **Aucun DDL** (57 tables, zéro
dérive) : `status='cancelled'` était déjà dans le vocabulaire depuis DATA-003, `job_attempts.outcome`
est du texte libre.

- **Purge préalable (décision de Jonathan, exécutée).** Les **22 lignes `__test_claim`** (7 en
  dead-letter) héritées d'avant le correctif JOB-003 ont été supprimées — la console est
  précisément l'écran qui les aurait exposées. `scripts/jobs-purge-test.ts`, **rejouable** et
  **dry-run par défaut** : un Ctrl-C au milieu d'une preuve saute son `cleanup()`, l'accident se
  reproduira. Deux points de méthode : le ciblage passe par **`starts_with(type, '__test_')`** et
  non `LIKE` (où `_` est un **joker** — `'__test_%'` matcherait un type métier), et le dry-run
  **liste les types trouvés avant de compter**, pour que le ciblage soit vérifié par un humain et
  non par une regex. Suppression **enfants d'abord** en une transaction (`job_attempts` →
  `job_effects` → `jobs`) : c'est exactement l'ordre qui manquait au bug d'origine. Résultat :
  22 jobs + 2 tentatives supprimés, `--dead` **vide**, file réelle = **6 jobs**, tous `succeeded`.
- **Deux modules, pour une raison précise.** `job-console.ts` reste **serveur** (il dépend de
  `JOB_STATUSES`/`ERROR_CLASSES`, qui vivent avec la file) ; `utils/job-format.ts` porte
  **libellés et formats**, parce qu'**une page Svelte ne peut pas importer `$lib/server`** — et
  surtout parce que `jobs-inspect.ts` **consomme désormais les mêmes libellés** (ses trois tables
  locales sont supprimées). Deux traductions d'un même vocabulaire auraient fini par diverger, et
  un `deferred` rendu « reporté » en CLI mais « échoué » à l'écran fait diagnostiquer à côté.
- **`explainFailure` porte l'acceptation n°1** (« comprendre un échec sans lire la DB »). Sans
  elle, la console afficherait `auth` ou `permanent` — ce qui suppose de connaître JOB-003. Elle
  rend un **verdict** et une **action** : `auth` → renouveler le jeton **puis** relancer ;
  `permanent` → corriger la cause, rejouer redonnerait la même erreur ; `quota` → « le job n'a rien
  fait de mal, sa tentative lui a été rendue » ; classe absente → traité comme rejouable, **jamais
  condamné**. Le drapeau `willRepeat` distingue les deux premiers : eux seuls re-tomberont à
  l'identique.
- **`normalizeJobFilters` réduit l'URL au vocabulaire connu** avant toute requête. Un statut
  inventé est **écarté** (pas refusé : un lien périmé doit afficher la file, pas une erreur), donc
  rien d'inconnu ne descend jusqu'au SQL. Prouvé en base avec un `status` hostile : liste vide de
  filtres, requête qui tourne quand même.
- **`cancelJob` — annuler un job EN COURS sans tuer personne.** On lui **retire son bail** : au
  prochain battement (≤ `leaseMs/3`), `renewLease` — gardé par `lease_owner` **et**
  `status='running'` — ne matche plus, le runner l'apprend et interrompt son handler. Ses écritures
  finales portent les mêmes gardes, elles ne réécrivent rien. **C'est le mécanisme de JOB-002, pas
  une voie parallèle** (le commentaire de `renewLease` anticipait déjà « job annulé »). Vérifié en
  réel : après annulation, `renewLease` → `null`, `completeJob` → `false`, `failJob` → `null`.
- **L'audit est porté par le journal, pas par un champ.** Une annulation écrit **deux** lignes
  quand le job tournait : celle de la **tentative** (close en `cancelled`, auteur = le worker) et
  celle de la **décision** (auteur = l'humain, raison en `metadata_json`) — deux faits distincts,
  et le journal étant append-only aucun n'écrase l'autre. Même idiome que la ligne `requeued` de
  JOB-003. L'état d'avant est lu **sous `FOR UPDATE`** et non par un sous-`SELECT` dans le
  `RETURNING` (qui verrait le snapshot d'avant la commande — subtil, donc fragile). Un refus
  **n'écrit rien du tout** : prouvé, 0 ligne après une tentative d'annuler un `succeeded`.
- **API `/api/ops/jobs/[id]/{cancel,requeue}`** — namespace `ops` **délibéré** : `/api/jobs/[id]`
  sert les `ai_jobs` legacy et la décision « `ai_jobs → jobs` écarté » tient. POST uniquement
  (GET → 405), session admin exigée (→ 401), acteur pris **dans la session** (`user:{email}`,
  jamais fourni par le client), **raison obligatoire** (→ 400), statut illégal ou course perdue
  → 409. **Aucune route n'accepte `payload_json`, `type`, `priority` ou `max_attempts`** :
  l'acceptation n°3 tient par **absence de chemin**, pas par une validation.
- **Pages** : `/jobs` (compteurs cliquables par statut, filtres projet/type/cause, table dense,
  pagination) et `/jobs/[id]` (verdict, chronologie `job_attempts`, payload en lecture seule,
  Relancer/Annuler avec raison). Entrée « Jobs » en sidebar. Deux choix assumés : les horodatages
  sont affichés en **UTC** — tels qu'ils sont stockés, comme la CLI — et l'interface **le dit**
  (convertir ici ferait exister deux lectures d'un même instant selon l'outil) ; et les pages
  **rappellent qu'aucun worker ne tourne en continu**, sinon « Relancer » paraît sans effet.
- **Bug trouvé en vérifiant (hors périmètre, corrigé)** : `job-003-retry-proof.ts` mesurait le
  délai **RESTANT** (`available_at - Date.now()`), donc **latence réseau comprise**. Un
  `Retry-After` de 120 s honoré à **130 s** s'y lisait « +119 s » et la vérification passait au
  **rouge sans qu'aucun code n'ait changé**. La mesure porte désormais sur le délai **ÉCRIT**
  (`available_at - updated_at`, deux colonnes calculées depuis le même `now`) — la fourchette de
  jitter a pu être resserrée à 24–36 s, sans marge pour le réseau.
- Vérif : `npm run test` = **374/374** (+32) · `npm run check` = **0 err / 42 warn** (baseline) ·
  **aucun DDL**, introspection = **57 tables, zéro dérive** · **`scripts/job-007-console-proof.ts`
  = 46/46 vertes sur Neon** (nettoie ses propres lignes) · non-régression : `job-003-retry-proof`
  **44/44** (après correction de la mesure), `job-002-recovery-proof` **27/27**,
  `job-claim-concurrency` **vert** · **13 findings intacts** (jonlabs 10 / bisrepetita 2 /
  physiopommier 1) · **0 horodatage ISO** dans `jobs` et `job_attempts` · routes sondées en dev :
  `/jobs` → 303 `/login`, POST sans session → 401, GET sur une action → 405.

**Acceptations couvertes.** (1) « un opérateur comprend un échec sans lire directement la DB » :
`getJobDetail` rend la cause classée, `explainFailure` la traduit en verdict + action, et la
chronologie `job_attempts` montre chaque tentative ; (2) « retry et annulation sont audités » :
chaque action écrit une ligne nominative (acteur + raison), le journal reste append-only — prouvé
`1 → 2` lignes après une annulation qui suit une reprise ; (3) « aucune opération ne permet de
modifier arbitrairement le payload » : `payload_json` vérifié **bit à bit inchangé** après
annulation ET après reprise, et aucune route n'expose de chemin d'écriture.

**Prochain :** l'**agent réel** qui lit les findings et produit des `action_proposals` gouvernées
par les policies DATA-007 · **JOB-005** (scheduler timezone-aware — c'est lui qui donnera un worker
récurrent, aujourd'hui tout dépend d'un lancement manuel) · **JOB-006** (prévenir le 429 au lieu
d'y réagir, débloqué par JOB-003). L'inbox UI (E11) reste à faire.

**Pièges :**
- **Reste à vérifier de visu** : le rendu des deux pages n'a pas pu être constaté (session admin
  requise). Le serveur de dev tourne sur `localhost:5173`. `npm run build` échoue par ailleurs sur
  un **symlink de l'adaptateur Vercel** (EPERM Windows) — environnement, pas code : la compilation
  et le bundle passent.
- **`_` est un joker dans `LIKE`** : tout ciblage de la famille de test doit passer par
  `starts_with(type, '__test_')`. `LIKE '__test_%'` matcherait un type métier de 7 caractères.
- **Ne jamais lire `jobs.attempts` comme un historique** (rappel JOB-003, la console en dépend) :
  `requeueDeadJob` le remet à zéro. La chronologie vient de `job_attempts`.
- **Un job annulé pendant qu'il tourne met jusqu'à ~100 s à s'arrêter** (un tiers de bail). L'écran
  le dit ; ce n'est pas un bouton d'arrêt immédiat, et un handler qui n'écoute pas son `signal`
  finira quand même son travail en cours.
- **Une preuve qui mesure un délai doit mesurer ce qui a été ÉCRIT**, jamais ce qu'il en reste :
  `Date.now()` face à une DB distante introduit une latence qui devient une fausse régression.
- Le **namespace `/api/jobs/`** reste celui des `ai_jobs` legacy. Toute nouvelle action
  d'exploitation va sous `/api/ops/`.
- Les libellés sont dans **`$lib/utils/job-format.ts`**, consommés par la CLI ET par les pages : en
  ajouter un côté page seulement recrée la divergence qu'on vient de fermer.
- Toujours en suspens hors JOB-007 : purge destructive (DATA-008 `--execute`) = session dédiée ·
  **CONTRACT différé** · `ai_jobs → jobs` **écarté** · **barberconcept** sans finding (50 d'un coup
  si détection lancée, cf. plafond `maxCandidates`) · **sur Vercel aucun worker permanent** : un job
  relancé ou reporté ne repart qu'au prochain lancement (cron dédié = JOB-005).

---

## Etat session 2026-07-22 (JOB-003 — l'échec est jugé, plus seulement compté)

**Fait :** JOB-001/002 savaient réclamer, tenir un bail et survivre à un worker mort — mais **toute
erreur y était traitée à l'identique** : backoff exponentiel, puis dead-letter au plafond. Un **403
structurel brûlait donc cinq tentatives sur une heure** alors qu'aucune ne pouvait aboutir, un **429
consommait le même budget qu'un bug**, et le backoff étant déterministe, N jobs échoués sur le même
provider revenaient **tous à la même seconde**. **Aucune table créée** (57 tables, zéro dérive) :
4 colonnes additives + 1 index partiel.

- **Le module pur `job-retry.ts`** — l'échec est d'abord **CLASSÉ**, et la classe décide :
  `retryable` (replanifié, jitté, borné par `max_attempts`) · `quota` (**reporté**) · `auth` et
  `permanent` (**dead-letter immédiat**). La politique de plafond n'est **pas réinventée** :
  `decideRetry` délègue à `decideAfterFailure` (JOB-001 → `computeBackoff`/`shouldDeadLetter` de
  DATA-003) et n'ajoute que le jugement et le jitter.
- **Le piège que ce module existe pour éviter — la raison prime sur le statut.** Google ne respecte
  pas la sémantique naïve des codes : un dépassement de quota arrive en **403 + `rateLimitExceeded`**,
  un refresh token mort en **400 + `invalid_grant`**. Classer sur le statut nu ferait exactement
  l'inverse de ce qu'il faut (le quota condamné en permanent, l'auth bouclant cinq fois). L'ordre
  d'examen est donc : codes internes → marqueurs de quota → d'auth → permanents → **puis seulement**
  le statut HTTP (429 = quota, 401 = auth, **tout autre 4xx = permanent** — un 4xx est par définition
  une erreur du client, la rejouer à l'identique redonne le même 4xx), 5xx → retryable. Une erreur
  **illisible retombe sur `retryable`** : on ne condamne jamais un job sur ce qu'on n'a pas su lire.
- **Jitter sans perdre la pureté** : `applyJitter` reçoit son `random` en **injection** (même
  discipline que le `nonce` de `deriveWorkerId`). **Sans `random`, le délai ressort inchangé** → tout
  le comportement déterministe de JOB-001/002 et ses tests restent valides tels quels ; seules les
  couches IO (`failJob`, le reaper) fournissent `Math.random`. Vérifié en réel : le 1er échec de la
  preuve JOB-001 replanifie à **+31 965 ms** au lieu de 30 000 pile.
- **`Retry-After` est un contrat** : honoré (secondes ou date HTTP, plafonné à **6 h** — sans ceiling
  un provider peut parquer un job pendant des jours), et le jitter peut l'**allonger, jamais le
  raboter** : repasser sous la barre rejouerait le 429 à coup sûr.
- **`deferJob` — le 429 ne consomme pas de tentative.** Décision produit : le job n'a rien fait de
  mal. Sa tentative lui est **rendue** (`attempts - 1`, comme `releaseJob`) et c'est **`deferrals`**,
  compteur séparé et **plafonné (20)**, qui borne la boucle. Sans l'asymétrie, une journée de
  saturation provider enverrait en dead-letter des jobs sains ; sans le plafond, un provider
  définitivement fermé les ferait tourner sans fin.
- **`requeueDeadJob` — la dead-letter n'est plus un cul-de-sac.** `attempts` **repart à zéro** (sinon
  un job repris à 5/5 remourrait au premier échec et la reprise ne serait qu'un geste), mais **rien
  n'est effacé** : `job_attempts` est append-only et la reprise **y écrit sa propre ligne**
  (`requeued`, l'auteur en `worker_id`, la raison en `metadata_json`). L'acceptation « une reprise
  manuelle conserve l'historique » est portée par le **journal**, pas par le compteur. Écriture
  **transactionnelle** : un job relancé sans trace serait un trou dans l'audit.
- **Câblage** : `job-runner.ts` route sur `decision.action` (`defer` → `deferJob`, sinon `failJob`) ;
  `WorkerStats` gagne `deferred` + `failedByClass` ; le reaper jitte aussi ses remises en file (N
  workers morts ensemble ne reviennent plus en chœur) ; `job_attempts.error_class` dit pourquoi
  **cette** tentative-là a échoué, quand `jobs.last_error_*` est écrasé à chaque reprise.
  **`NoHandlerRegistered` devient `permanent`** : rejouer cinq fois n'a jamais fait apparaître un
  handler manquant.
- **Outillage** : `scripts/jobs-requeue.ts` (`--dry-run`, refuse un job vivant, **prévient** qu'une
  cause `auth`/`permanent` non corrigée re-tombera à l'identique) · `jobs-inspect.ts --dead`
  (`--class=auth,permanent`) + les nouvelles issues dans la chronologie.
- **Bug trouvé en vérifiant (hors périmètre, corrigé)** : le nettoyage de `job-claim-concurrency.ts`
  violait la FK `job_attempts_job_id_fkey` **depuis JOB-002** (qui a fait écrire des tentatives) —
  l'erreur tombait **après** toutes les vérifications, donc invisible, et la preuve **laissait ses
  lignes dans la vraie file** à chaque exécution. Nettoyage enfants-d'abord + **type unique par
  exécution** (`__test_claim:<runId>`) : sans ce cloisonnement, un run réclamait les jobs du run
  précédent et la preuve mesurait autre chose (2 vérifications rouges à juste titre l'ont montré).
- Vérif : `npm run test` = **342/342** (+55) · `npm run check` = **0 err / 42 warn** (baseline) ·
  DDL appliqué sur Neon (**4 colonnes + 1 index partiel**) · introspection = **57 tables, zéro
  dérive** · **`scripts/job-003-retry-proof.ts` = 44/44 vertes sur Neon** (nettoie ses propres
  lignes) · non-régression : `job-002-recovery-proof` **27/27**, `job-claim-concurrency` **vert
  après correction du nettoyage** · chaîne réelle rejouée (`physiopommier findings:lifecycle`) →
  tentative journalisée · **13 findings intacts** (jonlabs 10 / bisrepetita 2 / physiopommier 1) ·
  **0 horodatage ISO** dans `jobs` et `job_attempts`.

**Décisions produit (validées avec Jonathan).** (1) **L'auth meurt tout de suite** — réessayer ne
répare pas un token révoqué, ça retarde l'humain qui doit re-consentir ; `last_error_class='auth'`
rend la cause filtrable et distincte de `permanent`. (2) **Le quota ne consomme pas de tentative**,
il se compte à part et sous plafond. (3) **La reprise manuelle remet `attempts` à zéro** : c'est le
journal qui porte l'histoire.

**Acceptations couvertes.** (1) « 429 et 5xx sont retentés conformément à la policy » : 429 →
`deferred`, `attempts` **inchangé**, `deferrals` +1, Retry-After honoré (+129 s pour un en-tête à
120 s) ; 5xx → replanifié, tentative consommée, délai **+31 s** (fourchette 24–36 s attendue) ;
(2) « 400/403 structurels ne bouclent pas » : 403 → `dead` **à la première tentative** (1/5), 400 +
`invalid_grant` → `dead` cause `auth`, et le **403 + `rateLimitExceeded` atterrit en `quota`**, pas
en permanent ; (3) « une reprise manuelle conserve l'historique » : chronologie finale
`#1 dead → #1 requeued (user:proof, « permission corrigée ») → #1 succeeded`, aucune ligne perdue.
Débloque **JOB-006**, **JOB-007**, **IDX-007** et **GMB-006**.

**Prochain :** **JOB-007** (console d'exploitation : lister queued/running/failed/dead, retry ciblé,
inspection — elle lira `jobs` + `job_attempts` + `last_error_class`, tout est là) et/ou l'**agent
réel** qui lit les findings et produit des `action_proposals` gouvernées par les policies DATA-007.
L'inbox UI (E11) reste à faire.

**Pièges :**
- **La raison prime sur le statut HTTP.** Toute évolution de `classifyJobFailure` doit garder cet
  ordre : un 403 Google porteur de `rateLimitExceeded` est un **quota**, pas un permanent, et un 400
  porteur d'`invalid_grant` est une **auth**. Inverser condamne des jobs sains et fait boucler les
  autres.
- **`applyJitter` sans `random` ne jitte pas** — c'est voulu (rétrocompatibilité et pureté). Un
  appelant IO qui oublie `Math.random` retombe silencieusement sur le backoff déterministe.
- Le **jitter n'ampute jamais un `Retry-After`** : la borne basse est le délai demandé par le provider.
- **`deferJob` rend la tentative** : tout nouveau chemin d'échec quota doit passer par lui, sinon le
  budget de tentatives se vide sur des reports qui ne sont pas des fautes du job.
- **`requeueDeadJob` remet `attempts` à 0** : ne jamais lire `jobs.attempts` comme un historique —
  c'est `job_attempts` qui fait foi (`requeued_count` dit seulement combien de fois on a relancé).
- Un job repris pour une cause **`auth`/`permanent` non corrigée** re-meurt immédiatement. Le script
  le dit, il ne l'interdit pas : c'est l'humain qui sait si la cause est levée.
- **Toute preuve qui écrit dans `jobs` doit supprimer ses `job_attempts`/`job_effects` d'abord**
  (FK) **et se cloisonner par un type unique**. Les deux manquaient à `job-claim-concurrency.ts`.
- **22 lignes de test `__test_claim`** (dont **7 en dead-letter**) traînent encore dans la vraie file,
  héritées des exécutions d'avant ce correctif : elles polluent `--dead`. Purge proposée, **non
  exécutée** (suppression = décision de Jonathan).
- Toujours en suspens hors JOB-003 : purge destructive (DATA-008 `--execute`) = session dédiée ·
  **CONTRACT différé** · `ai_jobs → jobs` **écarté** · **barberconcept** sans finding (50 d'un coup
  si détection lancée, cf. plafond `maxCandidates`) · **sur Vercel aucun worker permanent** : un job
  reporté ne repart qu'au prochain lancement (cron dédié = JOB-005).

---

## Etat session 2026-07-22 (JOB-002 — un worker qui meurt ne perd plus son job)

**Fait :** JOB-001 savait réclamer un job ; il ne savait pas ce qu'il devient quand son worker
**meurt**. Un crash (OOM, machine éteinte, process tué) laissait le job en `status='running'`, bail
périmé, `lease_owner` renseigné — **pour toujours** : `claimJob` ne regarde que les `queued`, le job
était perdu en silence. L'index `idx_jobs_lease`, posé en DATA-003 pour ce reaper, n'avait jamais
servi. Symétriquement, un job **long** voyait son bail de 5 min expirer pendant qu'il travaillait.
**2 tables additives** (57 tables, zéro dérive), aucun `ALTER` sur `jobs`.

- **Bail vivant (`jobs-lease.ts`)** — `renewLease` prolonge le bail et enregistre le battement,
  toujours gardé par `lease_owner` (un autre worker ne peut pas prolonger le bail d'autrui). Le
  runner bat **trois fois par bail** (`computeRenewInterval` = `leaseMs/3`) : une requête perdue ne
  suffit pas à se faire voler son job. Si un renouvellement échoue, le worker **l'apprend** et
  interrompt son handler — il ne travaille plus pour un job qui ne lui appartient plus.
- **Reaper (`reclaimExpiredLeases`)** — en UNE transaction :
  `SELECT … FOR UPDATE SKIP LOCKED` sur les baux expirés (consomme enfin `idx_jobs_lease`) →
  `classifyAbandonedLease` → `decideAfterAbandon` → `UPDATE` **gardé par `lease_owner` ET
  `lease_until` observés**. Cette double garde est le point sensible : si le vrai propriétaire a
  renouvelé entre la lecture et l'écriture, le `WHERE` ne matche pas et **on ne lui vole rien**
  (compté en `skipped`). `SKIP LOCKED` rend deux reapers concurrents inoffensifs — prouvé (A:1 B:0).
- **Timeout provider vs crash local**, la distinction de l'acceptation, tranchée par **où** le fait
  se constate : le crash se voit **de l'extérieur** (bail mort → `classifyAbandonedLease`, qui lit
  le rythme des battements : plus de battement bien avant l'échéance = `worker_death` ; battement
  jusqu'au bout puis silence = `lease_stall`) ; le timeout se voit **de l'intérieur**, worker vivant,
  via le **budget de durée** du runner (défaut 30 min) → `ProviderTimeout`, rejouable. La politique
  de retry n'est **pas réinventée** : `decideAfterAbandon` délègue à `decideAfterFailure` (DATA-003).
- **`job_attempts`** (journal append-only, 1 ligne par réclamation) — `jobs` ne portait qu'un
  compteur et un `last_error_*` **écrasé à chaque reprise** : impossible de montrer « la #1 a été
  abandonnée, la #2 a réussi ». **Pas d'unique `(job_id, attempt_no)`** : `releaseJob` **rend** la
  tentative, un numéro se répète légitimement, et écraser la ligne `released` effacerait justement
  l'historique qu'on crée. `scripts/jobs-inspect.ts` en fait une chronologie lisible.
- **`job_effects` + `guardExternalEffect`** — après reprise, le handler re-tourne. Le registre
  garantit l'exactly-once par **claim-then-apply** : on **réserve** la clé (`pending`, unique
  `(project_id, effect_key)`), **puis** on applique. Appliquer avant de réserver laisserait une
  fenêtre de double effet. Un effet `failed` reste **reprenable** (il n'a jamais abouti) ; un
  `applied` ne se rejoue jamais. Brique dont IDX-007 (outbox IndexNow) et la publication GMB auront
  besoin.
- **Reaper intégré au worker** : une passe au **démarrage** (le cas fréquent est justement le
  redémarrage après crash) puis à chaque **tour à vide** → la file se répare seule, sans infra
  nouvelle. La passe est **non bloquante** : si elle échoue, on la journalise et la boucle continue —
  un worker qui mourrait sur son reaper ne traiterait plus aucun job.
- Vérif : `npm run test` = **287/287** (+23) · `npm run check` = **0 err / 42 warn** (baseline) ·
  DDL appliqué sur Neon (**2 tables + 4 index**) · introspection = **57 tables, zéro dérive** ·
  **`scripts/job-002-recovery-proof.ts` = 27/27 vertes sur Neon** (nettoie ses propres lignes) ·
  `reap.ts --dry-run` sur la vraie file = **0 bail mort** · chaîne réelle rejouée
  (`bisrepetita findings:lifecycle`) → tentative journalisée · **13 findings intacts**, 0 job
  `running` orphelin, **0 horodatage ISO** dans `job_attempts`.

**Acceptations couvertes.** (1) « tuer un worker pendant un run entraîne une reprise automatique » :
bail forcé dans le passé + battement arrêté → reaper → `worker_death`, remise en file, puis un
`runWorker` réel reprend et mène le job à `succeeded` ; (2) « deux exécutions ne produisent pas deux
effets externes » : même `effect_key` sur deux tentatives → **1 seul appel**, une seule ligne
`applied` ; (3) « l'interface montre la tentative abandonnée et la reprise » : chronologie
`#1 abandoned (worker mort) → #2 succeeded`, workers distincts — la **page** reste JOB-007, qui lira
ces mêmes lignes. Débloque **JOB-003** et **JOB-007**.

**Prochain :** **JOB-003** (classification fine des erreurs — retryable / auth / quota / permanent —,
backoff avec jitter, action de reprise depuis la dead-letter), puis l'**agent réel** qui lit les
findings et produit des `action_proposals` gouvernées par les policies DATA-007. L'inbox UI (E11)
reste à faire.

**Pièges :**
- Le signal du job n'est **PAS** relié au signal d'arrêt gracieux : l'acceptation JOB-001 exige qu'un
  job commencé avant l'ordre d'arrêt soit **mené à son terme** (l'arrêt coupe la *réclamation*, pas
  l'exécution). Les relier casse silencieusement cette acceptation.
- **La file sert par priorité puis ancienneté** : un test qui seede un job puis appelle `claimJob`
  peut recevoir le job d'un **bloc précédent** resté en file. La preuve cloisonne chaque bloc par un
  **type dédié** (`__test_lease:<label>`) — sans quoi elle mesure autre chose que ce qu'elle annonce.
  (Deux vérifications vertes à tort avant correction.)
- `guardExternalEffect` **réserve avant d'appliquer**. Inverser l'ordre annule toute la garantie.
- Le reaper garde son `UPDATE` par `lease_owner` **et** `lease_until` : sans le second, une course
  avec un renouvellement volerait un job vivant.
- `classifyExecutionError` est **idempotente** (`ProviderTimeout` est lui-même dans la table des
  codes de timeout) : sans ça, code et drapeau se contredisent dans les logs.
- L'intervalle de heartbeat et le timer de budget sont nettoyés dans un `finally` — un timer
  survivant garderait le process en vie après la boucle.
- **Sur Vercel, aucun worker ne tourne en continu** : la reprise n'a lieu qu'au prochain lancement
  d'un worker (ou de `reap.ts`). Le cron dédié reste l'affaire de **JOB-005**.
- Toujours en suspens hors JOB-002 : purge destructive (DATA-008 `--execute`) = session dédiée ·
  **CONTRACT différé** · `ai_jobs → jobs` **écarté** · **barberconcept** sans finding (50 d'un coup
  si détection lancée, cf. plafond `maxCandidates`).

---

## Etat session 2026-07-22 (FIND-003 — cycle de vie : l'inbox se vide toute seule)

**Fait :** l'inbox devient crédible. Jusqu'ici un finding naissait `open` et y restait **pour
toujours** — rien ne le fermait quand le problème disparaissait, rien ne le rouvrait quand il
récidivait, rien ne permettait de le mettre en veille ni de dire « faux positif ». **Aucune table
créée** (55 tables, zéro dérive) : 5 colonnes additives sur `findings`.

- **Contrainte de correction n°1 — la troncature.** `maxCandidates=50` mord déjà (barberconcept :
  **1310** couples franchissent les seuils pour 50 écrits). Un finding absent des 50 **écrits** n'a
  rien prouvé. → la **closure** d'un run se fonde sur `selection.matched` (liste **complète**, avant
  troncature), jamais sur `candidates`. `selectOpportunities` expose désormais les deux ; un test
  vitest dédié protège l'invariant. Vérifié en réel : jonlabs closure 10 = 10 écrits, barberconcept
  closure **1310** pour 50 écrits (le dry-run l'annonce).
- **Deux autres gardes** : (a) **run non autoritaire = aucune réconciliation** (fenêtre absente ou
  zéro observation → un projet sans donnée ne vide pas son inbox), le runner le **dit** ; (b)
  **confirmation multi-fenêtres** (SPEC §10.3) — une seule absence ne résout pas, il en faut
  `autoResolveAfterMisses` **consécutives** (défaut 2, configurable par projet).
- **Purs (`finding-state.ts`)** : `canTransition` (matrice de légalité du graphe §10.1, gardée à
  l'écriture — un statut incohérent ne s'installe jamais en silence), `decideOnRedetection`,
  `decideOnAbsence`, `isSnoozeExpired`/`computeSnoozeUntil`, `resolveLifecycleConfig` (idiome tolérant
  de `resolveThresholds` : un override corrompu retombe sur le défaut plutôt que de fermer l'inbox
  d'un coup), `ACTIVE_STATUSES`/`isActiveStatus`. Nouvel `event_type` **`unsnoozed`** : une veille qui
  expire n'est pas une « validation » (assertion existante mise à jour).
- **IO (`findings.ts`)**, tout construit sur le `transitionFinding` **existant** : `snoozeFinding`,
  `dismissFinding`, `reopenFinding`, `expireSnoozes` (borné par l'index partiel) et
  **`reconcileDetectionRun`** (deux directions, une seule lecture : récidive → réouverture ; absence
  confirmée → auto-résolution ; veille et dismiss intouchés). `transitionFinding` porte désormais tous
  les effets de bord du cycle de vie (pose/efface l'échéance de veille, remet `consecutive_misses` à
  zéro au retour à l'actif, incrémente `reopen_count`) → aucun appelant ne peut les oublier.
- **Câblage** : le détecteur réveille les veilles échues **avant** la détection et réconcilie
  **après** ; `DetectorResult.lifecycle` est observable sans lire la DB et remonte dans le
  `monitoring_step`. Nouveau type de job **`findings:lifecycle`** (expiration seule) : une veille doit
  expirer même les semaines sans détection, sinon le snooze devient un enterrement.
- Vérif : `npm run test` = **264/264** (+33) · `npm run check` = **0 err / 42 warn** (baseline) · DDL
  appliqué sur Neon (**5/5 colonnes + index partiel**) · introspection = **55 tables, zéro dérive** ·
  **`scripts/find-003-lifecycle-proof.ts` = 37/37 vertes sur Neon** (nettoie ses propres lignes) ·
  détection réelle rejouée sur les 3 projets peuplés → **0 auto-résolution abusive**, les 13 findings
  matchent toujours leur closure · chaîne `queue → worker → expireSnoozes` démontrée.

**Décisions produit (validées avec Jonathan).** **Le snooze tient** : aucune aggravation ne le rompt
(elle reste journalisée) — un snooze est une promesse de silence, seule l'échéance le lève. **Le
dismiss vaut à vie** pour ce fingerprint : `occurrence_count` continue de monter (matière première de
la mesure de faux positifs, FIND-010) mais le finding ne remonte **jamais** seul dans l'inbox — seul
`reopenFinding` (humain) le défait.

**Acceptations couvertes.** (1) « un problème persistant n'apparaît qu'une fois » : unique
`(project_id, fingerprint)` + upsert, prouvé en base (2 détections → 1 ligne, `occurrence_count` 2) ;
(2) « une résolution puis récidive produit une réouverture » : `resolved` → `reopened`, `reopen_count`
incrémenté, `resolved_at`/cause effacés, journal `resolved` puis `reopened` ; (3) « le snooze expire
automatiquement » : `expireSnoozes` → `open` + événement `unsnoozed`, échéance et cause effacées.
Débloque **FIND-010**, **DASH-004**, **REP-001** et **AGT-005C**.

**Prochain :** **JOB-002** (renouvellement de bail, détection de worker mort, remise en queue), puis
l'**agent réel** qui lit ces findings et produit des `action_proposals` gouvernées par les policies
DATA-007. L'inbox UI (E11) reste à faire : les findings vivent maintenant leur cycle, rien ne les
affiche encore.

**Pièges :**
- **Ne jamais réconcilier depuis `candidates`** (tronqué) : c'est `matched` qui fait foi. Tout futur
  détecteur qui plafonne ses écritures doit exposer sa liste complète, sinon il fermera des findings
  bien vivants.
- **`expireSnoozes` renvoie en `open`**, pas au statut d'avant la veille (un `acknowledged` mis en
  veille revient `open`). Assumé : le journal garde l'historique, l'inbox reste simple.
- Un finding **déjà `resolved` et toujours absent** n'est pas compté comme « maintenu » (`held` ne
  compte que les décisions actives : veille et dismiss) — sinon le compteur enflerait sans fin.
- `transitionFinding` **refuse** désormais une transition illégale (throw). Les appelants futurs
  doivent passer par le graphe §10.1, pas écrire `status` à la main.
- La cartographie compare les **tables**, pas les colonnes : `scripts/apply-find-003.ts` vérifie
  lui-même les 5 colonnes + l'index.
- **barberconcept n'a encore aucun finding** (jamais détecté en réel). Lancer
  `detect.ts --project=barberconcept` y écrirait **50 findings d'un coup** — décision de Jonathan, à
  prendre après avoir tranché le plafond `maxCandidates`. Les 13 findings existants restent
  jonlabs 10 / bisrepetita 2 / physiopommier 1.
- Toujours en suspens hors FIND-003 : activation destructive de la purge (DATA-008 `--execute`) =
  session dédiée · **CONTRACT différé** (l'app lit encore `gsc_query_page_data` + `gmb_insights_daily`)
  · `ai_jobs → jobs` reste **écarté** (voir § Décisions).

---

## Etat session 2026-07-22 (FIND-001/FIND-004 + JOB-001 — la chaîne agentique tourne)

**Fait :** premier lot NON-données de E00 — la couche DATA produit enfin de la donnée de
nouvelle génération, et la queue est consommée. **Aucun DDL** (55 tables, zéro dérive).

- **FIND-001 + FIND-004** — 1er **détecteur déterministe** `keyword_opportunity` (§10.4), sans IA
  dans la boucle (§3.3 : le fait est établi par arithmétique, l'agent commentera plus tard).
  - Module **pur** `detector-state.ts` : `buildWindow` (N dernières semaines **complètes présentes** —
    les observations sont hebdo), **`areWindowsComparable`** (aucun delta entre longueurs
    différentes, GSC-004), `aggregateWindow` (Σ métriques + **position pondérée par impressions**,
    tri déterministe → rejouable quel que soit l'ordre d'arrivée), `selectOpportunities`
    (impressions ≥ seuil ∧ position exploitable ∧ CTR sous cible ∧ gain ≥ 1 clic),
    `isExcludedQuery` (**bruit configuré** marque/navigationnel — liste par projet, jamais
    d'heuristique devinée), `scoreOpportunity` (les 4 composantes §10.2, sommées par le
    `computePriorityScore` **existant**), `deriveOpportunitySeverity` (**plafond `medium` à faible
    volume ou confiance < 50** → FIND-002), `buildOpportunityEvidence` (**pointeurs** d'ids, plafonnés).
  - IO `detectors/keyword-opportunity.ts` : lit `gsc_query_page_observations`, écrit via
    `upsertFinding`/`recordFindingEvent` **existants**. Seuils = défauts < projection projet
    (`project_projections.payload.detectors.keyword_opportunity`, tolérant à l'absence) < overrides.
    Événement seulement quand il y a à dire : `created`, ou `aggravated`/`improved` via
    `deriveSeverityEventType` — une re-détection identique n'enfle pas le journal.
  - Runner `scripts/detect.ts` (`--project=<slug|all>`, `--weeks`, `--dry-run`, `--limit`) : ouvre un
    `monitoring_run` + `monitoring_step` (traçabilité `findings.run_id`), clé d'idempotence
    `deriveIdempotencyKey` → rejeu = un seul run. **Troncature jamais silencieuse** (le plafond
    `maxCandidates` atteint est annoncé avec le total réel).
- **JOB-001** — **réclamation atomique** de la queue durable (§6.2), en UNE instruction
  `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, consommant
  `idx_jobs_claim` (posé en DATA-003).
  - `job-state.ts` (**pur**) : `decideAfterFailure` (réutilise `computeBackoff`/`shouldDeadLetter`/
    `normalizeError` de DATA-003), `computeLeaseUntil`/`isLeaseExpired`, `deriveWorkerId`.
  - `jobs-claim.ts` : `claimJob` (filtre de type **paramétré**, jamais concaténé), `completeJob`/
    `failJob`/`releaseJob` — tous **refusent d'agir sur le job d'un autre worker** (`lease_owner`
    dans le WHERE).
  - `job-runner.ts` : registre de handlers + boucle `runWorker` **arrêtable** (AbortSignal). Premier
    handler réel = le détecteur → la chaîne **`queue → worker → détecteur → findings`** est bouclée.
  - `scripts/worker.ts` (`--once`, `--enqueue=<slug>`, `--types`, `--lease-ms`, `--poll-ms`) +
    `scripts/job-claim-concurrency.ts` (**preuve d'unicité**, impossible en vitest pur).
- **Correctif transverse — `timestamps.ts`** : les colonnes temporelles sont des `text` dont le
  DEFAULT SQL est `'YYYY-MM-DD HH:MM:SS'`, alors que le code écrivait de l'**ISO**. Deux formats dans
  une même colonne cassent toute comparaison lexicale (`'T'` 0x54 > `' '` 0x20 → un horodatage ISO du
  matin paraît **postérieur** à un horodatage DB du soir). `toDbTimestamp`/`toDbTimestampPlus` posés
  et câblés dans `findings.ts`, `monitoring.ts`, tout le chemin jobs. Vérifié en base : **0 ligne au
  format ISO** sur 13 findings.
- **Injection de client db** : `db/index.ts` lit `$env` → non importable depuis `tsx`. Les modules
  d'écriture (`findings.ts`, `monitoring.ts`) acceptent désormais un client optionnel et n'importent
  `db/index.js` que **dynamiquement**, à défaut. Une seule implémentation sert l'app ET les runners
  (fini la duplication de requêtes dans `scripts/`).
- Vérif : `npm run test` = **231/231** (+59 : 35 détecteur, 16 jobs, 8 timestamps) · `npm run check` =
  **0 err / 42 warn** (baseline) · introspection = **55 tables, zéro dérive** ·
  `job-claim-concurrency` = **21/21 vertes sur Neon** · détection réelle exécutée : **13 findings**
  sur 3 projets (jonlabs 10, bisrepetita 2, physiopommier 1), **0 doublon de fingerprint**,
  13 événements `created`/`detector`, rejeu → `occurrence_count` 2 puis 3 sans nouvelle ligne.

**Acceptations couvertes.** FIND-001 : (1) rejouable sur un snapshot figé (agrégation et tri
déterministes, testés sur ordre inversé) ; (2) deux versions comparables (`detector_version` =
`keyword_opportunity@1`) ; (3) aucune explication IA requise pour établir le fait. FIND-004 :
(1) chaque opportunité montre query, page, période et métriques ; (2) seuils configurables par projet ;
(3) aucune page publiée automatiquement (le détecteur n'écrit que des findings). JOB-001 : (1) test
concurrent réel → 8 workers, 8 jobs distincts, aucun doublon ; (2) arrêt gracieux → job mené à son
terme, aucun `running` orphelin, **tentative rendue** ; (3) jobs non réclamables (backoff,
`available_at` futur à priorité 100) **ne bloquent pas la file**.

**Prochain :** FIND-003 (cycle de vie : auto-résolution quand un finding cesse de matcher, snooze,
réouverture) et/ou **JOB-002** (renouvellement de bail, détection de worker mort, remise en queue) —
puis l'**agent réel** qui lit ces findings et produit des `action_proposals` gouvernées par les
policies DATA-007. L'inbox UI (E11) reste à faire : les findings existent, rien ne les affiche encore.

**Pièges :**
- **`attempts` s'incrémente à la RÉCLAMATION**, pas à l'échec — sinon un job qui tue ses workers
  boucle à l'infini. Corollaire : `releaseJob` **rend** la tentative (`GREATEST(attempts - 1, 0)`),
  sans quoi redémarrer un worker deux fois suffit à envoyer un job sain en dead-letter. (Trouvé par
  le test de concurrence, pas par relecture.)
- **Prédicat de disponibilité toujours CASTÉ** : `available_at::timestamp <= $now::timestamp`. Une
  comparaison lexicale sur ces colonnes `text` est fausse dès que deux formats coexistent.
- `sql\`… = ANY(${array})\`` **ne marche pas** avec le driver Neon (le tableau est sérialisé élément
  par élément → `malformed array literal`). Utiliser `IN (${sql.join(...)})`.
- **SIGINT n'atteint pas node sous Git Bash/Windows** : l'arrêt gracieux se vérifie par `AbortSignal`
  (même chemin de code ; le signal n'en est que le déclencheur), pas par `kill -INT`.
- Le détecteur **ne résout jamais** un finding qui cesse de matcher (c'est FIND-003) : un finding
  `open` qui n'apparaît plus dans un run n'est pas un bug.
- `project_projections` est **vide** : les seuils par projet retombent sur les défauts. Le chemin
  d'override avale toute anomalie (payload invalide → défauts) plutôt que de casser une détection.
- Le plafond `maxCandidates=50` **mord déjà** : barberconcept a **1310** couples franchissant les
  seuils. Le runner l'annonce ; ce n'est pas une couverture complète.

---

## Etat session 2026-07-22 (DATA-008 — rétention, agrégation & purge)

**Fait :** (périmètre validé = **expand + dry-run, aucune suppression réelle**)
- **DATA-008** phase **expand** : 3 tables de la rétention/purge (SPEC §7.11) dans `schema.ts`.
  - `retention_policies` — politique **configurable par type** (unique `data_type`). `retention_days`
    NULL = sans limite ; `protected` = jamais purgeable ; `requires_l4` = suppression exige L4 ;
    `aggregate_before_purge` ; `source_table`/`timestamp_column` (câblage runner). **Seedée** avec la
    politique §7.11 : détail obs = 24 mois (agrégé avant purge), debug/payload = 90 j, agrégats/findings/
    décisions/audit/rapports = sans limite.
  - `observation_aggregates` — rollups **semaine/mois/année** produits **avant** purge (agrégats conservés
    sans limite). Générique par `source` + `dimensions_hash` (dims variables : query+page / métrique /
    keyword). Idempotent (unique projet+source+grain+période+dims → reprise sans double-compte).
  - `purge_runs` — run **observable + reprenable** : `dry_run`, `plan_json`, `metrics_json`,
    `checkpoint_json` (reprise), `approval_ref`→`proposal_approvals` (L4 pour purge d'audit).
  - Helpers : `retention-state.ts` (**pur**, testé : `computeCutoff`/`isExpired` [null = sans limite],
    `isPurgeable` [protégé/infini/inactif jamais purgé], `requiresL4ForPurge`+`assertPurgeAuthorized`
    [audit = L4 sinon throw], `derivePeriod` [buckets week/month/year déterministes UTC],
    `canonicalDimensions`, `RETENTION_DEFAULTS` [config §7.11 pure], tuples) · `retention.ts`
    (`seedRetentionPolicies` idempotent, `upsertObservationAggregate` idempotent +`computeDimensionsHash`,
    `createPurgeRun`/`checkpointPurgeRun`/`updatePurgeRun` ; garde `assertBoundedPayload`/
    `assertNoInlineSecret` sur les blobs).
  - Runner `scripts/purge.ts` — **DRY-RUN par défaut** : seed policies + plan (lignes + périodes exactes
    par type, agrégats à produire). `--execute` **REFUSE** (destructif différé). `--now=YYYY-MM-DD` fige
    la réf. Application DDL : `drizzle/manual-data-008.sql` via `scripts/apply-data-008.ts`.
- Vérif : `npm run test` = **172/172** (28 nouveaux) · `npm run check` = **0 err / 42 warn** (baseline) ·
  DDL **appliqué sur Neon** (3/3) · introspection = **55 tables, zéro dérive** · **dry-run exécuté sur Neon** :
  réf. réelle → 0 ligne (données < 24 mois) ; réf. `2030-01-01` → **76 446 lignes** (73009+3300+137) +
  périodes 2026-03→07 comptées exactement, protégés listés « conservés », audit marqué L4.
- **4 acceptations couvertes** : (1) dry-run annonce lignes+périodes exactes ; (2) `isPurgeable` +
  `protected` → aucun agrégat/findings/rapport supprimé ; (3) `assertPurgeAuthorized` → suppression audit
  exige L4 ; (4) agrégats upsert + delete par cutoff = idempotents → reprise sans double effet
  (`checkpoint_json`).
- **Pas de suppression réelle, pas de cron/UI** : la branche destructive (`--execute`) est écrite mais
  **gardée** ; l'agrégation+purge réelle sera activée en session dédiée (accès + validation explicites).

**Prochain :** premier lot §9 quasi clos côté DATA. Suite = la **chaîne agentique aval** (1er détecteur
déterministe qui produit de vrais findings depuis les observations DATA-004, + agent réel → proposals
gouvernés par les policies DATA-007), et/ou **JOB-001** (réclamation atomique `FOR UPDATE SKIP LOCKED`).
Activation destructive de la purge = tâche séparée. **CONTRACT** (retrait legacy) toujours différé.

**Pièges :**
- Colonne d'âge des observations = **`period_end`** (l'âge de la DONNÉE) sauf `keyword_rank_observations`
  = **`observed_date`** (pas de period_end) ; `fetched_at` vaut ~now après backfill → **inutilisable**
  comme âge. Toute nouvelle source à purger doit déclarer la bonne `timestamp_column`.
- `isPurgeable` : `active` **absent = actif** (les `RETENTION_DEFAULTS` n'ont pas le champ ; seedés
  `active=true`). Seul `active === false` désactive.
- `debug_payload` = policy **logique** (payload_json est column-level, pas une table) → `source_table`
  null, le runner l'ignore (« runner non câblé ») jusqu'à ce que la purge column-level soit écrite.
- Le dry-run **seede** les 9 policies (config, non destructif) : c'est voulu (sans policies, rien à planifier).

---

## Etat session 2026-07-22 (DATA-007 — review_automation_policies + policy_promotions)

**Fait :**
- **DATA-007** phase **expand** : 2 tables des politiques d'avis & d'automatisation (SPEC §7.10) dans
  `schema.ts`. Une policy gouverne l'automatisation des réponses aux avis pour un projet, affinable
  par localisation. Elle est **versionnée** (même modèle que `project_projections`) : jamais modifiée
  en place → on **promeut** une nouvelle version, l'ancienne passe `superseded`.
  - `review_automation_policies` (§7.10) — mode `draft_only|guarded_auto|manual`, `sync_enabled`,
    `auto_generation_enabled`, **`kill_switch`**, note minimale, délai + **jitter**, plages horaires
    (JSON), langue, signature, catégories d'escalade (JSON), max/run. **`scope_key` = `location_id ?? '*'`**
    → rend robuste le partial-unique `WHERE status='current'` (Postgres traite les NULL comme distincts,
    ce qui casserait l'unicité de la policy projet-wide). **`policy_hash`** (sha256 de la config canonique)
    → dédup d'une re-promotion identique. Unique `(project_id, scope_key, version)` + unique partiel
    **une seule courante par scope**.
  - `policy_promotions` (**journal append-only**, BACKLOG « tracer toute promotion ») — 1 ligne par
    transition : `from/to_version`, `from/to_mode`, `kind` (create|mode_change|kill_switch|config_change),
    `actor`, `reason`. Jamais d'update/delete → la policy effective à toute date se reconstruit depuis
    le journal (« la policy effective est visible dans l'audit »).
  - Helpers : `policy-state.ts` (**pur**, testé : `deriveScopeKey`, `nextPolicyVersion`,
    `canonicalPolicyConfig` [sérialisation stable → hash], **`evaluatePolicyGates`** [invariant :
    `syncAllowed` ignore le kill switch], **`canAutoSendReview`** [§8.4 : draft_only/manual jamais,
    guarded_auto seulement 5★ non escaladé], `resolveEffectiveKillSwitch` [global OU localisation],
    `derivePromotionKind`, tuples de vocabulaire) · `policies.ts` (`promotePolicy` **transactionnel**
    idempotent [dédup par hash, versionne sinon, écrit le journal] + `computePolicyHash` [sha256],
    `setKillSwitch` [bascule = promotion journalisée, ne touche jamais `sync_enabled`],
    `getCurrentPolicy`/`getEffectivePolicy` ; garde `assertBoundedPayload`/`assertNoInlineSecret` sur
    les blobs JSON).
  - Application : `drizzle/manual-data-007.sql` (additif, `IF NOT EXISTS`) via `scripts/apply-data-007.ts`.
- Vérif : `npm run test` = **144/144** (29 nouveaux) · `npm run check` = **0 err / 42 warn** (baseline) ·
  DDL **appliqué sur Neon** (2/2 tables) · introspection = **52 tables, zéro dérive**.
- **3 acceptations couvertes** : (1) versionnage (unique current + `policy_hash`) → aucune ancienne
  proposition ne profite silencieusement d'une nouvelle policy ; (2) `evaluatePolicyGates` → le kill
  switch bloque les envois **sans** bloquer la sync ; (3) `policy_promotions` append-only → la policy
  effective est visible dans l'audit.
- **Pas d'exécuteur, pas de cron, pas d'UI** (expand seul). GMB-005 (application réelle des modes/kill
  switch au flux review-reply) reste **BLOCKED**, débloqué côté données par cette table.

**Prochain :** **DATA-008** (rétention/purge, désormais débloqué : agrégats semaine/mois/année avant purge,
24 mois de détail, dry-run + métriques + reprise). Puis la chaîne agentique aval (1er détecteur déterministe
+ agent réel qui produit findings→proposals, gouvernés par ces policies).

**Pièges :**
- `scope_key` = `location_id ?? '*'` : **toujours** passer par `deriveScopeKey` côté écriture, sinon le
  partial-unique `current` peut laisser deux policies projet-wide coexister (NULL distincts en Postgres).
- `policy_hash` = sha256 de `canonicalPolicyConfig` (ordre de champs **figé**) → réordonner les champs
  invalide tous les hash existants (re-promotion vue comme changement). Ne pas toucher sans migration.
- Le kill switch est **versionné dans la config** (pas une colonne mutée en place) : une bascule crée une
  nouvelle version + une ligne de journal → l'historique du kill switch est auditable.
- `setKillSwitch` sur un scope sans policy crée une `draft_only` sûre (kill switch demandé) : jamais
  d'envoi possible par défaut.

---

## Etat session 2026-07-22 (DATA-006 — proposals + approvals + agent_runs)

**Fait :**
- **DATA-006** phase **expand** : 3 tables de la couche décision→action (SPEC §7.8/§7.9/§12) dans
  `schema.ts`. Une proposition = une action **recommandée** (jamais une mutation → exécution).
  - `action_proposals` (§7.8) — **`payload_hash`** stocké (hash canonique de `payload_json`) = ce à
    quoi une approbation se lie. Statuts = 7 de §7.8 **+ `invalidated`** (payload modifié après
    approbation) **+ `expired`**. `required_approval_level` (L0–L4, §12.1). Exécution/vérification
    **non séparées** : `execution_job_id` FK→`jobs` (queue durable existante) + `verification_status`.
    Idempotence : **unique `(project_id, finding_id, action_type, payload_hash)`** → re-proposition
    identique ne duplique pas.
  - `proposal_approvals` (**entité d'approbation dédiée**, §12.2/§12.3/§14.3) — **hash lié**
    (`approved_payload_hash`), auteur + `scope_json` (périmètre), `method` (ui|telegram|policy),
    **token one-time** + `token_used_at` + `expires_at`, statut propre (active|consumed|expired|
    revoked|invalidated). 1 ligne par proposition (approbation de lot = jamais un scope global).
  - `agent_runs` (§7.9) — journal d'invocation LLM : agent/version, skill, model, inputs+hashes,
    `findings_read_json` (sources), sortie (proposal|report), tokens/coût/durée, résultat/erreurs,
    `human_validation_ref` FK→`proposal_approvals`. Distinct de `monitoring_runs` (orchestration).
  - Helpers : `proposal-state.ts` (**pur**, testé : `canActorApprove` [agent ≤ L2, policy ≤ L3,
    **L4 = user seul**], `isApprovalValid` [active + hash égal + non expiré], `statusAfterPayloadChange`,
    tuples de vocabulaire) · `proposals.ts` (`createProposal` idempotent + `computePayloadHash`
    [sha256], `approveProposal` **transactionnel** [refuse si niveau interdit], `updateProposalPayload`
    [invalide l'approbation], `rejectProposal`/`supersedeProposal`/`linkExecutionJob`/
    `setVerificationStatus`, `recordAgentRun`/`finishAgentRun` ; garde `assertBoundedPayload`/
    `assertNoInlineSecret` sur tous les blobs).
  - Application : `drizzle/manual-data-006.sql` (additif, `IF NOT EXISTS`) via `scripts/apply-data-006.ts`.
- Vérif : `npm run test` = **115/115** (18 nouveaux) · `npm run check` = **0 err / 42 warn** (baseline) ·
  DDL **appliqué sur Neon** (3/3 tables) · introspection = **50 tables, zéro dérive** (idem-unique +
  token-unique + FK exécution→`jobs` vérifiés).
- **3 acceptations couvertes** : (1) modifier le payload invalide l'approbation → `payload_hash` +
  `isApprovalValid` + `updateProposalPayload` ; (2) un agent ne peut pas élever son niveau →
  `canActorApprove` refuse L3/L4 ; (3) toute action externe remonte à une proposition (`execution_job_id`)
  ou policy versionnée (`review_automation_policies`, DATA-007).
- **Pas d'agent réel, pas d'exécuteur, pas d'UI** (expand seul). Recoupements legacy (`publish_logs`,
  `gmb_reviews.draftReply`, `ai_jobs`) **non touchés** — contract différé.

**Prochain :** **DATA-007** (`review_automation_policies` : modes draft_only/guarded_auto/manual, seuils,
version, kill switch) et/ou **DATA-008** (rétention/purge, désormais débloqué). Puis la chaîne agentique
aval (1er détecteur + agent réel qui produit findings→proposals).

**Pièges :**
- `payload_hash` = sha256 de la **chaîne** `payload_json` stockée → l'appelant doit fournir une
  sérialisation stable s'il veut que deux payloads sémantiquement égaux partagent le hash.
- `findingId` **nullable** dans l'unique d'idempotence : Postgres traite les NULL comme distincts →
  deux propositions « sans finding » de même action/payload ne se dédupliquent pas (attendu).
- Exécution = table `jobs` existante, **pas** une nouvelle table (SPEC : pas de table exécution séparée).
- `proposal_approvals.token` unique mais nullable → plusieurs approbations sans token coexistent (OK).

---

## Etat session 2026-07-22 (DATA-005 — findings + finding_events)

**Fait :**
- **DATA-005** phase **expand** : 2 tables du modèle agentique (SPEC §7.6/§7.7) dans `schema.ts`.
  Un finding = **interprétation déterministe persistante** (jamais un fait brut → observation) ;
  c'est la primitive centrale du produit (SPEC §1542).
  - `findings` (SPEC §7.6) — **unique `(project_id, fingerprint)`** = le même problème redétecté
    une autre semaine conserve le même finding (acceptation 1), on incrémente `occurrence_count`
    + rafraîchit `last_seen_at`/scores/preuves, `first_seen_at` préservé. Statuts = les **7 de §7.6
    + `reopened`** (§10.1) ; `new` transitoire (naît `open`). `severity` info→critical,
    `priority_score`/`confidence_score` 0–100. **Preuves = `evidence_json` (pointeurs), jamais de
    texte libre** ni de FK dure vers une observation. `run_id` nullable (traçabilité détecteur).
    Index inbox cross-projet : `idx_findings_status` + `(project_id, status|severity)`.
  - `finding_events` (SPEC §7.7) — journal **append-only** : `event_type` + `reason` (cause) +
    `actor` (auteur) → acceptation 2 « toute transition possède un événement, une cause et un auteur ».
    Jamais d'update/delete.
  - Helpers : `finding-state.ts` (**pur**, testé : `deriveFindingFingerprint` [séparateur `\x1f`,
    miroir de l'unique], `computePriorityScore` [barème §10.2 : impact 40 + urgency 25 + confidence 20
    + strategic_fit 15], `clampScore`, `deriveSeverityEventType`, `deriveStatusEventType`,
    tuples de vocabulaire) · `findings.ts` (`upsertFinding` idempotent avec incrément atomique
    `occurrence_count`, `recordFindingEvent` append-only, `transitionFinding` **transactionnel**
    statut+événement ; garde `assertBoundedPayload`/`assertNoInlineSecret` sur evidence/impact/payload).
  - Application : `drizzle/manual-data-005.sql` (additif, `IF NOT EXISTS`) via `scripts/apply-data-005.ts`.
- Vérif : `npm run test` = **97/97** (27 nouveaux) · `npm run check` = **0 err / 42 warn** (baseline) ·
  DDL **appliqué sur Neon** (2/2 tables) · introspection = **47 tables, zéro dérive**, les 2 tables +
  unique fingerprint + 3 index inbox + 2 index journal attendus.
- **Politique de suppression d'observation** (acceptation 3) : observations = série **append-only jamais
  supprimée** ; evidence_json = références *souples* → aucune cascade. « Interdit/géré par politique » ✓.
- **Pas de détecteur, pas de backfill, pas d'UI** (expand seul ; findings = données de nouvelle génération).

**Prochain :** **DATA-006** (débloqué) — le reste de la chaîne agentique (proposals/approval…) et un
premier **détecteur** déterministe qui produira de vrais findings depuis les observations DATA-004.

**Pièges :**
- Statut/sévérité/type en colonnes `text` (pas d'enum DB, cohérent avec le schéma) → le vocab canonique
  vit dans `finding-state.ts`, à garder synchro.
- `findings` **n'a pas** de `schema_version` (contrairement aux observations) : le versionnage d'un finding
  passe par `detector_version`.
- `evidence_json` : **pointeurs** (ids d'observations/queries/pages), jamais le texte de l'avis/du contenu.

---

## Etat session 2026-07-22 (DATA — backfill EXÉCUTÉ en DB réelle)

**Fait :**
- **Backfill exécuté sur Neon** (run réel, plus dry-run) : `gsc_query_page_observations`=**73009**,
  `gsc_page_observations`=**3300** (rollup), `gmb_insight_observations`=**0** (source vide),
  `keyword_rank_observations`=**137**. `verify-backfill` = **5/5 PASS**. `data-001-cartography
  post-backfill` = **45 tables, zéro dérive**, 4 tables d'observations peuplées.
- **Bug corrigé** (`7cb94c1`) : `CHUNK` 5000→4000. À 5000, `gsc_query_page_observations`
  (16 colonnes) générait 80000 params bind par INSERT → dépassait la limite Postgres de
  **65535 params/requête** (`bind message has N parameter formats but 0 parameters`). 4000×16=64000,
  sûr pour les 4 tables. Le run planté avant correctif était sans dommage (upserts idempotents).
- **Prochain = DATA-005** (`findings`/`finding_events`, débloqué). **CONTRACT** (retrait legacy) toujours
  différé : l'app lit encore `gsc_query_page_data` (`/positions`) et `gmb_insights_daily` (dashboards).

---

## Etat session 2026-07-22 (DATA — migrate/backfill : code)

**Fait :**
- **Phase MIGRATE** : backfill idempotent du legacy vers les tables d'observations (DATA-004),
  **additif** (aucune table source touchée). Les 3 domaines arbitrés :
  - `gsc_query_page_data` → `gsc_query_page_observations` (1:1 ; `week_start`→`period_start`,
    `period_end` joint depuis `gsc_snapshots`).
  - **rollup dérivé** `gsc_query_page_data` agrégé → `gsc_page_observations` (par snapshot/semaine :
    Σ clicks/impressions, `ctr` recalculé, **position pondérée par impressions**).
  - `gmb_insights_daily` → `gmb_insight_observations` (1:1).
  - `tracked_keywords` (non archivés) × `gsc_query_page_data` → `keyword_rank_observations`
    (**watchlist epic-23 seulement** ; ligne représentative = impressions max par keyword/device/semaine).
  - `provider` posé explicitement (`gsc`/`gsc`/`gmb`/`gsc`), `run_id=null`, `schema_version=1`,
    `payload_json=null` (série normalisée suffisante).
- Module **pur testé** `src/lib/server/observation-backfill.ts` (`import type` des interfaces d'input →
  zéro dépendance db/`$env`) : `rollupPagesFromQueryPage`, `weightedPosition`, `pickKeywordRankRow`,
  `buildKeywordRankInputs`, mappers `toGsc*`/`toGmb*`/`toKeywordRank*`.
- **Runner** `scripts/backfill-observations.ts` (Pool propre + drizzle autonome, cf. `apply-data-004.ts`) :
  passes A+B fusionnées par snapshot (mémoire bornée à une semaine, `week_end` gratuit), C keyset, D join.
  **Dédup intra-lot last-wins** côté GSC (pas de clé naturelle → sinon `ON CONFLICT` casse dans un même
  INSERT). Upserts par lot mirroir des `*_obs_unique`. Flag **`--dry-run`**.
- **Vérif read-only** `scripts/verify-backfill.ts` : #obs == #clés distinctes source (A/C), Σ impressions
  page == Σ impressions query_page (B, le rollup conserve la masse), keyword_rank ⊆ tracked + comptage (D).
- Vérif locale : `npm run test` = **70/70** (13 nouveaux) · `npm run check` = **0 err / 42 warn** (baseline).
- **Dry-run OK (2026-07-22, Neon lu, zéro écriture)** : A `gsc_query_page`=**73009** (96 snapshots, aucun
  doublon collapse) · B rollup `gsc_page`=**3300** · C `gmb_insight`=**0** (source `gmb_insights_daily`
  vide — GMB dormant) · D `keyword_rank`=**137** (depuis 443 candidates tracked). Le code tourne, se
  connecte, transforme sans crash.

**Prochain (exécution DB réelle, hors session code — nécessite accès Neon) :**
1. ✅ `npx tsx scripts/backfill-observations.ts --dry-run` — fait (compteurs ci-dessus).
2. `npx tsx scripts/backfill-observations.ts` (exécution réelle par lots).
3. `npx tsx scripts/verify-backfill.ts` (invariants) + `npx tsx scripts/data-001-cartography.ts post-backfill`
   (zéro dérive + 4 tables peuplées).
Puis **DATA-005** (`findings`/`finding_events`, débloqué). **CONTRACT** (retrait legacy) **différé** :
l'app lit encore `gsc_query_page_data` (`/positions`) et `gmb_insights_daily` (dashboards).

**Pièges :**
- `scripts/` **hors** `include` du `check` (comme tous les scripts) → non typecheckés statiquement ;
  leur validation passe par le **dry-run** (tsx + Neon).
- **Doublons GSC** : dédup intra-lot obligatoire ; les doublons inter-lots sont résolus par l'upsert
  (last-wins, valeurs identiques car re-fetch). `verify-backfill` mesure l'écart lignes↔clés distinctes.
- Rollup page : `gsc_page_observations` n'est **pas** une donnée page-native GSC mais une **dérivation** ;
  un futur collecteur page-level pourra la remplacer proprement (upsert idempotent, même clé).

---

## Etat session 2026-07-21 (DATA-004)

**Fait :**
- **DATA-004** phase **expand** : le modèle d'observations (SPEC §7.5), **10 tables** dans `schema.ts`.
  Une observation = un **fait collecté**, jamais une interprétation (ça = un finding, DATA-005).
  - Forme commune à chaque table : `project_id` · `run_id` (FK→`monitoring_runs`, nullable →
    **traçabilité** jusqu'au run collecteur) · `provider` · `schema_version` · période/date ·
    dimensions · métriques normalisées · `payload_json` **brut borné** (séparé du normalisé) ·
    `fetched_at`. **Unique d'upsert** (projet + dimensions + période) = deux collectes identiques
    ne dupliquent pas (acceptation 1). **Index (projet, période/date)** = fenêtres 7/28/90 j
    couvertes (acceptation 3).
  - Les 10 : `gsc_query_page` · `gsc_page` · `index` · `sitemap` · `plausible_page` ·
    `keyword_rank` · `backlink` · `ai_visibility` · `gmb_review` · `gmb_insight` _observations_.
    **5 ancrées** sur une source vivante à migrer (gsc_query_page, gsc_page, gmb_insight,
    keyword_rank, index) ; **5 préfigurent** un collecteur à venir (sitemap, plausible, backlink,
    ai_visibility, gmb_review) — expand étant additif, elles s'élargiront sans rupture.
  - Helpers : `observation-state.ts` (**pur**, testé : `deriveObservationFingerprint` [dédup
    déterministe, séparateur `0x1F`], `computeWindowStart`/`isWithinWindow`, `assertBoundedPayload`
    [payload borné 32 Ko]) · `observations.ts` (upserts idempotents `onConflictDoUpdate` des **5
    tables ancrées** ; garde `assertNoInlineSecret` + `assertBoundedPayload` sur le payload).
  - Application : `drizzle/manual-data-004.sql` (additif, `IF NOT EXISTS`) via `scripts/apply-data-004.ts`.
- Vérif : `npm run test` = **57/57** (17 nouveaux) · `npm run check` = 0 err / 42 warn · introspection =
  **45 tables, zéro dérive**, les 10 tables + uniques d'upsert + index de fenêtre attendus.
- **Pas de backfill / pas de retrait** (migrate/contract = phase suivante).

**Prochain :** **migrate/contract** désormais débloqué côté observations — backfill par lots
`gsc_query_page_data` (73k, **dédupliquer d'abord**, aucune clé naturelle) + `gsc_snapshots` →
`gsc_*_observations`, `gmb_insights_daily` → `gmb_insight_observations`, positions epic 23 →
`keyword_rank_observations`. Puis **DATA-005** (`findings`/`finding_events`, désormais débloqué).
Le morceau `ai_jobs → jobs` reste **écarté** (voir Décisions).

**Pièges :**
- Uniques en **index uniques** (`uniqueIndex`), pas contraintes — cohérent avec le reste du schéma.
- `payload_json` : **borné** (`assertBoundedPayload`, 32 Ko) ET sans secret (`assertNoInlineSecret`)
  avant persistance. Le brut illimité va ailleurs, jamais dans la série temporelle.
- `gmb_review_observations` **recouvre** l'existant `gmb_reviews` (conservé) : la table d'observation
  capture l'**état daté** (rating/sentiment/has_reply) pour la série réputation, sans dupliquer le
  texte de l'avis (→ payload/finding).
- Les 5 tables spéculatives n'ont **pas** de write-helper (on n'écrit pas ce qu'on ne collecte pas) :
  leurs colonnes de métriques sont volontairement minimales, à élargir quand leur collecteur arrive.

---

## Etat session 2026-07-21 (DATA-003)

**Fait :**
- **DATA-003** phase **expand** : 3 tables d'orchestration du modèle agentique dans `schema.ts`.
  - `monitoring_runs` (SPEC §7.3) — run logique par projet/période. **unique (project_id,
    idempotency_key)** = deux créations concurrentes même clé ⇒ **un seul run** (acceptation 2).
    Statuts `queued|running|partial|success|failed|cancelled`, types
    `daily|weekly|monthly|manual|post_publish`, `triggered_by` schedule|user|agent|webhook.
  - `monitoring_steps` (SPEC §7.4) — tentative d'étape, FK→run. **unique (run_id, step_type,
    attempt)** (`force` = nouvel `attempt`, SPEC §8.3). Statuts step incluent **`skipped`** et
    **`provider_unavailable`** → un run partiel distingue succès/skip/échec/provider indispo
    (acceptation 1). Lease (`lease_owner`/`lease_until`) + `input_hash`/`output_hash`.
  - `jobs` (conçue depuis SPEC §6.2 queue durable + §8.3) — queue Postgres : `attempts`/`max_attempts`
    (dead-letter), `available_at` (backoff), lease + `heartbeat_at`, `depends_on` (JSON), `run_id`
    nullable. **unique (project_id, idempotency_key)** (dédup) + **`idx_jobs_claim`(status,
    available_at, priority)** = index de réclamation vérifié (acceptation 3). Le claim atomique
    `FOR UPDATE SKIP LOCKED` reste **JOB-001** (hors périmètre).
  - Helpers : `monitoring-state.ts` (**pur**, testé : `deriveIdempotencyKey`, `classifyRunOutcome`,
    `computeBackoff`, `shouldDeadLetter`, `normalizeError` + tuples de statut) · `monitoring.ts`
    (`createRun`/`enqueueJob` concurrency-safe en `onConflictDoNothing`, `recordStep`,
    `recomputeRunStatus`). Garde `assertNoInlineSecret` réutilisée sur `payload_json`/`metadata_json`.
  - Application : `drizzle/manual-data-003.sql` (additif, `IF NOT EXISTS`) via `scripts/apply-data-003.ts`.
- Vérif : `npm run test` = **40/40** · `npm run check` = 0 err / 42 warn · introspection = **35 tables,
  zéro dérive**, les 3 tables + index attendus (uniques idempotence, `idx_jobs_claim`).
- **Pas de backfill / pas de retrait** (migrate/contract = phase suivante).

**Prochain :** **migrate/contract** — `ai_jobs` (queue légère, 111 lignes) → `jobs` (`type='ai'`) puis
retrait ; `gsc_*`/`gmb_insights_daily` → observations. Puis **JOB-001** (réclamation atomique des jobs :
`FOR UPDATE SKIP LOCKED`, lease, heartbeat, backoff) qui consomme `idx_jobs_claim`.

**Pièges :**
- Uniques en **index uniques** (`uniqueIndex`), pas contraintes — cohérent avec le reste du schéma.
- Statut de run **dérivé** des steps (`classifyRunOutcome`) ; `cancelled` est une décision externe,
  jamais dérivée.
- `payload_json`/`metadata_json` : passer par `assertNoInlineSecret` avant persistance (aucun secret).

---

## Etat session 2026-07-21 (DATA-002)

**Fait :**
- **DATA-002** phase **expand** : 2 tables socles du modèle agentique (SPEC §7.1/§7.2) dans `schema.ts`.
  - `project_integrations` — provider + `resource_key` (discriminateur) → **unique (project_id, provider,
    resource_key)** = plusieurs propriétés/localisations sans collision. `secret_ref` (jamais le secret),
    `configuration_json` non secret, fraîcheur (`last_success/error_at`) + `health_status`, `scopes`.
  - `project_projections` — hashée/versionnée. **unique (project_id, source_hash)** = inchangée jamais
    dupliquée ; **unique partiel `WHERE status='current'`** = une seule courante, versions passées `stale`.
  - Helpers : `projection-state.ts` (**pur**, testé : `classifyProjection`, `assertNoInlineSecret`,
    `computeHealth`) · `projections.ts` (record/dedup/versionnage transactionnel) · `integrations.ts`
    (upsert `onConflict` + succès/erreur → santé). Garde anti-secret sur payload ET config.
  - Application : `drizzle/manual-data-002.sql` (additif, `IF NOT EXISTS`) via `scripts/apply-data-002.ts`.
- Vérif : `npm run test` = **21/21** · `npm run check` = 0 err / 42 warn · introspection = **32 tables,
  zéro dérive**, les 2 tables avec FK→projects + index attendus (dont l'unique partiel).
- **Pas de backfill / pas de retrait** des tables héritées (migrate/contract = phase suivante).

**Prochain :** **DATA-003** — `monitoring_runs` / `monitoring_steps` / `jobs` (SPEC §7.3/§7.4) :
consommeront intégrations + projections. Puis migrate/contract (backfill `project_contexts` → projections,
4 sources → intégrations) et **DATA-001b** (fixture).

**Pièges :**
- Uniques posées en **index uniques** (`uniqueIndex`), pas contraintes — cohérent avec le reste du schéma.
- `configuration_json`/`payload` : toujours passer par `assertNoInlineSecret` avant persistance.

---

## Etat session 2026-07-21 (DATA-001)

**Fait :**
- **DATA-001** cartographie du schéma existant → `docs/DATA-001-cartography.md`.
  - Script d'introspection **read-only** `scripts/data-001-cartography.ts` (Pool `.env`, raw SQL
    `information_schema`/`pg_indexes` + `count(*)`) → snapshot `docs/_generated/data-001-introspection.json`.
  - **Zéro dérive** : 30 tables live = 30 dans `schema.ts` (les 5 tables ex-SQL-manuel epic18/22/
    seo-reports sont reprises dans le modèle). Base **non vide** (volumes réels relevés).
  - Sort documenté par table (conserver/migrer/retirer) · doublons vs futur modèle d'observations ·
    stratégie **expand/migrate/contract** pour base peuplée.
  - Volumétrie : dominée par `gsc_query_page_data` (**73 009** lignes, 99 % du hub), reste ≤ 500.
  - Findings : `content_types` vide (référentiel mort, candidat retrait) · `gsc_query_page_data`
    **sans clé naturelle imposée** → risque de doublons à dédupliquer avant migration · plusieurs
    tables GMB vides (dormantes).
- Vérif : script OK · `npm run check` = **0 err / 42 warn** (baseline).

**Prochain :** **DATA-002** — `project_integrations` (unifie `indexing_credentials`, `gmb_settings`,
`linkedin_settings`, `cms_connections`) + `project_projections` (remplace `project_contexts`, avec
hash/version/provenance). Puis **DATA-001b** (fixture anonymisée, différée).

**Pièges :**
- Migration GSC = seul morceau volumineux (73k) → **par lots**, jamais un rewrite bloquant.
- `core` reste R/O (FK `projects.slug → core.entities.slug`, possédé par invoices).

---

## Etat session 2026-07-21 (IDX-008)

**Fait :**
- **IDX-008** Google Indexing API restreinte. Garde unique en amont de tout réseau : flag maître
  `indexnow` (OFF par défaut) **ET** validation de type d'éligibilité (`JobPosting` / `BroadcastEvent`).
  - Helpers **purs** dans `src/lib/server/indexing-eligibility.ts` (`isEligibleForIndexingApi`,
    `evaluateIndexingGuard`) → testables hors runtime SvelteKit.
  - `publishUrl` / `batchSubmit` (`indexing.ts`) : gagnent `eligibility?` + `flagCtx?` ; refus →
    ligne d'audit `status:'blocked'`, `httpStatus:null`, **aucun `fetch`** (zéro quota). `batchSubmit`
    audite en 1 ligne résumé (`url = batch:<n>`).
  - 4 points d'entrée neutralisés (aucun ne porte de type éligible aujourd'hui) : auto-publish
    (`api/content/[id]/status`), `indexing/submit`, `indexing/from-sitemap` (×3). Les routes surfacent
    `blocked:true` + message pointant vers sitemap/maillage/inspection.
  - **1re infra de test du repo** : vitest + `vitest.config.ts` (node, modules purs) + `npm run test`.
    `indexing-eligibility.test.ts` → 7 tests verts (dont le **test positif** exigé).
  - Doc : commentaire flag `indexnow` (flags.ts) + `.env.example` mis à jour (interrupteur maître).
- Vérif : `npm run test` = 7/7 · `npm run check` = **0 err / 42 warn** (baseline inchangée).

**Prochain :** **DATA-001** — cartographier + figer le schéma existant (~29 tables), stratégie
expand/migrate/contract, fixture DB anonymisée. Contrats skills GSC-003/IDX-003 = hors repo.

**Pièges :**
- 3 chaînes `jlabs-content-hub` **visibles client** non renommées (décision de marque en attente) :
  `src/routes/positions/[slug]/+page.svelte:101`, `src/lib/server/email-templates.ts:54,107`.
- Build local KO sur Windows (symlink adapter-vercel) → vérifier via `check` + `test`, pas `build`.
- Le toggle `autoSubmitOnPublish` (settings `+page.svelte`) est désormais **inopérant** pour les
  articles (garde IDX-008) : à annoter « déprécié » un jour (cosmétique, non bloquant).

---

## Etat session 2026-07-21

**Fait :**
- **OPS-001** logger structuré (`src/lib/server/log.ts`) : JSON-lines prod / texte dev, niveaux (`LOG_LEVEL`), masquage des champs secrets.
- **GOV-003** config runtime centralisée (`src/lib/server/config.ts`) : schéma des 21 env vars, `validateStartup()` log-only câblé au boot (`hooks.server.ts`), `requireEnv()` fail-fast au point d'usage ; `.env.example` nettoyé (GitHub mort retiré + doc flags/LOG_LEVEL).
- **GOV-005** feature flags (`src/lib/server/flags.ts`) : 7 flags OFF par défaut, override global `FLAG_<NOM>` + par projet, `describeFlags()`.
- **GOV-001 (interne)** `package.json` name + User-Agent → `seo-stats`.
- **GOV-002/004** baseline établie : `check` = 0 err / 42 warn (dette legacy `(app)/`) ; build local KO (EPERM symlink adapter-vercel, Windows, pas une régression) ; `src` propre de Turso.

**Prochain :** Enchaîner **IDX-008** dans `src/lib/server/indexing.ts` — neutraliser `publishUrl`/`batchSubmit` génériques (garder JobPosting/BroadcastEvent), gater derrière le flag `indexnow`. Puis **DATA-001** (cartographie des 29 tables). Contrats skills GSC-003/IDX-003 = hors repo.

**Pièges :**
- 3 chaînes `jlabs-content-hub` **visibles client** non renommées (décision de marque en attente) : `src/routes/positions/[slug]/+page.svelte:101`, `src/lib/server/email-templates.ts:54,107`. Cible = `seo-stats` / `jonlabs` / retirer ?
- Build local KO sur Windows (symlink adapter-vercel) → vérifier via `check`, pas `build`, en local.
- IDX-008 change le comportement prod (auto-submit) → obligatoirement derrière flag.

**Commit :** [4bbe9ef] [hub] docs: HANDOFF pointe sur E00 fondations · code : [3d9be7d] fondations cockpit (logger, config, flags)

---

## Carte du code
> Mise à jour : 2026-07-26 (DASH-006 lot 2 — pause/reprise auditable)
>
> Ordre : lot le plus récent d'abord.

| Fichier | Rôle |
|---------|------|
| **`src/lib/server/pause-state.ts`** (+ `.test.ts`) *(DASH-006 lot 2)* | **Le jugement des pauses, pur.** `derivePauseStates` plie le **dernier événement par cible** en état effectif : une pause `until` échue en est **absente**, donc l'expiration est **dérivée et jamais écrite** (borne `<=`, comme `isSnoozeExpired`). `resolveCadencePause` fait l'**UNION** de `project_cadence` et `project` — pas de préséance à arbitrer, donc rien qui puisse diverger entre l'écran et le scheduler — et nomme la **plus large**, celle qu'il faudra lever. `resolveJobPause` réutilise `providerForJobType` (jamais une seconde table de types, qui divergerait au premier handler ajouté) ; un job **sans run** échappe à une pause de cadence, il n'appartient à aucun cadran. `normalizePauseTarget` est **STRICTE** à l'inverse de `resolveScheduleConfig` : une pause qui ne met rien en pause est pire qu'un refus, parce qu'elle a l'air d'avoir marché. `none` est refusé comme provider — c'est son **absence**. **40 tests.** |
| **`src/lib/server/pauses.ts`** *(DASH-006 lot 2)* | **L'accès base, sans une règle.** `loadPauseStates` = **une** requête `DISTINCT ON` : le dernier événement par cible, jamais le journal entier — la borne est le nombre de **cibles**, pas le volume d'historique. `recordPauseDecision` porte **l'idempotence DANS la transaction** (relit l'état dérivé, n'insère rien si l'état voulu est déjà là, rend `idempotent: true`) — contrat d'`approveProposal` : un double clic est un **non-événement**, jamais une erreur. ⚠️ Les conditions de `listPauseJournal` sont écrites sur **l'alias `p`** : les colonnes drizzle se rendent en nom pleinement qualifié, que Postgres refuse dès qu'un alias existe (42P01). |
| **`src/lib/server/jobs-pause.ts`** *(DASH-006 lot 2)* | **La 4ᵉ passe du worker**, jumelle de `jobs-graph.ts`. Conclut en `skipped` + `job_attempts` les jobs `queued` couverts par une pause, sous la garde `status='queued'` (course perdue = **no-op** : une pause arrête ce qui n'a pas commencé, elle n'interrompt pas ce qui court). Le `skipped` est ce que `classifyDependencyGate` lit comme **prérequis mort** → la propagation JOB-004 est **gratuite**. `LEFT JOIN` sur `monitoring_runs` : un job sans run doit **ressortir**, il reste soumis aux pauses provider et projet. **Zéro requête quand rien n'est suspendu** (le cas courant ne taxe aucun tour à vide). |
| `src/lib/server/job-runner.ts` *(DASH-006 lot 2)* | `pauseOnce` **avant** `settleOnce`, au démarrage et à chaque tour à vide : le skip qu'elle pose est ce que la passe suivante propage, **dans le même drain**. Compteur `pausedSkipped` **séparé** de `skipped` (comme `deferrals` l'est d'`attempts`) : dix jobs sautés par décision n'ont rien en commun avec dix jobs sautés par une collecte morte. Le `CapacityGovernor` relit les pauses **avec** la photo de la file. |
| `src/lib/server/job-limits.ts` (+ `.test.ts`) *(DASH-006 lot 2)* | `pausedProviders` / `pausedProjectIds` entrent dans `planAdmission` — **pas dans `JobLimits`** : une limite se règle, une pause se décide. La pause est évaluée **AVANT** le refroidissement (sinon l'écran annoncerait « au repos encore 900 s » d'un provider que personne ne compte rallumer). ⚠️ Un projet gelé est **retiré du calcul de réouverture du tour** : il a du travail réclamable qu'il ne prendra jamais, l'y laisser gèlerait l'équité du **parc entier**. |
| `src/lib/server/timestamps.ts` *(DASH-006 lot 2)* | `normalizeDbTimestamp` : rend une chaîne **déjà canonique** telle quelle. `new Date('2026-07-26 12:00:00')` est parsé en heure **LOCALE** (ECMA-262) — la repasser par `toDbTimestamp` la décale d'une à deux heures à Zurich, avec une amplitude qui change deux fois l'an. Toute valeur qui **sort** de la base passe par là. |
| `src/lib/server/scheduler.ts` · `automations.ts` · `automations-state.ts` *(DASH-006 lot 2)* | L'overlay `applyPauseToSpec` vit **au call site** : `loadProjectScheduleConfig` reste intacte, parce que « désactivée » (configuration) et « en pause » (décision) doivent rester **lisibles séparément**. Les pauses sont lues **une seule fois** par écran et par batch — deux lectures pourraient tomber de part et d'autre d'une reprise concurrente et afficher un état qui n'a jamais existé. `health: 'paused'` vient **après `disabled`** (ordre du scheduler) et **hors `FAILING_HEALTHS`** ; une cadence suspendue sort du dénominateur des « attendues ». |
| `src/routes/api/ops/automations/pause/+server.ts` *(DASH-006 lot 2)* | La seule porte humaine. Raison **obligatoire dans les deux sens** — y compris pour reprendre : « pourquoi le monitoring a-t-il redémarré le 12 août » est la question qu'on se posera, et une reprise sans motif y répond par un blanc. L'échéance se saisit en **jours** et se convertit ici : laisser le client envoyer une date inviterait deux formats dont la comparaison lexicale ne veut plus rien dire. |
| `src/lib/server/db/schema.ts` → `automation_pauses` *(DASH-006 lot 2, seul DDL — 60 tables)* | Journal **append-only**, calqué sur `finding_events`. **Aucun unique, volontairement** : rejouer un geste ne doit pas *échouer*, il ne doit *rien écrire* — une contrainte transformerait un double clic en erreur. `project_id` **nullable** : NULL ⇔ `scope='provider'`, une pause provider n'appartenant à aucun projet (l'attacher à l'un d'eux la rendrait invisible depuis les cinq autres, alors qu'elle les coupe tous). |
| **`src/lib/server/automations-state.ts`** (+ `.test.ts`) *(DASH-006 lot 1)* | **Purs DASH-006.** `lastDueOccurrence` **délègue à `dueOccurrences`** au lieu de réénumérer les créneaux : deux énumérations divergeraient au premier changement d'heure, et l'écran accuserait le cron d'un créneau qu'il n'a jamais eu à tirer. `classifyCadence` porte **l'axe PLANIFICATION seul** — un run `failed`, `partial` ou `cancelled` laisse `ok`, parce que le créneau, lui, **a bien été tiré** ; fusionner les deux axes peindrait en rouge un projet dont l'automatisation marche et en vert celui qui n'a plus rien tiré depuis trois semaines. ⚠️ **L'ordre des règles est celui de `planDueJobs`** : `unwired` **avant** `disabled`, le scheduler écartant les cadences sans handler avant de lire `enabled` — inversé, deux raisons pour un même silence, dont une fausse. **`late` vs `missed` se joue sur `DEFAULT_LOOKBACK_MS` importée**, jamais recopiée : au-delà, `dueOccurrences` ne regarde plus en arrière et le créneau est perdu **pour de bon** (borne testée à la milliseconde, `instantMs > since` ⇒ un créneau **sur** la borne est déjà `missed`). Un créneau antérieur à `projects.created_at` vaut `never_due`, mais une date **inconnue** ne blanchit rien. `normalizeAutomationFilters` n'accepte un `since` **qu'au format DB** — une chaîne libre irait dans un `>=` sur une colonne `text`, où elle écarterait des lignes au hasard. **25 tests.** |
| **`src/lib/server/automations.ts`** *(DASH-006 lot 1)* | **Lecture DASH-006 — le CROISEMENT.** Les créneaux d'abord, la base ensuite : on ne va chercher que les runs des créneaux **attendus**, au lieu de ramener un historique et d'y deviner ce qui manque. La jointure porte sur `(project_id, run_type, period_end)`, où `period_end` est le **créneau LOCAL** écrit par `planOne` — et non un intervalle autour de l'instant, qui apparierait un run au créneau voisin le jour du changement d'heure, précisément là où la question se pose. Premier lecteur de **`monitoring_runs`/`monitoring_steps`** depuis DATA-003 : les steps sont réduits à la **dernière tentative** par `step_type` (sinon un step relancé avec succès se lit comme un demi-échec permanent), et « dernière réussite » est un `DISTINCT ON (project_id, run_type)`. ⚠️ **`flags.ts` est importé en DYNAMIQUE** (il tire `$env/dynamic/private`) et rend **`null` hors SvelteKit** — « non lisible », jamais « tous à false », qui serait une affirmation sans preuve. |
| **`src/routes/(app)/automations/+page.*`** *(DASH-006 lot 1)* | La page cross-projet : bandeau de résumé (le seul élément qui se lit sans rien déplier), calendrier créneau attendu ↔ run observé, liste de runs filtrable, panneau « Règles effectives » (quotas JOB-006 · flags GOV-005 · politiques d'avis DATA-007). Le loader ne juge rien. Colonne **« Type / créneau »** et non « Cadence » : `manual` et `post_publish` sont des `run_type` **sans cadran**, les ranger sous « cadence » ferait chercher un créneau qui n'existe pas. |
| **`src/lib/server/home-state.ts` · `home.ts` · `(app)/+page.svelte`** *(DASH-006 lot 1)* | Le compteur **`runs_period` cesse d'être muet** : il rendait `href: null` faute de liste capable de reproduire son filtre (`/jobs` liste des **jobs**), et il ouvre désormais `/automations` avec le **même `since` et le même `status`**. `runCounters` est **dérivé de `runStatusCounts`** — il n'existe donc pas deux définitions de « les runs `failed` de la période ». Sans slug : **aucun paramètre projet**, le compteur de l'accueil comptant tous les projets. |
| **`src/lib/server/job-console.ts` · `jobs-claim.ts` · `(app)/jobs/+page.*`** *(DASH-006 lot 1)* | Filtre **`?run=`** sur la console : « les 6 jobs de ce run » n'ouvrait aucune liste capable de les reproduire (projet + type ramènent aussi les runs voisins). `countJobsByStatus` le respecte **comme `projectSlug`** — des compteurs comptés sur toute la file annonceraient des jobs que la liste n'affiche pas. Bandeau visible dans l'en-tête : ce filtre n'a **aucun contrôle** dans la barre (il se pose depuis `/automations`), et un filtre actif invisible ferait lire « la file est presque vide ». |
| **`scripts/dash-006-automations-proof.ts`** | **Preuve DASH-006 sur Neon (13 vérifs)** : chaque verdict confronté à une requête **indépendante** sur `monitoring_runs`, et l'invariant « pas de run ⇒ jamais `ok` » ; **le point du lot** — un run sentinelle `failed` posé sur le créneau manquant passe la planification à `ok` **tout en affichant l'échec**, et son retrait la fait retomber **exactement** dans son état d'avant ; deux tentatives d'un même step réduites à la dernière ; le compteur de l'accueil **rejoué depuis son URL** (11 → 11) ; `/jobs?run=` égal à un `count(*)` direct. Ce qui n'est pas prouvable faute de donnée est **nommé** (`⏭️`), jamais compté comme un succès. Sentinelle `__test_dash006:`, nettoyage enfants d'abord. |
| **`src/lib/server/home-state.ts`** (+ `.test.ts`) *(couverture de diagnostic)* | **`deriveDiagnosisCoverage` + `classifySignal` étendu** — la seconde moitié de « une intégration cassée est distincte d'une baisse de performance ». Le pipeline dit si la donnée **arrive** ; il ne dit rien de ce qu'on en a **fait**. `barberconcept` collectait bien et s'affichait « Sain » sans avoir jamais été détecté : ses zéro findings étaient une page blanche, pas un bulletin de santé. **L'invariant : `ok` n'est atteignable que sur un diagnostic complet** — ce qui est POSITIVEMENT su passe toujours (un critique reste un critique malgré l'angle mort), c'est la conclusion au vert qui exige d'avoir tout examiné. ⚠️ **Trois degrés qui ne se confondent PAS** : rien d'examiné → `unknown`, partiellement examiné sans rien trouver → **`watch`**, tout examiné → le verdict des findings. La 1re version renvoyait `unknown` dans les deux cas — vérifié sur Neon, `detect:index_transition` n'ayant jamais tourné nulle part, **les 6 projets viraient au violet** et « 6 à traiter sur 6 » ne distinguait plus le projet jamais ouvert de celui suivi depuis des semaines. `expectedCount === 0` vaut **`none`, pas `full`** : couper la planification d'un projet ne le rend pas sain. **46 tests.** |
| **`src/lib/server/home.ts`** *(couverture de diagnostic)* | **`DETECTOR_JOB_TYPES` dérivé du CATALOGUE** (`SCHEDULE_CATALOG` filtré sur `detect:*`) et non d'une liste tenue à la main — ajouter un détecteur l'intègre d'office à la couverture, sinon un détecteur neuf ferait passer les projets pour **couverts avant d'avoir tourné une seule fois**. `loadExpectedDetectors` lit `project_projections` en **UNE** requête puis résout en mémoire (un `loadProjectScheduleConfig` par projet rendrait six allers-retours à l'accueil) ; `loadDetectorLastSuccess` ne compte que les jobs **`succeeded`** — un détecteur mort en dead-letter n'a rien diagnostiqué, le compter comme passage referait l'erreur qu'on corrige. Projet sans projection ⇒ défauts SPEC via la clé `__default__`. |
| **`scripts/dash-002-home-proof.ts`** *(section B-ter)* | Ce que vitest **ne peut pas** prouver : que la couverture rendue correspond aux jobs détecteurs **réellement** réussis en base (comparé par un `count(DISTINCT type)` indépendant, projet par projet), qu'aucune carte ne se dit `ok` sans couverture complète, et que **sur un pipeline sain l'inconnu est imputé au DIAGNOSTIC et non à la collecte** — sans ce dernier contrôle l'assertion passerait aussi bien pour une tout autre cause, et l'intégration sentinelle de la section B en fabrique justement une (première rédaction du test : rouge sur `barberconcept`, cassé exprès à cet instant). |
| **`project-cockpit-state.ts` · `home-state.ts` · `(app)/+page.svelte` · `(app)/+layout.svelte` · `projects/[slug]/+page.svelte`** *(revue visuelle)* | **Règle établie par la revue : deux mesures différentes ne portent jamais le même mot, et un verdict ne dit jamais plus que ce qu'il a regardé.** `derivePanelState` rend `collecte à jour` et non `à jour` — le badge mesure la fraîcheur de l'**intégration**, le caveat GSC-004 la complétude de la **donnée**, et les deux tombent dans le même encadré (sur `barberconcept`, trois « à jour » contre un « données pas à jour »). `buildHeadline` case `ok` rend `Collecte et performance au vert` : le seul verdict nu des cinq, alors que la fonction se donne pour règle de **nommer toujours l'axe** — « Rien à traiter » niait les 4 propositions du compteur voisin, que la santé ne lit pas. Les notes `inactive` passent en deux-points (`${label} : aucune intégration déclarée`) : concaténer `non branché` accordait au masculin quel que soit le domaine. ⚠️ **Les deux tests correspondants assertent la PROPRIÉTÉ, plus la tournure** (qu'une intégration désactivée ne ressorte pas son `last_error_code` ; qu'un projet sain nomme ses axes avec 6 findings ouverts) — c'est ce qui rendait le libellé fautif intouchable. |
| **`src/lib/server/project-cockpit-state.ts`** (+ `.test.ts`) | **Purs DASH-003** : **`ProvenanceTrio`** — période / fraîcheur / source, exigé par `buildPanel`, donc un panneau **ne peut pas exister** sans dire d'où il sort (une règle qui ne vivrait que dans un template se perdrait au premier refactor) ; **`derivePanelState`**, où **l'ordre des règles EST la décision** : désactivé ⇒ `inactive` **quoi qu'il porte par ailleurs** (une intégration éteinte garde son vieux `last_error_code`), activé + `error`/`revoked`/`down` ⇒ `broken`, sinon la fraîcheur tranche — et **`hasData` prime sur l'absence de ligne d'intégration** (un projet peut collecter sans registre : dire « non branché » serait démenti par l'écran d'à côté). **`external: false`** pour les domaines internes : le diagnostic n'a pas de credential, « non branché » y serait un contresens. `rankPanels` met `inactive` **après** `ok` (aucun geste à faire). `summarizeIndexation` : `excluded` **hors dénominateur** (un noindex est une décision du site), taux `null` et non 0 % quand rien n'a été mesuré. `buildTimeline` : ordre **TOTAL** (temps, nature, id), horodatage illisible **à la fin**, troncature **comptée**. **19 tests.** |
| **`src/lib/server/project-cockpit.ts`** | **Lecture DASH-003.** ⚠️ **La carte de santé vient de `loadHomeCockpit`, et de nulle part ailleurs** — recalculer les six domaines ici ferait deux définitions de « projet à risque » qui divergeraient au premier seuil modifié, et le même projet serait noté différemment sur deux écrans. Coût nul : les requêtes de l'accueil sont **déjà groupées par projet**. Ajoute le DÉTAIL que l'accueil n'a pas la place de porter : `loadGscWindows` (GSC-004), `countIndexClasses` + `loadDueSelections` (**premier lecteur** d'`indexing-read.ts` et d'`index_selection`), et la timeline. **Les décisions se lisent dans `action_proposals`** : `proposal_approvals` seul manquerait tous les **rejets**, `finding_events` seul manquerait les décisions sur une proposition **sans finding**. Seuil de fraîcheur d'indexation à **15 j** (≠ 10 j GSC) : l'inspection est une **sélection**, pas une collecte de masse. |
| **`src/routes/(app)/projects/[slug]/`** *(DASH-003)* | `+page.*` = le cockpit (le loader ne calcule rien) ; `+layout.svelte` = la barre d'onglets, qui **ne montre que ce qui existe** (un onglet mort apprend à ne plus cliquer) ; `content/+page.*` = le calendrier de contenus **déplacé** (`git mv`, `R100` — un déplacement, pas une réécriture, sinon une régression passerait inaperçue). Un slug inconnu rend **404**, jamais une page vide qui se lirait « ce projet n'a rien ». |
| **`scripts/dash-003-project-proof.ts`** | **Preuve DASH-003 sur Neon (25 vérifs), ZÉRO réseau** : **l'invariant anti-divergence** — carte du cockpit == carte de l'accueil, `JSON.stringify` champ par champ ; intégration **désactivée** porteuse d'un code d'erreur ⇒ `inactive`, **contre-épreuve** la même activée ⇒ `broken` + projet en collecte cassée ; **une proposition rejetée SANS finding** (0 `finding_event` vérifié en SQL) apparaît quand même dans la timeline, avec son niveau d'autorisation et son lien ; aucun panneau sans source, aucune plage inventée, aucun « 0 h » là où rien n'a été collecté ; timeline stable d'un appel à l'autre ; slug inconnu ⇒ `null`. Sentinelles `__test_dash003`, nettoyage enfants d'abord. |
| **`src/lib/server/collectors/index-selection-state.ts`** *(IDX-004 lot 2)* | **`postPublishSelections`** — une échéance par offset, datée depuis la **PUBLICATION** et jamais depuis « aujourd'hui » (sinon une transition rejouée rendrait d'autres dates, et l'idempotence par `(url, due_date)` s'effondrerait). ⚠️ **Ne passe PAS par `allocate`** : `dedupeCandidates` fusionne par URL, donc les trois échéances d'une page y deviendraient une seule ligne — « une URL, un slot » vaut pour **une journée**, pas pour trois rendez-vous futurs. URL non normalisable ou date illisible ⇒ **rien** (une échéance jamais honorable serait due pour toujours). **`manualSelections`** — coupe au budget **en conservant l'ordre d'entrée** : un tri réordonnerait la priorité de l'opérateur à sa place, puis couperait ailleurs qu'il ne croit. Seul import du module : `normalizeUrl` (pur). |
| **`src/lib/server/collectors/index-selection.ts`** *(IDX-004 lot 2)* | **`scheduleIndexChecks`** (enveloppe base : normalise la date, délègue le jugement, `persistSelections`) — **n'inspecte rien et ne consomme aucun quota**, ce qui permet de l'appeler depuis une route HTTP. L'idempotence vit dans les **DATES** : rejouer une publication n'écrit rien, **republier** pose de nouvelles échéances — précisément ce que la clé de `schedulePostPublish` (sans `publishedAt`) ne sait pas faire, et la raison pour laquelle elle n'est pas réutilisée. **`selectManualUrls`** — repasse par `loadSelectionSettings` → `resolveProjectSelection` → `loadGlobalPoolUsed` → **`resolveBudget`** en `scope: 'due'` : un audit à la main ne peut pas vider le pool des six projets. |
| **`src/routes/api/content/[id]/status/+server.ts`** *(IDX-004 lot 2)* | Le déclencheur J+3/J+7/J+28, **sans condition sur `autoSubmitOnPublish`** : ce drapeau gouverne la *soumission* Indexing API, pas le fait de vouloir **savoir** si la page est indexée (même raisonnement qu'`exclude_patterns` au lot 1). Garde de **type** (`article`) : GMB/LinkedIn n'ont pas de page sur le site client. ⚠️ **Un seul `publishedAt`** partagé avec l'écriture de la ligne — un second `new Date()` les ferait diverger d'un jour à la frontière UTC et fausserait la jointure « honorée » pour toujours. `await` mais **sous garde** : planifier est le corollaire de publier, jamais sa condition. |
| **`src/lib/server/schedule-state.ts`** *(IDX-004 lot 2)* | Catalogue **quotidien** à 3 entrées : `collect:url_inspection` en `{ mode: 'policy', scope: 'due' }` puis `detect:index_transition` en arête **obligatoire**. **Aucun prérequis sur l'inspection** — le canal `due` ne lit ni inventaire ni clics, et les prérequis optionnels de l'hebdo l'auraient fait **attendre un tick** derrière un `collect:sitemap` lent pour rien. Sans cette cadence, un J+3 posé le mardi n'aurait été honoré que le lundi suivant. |
| **`scripts/inspect-urls.ts`** *(IDX-004 lot 2)* | Audit manuel borné (`--project`, `--url` répétable, `--file`, `--limit`, `--now`, `--note`). ⚠️ **Dry-run par DÉFAUT — l'inverse du reste de l'outillage** : les autres runners écrivent en base, celui-ci dépense un quota **externe payant**, donc l'oubli d'un drapeau doit coûter zéro appel. `--execute` écrit les intentions **puis** inspecte, avec le **même `now`** pour les deux. Dit tout ce qu'il coupe (non normalisables, doublons fusionnés, troncature, gardes) et, en cas d'échec provider, rappelle que les URLs non observées **restent dues**. |
| **`scripts/idx-004-lot2-proof.ts`** | **Preuve lot 2 sur Neon (25 vérifs), ZÉRO appel Google** : trois échéances datées depuis la publication, chacune portant son détail ; **le point du lot** — au J+3 la passe `due` rend **1** URL et pas 3, les deux autres restant dues **intactes** ; idempotence par les dates (rejouer 3 → 3, republier 3 → 6) ; une observation au J+2 **n'honore pas** J+3, celle du jour même oui ; échéance périmée **comptée** ; `scope: due` ne rend qu'une échéance **malgré 200 pages neuves** en inventaire (contre-épreuve : `full` en rend 17) ; audit manuel coupé à 40/120, `--limit=5` → 5, **`0` → 0**. Réglage `indexing.selection` sauvegardé et restauré. |
| **`src/lib/server/collectors/index-selection-state.ts`** (+ `.test.ts`) | **Purs IDX-004** : le vocabulaire **FERMÉ** `SELECTION_REASONS` (une raison en texte libre ne s'interroge pas en SQL) et ses trois familles ; `resolveSelectionConfig` — ⚠️ **`0` veut dire ZÉRO ici**, l'inverse de `job-limits.ts`, parce qu'on gouverne un quota **externe payant** et non une concurrence interne (lire `0` comme « illimité » brûlerait le pool en un job) ; `computeSampleCap` avec **`MAX_SAMPLE_PCT = 60` clampé**, d'où l'invariant qui porte l'acceptation 1 : `budget >= 1 ⇒ sampleCap < budget`, donc l'échantillon ne peut **jamais** prendre le dernier slot et un réglage forgé à 100 % retombe à 60 ; `resolveBudget` (la réserve urgente n'est déductible que d'une passe `full` — une passe `due` y a accès, c'est **le** mécanisme cross-projet) ; `allocate` (urgent → routine → sample, les slots inutilisés passant à la famille suivante **dans les deux sens**) ; `dedupeCandidates` (une URL, une place, mais les raisons secondaires **conservées** dans `alsoBecause`) ; `compareCandidates` (ordre **TOTAL**, dernière clé l'URL — sans quoi « rejouer la politique » ne vérifierait rien) ; `isSampleDue` (**jamais observée ⇒ due**, ce qui fait démarrer la rotation d'un projet neuf) ; `isExpired`. **59 tests.** |
| **`src/lib/server/collectors/index-selection.ts`** | **IO IDX-004** : triptyque de réglages (`SELECTION_SETTINGS_KEY` = `indexing.selection`, `load*` qui **ne lève jamais**, overrides projet dans `project_projections` qui ne peuvent que **RESSERRER**) ; `loadDueSelections` — « honorée » se **DÉRIVE** par un `NOT EXISTS` **corrélé** (une jointure dupliquerait la ligne autant de fois que l'URL a d'observations, leçon DASH-002) et le `>=` y porte toute la sémantique J+N ; `loadGlobalPoolUsed` (**BORNE INFÉRIEURE** : ne compte ni les échecs, ni les illisibles, ni le skill `/seo-index-diagnose` ni la route legacy `seo-data`, qui tapent le même service account — d'où un pool à 800 et non 2 000) ; `collectCandidates` (réutilise `decideStrategic`/`loadClicksByUrl`/`loadProjectTransitionOverrides` **d'IDX-005** : redéclarer « page stratégique » ferait protéger une page qu'on n'inspecte jamais) ; `persistSelections` en **`DO NOTHING`** (une échéance garde sa raison, son détail et son run d'origine) ; `planInspectionSelection` — ⚠️ **écrit AVANT que la collecte parte**, sans quoi un 429 au 3ᵉ appel perdrait les intentions suivantes et rien ne serait replanifié. |
| **`src/lib/server/db/schema.ts`** *(IDX-004)* + `drizzle/manual-idx-004.sql` + `scripts/apply-idx-004.ts` | **Seul DDL du lot** : `index_selection`, table **vide** à la création (58 → **59 tables**). Registre des **DÉCISIONS**, jamais du résultat : **aucune colonne `status`** (ce serait un second état persistant dont personne n'est propriétaire du retour — motif du `health_status` rejeté par JOB-006). ⚠️ Table **OPTIMISTE** : une ligne est une **intention**, pas une preuve d'inspection ; tout comptage de fait passe par la jointure à `index_observations`. L'unique `(projet, url_normalized, due_date)` **EST** l'anti-duplication de l'acceptation 3, et `url_normalized` est aussi la chaîne envoyée à Google — sinon `/a` et `/a#x` paieraient deux slots et produiraient **deux séries de longueur 1**, trop courtes pour que `confirmTransition` conclue jamais. |
| **`src/lib/server/collectors/sitemap-inventory.ts`** *(IDX-004)* | `loadInventoryAt` (une date **exacte**, pour rejouer une sélection contre un snapshot connu) et `loadLatestInventory` (à ou **avant** une date). `loadPreviousInventory` ne sait rendre que « strictement antérieur », ce qui sert le diff mais ferait travailler la sélection sur l'inventaire de la semaine passée — donc ignorer les pages parues **aujourd'hui**, exactement ce que la raison `new` existe pour attraper. |
| **`src/lib/server/job-runner.ts`** *(IDX-004)* | Handler `collect:url_inspection` à **deux modes**, et la **non-régression est portée par le DÉFAUT** : `mode` absent ⇒ `explicit` ⇒ le chemin d'IDX-002 mot pour mot (la faire dépendre d'une condition l'exposerait au premier payload mal formé). `scope` défaut **`due`** : un job forgé ne peut pas déclencher un tirage complet. ⚠️ **UN SEUL `now`** passé à la sélection **et** à `collectUrlInspection` (qui l'acceptait déjà sans le recevoir) : un job démarré à 23:59:58 UTC aurait inscrit sa sélection au jour J et son observation au jour J+1, rendant la jointure « honorée » fausse **pour toujours**. |
| **`src/lib/server/schedule-state.ts`** *(IDX-004)* | Catalogue hebdo à **6 entrées** : la branche d'indexation se referme. Le payload porte une **INTENTION** (`{ mode: 'policy', scope: 'full' }`) et jamais une liste d'URLs — `scheduler.ts` sérialise un **littéral**, et une sélection calculée au plan précéderait l'écriture de l'inventaire du jour. Prérequis de l'inspection **OPTIONNELS** (un sitemap 404 ou un 429 GSC ne doit pas priver le projet de ses findings et échéances) ; arête vers le détecteur **OBLIGATOIRE**. ⚠️ Optionnel ≠ sans effet : un prérequis `queued`/`running` fait **ATTENDRE**. |
| **`src/lib/server/retention-state.ts`** *(IDX-004)* | `index_selection` en catégorie **`audit`**, sans limite, `requiresL4` : « pourquoi cette page a coûté un appel le 12 mars » est une question d'audit, pas une mesure qu'on agrège — et purger ce registre effacerait la seule trace des inspections **dues et jamais honorées**. |
| **`scripts/idx-004-selection-proof.ts`** | **Preuve IDX-004 sur Neon (42 vérifs), ZÉRO appel Google** : acceptation 1 vérifiée **EN SQL sur `bucket`** (200 candidats, budget 40 → 16 lignes ; réglage forgé à 100 % → 24, jamais 40) ; chaque raison écrite **prouve** sa raison (`finding` cite son id, `changed` cite le `lastmod` avant **et** après) ; **le point du lot** — collecte interrompue après 3/10 → 7 dues, reprises avec `count(*)` **inchangé**, et la **contre-épreuve C-bis MESURE** le faux signal (intentions effacées ⇒ **0 due**, les 7 URLs payées deviennent invisibles) ; J+4 n'honore pas J+7 ; réserve cross-projet (`full` = 0 et le **dit**, `due` passe) ; échéance périmée **comptée** ; mode `explicit` n'écrit **aucune** ligne. Le réglage `indexing.selection` est **sauvegardé et restauré**. |
| **`src/lib/server/detectors/index-transition-state.ts`** (+ `.test.ts`) | **Purs IDX-005** : `confirmTransition` — le cœur du lot, où **`unknown` n'est pas un état** (une inspection illisible ne rompt pas un streak **et** ne le confirme pas : sans la 1re moitié une erreur de lecture repousserait indéfiniment la confirmation, sans la 2ᵉ un trou vaudrait preuve) et où **`excluded` n'est jamais un `index_drop`** (`indexed → noindex` est une décision du site) ; `classifyNotIndexedKind` **affine** `classifyCoverage` sans la dupliquer (elle reste l'autorité, consommée par `indexing-read.ts`) ; `buildStateSeries` (ordre **total**, donc rejouable quel que soit l'ordre d'arrivée) ; `computeTransitionConfidence` (streak / oscillations / trous — **dérivée, jamais stockée**, une observation unique plafonnée à 40) ; `deriveTransitionSeverity` (**`critical` RÉSERVÉ** au cas notifiable §14.3 ; non confirmé ou confiance < 50 → plafond `medium`) ; `decideStrategic` (déclarée **ou** ≥ N clics — **aucune** page stratégique sans donnée ni déclaration, jamais « toutes ») ; `shouldNotifyImmediately` + `NOTIFY_IMMEDIATELY_REASON` (le **SIGNAL** ; le canal est TEL-002). **42 tests.** |
| **`src/lib/server/detectors/index-transition.ts`** | **IO IDX-005** : lit la série, construit le contexte stratégique (clics GSC **normalisés par `normalizeUrl`** — sinon la déclaration ne rejoint jamais la mesure), écrit findings + événements (**seulement** création ou mouvement de sévérité), puis réconcilie **une passe PAR TYPE** avec **son `scope`** — mélanger les closures ferait passer pour absente une page dont le problème a changé de **nature**. Le `scope` couvre les 3 types pour **toute URL observée**, pour qu'une page redevenue indexée puisse se résoudre. `recommended_skill = seo-index-diagnose`. |
| **`src/lib/server/findings.ts`** *(IDX-005)* | **`ReconcileDetectionInput.scope`** (optionnel) + **`outOfScope`** au résultat. Ce détecteur n'est **PAS autoritaire sur son projet** (l'inspection coûte du quota et ne couvre qu'une sélection) : hors portée, le finding est laissé **strictement intact**, `consecutive_misses` compris — l'incrémenter compterait un manque de **mesure** comme une preuve de **guérison**. `outOfScope` est distinct de `held` (« une décision les protège ») : les confondre ferait lire « maintenu par décision » là où personne n'a rien décidé. Champ absent ⇒ comportement **inchangé** (`keyword-opportunity.ts` non touché). |
| **`src/lib/server/indexing-read.ts`** *(IDX-005)* | **`loadIndexSeries`** — l'historique de **toutes** les URLs sur une fenêtre bornée. Ni `loadIndexHistory` (une URL) ni `loadLatestIndexStates` (le dernier état) ne peuvent nourrir une comparaison consécutive à l'échelle d'un projet. Le poser ici garde ce fichier comme **unique porte** de lecture de l'indexation : un détecteur avec son propre SQL finirait par diverger de l'écran qui affiche le même état. |
| **`src/lib/server/job-runner.ts` + `job-limits.ts`** *(IDX-005)* | `detect:index_transition` : handler + provider **`none`** (il relit des observations **déjà payées** — le classer `gsc` le mettrait au repos avec la cohorte au premier 429, pour un quota dont il n'a pas besoin). **Au catalogue hebdo depuis IDX-004**, en arête **obligatoire** `collect:url_inspection → detect:index_transition`. ⚠️ Cette arête garantit l'**ORDRE, pas la FRAÎCHEUR** : une inspection sans rien à faire réussit (zéro URL ⇒ `succeeded`), donc le détecteur tourne sur ce que sa fenêtre contient déjà. Ce n'est pas un bug — le `scope` borne sa portée aux URLs réellement observées — mais ne pas la lire comme « il ne voit jamais du périmé ». |
| **`scripts/detect-index.ts`** | Runner IDX-005 (`--project=<slug\|all>`, `--lookback`, `--dry-run`, `--limit`, `--now`) : run+step de traçabilité, et surtout deux choses **dites** plutôt que tues — la troncature, et le **hors-portée** (« aucune inspection ne les a couverts, donc rien n'a été conclu »). Tant qu'IDX-004 n'existe pas, il annonce `aucune observation d'indexation sur la fenêtre` au lieu d'un silence qu'on lirait comme « tout va bien ». |
| **`scripts/idx-005-transition-proof.ts`** | **Preuve IDX-005 sur Neon (31 vérifs)** : 3 runs → **1 seul `created`** et `occurrence_count` à 3 ; bascule isolée `pending`/confiance 40/`medium`/0 notifiable, puis confirmée → 90/`critical`/`aggravated` **même finding** ; **le point du lot** — une URL non ré-inspectée reste `open` avec `consecutive_misses` **à 0**, et la **contre-épreuve C-bis MESURE** le faux signal évité (la même scène sans `scope` : `open → resolved`) ; page réparée résolue seulement après **2 absences constatées**, puis récidive → `reopened` avec `created → resolved → reopened` intact ; les deux silences (`noindex`, illisible). Dates **2018-11-%**, domaine `sentinelle-idx005.test`, nettoyage **enfants d'abord**. |
| **`src/lib/server/collectors/url-inspection-state.ts`** (+ `.test.ts`) | **Purs IDX-002** : **`InspectionOutcome`** — union discriminée `result` \| `provider_error` dont les branches ne partagent **aucun champ exploitable**, ce qui rend « erreur provider ≠ non indexé » impossible à confondre (le legacy rendait `unknown` pour les deux) ; `parseInspectionResult` (7 colonnes + payload SPEC §9.2, `understood: false` sur une enveloppe illisible — écrire des `null` se lirait comme « Google ne connaît pas cette page ») ; listes **plafonnées à 50 et troncature DITE** (le payload d'observation **jette** au-delà de 32 Ko : une page très maillée s'auto-saboterait) ; `classifyCoverage` où **`excluded` est une classe à part** de `not_indexed` (décision du site vs problème à traiter) ; `canonicalMismatch` (`null` = incomparable, jamais « d'accord ») ; `capUrls` (dédup + plafond dur **200**). **18 tests.** |
| **`src/lib/server/collectors/url-inspection.ts`** | **IO IDX-002** : `inspectOne` (seul endroit où une `GscApiError` devient une valeur, et elle devient un `provider_error` **explicite**) et `collectUrlInspection` — écriture **INCRÉMENTALE**, l'inverse de GSC-002 et délibérément : une URL inspectée est un fait **autonome** que rien ne compare à un total attendu, donc perdre 199 inspections payées au quota pour la 200ᵉ serait absurde. Mais une **erreur provider interrompt et REMONTE structurée** : l'absorber URL par URL brûlerait les suivantes contre un mur et la file n'apprendrait rien. Pause **150 ms** (600 req/min par propriété). |
| **`src/lib/server/gsc-auth.ts`** *(étendu IDX-002)* | `urlInspection()` posée **à côté de** `searchAnalyticsPage` : hérite `toGscApiError`, donc les erreurs sont **structurées gratuitement** et `classifyJobFailure` est exact sur les deux cas que Google fait à l'envers (403 `rateLimitExceeded` → `quota`, 400 `invalid_grant` → `auth`). Scope déjà présent dans `COMBINED_SCOPE` — aucun nouveau consentement. |
| **`src/lib/server/indexing-read.ts`** | **Lecture IDX-002, SANS RÉSEAU** — l'acceptation « le statut UI est dérivé de champs persistés » : `loadLatestIndexStates` (`DISTINCT ON (url)`, une requête), `loadIndexHistory` (du plus récent au plus ancien), `countIndexClasses` (agrège **en mémoire** via `classifyCoverage` : une reproduction SQL divergerait au premier libellé nouveau de Google), `loadInspectionFreshness` (`null` = jamais inspecté, état À PART). ⚠️ **Aucun écran ne le consomme encore** — c'est DASH-003 (piège AGT-000 assumé et daté). |
| **`scripts/idx-002-inspection-proof.ts`** | **Preuve IDX-002 sur Neon (32 vérifs)** : les **7 cas d'erreur classés par la file**, l'erreur provider qui **n'écrit rien** contre la page non indexée qui **produit une ligne qualifiée** (les deux distinguables **en base**), la réponse 200 illisible comme **3ᵉ état nommé**, rerun du jour qui rafraîchit vs jour antérieur **intact**, `referringUrls` de 400 entrées tronqué **sans échec**, plafond rapporté, bail perdu. **+ 1 inspection RÉELLE** (`--skip-real` pour l'éviter) : `sc-domain:barberconcept.ch` → `verdict=PASS`. |
| **`src/lib/server/collectors/sitemap-state.ts`** (+ `.test.ts`) | **Purs IDX-001** : `parseSitemapXml` (racine réelle qui décide `index` vs `urlset` ; un `<url>` sans `<loc>`, un `<loc>` relatif, un corps non-XML produisent une **`SitemapError`** — jamais un silence, ce que `catch {}` rendait impossible) ; `normalizeUrl` (fragment retiré, hôte minusculé — **mais slash final et query CONSERVÉS** : les retirer ferait fusionner deux pages et le diff annoncerait un retrait) ; `extractAlternates` (une alternate n'est **pas** une page nouvelle) ; `dedupeEntries` (**avant** l'INSERT : Postgres rejette tout le lot sur un doublon) ; `admitSitemap` (cycle / profondeur / budget, bornes **rapportées**) ; **`diffInventories`** — fonction **pure** de deux listes, sorties triées, d'où la reproductibilité. **31 tests.** |
| **`src/lib/server/collectors/sitemap-inventory.ts`** | **IO IDX-001** : parcours en largeur avec `visited`, **RIEN n'est écrit avant que tout l'arbre soit parcouru** (un inventaire tronqué produirait des **retraits fantômes** au run suivant — la preuve le mesure), un fichier mort devient un **fait persisté** et n'annule pas ses frères (`partial: true`), `loadPreviousInventory` cherche le dernier inventaire **strictement antérieur** (sinon un 2ᵉ run du jour se comparerait à lui-même et rendrait un diff toujours vide), `resolveSitemapRoot` (explicite → `indexing_credentials.sitemap_url` → dérivée, cette dernière étant une **convention** et non une découverte). |
| **`src/lib/server/db/schema.ts`** *(IDX-001)* + `drizzle/manual-idx-001.sql` + `scripts/apply-idx-001.ts` | **Seul DDL des deux lots** : `sitemap_url_observations`, contrat DATA-004, table **vide** à la création (57 → **58 tables**). **Snapshot complet par date et non un journal** — c'est ce qui fait du diff une fonction pure, donc rejouable. ⚠️ L'unique porte **`url_normalized`**, pas `url` : sinon `/a` et `/a#x` feraient deux lignes et le diff inventerait un ajout **à chaque run**. `sitemap_url` est dans le `set` d'upsert (une URL peut **migrer** d'un enfant à l'autre sans cesser d'être la même page). |
| **`src/lib/server/observations.ts`** *(IDX-001)* | Le domaine `sitemap` **sort** des tables spéculatives : `upsertSitemapObservation` (par FICHIER — c'est par `errors > 0` qu'un sitemap injoignable devient **interrogeable en SQL**) et `upsertSitemapUrlObservations` (par URL, chunké, `fetched_at` **format DB**). |
| **`scripts/idx-001-sitemap-proof.ts`** | **Preuve IDX-001 sur Neon (43 vérifs)**, `fetchImpl` **injecté** (donc 0 réseau, 0 quota, et un 404 provoqué à la demande) : arbre découvert malgré un enfant mort, **404 persisté nommément**, injoignable et malformé **comptés séparément** (un problème réglé ne masque pas l'autre), diff +1/−1/~1 **rejoué à l'identique deux fois**, fragment sans faux ajout, cycle stoppé, **et la mesure du faux signal évité** (run tronqué → 4 retraits annoncés, jamais écrits), bail perdu → **rien écrit**. `indexing_submissions` **441 → 441** : aucune URL retirée n'est désindexée. |
| **`src/lib/server/home-state.ts`** (+ `.test.ts`) | **Purs DASH-002** : `classifyProject` tient **DEUX axes qui ne fusionnent jamais** — `pipeline` (la donnée arrive-t-elle ?) et `signal` (que dit-elle ?) — et surtout **un pipeline cassé rend le signal `unknown`, jamais `ok`** : sans cette règle un projet dont la collecte est morte afficherait « 0 nouveau finding » et se lirait comme le plus sain du portefeuille. `deriveFreshness` (« jamais collecté » = `ageHours: null`, **jamais 0**) · `CounterFilter`/`buildCounter` (le nombre ET son lien depuis **un seul** descripteur ; `href: null` quand aucune liste ne saurait reproduire le filtre) · `rankProjects` (ordre **total**, `unknown` **avant** `watch` — un projet muet est le seul qui puisse tout cacher) · `summarizeCosts` (gate **inerte**, « non instrumenté » et pas zéro). **37 tests.** |
| **`src/lib/server/home.ts`** | **Read-model DASH-002**, une lecture par DOMAINE groupée par projet (six projets × sept compteurs feraient 42 allers-retours). ⚠️ `loadActivity` compte **`DISTINCT finding_id`** et non des lignes de journal — bug trouvé en écrivant la preuve : un finding aggravé deux semaines de suite annonçait « 2 aggravés » pour **un** problème, et `reconcileDetectionRun` en écrit un par run. Les cumuls cross-projet sont la **somme des cartes**, jamais une requête de plus. |
| **`src/lib/server/findings.ts`** *(DASH-002)* | Filtre d'**ACTIVITÉ** `activityEvents`/`activitySince` — clause **EXISTS** sur `finding_events` (une jointure dupliquerait la ligne autant de fois qu'elle a d'événements et ferait mentir `countFindings`). C'est lui qui rend les liens des compteurs honnêtes : compteur et liste passent par la **même** clause. |
| **`src/routes/(app)/+page.server.ts` + `+page.svelte`** | **L'accueil EST le cockpit** (SPEC §13.1) : projets à traiter d'abord, triés par urgence, chacun avec **une phrase qui nomme l'axe** ; les deux axes rendus côte à côte et jamais fondus ; compteurs qui portent leur propre lien (le template n'en construit aucun) ; coûts « non instrumentés ». L'ancien bandeau Content Hub descend en second — rien n'est supprimé. ⚠️ **Jamais vu à l'œil** (pas de session admin, limite JOB-007). |
| **`scripts/dash-002-home-proof.ts`** | **Preuve DASH-002 sur Neon (44 vérifs)** : deux projets réels, deux causes → `broken`+signal `unknown` contre `at_risk`+pipeline sain, **ni le même état ni la même phrase** ; et surtout chaque compteur lié est **rejoué DEPUIS SON URL** — c'est le seul test qui attrape un lien pointant vers un autre ensemble. Plus la contre-épreuve du bug `DISTINCT` (2 aggravations d'un même finding = **1**). |
| **`src/lib/server/gsc-windows-state.ts`** (+ `.test.ts`) | **Purs GSC-004** : `spanToWeeks` (7/28/90 j = **1/4/13 semaines** — le canon GSC est hebdomadaire, une fenêtre au jour près serait une précision que la donnée n'a pas), `buildWindowComparison`, **`computeWindowDelta`** (le refus entre longueurs incompatibles vit **dans le module pur**, pas dans un `{#if}` qui se perdrait au premier refactor), `windowCompleteness` (l'incomplétude **BAISSE la confiance**, dérivée et jamais stockée, avec deux caveats distincts : pas assez de semaines vs pas la dernière), `buildYoyComparison` (**inerte** jusqu'en 2027, câblé plutôt qu'absent). **18 tests.** |
| **`src/lib/server/gsc-windows.ts`** | **IO GSC-004** : `loadGscWindows` lit le **CANON** (`gsc_query_page_observations`, même source que le détecteur — jamais `gsc_snapshots`, sans quoi l'écran et le détecteur divergeraient) ; **`enqueueGscBackfill`** **reprenable SANS checkpoint** — la reprise est **dérivée** des observations présentes, parce qu'un checkpoint stocké peut **mentir** (une semaine « faite » dont le job a échoué après). ⚠️ `batch` est un **débit**, pas un curseur : rappeler avant collecte re-enfile les mêmes semaines (idempotent, voulu). |
| **`src/lib/server/gsc-settings.ts`** + `src/routes/api/projects/[slug]/gsc/{windows,backfill}/` + `src/routes/(app)/projects/[slug]/windows/` | Latence GSC **réglable sans redéploiement** (`system_settings` → `gsc.latency_days`) — et **le collecteur résout la même** : si seul le read-model la lisait, il jugerait « pas à jour » une semaine que la collecte tient déjà pour finale. Endpoint + panneau ⚠️ **non constatables à l'œil** (pas de session admin). |
| **`scripts/gsc-004-windows-proof.ts`** + `scripts/backfill-gsc.ts` | **Preuve GSC-004 sur Neon (35 vérifs)** : span 90 sur 8 semaines → **delta indisponible**, complétude dérivée, latence relue en base, backfill idempotent qui **AVANCE** dès qu'une semaine devient présente, jamais au-delà de la dernière semaine complète. Semaines sentinelles **2018-2019**. |
| **`src/lib/server/proposal-console.ts`** | **Purs DASH-005** : `normalizeProposalFilters` (l'URL réduite au vocabulaire connu **avant** toute requête ; un `?status` entièrement invalide rend **vide** et ne retombe **pas** sur le défaut — l'utilisateur a demandé autre chose), `OPEN_PROPOSAL_STATUSES` (le défaut = ce qui attend quelqu'un, même choix que `ACTIVE_STATUSES` pour les findings), `proposalAbilities` (statut **et** niveau : rejeter reste possible là où approuver ne l'est pas — refuser n'accorde rien), **`buildApprovalLots`** (lots homogènes projet×action×niveau×risque, **L4 exclu ici et non dans un template**, risque `null` = classe `inconnu`, lot d'un seul = pas un lot, `excluded` toujours rendu), `explainProposal` (`superseded` ≠ `invalidated` ≠ `rejected`, dit à l'écran). |
| **`src/lib/server/proposal-console.test.ts`** | **Vitest DASH-005 — 26 tests** : filtres hostiles écartés, matrice des décisions par statut × acteur, et la table complète du groupement — dont **deux L4 parfaitement homogènes ne formant aucun lot**, et le risque `null` qui ne se mélange jamais à `low`. |
| **`src/lib/utils/proposal-format.ts`** (+ `.test.ts`) | **Libellés partagés pages ↔ (future) CLI** : `ACTION_LABEL`, **`LEVEL_LABEL` + `LEVEL_APPROVER`** (le niveau ET qui peut l'accorder — un `L3` nu ne « indique » rien), `RISK_LABEL` (`inconnu` ≠ `faible`), `PROPOSAL_STATUS_LABEL`, `FINDING_*_LABEL`, `shortHash`, `priorityBand` (la bande 60 est celle du **producteur**, pas une couleur), `prettyJson` (une valeur illisible s'affiche **telle quelle** : une donnée corrompue n'est pas une absence). Les dates viennent de `job-format.ts`, **jamais redéfinies**. **14 tests**, dont la couverture exhaustive des 4 vocabulaires. |
| **`src/routes/(app)/inbox/+page.server.ts` + `+page.svelte`** | **L'inbox**, cross-projet, deux onglets : compteurs par statut cliquables **toujours calculés pour les deux** (un badge calculé seulement à l'ouverture cache ce que l'inbox existe pour montrer), une seule liste paginée, filtres projet/action/risque, et les **lots calculés serveur** — l'écran ne peut pas en fabriquer un que la base refuserait. |
| **`src/routes/(app)/inbox/proposals/[id]/`** | **Une proposition** : payload, **hash affiché en entier** (l'acceptation n'est vérifiable par un humain que s'il peut comparer), rationale/impact, **preuves du finding source**, approbations — **y compris tombées**, avec « portait un autre payload » — et validité **recalculée** par `isApprovalValid` contre le hash courant. |
| **`src/routes/(app)/inbox/findings/[id]/`** | **Un finding (DASH-004)** : faits, `evidence_json` **brut** (aucune synthèse IA sur la page), journal, propositions issues, et les actions **dérivées de `canTransition`** — l'écran ne propose jamais un geste que l'écriture refuserait. Raison obligatoire, durée de veille et motif d'écart en clair. |
| **`src/routes/api/ops/proposals/[id]/{approve,decide}/`** | Décisions individuelles. `approve` **exige** le `payloadHash` affiché (optionnel côté fonction pour le chemin agent, obligatoire ici) ; `decide` porte rejet **et** demande de révision, `mode` inconnu → **400**, jamais un défaut. Codes : 403 niveau, 404 introuvable, **409 hash périmé / plus décidable**. |
| **`src/routes/api/ops/proposals/approve-batch/`** | **Validation groupée** : relit les lignes, **rejoue `buildApprovalLots` côté serveur** et refuse si les ids ne forment pas exactement UN lot — une requête forgée ne peut pas mélanger deux projets ni faire passer une L4. Chaque item porte son hash ; un item écarté **n'annule pas les autres** et le **compte rendu par item** est toujours rendu. |
| **`src/routes/api/ops/findings/[id]/transition/`** | Les entrées humaines du cycle de vie (acknowledge/plan/start/resolve/snooze/dismiss/reopen) : passe par les **raccourcis FIND-003** (qui portent les effets de bord : échéance de veille, catégorie d'écart), raison obligatoire, pré-contrôle `canTransition` pour rendre un 409 lisible plutôt qu'un 500. |
| **`scripts/dash-005-inbox-proof.ts`** | **Preuve DASH-004/005 sur Neon (47 vérifs)** : les 4 acceptations (hash exact — et un hash périmé **n'écrit rien** —, item modifié écarté du lot pendant que les autres passent, **deux L4 homogènes sans lot**, double approbation = **1 seule** ligne d'audit), plus le cycle de vie des findings, la révision **qui survit au run du producteur**, et **0 horodatage ISO**. Bornée par un fingerprint de run ; nettoyage **enfants d'abord** ; base rendue à l'identique. |
| **`src/lib/server/collectors/gsc-collector-state.ts`** (+ `.test.ts`) | **Purs GSC-001/002** : bornes de semaine et `latestCompleteWeekStart` (**8+ jours** — la latence de 3 j ne suffit pas à consolider), `rowKey` (dédup **avant** l'INSERT, invariant du séparateur documenté et testé **tel qu'il est**, aligné sur `rollupPagesFromQueryPage`), agrégats et totaux. |
| **`src/lib/server/collectors/gsc-query-page.ts`** | **IO GSC-002** — le premier type de job qui appelle vraiment un provider : pagine Search Analytics, **n'écrit RIEN avant la fin de la pagination** (une semaine tronquée se lirait comme complète, donc comme une chute), puis **un seul tampon → double écriture** observations + legacy + diff hebdo, et tient la fraîcheur dans `project_integrations`. |
| **`src/lib/server/gsc-weekly-diff.ts`** | `computeWeeklyDiff` **extrait de `gsc-analytics.ts`** (qui garde son `db` statique, donc inchargeable en runner `tsx`) : le collecteur doit pouvoir le rappeler, sinon l'écran affiche des KPI figés au-dessus de données fraîches. Upsert delete+insert, **lecture DB seule — zéro quota**. |
| **`src/lib/server/crypto-core.ts`** | Chiffrement **pur** (clé en paramètre), scindé de `crypto.ts` qui importait `$env` **statiquement** : sans cette scission, aucune preuve du collecteur sur Neon n'était possible. |
| **`scripts/collect-gsc.ts`** | Runner du collecteur (`--project=<slug\|all>`, `--week=`, `--dry-run`, `--test-access`, `--skip-legacy`). ⚠️ **Consomme du quota réel sur le compte partagé par les 6 projets** — `--dry-run` le consomme **aussi**. Affiche la **classe** d'erreur, pas seulement le message. |
| **`scripts/gsc-002-collector-proof.ts`** | **Preuve GSC-002 sur Neon (44 vérifs)** : rerun sans duplication, semaine à zéro ligne qui **n'efface rien**, échec en cours de pagination qui **n'écrit rien**, les 7 cas de `GscApiError` — dont les deux que Google fait à l'envers (403 `rateLimitExceeded` → `quota`, 400 `invalid_grant` → `auth`). |
| **`src/lib/server/job-limits.ts`** | **Purs JOB-006** : `PROVIDER_BY_JOB_TYPE` (type → provider ; **inconnu → `none`**, choix INVERSE de `required` et délibéré), `resolveLimits` (tolérant, **`0` = pas de limite** partout), `resolveProjectLimits` + `concurrencyForProject`/`lapShareForProject` (resserrage par projet), **`planAdmission`** (plafonds global/projet/provider, réserve, refroidissement, budget de fenêtre → **exclusions**, pas un verdict par job : la réclamation choisit elle-même sa ligne) et la **réouverture du TOUR** (quand tous les projets servables ont eu leur part), `computeCapacity` (ce qui reste, **dérivé**). |
| **`src/lib/server/job-limits.test.ts`** | **Vitest JOB-006 — 45 tests** : chaque cause d'exclusion et chaque relâchement, `0` traité comme « pas de limite » et non comme zéro, tolérance de config (absente / mal typée / hors bornes), réouverture du tour — **dont le cas qui a fait échouer une intuition** : un projet OCCUPÉ ne compte pas parmi ceux à servir, sinon le tick s'arrête avec du budget et une file pleine. |
| **`src/lib/server/jobs-limits.ts`** | **IO JOB-006** : `loadSystemLimitOverrides`/`saveSystemLimitOverrides` (clé `jobs.limits`), `loadProjectLimits` (projection `payload.limits`, calque de `loadProjectScheduleConfig`), **`loadQueueSnapshot`** (une photo par tour : `running` **à bail VIVANT**, projets ayant du travail servable — **types de l'appelant + `DEPENDENCY_GATE` importée, jamais recopiée** —, consommation de fenêtre, dernier `quota` du journal), **`coolDownQuotaLimitedJobs`** (pousse `available_at` de la cohorte, **sans toucher `attempts`/`deferrals`** ni écrire de tentative : rien n'a été tenté), `loadCapacitySnapshot` (lecture pour l'écran et la CLI). `providerOf`/`typesForProvider` **substituables** pour les preuves. |
| **`scripts/job-006-limits-proof.ts`** | **Preuve JOB-006 sur Neon (33 vérifs)** : équité réelle en un seul drain (`AABBAAAA`, 2 tours), cohorte entière au repos avec `attempts`/`deferrals` intacts, **garde prouvée AVANT la passe** (le même job refusé *avec* et réclamé *sans*, donc c'est bien ELLE qui refuse — sinon le refus s'expliquerait tout autant par un `available_at` poussé), idempotence, refroidissement expiré qui repart seul, réserve, type inconnu non bloqué **alors que son voisin de cohorte l'est**, limites relues depuis la base, config restaurée à l'identique. |
| **`scripts/limits.ts`** | Réglage des plafonds **sans redéploiement**, DRY-RUN par défaut (`--set clé=valeur`, `--reset`, `--execute`) : affiche l'état, le **diff retenu**, et **annonce explicitement** qu'une valeur hors bornes a été ignorée — au lieu de la laisser croire appliquée. |
| **`scripts/apply-job-006.ts`** + `drizzle/manual-job-006.sql` | DDL additif JOB-006 : **`system_settings`** (KV de portée système, table **vide** à la création — sans ligne, `resolveLimits` rend les défauts du code, donc appliquer le DDL ne change aucun comportement). Le seul écart d'introspection : **57 → 58 tables**. |
| **`src/lib/server/job-graph.ts`** | **Purs JOB-004** : `JobDependency` (`jobId` + `jobType` + `required`), **`parseDependencies`** (tolérant, ne lève jamais ; `required` absent → **`true`**), `serializeDependencies` (vide → `NULL`, pour que la garde SQL court-circuite), **`classifyDependencyGate`** (`wait` / `skip` / `ready` — un prérequis en cours prime sur un prérequis mort, un OPTIONNEL mort ne bloque pas, un prérequis `skipped` **cascade**), **`validateCatalogGraph`** (chaque prérequis déclaré **strictement avant** son dépendant → exclut auto-dépendance et cycles), `resolveDependencies` (types → ids réels). |
| **`src/lib/server/job-graph.test.ts`** | **Vitest JOB-004 — 38 tests** : table de décision complète (optionnel mort → `ready`, obligatoire mort → `skip`, cascade, prérequis introuvable, mort **à côté** d'un vivant → `wait`), tolérance de lecture (JSON cassé, `required` illisible), et les 4 formes de catalogue invalide. |
| **`src/lib/server/jobs-graph.ts`** | **IO JOB-004** : `listBlockedJobs` (jobs `queued` porteurs d'arêtes + statut de leurs prérequis), **`settleBlockedJobs`** (conclut en `skipped` ce qu'aucun prérequis ne débloquera — UPDATE **gardé sur `status='queued'`** + ligne `job_attempts` `system:dependency` **en une transaction**, puis step `skipped`), `loadDependencyStatuses` (aussi consommée par la console). **Aucun état nouveau** : l'attente est dérivée, jamais persistée. |
| **`scripts/job-004-dag-proof.ts`** | **Preuve JOB-004 sur Neon (45 vérifs)** : arêtes écrites vers de vrais ids, dépendant non réclamable (prérequis `queued` **puis** `running`), prérequis mort → **optionnel exécuté / obligatoire `skipped`** avec la cause nommée, journal audité, **run `partial`**, passe **rejouable**, replanification sans doublon. Catalogue **substitué** (`__test_dag:<runId>`), le prérequis meurt **par le chemin réel du worker** (403 nu → `permanent`) — le faire mourir à la main aurait sauté son step et la preuve aurait mesuré son propre raccourci. |
| **`src/lib/server/proposer-state.ts`** | **Purs AGT-000** : `PROPOSAL_ACTION_TYPES` (catalogue **fermé**), `APPROVAL_LEVEL_BY_ACTION` (table **figée** L0–L4, §12.1) + `deriveApprovalLevel` (inconnu → `null`, jamais de défaut permissif), `deriveRiskLevel` (le niveau de l'action, relevé si la page a des **clics à perdre**), `mapFindingToActions` (position ≶ 10 → `meta_rewrite` L3 / `refresh_plan` L2 ; type inconnu → **rien**), **`buildProposalPayload`/`canonicalProposalPayload`** (STABLE dans le temps — c'est lui qui est hashé), `canonicalInputSignature` (volatile, **séparée**), `selectProposableFindings` (statuts actifs + `minPriority`, expose `matched` **et** `selected`), `decideSupersession` (n'écrase jamais une décision prise, **remonte** les `approved` périmées), `decideAutoApproval` (≤ L2 **et** policy `guarded_auto` — refus par défaut). |
| **`src/lib/server/proposer-state.test.ts`** | **Vitest AGT-000 — 49 tests**, dont l'invariant qui tient tout : **mesures qui bougent → payload identique** (sinon l'inbox doublerait chaque semaine), la cohérence de la table des niveaux avec `canActorApprove`, et l'absence de tout champ volatil dans le payload sérialisé. |
| **`src/lib/server/proposers/finding-proposer.ts`** | **IO AGT-000** : `db` **injecté**, ouvre/clôt un **`agent_run`** (y compris **en échec** — un run laissé `running` mentirait à la supervision), lit la config projet (`payload.proposers.finding_proposer`, idiome tolérant), écrit par `createProposal` (idempotent), périme via `supersedeProposals`, journalise un **`agent_comment`** côté finding **à la première proposition seulement**, auto-approuve **uniquement** L0–L2 sous policy. Paramètre **`findingIds`** = substitution pour les preuves (cf. `catalog` de `planDueJobs`). |
| **`scripts/propose.ts`** | Runner AGT-000 **DRY-RUN par défaut** (`--execute`, `--project=<slug\|all>`, `--min-priority`, `--max`, `--limit`) : run+step de traçabilité, rapport annonçant troncature, findings sans action, propositions périmées et **approbations devenues obsolètes**. |
| **`scripts/agt-000-proposer-proof.ts`** | **Preuve AGT-000 sur Neon (41 vérifs)** : idempotence, rafraîchissement des champs **non hashés** à hash constant, supersession, refus d'approbation L3 par un agent, invalidation liée au hash, snooze/dismiss qui tiennent, `agent_run` clos, troncature annoncée, **0 horodatage ISO**, et **base rendue à l'identique**. Bornée par `findingIds` ; nettoyage **enfants d'abord**. |
| **`src/lib/server/schedule-state.ts`** | **Purs JOB-005** : cadences (`SCHEDULE_CADENCES`, `SCHEDULE_DEFAULTS` — hebdo lundi 09:00 §8.1), `zoneOffsetMs`/`utcToZonedFields`/**`zonedFieldsToUtc`** (les deux offsets testés → heure inexistante qui **glisse**, heure doublée résolue à la première), **`formatLocalSlot`** (la clé d'occurrence, LOCALE), `dueOccurrences`/`nextOccurrence`, `resolveScheduleConfig` (tolérant), **`SCHEDULE_CATALOG`** (cadence → jobs ; hebdo = `detect:keyword_opportunity` **puis** `propose:actions`, et depuis **JOB-004** c'est une vraie **`dependsOn` obligatoire**, plus seulement un ordre de service), `postPublishSlots`. `Intl` seul, aucune dépendance. |
| **`src/lib/server/schedule-state.test.ts`** | **Vitest JOB-005 — 38 tests**, dont les **deux bascules DST** (2026-03-29 : 02:30 inexistant → 03:30, lundi 09:00 = 08:00 puis 07:00 UTC · 2026-10-25 : 02:30 doublé → une seule occurrence, journée de 25 h sans créneau sauté) et l'invariant « chaque occurrence est rattrapée par le tick horaire qui la suit ». |
| **`src/lib/server/scheduler.ts`** | **IO JOB-005** : `planDueJobs` (occurrences dues sur une fenêtre de rattrapage, `createRun` + `enqueueJob` avec la clé du **créneau local**, isolation par projet, `catalog` substituable pour les preuves ; **JOB-004** : valide le graphe **avant toute écriture** et résout les arêtes du catalogue en ids réels au fil de la mise en file), `listNextOccurrences` (**calculée**, jamais persistée), `loadProjectScheduleConfig` (projection `payload.schedules`), `schedulePostPublish` (J+3/J+7/J+28 via `available_at`). **Aucune table.** |
| **`src/routes/api/cron/tick/+server.ts`** | **Le battement** (`0 * * * *`, `maxDuration: 300`) : planifie **puis** draine (`runWorker({once})`, budget 240 s via `AbortController`, reaper inclus) ; expose depuis **JOB-006** le bloc `capacity` (`throttledTicks`, `heldByReason`, `quotaPushed`, `laps`). Bearer `CRON_SECRET`. 500 si une moitié tombe — un cron toujours vert ne remonte dans aucune alerte. |
| **`scripts/schedule.ts`** | Runner JOB-005 **dry-run par défaut** (`--execute`, `--now=<ISO>` pour rejouer une date DST, `--project`, `--lookback-hours`, `--next-only`) : occurrences dues + **prochaine exécution par projet** en heure métier ET en UTC. |
| **`scripts/job-005-schedule-proof.ts`** | **Preuve JOB-005 sur Neon (33 vérifs)** : idempotence du créneau (restart et tick en retard), les deux régimes DST écrits en base, chaîne planifier→réclamer→`succeeded`, prochaine exécution par projet, post-publication. Catalogue **substitué** (`__test_schedule:<runId>`) pour ne pas déclencher de vraie détection ; nettoyage enfants d'abord, **`monitoring_steps` compris**. |
| `src/lib/server/finding-state.ts` | Purs DATA-005 **+ FIND-003** : fingerprint, scoring §10.2, dérivation d'événements (dont `unsnoozed`), **`canTransition`** (graphe §10.1), `decideOnRedetection`/`decideOnAbsence`, `isSnoozeExpired`/`computeSnoozeUntil`, `resolveLifecycleConfig`, `ACTIVE_STATUSES` — **+ AGT-000 `parseFindingFingerprint`** : la PAGE d'un `keyword_opportunity` ne vit que dans le fingerprint (`entity_key` ne porte que la query), et une cible d'action doit pouvoir la relire sans deviner le séparateur.
| `src/lib/server/findings.ts` | DATA-005 **+ FIND-003 + AGT-000** : `upsertFinding`, `recordFindingEvent`, `transitionFinding` (légalité + effets de bord du cycle de vie), `snoozeFinding`/`dismissFinding`/`reopenFinding`, `expireSnoozes`, **`reconcileDetectionRun`** — et depuis AGT-000 la **LECTURE**, qui manquait entièrement : **`listFindings`** (défaut = les statuts **ACTIFS**, tri total déterministe) et **`getFindingWithEvidence`**. Brique commune à l'API agent (AGT-001) et à l'inbox (E11). **+ DASH-004** : `countFindings`/`countFindingsByStatus` et un `offset` (liste et total partagent **un seul** jeu de filtres, sinon ils décrivent deux ensembles), le **projet joint** sur chaque ligne (l'inbox est cross-projet) et `getFindingWithEvidence` qui rend aussi le **slug** — un écran lie par slug, pas par id.
| `scripts/apply-find-003.ts` + `drizzle/manual-find-003.sql` | DDL additif FIND-003 (5 colonnes de cycle de vie sur `findings` + index partiel d'expiration de veille) ; vérifie colonnes ET index. |
| `scripts/find-003-lifecycle-proof.ts` | Preuve du cycle de vie sur Neon (37 vérifs : persistance, auto-résolution confirmée, récidive, expiration de veille, snooze et dismiss qui tiennent, transition illégale refusée) ; nettoie ses propres lignes. |
| `src/lib/server/detector-state.ts` | Purs FIND-001/004 : `buildWindow`/`areWindowsComparable` (fenêtres hebdo comparables), `aggregateWindow` (position pondérée), `selectOpportunities` (+ bruit configuré, troncature reportée), `scoreOpportunity` (composantes §10.2), `deriveOpportunitySeverity` (plafond faible volume), `buildOpportunityEvidence` (pointeurs). |
| `src/lib/server/detector-state.test.ts` | Vitest FIND-001/004 — 35 tests (rejouabilité, pondération, seuils, confiance dégradée, plafond de sévérité, preuves). |
| `src/lib/server/detectors/keyword-opportunity.ts` | IO du détecteur : lit les observations, écrit findings + événements, seuils par projet (projection), client db injecté. |
| `scripts/detect.ts` | Runner du détecteur (`--project=<slug\|all>`, `--weeks`, `--dry-run`, `--limit`) : run+step de traçabilité, rapport avec troncature explicite. |
| `src/lib/server/job-state.ts` | Purs JOB-001/002 : `decideAfterFailure` (backoff/dead-letter via DATA-003), bail, heartbeat, `classifyAbandonedLease`/`classifyExecutionError`, vocabulaire des tentatives (+ `deferred`/`requeued` en JOB-003, **`cancelled` en JOB-007**). |
| `src/lib/server/job-state.test.ts` | Vitest JOB-001/002 — 39 tests (backoff exponentiel plafonné, dead-letter au plafond exact, bail, heartbeat, nature d'abandon). |
| **`src/lib/server/job-retry.ts`** | **Purs JOB-003** : `classifyJobFailure` (**raison avant statut** — 403+quota Google, 400+`invalid_grant`), `parseRetryAfter`/`extractRetryAfterMs` (plafond 6 h), `applyJitter` (`random` **injecté**), `RETRY_DEFAULTS` par classe, `decideRetry` (retry / defer / dead + `deadReason`). |
| **`src/lib/server/job-retry.test.ts`** | **Vitest JOB-003 — 55 tests** (table de classification, priorité raison>statut, Retry-After, bornes et déterminisme du jitter, les 4 classes, les deux plafonds). |
| `src/lib/server/jobs-claim.ts` | JOB-001 + JOB-003 + JOB-007 + JOB-004 + **JOB-006** — `claimJob` (`FOR UPDATE SKIP LOCKED`, une instruction), sa **`DEPENDENCY_GATE`** (désormais **exportée** : l'instantané doit compter comme réclamable exactement ce qu'elle laisse passer) et sa **`ClaimCapacity`** (types/projets exclus, réserve en **inclusion**, `saturated` qui ne requête même pas) — la garde de capacité est **à la porte**, pas dans le worker : non réclamable si un prérequis est `queued`/`running`, **ou** si un prérequis **obligatoire** n'a pas abouti (cette seconde moitié ferme la course avec `settleBlockedJobs`) ; `requeueDeadJob` accepte désormais **`skipped`**, pour que le skip ne soit pas un cul-de-sac, `completeJob`/`failJob` (classé)/`releaseJob`, `deferJob` (quota : tentative rendue), `requeueDeadJob` (transactionnel, journalise la reprise), `listDeadJobs`, **`listJobs`/`countJobs`/`countJobsByStatus`/`getJobDetail`** (lecture de la console) et **`cancelJob`** (transactionnel : retire le bail, clôt la tentative ouverte, écrit la ligne d'audit). |
| `src/lib/server/job-runner.ts` | JOB-001/002 + **JOB-003** + **JOB-005** + **AGT-000** (`propose:actions`) — registre de handlers, boucle `runWorker` arrêtable, routage `defer`/`fail` selon la classe, `deferred` + `failedByClass` ; **`concludeRunStep`** délègue à `monitoring.concludeJobStep` (partagée avec la passe de dépendances) et n'écrit **qu'aux issues terminales** ; **JOB-004** ajoute **`settleOnce`**, jumelle du reaper — bornée, non bloquante, jouée au démarrage et à chaque tour à vide, **avant** le `break` de `once` ; **JOB-006** ajoute le **`CapacityGovernor`** (photo + tour d'équité + cadence de rafraîchissement qui bougent ENSEMBLE — éparpillés, la prochaine modification en oublierait un, et le plus probable est le rafraîchissement **après quota**), la 3ᵉ passe **`coolDownOnce`**, et **`throttledTicks`** qui distingue « file vide » de « file bridée ». |
| `scripts/worker.ts` | Worker CLI (`--once`, `--enqueue=<slug>`, `--types`, `--lease-ms`, `--poll-ms`) + arrêt gracieux SIGINT/SIGTERM. |
| `scripts/job-claim-concurrency.ts` | Preuve d'unicité de réclamation sur Neon (concurrence, étanchéité du bail, arrêt gracieux, backoff/dead-letter) ; **type unique par exécution** + nettoyage enfants-d'abord (corrigé en JOB-003). **JOB-006 : capacité DÉSARMÉE** (`capacityRefreshEvery: 0`) — elle laisse 8 jobs `running` à dessein, le plafond global les refuserait donc **correctement** et sa boucle sans `once` attendrait un job qu'elle n'a pas le droit de prendre. |
| **`scripts/job-003-retry-proof.ts`** | **Preuve JOB-003 sur Neon (44 vérifs)** : 5xx replanifié/jitté, 429 reporté (tentative rendue, Retry-After honoré), 403-quota Google ≠ 403 structurel, dead-letter immédiat, plafond de reports, reprise manuelle avec historique intact ; nettoie ses propres lignes. |
| **`scripts/jobs-requeue.ts`** | Reprise d'un job depuis la dead-letter (`--job`, `--actor`, `--reason`, `--dry-run`) ; refuse un job vivant, prévient sur cause `auth`/`permanent`. |
| `scripts/jobs-inspect.ts` | Chronologie d'un job, dead-letter et **capacité** en CLI (`--job`, `--project`, `--status`, `--dead`, `--class`, **`--capacity`**) ; **libellés importés de `utils/job-format.ts`** depuis JOB-007 — mêmes mots que la console. |
| **`src/lib/server/job-console.ts`** | **Purs JOB-007 (serveur)** : `normalizeJobFilters` (l'URL réduite au vocabulaire connu **avant** toute requête), `canCancelJob`/`canRequeueJob` (légalité des actions, miroir des gardes SQL), **`explainFailure`** (classe d'erreur → verdict + action + `willRepeat` ; **JOB-004** : un `skipped` renvoie vers le **prérequis**, jamais vers le job lui-même), **`describeDependencies`** (badge « attend … » **dérivé**, jamais stocké — sans lui un job retenu par la garde ressemble à un job coincé). |
| **`src/lib/server/job-console.test.ts`** | **Vitest JOB-007/JOB-004 — 33 tests** (filtres hostiles écartés, pagination bornée, matrice d'annulation/reprise, les 4 classes expliquées, annulation ≠ échec). |
| **`src/lib/utils/job-format.ts`** (+ `.test.ts`) | **Libellés et formats partagés CLI ↔ console** — `OUTCOME_LABEL`/`CLASS_LABEL`/`KIND_LABEL`/`STATUS_LABEL`, **`CADENCE_LABEL`** (JOB-005), `formatDbTimestamp`/`formatDbTime`/`formatDuration`/`formatRelative` (`now` injecté), `parseDbTimestamp` (**UTC explicite**), **`formatScheduleSlot`** (créneau LOCAL, jamais reconverti) — **+ JOB-006** `PROVIDER_LABEL`/`CAPACITY_STATE_LABEL`/`HOLD_REASON_LABEL`, **`formatQuota`** (`3/∞` et jamais `3/0` : un plafond nul n'est pas une saturation) et `formatEpochUtc` (le refroidissement s'affiche dans le même référentiel que la file). Dans `utils/` parce qu'une page Svelte ne peut pas importer `$lib/server`. **18 tests**. |
| **`src/routes/(app)/jobs/+page.server.ts` + `+page.svelte`** | **La file** : filtres normalisés côté serveur, `listJobs`/`countJobs`/`countJobsByStatus`, compteurs cliquables par statut, table dense, pagination ; `now` serveur passé à la page (jamais l'horloge du navigateur). **+ JOB-005** : panneau **Planification** (`listNextOccurrences`, heure métier **et** UTC, cadences non câblées nommées une fois) ; **+ JOB-006** : panneau **Capacité & quotas** (providers hors `none` — ni quota ni budget à montrer —, plafonds et budgets restants, refroidissement daté, plafonds « lus en base » ou « par défaut »). Les deux suivent le même filtre projet que la file. |
| **`src/routes/(app)/jobs/[id]/+page.server.ts` + `+page.svelte`** | **Un job** : verdict `explainFailure`, chronologie `job_attempts` (jamais `jobs.attempts`), payload **en lecture seule**, Relancer/Annuler avec raison obligatoire. |
| **`src/routes/api/ops/jobs/[id]/{cancel,requeue}/+server.ts`** | Actions d'exploitation. Namespace `ops` parce que `/api/jobs` sert les `ai_jobs` legacy. POST seul, session exigée, acteur pris **dans la session**, raison obligatoire ; **aucun champ de payload accepté**. |
| **`scripts/job-007-console-proof.ts`** | **Preuve JOB-007 sur Neon (46 vérifs)** : annulation en file et en cours (le worker ne peut plus ni renouveler, ni conclure, ni échouer), refus sur `succeeded`, reprise + annulation enchaînées, journal append-only, payload inchangé, filtres hostiles ; nettoie ses lignes enfants d'abord. |
| **`scripts/jobs-purge-test.ts`** | Purge rejouable des lignes de test laissées en file (`starts_with(type,'__test_')`, **pas `LIKE`**), DRY-RUN par défaut, suppression enfants d'abord en une transaction ; liste les types trouvés avant de compter. |
| **`scripts/apply-job-003.ts`** + `drizzle/manual-job-003.sql` | DDL additif JOB-003 (`last_error_class`/`deferrals`/`requeued_count` sur `jobs`, `error_class` sur `job_attempts`, index partiel `idx_jobs_dead`) ; vérifie colonnes ET index. |
| `src/lib/server/timestamps.ts` (+ `.test.ts`) | Format canonique `YYYY-MM-DD HH:MM:SS` des colonnes `text` (`toDbTimestamp`/`toDbTimestampPlus`) — 8 tests, dont la preuve du piège lexical ISO vs DB. |
| `src/lib/server/db/types.ts` | Type `AppDb` isolé de `db/index.ts` (qui lit `$env`) → permet l'injection de client dans les modules d'écriture. |
| `src/lib/server/retention-state.ts` | Purs DATA-008 : `computeCutoff`/`isExpired` (null=sans limite), `isPurgeable`, `requiresL4ForPurge`/`assertPurgeAuthorized` (audit=L4), `derivePeriod` (week/month/year), `RETENTION_DEFAULTS` (§7.11), tuples. |
| `src/lib/server/retention-state.test.ts` | Vitest DATA-008 — 28 tests (cutoff, expiration infinie, purgeabilité, garde L4, buckets de période). |
| `src/lib/server/retention.ts` | DATA-008 — `seedRetentionPolicies` idempotent, `upsertObservationAggregate` idempotent (+`computeDimensionsHash`), `createPurgeRun`/`checkpointPurgeRun`/`updatePurgeRun`. |
| `scripts/purge.ts` | Runner DATA-008 DRY-RUN : plan (lignes+périodes exactes par type) ; `--execute` refusé (destructif différé) ; `--now=` fige la réf. |
| `scripts/apply-data-008.ts` + `drizzle/manual-data-008.sql` | Application déterministe du DDL additif DATA-008 (`retention_policies` + `observation_aggregates` + `purge_runs`). |
| `src/lib/server/policy-state.ts` | Purs DATA-007 : `deriveScopeKey`, `nextPolicyVersion`, `canonicalPolicyConfig` (hash), `evaluatePolicyGates` (kill switch ⟂ sync), `canAutoSendReview` (§8.4), `resolveEffectiveKillSwitch`, `derivePromotionKind`, tuples (modes/statuts/kinds). |
| `src/lib/server/policy-state.test.ts` | Vitest DATA-007 — 29 tests (scope, versionnage, canonicalisation, invariant kill-switch⟂sync, éligibilité envoi, kinds). |
| `src/lib/server/policies.ts` | DATA-007 — `promotePolicy` transactionnel idempotent (+`computePolicyHash` sha256, journal), `setKillSwitch` (promotion journalisée sans toucher la sync), `getCurrentPolicy`/`getEffectivePolicy`. **Client injecté** + horodatages au **format DB** (mêmes deux corrections qu'AGT-000 a dû faire sur `proposals.ts`).
| `scripts/apply-data-007.ts` + `drizzle/manual-data-007.sql` | Application déterministe du DDL additif DATA-007 (`review_automation_policies` + `policy_promotions`). |
| `src/lib/server/proposal-state.ts` | Purs DATA-006 **+ DASH-005** : `canActorApprove` (séparation des niveaux L0–L4), `isApprovalValid` (hash lié + expiration), `statusAfterPayloadChange`, tuples — **+ `changes_requested`** (10ᵉ statut, colonne `text`, zéro DDL : porte « request changes » sans éditeur de payload, et **échappe volontairement à `decideSupersession`**, donc une demande humaine survit au run hebdo) et **`isDecidableStatus`/`DECIDABLE_STATUSES`** (`invalidated` en fait partie : l'approbation est tombée, pas la proposition). |
| `src/lib/server/proposal-state.test.ts` | Vitest DATA-006 **+ DASH-005** — 22 tests (niveaux, validité hash/expiration, transitions, et la matrice du décidable — un statut inconnu n'est **jamais** décidable). |
| `src/lib/server/proposals.ts` | DATA-006 **+ AGT-000** — `createProposal` idempotent (+`computePayloadHash` sha256) qui **rafraîchit désormais les champs NON hashés** (rationale/impact : sans quoi une proposition afficherait éternellement les mesures de sa première semaine), `approveProposal` transactionnel (refus niveau), `updateProposalPayload` (invalidation), **`listProposalsForFinding`**, **`supersedeProposals`** (gardée sur les statuts ouverts), agent runs. **Client injecté** + horodatages au **format DB** (deux corrections AGT-000 : le module était inchargeable hors SvelteKit et écrivait de l'ISO). **+ DASH-005** : la **LECTURE**, qui manquait entièrement — `listProposals`/`countProposals`/`countProposalsByStatus` (LEFT JOIN : une proposition dont le finding a été purgé reste **visible et décidable**), `getProposalDetail` (approbations **y compris tombées**), `listProposalsOfFinding` ; et trois gardes sur `approveProposal` : **hash attendu** (409 `stale_hash`, rien écrit), **statut décidable** (sans elle, une proposition rejetée par un humain repassait `approved` au rappel du producteur) et **idempotence** (une approbation `active` sur le même hash est rendue, sans seconde ligne d'audit). `rejectProposal`/`requestProposalChanges` exigent une **raison**, journalisée au finding dans la **même transaction**. `ProposalDecisionError` + `DECISION_HTTP_STATUS` : la cause se traduit en code HTTP sans relire un message.
| `scripts/apply-data-006.ts` + `drizzle/manual-data-006.sql` | Application déterministe du DDL additif DATA-006 (`action_proposals` + `proposal_approvals` + `agent_runs`). |
| `src/lib/server/finding-state.ts` | Purs DATA-005 : `deriveFindingFingerprint`, `computePriorityScore` (§10.2), `deriveSeverityEventType`/`deriveStatusEventType`, tuples de vocabulaire (types/statuts/sévérités/entités/événements/acteurs). |
| `src/lib/server/finding-state.test.ts` | Vitest DATA-005 — 27 tests (fingerprint stable, scoring borné, dérivation d'événements, vocab). |
| `src/lib/server/findings.ts` | DATA-005 — `upsertFinding` idempotent (`occurrence_count` atomique), `recordFindingEvent` append-only, `transitionFinding` transactionnel (statut+événement). |
| `scripts/apply-data-005.ts` + `drizzle/manual-data-005.sql` | Application déterministe du DDL additif DATA-005 (`findings` + `finding_events`). |
| `src/lib/server/observation-backfill.ts` | Purs MIGRATE : rollup page (position pondérée), sélection représentative keyword, mappers legacy→input d'upsert. |
| `src/lib/server/observation-backfill.test.ts` | Vitest MIGRATE — 13 tests (rollup, pondération, dédup keyword, mapping). |
| `scripts/backfill-observations.ts` | Runner MIGRATE (Pool+drizzle propres) : backfill idempotent des 4 tables d'observations, dédup intra-lot GSC, `--dry-run`. |
| `scripts/verify-backfill.ts` | Vérif read-only du backfill (invariants #obs/#clés, Σ impressions rollup, keyword_rank ⊆ tracked). |
| `src/lib/server/log.ts` | Logger structuré (OPS-001) — socle d'observabilité, masquage secrets. |
| `src/lib/server/config.ts` | Config runtime centralisée (GOV-003) — schéma env, `validateStartup`, `requireEnv`. |
| `src/lib/server/flags.ts` | Feature flags de migration (GOV-005) — 7 verticales OFF ; `indexnow` = interrupteur maître IDX-008. |
| `src/hooks.server.ts` | Import à effet de bord de `config.ts` → validation au boot serveur. |
| `.env.example` | Référence des 21 env vars + doc flags/LOG_LEVEL (secret-free). |
| `src/lib/server/indexing.ts` | Indexing API — garde IDX-008 (flag + éligibilité) sur `publishUrl`/`batchSubmit`. |
| `src/lib/server/indexing-eligibility.ts` | Purs IDX-008 : types éligibles + `evaluateIndexingGuard`. |
| `src/lib/server/db/schema.ts` | Modèle Drizzle (**57 tables**, +`job_attempts`/`job_effects` en JOB-002 ; JOB-007 n'en ajoute aucune) ; +DATA-002→008 (intégrations, orchestration, 10 observations, findings+finding_events, proposals+approvals+agent_runs, policies+promotions, retention_policies+observation_aggregates+purge_runs). |
| `src/lib/server/observation-state.ts` | Purs DATA-004 : `deriveObservationFingerprint`, `computeWindowStart`/`isWithinWindow`, `assertBoundedPayload`. |
| `src/lib/server/observations.ts` | DATA-004 — upserts idempotents des 5 tables d'observation ancrées (gsc_query_page/gsc_page/index/keyword_rank/gmb_insight). |
| `scripts/apply-data-004.ts` + `drizzle/manual-data-004.sql` | Application déterministe du DDL additif DATA-004 (10 tables). |
| `src/lib/server/projection-state.ts` | Purs DATA-002 : `classifyProjection`, `assertNoInlineSecret`, `computeHealth`. |
| `src/lib/server/projections.ts` | DATA-002 — record/dedup/versionnage transactionnel des projections. |
| `src/lib/server/integrations.ts` | DATA-002 — upsert intégration (`onConflict`) + succès/erreur → santé. |
| `scripts/data-001-cartography.ts` | Introspection read-only Neon → cartographie + réconciliation modèle↔DB. |
| `scripts/apply-data-002.ts` + `drizzle/manual-data-002.sql` | Application déterministe du DDL additif DATA-002. |

### Décisions clés
- **DASH-005** : **l'approbation est optimiste et idempotente, dans la même transaction.** Le client
  renvoie le hash **qu'il a affiché** ; un hash périmé refuse **sans rien écrire**. C'est ce qui rend
  « liée au hash exact » vrai *sous concurrence* (le run du lundi peut passer entre l'affichage et le
  clic) — et l'acceptation « modifier une proposition l'exclut du lot » tombe **gratuitement**, par la
  même comparaison, sans aucune règle d'interface. Rejouer une approbation déjà accordée rend
  l'existante : deux lignes dans `proposal_approvals` feraient dire à l'audit **deux décisions** là
  où un humain n'en a pris qu'une. Et la garde de **statut** ajoutée au passage ferme un trou réel :
  une proposition rejetée par un humain repassait `approved` au simple rappel de la fonction —
  jamais mordu **parce qu'aucun projet n'a de policy**, la même forme que les dettes « la table était
  vide ».
- **DASH-005** : **« request changes » est un statut, pas un éditeur de payload**, et le **lot se
  reconstruit depuis la base**. Éditer le payload à la main aurait été `superseded` au lundi suivant
  et mettrait la dédup en danger (le piège central d'AGT-000) ; `changes_requested` échappe à
  `decideSupersession`, donc une demande humaine **survit au run hebdo**. Côté lot, `approve-batch`
  rejoue `buildApprovalLots` sur les lignes réelles : une requête forgée ne peut pas mélanger deux
  projets ni faire passer une **L4** — exclue dans le module **pur**, pas dans un `{#if}` qui se perd
  au premier refactor. Le bouton **n'existe pas**, plutôt qu'il n'existe et refuse.
- **JOB-005** : **un créneau se nomme par son heure LOCALE, jamais par son instant.** Toute la
  garantie anti-doublon en découle : le lundi 09:00 métier garde la même clé alors qu'il s'écrit
  08:00 UTC en hiver et 07:00 en été, et le retour à l'heure d'hiver ne peut pas dédoubler un
  créneau qui n'existe qu'une fois au calendrier. Corollaire : **aucune table de planification** —
  rejouer un tick, redémarrer à 09:00 et rattraper un créneau manqué sont la **même opération**,
  gardée par l'unique `(project_id, idempotency_key)` déjà en base ; et la « prochaine exécution »
  est **calculée**, donc structurellement incapable de contredire ce que le tick fera. Le cron
  (`0 * * * *`) perd sa sémantique métier : il bat, et le code sait l'heure qu'il est à Zurich —
  il **planifie ET draine**, sinon on remplirait une file que personne ne vide.
- **JOB-007** : **un job en cours s'annule en lui retirant son bail**, jamais en tuant son worker —
  `renewLease` cesse de matcher, le runner interrompt son handler, et ses écritures finales
  (gardées par `lease_owner` + `status='running'`) ne réécrivent rien. C'est le mécanisme de
  JOB-002 réutilisé. **L'audit est une ligne de journal**, pas un champ : acteur pris **dans la
  session**, raison obligatoire, `job_attempts` append-only — donc annuler un job qui tourne écrit
  **deux** lignes (la tentative, la décision), et un refus n'écrit **rien**. « Aucune modification
  arbitraire du payload » tient par **absence de chemin** (aucune route n'accepte `payload_json`).
  Les horodatages restent affichés **en UTC** comme ils sont stockés, et l'interface le dit :
  convertir ferait exister deux lectures d'un même instant selon l'outil.
- **JOB-003** : l'échec est **classé avant d'être compté**, et la **raison prime sur le statut HTTP**
  (403+`rateLimitExceeded` = quota, 400+`invalid_grant` = auth — la sémantique Google inverse la
  lecture naïve). Tout **4xx non reconnu = permanent** (rejouer une erreur du client redonne la même
  erreur) ; une erreur **illisible = retryable** (on ne condamne pas à l'aveugle). **L'auth meurt
  immédiatement** (réessayer ne répare pas un token révoqué). **Le quota ne consomme pas de
  tentative** : elle est rendue et le compteur **séparé** `deferrals`, plafonné, borne la boucle.
  **Le jitter vit dans la couche IO** (`random` injecté ; sans lui, comportement déterministe
  inchangé) et **n'ampute jamais un `Retry-After`**. **La reprise manuelle remet `attempts` à zéro** :
  l'historique est porté par `job_attempts` (append-only, la reprise y écrit sa ligne `requeued`),
  jamais par le compteur. Aucune table neuve : 4 colonnes + 1 index partiel.
- **FIND-003** : la closure d'un run = **`selection.matched` complet**, jamais la liste tronquée
  écrite — sinon la troncature ferme des findings vivants (1310 vs 50 chez barberconcept). Une
  réconciliation n'a lieu que sur un run **autoritaire**, et une absence isolée ne résout jamais
  (confirmation sur N fenêtres consécutives, §10.3). **Le snooze tient** jusqu'à son échéance
  (aggravation journalisée mais sans effet) et **le dismiss vaut à vie** (seul un humain rouvre) :
  la machine ne réécrit pas une décision humaine. Les effets de bord du cycle de vie vivent **dans
  `transitionFinding`** (pas chez l'appelant) et la légalité du graphe §10.1 est **gardée à
  l'écriture**. L'expiration de veille a son **propre type de job** : elle ne dépend pas d'un run de
  détection.
- **FIND-001/FIND-004** : le détecteur est **pur + IO**, jamais un script monolithique — la logique
  testée par vitest, l'IO réduit à lire/écrire. **Fenêtre = semaines complètes présentes** (les
  observations sont hebdo), et deux fenêtres de longueurs différentes ne se comparent jamais
  (`areWindowsComparable`). Une **fenêtre incomplète baisse la confiance**, elle ne supprime pas le
  finding ; un **faible volume plafonne la sévérité à `medium`** (jamais de `critical` sans données).
  Le **bruit est configuré, jamais deviné** (`excludeQueryPatterns` par projet) : on préfère un
  finding de marque visible à un filtre implicite faux. **Troncature annoncée** (`maxCandidates`
  atteint = dit avec le total réel). Le détecteur **n'auto-résout rien** → FIND-003.
- **JOB-001** : `attempts` s'incrémente **à la réclamation** (un worker qui meurt consomme sa
  tentative → pas de boucle infinie sur un job « poison »), et `releaseJob` la **rend** (arrêt
  gracieux = rien n'a tourné). Toutes les mutations d'état sont gardées par `lease_owner` : un worker
  ne clôt jamais le job d'un autre. Reaper de baux morts = **JOB-002**, hors lot.
- **Format temporel canonique** (`timestamps.ts`) : les colonnes `text` ont un DEFAULT SQL
  `YYYY-MM-DD HH:MM:SS` ; toute écriture applicative passe désormais par `toDbTimestamp`, et tout
  prédicat SQL **caste** (`::timestamp`). Mélanger ISO et format DB dans une colonne casse les
  comparaisons lexicales — c'est le bug qui aurait rendu un job indisponible jusqu'au lendemain.
- **Injection de client db** : `findings.ts`/`monitoring.ts` acceptent un client optionnel et
  n'importent `db/index.js` (qui lit `$env`) que **dynamiquement**. Les runners `scripts/` réutilisent
  ainsi les vraies fonctions d'écriture au lieu de réimplémenter les requêtes.
- Config au boot **log-only** (pas de throw) pour protéger le daily driver ; fail-fast strict délégué à `requireEnv` au point d'usage.
- Flags OFF par défaut ; un flag route le comportement, n'efface jamais de donnée.
- **IDX-008** : garde à deux étages (flag maître `indexnow` + éligibilité type) ; refus audité en DB, zéro quota.
- **DATA-002 (expand seul)** : `resource_key` discrimine plusieurs propriétés/locations d'un provider ; projections en **historique** (unique `(project_id, source_hash)` + unique partiel `current`) ; garde `assertNoInlineSecret` sur payload/config ; secrets via `secret_ref`, jamais inline. **Pas de backfill/retrait** des tables héritées.
- **DATA-006 (expand seul)** : `action_proposals` + `proposal_approvals` + `agent_runs` (SPEC §7.8/§7.9/§12).
  **Approbation = table dédiée** (pas inline §7.8) : porte le **hash lié** (`approved_payload_hash`),
  périmètre, token one-time + expiration, statut propre → supporte lot (§12.3) + Telegram (§14.3) ;
  `action_proposals` garde `approved_by/at` en dénormalisé. **Statuts** = 7 de §7.8 **+ `invalidated` +
  `expired`** ; colonne **`payload_hash`** (sha256) à laquelle l'approbation se lie. **Invariants portés
  par le module pur** : `canActorApprove` (agent ≤ L2, policy ≤ L3, **L4 = user seul** — §12.2) +
  `isApprovalValid` (active + hash égal + non expiré). **Exécution/vérification non séparées** :
  `execution_job_id` FK→`jobs` + `verification_status` (pas de table exécution). Idempotence :
  unique `(project_id, finding_id, action_type, payload_hash)`. `agent_runs` distinct de
  `monitoring_runs` (raisonnement agent vs orchestration collecteur). **Pas d'agent/exécuteur/UI.**
- **DATA-007 (expand seul)** : `review_automation_policies` + `policy_promotions` (SPEC §7.10). Policy
  **versionnée** (modèle `project_projections` : unique current par scope, ancienne `superseded`) →
  aucune ancienne proposition ne profite d'une nouvelle policy. **`scope_key = location_id ?? '*'`**
  (robustesse NULL du unique current) ; **`policy_hash`** (sha256 config canonique) → dédup re-promotion.
  Kill switch **versionné dans la config** (bascule = promotion journalisée). Invariants purs
  (`policy-state.ts`) : **`evaluatePolicyGates`** (kill switch bloque les envois **sans** bloquer la sync)
  + **`canAutoSendReview`** (§8.4 : draft_only/manual jamais, guarded_auto seulement 5★ non escaladé).
  `policy_promotions` **append-only** → policy effective auditable. **Pas d'exécuteur/cron/UI.**
- **DATA-008 (expand + dry-run, pas de suppression réelle)** : `retention_policies` + `observation_aggregates`
  + `purge_runs` (SPEC §7.11). Rétention **configurable par type** (seedée §7.11). Invariants purs
  (`retention-state.ts`) : **`isPurgeable`** (protégé/infini/inactif jamais purgé), **`assertPurgeAuthorized`**
  (suppression d'audit = L4 sinon throw), **`derivePeriod`** (buckets week/month/year déterministes).
  Runner `scripts/purge.ts` **DRY-RUN par défaut** (annonce lignes+périodes exactes) ; **`--execute` REFUSÉ**
  — l'agrégation+delete réels (par lots, reprise `checkpoint_json`, L4 pour audit) sont **différés** en
  session dédiée. Colonne d'âge = `period_end` sauf `keyword_rank_observations` = `observed_date`.
- **DATA-005 (expand seul)** : `findings` + `finding_events` (SPEC §7.6/§7.7). **Statuts** = les 7 de §7.6
  **+ `reopened`** (§10.1) ; `new` transitoire (naît `open`). **Dédup** = unique `(project_id, fingerprint)`
  (fingerprint stable = miroir applicatif dans `finding-state.ts`, séparateur `\x1f`). **Preuves** =
  `evidence_json` **pointeurs** (ids d'observations), jamais de texte libre ni de FK dure. **Politique
  suppression observation** = série append-only jamais supprimée → références souples, aucune cascade
  (satisfait « interdit/géré par politique »). `run_id` **nullable** (traçabilité détecteur) ajouté
  au-delà de la liste §7.6. **`findings` sans `schema_version`** : versionnage par `detector_version`.
  `finding_events` **append-only** (insert seul, jamais update/delete). **Pas de détecteur/backfill/UI.**
- **DATA-004 (expand seul)** : 10 tables d'observations (SPEC §7.5), forme commune (provider, run_id,
  période/date, dims, métriques, payload borné, schema_version, fetched_at) ; unique d'upsert = dédup ;
  index (projet, période) = fenêtres 7/28/90 j. 5 ancrées + 5 spéculatives (expand additif). **Décision
  `ai_jobs` :** le « `ai_jobs → jobs type='ai'` » du plan initial est **écarté** — `ai_jobs` est un
  *result-store poll é* vivant (fire-and-poll, colonne `result`, lu par `GET /api/jobs/[id]`), pas la
  pull-queue durable que `jobs` modélise (claim/lease, aucune colonne résultat). Le folder mécanique
  polluerait `jobs`. `ai_jobs` reste du **legacy pré-agentique**, à retirer quand le flux review-reply
  devient agent+proposal (DATA-006/JOB-001), pas à remapper.
- Nouvelles tables appliquées par **SQL additif idempotent** (pas `db:push`) ; `schema.ts` reste source de vérité, vérif par re-run de l'introspection (zéro dérive).
- Renommage `jlabs-content-hub` limité à l'interne ; le client-facing est une décision de marque séparée.
- Branche `feat/cockpit` depuis `feat/neon` (isole la phase agentique ; `feat/neon` figée pour le cutover Vercel P5A).

## Trace des commits (E00, branche `feat/cockpit`)
`3d9be7d` fondations (logger/config/flags) · `4bbe9ef` docs HANDOFF · `256c1a2` IDX-008 · `d7484a9`
DATA-001 · `b6df05e` DATA-002 · `1ab115f` DATA-003 · `7d3ae9c` DATA-004 · `4696919` migrate/backfill ·
`7cb94c1` fix chunk · `f9432ce` DATA-005 · `4c24bc9` docs DATA-005 · `16fa000` DATA-006 · `43fe9d7`
docs DATA-006 · `15a92cb` DATA-007 · `a8bdd2f` docs DATA-007 · `0f78d89` DATA-008 · `c6ccc70` docs
DATA-008 · `f9b7801` wrap DATA-007/008 · `9e25e5d` fix timestamps + injection db · `717bb71`
FIND-001/004 détecteur · `7321f5a` JOB-001 claim atomique · `cc6a92f` docs FIND/JOB · `5428ec7`
FIND-003 cycle de vie · `9d6976d` docs FIND-003 · `8aea66e` JOB-002 bail/heartbeat/récupération ·
`77b570b` docs JOB-002 · `1c31db6` décisions JOB-002 · **`e7a3a44` JOB-003 retry classé, backoff
jitté et dead-letter reprenable**.

## Reste du premier lot §9 (non fait)
- [ ] **GOV-001 (reste)** — marquer `Desktop/apps/jlabs-content-hub` legacy read-only (garder comme backup
      jusqu'au cutover), avertissement dans sa doc.
- [x] **DATA-001** (2026-07-21) — cartographie du schéma → `docs/DATA-001-cartography.md` (30 tables,
      zéro dérive, sort par table, doublons, expand/migrate/contract). Script read-only
      `scripts/data-001-cartography.ts`.
- [ ] **DATA-001b** — fixture DB anonymisée (seed synthétique, zéro donnée client). Différée de DATA-001.
- [ ] **GSC-003** — réparer le contrat réel de `~/.claude/skills/seo-gsc` (champ `page` fantôme dans
      `top_queries`) + adapter weekly/actions/refresh. **Hors repo (couche skills).**
- [ ] **IDX-003** — réparer le contrat de `~/.claude/skills/seo-index-diagnose` (`buckets` vs `results`)
      + `post_publication.py`. **Hors repo (couche skills).**
- [x] **IDX-008** (2026-07-21) — Google Indexing API restreinte : garde flag `indexnow` (OFF défaut)
      + validation de type (`JobPosting`/`BroadcastEvent`) dans `indexing.ts` (helpers purs
      `indexing-eligibility.ts`). Soumission générique refusée + auditée (`status:'blocked'`), zéro
      quota. 4 points d'entrée neutralisés. Doc sitemap/maillage = voie normale. 1re infra vitest +
      7 tests verts.
