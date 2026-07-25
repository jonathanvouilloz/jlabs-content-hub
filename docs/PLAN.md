# Plan d'execution — seo-stats

> Derniere mise a jour : 2026-07-21
> **Cap actuel :** refonte **cockpit agentique de monitoring** (SPEC : [SPEC.md](SPEC.md) · execution : [BACKLOG.md](BACKLOG.md)).
> Ce fichier ne garde que **l'historique du socle livré** (Phases 1-2, epics 1-23). La suite (E00→E13)
> vit dans **[BACKLOG.md](BACKLOG.md)**, pas ici. Le pivot jokiSEO (2026-06-24) est archivé (`_archive/PRD-jokiseo.md`).
>
> **Pré-requis transverse en cours :** migration données Turso → Neon (voir [NEON-MIGRATION.md](NEON-MIGRATION.md) Phase 4)
> avant de démarrer la reconstruction du BACKLOG.

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
  Prochain : trancher le point produit ouvert par la revue — **`barberconcept` s'affiche « Sain » sans
  avoir jamais été diagnostiqué** (zéro finding se lit « zéro problème » : le vice que l'invariant
  « pipeline cassé ⇒ signal `unknown` » interdit sur l'autre axe) — puis **DASH-003 lot 2** ou
  **DASH-006** (débloqué : JOB-007 est DONE).
  Détail → [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md).
- **Correspondances** : les douleurs jokiSEO (avis full-auto, rang réel, cannibalisation, indexation) sont
  reprises et élargies dans E04/E05/E08 du BACKLOG. L'epic 23 (positions GSC) reste livré en prod.

> Ne pas rouvrir les epics 24-32 : le BACKLOG les remplace.
