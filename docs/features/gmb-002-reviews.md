# Feature — GMB-002 : synchronisation des avis, fiable et observable (E08 lot 1)

> Epic E08 (Google Business Profile et avis) · SPEC §9.6, §17.3 · BACKLOG GMB-002.
> Premier ticket livré d'un epic qui en compte 8 et en affichait 0.

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
