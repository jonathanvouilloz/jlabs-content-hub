# API agent GMB Barber Concept - v1

> Etat au 24 septembre 2026 : implemente et teste localement sur `feat/s0-stabilisation`.
> Cette API n'est pas operationnelle sur le VPS tant que les migrations DATA-009/DATA-010,
> le deploiement Vercel et le credential machine `barberconcept` ne sont pas en place.

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
| `review:read` | liste et etat des avis |
| `review:propose` | proposition de reponse, mentions candidates, cloture mensuelle |
| `review:publish` | publication bornee et reconciliation GET-only |
| `review:report:read` | lecture du recap mensuel |

Un scope absent ou un slug hors allowlist renvoie `403`. Un bearer absent, inconnu, expire, pas
encore actif ou revoque renvoie `401`. Les routes n'acceptent ni token admin ni token client.

Exemple de configuration cote hub, sans secret en clair :

```json
[
  {
    "id": "hermes-barberconcept-2026-09",
    "tokenHash": "<sha256-hex-du-secret>",
    "scopes": ["review:read", "review:propose", "review:publish", "review:report:read"],
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
PUT ne declenche jamais un second PUT. Le hub relit une fois Google : s'il ne peut pas confirmer le
texte exact, l'etat reste `write_unknown`.

Etats de resultat : `verified`, `conflict`, `write_unknown`. Un double appel avec la meme cle de
publication reutilise la reservation et ne refait pas l'ecriture.

## Reconciliation GET-only

### `GET /proposals/{proposalId}/reconcile`

Scope : `review:publish`.

Cette action peut ajouter un evenement d'audit local, mais n'appelle que le GET Google :

- texte distant identique : `verified` ;
- texte distant different ou avis absent : `conflict` ;
- toujours aucune reponse : `retry_eligible`.

`retry_eligible` n'envoie rien. Une nouvelle tentative exige un appel de publication explicite
avec une nouvelle cle d'idempotence, apres une nouvelle relecture/policy check.

## Mentions equipe

### `POST /reviews/{reviewId}/mentions`

Scope : `review:propose`. Header `Idempotency-Key` obligatoire.

```json
{
  "candidates": [
    {
      "token": "Noe",
      "sentiment": "positive",
      "evidence": "Merci Noe pour la coupe",
      "confidence": 0.93,
      "rosterVersion": "<version-optionnelle>"
    }
  ]
}
```

Bornes : 1 a 20 candidats, token 80 caracteres, preuve 240 caracteres, confiance entre 0 et 1.
Chaque ligne est creee en statut `candidate`. L'API ne valide pas une identite, ne cree pas un
employe, ne calcule pas de prime et n'expose aucun montant. Les mentions validees du recap sont
derivees de la source canonique par avis ; les candidates restent separees jusqu'a resolution.

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

## Activation conseillee

1. appliquer DATA-009 puis DATA-010 sur staging et verifier les tables/index ;
2. compiler/promouvoir une projection Barber Concept `current` avec contexte, voix, interdits et roster ;
3. creer une policy d'abord `draft_only`, lancer une semaine de dry-run ;
4. creer le credential borne et verifier 401/403/cross-project ;
5. deployer le hub, configurer les deux variables non Google sur le VPS ;
6. verifier l'escalade Telegram des 1-3 etoiles et contenus sensibles ;
7. promouvoir `guarded_auto`, `minRatingForAutoSend=4`, kill switch OFF ;
8. observer deux semaines de 4-5 etoiles avant de considerer la gate S4 fermee.

Rollback : activer le kill switch ou repasser la policy en `draft_only`. La synchronisation des
avis continue ; seules les ecritures sont bloquees.
