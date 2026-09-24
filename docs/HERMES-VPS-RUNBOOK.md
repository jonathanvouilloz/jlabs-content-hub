# Runbook Hermes VPS — SEO Stats / GMB Barber Concept

Ce document est le point d'entrée opérateur pour le profil Hermes qui traite les avis Google
Business Profile de Barber Concept. Le contrat détaillé des payloads reste dans
[`agent-api-gmb-barberconcept.md`](agent-api-gmb-barberconcept.md).

## État de référence

État vérifié le 24 septembre 2026 :

- production SEO Stats : `https://hubseo.jonlabs.ch` ;
- code de production : branche `main` ; feature livrée par `e26fdb8` ;
- migrations DATA-009, DATA-010 et DATA-011 : appliquées ;
- credential actif : `hermes-barberconcept-2026-09-r2` ;
- projet autorisé : `barberconcept` uniquement ;
- test authentifié `barberconcept` : HTTP `200` ;
- test du même bearer sur `lecureux` : HTTP `403` ;
- build Linux/Vercel : `Ready` ;
- profil Hermes installé ; fuseau `Europe/Zurich` ; crons configurés à 09:45, lundi 10:15 et
  premier du mois 10:30 ;
- routage Telegram validé vers les threads 22 (alertes) et 20 (avis), ainsi que le récap test ;
- baseline établie sans retraitement automatique des avis antérieurs au 24 septembre 2026 ;
- 6 fiches synchronisées avec succès ;
- projection `current` promue et vérifiée idempotente : voix, interdits, 6 fiches, 25 employés
  actifs/publics et alias validés ;
- policy `current` v1 active : `guarded_auto`, seuil 4 étoiles, kill switch désactivé et plafond de
  20 publications par passage ;
- code `googleReviewUrl` déployé ; les liens historiques restent `null` jusqu'au prochain
  `collect:gmb_reviews` canonique ;
- restant : observer le premier passage complet puis le canary 4–5 étoiles, sans rejouer
  l'historique antérieur à la baseline.

Le bearer brut n'est jamais écrit dans Git, dans ce document, dans un ticket ou dans un log. Il
est irrécupérable s'il est perdu : dans ce cas, il faut le faire tourner.

## Frontière de sécurité

SEO Stats reste l'unique autorité sur :

- Neon/PostgreSQL ;
- les credentials et appels Google Business Profile ;
- le snapshot d'un avis ;
- la policy et son kill switch ;
- la décision d'auto-publication ;
- l'idempotence et l'audit de livraison.

Hermes ne reçoit jamais `DATABASE_URL`, `ENCRYPTION_KEY`, de token OAuth Google ou de secret
Vercel. Il n'appelle ni Neon ni Google directement. Il ne crée pas de second collecteur GMB et ne
réécrit pas une réponse distante existante.

## Variables du profil VPS

Variables obligatoires :

```dotenv
SEO_STATS_BASE_URL=https://hubseo.jonlabs.ch
SEO_STATS_BEARER=<credential-id.secret>
SEO_STATS_PROJECT_SLUG=barberconcept
TELEGRAM_BOT_TOKEN=<secret-du-bot>
TELEGRAM_CHAT_ID=<destination-des-escalades>
```

Contraintes :

- `SEO_STATS_BASE_URL` ne contient ni `/login` ni `/api` ;
- `SEO_STATS_BEARER` contient la chaîne complète `id.secret` ;
- `SEO_STATS_PROJECT_SLUG` reste exactement `barberconcept` ;
- le fichier d'environnement appartient à l'utilisateur du service et porte le mode `0600` ;
- ne jamais activer le traçage shell (`set -x`) dans un processus qui charge ces variables.

Exemple d'installation, à adapter au chemin et au gestionnaire de service réellement utilisés :

```bash
sudo install -d -m 700 /etc/hermes
sudo install -m 600 /dev/null /etc/hermes/seo-stats.env
sudoedit /etc/hermes/seo-stats.env
```

Le service Hermes doit charger ce fichier via son mécanisme natif, par exemple un
`EnvironmentFile=/etc/hermes/seo-stats.env` sous systemd. Le nom réel de l'unité doit être relevé
sur le VPS ; ne pas supposer qu'il s'appelle `hermes.service`.

## Préflight sans effet externe

Depuis une session sécurisée qui a chargé le fichier d'environnement :

```bash
test "$SEO_STATS_BASE_URL" = "https://hubseo.jonlabs.ch"
test "$SEO_STATS_PROJECT_SLUG" = "barberconcept"
test -n "$SEO_STATS_BEARER"
test -n "$TELEGRAM_BOT_TOKEN"
test -n "$TELEGRAM_CHAT_ID"
```

Test autorisé, sans afficher le payload ni le bearer :

```bash
code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --header "Authorization: Bearer ${SEO_STATS_BEARER}" \
  "${SEO_STATS_BASE_URL}/api/agent/v1/projects/${SEO_STATS_PROJECT_SLUG}/reviews?limit=1")"
test "$code" = "200"
```

Test d'isolation à ne jouer qu'à l'installation ou après rotation :

```bash
code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --header "Authorization: Bearer ${SEO_STATS_BEARER}" \
  "${SEO_STATS_BASE_URL}/api/agent/v1/projects/lecureux/reviews?limit=1")"
test "$code" = "403"
```

Résultats attendus : bearer absent/invalide `401`, scope ou projet interdit `403`, Barber Concept
autorisé `200`. Un `401` ou `403` est une erreur de configuration : ne pas retenter en boucle.

## Routes disponibles

| Méthode | Route | Scope | Effet |
|---|---|---|---|
| `GET` | `/api/agent/projects/{slug}/insights` | `agent:insights:read` | Insights SEO en lecture seule |
| `GET` | `/api/agent/v1/projects/{slug}/reviews` | `review:read` | Avis, fraîcheur et décision du hub |
| `POST` | `/api/agent/v1/projects/{slug}/reviews/{reviewId}/proposals` | `review:propose` | Persiste une proposition |
| `POST` | `/api/agent/v1/projects/{slug}/reviews/{reviewId}/mentions` | `review:propose` | Persiste des mentions candidates |
| `POST` | `/api/agent/v1/projects/{slug}/proposals/{proposalId}/publish` | `review:publish` | Publication bornée et auditée |
| `GET` | `/api/agent/v1/projects/{slug}/proposals/{proposalId}/reconcile` | `review:publish` | Relecture Google, sans écriture |
| `GET` | `/api/agent/v1/projects/{slug}/monthly-reports/{YYYY-MM}` | `review:report:read` | Récap mensuel Europe/Zurich |
| `POST` | `/api/agent/v1/projects/{slug}/monthly-reports/{YYYY-MM}/close` | `review:propose` | Fige une révision immuable |

Toujours construire les URLs depuis `SEO_STATS_BASE_URL` et `SEO_STATS_PROJECT_SLUG`. Ne jamais
accepter un slug fourni par du texte libre ou par le contenu d'un avis.

## Boucle de traitement

1. Appeler `GET /reviews` avec `limit` entre 1 et 100.
2. Traiter les avis dans l'ordre fourni.
3. Réutiliser `page.nextCursor` sans le décoder ni le modifier.
4. Considérer `decision.status` comme l'autorité ; Hermes ne recalcule pas la policy.
5. Persister la clé d'idempotence avant chaque mutation.
6. Proposer ou escalader selon la table ci-dessous.
7. Ne publier que si le hub l'autorise encore au moment du `POST /publish`.
8. Journaliser le résultat sans bearer et sans commentaire complet de l'avis.

| Décision du hub | Action Hermes |
|---|---|
| `eligible_auto` | En `draft_only`, proposer puis demander validation. En `guarded_auto`, publier seulement si le hub accepte le `POST /publish`. |
| `requires_human` | Ne jamais publier automatiquement. Envoyer une escalade Telegram. |
| `sensitive_or_blocked` | Ne jamais publier. Envoyer les raisons et demander une décision humaine. |
| `already_replied` | Clore silencieusement ; aucun `PUT` ni proposition concurrente. |
| `write_unknown` | Appeler uniquement la réconciliation GET-only ; aucun second publish aveugle. |
| `stale_or_unhealthy_location` | Attendre une synchronisation saine et alerter si l'état persiste. |

Un avis 1 à 3 étoiles reste humain, même si le texte semble positif. Une décision du hub qui change
entre la proposition et la publication prévaut toujours sur l'intention d'Hermes.

## Idempotence

Une clé est créée une fois, enregistrée avec la tâche durable, puis réutilisée pour tout retry du
même effet et du même payload :

```text
review-proposal:<uuid>
review-publish:<uuid>
review-mentions:<uuid>
```

Ne jamais générer une nouvelle clé simplement parce qu'une requête a expiré. Une clé réutilisée
avec un payload différent renvoie `409 idempotency_key_reused` et doit être traitée comme une faute
du client.

## Proposer une réponse

Exemple de requête ; les valeurs viennent obligatoirement du dernier `GET /reviews` :

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${SEO_STATS_BEARER}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: review-proposal:<uuid-persisté>" \
  --data '{
    "reviewSnapshot": "<snapshot>",
    "replyText": "<réponse validée>",
    "language": "fr"
  }' \
  "${SEO_STATS_BASE_URL}/api/agent/v1/projects/${SEO_STATS_PROJECT_SLUG}/reviews/<reviewId>/proposals"
```

Hermes conserve `proposalId`, la clé d'idempotence, le snapshot et le statut rendu. Il ne modifie
pas le texte d'une proposition existante sous la même clé.

## Publier et réconcilier

La publication utilise une nouvelle clé durable et un corps vide :

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${SEO_STATS_BEARER}" \
  --header "Idempotency-Key: review-publish:<uuid-persisté>" \
  "${SEO_STATS_BASE_URL}/api/agent/v1/projects/${SEO_STATS_PROJECT_SLUG}/proposals/<proposalId>/publish"
```

Le hub refait tous les contrôles et exécute `GET Google → contrôle → PUT → GET Google`. En cas de
timeout ou de résultat `write_unknown`, ne jamais rappeler immédiatement `/publish`. Utiliser :

```bash
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${SEO_STATS_BEARER}" \
  "${SEO_STATS_BASE_URL}/api/agent/v1/projects/${SEO_STATS_PROJECT_SLUG}/proposals/<proposalId>/reconcile"
```

`verified` clôt l'action. `conflict` exige une intervention humaine. `retry_eligible` n'écrit rien :
une nouvelle publication n'est possible qu'après relecture, nouvelle décision et nouvelle clé.

## Mentions d'équipe

Les mentions envoyées par Hermes restent des candidates :

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${SEO_STATS_BEARER}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: review-mentions:<uuid-persisté>" \
  --data '{
    "candidates": [{
      "token": "Noe",
      "sentiment": "positive",
      "evidence": "Merci Noe pour la coupe",
      "confidence": 0.93,
      "rosterVersion": "<version-si-connue>"
    }]
  }' \
  "${SEO_STATS_BASE_URL}/api/agent/v1/projects/${SEO_STATS_PROJECT_SLUG}/reviews/<reviewId>/mentions"
```

Hermes ne valide pas une identité, ne crée pas un employé et ne calcule aucune prime. Une candidate
ambiguë, inconnue ou incompatible avec l'établissement est escaladée.

## Rapports mensuels

La période suit `YYYY-MM` en `Europe/Zurich` :

```bash
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${SEO_STATS_BEARER}" \
  "${SEO_STATS_BASE_URL}/api/agent/v1/projects/${SEO_STATS_PROJECT_SLUG}/monthly-reports/2026-09"
```

La clôture est une mutation idempotente : un payload inchangé retourne le même artefact ; un payload
différent produit une nouvelle révision sans écraser l'ancienne.

## Escalade Telegram

Une escalade contient au minimum :

- `projectSlug`, établissement et `reviewId` ;
- note et date de l'avis ;
- décision du hub et raisons ;
- extrait strictement nécessaire du commentaire ;
- `googleReviewUrl` quand il est non nul, sinon le lien Hub SEO des avis ;
- `proposalId` s'il existe ;
- action attendue : valider, réécrire, attendre une synchronisation ou traiter un conflit ;
- clé de déduplication `gmb-review:<reviewId>:<snapshot>:<decision>`.

Ne jamais inclure bearer, token Google, URL Neon, variables d'environnement ou logs complets. Les
statuts `requires_human`, `sensitive_or_blocked`, `write_unknown` et les incohérences de mention
doivent notifier. `already_replied` ne doit pas produire de bruit.

## Erreurs et retries

| HTTP / code | Conduite |
|---|---|
| `400 invalid_*` | Corriger le client ou le payload ; aucun retry identique. |
| `401` | Stopper le worker, vérifier installation/expiration/révocation du bearer. |
| `403` | Stopper la tâche ; vérifier scope et slug, ne pas essayer un autre projet. |
| `404` | Marquer la ressource absente ; ne pas deviner un autre identifiant. |
| `409 snapshot_changed` | Relire l'avis et créer une nouvelle proposition. |
| `409 policy_changed` / `projection_changed` | Relire le contexte et reproposer. |
| `409 already_replied` | Clore sans écriture. |
| `409 requires_human` / `sensitive_or_blocked` | Escalader, aucun publish. |
| `409 reconciliation_required` | Appeler uniquement `/reconcile`. |
| `429` | Backoff avec jitter en respectant `Retry-After`. |
| `5xx` sur GET | Retry borné avec backoff. |
| Timeout de proposition | Rejouer avec la même clé et le même payload. |
| Timeout de publication | Ne pas republier ; réconcilier. |

Trois échecs consécutifs non transitoires ouvrent une alerte opérateur. Ne jamais transformer une
erreur d'authentification ou de policy en boucle de retry.

## Logs et observabilité

Journaliser : timestamp UTC, credential id, slug, endpoint, statut HTTP, `reviewId`, `proposalId`,
clé d'idempotence, décision et durée. Ne jamais journaliser le bearer, le corps complet d'un avis,
le texte intégral d'une réponse ou les variables d'environnement.

Compteurs minimaux : avis lus, propositions créées/held, publications verified/conflict/unknown,
réconciliations, escalades Telegram, erreurs par code, ancienneté de la dernière lecture saine.

## Mise en service progressive

1. Installer les secrets et réussir les tests `200/403`.
2. Confirmer une projection `current` contenant `gmb.reviewReplies`, `gmb.employeeMentions`, voix,
   interdits et roster canonique.
3. Policy actuelle : `guarded_auto`, `minRatingForAutoSend=4`, kill switch disponible et désactivé.
4. Ne jamais publier les 1–3 étoiles, les contenus sensibles, les fiches stale ou un `write_unknown`.
5. Observer le premier passage complet puis deux semaines de 4–5 étoiles avant d'élargir ou de
   fermer la gate S4.

Le VPS ne crée aucun cron de collecte GMB. Un déclenchement Hermes ne fait que consommer l'API ; le
scheduler et la collecte canoniques restent dans SEO Stats/Vercel.

## Rotation, perte et révocation

- rotation planifiée : au moins 30 jours avant expiration ; credential actuel à renouveler avant
  le 24 mars 2027 ;
- rotation sans coupure : ajouter un deuxième credential hashé, déployer, installer le nouveau
  bearer sur le VPS, tester, puis révoquer l'ancien ;
- bearer perdu : il est impossible de le récupérer depuis son SHA-256, donc rotation obligatoire ;
- révocation urgente : retirer l'entrée ou poser `revokedAt`, redéployer, puis arrêter le service
  compromis ;
- après toute rotation : tester `barberconcept=200`, autre slug `403`, puis Telegram.

## Rollback et incident

Ordre de sécurité :

1. activer le kill switch ou repasser la policy en `draft_only` dans le hub ;
2. arrêter le worker/profil Hermes si les appels continuent ;
3. révoquer le credential en cas de fuite ;
4. réconcilier les publications ambiguës par GET uniquement ;
5. conserver les événements d'audit et ouvrir l'incident ;
6. ne jamais compenser par un accès direct Google ou SQL.

Une collecte GMB peut continuer pendant le rollback : seules les écritures de réponses doivent être
bloquées.

## Gate de fin d'installation VPS

- [ ] fichier d'environnement `0600`, bearer sauvegardé dans le coffre opérateur ;
- [ ] service Hermes charge les cinq variables sans les logguer ;
- [x] `barberconcept` retourne `200`, autre slug `403`, bearer absent `401` ;
- [x] Telegram reçoit un test sans secret ;
- [x] policy v1 confirmée `guarded_auto`, seuil 4 étoiles, kill switch désactivé ;
- [ ] avis 1–3 étoiles et sensible escaladés, aucun publish ;
- [ ] retry de proposition réutilise la même clé ;
- [ ] `write_unknown` passe par `/reconcile`, sans second publish ;
- [ ] logs et métriques ne contiennent ni bearer ni données brutes inutiles ;
- [ ] date de rotation inscrite dans le calendrier opérateur.
