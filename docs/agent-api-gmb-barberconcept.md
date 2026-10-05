# API agent GMB Barber Concept - v1

> Etat au 24 septembre 2026 : déployé en production depuis `main` (feature `e26fdb8`) sur
> `https://hubseo.jonlabs.ch`. DATA-009/DATA-010 sont déclarées appliquées par l'opérateur et le
> credential `barberconcept` a été vérifié en production (`200` autorisé, `403` hors projet).
> Le profil VPS, ses crons, Telegram et sa baseline sont installés. La projection canonique est
> `current`. DATA-011 et le code `googleReviewUrl` sont en production. La policy v1 est `current` en
> mode `guarded_auto`, seuil 4 étoiles, kill switch désactivé. Runbook :
> [`HERMES-VPS-RUNBOOK.md`](HERMES-VPS-RUNBOOK.md).

## Frontiere de securite

SEO Stats reste l'autorite sur Google Business Profile, Neon, les snapshots, la policy,
l'idempotence et l'audit. Hermes ne recoit jamais `DATABASE_URL`, les tokens OAuth Google,
`GOOGLE_CLIENT_SECRET` ou `ENCRYPTION_KEY`.

Toutes les routes sont sous :

```text
/api/agent/v1/projects/{slug}/...
```

Le bearer doit declarer explicitement `projects: ["barberconcept"]`. Une ressource appartenant
a un autre projet est introuvable pour ce credential, meme si Hermes connait son `reviewId` ou
son `proposalId`.

## Authentification et scopes

```http
Authorization: Bearer <credential-id>.<secret>
```

Le hub ne stocke que `sha256(secret)` dans `HERMES_MACHINE_CREDENTIALS_JSON`. Le secret brut vit
uniquement dans le profil Hermes. Le credential peut porter `notBefore`, `expiresAt` et `revokedAt`.

Scopes initiaux :

| Scope | Routes |
|---|---|
| `review:read` | liste et etat des avis, roster courant, mentions par statut |
| `review:propose` | proposition de reponse, mentions jugees, cloture mensuelle |
| `review:publish` | publication bornee et reconciliation GET-only |
| `review:report:read` | lecture du recap mensuel |
| `review:mention:resolve` | decision humaine sur une mention en attente (GMB-010) |
| `roster:write` | modification du roster d'equipe (GMB-010) |

Un scope absent ou un slug hors allowlist renvoie `403`. Un bearer absent, inconnu, expire, pas
encore actif ou revoque renvoie `401`. Les routes n'acceptent ni token admin ni token client.

Exemple de configuration cote hub, sans secret en clair :

```json
[
  {
    "id": "hermes-barberconcept-2026-09",
    "tokenHash": "<sha256-hex-du-secret>",
    "scopes": ["review:read", "review:propose", "review:publish", "review:report:read", "review:mention:resolve", "roster:write"],
    "projects": ["barberconcept"],
    "notBefore": "<ISO-8601>",
    "expiresAt": "<ISO-8601>"
  }
]
```

## Pagination et fraicheur

### `GET /reviews`

```http
GET /api/agent/v1/projects/barberconcept/reviews?limit=50&cursor=<opaque>
```

- `limit` : 1 a 100, defaut 50.
- `cursor` : opaque, stable sur `(googleCreatedAt, reviewId)`, ordre descendant.
- ne jamais construire ou modifier un curseur cote Hermes ; reutiliser `page.nextCursor`.
- `freshness.maxLocationAgeHours` vaut 48.

Chaque avis expose seulement les donnees operationnelles :

```json
{
  "reviewId": "<stable-id>",
  "snapshot": "<sha256>",
  "googleReviewUrl": "<URL officielle Google pour ouvrir/repondre a l'avis, ou null>",
  "location": { "id": "<google-location-id>", "label": "Barber Concept Rive" },
  "rating": 5,
  "googleCreatedAt": "<ISO-8601>",
  "text": "<texte avis>",
  "remoteReply": null,
  "state": {
    "local": "none",
    "distant": "unreplied",
    "lastSeenAt": "<UTC DB timestamp>",
    "locationLastSyncAt": "<UTC DB timestamp>",
    "locationLastSyncStatus": "success"
  },
  "decision": {
    "status": "eligible_auto",
    "autoPublishable": true,
    "reasons": ["positive_simple"]
  }
}
```

`googleReviewUrl` vient directement du champ output-only `Review.reviewReplyUrl` de Google
Business Profile. Hermes ne doit jamais reconstruire ce lien. Apres le deploiement DATA-011,
les lignes historiques restent `null` jusqu'a leur prochain `collect:gmb_reviews`.

Etats de decision :

| Etat | Sens |
|---|---|
| `eligible_auto` | 4-5 etoiles, non sensible, fiche fraiche et policy active |
| `requires_human` | 1-3 etoiles ; jamais de publication automatique |
| `sensitive_or_blocked` | contenu sensible ou policy/contexte/kill switch bloquant |
| `already_replied` | une reponse distante existe ; aucun PUT autorise |
| `write_unknown` | resultat d'ecriture ambigu ; reconciliation obligatoire |
| `stale_or_unhealthy_location` | fiche jamais synchronisee, en erreur ou agee de plus de 48 h |

La colonne historique `replied_at` n'est jamais utilisee seule comme preuve. Seule une relecture
Google et `remoteReply` peuvent etablir l'etat distant.

## Resume lecture rapide (GMB-011)

### `GET /review-status`

```http
GET /api/agent/v1/projects/barberconcept/review-status
If-None-Match: "<etag precedent>"   (optionnel)
```

Scope : `review:read`. Sans bearer : 401 · slug hors credential : 403 · projet archive : 404.

Repond en un seul GET aux questions Telegram recurrentes (nouveaux avis, volume du jour / de la
semaine, salons en panne, confirmations en attente, policy). **Lecture seule et jamais une
autorite** : aucune ecriture, aucun appel Google, aucune decision. Toute proposition, publication,
reconciliation ou modification de roster **ignore ce resume** et relit `GET /reviews` puis
`decision.status` au moment du geste.

Garanties :

- les compteurs de statut sont **exactement** les `decision.status` de `GET /reviews` (meme
  classification, meme porte de projection, meme policy effective), et ils **partitionnent**
  `reviews` dans chaque fenetre ;
- aucun texte d'avis, nom de client, `reviewId`, URL Google ni texte de reponse ;
- une fiche jamais synchronisee est `unknown`, en erreur `degraded`, agee de plus de 48 h `stale` :
  jamais `healthy` par defaut. `overallStatus` = le pire (`degraded` > `stale` > `unknown` > `healthy`).
- `lastSuccessfulSyncAt` n'est renseigne que si le dernier sync a reussi : le collecteur ecrit
  `last_sync_at` aussi en echec, et aucune colonne ne garde le dernier succes d'une fiche en panne.

Fenetres, toutes `[fromInclusive, toExclusive[` en ISO-8601 UTC et renvoyees dans `windows` :

| Fenetre | Bornes |
|---|---|
| `last24Hours` | glissante, `now − 24 h` → `now` |
| `last7Days` | glissante, `now − 7 j` → `now` |
| `today` | jour civil `Europe/Zurich` (minuit local → minuit suivant, DST compris) |

Les compteurs « ouverts » par salon (`requiresHumanOpen`, `sensitiveOpen`) portent sur les avis
crees dans les `openLookbackDays` (180) derniers jours, la fenetre SLA du detecteur d'avis.
`pendingConfirmations` = propositions dont la derniere est `write_unknown` ou `retry_eligible`,
**quel que soit l'age de l'avis** : elles se lisent ici et se concluent par `GET /reconcile`,
jamais par un second publish.

```json
{
  "ok": true,
  "data": {
    "schemaVersion": "1",
    "generatedAt": "2026-10-05T16:05:12.000Z",
    "project": "barberconcept",
    "freshness": {
      "overallStatus": "healthy",
      "maxLocationAgeHours": 48,
      "lastSuccessfulCollectionAt": "2026-10-05T05:00:19.000Z",
      "oldestLocationSyncAt": "2026-10-05T05:00:19.000Z"
    },
    "windows": {
      "last24Hours": { "fromInclusive": "2026-10-04T16:05:12.000Z", "toExclusive": "2026-10-05T16:05:12.000Z" },
      "last7Days": { "fromInclusive": "2026-09-28T16:05:12.000Z", "toExclusive": "2026-10-05T16:05:12.000Z" },
      "today": { "fromInclusive": "2026-10-04T22:00:00.000Z", "toExclusive": "2026-10-05T22:00:00.000Z", "timezone": "Europe/Zurich" }
    },
    "openLookbackDays": 180,
    "periods": {
      "last24Hours": { "reviews": 0, "ratings": { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 }, "eligibleAuto": 0, "requiresHuman": 0, "sensitiveOrBlocked": 0, "alreadyReplied": 0, "writeUnknown": 0, "staleOrUnhealthyLocation": 0, "verifiedReplies": 0, "pendingConfirmations": 0 },
      "last7Days": { "reviews": 47, "ratings": { "1": 0, "2": 1, "3": 0, "4": 0, "5": 46 }, "eligibleAuto": 0, "requiresHuman": 0, "sensitiveOrBlocked": 0, "alreadyReplied": 47, "writeUnknown": 0, "staleOrUnhealthyLocation": 0, "verifiedReplies": 37, "pendingConfirmations": 0 },
      "today": { "reviews": 0, "ratings": { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 }, "eligibleAuto": 0, "requiresHuman": 0, "sensitiveOrBlocked": 0, "alreadyReplied": 0, "writeUnknown": 0, "staleOrUnhealthyLocation": 0, "verifiedReplies": 0, "pendingConfirmations": 0 }
    },
    "pendingConfirmationsTotal": 3,
    "locations": [
      {
        "locationId": "locations/12743724963296165280",
        "label": "Barber Concept Jonction Genève",
        "freshnessStatus": "healthy",
        "lastSyncAt": "2026-10-05T05:00:19.000Z",
        "lastSuccessfulSyncAt": "2026-10-05T05:00:19.000Z",
        "autoPublishingEnabled": true,
        "reviewsLast24Hours": 0,
        "reviewsLast7Days": 4,
        "requiresHumanOpen": 0,
        "sensitiveOpen": 0,
        "pendingConfirmations": 3
      }
    ],
    "policy": { "status": "active", "mode": "guarded_auto", "autoPublishingEnabled": true, "minimumAutoRating": 4 }
  }
}
```

`locations` est trie par `label` puis `locationId` (ordre stable). `policy` resume la policy
projet (`*`) ; `status` vaut `unknown` sans policy courante, `disabled` si le mode n'est pas
`guarded_auto`, la generation coupee ou le kill switch actif. `autoPublishingEnabled` par salon
tient compte d'une policy locale et du kill switch global.

Cache :

- `Cache-Control: private, max-age=30` — aucun cache partage.
- `ETag` fort, calcule sur le **contenu** (compteurs, fraicheur, policy), hors `generatedAt` et
  bornes des fenetres glissantes ; `If-None-Match` egal → `304` sans corps.
- Hermes peut garder une reponse au plus 30 s pour une question de lecture. Une mutation ne lit
  jamais ce cache.

Latence mesuree le 2026-10-05 contre Neon prod (`npx tsx scripts/review-status-preview.ts`,
service seul, hors reseau Vercel) : mediane ~150 ms, ~3 s a froid (connexion).

## Proposer une reponse

### `POST /reviews/{reviewId}/proposals`

Scope : `review:propose`.

```http
Idempotency-Key: review-proposal:<uuid>
Content-Type: application/json
```

```json
{
  "reviewSnapshot": "<snapshot renvoye par GET /reviews>",
  "replyText": "Merci beaucoup pour votre retour !",
  "language": "fr"
}
```

Le hub recalcule le snapshot, recharge la projection `current`, la policy versionnee et la sante
de la fiche. La proposition est persistee avant toute ecriture Google. Un cas non publiable est
conserve en `held`; Hermes peut donc tracer sa proposition sans pouvoir contourner la policy.

Rejouer la meme cle avec le meme contenu renvoie le meme `proposalId`. Reutiliser la cle avec un
autre contenu renvoie `409 idempotency_key_reused`.

## Publier

### `POST /proposals/{proposalId}/publish`

Scope : `review:publish`.

```http
Idempotency-Key: review-publish:<uuid>
```

Le corps est vide. Le hub revalide :

- slug et appartenance de la proposition ;
- snapshot local de l'avis ;
- projection courante et son hash ;
- policy courante, version, hash et kill switch ;
- note 4-5 uniquement ;
- absence de contenu sensible ;
- fraicheur de la fiche ;
- absence de reponse distante.

Sequence obligatoire :

```text
reservation idempotente -> GET Google -> controle snapshot/reponse -> PUT -> GET Google -> audit
```

Un avis 1-3 etoiles, sensible, stale, modifie ou deja repondu ne produit aucun PUT. Un timeout du
PUT ne declenche jamais un second PUT. Google peut accepter le PUT et ne montrer la reponse que plus
tard (mesure le 2026-09-28) : le hub relit donc Google a 0, 2, 4 et 8 s. S'il ne peut toujours pas
confirmer le texte exact, l'etat reste `write_unknown`. L'heure renvoyee par Google dans le corps du PUT
est journalisee (`putReplyAt`) comme preuve d'acceptation.

Etats de resultat : `verified`, `conflict`, `write_unknown`. Un double appel avec la meme cle de
publication reutilise la reservation et ne refait pas l'ecriture.

### Contrat de resultat commun (publish et reconcile)

Depuis le 2026-09-29, `publish` et `reconcile` repondent avec **la meme forme**. Le champ canonique est
`state`, toujours dans `data`, pour tous les etats :

```json
{ "ok": true, "data": { "state": "write_unknown", "reason": "awaiting_remote_propagation",
  "retryAfterSeconds": 840, "idempotent": false } }
```

| `data.state` | Champs optionnels | Geste suivant |
|---|---|---|
| `verified` | — | aucun, la reponse est en ligne |
| `conflict` | `reason` (`remote_reply_differs`, `review_missing`, `snapshot_changed`) | humain |
| `write_unknown` | `error` (publish), `reason` + `retryAfterSeconds` (reconcile) | **GET `/reconcile` uniquement** |
| `retry_eligible` | — (reconcile seulement) | voir plus bas |

Il n'y a ni `status` ni `resultStatus`. `publish` garde aussi `data.result` (`{ state, reason?, error? }`),
alias **deprecie** de l'ancienne forme, conserve pour les clients deja deployes. Avant cette date,
publish ne portait l'etat que sous `data.result.state` : le worker Hermes le lisait `unknown`
(incident `de76afbef07f442e1b074a82`).

## Reconciliation GET-only

### `GET /proposals/{proposalId}/reconcile`

Scope : `review:publish`.

Cette action peut ajouter un evenement d'audit local, mais n'appelle que le GET Google :

- texte distant identique (traduction Google annexee toleree) : `verified` ;
- texte distant different ou avis absent : `conflict` ;
- aucune reponse, PUT accepte il y a moins de 15 min : `200 {state: "write_unknown",
  reason: "awaiting_remote_propagation", retryAfterSeconds}` — rien n'est ecrit, relancer
  `reconcile` apres `retryAfterSeconds` ;
- aucune reponse, sans PUT accepte ou apres 15 min : `retry_eligible`.

Un PUT parti sans reponse exploitable (timeout, 5xx) compte comme un PUT **peut-etre** accepte : son
evenement `write_unknown` porte `putAttempted: true`, et la fenetre de 15 min s'applique aussi a lui.
Sinon, un timeout suivi d'une relecture vide rendrait `retry_eligible` sur une reponse deja en ligne.

Depuis le 2026-09-28, `reconcile` accepte aussi une proposition deja en `retry_eligible` : une reponse
arrivee tard se conclut `verified` en lecture seule, sans second publish. Si elle est toujours absente,
la reponse est `{state: "retry_eligible", idempotent: true}` et rien n'est ecrit.

`retry_eligible` n'envoie rien. Une nouvelle tentative exige un appel de publication explicite
avec une nouvelle cle d'idempotence, apres une nouvelle relecture/policy check.

## Mentions equipe (GMB-010)

Principe : **l'agent juge, le hub decide, l'humain tranche le doute.** L'agent rattache chaque
prenom cite a un membre du roster au moment ou il redige la reponse. Le hub ne valide d'office que
le match **exact** (casse, accents, ponctuation pres) a un nom ou un alias d'un membre actif **du
salon de l'avis**. Tout le reste attend une decision humaine. La reponse a l'avis, elle, n'attend
jamais : seule la mention douteuse est mise a jour apres coup.

### `GET /roster`

Scope : `review:read`. Roster courant de la projection `current`.

```json
{
  "version": "2026-10-01.1",
  "extraction": "agent",
  "locations": [{ "id": "locations/4735391311439608561", "label": "Lausanne" }],
  "employees": [{
    "id": "giuseppe", "displayName": "Giuseppe", "aliases": ["Guiseppe"],
    "locations": ["locations/4735391311439608561"],
    "active": true, "publicReplyAllowed": true, "trackMentions": true
  }]
}
```

`extraction: "agent"` = l'agent est la seule source d'extraction ; le detecteur LLM du hub
(`detect:employee_mentions`) se met en retrait (`skippedReason: employee_mentions_delegated`).
Aucun champ de prime n'est expose.

### `POST /reviews/{reviewId}/mentions`

Scope : `review:propose`. Header `Idempotency-Key` obligatoire.

```json
{
  "candidates": [
    {
      "token": "Guiseppe",
      "sentiment": "positive",
      "evidence": "Merci Guiseppe pour la coupe",
      "confidence": 0.9,
      "employeeId": "giuseppe",
      "matchKind": "variant",
      "rosterVersion": "2026-10-01.1"
    }
  ]
}
```

Bornes : 0 a 20 candidats, token 80 caracteres, preuve 240 caracteres, confiance entre 0 et 1,
`employeeId` (optionnel) = l'id du roster que l'agent vise, `matchKind` (optionnel, information) :
`exact | alias | variant | unknown | ambiguous`. **`candidates: []` est valide** : avis analyse,
personne de cite (l'avis est marque traite).

Le hub juge chaque ligne a la reception et rend son verdict dans la reponse :

| `status` | `reason` | Sens | Geste de l'agent |
|---|---|---|---|
| `validated` | — | match exact au salon ; ajoute a `mentioned_employees` | rien |
| `resolved` | `not_tracked` | membre reconnu mais non suivi (ex. cofondateur) | rien |
| `candidate` | `unknown_token` | orthographe absente du roster | demander a Jon |
| `candidate` | `wrong_location` | prenom du roster, mais d'un autre salon | demander a Jon |
| `candidate` | `suggestion_conflict` | match exact, mais l'agent vise quelqu'un d'autre | demander a Jon |
| `candidate` | `ambiguous` / `inactive` / `roster_unavailable` | indecidable | demander a Jon |

Chaque ligne porte `id`, `employeeId`/`displayName` (si valide), `suggestedEmployeeId` (la
suggestion de l'agent, ou le seul membre plausible). Le meme couple (avis, token normalise) deja
recu renvoie la ligne existante avec `idempotent: true`, quelle que soit la cle.

### `GET /mention-candidates?status=candidate&limit=100`

Scope : `review:read`. Mentions par statut (`candidate` par defaut, `validated`, `rejected`,
`resolved`), dans l'ordre de reception, 200 au plus.

### `POST /mention-candidates/{candidateId}/resolve`

Scope : `review:mention:resolve`. Header `Idempotency-Key` obligatoire.

```json
{ "decision": "validate", "employeeId": "giuseppe", "rememberAlias": true, "note": "Jon, Telegram" }
```

- `validate` : `employeeId` optionnel (defaut : `suggestedEmployeeId`). La mention passe
  `validated` et rejoint `mentioned_employees` (ou `resolved` si le membre est non suivi).
- `rememberAlias: true` : l'orthographe du token devient un alias du membre → nouvelle version du
  roster, et **toutes** les candidates en attente sont re-jugees (les autres « Guiseppe » passent
  `validated` d'elles-memes). Un echec de l'alias n'annule pas la decision (`alias.error`).
- `reject` : la mention passe `rejected`, rien n'est attribue.

Une decision posee ne se reecrit pas : rejouer la meme cle renvoie le meme resultat, une autre
cle renvoie `409 candidate_already_resolved`.

### `POST /roster/changes`

Scope : `roster:write`. Header `Idempotency-Key` obligatoire.

```json
{
  "baseVersion": "2026-10-01.1",
  "reason": "Mohammed a quitte Jonction (Jon, Telegram)",
  "changes": [{ "op": "deactivate", "employeeId": "mohammed" }]
}
```

Operations (1 a 20 par appel, **tout ou rien**) :

| `op` | Champs |
|---|---|
| `add_alias` / `remove_alias` | `employeeId`, `alias` |
| `add_employee` | `employeeId` (`a-z0-9-`), `displayName`, `locations[]`, `aliases?`, `publicReplyAllowed?`, `trackMentions?` |
| `deactivate` / `reactivate` | `employeeId` |
| `set_locations` | `employeeId`, `locations[]` |
| `set_public_reply` | `employeeId`, `allowed` |
| `set_track_mentions` | `employeeId`, `tracked` |
| `set_extraction` | `owner` : `hub` ou `agent` |

Chaque changement effectif promeut une **nouvelle projection hashee** (version `AAAA-MM-JJ.n`,
l'ancienne passe `stale`) puis re-juge les candidates en attente. Reponse : `version`,
`previousVersion`, `changed`, `reassessed`. Un employe ajoute par l'API n'est jamais eligible a une
prime. Erreurs : `409 roster_version_conflict` (relire `GET /roster` puis rejouer avec la nouvelle
`baseVersion`), `409 token_conflict` (l'alias rendrait deux membres d'un meme salon
indiscernables), `employee_not_found`, `employee_exists`, `alias_not_found`, `unknown_location`.

⚠️ Une proposition de reponse redigee sous l'ancien roster est refusee au `/publish`
(`409 projection_changed`) : la relire et la re-proposer. Eviter de modifier le roster pendant le
passage quotidien.

## Recap mensuel Europe/Zurich

### `GET /monthly-reports/{YYYY-MM}`

Scope : `review:report:read`.

Retourne la fenetre exacte Europe/Zurich, le volume et la moyenne, les notes, reponses verifiees,
alertes, mentions validees et candidates non resolues. Les bornes UTC tiennent compte du passage
heure d'hiver/heure d'ete.

### `POST /monthly-reports/{YYYY-MM}/close`

Scope : `review:propose`.

Fige le payload courant. Meme hash : meme artefact. Payload different : nouvelle revision avec
`supersedesId`. Une revision precedente n'est jamais ecrasee.

## Erreurs principales

| HTTP | Code | Action |
|---|---|---|
| 400 | `invalid_*` | corriger payload, curseur ou cle d'idempotence |
| 401 | `Unauthorized` | verifier bearer, dates et revocation |
| 403 | `Forbidden` | verifier scope et allowlist `barberconcept` |
| 404 | `project_not_found`, `review_not_found`, `proposal_not_found` | ne pas deviner un autre slug/id |
| 409 | `snapshot_changed` | relire l'avis et reproposer |
| 409 | `policy_changed`, `projection_changed` | relire/reproposer sous le contexte courant |
| 409 | `already_replied`, `sensitive_or_blocked`, `requires_human` | escalader, aucun retry PUT |
| 409 | `reconciliation_required` | appeler le endpoint GET-only |
| 409 | `idempotency_key_reused` | ne jamais recycler une cle pour un autre effet |

## Variables operateur

Cote SEO Stats / Vercel :

```dotenv
HERMES_MACHINE_CREDENTIALS_JSON=<json-avec-hash-scopes-et-projects>
DATABASE_URL=<secret-neon-existant>
ENCRYPTION_KEY=<secret-existant>
GOOGLE_CLIENT_ID=<secret-existant>
GOOGLE_CLIENT_SECRET=<secret-existant>
```

Cote VPS Hermes, noms a adapter au profil installe :

```dotenv
SEO_STATS_BASE_URL=https://hubseo.jonlabs.ch
SEO_STATS_BEARER=<credential-id.secret>
SEO_STATS_PROJECT_SLUG=barberconcept
TELEGRAM_BOT_TOKEN=<secret-telegram-du-vps>
TELEGRAM_CHAT_ID=<destination-escalades>
```

Ne copier sur le VPS ni `DATABASE_URL`, ni `ENCRYPTION_KEY`, ni token Google. Ne creer aucun cron
de collecte GMB sur le VPS : la collecte canonique reste le job SEO Stats/Vercel existant.

Le credential de production actif au 24 septembre 2026 est
`hermes-barberconcept-2026-09-r2`. Son bearer brut n'est documenté nulle part et doit vivre dans le
coffre opérateur et l'environnement sécurisé du VPS.

## Activation conseillee

1. ~~appliquer DATA-009 puis DATA-010~~ — déclaré fait par l'opérateur ;
2. ~~confirmer/promouvoir une projection Barber Concept `current`~~ — fait et vérifié idempotent ;
3. ~~créer et promouvoir la policy~~ — v1 `guarded_auto`, seuil 4 étoiles, kill switch OFF ;
4. ~~créer le credential borné et vérifier 401/403/cross-project~~ — vérifié en production ;
5. ~~déployer le hub, configurer le VPS et appliquer DATA-011~~ — fait sur `e26fdb8` ;
6. ~~vérifier l'escalade Telegram~~ — routage de test validé ;
7. ~~promouvoir `guarded_auto`, `minRatingForAutoSend=4`, kill switch OFF~~ — fait ;
8. observer deux semaines de 4-5 étoiles avant de considérer la gate S4 fermée.

Rollback : activer le kill switch ou repasser la policy en `draft_only`. La synchronisation des
avis continue ; seules les ecritures sont bloquees.
