# GMB-011 — Résumé lecture rapide des avis pour Hermes (`GET /review-status`)

**Statut :** IN_REVIEW (2026-10-05) — code et tests verts, non déployé.
**Contrat :** `docs/agent-api-gmb-barberconcept.md` § « Resume lecture rapide (GMB-011) ».

## Objectif

Hermes (Telegram) répondait aux questions récurrentes (« combien d'avis aujourd'hui ? », « un
salon en panne ? », « des confirmations en attente ? ») en paginant `GET /reviews` : textes,
réponses, décisions avis par avis. Un seul GET agrégé, sans PII, suffit à ces questions.

## Décisions

- ⭐ **Le résumé compte, il ne décide pas.** Les statuts sont produits par `decideReview`
  (factorisé de `listAgentReviews`) : même `classifyAgentReview`, même `applyProjectionGate`,
  même `effectivePolicy`. Un compteur ne peut donc jamais contredire `GET /reviews`, et les six
  statuts **partitionnent** le total de chaque fenêtre (vérifié en test et sur la prod).
- ⭐ **Zéro DDL, zéro écriture, zéro appel Google** : quatre lectures en parallèle. Le test service
  fait échouer tout `insert`/`update`/`delete` ; le test statique interdit à la route tout
  import Google, toute clé d'idempotence et toute méthode autre que `GET`.
- ⚠️ **`lastSuccessfulSyncAt` est `null` pour une fiche en erreur** : le collecteur écrit
  `last_sync_at` aussi en échec, et aucune colonne ne garde le dernier succès. On n'invente pas
  la date ; `lastSyncAt` brut est exposé à côté.
- Fraîcheur jamais saine par défaut : `unknown` (jamais synchronisée), `degraded` (erreur),
  `stale` (> 48 h, le seuil de `classifyAgentReview`). `overallStatus` = le pire.
- Fenêtres `last24Hours` / `last7Days` glissantes **et** `today` (jour civil `Europe/Zurich`, via
  `europeZurichDayWindow`) : « aujourd'hui » au sens d'un salon n'est pas « les dernières 24 h ».
- `pendingConfirmations` = dernière proposition en `write_unknown` ou `retry_eligible`, **quel
  que soit l'âge de l'avis** — sinon une ambiguïté sur un vieil avis disparaîtrait de la vue.
- ETag fort sur le contenu, hors `generatedAt` et bornes glissantes (sinon jamais de 304).
  `Cache-Control: private, max-age=30`.

## Premier run réel (2026-10-05, prod, lecture seule)

47 avis sur 7 j (46×5★, 1×2★), tous `already_replied` ; 6 salons `healthy` (sync 05:00 UTC).
⚠️ **3 `write_unknown` en attente sur Jonction**, nées le 2026-09-30 sur des avis de 2016-2017
dont Google montre une réponse : elles attendent un `GET /reconcile`. Elles étaient invisibles
dans toute fenêtre récente — c'est la raison du « quel que soit l'âge ».

Latence (service seul contre Neon, `scripts/review-status-preview.ts`) : médiane ~150 ms,
~3 s au premier appel (connexion à froid).

## Carte du code

| Fichier | Rôle |
|---|---|
| `src/lib/server/reviews/agent-review-status-state.ts` | Module pur : fenêtres, agrégation, fraîcheur, policy, ETag |
| `src/lib/server/reviews/agent-review-service.ts` | `buildAgentReviewStatus` + `loadDecisionContext` / `decideReview` partagés avec `listAgentReviews` |
| `src/lib/server/reviews/agent-review-state.ts` | `europeZurichDayWindow`, `parseTimestamp` exporté |
| `src/routes/api/agent/v1/projects/[slug]/review-status/+server.ts` | Route GET, `review:read`, ETag / 304 |
| `src/lib/server/reviews/agent-review-status-state.test.ts` · `agent-review-status.test.ts` · `agent-review-routes.spec.ts` | Tests |
| `scripts/review-status-preview.ts` | Aperçu + latence, lecture seule |

## Reste

1. Commit + déploiement.
2. Vérif prod : 200 + ETag, `If-None-Match` → 304, sans bearer → 401, autre slug → 403.
3. Côté Hermes (hors repo) : voie Telegram « questions rapides Reviews » qui appelle ce GET en premier.
