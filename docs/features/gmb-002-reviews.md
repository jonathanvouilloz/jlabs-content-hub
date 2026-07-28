# Feature — GMB-002 : les avis, de la synchro fiable au signal décidable (E08)

> Epic E08 (Google Business Profile et avis) · SPEC §9.6, §10.4, §14.3, §17.3 · BACKLOG GMB-002.
> Premier ticket livré d'un epic qui en compte 8 et en affichait 0. **Lot 1 + lot 2 livrés.**

## Recap epic — GMB-002 : les avis, de la synchro fiable au signal décidable (2026-07-28) · CLÔTURÉ

**Objectif** — Faire descendre les avis Google de façon fiable et observable, puis transformer
« cet avis n'a pas de réponse » en un **fait décidable** dans l'inbox du cockpit. E08 comptait
8 tickets et en affichait **0** livré ; GMB-002 était le seul dont les acceptations étaient
atteignables sans les autres.

**Livré**

- **Lot 1 — la collecte** (`cd19511`) : `collect:gmb_reviews` entre dans la file (catalogue
  quotidien, provider `gmb`), réconcilie l'état distant, et chaque fiche porte sa santé de
  synchro. `/api/cron/gmb-reviews` retiré de `vercel.json`, conservé pour rattrapage manuel.
- **Vérification du chiffre** (`b8b78fd`) : les 502 avis en attente sont contrôlés **contre l'API
  Google**, fiche par fiche (301/301, 320/320, 351/351) — aucun écart, aucun champ de réponse
  manqué.
- **Lot 2 — la détection** (`40936f0`) : `detect:review_pending` produit `review_pending_sla` et
  `negative_review`, au catalogue quotidien avec une arête obligatoire depuis la collecte.
- **Un seul DDL sur tout l'epic** (`drizzle/manual-gmb-002.sql`, lot 1) : les colonnes distantes
  de `gmb_reviews` et la santé de `project_gmb_locations`. Le lot 2 n'en a demandé **aucun**.

**Décisions techniques** (reportées dans `docs/DECISIONS.md`)

- **`replied_at` (local) et `remote_reply_at` (distant) ne fusionnent jamais** : une colonne
  unique répond « répondu » aux deux questions, donc ne peut jamais se contredire, donc ne peut
  jamais révéler une divergence. `pendingReviewFilter()` devient LA définition de « en attente »
  — 11 copies manuscrites avant. Alternative écartée : une colonne unique enrichie d'un
  `reply_source` (ne révèle toujours pas le désaccord).
- **La collecte est quotidienne, pas horaire** : casse le SLO §17.3 (2 h) par construction, et
  c'est assumé — ~1 nouvel avis/jour ne justifie pas 24 réveils sur un compte Google unique.
  Alternative écartée : horaire conforme à la SPEC (24× le quota pour la même donnée).
- **Les deux types de findings COEXISTENT sur un même avis** : §10.4 leur donne deux gestes (SLA
  → skill `gmb-review-responder` ; négatif → escalade **humaine**, aucun skill). Alternative
  écartée : absorption du SLA par le négatif (rendrait « avis négatif en retard » indiscernable
  de « avis négatif frais »).
- **La fenêtre des 180 jours vit dans la closure ET dans le scope** : sans cette symétrie, un
  avis franchissant J+180 sortirait de la closure en restant dans la portée, et serait
  auto-résolu au bout de deux runs — sur 332 avis toujours sans réponse. Alternative écartée :
  fenêtre dans la closure seule (le cas nominal marche, le cas limite ment).
- **Le plafond d'écriture se répartit par fiche (tour d'équité)** — une première dans le parc.
  Alternative écartée : plafond global (les 30 places seraient parties à Eaux Vives et Jonction,
  tronquant le 2★ de Sion).
- **Le scope exige `last_sync_status = 'success'` ET la fraîcheur** : le collecteur écrit
  `last_sync_at` **aussi en cas d'échec** (c'est ce qui rend la panne observable), donc la date
  seule dirait « synchronisée » d'une fiche en panne depuis avril.
- **L'auth provider vit dans `gmb-auth.ts` (`process.env`), jamais derrière `$env`** : un handler
  qui importe `gmb.ts` marche sur Vercel et **meurt en dead-letter** sous un worker local.

**Problèmes rencontrés**

- **Le filtre `!reply && <30 j` mentait par omission** : 11 avis « en attente » annoncés contre
  **502** réels. La réconciliation ne coûte aucun appel Google de plus (la pagination était déjà
  totale) — le vrai verrou était `onConflictDoNothing`, passé en `onConflictDoUpdate` sur une
  **liste de colonnes écrite en dur** (les colonnes locales ne sont jamais touchées).
- **`review_id` arrivait en chemin complet** : sans normalisation, la première collecte
  réconciliante aurait inséré **382 doublons**. Vérifié avant écriture : 382 lignes → 382 clés
  distinctes, 0 collision.
- **`weekly-report.ts:148` comparait un ISO à une borne au format DB** : à l'index 10, `'T'`
  (0x54) > `' '` (0x20), donc tout avis du même jour comptait comme « reçu ». Corrigé au lot 1,
  puis rendu **impossible par construction** au lot 2 (pré-filtre SQL sur date nue,
  `parseReviewCreateTime` pour tout le reste).
- **`markReviewAsReplied` et `/reviews/drafts` écrivaient sans filtre `project_id`** — l'unique
  sur `review_id` étant global, un identifiant fourni par l'appelant pouvait toucher l'avis d'un
  autre client.
- **La preuve du lot 1 a pollué six fiches de production** (`last_sync_at` de 2018 sur
  `barberconcept`, la colonne même qui sert de `scope` au lot 2). Restaurées ; les deux preuves
  vérifient désormais elles-mêmes que le projet porteur est vierge — sur **trois** points au
  lot 2, parce que `reconcileDetectionRun` et `expireSnoozes` travaillent à l'échelle du projet.

**Fichiers**

### Créés
- `src/lib/server/collectors/gmb-reviews-state.ts` — jugement pur de la collecte (`GmbApiError`,
  normalisation, diff)
- `src/lib/server/collectors/gmb-reviews.ts` — le collecteur (seul à toucher la base)
- `src/lib/server/gmb-auth.ts` — jetons Google via `process.env`, source unique des 3 appelants
- `src/lib/server/reviews/pending-filter.ts` — LA définition de « en attente », et la seule
- `src/lib/server/detectors/review-pending-state.ts` — jugement pur du détecteur
- `src/lib/server/detectors/review-pending.ts` — le détecteur (seul à toucher la base)
- `drizzle/manual-gmb-002.sql` + `scripts/apply-gmb-002.ts` — le DDL de l'epic, idempotent
- `scripts/collect-reviews.ts` · `scripts/detect-reviews.ts` — runners CLI
- `scripts/gmb-002-reviews-proof.ts` (31 vérifs) · `scripts/gmb-002-lot2-detect-proof.ts` (13)
- Tests : `gmb-reviews-state.test.ts` (40) · `review-pending-state.test.ts` (57)

### Modifiés
- `src/lib/server/db/schema.ts` — colonnes distantes de `gmb_reviews`, santé de
  `project_gmb_locations`
- `src/lib/server/job-runner.ts` · `job-limits.ts` · `schedule-state.ts` · `home-state.ts` —
  câblage des deux jobs (catalogue quotidien, arête obligatoire, provider)
- `src/lib/server/weekly-report.ts` · `home.ts` · 9 routes API/pages — passage à
  `pendingReviewFilter()`
- `vercel.json` — `gmb-reviews` retiré des crons (5 → 4)
- `src/routes/api/cron/gmb-reviews/+server.ts` — conservé, plus planifié

**Vérifications**

| Test | Résultat |
|---|---|
| `gmb-reviews-state.test.ts` (lot 1) | **40 passés** |
| `review-pending-state.test.ts` (lot 2) | **57 passés** |
| `scripts/gmb-002-reviews-proof.ts` (Neon, sans réseau) | **31 vérifs passées**, base rendue à l'identique |
| `scripts/gmb-002-lot2-detect-proof.ts` (Neon, P1→P13) | **toutes passées**, base rendue à l'identique (3 189 / 13 / 17 / 9) |
| Suite complète `npm test` | **1 519 passés / 44 fichiers** |
| `npm run check` | **0 erreur / 42 warnings** (baseline exacte) |
| Collecte réelle | 382 → **3 189 avis**, 3 100 écrits en 41 s, idempotence rejouée sur `physiopommier` (14 vus, 14 inchangés) |
| Détection réelle (`barberconcept`) | **17 findings** (13 SLA + 4 négatifs, 3 notifiables) ; second run **0 créé / 17 rafraîchis** |

Aucune vérification en échec.

**Dettes assumées**

- **Le SLO §17.3 (2 h) est cassé par construction** par la cadence quotidienne. À revisiter si le
  volume d'avis augmente — il faudra alors déplacer l'entrée de catalogue **et son détecteur**.
- **Les lignes antérieures à GMB-002 ne sont pas réécrites** : `/reviews/backfill` avait écrit la
  réponse de Google dans `draft_reply` et son `replyTime` dans `replied_at`. Deviner « qui a
  répondu à ce client » serait exactement la supposition que ce canon refuse. Conséquence : la
  divergence GMB-007 n'est fiable que pour les lignes écrites après le lot.
- **~1 700 avis de `barberconcept` ne sont pas lus** (borne des 365 j) et **`outOfWindow` vaut
  donc structurellement 0**. C'est voulu — ils restent visibles à l'écran, jamais une alerte —
  mais le compteur ne doit pas se lire « rien n'est hors fenêtre ».
- **La sévérité SLA est uniformément `high`** tant que l'arriéré est ancien (`overdueBy >=
  slaDays × 4` = 12 j). Honnête aujourd'hui ; les trois paliers reprendront du sens une fois
  l'arriéré résorbé.
- **`notifyImmediately` est écrit et interrogeable, aucun canal n'est câblé** (TEL-002 BLOCKED).
- **E08 reste à 1 ticket sur 8** : GMB-003 à GMB-008 (projection de contexte, brouillons, quality
  gate, policy d'envoi, divergence) sont intouchés.
- **La fenêtre d'affichage de `/projects/[slug]/reviews` (499 entrées) n'est pas arbitrée**, et le
  rattrapage exportable de Barber Concept reste à sortir — décidé avec Jonathan : session
  suivante.

---

## Etat session 2026-07-28 (lot 2 — LIVRÉ, GMB-002 est CLOS)

**Fait :** `detect:review_pending` produit `review_pending_sla` et `negative_review`. Un avis
sans réponse cesse d'être un fait interrogeable et devient un **finding décidable**, présent dans
`/inbox` et comptable au rapport hebdo. **Zéro DDL** — les deux types étaient déjà dans
`FINDING_TYPES`, `'review'` déjà dans `FINDING_ENTITY_TYPES`, les libellés UI déjà dans
`proposal-format.ts`.

### Ce qui a motivé le lot

Le lot 1 avait rendu la synchro fiable (382 → 3 189 avis, 502 en attente vérifiés contre l'API
Google) — mais **rien ne transformait ces faits en signal**. Le 2★ de Sion du 18/07 était
interrogeable en base et invisible partout ailleurs. E08 comptait 8 tickets, 1 livré.

### Décisions prises avec Jonathan

- **SLA à 3 jours** (et non 7) : un avis Google reste visible en permanence, trois jours de
  silence sont déjà lisibles par le prochain visiteur.
- **Deux findings** sur un avis négatif en retard, jamais un seul.
- **Plafond 30 par type et par projet.**

### Livré

- **⭐ Les deux types COEXISTENT.** §10.4 leur donne deux gestes : le SLA route vers
  `gmb-review-responder`, l'avis négatif vers une **escalade humaine** et aucun skill
  (`NEGATIVE_REVIEW_SKILL` est une constante explicitement nulle). L'absorption serait aussi
  asymétrique dans le temps : à J+2 le 2★ ne produirait qu'un `negative_review`, à J+4 le SLA
  serait masqué — « avis négatif EN RETARD » deviendrait indiscernable de « avis négatif frais ».
  Corollaire porteur : `negative_review` vise un avis 1–3★ **non traité**, pas un avis 1–3★ ;
  sans ce prédicat, le détecteur écrirait des centaines de findings que rien ne résoudrait jamais.
- **⭐ Le glissement de fenêtre ne peut PAS auto-résoudre.** La borne des 180 jours vit dans la
  closure **et** dans le scope. Sans cette symétrie, un avis franchissant J+180 sortirait de la
  closure en restant dans la portée, et serait auto-résolu au bout de deux runs — soit
  « auto-résolu : le signal ne franchit plus les seuils » écrit sur **332 avis toujours sans
  réponse**. Prouvé sur Neon (P5).
- **⭐ Le plafond se répartit par FICHE — une première dans le parc.** L'arriéré est concentré
  (Eaux Vives 190/541 et Jonction 179/499 portent 74 % du retard, Lausanne tient 301/302) : un
  plafond global aurait donné les 30 places aux deux plus grosses fiches et **tronqué le 2★ de
  Sion**, c'est-à-dire précisément le fait que le lot 1 a mis quatre mois à découvrir. Ordre total
  (priorité desc, puis `reviewId`), fiches ordonnées par **identifiant** et non par arriéré
  (classer par volume redonnerait au plus gros l'avantage que le tour existe pour retirer). La
  closure reste intégrale : le tour décide qui est **écrit**, il ne ferme rien.
- **⭐ Le scope vient de la santé de synchro, statut ET fraîcheur.** Indissociables : le
  collecteur écrit `last_sync_at` **aussi en cas d'échec** (c'est ce qui rend la panne observable),
  donc la date seule dirait « synchronisée » d'une fiche en panne depuis avril. S'y ajoutent deux
  gardes par ligne : `last_seen_at IS NULL` (les 88 lignes du backfill) et
  `last_seen_at < last_sync_at` (disparu chez Google, sans jamais un DELETE).
- **La garde du format mixte.** `create_time` est en ISO quand tout le reste est au format DB. Le
  SQL ne pré-filtre que sur une **date nue** (seul préfixe commun aux deux formes) et tout le
  jugement d'âge passe par `parseReviewCreateTime`. C'est le bug `weekly-report.ts:148` du lot 1,
  interdit par construction cette fois.
- **Aucune PII dans les preuves** : ni `author_name`, ni `comment`, ni `draft_reply`.
  `finding_events.payload_json` est **append-only** — ce qu'on y écrit ne s'efface plus.
- **Catalogue quotidien**, arête **obligatoire** `collect:gmb_reviews → detect:review_pending`,
  provider `none`. Cadran : 36 → 45 jobs/jour, toujours **2 ticks** (coût marginal nul).

### Résultat du premier run réel (`barberconcept`, 2026-07-28)

| | Valeur |
|---|---|
| Avis lus (fenêtre 365 j) | 1 094 |
| Franchissent les seuils | **13 SLA + 4 négatifs** |
| Findings écrits | **17**, tous `open` |
| Notifiables §14.3 | **3** |

| Fiche | Findings |
|---|---|
| Barber Concept - Eaux Vives | 6 |
| Barber Concept Jonction Genève | 5 |
| Barber Concept Cornavin | 4 |
| Barber Concept - Sion | 2 |
| **Barber Concept Lausanne** | **0** |

**Lausanne à 0 est la contre-épreuve** : la fiche qui répond (301/302) ne produit rien, celles qui
ont décroché produisent tout. Le **2★ de Sion du 18/07** est `critical`, notifiable, en tête de
liste. `physiopommier` produit **1 SLA** — l'avis du 15/03 que le lot 1 avait tranché « réellement
oublié ». `jonlabs` et `bisrepetita` : **0**, tous leurs avis sont répondus.

Second run à l'identique : **0 créé, 17 rafraîchis**, `occurrence_count = 2` partout et toujours
**17 événements `created`** — l'idempotence tient sur données réelles.

### Vérification

- `review-pending-state.test.ts` — **57 tests**, dont la régression `weekly-report.ts:148` (deux
  avis du même jour, ISO et format DB, un seuil entre les deux) et l'invariant `closure ⊆ scope`
  sur 200 lignes générées.
- `scripts/gmb-002-lot2-detect-proof.ts` — **13 preuves sur Neon** (P1 à P13), **aucune requête
  réseau** : idempotence, coexistence sans collision d'unicité, **le scope protège**
  (`consecutive_misses` inchangé sur une fiche en erreur), auto-résolution puis réouverture,
  **le glissement hors fenêtre ne résout pas**, backfill hors portée, **format mixte**, projet
  sans fiche, **la troncature n'auto-résout pas**, **tour d'équité**, absence de PII, dry-run,
  divergence GMB-007. Base rendue à l'identique (3 189 / 13 / 17 / 9).
- Suite complète : **1 519 tests / 44 fichiers**. `npm run check` : **0 erreur / 42 warnings**
  (baseline exacte).

### Pièges

- ⚠️ **La preuve doit tourner sur un projet vierge sur TROIS points**, et elle le vérifie avant
  d'écrire : aucune fiche GMB réelle (leçon du lot 1), **aucun finding d'avis** (car
  `reconcileDetectionRun` travaille à l'échelle du PROJET et auto-résoudrait un finding de
  production), **aucun finding en veille** (car `expireSnoozes({ projectId })` réveille tous les
  types).
- ⚠️ **`outOfWindow` vaut structurellement 0** : la borne SQL est le maximum des deux fenêtres,
  donc un avis hors des deux n'est pas « lu puis écarté », il n'est **pas lu**. Le CLI dit
  explicitement depuis quelle date il lit — sur `barberconcept`, ~1 700 avis restent hors lecture,
  visibles à l'écran et jamais une alerte.
- ⚠️ **La sévérité SLA est uniformément `high` sur l'arriéré actuel** (`overdueBy >= slaDays × 4`
  = 12 jours, or tout l'arriéré a des mois). C'est honnête — ils **sont** tous très en retard — et
  c'est le `priorityScore` qui discrimine (70 / 59 / 58 / 53). En régime permanent, une fois
  l'arriéré résorbé, les trois paliers `low`/`medium`/`high` reprendront du sens.
- ⚠️ **`res.reviews` est trié par priorité, tous types confondus.** Concaténer « les SLA puis les
  négatifs » faisait passer le 2★ de Sion derrière douze 5★ oubliés : le lecteur voyait d'abord le
  lot le plus nombreux, jamais le plus grave.
- ⚠️ **Le premier tick d'un projet repris écrit désormais un détecteur de plus.** Le repère du
  HANDOFF (4 détecteurs hebdo × 50) s'augmente du quotidien : `barberconcept` a déjà ses 17.
- ⚠️ **`DETECTOR_JOB_TYPES` est dérivé du catalogue** (`home.ts`) : les 9 projets voient leur
  `expectedCount` monter d'une unité et leur couverture passer de `full` à `partial` tant que le
  job n'a pas tourné. **Attendu**, pas une régression.

### Reste à faire (hors périmètre de ce lot)

1. **Le rattrapage Barber Concept** — liste exportable des non-répondus 2025-2026 par fiche
   (Eaux Vives et Jonction d'abord). Décidé avec Jonathan : session suivante.
2. **Arbitrer la fenêtre d'affichage** de `/projects/[slug]/reviews` et `/api/reviews/pending`
   (499 entrées). ⚠️ À ne pas confondre avec `slaLookbackDays` : borner l'écran cache un fait
   vérifié contre l'API Google, borner le détecteur choisit ce qu'on **alerte**.
3. **TEL-002** — `notifyImmediately` est écrit et interrogeable ; **aucun canal n'est câblé**.
4. **GMB-003 à GMB-008** — projection de contexte, brouillons, quality gate, policy d'envoi,
   divergence hub↔Google (comptée ici, jamais un finding).

---

## Etat session 2026-07-28 (lot 1 — LIVRÉ)

**Fait :** la collecte d'avis cesse d'être aveugle, entre dans la file de jobs, et réconcilie
l'état distant. Le lot 2 (findings `review_pending_sla` / `negative_review`) reste à faire.

### Ce qui a motivé le lot — trois faits mesurés en prod le 2026-07-28

- **Un avis 2★ sur `barberconcept` (Sion), daté du 18/07, sans réponse et sans brouillon,
  découvert seulement le 28/07.** Dix jours de silence sur exactement le cas que SPEC §14.3
  classe en notification immédiate.
- **`physiopommier` : un avis du 15/03 « en attente » depuis quatre mois et demi.** Le hub
  était incapable de dire s'il avait été oublié ou répondu directement dans Google.
- **Le cron avalait ses erreurs** dans un `catch {}` anonyme : impossible de distinguer un
  mois calme d'une panne.

### Livré

- **⭐ `replied_at` (local) et `remote_reply_at` (distant) ne fusionnent jamais.** Une colonne
  unique répond « répondu » aux deux questions et ne peut donc jamais se contredire — donc
  jamais révéler une divergence. `pendingReviewFilter()` interroge les deux et devient **la**
  définition de « en attente », là où **onze** endroits l'écrivaient à la main.
- **⭐ La réconciliation ne coûte AUCUN appel Google supplémentaire.** `fetchLocationReviews`
  paginait déjà tout ; le filtre `!reply && <30 j` était appliqué *après* le fetch. Le vrai
  verrou n'était pas le filtre mais `onConflictDoNothing` : un avis connu n'était jamais
  rafraîchi. Passage à `onConflictDoUpdate` sur une **liste de colonnes écrite en dur** —
  `draft_reply`, `replied_at` et `mentioned_employees` sont LOCALES et jamais touchées.
- **⭐ Normalisation de `review_id`** (path complet → segment nu). Sans elle, la première
  collecte aurait inséré **382 doublons** au lieu de réconcilier. Vérifié avant écriture :
  382 lignes → 382 clés distinctes, 0 collision.
- **⭐ L'auth provider quitte `$env`.** Le handler importait `gmb.ts` : il marchait sur Vercel
  et **mourait en dead-letter** dès qu'un worker local le réclamait. `gmb-auth.ts` (modèle
  `gsc-auth.ts`) devient la source unique des jetons pour les trois appelants.
- **`GmbApiError` + `parseGmbError`** : `classifyJobFailure` classe `403 rateLimitExceeded` en
  `quota` **sans que `job-retry.ts` soit modifié** (la classification était jusqu'ici
  accidentelle — le marqueur était trouvé dans le *texte* du message).
- **`collect:gmb_reviews`** au catalogue **quotidien**, provider `gmb` (cohorte séparée de
  `gsc`), `reservedTypes` corrigé du type fantôme `reviews:sync`. `/api/cron/gmb-reviews`
  retiré de `vercel.json`, conservé en rattrapage manuel.
- **Santé par établissement** : `last_sync_at` / `last_sync_status` / `last_sync_error`.
- **Écriture par lots de 100** : 3 100 avis en **41 s**, contre 2 807 allers-retours avant.

### Résultat mesuré après la première collecte réconciliante

| | Avant | Après |
|---|---|---|
| Avis en base | 382 | **3 189** |
| Avis « en attente » | 11 (faux) | **502** (vrai) |
| Fiches avec une santé connue | 0 | **9** |

- **Le fantôme `physiopommier` est tranché : réellement oublié** (`remote_reply_at` NULL,
  brouillon écrit en mars jamais envoyé) — une défaillance de geste, pas de génération.
- **Un 1★ du 18/07 (Lausanne) n'était jamais entré dans le hub** ; il avait été répondu chez
  Google en 14 h. Le filtre de 30 jours le cachait.
- **Le 2★ de Sion est confirmé sans réponse**, 10 jours.
- **Les 88 lignes « divergentes » sont toutes `last_seen_at IS NULL`** : Google ne les renvoie
  plus, ce sont des lignes héritées du `backfill`, pas des divergences hub↔Google. La garde
  « jamais vu ⇒ hors scope » du lot 2 est donc validée empiriquement.

### Vérification du chiffre de 502 — contre l'API Google, pas contre la base

Le passage de 11 à 502 avis « en attente » était assez brutal pour qu'on se demande si la
réconciliation ne fabriquait pas l'arriéré (l'intuition de Jonathan : « Barber Concept a
toujours tout répondu »). Contrôlé en rappelant `reviews.list` **à l'état brut**, sans passer
par le collecteur, sur trois fiches :

| Fiche | Avis (Google) | Avec `reviewReply` | Base : `remote_reply_at` | Accord |
|---|---|---|---|---|
| Lausanne | 302 | 301 | 301 | ✅ |
| Jonction Genève | 499 | 320 | 320 | ✅ |
| Eaux Vives | 541 | 351 | 351 | ✅ |

**Aucun écart.** Vérifié aussi qu'aucun champ de réponse n'échappait à la normalisation : les
six formes de clés rencontrées montrent que Google envoie `reviewReplyUrl` sur **tous** les
avis (c'est le lien pour répondre, pas une réponse) et `reviewReply` uniquement quand une
réponse existe. Aucune variante cachée.

**L'arriéré est donc réel, et il est à deux vitesses** — ce n'est pas de la longue traîne
de 2017 :

| Fiche | Total | Sans réponse |
|---|---|---|
| Lausanne | 302 | **1** |
| Sion | 633 | 28 |
| Rive | 604 | 38 |
| Cornavin | 518 | 63 |
| Jonction Genève | 499 | **179** |
| Eaux Vives | 541 | **190** |

Non répondus **récents** (le trou n'est pas historique) : Eaux Vives 33 en 2024, **98 en
2025**, 5 en 2026 · Jonction 9 / 14 / 8. Lausanne à 1/338 est la contre-épreuve : quand une
fiche est tenue, ça se voit. Échantillons réels non répondus à Eaux Vives, dont un 3★ :
« Je suis arrivé avec 10 minutes de retard à cause des bus après l'école… ».

### Défauts trouvés au passage, corrigés

1. **`weekly-report.ts:148`** comparait `create_time` (ISO, `…T10:52:48Z`) à une borne au
   format DB. À l'index 10, `'T'` (0x54) > `' '` (0x20) : **tout avis du même jour que la
   borne comptait comme « reçu »**, quelle que soit son heure.
2. **`markReviewAsReplied` et `/reviews/drafts` écrivaient sans filtre `project_id`** —
   l'unique sur `review_id` étant global, un identifiant fourni par l'appelant pouvait
   toucher l'avis d'un autre client.
3. **`/reviews/backfill` écrivait la réponse de Google dans `draft_reply` et son `replyTime`
   dans `replied_at`** : les deux colonnes locales portaient des faits distants. Corrigé pour
   l'avenir ; **les lignes antérieures ne sont pas réécrites** (deviner « qui a répondu à ce
   client » serait exactement la supposition que ce canon refuse).
4. **`markReviewAsReplied` écrivait en ISO** dans une colonne au format DB.

### Vérification

- `gmb-reviews-state.test.ts` — **40 tests**, dont la preuve que `classifyJobFailure` classe
  correctement les 6 cas GBP sans modification de `job-retry.ts`.
- `scripts/gmb-002-reviews-proof.ts` — **31 vérifications sur Neon**, `fetchImpl` injecté donc
  **aucune requête réseau** : pagination, idempotence sur un chemin qui fait des `UPDATE`,
  import d'une réponse distante avec `draft_reply`/`replied_at` **intacts au caractère près**,
  avis omis qui reste, 429 → `GmbApiError` → `quota` + `last_sync_status='error'`, note
  modifiée qui invalide son brouillon, projet sans fiche.
- Suite complète : **1 460 tests / 43 fichiers**. `npm run check` : **0 erreur / 42 warnings**
  (baseline exacte).
- Chemin de bout en bout vérifié : `worker.ts --enqueue=physiopommier --job=reviews` puis
  drain → 14 avis vus, **14 inchangés** (idempotence sur données réelles).

### Pièges

- ⚠️ **La preuve doit poser sa sentinelle sous un projet SANS fiche réelle**, et elle le
  vérifie désormais. La première version prenait `barberconcept` (6 fiches) : le collecteur
  parcourant tous les établissements de son projet, elle a écrit un `last_sync_at` de 2018 et
  un `last_sync_status='success'` sur **six fiches de production** — la colonne même qui
  servira de `scope` au lot 2. Les avis n'ont jamais été touchés, les six lignes ont été
  remises à NULL, et le nettoyage vérifie maintenant qu'aucune fiche ne porte de date
  sentinelle.
- ⚠️ **`/projects/barberconcept/reviews` affiche désormais ~499 avis en attente**, dont 332
  d'avant 2025. C'est la vérité — **vérifiée contre l'API Google, chiffre pour chiffre** (voir
  section ci-dessus) — mais c'est brutal à l'écran, et `/api/reviews/pending` renvoie autant
  au skill `gmb-review-responder`. Une fenêtre d'affichage reste à arbitrer.
- ⚠️ **`daily` passe de 27 à 36 jobs/jour** (4 entrées × 9 projets) pour
  `MAX_JOBS_PER_TICK = 25` : l'occurrence ne se draine plus en un tick. Acceptable (tour
  d'équité + `available_at`), mais **5 projets sur 9 n'ont aucune fiche** et leur job réussit
  avec `skippedReason: 'no_gmb_location'` — jamais un échec, jamais un silence.
- ⚠️ **Une pause `daily` sur un projet arrête aussi ses avis.** Aujourd'hui seule `weekly` est
  en pause.
- ⚠️ **Le premier import a été fait à la main** (`scripts/collect-reviews.ts --execute`) après
  mesure en dry-run. Le tick n'aura donc qu'un delta à traiter.

### Prochaine étape — lot 2

`detect:review_pending` produisant `review_pending_sla` et `negative_review` (les deux types
sont **déjà** dans `FINDING_TYPES`, et `'review'` dans `FINDING_ENTITY_TYPES`). Sans lui, le
2★ de Sion reste un fait interrogeable mais n'apparaît ni dans `/inbox` ni au rapport hebdo.

⚠️ **Le dimensionnement a changé** : l'arriéré réel est de 502 avis, pas 11. Le
`slaLookbackDays: 180` prévu au plan est ce qui empêche la closure de contenir 499 entrées sur
`barberconcept` — répartition mesurée : 332 avant 2025, 140 en 2025, 20 en 2026 avant juillet,
10 en juillet.

⚠️ **Le lot 2 doit produire un signal PAR FICHE, pas seulement par projet.** C'est le
constat le plus actionnable de la vérification : un `review_pending_sla` agrégé au projet
dirait « barberconcept a 499 avis en retard » et noierait le fait utile — **deux
établissements sur six portent 74 % de l'arriéré**, et l'un d'eux (Eaux Vives) a laissé
passer 98 avis sur la seule année 2025 pendant que Lausanne tenait 301/302. `entity_type`
vaut `review` (donc le finding est déjà par avis), mais le regroupement de lecture et le
titre doivent nommer l'établissement.

### Reste à faire (session suivante)

1. **Lot 2** — `detect:review_pending` (`review_pending_sla` + `negative_review`), cadré sur
   `slaLookbackDays: 180` : ~40 avis récents actionnables, les 332 d'avant 2025 restant un
   stock visible non transformé en alertes.
2. **Le rattrapage Barber Concept** — sortir la liste exportable des non-répondus 2025-2026
   par fiche (Eaux Vives et Jonction d'abord), pour que le client rattrape. Décidé avec
   Jonathan : traité à la session suivante, pas dans ce lot.
3. **Arbitrer la fenêtre d'affichage** de `/projects/[slug]/reviews` et de
   `/api/reviews/pending` (499 entrées aujourd'hui).

**Commit :** `cd19511` (lot 1) · vérification et cadrage : commit suivant
