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

- [ ] Cartographier chaque fichier modifié/non suivi vers son objectif et sa migration.
- [ ] Exécuter `npm run check`, tests ciblés, suite complète et build Linux/Vercel.
- [ ] Vérifier migrations 0062+, base neuve et base existante/staging.
- [ ] Jouer le backfill client tokens en dry-run sur staging, puis appliquer après revue.
- [ ] Faire une revue sécurité machine-auth/CSRF/scopes et vérifier absence de bearer admin côté navigateur.
- [ ] Découper en commits cohérents puis obtenir l’autorisation de push/déploiement.
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

## Lot S2 — Notifications Discord et watchdog

Correspond à `TEL-001`, `TEL-002`, `REP-002` et au watchdog externe.

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
