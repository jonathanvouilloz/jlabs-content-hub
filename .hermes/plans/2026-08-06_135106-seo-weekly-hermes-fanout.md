# Fan-out SEO hebdomadaire vers Hermes — plan d’implémentation

> **Pour Hermes :** exécuter ce plan par tranches verticales TDD, sans commit, push, migration distante ni déploiement sans autorisation explicite.

**Objectif :** Après publication d’un rapport hebdomadaire, créer un job durable et idempotent par projet exploitable, envoyer un webhook signé à Hermes, matérialiser le snapshot dans le bon dépôt puis lancer une mission bornée produisant un rapport d’exécution.

**Architecture :** Réutiliser la queue Postgres existante de SEO Stats plutôt que créer un second scheduler. Le rapport global reste l’autorité ; un fan-out additif crée des jobs `dispatch:seo_weekly` indépendants, consommés par les workers actuels. Chaque job POSTe un événement minimal signé HMAC V2 au receiver Agent Ops. Celui-ci ne répond 2xx qu’après persistance dans une file disque ; un worker borné à trois matérialise le snapshot et lance Hermes. Les deux étages retryent isolément et ne peuvent bloquer ni la publication globale ni les autres projets.

**Stack :** SvelteKit/TypeScript, Drizzle/Neon, Vitest, queue Postgres existante, Hermes webhook HMAC, Agent Ops/Node.js.

---

## État d’exécution — 2026-08-06

- [x] Contrat pur, fan-out post-publication et révisions.
- [x] HMAC V2 anti-replay et livraison HTTP classifiable.
- [x] Handler dans la queue canonique, retries/dead-letter et feature flag OFF par défaut.
- [x] Receiver Agent Ops avec ACK après persistance, déduplication durable et limite de corps.
- [x] Worker borné à trois, retries/backoff isolés, récupération après crash, snapshot et rapport obligatoires.
- [x] Registre `spinlink` → `spinflow`, chemins Windows/VPS et refus des dossiers sans dépôt Git.
- [x] Tests complets, type-checks, lint, preuve HTTP réelle et compilation des bundles.
- [ ] Déploiement VPS/Vercel et canary réel — volontairement non exécutés sans feu vert.

## Invariants et périmètre

- Aucun cron Vercel par client : l’ajout d’un projet ajoute un run et un job de dispatch.
- Uniquement les projets `ready|degraded` ; `paused|missing|waiting|archived` ne déclenchent rien.
- Idempotence par `(project_id, idempotency_key)` et clé incluant slot + révision + slug.
- Aucune écriture cross-repo depuis Vercel.
- Le payload ne contient ni secret ni dump SEO complet : seulement identifiants et URL du snapshot.
- La fonctionnalité reste OFF tant que `FLAG_AGENT_RUNNER`, URL et secret webhook ne sont pas configurés.
- Une erreur de fan-out est journalisée et observable, sans annuler le rapport déjà publié.
- Push, merge, déploiement, publication externe, canonical/noindex/redirect et suppressions restent soumis à la politique A0–A4.

## Tâche 1 — Contrat pur du fan-out

**Fichiers :**
- Créer `src/lib/server/seo-weekly-dispatch-state.ts`
- Créer `src/lib/server/seo-weekly-dispatch-state.spec.ts`

1. Écrire un test RED : seuls `ready|degraded` avec `runId` produisent un événement.
2. Écrire un test RED : clés et URLs incluent slot, révision et slug ; ordre déterministe.
3. Implémenter le contrat minimal.
4. Vérifier les tests ciblés.

## Tâche 2 — Signature et livraison webhook

**Fichiers :**
- Créer `src/lib/server/hermes-webhook.ts`
- Créer `src/lib/server/hermes-webhook.spec.ts`

1. Test RED pour JSON stable et HMAC V2 `HMAC(secret, timestamp.body)`.
2. Test RED pour anti-replay, réponse non-2xx, timeout et absence de configuration.
3. Implémenter le POST avec `AbortSignal` et erreurs classifiables.
4. Vérifier les tests ciblés.

## Tâche 3 — Mise en file additive après publication

**Fichiers :**
- Créer `src/lib/server/seo-weekly-dispatch.ts`
- Créer `src/lib/server/seo-weekly-dispatch.spec.ts`
- Modifier `src/lib/server/report-publication.ts`
- Modifier les tests de publication concernés.

1. Test RED : fan-out OFF par défaut et zéro requête/écriture.
2. Test RED : un job par projet éligible, `runId=null`, clé idempotente, payload sans secret.
3. Test RED : le second appel ne duplique pas.
4. Ajouter un callback post-publication isolé par `try/catch`.
5. Ajouter le même fan-out aux révisions explicites.
6. Vérifier publication + fan-out ciblés.

## Tâche 4 — Handler de queue

**Fichiers :**
- Modifier `src/lib/server/job-runner.ts`
- Modifier `src/lib/server/job-limits.ts`
- Ajouter/adapter les tests du registre et du provider.

1. Test RED : `dispatch:seo_weekly` est enregistré et classé provider `none`.
2. Brancher le handler vers `hermes-webhook.ts`.
3. Confirmer retries/dead-letter via la boucle existante sans modifier ses invariants.

## Tâche 5 — Réception et mission Agent Ops

**Fichiers :**
- Modifier `src/sources/seo-weekly-dispatch.ts`
- Créer un script webhook de validation/normalisation sous `scripts/` si nécessaire.
- Modifier `docs/seo-weekly-orchestration.md` et `.env.example` des deux dépôts.

1. Valider strictement l’événement (`eventType`, eventId, slug, slot, révision, URL HTTPS canonique).
2. Construire un prompt autonome et borné : matérialiser snapshot, lire contexte/skills, planifier, exécuter selon A0–A4, vérifier, écrire `seo-execution-rN.md`, livrer un digest.
3. Documenter le receiver Agent Ops, les services systemd/nginx et les secrets côté VPS uniquement.

## Tâche 6 — Vérification complète

1. Tests ciblés RED/GREEN de chaque tranche.
2. `npm test` + `npm run check` dans SEO Stats.
3. `npm test` + `npm run check` + `npm run lint` dans Agent Ops.
4. `git diff --check`, revue des payloads/secrets, revue des fichiers touchés.
5. Build SvelteKit ; distinguer compilation applicative du packaging Vercel Windows si le symlink `EPERM` persiste.
6. Documenter précisément : implémenté localement, non déployé, configuration VPS requise, protocole canary Physio Pommier puis trois lundis réels.

## Déploiement progressif prévu, non exécuté sans accord

1. Déployer SEO Stats avec flag OFF.
2. Installer/configurer le receiver Agent Ops et le worker Hermes borné sur le VPS.
3. Configurer URL + secret côté Vercel et credential machine `monitor:read` côté VPS.
4. Activer le flag uniquement pour un canary Physio Pommier si une allowlist est configurée.
5. Rejouer un rapport déjà publié/révision dédiée ; vérifier snapshot, job, webhook, branche, tests et rapport d’exécution.
6. Étendre à trois projets, puis au parc après trois runs validés.
