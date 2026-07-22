# Feature — E00 Fondations (reconstruction agentique)

> Premier lot exécutable du BACKLOG (§9) pour la reconstruction cockpit agentique.
> SPEC source : `docs/SPEC.md` v0.2 · Backlog : `docs/BACKLOG.md` E00.
> Branche : `feat/cockpit` (depuis `feat/neon`).

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
> Mise à jour : 2026-07-22

| Fichier | Rôle |
|---------|------|
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
| **`src/routes/api/cron/tick/+server.ts`** | **Le battement** (`0 * * * *`, `maxDuration: 300`) : planifie **puis** draine (`runWorker({once})`, budget 240 s via `AbortController`, reaper inclus). Bearer `CRON_SECRET`. 500 si une moitié tombe — un cron toujours vert ne remonte dans aucune alerte. |
| **`scripts/schedule.ts`** | Runner JOB-005 **dry-run par défaut** (`--execute`, `--now=<ISO>` pour rejouer une date DST, `--project`, `--lookback-hours`, `--next-only`) : occurrences dues + **prochaine exécution par projet** en heure métier ET en UTC. |
| **`scripts/job-005-schedule-proof.ts`** | **Preuve JOB-005 sur Neon (33 vérifs)** : idempotence du créneau (restart et tick en retard), les deux régimes DST écrits en base, chaîne planifier→réclamer→`succeeded`, prochaine exécution par projet, post-publication. Catalogue **substitué** (`__test_schedule:<runId>`) pour ne pas déclencher de vraie détection ; nettoyage enfants d'abord, **`monitoring_steps` compris**. |
| `src/lib/server/finding-state.ts` | Purs DATA-005 **+ FIND-003** : fingerprint, scoring §10.2, dérivation d'événements (dont `unsnoozed`), **`canTransition`** (graphe §10.1), `decideOnRedetection`/`decideOnAbsence`, `isSnoozeExpired`/`computeSnoozeUntil`, `resolveLifecycleConfig`, `ACTIVE_STATUSES` — **+ AGT-000 `parseFindingFingerprint`** : la PAGE d'un `keyword_opportunity` ne vit que dans le fingerprint (`entity_key` ne porte que la query), et une cible d'action doit pouvoir la relire sans deviner le séparateur.
| `src/lib/server/findings.ts` | DATA-005 **+ FIND-003 + AGT-000** : `upsertFinding`, `recordFindingEvent`, `transitionFinding` (légalité + effets de bord du cycle de vie), `snoozeFinding`/`dismissFinding`/`reopenFinding`, `expireSnoozes`, **`reconcileDetectionRun`** — et depuis AGT-000 la **LECTURE**, qui manquait entièrement : **`listFindings`** (défaut = les statuts **ACTIFS**, tri total déterministe) et **`getFindingWithEvidence`**. Brique commune à l'API agent (AGT-001) et à l'inbox (E11).
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
| `src/lib/server/jobs-claim.ts` | JOB-001 + JOB-003 + JOB-007 + **JOB-004** — `claimJob` (`FOR UPDATE SKIP LOCKED`, une instruction) et sa **`DEPENDENCY_GATE`** : non réclamable si un prérequis est `queued`/`running`, **ou** si un prérequis **obligatoire** n'a pas abouti (cette seconde moitié ferme la course avec `settleBlockedJobs`) ; `requeueDeadJob` accepte désormais **`skipped`**, pour que le skip ne soit pas un cul-de-sac, `completeJob`/`failJob` (classé)/`releaseJob`, `deferJob` (quota : tentative rendue), `requeueDeadJob` (transactionnel, journalise la reprise), `listDeadJobs`, **`listJobs`/`countJobs`/`countJobsByStatus`/`getJobDetail`** (lecture de la console) et **`cancelJob`** (transactionnel : retire le bail, clôt la tentative ouverte, écrit la ligne d'audit). |
| `src/lib/server/job-runner.ts` | JOB-001/002 + **JOB-003** + **JOB-005** + **AGT-000** (`propose:actions`) — registre de handlers, boucle `runWorker` arrêtable, routage `defer`/`fail` selon la classe, `deferred` + `failedByClass` ; **`concludeRunStep`** délègue à `monitoring.concludeJobStep` (partagée avec la passe de dépendances) et n'écrit **qu'aux issues terminales** ; **JOB-004** ajoute **`settleOnce`**, jumelle du reaper — bornée, non bloquante, jouée au démarrage et à chaque tour à vide, **avant** le `break` de `once`. |
| `scripts/worker.ts` | Worker CLI (`--once`, `--enqueue=<slug>`, `--types`, `--lease-ms`, `--poll-ms`) + arrêt gracieux SIGINT/SIGTERM. |
| `scripts/job-claim-concurrency.ts` | Preuve d'unicité de réclamation sur Neon (concurrence, étanchéité du bail, arrêt gracieux, backoff/dead-letter) ; **type unique par exécution** + nettoyage enfants-d'abord (corrigé en JOB-003). |
| **`scripts/job-003-retry-proof.ts`** | **Preuve JOB-003 sur Neon (44 vérifs)** : 5xx replanifié/jitté, 429 reporté (tentative rendue, Retry-After honoré), 403-quota Google ≠ 403 structurel, dead-letter immédiat, plafond de reports, reprise manuelle avec historique intact ; nettoie ses propres lignes. |
| **`scripts/jobs-requeue.ts`** | Reprise d'un job depuis la dead-letter (`--job`, `--actor`, `--reason`, `--dry-run`) ; refuse un job vivant, prévient sur cause `auth`/`permanent`. |
| `scripts/jobs-inspect.ts` | Chronologie d'un job et vue dead-letter en CLI (`--job`, `--project`, `--status`, `--dead`, `--class`) ; **libellés importés de `utils/job-format.ts`** depuis JOB-007 — mêmes mots que la console. |
| **`src/lib/server/job-console.ts`** | **Purs JOB-007 (serveur)** : `normalizeJobFilters` (l'URL réduite au vocabulaire connu **avant** toute requête), `canCancelJob`/`canRequeueJob` (légalité des actions, miroir des gardes SQL), **`explainFailure`** (classe d'erreur → verdict + action + `willRepeat` ; **JOB-004** : un `skipped` renvoie vers le **prérequis**, jamais vers le job lui-même), **`describeDependencies`** (badge « attend … » **dérivé**, jamais stocké — sans lui un job retenu par la garde ressemble à un job coincé). |
| **`src/lib/server/job-console.test.ts`** | **Vitest JOB-007/JOB-004 — 33 tests** (filtres hostiles écartés, pagination bornée, matrice d'annulation/reprise, les 4 classes expliquées, annulation ≠ échec). |
| **`src/lib/utils/job-format.ts`** (+ `.test.ts`) | **Libellés et formats partagés CLI ↔ console** — `OUTCOME_LABEL`/`CLASS_LABEL`/`KIND_LABEL`/`STATUS_LABEL`, **`CADENCE_LABEL`** (JOB-005), `formatDbTimestamp`/`formatDbTime`/`formatDuration`/`formatRelative` (`now` injecté), `parseDbTimestamp` (**UTC explicite**), **`formatScheduleSlot`** (créneau LOCAL, jamais reconverti). Dans `utils/` parce qu'une page Svelte ne peut pas importer `$lib/server`. 11 tests. |
| **`src/routes/(app)/jobs/+page.server.ts` + `+page.svelte`** | **La file** : filtres normalisés côté serveur, `listJobs`/`countJobs`/`countJobsByStatus`, compteurs cliquables par statut, table dense, pagination ; `now` serveur passé à la page (jamais l'horloge du navigateur). **+ JOB-005** : panneau **Planification** (`listNextOccurrences`, heure métier **et** UTC, cadences non câblées nommées une fois), soumis au même filtre projet que la file. |
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
| `src/lib/server/proposal-state.ts` | Purs DATA-006 : `canActorApprove` (séparation des niveaux L0–L4), `isApprovalValid` (hash lié + expiration), `statusAfterPayloadChange`, tuples (statuts/niveaux/méthodes/vérif). |
| `src/lib/server/proposal-state.test.ts` | Vitest DATA-006 — 18 tests (niveaux d'approbation, validité hash/expiration, transitions). |
| `src/lib/server/proposals.ts` | DATA-006 **+ AGT-000** — `createProposal` idempotent (+`computePayloadHash` sha256) qui **rafraîchit désormais les champs NON hashés** (rationale/impact : sans quoi une proposition afficherait éternellement les mesures de sa première semaine), `approveProposal` transactionnel (refus niveau), `updateProposalPayload` (invalidation), **`listProposalsForFinding`**, **`supersedeProposals`** (gardée sur les statuts ouverts), agent runs. **Client injecté** + horodatages au **format DB** (deux corrections AGT-000 : le module était inchargeable hors SvelteKit et écrivait de l'ISO).
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
