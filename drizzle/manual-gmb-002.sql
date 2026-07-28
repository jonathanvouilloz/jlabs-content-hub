-- GMB-002 — L'état DISTANT d'un avis devient un fait, et la synchro d'un établissement
-- devient interrogeable. Additif, idempotent.
-- Miroir fidèle de `gmbReviews` et `projectGmbLocations` dans src/lib/server/db/schema.ts.
-- Appliqué par scripts/apply-gmb-002.ts. AUCUNE nouvelle table (61).
--
-- ⚠️ CE FICHIER TOUCHE DES DONNÉES, contrairement aux DDL précédents : il NORMALISE
--    `review_id` (§4). C'est la seule écriture, elle est déterministe et idempotente, et
--    elle est OBLIGATOIRE — sans elle le nouveau collecteur insérerait 382 doublons au
--    lieu de réconcilier. Détail et garanties au §4.
--
-- Le sujet, mesuré en prod le 2026-07-28 : `physiopommier` porte un avis du 15 mars toujours
-- « en attente », avec un brouillon prêt. Personne ne peut dire s'il a été oublié ou s'il a
-- reçu sa réponse directement dans Google — parce que le hub ne stocke NULLE PART ce que
-- Google dit de cet avis. `fetchProjectReviews` filtrait `!r.reply` : un avis répondu
-- n'entrait jamais, et un avis connu n'était jamais rafraîchi (`onConflictDoNothing`). Le
-- hub ne pouvait donc que fabriquer des fantômes, et n'avait aucun moyen de les dissiper.
--
-- ⚠️ LA DISTINCTION QUI PORTE TOUT LE LOT : `replied_at` est LOCAL (« le hub a envoyé »),
--    `remote_reply_at` est DISTANT (« Google montre une réponse »). Les confondre en une
--    seule colonne, c'est perdre la seule chose qui rende la divergence GMB-007 visible :
--    `replied_at NOT NULL AND remote_reply_at IS NULL` après une synchro réussie veut dire
--    « le hub croit avoir répondu, Google ne le confirme pas ». Une colonne unique
--    répondrait « répondu » aux deux questions et ne pourrait jamais se contredire.
--
-- ⚠️ `replied_at` EST DÉJÀ CONTAMINÉE, et ce DDL ne la répare pas rétroactivement.
--    `src/routes/api/projects/[slug]/reviews/backfill/+server.ts` y écrit le `replyTime` de
--    Google (et met la réponse Google dans `draft_reply`). Une part des 379 avis de
--    `barberconcept` porte donc un `replied_at` qui n'est pas une écriture du hub.
--    Conséquence à tenir dans le code : l'indicateur de divergence n'est fiable que pour les
--    lignes écrites APRÈS ce lot. On répare l'écrivain (T9), on ne réécrit pas l'histoire —
--    une migration devinerait, et deviner sur « a-t-on répondu à ce client » est exactement
--    le genre de supposition que ce canon refuse.
--
-- ⚠️ AUCUN DEFAULT SUR `last_sync_status` NI SUR `last_seen_at`. NULL est un état PORTEUR :
--    « jamais lu chez Google ». Un DEFAULT 'success' ferait lire comme saine une location
--    jamais synchronisée, et un DEFAULT now() sur `last_seen_at` ferait croire que chaque
--    ligne préexistante a été observée par le nouveau collecteur — ce qui armerait le
--    détecteur du lot 2 sur des avis dont l'état distant n'a jamais été lu. C'est la règle
--    « absent ≠ zéro » (REP-001), appliquée à une colonne au lieu d'une section.
--
-- Écart d'introspection ATTENDU : 61 → 61 tables `seostats` (aucune table créée).
--   `gmb_reviews`            : 13 → 17 colonnes
--   `project_gmb_locations`  :  6 →  9 colonnes

-- ── 1. `gmb_reviews` — ce que Google dit ────────────────────────────────────────────────

-- Le TEXTE de la réponse publiée chez Google. Séparé de `draft_reply` (notre proposition)
-- parce que GMB-002 exige « un avis modifié invalide le brouillon associé » : on ne peut pas
-- invalider une proposition qui partage sa colonne avec la publication.
ALTER TABLE "seostats"."gmb_reviews"
	ADD COLUMN IF NOT EXISTS "remote_reply_text" text;

-- `reviewReply.updateTime` de Google, au format DB. C'est LUI qui dit « cet avis a une
-- réponse », jamais `replied_at`. Format DB (et non l'ISO brut de Google) parce que la
-- comparaison est lexicale : un ISO ('…T07:06:58Z') et un format DB ('… 07:06:58') ne sont
-- pas comparables — le piège documenté dans src/lib/utils/timestamps.ts.
ALTER TABLE "seostats"."gmb_reviews"
	ADD COLUMN IF NOT EXISTS "remote_reply_at" text;

-- `updateTime` de l'AVIS lui-même (distinct de celui de la réponse). Sans lui, « détecter les
-- modifications d'avis » (3ᵉ puce de GMB-002) et « avis modifié après génération » (SPEC §9.6)
-- n'ont aucun ancrage : on ne saurait comparer que le texte, ce qui rate une note changée.
ALTER TABLE "seostats"."gmb_reviews"
	ADD COLUMN IF NOT EXISTS "remote_update_at" text;

-- Quand cette ligne a été VUE chez Google pour la dernière fois. Trois usages, tous
-- indispensables au lot 2 :
--   NULL          ⇒ ligne héritée, état distant jamais lu ⇒ HORS scope ET hors closure.
--                   C'est la garde qui rend le premier run du détecteur sûr.
--   < last_sync_at de sa location (elle-même en succès frais)
--                 ⇒ l'avis a disparu chez Google ⇒ dans le scope, hors closure ⇒ auto-résolu.
--                   La disparition devient un FAIT dérivable, sans jamais DELETE une ligne.
--   = ce run      ⇒ `seenThisRun`, le terme sans lequel on notifierait sur un avis non revu.
ALTER TABLE "seostats"."gmb_reviews"
	ADD COLUMN IF NOT EXISTS "last_seen_at" text;

-- ── 2. `project_gmb_locations` — la santé de la synchro ─────────────────────────────────

-- GMB-001 demande d'« exposer santé et dernière synchro ». Aujourd'hui le cron avale ses
-- erreurs dans un `catch {}` anonyme (aucun log, aucune écriture) : `bisrepetita` et
-- `physiopommier` n'ont rien reçu depuis mai et avril, et il est IMPOSSIBLE de prouver que
-- ce sont des mois calmes plutôt qu'une panne. Ces trois colonnes transforment cette question
-- indécidable en une requête.
--
-- Elles portent aussi le `scope` du détecteur (lot 2) : un avis n'est jugeable que si sa
-- location a été synchronisée avec SUCCÈS et RÉCEMMENT. Sans ce second terme, une location
-- qui cesse silencieusement d'être synchronisée continuerait d'auto-résoudre ses findings —
-- le pire mensonge possible ici, puisque la panne de synchro est précisément le mode de
-- défaillance qu'on instrumente.
ALTER TABLE "seostats"."project_gmb_locations"
	ADD COLUMN IF NOT EXISTS "last_sync_at" text;

-- 'success' | 'error'. Sans DEFAULT (voir l'avertissement en tête).
ALTER TABLE "seostats"."project_gmb_locations"
	ADD COLUMN IF NOT EXISTS "last_sync_status" text;

-- Le message structuré du dernier échec (status + reason Google), borné à l'écriture.
-- Un échec cesse d'être un compteur anonyme et redevient un diagnostic.
ALTER TABLE "seostats"."project_gmb_locations"
	ADD COLUMN IF NOT EXISTS "last_sync_error" text;

-- ── 3. Index ────────────────────────────────────────────────────────────────────────────

-- Le détecteur relit tous les avis d'un projet à chaque run et partitionne sur la fraîcheur
-- d'observation. Sans cet index, la lecture du scope est un seq scan par projet et par jour.
CREATE INDEX IF NOT EXISTS "idx_gmb_reviews_project_last_seen"
	ON "seostats"."gmb_reviews" ("project_id", "last_seen_at");

-- « Les avis négatifs récents de ce projet » — la lecture chaude du type `negative_review`,
-- et celle de la section 9 du rapport hebdo.
CREATE INDEX IF NOT EXISTS "idx_gmb_reviews_project_rating_created"
	ON "seostats"."gmb_reviews" ("project_id", "rating", "create_time");

-- ── 4. Normalisation de `review_id` — la SEULE écriture de ce fichier ────────────────────
--
-- Les 382 lignes existantes stockent le PATH COMPLET que Google renvoie dans `name` :
--   accounts/109757690564270447076/locations/12743724963296165280/reviews/AbFvOqk1cZ5w…
-- Le nouveau collecteur écrit le DERNIER SEGMENT (`normalizeReviewKey`). Sans cette
-- normalisation, la toute première collecte n'aurait réconcilié RIEN : elle aurait inséré
-- 382 lignes neuves à côté des anciennes, doublé le compteur d'avis en attente, et laissé
-- le fantôme `physiopommier` exactement où il est.
--
-- Pourquoi le segment nu est la bonne identité : `{acct}` change lors d'un transfert de
-- propriété GBP ou d'une migration de compte. Tant que le path complet fait office de clé,
-- un tel transfert produit un jeu complet de doublons — et, au lot 2, un « nouvel avis sans
-- réponse » pour chaque avis vieux de six mois. Le segment est ce que Google garantit stable ;
-- le path complet reste disponible côté Google et dans les preuves des findings.
--
-- ⚠️ Ce n'est PAS une reconstruction de données : `split_part` applique une fonction
--    déterministe à une valeur présente. Rien n'est deviné, contrairement à `replied_at`
--    (contaminé par `reviews/backfill`) qu'on se garde bien de « réparer » rétroactivement.
--
-- Sûreté VÉRIFIÉE en base avant écriture (2026-07-28) : 382 lignes → 382 clés distinctes,
-- 0 collision, 0 clé vide. La garde `WHERE review_id LIKE '%/%'` rend l'instruction
-- idempotente (une seconde application ne touche plus rien), et l'unique global sur
-- `review_id` ferait ÉCHOUER la transaction en cas de collision imprévue — jamais écraser
-- silencieusement.
UPDATE "seostats"."gmb_reviews"
	SET "review_id" = split_part("review_id", '/', -1)
	WHERE "review_id" LIKE '%/%'
	  AND split_part("review_id", '/', -1) <> '';
