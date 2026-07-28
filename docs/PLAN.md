# Plan d'execution — seo-stats

> Derniere mise a jour : 2026-07-26
> **Cap actuel :** refonte **cockpit agentique de monitoring** (SPEC : [SPEC.md](SPEC.md) · execution : [BACKLOG.md](BACKLOG.md)).
> Ce fichier ne garde que **l'historique du socle livré** (Phases 1-2, epics 1-23). La suite (E00→E13)
> vit dans **[BACKLOG.md](BACKLOG.md)**, pas ici. Le pivot jokiSEO (2026-06-24) est archivé (`_archive/PRD-jokiseo.md`).
>
> **Pré-requis transverse en cours :** migration Turso → Neon, **Phase 5A — le cutover**
> (voir [NEON-MIGRATION.md](NEON-MIGRATION.md)). ⚠️ Constaté le 2026-07-26 : `main` porte encore le
> code libsql, donc **la prod tourne toujours sur Turso** ; le code Neon vit sur `feat/cockpit`.
> Données prod rattrapées (222 lignes). Restent deux gestes qui demandent Jonathan : variable Vercel
> puis `git merge --ff-only feat/neon` sur `main`.

---

## Phase 1 — MVP (DONE)

| # | Epic | Complexite | Statut | Detail |
|---|------|-----------|--------|--------|
| 1 | Init projet + Schema DB | S | DONE | [init-schema.md](features/init-schema.md) |
| 2 | API REST (contenu, projets, commentaires) | M | DONE | [api-routes.md](features/api-routes.md) |
| 3 | Auth admin (Better Auth) | S | DONE | [auth.md](features/auth.md) |
| 4 | Dashboard admin (UI Skeleton) | L | DONE | [dashboard-admin.md](features/dashboard-admin.md) |
| 5 | Calendrier editorial | M | DONE | [calendrier.md](features/calendrier.md) |
| 6 | Acces client + commentaires | M | DONE | [acces-client.md](features/acces-client.md) |
| 7 | GitHub sync (backup) | S | DONE | [github-sync.md](features/github-sync.md) |
| 8 | Migration contenu existant | S | DONE | [migration.md](features/migration.md) |
| 9 | Deploiement Vercel + Turso | S | DONE | [deploiement.md](features/deploiement.md) |

---

## Phase 2 — V2 Ameliorations

| # | Epic | Complexite | Statut | Commits cles |
|---|------|-----------|--------|--------------|
| 10 | UX admin — sidebar dynamique + design system | M | DONE | `556a430`, `0333da4` |
| 11 | Cartes projets redesign + image cover + calendrier | M | DONE | `fdab660` |
| 12 | Publication GMB — auth Google, cron, multi-location | L | DONE | `c3f7301`, `e7c2aa8`, `e7bac29` |
| 13 | Publication LinkedIn — OAuth, batch split, scheduling | L | DONE | `562ec01` |
| 14 | Publication CMS (Webflow) — adapter, API, JSON-LD | L | DONE | `906755d` |
| 15 | Avis Google — consultation, reponse, stockage DB, cron sync | L | DONE | `4c8a5de`, `ad19986`, `93ba9ad` |
| 16 | Profil business par projet | S | DONE | `93ba9ad` |
| 17 | Cleanup contenu MVP (DB + GitHub backup) | S | DONE | `3b6e35b`, `70baaee` |
| 18 | GMB full-auto pipeline (logs, emails, blob, auto-approve) | M | DONE | `d800f70` |
| 19 | Fix /publish-hub GMB pipeline (upsert idempotent + CSRF + /api/whoami) | S | DONE | _en cours_ |
| 20 | GSC weekly snapshots (data layer + admin page + skill /seo-weekly) | M | DONE | _en cours_ |
| 21 | SEO actions actionnables (endpoint /gsc/actions + skill /seo-actions) | S | DONE | _en cours_ |
| 22 | Gestion fiche GMB : lecture snapshot + edition infos+horaires + stats Performance API | M | DONE | _en cours_ |
| 23 | Suivi de positions mots-cles (cron GSC + watchlist + serie temporelle + rapport client) | M | ABSORBE → epic 27 | [keyword-position-tracking.md](features/keyword-position-tracking.md) |

> Epic 23 : code livre et fonctionnel (positions GSC, cannibalisation, vue client, digest). N'est plus poursuivi en l'etat — l'**epic 27** ajoute le rang SERP reel par-dessus et porte la suite.

---

## Phase 3+ — Refonte agentique → voir [BACKLOG.md](BACKLOG.md)

La suite n'est plus planifiée ici. Le cadrage jokiSEO (epics 24-32) a été **absorbé et dépassé** par la
refonte « cockpit agentique de monitoring » du 2026-07-21 :

- **Quoi** : déléguer 90% du monitoring SEO/présence-locale récurrent à des agents, findings persistants,
  validation humaine des actions sensibles.
- **Vision complète** : [SPEC.md](SPEC.md) (23 sections, décisions validées).
- **Exécution** : [BACKLOG.md](BACKLOG.md) — 14 epics `E00→E13`, jalons `M0→M6`, premier lot exécutable (§9).
- **Statut (2026-07-25)** : **E00 EN COURS** sur `feat/cockpit` — fondations (GOV-003/005 + OPS-001) +
  **IDX-008** + **DATA-001→008** livrés (cartographie, intégrations/projections, orchestration+queue,
  10 observations + backfill exécuté, findings, proposals/approvals/agent_runs, policies d'automatisation,
  rétention/purge en expand+dry-run), puis la **chaîne agentique bouclée** : **FIND-001/004** (1er
  détecteur déterministe) et **FIND-003** (cycle de vie : les findings se ferment, se rouvrent et se
  mettent en veille seuls). **La queue est complète** : **JOB-001** (réclamation atomique),
  **JOB-002** (bail vivant, worker mort, journal `job_attempts`, exactly-once des effets),
  **JOB-003** (erreur classée, backoff jitté, dead-letter reprenable), **JOB-007** (console
  d'exploitation `/jobs` : liste, chronologie, retry ciblé, annulation auditée) et **JOB-005**
  (scheduler timezone-aware : tick horaire `/api/cron/tick` qui planifie les cadences
  `Europe/Zurich` — DST comprise, zéro DDL — **et draine la file** : plus rien ne dépend d'un
  lancement manuel). **La chaîne de décision est fermée** : **AGT-000** (producteur déterministe
  findings → `action_proposals`, niveaux L0–L4 figés, payload stable donc dédup réelle, plafond par
  projet, auto-approbation bornée à L2 sous policy explicite ; job `propose:actions` planifié le
  lundi après le détecteur). **L'ordonnancement et la capacité sont fermés** : **JOB-004**
  (dépendances réelles entre jobs — un prérequis obligatoire mort fait `skipped` son dépendant et
  `partial` son run) et **JOB-006** (plafonds global/projet/provider, **tour d'équité** pour qu'un
  gros projet ne prenne pas tout un tick, **refroidissement provider** qui met toute la cohorte au
  repos sur un `quota`, plafonds réglables **sans redéploiement**). **La collecte est branchée** :
  **GSC-001+002** (`collect:gsc_query_page` — premier job qui appelle vraiment un provider ; rien
  n'est écrit avant la fin de la pagination, un seul fetch alimente observations **et** legacy,
  erreurs GSC structurées donc classées juste). **Et la chaîne atteint enfin l'humain** :
  **DASH-004+005** (inbox `/inbox` — approbation liée au **hash exact** et idempotente, rejet et
  `changes_requested` motivés et journalisés, lots homogènes dont les **L4 sont exclues**, vue
  finding avec preuves brutes ; ⚠️ approuver **n'exécute rien**, aucun handler d'exécution
  n'existe). DB à **58 tables, zéro dérive** (57 `seostats` + 1 miroir `core` ; `system_settings`,
  seul DDL depuis JOB-003) · test **656/656**. **Et la comparaison devient multi-fenêtres** :
  **GSC-004** (fenêtres **7/28/90 j** = 1/4/13 semaines sur le canon d'observations, **delta gardé par
  comparabilité** — aucun calcul entre longueurs incompatibles —, **confiance dérivée** d'une fenêtre
  tronquée ou pas à jour ; **latence GSC réglable** sans redéploiement via `system_settings` ;
  **backfill borné et reprenable** piloté par la file, reprise **dérivée** des observations sans table
  de checkpoint ; année N-1 câblée mais **inerte** jusqu'en 2027 ; endpoint `GET /gsc/windows` +
  panneau `/projects/[slug]/windows`). **Zéro DDL** (`schema.ts` intact, 57 `seostats` + 1 `core`) ·
  test **679/679**. **Et l'accueil devient le cockpit** : **DASH-002** (`/` cross-projet — santé à
  **deux axes qui ne fusionnent jamais**, `pipeline` vs `signal`, un pipeline cassé rendant le signal
  **`unknown` et jamais `ok`** de sorte qu'une collecte morte ne se lise plus comme le projet le plus
  sain ; **compteurs dont le nombre et le lien naissent du même filtre**, rejoués depuis leur URL dans
  la preuve, et **sans lien** quand aucune liste ne saurait les reproduire ; filtre d'activité
  `?event=`/`?since=` sur l'inbox via EXISTS sur `finding_events` ; « jamais collecté » ≠ 0 h ; ordre
  d'urgence **total** où `unknown` passe avant `watch` ; **coûts « non instrumentés »**, pas à zéro).
  **Zéro DDL** · test **716/716**. **Et l'indexation entre dans le cockpit** : **IDX-001** (inventaire
  sitemap — arbre XML parcouru sous bornes dures, cycle stoppé, un sitemap injoignable ou malformé
  devient un **fait persisté** au lieu d'un `catch {}` ; diff de deux snapshots **fonction pure** donc
  rejouable ; unique sur l'URL **normalisée**, sans quoi `/a` et `/a#x` inventeraient un ajout par run ;
  **rien n'est écrit avant que tout l'arbre soit parcouru**, la preuve mesurant les retraits fantômes
  évités ; **aucune URL retirée n'est jamais désindexée**, tenu par construction. Seul DDL :
  `sitemap_url_observations`, 57 → **58 tables**) et **IDX-002** (collecteur URL Inspection
  **persistant**, **zéro DDL** — une **erreur provider n'écrit rien et ne se lit jamais « non
  indexé »**, contrairement au legacy qui rendait `unknown` pour les deux ; erreurs **structurées** via
  `toGscApiError` donc 7 classes JOB-003 exactes, dont 403 `rateLimitExceeded` → `quota` ; rerun du
  jour rafraîchit, jour antérieur intact → historique ; lecture `indexing-read.ts` **sans réseau** ;
  `excluded` distingué de `not_indexed` ; chaîne réelle démontrée sur `sc-domain:barberconcept.ch`).
  · test **766/766**. Puis **IDX-005** (détecteur de transitions, **zéro DDL** — une transition stable
  ne parle **qu'une fois** (fingerprint `(type, page, url)`, 3 runs = 1 `created`) ; une fluctuation
  isolée est **écrite mais plafonnée** (`pending`, confiance 40, `medium`, jamais notifiable) et la
  confirmation la fait monter sur le **même** finding ; **`unknown` n'est pas un état** et
  `indexed → noindex` n'est **pas** une désindexation ; et surtout `reconcileDetectionRun` gagne un
  **`scope`** — ce détecteur n'est autoritaire que sur **ce qui a été ré-inspecté**, sinon une page
  non regardée serait « guérie » en deux runs, faux signal que la contre-épreuve **mesure**. §14.3 :
  le **signal** (`notifyImmediately`), pas le canal — TEL-002 reste BLOCKED) · test **809/809**.
  Enfin **IDX-004 lot 1** (politique de sélection et quotas — **un DDL** : `index_selection`,
  58 → **59 tables**), qui **rend IDX-005 vivant** et **referme la branche d'indexation** du graphe
  hebdo (`sitemap`/`gsc_query_page` → `url_inspection`, prérequis **optionnels** → `index_transition`,
  arête **obligatoire**). La table stocke la **DÉCISION**, jamais le résultat : aucune colonne
  `status`, « honorée » se **dérive** (`observed_date >= due_date`, ce qui porte la sémantique J+N).
  Et la sélection est **persistée AVANT que la collecte parte** — un 429 au 3ᵉ appel sur 10 laisse
  7 intentions dues, reprises au run suivant **sans une ligne de plus**, là où la contre-épreuve
  **mesure** qu'un code persistant *après* rendrait ces 7 URLs invisibles. « Réserver du quota à
  l'urgent » est un **ordre** et un **canal** (`scope: 'due'`), pas un pourcentage ; l'échantillon
  est plafonné par `samplePctMax` **clampé à 60 %**, donc il ne peut jamais prendre le dernier slot.
  ⚠️ **`0` veut dire ZÉRO** ici, l'inverse de `job-limits.ts` · test **875/875**.
  Puis **IDX-004 lot 2**, qui **ferme IDX-004** (**zéro DDL**) : une page publiée cesse d'attendre le
  lundi — trois rendez-vous J+3/J+7/J+28 posés à la publication, qui ne passent **pas** par
  `allocate` (`dedupeCandidates` fusionne par URL, les trois échéances y deviendraient une) ;
  l'idempotence vit dans les **DATES**, donc republier reprogramme là où la clé de
  `schedulePostPublish` ne savait pas ; cadence quotidienne **sans aucun prérequis** (le canal `due`
  ne lit ni inventaire ni clics) mais arête **obligatoire** vers le détecteur ; CLI d'audit borné par
  le **même budget** que la politique, ⚠️ en **dry-run par défaut** — l'inverse du reste de
  l'outillage, parce qu'il dépense un quota externe payant · test **889/889**. Enfin **DASH-003
  lot 1** (cockpit projet, **zéro DDL**) : `/projects/[slug]` cesse d'être le calendrier de contenus
  (déplacé en `[slug]/content` par `git mv`, `R100`) et devient la vue d'ensemble — ⚠️ **la carte de
  santé vient de `loadHomeCockpit` et n'est JAMAIS recalculée** (deux définitions de « projet à
  risque » divergeraient au premier seuil modifié), le trio période/fraîcheur/source est porté par le
  **type** donc un panneau ne peut pas exister sans dire d'où il sort, **« non branché » n'est pas
  « cassé »** (désactivé ⇒ `inactive` quoi qu'il porte par ailleurs), et la timeline lit les décisions
  dans **`action_proposals`** — seul endroit qui n'oublie ni les rejets ni les décisions sans finding.
  **Premier lecteur** d'`indexing-read.ts` et d'`index_selection` · test **908/908**.
  **Et le cockpit est enfin VU À L'ŒIL** (revue visuelle, **zéro DDL, aucun calcul touché**) : les
  invariants tiennent à l'écran et l'acceptation « chaque compteur ouvre une liste cohérente » est
  vérifiée **en cliquant** pour la première fois. Quatre correctifs verbaux, dont le seul qui compte —
  **« à jour » désignait deux choses opposées dans le même encadré** (fraîcheur de l'**intégration**
  vs complétude de la **donnée** : trois « à jour » contre un « données pas à jour » à quinze pixels
  sur `barberconcept`) → `collecte à jour` ; et **« Rien à traiter » s'affichait à côté de « 4 à
  valider »**, le seul verdict nu de `buildHeadline` alors qu'elle se donne pour règle de nommer
  toujours l'axe → « Collecte et performance au vert ».
  **Et le point produit ouvert par la revue est tranché** (2026-07-26, **zéro DDL**) : `barberconcept`
  s'affichait « Sain » sans avoir jamais été diagnostiqué — collecte fraîche, pipeline vert, et zéro
  finding qui se lisait « zéro problème » au lieu de « personne n'a jamais ouvert le dossier ». C'est
  la seconde moitié de l'invariant : un pipeline sain ne prouve pas qu'on ait **regardé**. Nouvel axe
  dérivé, la **couverture de diagnostic** — détecteurs attendus lus dans le **catalogue** (pas une
  liste tenue à la main) et croisés au dernier job `succeeded`. **`ok` n'est atteignable que sur un
  diagnostic complet** ; ce qui est positivement su passe toujours. ⚠️ **Trois degrés qui ne se
  confondent pas** : rien d'examiné → `unknown`, partiellement examiné sans rien trouver → `watch`,
  tout examiné → le verdict des findings. La 1re version renvoyait `unknown` dans les deux cas et
  faisait virer **les 6 projets au violet** (`detect:index_transition` n'a jamais tourné nulle part) —
  un cockpit uniforme ne se lit plus. Couper la planification ne rend pas un projet sain
  (`expectedCount === 0` vaut `none`) · test **917/917**.
  Enfin **DASH-006 lot 1** (`/automations`) : le cockpit voit le **créneau qui n'a pas eu lieu**. Un
  job mort laisse une ligne, un **tick qui ne tourne pas ne laisse rien** — l'absence n'a pas de
  ligne, elle ne se révèle que par le croisement du créneau **calculé** (`schedule-state.ts`, la
  fonction même du scheduler) et du run **observé** (`monitoring_runs.period_end`). **Deux axes qui
  ne fusionnent jamais** : « le créneau a-t-il été tiré ? » ≠ « ce qui a été tiré a-t-il réussi ? ».
  `late`/`missed` se sépare sur `DEFAULT_LOOKBACK_MS` **importée** du scheduler — au-delà, le créneau
  est perdu pour de bon. Premier lecteur de `monitoring_runs`/`monitoring_steps` depuis DATA-003 ; le
  compteur `runs_period` de l'accueil devient cliquable ; `/jobs?run=`. Aucun DDL · test **943/943**.
  **Ce que l'écran a dit aussitôt : 12 créneaux manqués sur 12** — plus rien depuis le 23.07, aucun
  run hebdomadaire n'ayant **jamais** existé (le tick vit sur cette branche, pas sur `main`).
  Puis **DASH-006 lot 2**, qui **clôt l'epic** : une automatisation s'arrête désormais **sur décision,
  pas sur panne**. Une pause est une **décision** (auteur, cause, date), donc ni dans
  `project_projections` — projection **recompilée**, la pause y serait effacée sans bruit — ni dans
  `system_settings`, KV qui se réécrit sur place et rendrait l'auditabilité infalsifiable. D'où
  `automation_pauses`, **journal append-only** dont l'état se **dérive** : aucun booléen ne peut
  diverger de son historique, **parce qu'il n'y a aucun booléen**. Trois portées
  (`project_cadence`/`project`/`provider`), **union et non préséance**. ⭐ L'acceptation du BACKLOG
  tenue littéralement : couper `gsc` fait sauter ses 3 collecteurs **et** leur dépendant obligatoire,
  pendant que `findings:lifecycle` **reste en file** — le `skipped` étant ce que JOB-004 lit comme
  prérequis mort, la propagation est gratuite. Les jobs déjà en file sont **conclus** (4ᵉ passe
  `pauseOnce`, avant `settleOnce`) **et** empêchés (garde dans `claimJob`) : conclure seul laisserait
  une fenêtre, empêcher seul les ferait dormir à vie. L'expiration `until` est **dérivée, jamais
  écrite**. Seul DDL : **60 tables** · test **997/997** · preuve **24/24** sur Neon.
  **À l'œil** : suspendre `barberconcept/hebdomadaire` fait passer le bandeau de **12 manqués / 12
  attendues** à **11 / 11 + 1 suspendue** — la décision sort du dénominateur *et* du décompte d'échecs.
  Puis **DASH-003 lot 2, chantier 1** : la leçon de DASH-006 s'arrêtait à un écran. `grep -i pause`
  rendait **0 occurrence** dans `home-state.ts`/`home.ts`/`project-cockpit*.ts`, si bien qu'un projet
  volontairement suspendu se lisait comme un pipeline mort sur `/` et `/projects/[slug]` — la
  confusion supprimée par DASH-006, réintroduite sur l'écran qu'on ouvre en premier. `paused` devient
  un **6ᵉ état de projet rangé APRÈS `ok`** et exclu de « à traiter » (sous `unknown` il serait passé
  **devant** un projet à surveiller). ⭐ L'ordre des règles de `classifyPipeline` est celui de **ce qui
  survit à la reprise** : un credential révoqué reste `broken` sous pause, un dead-letter reste une
  dégradation ; seul le **retard de collecte** cesse d'être un symptôme. Et il n'est expliqué que si
  **tous** les jobs du provider de fraîcheur sont suspendus — `collect:gsc_query_page` **et**
  `collect:url_inspection` écrivent `syncGscIntegration`, donc « au moins un » aurait silencié un vrai
  retard (trouvé par un test qui a échoué en ayant raison). Le diagnostic est suspendu **par
  détecteur**, propagation JOB-004 comprise. Aucun DDL · **une seule** requête ajoutée (coût constant)
  · test **1026/1026** (+29) · preuve **26/26** sur Neon.
  L'arbitrage « quels onglets » est tranché sur pièces : Rapports (REP-\*) et Analytics (ANA-\*) n'ont
  **aucun read-model**, Automatisations est livré en cross-projet depuis DASH-006. Prochain :
  **chantier 2 — l'onglet Indexation** (`indexing-read.ts` et `index_selection` n'ont toujours pas de
  lecteur d'écran ; `loadInspectionFreshness` n'a **aucun appelant nulle part**) ou **E11/exécution**
  (approuver n'exécute toujours rien : ni runner de skills — AGT-008 BLOCKED —, ni client d'écriture
  provider — IDX-007 BLOCKED).
  ⚠️ `project-cockpit-state.ts` **n'a pas été touché** et n'avait pas à l'être : il ne calcule pas la
  santé (il réutilise `classifyProject` de `home-state.ts`), le défaut était en amont. Le cockpit
  projet reste **jamais vu à l'œil** — tout est prouvé côté données, rien côté rendu.
  ⚠️ Un run dont **tous** les steps sont `skipped` se lit `success` (`STEP_TERMINAL_OK`, sémantique
  JOB-004) : bien plus atteignable depuis ce lot.
  Puis **DASH-003 lot 2, chantier 2 — l'onglet Indexation** (`/projects/[slug]/indexing`) : quatre
  tickets E04 étaient livrés sans qu'aucun écran ne les lise. `loadInspectionFreshness` n'avait
  **aucun appelant nulle part**, et `index_selection` n'était lu que par le collecteur qui l'écrit.
  ⭐ Lui donner un lecteur n'avait de valeur que si les **deux chemins de lecture rendent le même
  panneau** — l'onglet par elle, la vue d'ensemble par son `max(observed_date)` local : l'égalité
  `JSON.stringify` est prouvée en base, faute de quoi le taux de couverture aurait pu différer d'un
  onglet à l'autre sans qu'on sache lequel croire. ⭐ **« Honorée » se dérive** : l'observation posée
  **à** la date d'échéance vide la file **sans qu'une ligne d'`index_selection` ne bouge** (2 → 2
  compté). Un **seul** snapshot sitemap ne rend pas un diff vide (« rien à quoi comparer » ≠ « rien
  n'a changé »), une **alternate n'est pas une page**, le pool se dit **« au plus »** jamais « il
  reste », et une raison de sélection hors vocabulaire est **écartée, comptée et dite**, jamais
  réinterprétée. Contre-épreuve trouvée par un échec : sans intégration **et** sans donnée ⇒
  `inactive` (rien à brancher) ; la **même** absence, intégration déclarée ⇒ `never`. Zéro DDL ·
  zéro appel réseau · allers-retours constants · test **1051/1051** (+25) · preuve **46/46** sur
  Neon.
  ⚠️ **`scripts/dash-002-home-proof.ts` était cassé avant ce lot, et a été réparé** : il choisissait
  sa cible « baisse de performance » par **position**, et le parc passé à 9 projets l'a fait glisser
  sur un projet sans aucun détecteur passé — la preuve testait la règle de couverture en croyant
  tester la distinction panne/baisse. Choix par **propriété** désormais.
  ⚠️ **La prod écrit dans la même base** (`gsc_query_page_observations`, `run_id: null`) : toute
  assertion « base rendue à l'identique » sur cette table est **racée** par construction.
  Puis **FIND-005 — le détecteur de baisses** (`keyword_decline`) : le parc n'avait que **deux
  détecteurs** (`keyword_opportunity`, `index_transition`) pour six écrans de cockpit, donc une
  requête qui perdait 80 % de ses clics ne produisait **rien** — le plus gros trou de la gate M2, et
  le seul consommateur possible des fenêtres GSC-004. ⭐ **Un couple disparu n'est pas une baisse de
  −100 %** : il est indiscernable d'une semaine non collectée, donc seule l'**intersection** des deux
  fenêtres est comparée — sur `lecureux` ils étaient **107**, soit 107 findings faux qu'une lecture
  naïve aurait écrits en un run. C'est « une collecte partielle ne crée pas de baisse » rendu
  **structurel** plutôt que déclaratif, et c'est aussi ce qui distingue baisse réelle et changement
  de périmètre. ⭐ **L'écart 4 sem./1 sem. EST le niveau de confirmation** (`confirmed`/`sustained`/
  `emerging`), le dernier **plafonné à `medium`** comme IDX-005 plafonne une fluctuation isolée. Une
  page ne se **regroupe** que si **son total** baisse aussi, calculé sur **tous** ses couples
  appariés (une page dont 3 requêtes baissent et 12 montent n'est pas en perte). La **saisonnalité
  N-1 est déclarée absente**, jamais neutre. Découpage de fenêtres, complétude et gate N-1 réutilisés
  de GSC-004 **tels quels** ; l'auto-résolution vient de FIND-003 **sans une ligne de plus**. Zéro
  DDL (60 tables) · zéro appel provider · une **seule** lecture d'observations pour les 4 fenêtres ·
  test **1102/1102** (+51) · preuve **47/47** sur Neon.
  ⚠️ Contre-épreuve trouvée par un échec, et **l'assertion était fausse, pas le code** : un
  effondrement massif rend `sustained`, pas `confirmed`, parce que la fenêtre récente compare **w0 à
  w1** — un palier bas et stable ne la fait pas tomber. Le libellé du caveat, lui, était trompeur et
  a été corrigé.
  ⚠️ **Au premier run, les 9 projets passent de `ok` à `watch`** : un détecteur neuf n'a jamais
  tourné ⇒ couverture `partial` ⇒ signal `watch` (règle DASH-002). Ce n'est pas une régression, et ça
  se résorbe au premier tick hebdo. `dash-003-pause-health-proof` avait échoué là-dessus : sa liste
  de détecteurs était **recopiée**, elle est maintenant **dérivée** de `SCHEDULE_CATALOG`.
  ⚠️ **`propose:actions` n'en dépend volontairement pas** : AGT-000 ne traite que
  `keyword_opportunity`. Ces findings vivent dans l'onglet **findings** de `/inbox`, jamais dans la
  file d'approbation.
  Puis **REP-001 — le rapport hebdomadaire déterministe** : **E07 était à zéro ligne** alors que
  quatre tickets P0 en dépendaient (REP-002/003/004, TEL-002, AGT-004/005B) **et** l'onglet Rapports
  de DASH-003. ⭐ **Il n'existe aucun endroit où loger un `0` pour un provider non branché** :
  `Availability<T>` est une union discriminée, une section absente **n'a pas de corps**, donc pas de
  tableau de métriques où un zéro pourrait s'écrire. L'acceptation « absent, pas zéro » cesse d'être
  une convention qu'un oubli suffirait à violer. Trois absences distinctes — `not_wired` (brancher),
  `never_collected` (attendre/réparer), `not_examined` (diagnostiquer) — parce qu'elles demandent
  trois gestes. ⭐ **Le gate d'examen passe AVANT le comptage** : sur un parc dont aucun détecteur n'a
  jamais tourné, les sections de findings se déclarent `not_examined` **même si des findings sont
  passés en entrée** — la règle DASH-002 (« jamais regardé ≠ rien à signaler ») portée jusqu'au
  rapport, parce qu'un rapport qui annonce « 0 nouveau finding » sur une page blanche est le plus
  dangereux de tous : rassurant et faux. ⭐ **`renderWeeklyReportText(report)` n'a d'autre paramètre
  que le rapport** : sans accès à la base, à l'heure ni à un modèle, il ne peut rien ajouter que le
  JSON ne porte — « générable sans LLM » devient structurel. Le compteur d'une section vient d'un
  `count(*)`, jamais de `rows.length` : sinon un plafond de lecture deviendrait un fait, et le
  rapport annoncerait une semaine calme parce qu'il a mal lu. La santé vient de `loadHomeCockpit`
  et de nulle part ailleurs (portefeuille, cartes, ordre et compteurs **liens compris**, égalité
  prouvée en base). Zéro DDL (60 tables) · zéro persistance · zéro appel provider · test
  **1162/1162** (+60) · preuve **33/33** sur Neon.
  ⚠️ **L'inspection à l'œil a trouvé ce que ni les tests ni la preuve ne voyaient** : imprimé, le
  rapport répétait la même liste de 9 angles morts dans **les 12 sections** (108 lignes). La
  couverture est désormais portée **une fois** au niveau du rapport, chaque section n'en gardant
  qu'un rappel chiffré — **une projection a le droit de compresser ce que le JSON répète, jamais de
  le taire**. C'est le premier livrable de ce parc qui se lit entièrement **sans écran**.
  ⚠️ **Le rapport n'est ni planifié, ni publié, ni stocké** (périmètre du ticket : REP-003 publie,
  REP-004 archive). ⚠️ **Deux sections sur douze sont absentes aujourd'hui, et c'est correct** :
  `index_observations` est à 0 ligne, aucun projet ne déclare `plausible`. ⚠️ Une **réouverture**
  n'apparaît dans aucune section (`ACTIVITY_EVENTS` hérité de DASH-002) — à rattraper par REP-004.
  Puis **REP-003 — la publication du rapport du lundi**, dernière case P0 de la gate M2. Le
  rapport savait se construire ; rien ne le gardait ni ne le déclenchait, et « accessible après
  restart » ne se dérive de rien (sur Vercel aucun processus ne survit à la requête, et
  reconstruire le JSON une heure plus tard ne rend pas le même objet).
  ⭐ **La publication n'est PAS un job de la file, et c'est structurel** : `jobs.project_id` et
  `monitoring_runs.project_id` sont **NOT NULL** alors que le rapport est **cross-projet** — neuf
  jobs auraient tenté d'écrire le même rapport, huit sans effet, et un no-op est indistinguable
  d'un incident dans une console de file ; et les arêtes de JOB-004 sont **intra-occurrence**,
  donc incapables d'exprimer « attendre les steps des neuf projets ». D'où une table **sans
  `project_id`** (`weekly_reports`, la première du schéma), une attente cross-projet bornée, et un
  appel du tick **après** son drain. L'unique sur le **créneau LOCAL** (même clé que JOB-005) porte
  littéralement « un seul rapport logique par semaine » — prouvé sur deux publications
  **concurrentes** qui laissent une ligne, la seconde rendant `already_published`.
  ⭐ **Le contenu est une fonction du CRÉNEAU** (`now = slot`), **la ligne date de l'ÉCRITURE** :
  sinon deux publications du même lundi (retard, rattrapage) porteraient deux périodes
  différentes, et REP-004 comparerait des semaines qui ne se recouvrent pas. `published_at` est
  l'heure réelle de l'écriture — un drain de quatre minutes ne s'attribue pas une ponctualité
  qu'il n'a pas eue.
  ⭐ **Le SLO se dérive** (`published_at <= due_at`), **aucune colonne de verdict** (les 11
  colonnes sont épinglées par la preuve) : un `slo_met` persisté serait faux le jour où l'échéance
  change — et elle est réglable sans redéploiement (`report.publish_deadline_minutes`, défaut
  60 min = 10:00 local, SLO §17.3).
  ⭐ **`complete` exige un périmètre attendu NON VIDE**, et une **pause** sort le projet du
  dénominateur en restant **nommée** : sans la première règle, un parc entièrement suspendu
  s'annoncerait complet sur zéro projet examiné (faute DASH-002 portée au statut) ; sans la
  seconde, un client gelé trois mois rendrait `partial` éternel et viderait le statut de sa valeur
  discriminante. Un run **existant** l'emporte en revanche sur une pause posée depuis : une
  décision de mercredi ne rétroactive pas le lundi.
  Un seul DDL (**61 tables**) · zéro appel provider · zéro modification de REP-001 · test
  **1214/1214** (+52) · preuve **43/43** sur Neon.
  ⚠️ **Un rapport publié `partial` ne devient jamais `complete`** : republier est un **no-op**,
  jamais un écrasement (graine de REP-004, « régénérer ne remplace pas silencieusement
  l'original »). ⚠️ **Au premier tick après merge, le rapport de la semaine partira `partial` avec
  les 9 projets `missing`** (créneau et échéance déjà passés, aucun run hebdo n'a jamais tourné) :
  un constat d'absence, exact et non réécrit ensuite. ⚠️ **Le SLO de 10:00 est structurellement à
  risque** : 54 jobs hebdo pour `MAX_JOBS_PER_TICK = 25`. ⚠️ **L'annonce est produite et
  journalisée, pas envoyée** (TEL-001 BLOCKED ; l'envoi est TEL-002 — brancher un email de secours
  aurait créé un second chemin à dédupliquer). ⚠️ **Aucun écran ne lit `weekly_reports`**
  (`scripts/rep-003-publish.ts --list|--show|--dry-run` ; l'onglet Rapports est DASH-003).
  Puis **FIND-006 — nouvelles, perdues et émergentes**. FIND-005 comptait les disparitions
  (`vanished`, 107 sur `lecureux`) sans pouvoir les traiter : une requête apparue ou disparue ne
  produisait rien. Le portefeuille a désormais ses entrées et ses sorties.
  ⭐ **Le regroupement de variantes n'est pas un confort d'affichage : il empêche deux faux
  signaux SYMÉTRIQUES.** Google réordonne et réécrit les requêtes ; sans regroupement,
  « genève coiffeur » apparaîtrait comme une **découverte** le jour même où « coiffeur genève »
  devient une **perte** — deux findings, deux fois faux, pour un événement qui n'a pas eu lieu.
  D'où la règle des deux côtés : un groupe n'est `new` que si **TOUS** ses membres sont neufs,
  `lost` que si **TOUS** ont disparu. Mesuré en base : **581 évités sur le seul `barberconcept`**
  (414 + 167). La normalisation est volontairement **pauvre** (accents, casse, ponctuation, ordre
  des mots — ni stemming ni synonymie) parce qu'une fusion abusive **fabrique** un signal, alors
  qu'un groupe manqué ne fait que du bruit ; et elle ne s'affiche **jamais** : titre = terme brut
  dominant, preuves = chaque terme avec sa durée de vie, clé publiée et **rejouable**.
  ⭐ **« Nouvelle » se juge sur TOUT l'historique**, jamais sur la fenêtre précédente : une requête
  vue il y a six mois et revenue est un **retour**, pas une découverte (**264** sur
  `barberconcept`). L'agrégat `firstSeen`/`lastSeen` par requête qui tranche est le même qui porte
  la **première/dernière apparition** exigée par l'acceptation.
  ⭐ **La portée (`scope`) n'existe que du côté des pertes, et c'est structurel** : leur fenêtre de
  référence **glisse d'une semaine à chaque run**, donc plus rien ne mesure ce que la requête
  pesait — alors qu'elle est toujours absente. Sortir son fingerprint de la closure l'auto-
  résoudrait : « je ne peux plus mesurer sa perte » se lirait « elle est revenue ». Le finding
  devenu immesurable reste **strictement intact** (`consecutive_misses` compris) ; seul un
  **retour effectif** le fait compter puis résoudre. C'est la doctrine IDX-005 appliquée à un
  glissement de fenêtre.
  ⭐ **Une perte dont la page n'est plus indexable appartient à `index_drop`** (confirmation
  SPEC §10.4, et garde anti-doublon avec IDX-005) — mais seul un `not_indexed`/`excluded`
  **explicite** supprime : `unknown` (le cas de tout le parc, 0 inspection) ne bloque rien, il
  baisse la confiance et change le skill recommandé (`seo-index-diagnose` tant que l'indexation
  n'est pas vérifiée, `seo-refresh` une fois la page connue indexée).
  **UN job pour DEUX types** (`detect:query_turnover`), parce que chacun est la garde de l'autre —
  donc **deux closures**. Zéro DDL (**61 tables**) · zéro appel provider · catalogue hebdo à
  **7 entrées** · tests **1264/1264** (+50) · preuve **40/40** sur Neon.
  ⚠️ **`LOST = 0` sur les 9 projets aujourd'hui** : 937 disparitions comptées et écartées sur
  `barberconcept`, 82 sur `lecureux` — le parc ne perd que de la longue traîne, et ce n'est pas
  une inertie. ⚠️ **Une découverte non traitée s'AUTO-RÉSOUT** au bout de la fenêtre de 4 semaines
  (la nouveauté est périssable ; personne n'est prévenu). ⚠️ **Premier tick : `barberconcept`
  écrit 50 `new_query` de plus** (221 franchissent le gate, plafond 50) → jusqu'à **150 findings**
  pour un projet frais. ⚠️ **Le SLO de 10:00 s'éloigne : 63 jobs hebdo** pour
  `MAX_JOBS_PER_TICK = 25`. ⚠️ **Les 9 projets repassent de `full` à `partial`** en couverture de
  diagnostic (détecteur neuf), résorbé au premier tick. ⚠️ **AGT-000 n'en fait aucune
  proposition** : une découverte se qualifie et une perte se diagnostique avant de se corriger.
  Puis **FIND-008 — la cannibalisation persistante**, **dernière case P0 de la gate M2**. Le parc
  avait un ÉCRAN de cannibalisation (epic 23) qui lit les tables **legacy**, n'écrit aucun finding,
  n'a ni cycle de vie ni preuves, et ne survit pas à la requête qui l'affiche.
  ⭐ **La normalisation d'URL n'est pas un confort d'affichage : c'est la moitié du détecteur.**
  GSC remonte `…/article#section`, `http://`, `https://www.` et `…/page/` comme des pages
  **distinctes** — ce sont la même ressource. Mesuré : sur `barberconcept`, **143 pages brutes se
  replient en 51**, et les conflits persistants tombent de **397 à 180** (**217 faux conflits
  évités**). Le détail qui compte : deux ancres d'un même article se partagent les impressions à
  parts égales, donc elles prennent **exactement la forme d'une compétition équilibrée** — **391
  de ces faux conflits se seraient lus « probables », contre 171 vrais** (`split` : 299 avant
  repli, 58 après). Règle **fermée**, **versionnée** (`gsc_page_url@1`), **publiée** dans les
  preuves et **rejouable** ; le repli reste réversible (`rawUrls`).
  ⭐ **Le grain HEBDO est obligatoire** : `aggregateWindow` collapse les semaines, donc l'alternance
  — le meilleur discriminant, **122 des 197** conflits du parc — disparaîtrait **sans que rien
  n'échoue**. Et sa contiguïté est celle de la **sous-suite de chevauchement**, pas de la fenêtre :
  on compare les choix de Google sur les semaines où il avait un choix à faire.
  ⭐ **La persistance est un gate DUR** (acceptation littérale, ≠ FIND-005 qui écrit et plafonne),
  et son cas trompeur porte un nom : deux URLs qui ne se **chevauchent jamais** sont un
  **REMPLACEMENT**, pas une cannibalisation.
  ⭐ **La forme mécanique ne gate pas, elle plafonne** (`!probable ⇒ ≤ low`) — gater dessus ferait
  clignoter les findings (écrit → auto-résolu → rouvert). Et c'est écrit franchement dans le
  module : **elle n'écarte que 11 conflits sur 197**, le verdict appartient au skill (§10.5).
  ⭐ **« merge, redirect et canonical restent L4 » est PROUVÉ, pas affirmé** : `action_proposals`
  à 0 après le run, et `mapFindingToActions` appelé directement sur un finding réel rend `[]`.
  **Inversion assumée de FIND-006** : on ne regroupe **pas** les variantes de requêtes — ici la
  fusion **fabriquerait** un conflit. Zéro DDL (**61 tables**) · zéro appel provider · catalogue
  hebdo à **9 entrées** · tests **1338/1338** (+74) · preuve **51/51** sur Neon.
  ⚠️ **Le tripwire `maxUrls` est mathématiquement inatteignable au défaut** (`relativeShare = 0.15`
  borne déjà à ⌊1/0,15⌋ = 6) : il surveille un projet qui **abaisse** sa part, pas la
  normalisation. ⚠️ **`barberconcept` a UN problème d'architecture éditoriale, pas 25 problèmes
  ponctuels** : 180 retenus, 25 écrits. ⚠️ **Premier tick : 42 findings sur tout le parc**, pas
  200. ⚠️ **Le SLO de 10:00 : 81 jobs hebdo** pour `MAX_JOBS_PER_TICK = 25` — **déjà cassé à 72**,
  FIND-008 ajoute 12 % à un déficit de 31. ⚠️ **Les 9 projets repassent de `full` à `partial`**
  (5ᵉ détecteur attendu), résorbé au premier tick.
  Prochain : **DASH-003 lot 2 ch. 3** (l'écran Rapports), puis **REP-004**.
  Détail → [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md).
- **REP-004 — historique, comparaison et archivage** (2026-07-27) · **DONE**, epic **CLÔTURÉ**
  (3 acceptations sur 3), deux lots `1d4a6b4` et `3840dba`. Précédé de **DASH-003 lot 2 ch. 3**
  (`8cd0113`), qui a donné son premier lecteur à `weekly_reports` (`/reports`, cross-projet).
  ⭐ **Lot 1 : « ne remplace pas silencieusement » cesse d'être une abstention et devient une
  FORME.** Jusque-là l'acceptation était tenue en ne faisant rien (republier = no-op), donc le
  seul moyen de ne pas écraser l'original était de **ne jamais corriger le rapport** — un
  `partial` publié à l'échéance restait faux pour toujours. Réviser **insère** : l'unique passe de
  `(period_slot)` à `(period_slot, revision)`, et « un seul rapport par semaine » se déplace dans
  le code — **le tick n'écrit jamais que `revision = 1`**, donc un cron qui repasse cent fois
  produit toujours une ligne, et une révision ≥ 2 exige un geste délibéré **et une raison**
  (CHECK en base). L'original garde id, statut, heure et payload **octet pour octet**.
  ⭐ **Lot 1 : une disponibilité qui change n'est PAS un écart** — 3ᵉ endroit où « absent ≠ zéro »
  se défait, et le seul où il produit un **mouvement inventé** : une section branchée cette
  semaine annoncerait `+13`, un provider tombé `−13` (donc « treize problèmes résolus »). Même
  refus pour les sections d'**activité**, les listes **plafonnées** et les schémas/fenêtres
  différents. Et la comparaison **n'apparie jamais sur de la prose** (`ReportMetric.key`, schéma
  de rapport 1 → 2) : le libellé de la métrique L4 porte un nombre qui change chaque semaine.
  ⭐ **Lot 2 : rendre `payload_json` nullable CRÉE un état, et c'est le CHECK qui le rend sûr.**
  « Ligne sans détail » se lit naïvement « rapport vide » — douze sections non branchées pour un
  rapport qui en portait dix. `weekly_reports_payload_presence_check` interdit sa version
  **muette** : pas de payload ⇒ **adresse d'archive, date de purge et empreinte obligatoires**.
  Trois `UPDATE` nus, ceux qu'on taperait dans psql, sont **refusés en base**.
  ⭐ **Lot 2 : on purge le DÉTAIL, jamais la LIGNE** (SLO, préparation et lignage survivent — ce
  dont `supersedes_id` sans FK et le numéro de révision dérivé du `max` dépendaient déjà sans le
  dire), et **« archivé » est une condition VÉRIFIÉE** : un rapport ne se régénère pas, donc
  `not_archived` retient quel que soit l'âge, et la marque n'est posée qu'après avoir retrouvé la
  note du vault et **comparé son SHA-256**. Un caractère modifié dans le détail embarqué fait
  refuser la confirmation, donc **interdit la purge** (mode de panne du bon côté).
  Deux DDL, **aucune table** (61) · 11 → 19 colonnes sur `weekly_reports` · tests **1419/1419**
  (+56) · preuves **37/37** et **37/37** sur Neon · chaîne réelle export → `/seo-archive` →
  confirm → purge → relecture exercée, altération d'archive comprise.
  ⚠️ **Rétention DÉSACTIVÉE par défaut** (`report.detail_retention_weeks` = `null`, plancher
  4 semaines) : le défaut, comme le pire cas d'une valeur illisible, doit être celui qui ne
  détruit rien. ⚠️ **La séquence d'archivage a quatre étapes et l'ordre EST la garantie.**
  ⚠️ **Prettier n'est pas configuré dans ce repo** — le lancer reformate tout au lieu du style
  maison (incident de ce lot, réparé).
  Prochain : le **portage de `/positions` sur le canon** (débloque FIND-007) ou **AGT-001**
  (API agent v1 — approuver n'exécute toujours rien).
  **Et la mise en prod commence** (2026-07-27) : le cockpit n'a jamais tourné en production, et
  trois choses seulement le séparent du merge — aucun écran vu à l'œil, aucun build Vercel de la
  branche, et un premier tick à **81 jobs hebdo pour un plafond de 25**. Les deux gestes qui
  doivent le précéder sont faits : **`scripts/pauses.ts`** (la porte hors-écran des pauses —
  `/automations` n'est pas déployée, or c'est précisément avant le déploiement que la décision se
  prend ; **les 9 cadences hebdo sont en pause**, reprise projet par projet ensuite) et le cron
  **`gmb-reviews`** dans `vercel.json`, une route qui existait sans être planifiée **nulle part**
  (les avis ne descendaient que par le bouton Sync ; `physiopommier` n'avait pas été synchronisé
  depuis avril). Reste : la **revue visuelle**, le **preview Vercel**, le **merge `--ff-only`** et
  l'observation du premier tick. ⚠️ Le DDL est **déjà en base** (61 tables) — le merge ne touche
  pas au schéma, il **supprime** le risque `db:push`.
  Détail → [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md).
- **GMB-002 — les avis, de la synchro fiable au signal décidable** (2026-07-28) · **DONE**, ticket
  **CLÔTURÉ** (3 acceptations sur 3), deux lots `cd19511` et `40936f0` (+ `b8b78fd`, la
  vérification du chiffre). **Premier ticket livré d'E08, qui en compte 8 et en affichait 0.**
  ⭐ **Lot 1 : `replied_at` (local) et `remote_reply_at` (distant) ne fusionnent jamais.** Une
  colonne unique répond « répondu » aux deux questions, donc ne peut **jamais se contredire**,
  donc ne peut jamais révéler une divergence — et c'est exactement ce qu'il fallait voir : le
  filtre `!reply && <30 j` annonçait **11** avis en attente là où il y en a **502**.
  `pendingReviewFilter()` devient LA définition, là où **onze** endroits l'écrivaient à la main.
  La réconciliation ne coûte **aucun appel Google de plus** (la pagination était déjà totale) : le
  vrai verrou était `onConflictDoNothing`. **382 → 3 189 avis**, 9 fiches avec une santé de
  synchro. Le chiffre de 502 est ensuite **vérifié contre l'API Google**, fiche par fiche
  (301/301, 320/320, 351/351) — aucun écart. L'arriéré est réel et **à deux vitesses** : Lausanne
  1 non répondu sur 302, mais Eaux Vives 190/541 et Jonction 179/499.
  ⭐ **Lot 2 : les deux types de findings COEXISTENT sur un même avis.** §10.4 leur donne deux
  gestes — SLA → skill `gmb-review-responder`, négatif → escalade **humaine** et aucun skill —
  et l'absorption serait asymétrique dans le temps : « avis négatif EN RETARD » deviendrait
  indiscernable de « avis négatif frais ». Corollaire porteur : `negative_review` vise un avis
  1–3★ **non traité**, sinon rien ne pourrait jamais le résoudre. **Zéro DDL** (les deux types
  étaient déjà au vocabulaire).
  ⭐ **Le glissement de fenêtre ne peut PAS auto-résoudre** : la borne des 180 j vit dans la
  closure **et** dans le scope. Sans cette symétrie, « auto-résolu : le signal ne franchit plus
  les seuils » s'écrirait sur **332 avis toujours sans réponse**.
  ⭐ **Le plafond d'écriture se répartit par FICHE** (tour d'équité) — une première dans le parc.
  L'arriéré est concentré : un plafond global aurait donné les 30 places aux deux plus grosses
  fiches et **tronqué le 2★ de Sion**, c'est-à-dire précisément le fait que le lot 1 a mis quatre
  mois à découvrir. La closure reste intégrale — le tour décide qui est **écrit**, il ne ferme rien.
  ⭐ **Le scope exige le statut ET la fraîcheur** de synchro, indissociables : le collecteur écrit
  `last_sync_at` **aussi en cas d'échec** (c'est ce qui rend la panne observable), donc la date
  seule dirait « synchronisée » d'une fiche en panne depuis avril.
  Premier run réel : **17 findings sur `barberconcept`** (13 SLA + 4 négatifs, 3 notifiables
  §14.3) — Eaux Vives 6 · Jonction 5 · Cornavin 4 · Sion 2 · **Lausanne 0**, la contre-épreuve.
  ⚠️ **L'auth provider ne doit pas passer par `$env`** : un handler qui importe `gmb.ts` marche
  sur Vercel et **meurt en dead-letter** sous un worker local.
  ⚠️ **La cadence quotidienne casse le SLO §17.3 (2 h)**, délibérément. Y revenir demande de
  déplacer l'entrée de catalogue **et son détecteur**.
  ⚠️ **Une preuve doit tourner sur un projet vierge sur TROIS points** — appris en polluant six
  fiches de production au lot 1 (restaurées).
  ⚠️ **E08 reste à 1 ticket sur 8** : GMB-003 à GMB-008 sont intouchés.
  Détail → [features/gmb-002-reviews.md](features/gmb-002-reviews.md).
- **Correspondances** : les douleurs jokiSEO (avis full-auto, rang réel, cannibalisation, indexation) sont
  reprises et élargies dans E04/E05/E08 du BACKLOG. L'epic 23 (positions GSC) reste livré en prod.

> Ne pas rouvrir les epics 24-32 : le BACKLOG les remplace.
