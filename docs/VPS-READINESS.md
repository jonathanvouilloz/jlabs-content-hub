# Préparation SEO Stats pour Hermes sur VPS

> **Plan maître :** [`../../cerveau/_system/VPS-MIGRATION-PLAN.md`](../../cerveau/_system/VPS-MIGRATION-PLAN.md)  
> **Backlog produit canonique :** [`BACKLOG.md`](BACKLOG.md)  
> **État GMB :** [`gmb-avis-pipeline.md`](gmb-avis-pipeline.md)

## Objectif

Faire de SEO Stats la frontière métier sécurisée entre Hermes et les données/opérations SEO. SEO Stats
reste scheduler, propriétaire de Neon, des jobs, findings, policies et audits. Hermes ne reçoit ni
`DATABASE_URL` ni accès SQL.

## Baseline avant implémentation

Le working tree porte un chantier local important autour de machine-auth, client tokens, fédération
`core.entities`, idempotence et durcissement des imports. Il doit être revu, découpé, testé et déployé
avant d’ajouter la surface VPS. Ne pas rebaser ou committer à l’aveugle les modifications existantes.

## Lot S0 — Stabiliser le chantier local

- [x] Cartographier chaque fichier modifié/non suivi vers son objectif et sa migration (2026-09-24).
- [x] `npm run check` : 0 erreur, 42 avertissements préexistants. `npm test` : 73 fichiers, 1 646 tests verts.
      Build : compilation client (4 160 modules) et serveur (3 987) OK ; le packaging adapter-vercel échoue sur
      le symlink Windows `EPERM`. **Build Linux/Vercel non vérifié** — il le sera au déploiement.
- [ ] Vérifier migrations 0062+, base neuve et base existante/staging.
- [ ] Jouer le backfill client tokens en dry-run sur staging, puis appliquer après revue.
- [x] Revue sécurité machine-auth/CSRF/scopes (2026-09-24) :
      · **Aucun bearer côté navigateur**, et deux specs de non-régression le verrouillent déjà
        (`security-regressions.spec.ts`, `projects.api.spec.ts`).
      · **CSRF SvelteKit actif** : `4a82f97` a supprimé l'override `checkOrigin: false`, donc le défaut
        `true` s'applique — il n'y a plus de clé `csrf` à lire dans `svelte.config.js`, c'est normal.
      · **Toutes les routes `/api/` portent une garde**, sauf les trois callbacks OAuth/Better Auth
        (protégés par construction) et `/api/setup`, qui se ferme dès qu'un utilisateur existe.
      · `legacyMachineScopeForRequest` échoue fermé sur route inconnue ; `/api/agent/**` n'y est pas mappé
        et exige un scope explicite.
      · ⭐ **Défaut trouvé et corrigé** : `/api/agent/reports/{slot}/projects/{slug}` rend la projection
        d'UN projet nommé par le slug, mais n'utilisait que `authorizeMachine` — le scope sans l'allowlist.
        Un credential `monitor:read` lisait donc le snapshot de **n'importe quel client**, ce que
        l'acceptation AGT-001 interdit et que le cloisonnement du profil `barber-concept` exige.
        Passé à `authorizeMachineProject`, avec une spec qui interdit le retour de la forme non bornée.
        ⚠️ **Conséquence de configuration** : le credential `monitor:read` d'Agent Ops doit désormais
        porter une allowlist `projects`, sinon il reçoit 403 sur tous les slugs. Le fan-out n'ayant
        jamais été déployé (flag OFF), le changement ne casse rien en vol.
- [x] Découpé en 4 commits sur `feat/s0-stabilisation`, et **chacun vérifié isolément** (`check` 0 erreur ;
      1 599 → 1 640 → 1 646 → 1 646 tests verts) — sans quoi « régression attribuable » ne veut rien dire :
      `1f52f9d` substrat avis GMB-004→007 · `1609a64` E18 + fan-out + GMB-009 · `dadded5` surface machine
      Hermes · `db1705c` docs et outils.
      ⚠️ Les ~30 scripts jetables `reply-reviews-*` / `publish-replies-*` sont **délibérément non commités** :
      c’est la boucle manuelle que le Lot S4 remplace.
- [ ] Obtenir l’autorisation de push/déploiement (Jonathan).
- [ ] Vérifier `/api/whoami`, migrations, auth humaine et machine en production.

### Gate S0

- `main`, `origin/main` et production correspondent ;
- suite de tests verte et build Linux/Vercel vert ;
- migrations staging puis production prouvées ;
- credentials historiques rotatés.

## Lot S1 — API agent v1

Correspond principalement à `AGT-001`→`AGT-003`, avec le minimum requis par le VPS.

- [ ] Exposer projets, intégrations, santé, runs, jobs, findings, propositions et rapports.
- [ ] Versionner chaque contrat et inclure fraîcheur/pagination.
- [ ] Scoper les credentials par projet et capability.
- [ ] Créer des endpoints de retry/cancel qui réutilisent le lifecycle canonique, jamais des updates bruts.
- [ ] Exiger actor, correlation ID, idempotency key et audit event pour toute mutation.
- [ ] Livrer un client CLI/TypeScript dans `agent-ops` avec sorties JSON stables.
- [ ] Ajouter tests de non-franchissement : token projet A, ressource B, scope absent, token expiré/révoqué.

Scopes initiaux recommandés :

| Scope | Capacité |
|---|---|
| `monitor:read` | santé, runs, jobs, reports, findings |
| `monitor:retry` | retry idempotent d’un job autorisé |
| `proposal:read` | propositions et preuves |
| `proposal:decide` | décision humaine relayée, hash exact obligatoire |
| `review:draft` | créer un brouillon GMB |
| `review:publish` | publier uniquement après policy/gate |

### Gate S1

- Hermes produit le rapport du lundi depuis l’API sans SQL ;
- un scope manquant échoue fermé ;
- retry et double appel ne créent pas de duplication ;
- les preuves ne contiennent pas de PII inutile.

## Lot S2 — Notifications Discord, snapshots projet et watchdog

Correspond à `TEL-001`, `TEL-002`, `REP-002` et au watchdog externe.

- [x] Exposer une projection hebdomadaire déterministe par projet depuis le rapport portefeuille (`GET /api/agent/reports/{slot}/projects/{slug}`, scope `monitor:read`).
- [x] Livrer dans `agent-ops` la matérialisation immuable `docs/monitoring/YYYY-MM-DD-seo-weekly-rN.md` et le contrat de dispatch idempotent.
- [x] Implémenter le fan-out post-publication `ready|degraded` dans la queue canonique SEO Stats, avec clé par slot/révision/slug, retries isolés et feature flag OFF par défaut.
- [x] Livrer le receiver HMAC V2 Agent Ops, la file disque durable, le worker borné à 3, les retries locaux, la récupération après crash et le lancement Hermes sans credential de publication.
- [ ] Déployer ces deux services sur le VPS et valider le canary `physiopommier` avant d’élargir l’allowlist ; les projets `paused|archived` restent absents du rapport publiable et les sites sans repo sont exclus de l’allowlist.
- [ ] Définir le contrat de notification : type, sévérité, slug, établissement, source URL, dedupe key.
- [ ] Livrer intégration cassée, dead-letter, désindexation critique, chute critique et avis 1–2★.
- [ ] Livrer un digest hebdomadaire portefeuille et des drill-downs projet.
- [ ] Rendre le canal configurable par slug/établissement sans stocker le token Discord dans SEO Stats.
- [ ] Dédupliquer par événement/slot et ajouter cooldown/résumé de rafale.
- [ ] Tester silence lorsque tout va bien et alerte actionnable lorsque le run ne peut finir.
- [ ] Rejouer 9 projets × 9 jobs avec timeouts fractionnés ; compter les jobs uniques et attendre le rapport terminal.

### Gate S2

- trois lundis réels observés ;
- aucun message doublon sur retry/tick répété ;
- un incident injecté est détecté, relayé puis résolu avec audit.

## Lot S3 — Boucle d’exécution Head SEO

Correspond à `AGT-004`→`AGT-008` et aux actions provider/Git autorisées.

- [ ] Transformer les findings en plans sourcés et payloads versionnés.
- [ ] Appliquer les politiques A0–A4 par slug.
- [ ] Lier approbation au hash exact du plan/diff.
- [ ] Exposer des actions bornées ; ne jamais permettre une commande shell libre via l’API.
- [ ] Journaliser proposition, approbation, agent run, résultat, vérification et rollback.
- [ ] Refuser automatiquement l’exécution si le contexte ou le hash a changé.
- [ ] Prouver un chemin canary jusqu’à une PR et une production vérifiée.

## Lot S4 — Avis GMB Barber Concept

Ordre obligatoire : `GMB-003` → `GMB-004` → `GMB-005` → `GMB-006` → `GMB-007` → `GMB-009`.

- [ ] Compiler une projection versionnée par établissement : identité, voix, équipe, interdits et fraîcheur.
- [ ] Générer des brouillons structurés depuis le vrai avis et la bonne fiche.
- [ ] Classifier auto-publiable vs sensible dans le hub, pas dans l’agent.
- [ ] Publier via state machine avec anti-doublon et vérification distante avant/après.
- [ ] Extraire les mentions de tous les avis, indépendamment de la réponse.
- [ ] Remplacer le roster global par IDs, aliases et affectations d’établissement datées.
- [ ] Stocker la mention candidate avec preuve, confiance et statut de validation.
- [ ] Rendre les agrégats dérivables/rejouables depuis la source par avis.
- [ ] Créer un finding pour nom inconnu, homonyme ou affectation incohérente.
- [ ] Produire mini-rapport quotidien et clôture mensuelle immuable/versionnée.

### Gate S4

- dry-run une semaine ;
- auto-publication 4–5★ uniquement pendant deux semaines ;
- 1–2★ et sensible toujours escaladés ;
- un mois complet rapproché du rapport manuel ;
- aucune donnée candidate utilisée directement pour la rémunération.

## Lot S5 — Exploitation et portabilité

- [ ] Corriger/valider la lecture `system_settings` et les defaults observables.
- [ ] Documenter rate limits, timeouts, retries, dead letters et kill switch.
- [ ] Ajouter métriques d’usage API machine et alertes de credential proche d’expiration.
- [ ] Tester rotation avec chevauchement et révocation immédiate.
- [ ] Garder Vercel comme scheduler canonique ; ne jamais créer un second catalogue concurrent sur le VPS.
- [ ] Documenter rollback applicatif, migration DB et désactivation GMB.

## Definition of Done SEO/VPS

- [ ] aucun accès SQL depuis Hermes ;
- [ ] API agent versionnée, scopée, auditée et testée ;
- [ ] watchdog réel stable trois semaines ;
- [ ] rapport Discord fiable et silencieux hors incident ;
- [ ] chemin Head SEO jusqu’à production vérifié sur un canary ;
- [ ] Barber Concept validé quotidiennement et mensuellement ;
- [ ] rotation/révocation/restauration prouvées.
