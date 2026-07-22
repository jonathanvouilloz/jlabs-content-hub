# Feature — E00 Fondations (reconstruction agentique)

> Premier lot exécutable du BACKLOG (§9) pour la reconstruction cockpit agentique.
> SPEC source : `docs/SPEC.md` v0.2 · Backlog : `docs/BACKLOG.md` E00.
> Branche : `feat/cockpit` (depuis `feat/neon`).

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
> Mise à jour : 2026-07-22

| Fichier | Rôle |
|---------|------|
| `src/lib/server/finding-state.ts` | Purs DATA-005 **+ FIND-003** : fingerprint, scoring §10.2, dérivation d'événements (dont `unsnoozed`), **`canTransition`** (graphe §10.1), `decideOnRedetection`/`decideOnAbsence`, `isSnoozeExpired`/`computeSnoozeUntil`, `resolveLifecycleConfig`, `ACTIVE_STATUSES`. |
| `src/lib/server/findings.ts` | DATA-005 **+ FIND-003** : `upsertFinding`, `recordFindingEvent`, `transitionFinding` (légalité + effets de bord du cycle de vie), `snoozeFinding`/`dismissFinding`/`reopenFinding`, `expireSnoozes`, **`reconcileDetectionRun`**. |
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
| `src/lib/server/jobs-claim.ts` | JOB-001 + JOB-003 + **JOB-007** — `claimJob` (`FOR UPDATE SKIP LOCKED`, une instruction), `completeJob`/`failJob` (classé)/`releaseJob`, `deferJob` (quota : tentative rendue), `requeueDeadJob` (transactionnel, journalise la reprise), `listDeadJobs`, **`listJobs`/`countJobs`/`countJobsByStatus`/`getJobDetail`** (lecture de la console) et **`cancelJob`** (transactionnel : retire le bail, clôt la tentative ouverte, écrit la ligne d'audit). |
| `src/lib/server/job-runner.ts` | JOB-001/002 + **JOB-003** — registre de handlers, boucle `runWorker` arrêtable, routage `defer`/`fail` selon la classe, `deferred` + `failedByClass` dans les compteurs. |
| `scripts/worker.ts` | Worker CLI (`--once`, `--enqueue=<slug>`, `--types`, `--lease-ms`, `--poll-ms`) + arrêt gracieux SIGINT/SIGTERM. |
| `scripts/job-claim-concurrency.ts` | Preuve d'unicité de réclamation sur Neon (concurrence, étanchéité du bail, arrêt gracieux, backoff/dead-letter) ; **type unique par exécution** + nettoyage enfants-d'abord (corrigé en JOB-003). |
| **`scripts/job-003-retry-proof.ts`** | **Preuve JOB-003 sur Neon (44 vérifs)** : 5xx replanifié/jitté, 429 reporté (tentative rendue, Retry-After honoré), 403-quota Google ≠ 403 structurel, dead-letter immédiat, plafond de reports, reprise manuelle avec historique intact ; nettoie ses propres lignes. |
| **`scripts/jobs-requeue.ts`** | Reprise d'un job depuis la dead-letter (`--job`, `--actor`, `--reason`, `--dry-run`) ; refuse un job vivant, prévient sur cause `auth`/`permanent`. |
| `scripts/jobs-inspect.ts` | Chronologie d'un job et vue dead-letter en CLI (`--job`, `--project`, `--status`, `--dead`, `--class`) ; **libellés importés de `utils/job-format.ts`** depuis JOB-007 — mêmes mots que la console. |
| **`src/lib/server/job-console.ts`** | **Purs JOB-007 (serveur)** : `normalizeJobFilters` (l'URL réduite au vocabulaire connu **avant** toute requête), `canCancelJob`/`canRequeueJob` (légalité des actions, miroir des gardes SQL), **`explainFailure`** (classe d'erreur → verdict + action + `willRepeat`). |
| **`src/lib/server/job-console.test.ts`** | **Vitest JOB-007 — 22 tests** (filtres hostiles écartés, pagination bornée, matrice d'annulation/reprise, les 4 classes expliquées, annulation ≠ échec). |
| **`src/lib/utils/job-format.ts`** (+ `.test.ts`) | **Libellés et formats partagés CLI ↔ console** — `OUTCOME_LABEL`/`CLASS_LABEL`/`KIND_LABEL`/`STATUS_LABEL`, `formatDbTimestamp`/`formatDbTime`/`formatDuration`/`formatRelative` (`now` injecté), `parseDbTimestamp` (**UTC explicite**). Dans `utils/` parce qu'une page Svelte ne peut pas importer `$lib/server`. 9 tests. |
| **`src/routes/(app)/jobs/+page.server.ts` + `+page.svelte`** | **La file** : filtres normalisés côté serveur, `listJobs`/`countJobs`/`countJobsByStatus`, compteurs cliquables par statut, table dense, pagination ; `now` serveur passé à la page (jamais l'horloge du navigateur). |
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
| `src/lib/server/policies.ts` | DATA-007 — `promotePolicy` transactionnel idempotent (+`computePolicyHash` sha256, journal), `setKillSwitch` (promotion journalisée sans toucher la sync), `getCurrentPolicy`/`getEffectivePolicy`. |
| `scripts/apply-data-007.ts` + `drizzle/manual-data-007.sql` | Application déterministe du DDL additif DATA-007 (`review_automation_policies` + `policy_promotions`). |
| `src/lib/server/proposal-state.ts` | Purs DATA-006 : `canActorApprove` (séparation des niveaux L0–L4), `isApprovalValid` (hash lié + expiration), `statusAfterPayloadChange`, tuples (statuts/niveaux/méthodes/vérif). |
| `src/lib/server/proposal-state.test.ts` | Vitest DATA-006 — 18 tests (niveaux d'approbation, validité hash/expiration, transitions). |
| `src/lib/server/proposals.ts` | DATA-006 — `createProposal` idempotent (+`computePayloadHash` sha256), `approveProposal` transactionnel (refus niveau), `updateProposalPayload` (invalidation), agent runs. |
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
