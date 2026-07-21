# SPEC — seo-stats, cockpit agentique de monitoring SEO et présence locale

> **Version :** 0.2 — décisions produit et exploitation intégrées  
> **Date :** 2026-07-21  
> **Statut :** base de refactor validée, prête à être découpée en epics  
> **Produit cible :** `seo-stats`  
> **Repo canonique :** `C:\Users\jojo-\Desktop\noyau\seo-stats`  
> **Backlog d'exécution :** `docs/BACKLOG.md`  
> **Remplace fonctionnellement :** le pivot jokiSEO incomplet du Content Hub  
> **Objectif final :** déléguer 90 % des opérations récurrentes à des agents IA, avec validation humaine des décisions sensibles.

---

## 0. Résumé exécutif

`seo-stats` devient la plateforme opérationnelle centrale pour surveiller, diagnostiquer et piloter le SEO et la présence locale de tous les projets.

Le système doit :

1. collecter automatiquement les données de chaque projet ;
2. conserver un historique fiable des observations ;
3. détecter les problèmes et opportunités avec des règles déterministes ;
4. confier aux agents IA la synthèse, le diagnostic enrichi et la préparation des actions ;
5. présenter à Jonathan une inbox priorisée et un rapport hebdomadaire consolidé ;
6. exécuter automatiquement les actions explicitement autorisées ;
7. demander une validation pour toute action éditoriale, destructive, coûteuse ou risquée ;
8. conserver une piste d'audit complète de chaque observation, décision et exécution.

Le dashboard n'est plus le lieu principal de production de contenu. Il devient un cockpit de lecture, de validation et de supervision. Les repos projets restent les sources de vérité pour l'identité, le contexte métier et les contenus. `seo-stats` possède les données opérationnelles, les observations, les findings, les jobs et les décisions.

Le dimensionnement initial couvre 5 projets. L'architecture, les quotas et les opérations doivent fonctionner sans refonte pour 10 à 15 projets au minimum dans les douze mois.

### Résultat utilisateur visé

Chaque semaine, le système doit pouvoir produire automatiquement :

- un état de santé de tous les projets ;
- les gains et baisses SEO significatifs ;
- les nouvelles requêtes et opportunités ;
- les anomalies CTR ;
- les conflits de cannibalisation ;
- les problèmes d'indexation ;
- les changements de trafic et de conversion ;
- les avis Google à traiter et les réponses proposées ou envoyées ;
- une liste courte d'actions priorisées, justifiées et routées vers les bons skills.

Jonathan ne doit plus collecter ni assembler manuellement les données. Son travail cible est : lire le rapport, valider ou rejeter les propositions et relire les contenus ou réponses sensibles.

---

## 1. Contexte et problèmes à résoudre

### 1.1 Existant utile à conserver

Le produit actuel dispose déjà de briques solides :

- collecte GSC hebdomadaire à la granularité `query × page × device` ;
- snapshots, diffs et historique ;
- watchlist de mots-clés ;
- détection de mouvements ;
- détection de cannibalisation avec normalisation des URLs ;
- inspection d'URLs et soumissions d'indexation ;
- synchronisation des avis Google ;
- génération de brouillons de réponse ;
- gestion de jobs de fond simples ;
- stockage de rapports SEO externes ;
- accès API par les skills.

### 1.2 Limites actuelles

- Le dashboard reste structuré comme un Content Hub.
- La collecte, le diagnostic et les skills utilisent plusieurs chemins et formats concurrents.
- Les résultats d'indexation ne sont pas historisés.
- Les diagnostics sont souvent recalculés à la demande ou laissés dans des fichiers JSON locaux.
- Le cron GSC ne déclenche pas la chaîne complète d'analyse et de rapport.
- La route de synchronisation des avis n'est pas planifiée dans la configuration Vercel actuelle.
- Le registre `ai_jobs` n'est pas une queue durable.
- Les tests du pipeline post-publication utilisent des fixtures qui ne correspondent pas aux outputs réels de certains skills.
- Plusieurs skills pointent encore vers `jlabs-content-hub`, Turso ou une URL Vercel codée en dur.
- Les agents ne disposent pas d'une interface stable pour lister les findings, obtenir les preuves, proposer une action et suivre son exécution.
- Les décisions sont présentées comme des tableaux temporaires plutôt que comme des objets persistants avec un cycle de vie.

### 1.3 Changement de modèle

Le système cible repose sur la chaîne suivante :

```text
providers -> observations -> detectors -> findings -> agent analysis -> proposals -> approval -> execution -> verification
```

Une observation est un fait collecté. Un finding est une interprétation déterministe persistante. Une proposition est une action recommandée. Une exécution est une mutation autorisée. Ces quatre objets ne doivent jamais être confondus.

---

## 2. Vision produit

### 2.1 Promesse

> Tous les projets sont surveillés automatiquement. Chaque anomalie ou opportunité importante devient un finding justifié. Les agents préparent le diagnostic et les actions. Jonathan valide uniquement ce qui mérite un jugement humain.

### 2.2 Objectifs mesurables

- 100 % des projets actifs avec intégrations valides sont scannés chaque semaine.
- 100 % des runs possèdent un statut, une durée, un détail des étapes et des erreurs.
- 100 % des findings affichés possèdent des preuves et une période de comparaison.
- Un même problème n'apparaît pas comme une nouvelle alerte chaque semaine : son historique est continu.
- Le rapport consolidé est disponible automatiquement après le dernier run hebdomadaire.
- Les nouveaux avis sont synchronisés sans intervention manuelle.
- Les avis éligibles reçoivent automatiquement un brouillon ; les avis autorisés par la politique peuvent être envoyés automatiquement après délai.
- Les actions sensibles restent validées par un humain.
- Toute action externe est auditable et idempotente.
- Les agents peuvent opérer sans ouvrir le dashboard grâce à une CLI et une API stables.

### 2.3 Définition des « 90 % délégués »

Les agents prennent en charge automatiquement :

- la collecte ;
- les contrôles de fraîcheur et de qualité des données ;
- les comparaisons temporelles ;
- la détection des anomalies et opportunités ;
- l'enrichissement du diagnostic avec le contexte projet ;
- la priorisation ;
- la rédaction des rapports ;
- la préparation des briefs de correction ;
- la préparation des refreshs ;
- la rédaction des réponses aux avis ;
- les relances et vérifications après exécution.

Jonathan conserve :

- la validation des priorités stratégiques ;
- la relecture des réponses sensibles ;
- la validation des modifications de contenu ;
- la validation des redirections, canonicals, suppressions et désindexations ;
- la validation des dépenses ou augmentations de quotas ;
- la décision finale lorsqu'un diagnostic reste ambigu.

---

## 3. Principes d'architecture

### 3.1 Sources de vérité

| Domaine | Source canonique |
|---|---|
| Identité, voix, équipe, offres, établissements | Repo projet, `docs/brand/*` et `docs/business/profile.md` |
| Configuration technique du projet | `project.yaml` |
| Contenu publié et historique éditorial | Repo projet |
| Registre canonique des entités/slugs | `core.entities` / système cerveau |
| Observations SEO, GMB et analytics | `seo-stats` |
| Jobs, findings, propositions et décisions | `seo-stats` |
| Secrets | variables d'environnement ou secret store, jamais `project.yaml` |

Le dashboard ne doit pas réintroduire une seconde vérité éditable pour les faits métier.

### 3.2 Projection de contexte

Chaque projet connecté fournit à `seo-stats` une projection compilée, horodatée et hashée contenant uniquement les informations nécessaires aux diagnostics :

- slug canonique ;
- domaine et variantes ;
- locales ;
- pages et types de pages ;
- mapping contenu -> URL ;
- mots-clés cibles ;
- URLs cibles ;
- établissements et zones géographiques utiles ;
- règles de marque nécessaires aux réponses d'avis ;
- hashes des documents sources.

La projection est en lecture seule. Si les hashes ne correspondent plus aux sources, elle est marquée `stale` et doit être recompilée.

### 3.3 Séparation déterministe / IA

- Les collecteurs acquièrent des faits.
- Les détecteurs déterministes calculent les deltas, seuils, fingerprints et scores.
- Les agents IA expliquent, regroupent, contextualisent et proposent.
- Un agent ne fabrique jamais une métrique manquante.
- Une recommandation IA doit pointer vers les observations et findings qui la justifient.

### 3.4 Portabilité

Le produit utilise PostgreSQL standard et évite les dépendances exclusives à Neon ou Vercel. Le même code doit fonctionner :

- d'abord avec Neon comme PostgreSQL managé pendant les tests locaux et la stabilisation ;
- ensuite avec l'application, les workers et les agents sur le VPS tout en pouvant conserver Neon ;
- enfin, si cela devient utile, avec PostgreSQL auto-hébergé sur le VPS sans refonte métier.

Le déplacement de l'application vers le VPS et le déplacement de la base sont deux décisions indépendantes. Aucun cutover PostgreSQL auto-hébergé n'est requis pour mettre `seo-stats` en production sur le VPS.

Les tâches longues ne doivent pas dépendre du cycle de vie d'une requête HTTP serverless.

---

## 4. Périmètre

### 4.1 Inclus dans la cible

- cockpit cross-projet ;
- cockpit par projet ;
- scheduler et queue durables ;
- collecte GSC ;
- monitoring des mots-clés et pages ;
- indexation et inspection d'URLs ;
- IndexNow ;
- cannibalisation ;
- analytics Plausible optionnels ;
- avis Google entièrement automatisables ;
- rapports hebdomadaires internes ;
- rapports mensuels client ;
- CLI et API pour agents ;
- projection hashée du contexte projet ;
- suivi des coûts, quotas, erreurs et fraîcheur ;
- déploiement VPS ;
- extension future DataForSEO, backlinks, geo-grid et visibilité IA.

### 4.2 Hors périmètre initial

- éditeur de contenu complet dans le dashboard ;
- publication autonome de changements SEO sensibles sans validation ;
- remplacement du repo comme source de contenu ;
- commercialisation SaaS multi-tenant avancée ;
- data warehouse événementiel généraliste ;
- garanties d'indexation ou de classement ;
- soumission de pages ordinaires via la Google Indexing API.

---

## 5. Utilisateurs et rôles

### 5.1 Admin opérateur

Jonathan possède tous les droits de lecture, validation, configuration et exécution.

### 5.2 Agent de monitoring

Peut :

- lire projets, runs, observations, findings et projections ;
- déclencher un scan autorisé ;
- produire une analyse et une proposition ;
- générer un rapport ;
- demander l'exécution d'une action.

Ne peut pas modifier silencieusement les sources canoniques ou contourner une validation.

### 5.3 Agent d'exécution

Peut exécuter uniquement une proposition approuvée et dans un périmètre déterminé : projet, action, durée et ressources autorisées.

### 5.4 Client viewer

Accès lecture seule à un rapport simplifié et white-label. Aucun accès aux prompts, secrets, erreurs techniques internes ou projets tiers.

---

## 6. Architecture cible

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Repos projets / système cerveau                                    │
│ project.yaml + docs canoniques + contenus + projection hashée      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ seo-stats API                                                       │
│ projets · observations · findings · propositions · approvals       │
└───────────────┬─────────────────────┬───────────────────────────────┘
                │                     │
                ▼                     ▼
┌─────────────────────────┐  ┌────────────────────────────────────────┐
│ Scheduler + job queue   │  │ Dashboard / CLI / API agents           │
│ leases · retry · resume │  │ lecture · triage · validation          │
└──────────────┬──────────┘  └────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Workers                                                             │
│ GSC · URL Inspection · IndexNow · GMB · Plausible · DataForSEO     │
│ détecteurs déterministes · rapports · vérification post-action     │
└──────────────┬──────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ PostgreSQL                                                          │
│ observations time-series · runs · findings · audit · coûts         │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.1 Composants applicatifs

1. **Web/API SvelteKit** : interface et API authentifiée.
2. **Scheduler** : crée les jobs selon les politiques projets.
3. **Worker** : réclame les jobs, renouvelle les leases et exécute les étapes.
4. **Analyzer** : produit les findings déterministes.
5. **Agent gateway** : expose aux agents une API et une CLI structurées.
6. **Report builder** : produit les rapports internes et clients.
7. **Notification service** : Telegram en canal principal, dashboard comme inbox canonique, email optionnel pour les rapports clients.
8. **Projection compiler** : compile et synchronise le contexte minimal des repos.

### 6.2 Queue durable

La première version utilise PostgreSQL afin d'éviter un Redis obligatoire :

- table de jobs ;
- réclamation atomique avec `FOR UPDATE SKIP LOCKED` ;
- lease expirant ;
- heartbeat ;
- retry avec backoff ;
- dead-letter après le nombre maximal de tentatives ;
- idempotency key ;
- dépendances entre jobs ;
- annulation ;
- reprise après redémarrage du worker.

---

## 7. Modèle de données cible

Les noms finaux pourront être adaptés à Drizzle, mais les concepts suivants sont obligatoires.

### 7.1 `project_integrations`

- `project_id`
- `provider`
- `enabled`
- `status`
- `configuration_json`
- `secret_ref`
- `last_success_at`
- `last_error_at`
- `last_error_code`
- `health_status`
- `created_at`, `updated_at`

Les secrets ne sont pas stockés dans `configuration_json`.

### 7.2 `project_projections`

- `project_id`
- `schema_version`
- `source_hash`
- `payload`
- `compiled_at`
- `received_at`
- `status: current | stale | invalid`
- `validation_errors`

### 7.3 `monitoring_runs`

- `id`
- `project_id`
- `run_type: daily | weekly | monthly | manual | post_publish`
- `period_start`, `period_end`
- `status: queued | running | partial | success | failed | cancelled`
- `idempotency_key`
- `triggered_by: schedule | user | agent | webhook`
- `started_at`, `finished_at`
- `summary_json`
- `cost_json`

### 7.4 `monitoring_steps`

- `run_id`
- `step_type`
- `provider`
- `status`
- `attempt`
- `lease_owner`, `lease_until`
- `input_hash`, `output_hash`
- `started_at`, `finished_at`, `duration_ms`
- `error_code`, `error_message`
- `metadata_json`

### 7.5 Observations

Tables ou partitions dédiées :

- `gsc_query_page_observations` ;
- `gsc_page_observations` ;
- `index_observations` ;
- `sitemap_observations` ;
- `plausible_page_observations` ;
- `keyword_rank_observations` ;
- `backlink_observations` ;
- `ai_visibility_observations` ;
- `gmb_review_observations` ;
- `gmb_insight_observations`.

Chaque observation porte : projet, provider, période/date, dimensions, métriques, `run_id`, date de collecte et version du schéma.

### 7.6 `findings`

- `id`
- `project_id`
- `fingerprint` unique et stable
- `type`
- `entity_type: project | query | page | review | integration`
- `entity_key`
- `title`
- `status: open | acknowledged | planned | in_progress | resolved | dismissed | snoozed`
- `severity: info | low | medium | high | critical`
- `priority_score` de 0 à 100
- `confidence_score` de 0 à 100
- `impact_estimate_json`
- `first_seen_at`, `last_seen_at`
- `occurrence_count`
- `evidence_json`
- `detector_version`
- `recommended_skill`
- `resolution_reason`
- `resolved_at`

Le fingerprint empêche la duplication hebdomadaire du même problème.

### 7.7 `finding_events`

Journal append-only : création, aggravation, amélioration, commentaire agent, validation, rejet, snooze, réouverture et résolution.

### 7.8 `action_proposals`

- `id`
- `finding_id`
- `project_id`
- `action_type`
- `target`
- `rationale`
- `expected_impact`
- `risk_level`
- `required_approval_level`
- `proposed_by`
- `payload_json`
- `input_hashes_json`
- `status: proposed | approved | rejected | executing | executed | failed | superseded`
- `approved_by`, `approved_at`
- `execution_job_id`
- `verification_status`

### 7.9 `agent_runs`

- agent et version ;
- skill ;
- inputs et hashes ;
- findings lus ;
- proposition ou rapport produit ;
- tokens/coût/durée ;
- résultat ;
- erreurs ;
- validation humaine associée.

### 7.10 `review_automation_policies`

- projet/localisation ;
- sync activée ;
- génération automatique activée ;
- note minimale pour envoi automatique ;
- délai avant envoi ;
- plages horaires ;
- langue par défaut ;
- signatures ;
- catégories nécessitant une validation ;
- nombre maximal d'envois par run ;
- mode `draft_only | guarded_auto | manual`.

### 7.11 Rétention des données

Politique initiale validée :

- observations détaillées GSC, indexation, analytics et réputation : 24 mois ;
- agrégats hebdomadaires, mensuels et annuels : conservation sans limite prédéfinie ;
- findings, décisions, approbations et audit des actions externes : conservation sans limite prédéfinie ;
- payloads techniques volumineux et logs de debug : 90 jours, sauf incident ou obligation d'audit ;
- rapports générés : conservation sans limite prédéfinie ;
- purge exécutée par job versionné, observable et testable en mode dry-run.

La rétention doit être configurable par type de donnée. Une suppression de données d'audit ne peut pas être déclenchée par un agent sans validation L4.

---

## 8. Orchestration des automatisations

### 8.1 Types de runs

La cadence validée utilise `Europe/Zurich` comme timezone métier et tient compte des changements heure d'été/heure d'hiver.

#### Événementiel ou horaire

- soumission IndexNow dès publication, modification ou suppression confirmée ;
- synchronisation des avis Google toutes les heures ;
- génération du brouillon dans les 15 minutes suivant la synchronisation ;
- alertes critiques dès confirmation ;
- reprise des jobs échoués selon backoff, sans attendre le run quotidien.

#### Quotidien

- santé des intégrations ;
- événements IndexNow en attente ;
- vérification des jobs échoués ;
- anomalies critiques de disponibilité ou d'indexation déjà connues ;
- DataForSEO quotidien uniquement pour les mots-clés explicitement configurés.

#### Hebdomadaire

Déclenchement : **chaque lundi à 09:00 Europe/Zurich**. C'est la fréquence initiale de référence pour les diagnostics GSC : elle limite le bruit lié à la latence de Search Console tout en restant assez réactive. Les fenêtres 7 et 28 jours restent calculées ensemble.

- snapshot GSC final ;
- comparaison 7 jours et 28 jours ;
- sitemap diff ;
- inspection ciblée ;
- mots-clés en hausse/baisse ;
- nouvelles et anciennes requêtes ;
- CTR gaps ;
- cannibalisation ;
- target URL mismatch ;
- trafic Plausible ;
- consolidation des findings ;
- synthèse agent ;
- rapport cross-projet.

#### Mensuel

- rapport client automatique, activé dans une phase ultérieure après validation du modèle interne ;
- comparaison mois précédent ;
- comparaison annuelle si historique suffisant ;
- audit de contenu vieillissant ;
- tendances réputation ;
- backlinks et visibilité IA si activés ;
- recommandations stratégiques.

#### Post-publication

- enregistrement de l'URL publiée ;
- soumission IndexNow ;
- vérification sitemap/canonical ;
- inspection différée ;
- baseline GSC et Plausible ;
- vérifications J+3, J+7, J+28 selon la politique.

### 8.2 Graphe du run hebdomadaire

```text
validate_project
  ├─ sync_projection
  ├─ pull_gsc_7d
  ├─ pull_gsc_28d
  ├─ fetch_sitemap
  ├─ pull_plausible_7d      [optionnel]
  ├─ pull_reviews           [si GMB]
  └─ inspect_priority_urls  [quota-aware]
          ↓
normalize_observations
          ↓
run_detectors
          ↓
upsert_findings
          ↓
agent_synthesis
          ↓
generate_report
          ↓
notify_admin
```

### 8.3 Idempotence

Chaque job reçoit une clé déterministe, par exemple :

```text
weekly:{project_slug}:{period_end}:{step_type}:{schema_version}
```

Un rerun ne duplique ni observations, ni findings, ni réponses aux avis. `force` crée une nouvelle tentative rattachée au même run logique.

---

## 9. Providers et collecteurs

### 9.1 Google Search Console

#### Données collectées

- totaux site ;
- queries ;
- pages ;
- query × page ;
- query × page × device si nécessaire ;
- périodes exactes non chevauchantes ;
- état `final` pour les rapports réguliers.

#### Fenêtres

- 7 jours complets vs 7 jours précédents ;
- 28 jours complets vs 28 jours précédents ;
- 3 mois pour les diagnostics de fond ;
- année précédente lorsque disponible.

Le signal hebdomadaire sert à la réactivité. Le signal 28 jours sert à confirmer la tendance et réduire le bruit.

#### Règles

- pagination complète ;
- conservation de la donnée brute normalisée ;
- aucune position GSC présentée comme rang SERP exact ;
- séparation search type, device et pays lorsque pertinent ;
- suivi explicite de la fraîcheur et de la latence.

### 9.2 URL Inspection

#### Données conservées

- verdict ;
- coverage state ;
- indexing state ;
- page fetch state ;
- robots state ;
- dernier crawl ;
- canonical Google ;
- canonical utilisateur ;
- referring URLs ;
- mobile usability et rich results si disponibles ;
- erreur et statut HTTP de l'API.

#### Stratégie de quota

Ne pas inspecter l'intégralité de tous les sites chaque semaine. Priorité :

1. URLs nouvelles ou modifiées ;
2. URLs précédemment problématiques ;
3. URLs ayant perdu impressions/clics brutalement ;
4. URLs attendues mais absentes du sitemap ;
5. échantillon tournant des autres URLs ;
6. audit complet manuel ou mensuel selon la taille du site.

### 9.3 IndexNow

IndexNow est un canal de notification, pas une preuve d'indexation.

#### Événements soumis

- URL ajoutée ;
- URL substantiellement mise à jour ;
- URL supprimée ;
- redirection validée ;
- batch issu d'un sitemap diff approuvé.

#### Configuration projet

```yaml
integrations:
  indexnow:
    enabled: false
    endpoint: https://api.indexnow.org/indexnow
    key_env: INDEXNOW_KEY
    key_location: null
    submit_on: [publish, update, delete]
```

#### Stockage

- URL ;
- type d'événement ;
- content hash ;
- date de demande ;
- endpoint ;
- HTTP status ;
- tentative ;
- réponse ;
- prochaine tentative ;
- statut final.

#### Règles

- clé de 8 à 128 caractères conforme au protocole ;
- fichier de preuve hébergé sur le domaine ;
- batch jusqu'à 10 000 URLs accepté par le protocole, mais batch interne borné plus bas ;
- 200/202 signifie reçu, pas indexé ;
- 400/403/422 non retentés aveuglément ;
- 429 retenté avec backoff ;
- déduplication par `URL + content_hash + event_type`.

### 9.4 Google Indexing API

La soumission automatique générale d'articles et pages locales est retirée.

La Google Indexing API ne reste disponible que pour les pages explicitement éligibles :

- `JobPosting` ;
- `BroadcastEvent` intégré dans un `VideoObject`.

Pour les pages ordinaires, les actions sont : sitemap, maillage interne, canonical, qualité, inspection et éventuelle demande manuelle dans Search Console.

### 9.5 Plausible Analytics

Plausible est un provider optionnel. Il complète GSC mais ne le remplace pas.

La cible privilégiée est **Plausible Community Edition auto-hébergée sur le VPS**. Cette édition est gratuite côté licence (« free as in beer ») : les coûts restants sont le VPS, le stockage, les sauvegardes et le temps de maintenance. Elle ne contient pas nécessairement toutes les fonctions premium du cloud ; l'intégration `seo-stats` doit donc reposer uniquement sur les événements et endpoints effectivement disponibles et couverts par un test de contrat.

#### Métriques

- visiteurs ;
- visites ;
- pages vues ;
- pages vues par visite ;
- taux de rebond ;
- durée de visite ;
- temps par page ;
- profondeur de scroll ;
- conversions ;
- événements personnalisés, notamment formulaires envoyés, clics/appels téléphoniques et prises de rendez-vous ;
- pages 404 ;
- pages de destination ;
- sources/referrers lorsque la configuration le permet.

#### Cas d'usage

- confirmer qu'une hausse de clics GSC produit du trafic réel ;
- détecter une baisse de trafic sans baisse de visibilité ;
- repérer les pages visibles mais peu engageantes ;
- prioriser les refreshs selon trafic et conversion ;
- identifier des 404 réelles ;
- mesurer l'effet après optimisation ;
- enrichir les rapports clients.

Les conversions sont configurées par projet dans un registre canonique. Chaque événement possède au minimum `event_name`, `lead_type`, `source`, `page`, `occurred_at` et, si disponible, un identifiant de déduplication. Le MVP couvre :

- soumission de formulaire ;
- clic sur numéro de téléphone et appel confirmé lorsqu'une source de call tracking le permet ;
- prise de rendez-vous démarrée et confirmée ;
- autres événements explicitement marqués comme leads pour le client final.

Un clic sur téléphone ne doit pas être présenté comme un appel confirmé. Une ouverture de formulaire ne doit pas être comptée comme une soumission.

#### Configuration

```yaml
integrations:
  plausible:
    enabled: false
    base_url: https://plausible.example.com
    site_id: example.com
    api_key_env: PLAUSIBLE_STATS_API_KEY
```

Le provider doit supporter une URL de base configurable pour fonctionner avec Plausible Cloud ou une instance auto-hébergée. L'implémentation valide au préalable les fonctions réellement disponibles dans l'édition choisie.

#### Stockage

`seo-stats` conserve des agrégats quotidiens ou hebdomadaires nécessaires aux diagnostics. Il ne copie pas tous les événements bruts de Plausible.

### 9.6 Google Business Profile et avis

#### Pipeline complet

```text
sync -> dedupe -> classify -> generate draft -> quality gate
     -> delay -> approval policy -> send -> verify -> audit
```

#### Synchronisation

- toutes les heures par défaut ;
- isolation des erreurs par projet et établissement ;
- curseur ou fenêtre de rattrapage ;
- déduplication par `review_id` ;
- synchronisation des réponses déjà présentes chez Google ;
- détection des modifications d'avis.

#### Génération

- génération automatique pour tout nouvel avis sans réponse ;
- contexte provenant de la projection hashée du repo ;
- réponse dans la langue de l'avis ;
- mention spécifique du commentaire ;
- détection des employés limitée à l'équipe canonique ;
- contrôle de longueur, ton, répétition, PII et formulations interdites ;
- score de confiance ;
- raisons explicites si validation requise.

#### Politique par défaut

L'automatisation est promue par étapes afin de mesurer le taux de retouche et les erreurs avant tout élargissement :

1. `draft_only` : backtest historique puis observation des nouveaux avis, sans envoi autonome ;
2. `guarded_auto` : après validation explicite du projet, les 5 étoiles éligibles sont envoyés automatiquement ;
3. politique élargie : les 4 étoiles, puis les autres avis positifs non sensibles, ne deviennent auto-éligibles qu'après une nouvelle validation fondée sur les résultats.

Le passage de niveau exige au minimum zéro erreur critique, un échantillon suffisant documenté et un taux d'acceptation sans modification défini dans la policy. Une proposition initiale de gate est : 30 avis historiques + 20 avis réels, au moins 95 % acceptés sans retouche substantielle.

| Avis | Comportement initial |
|---|---|
| 5 étoiles | brouillon auto ; envoi différé auto uniquement après promotion en `guarded_auto` et quality gate PASS |
| 4 étoiles | brouillon auto, validation humaine jusqu'à promotion explicite de la policy |
| 3 étoiles | brouillon auto, validation humaine obligatoire |
| 1–2 étoiles | brouillon + alerte, validation humaine obligatoire |
| Contenu sensible ou juridique | validation humaine obligatoire |
| Confiance faible | validation humaine obligatoire |

#### Envoi différé

- délai par défaut de 8 heures, configurable par projet ;
- jitter par défaut de ± 90 minutes pour éviter un comportement mécanique ;
- annulation possible ;
- vérification que l'avis n'a pas changé ;
- verrou empêchant deux réponses ;
- nouvelle lecture de la policy juste avant envoi ;
- confirmation distante après envoi.

#### Escalade

Un avis passe en validation si :

- note sous le seuil ;
- accusation, incident, santé, droit, remboursement ou sécurité ;
- menace ou langage abusif ;
- réponse contenant une donnée personnelle ;
- établissement ou personne ambiguë ;
- contexte métier stale ;
- erreur du quality gate ;
- avis modifié après génération.

---

## 10. Moteur de diagnostic

### 10.1 Cycle de vie d'un finding

```text
new -> open -> acknowledged -> planned -> in_progress -> resolved
                    └──────────── dismissed / snoozed
resolved -> reopened si le problème réapparaît
```

### 10.2 Priorité

Score recommandé :

```text
priority = impact (0–40)
         + urgency (0–25)
         + confidence (0–20)
         + strategic_fit (0–15)
```

Le score et ses composantes sont visibles. L'agent peut commenter la priorité mais ne remplace pas le calcul de base.

### 10.3 Réduction du bruit

- seuils relatifs au volume du projet ;
- comparaison 7 jours et confirmation 28 jours ;
- minimum d'impressions/clics adapté aux sites locaux ;
- persistance sur plusieurs fenêtres pour les alertes non critiques ;
- intervalle de confiance ;
- détection de saisonnalité lorsque l'historique le permet ;
- regroupement par page, query et cluster ;
- un fingerprint stable par problème ;
- distinction entre absence de donnée et valeur zéro.

### 10.4 Catalogue initial de findings

| Type | Signal principal | Confirmation | Skill/action |
|---|---|---|---|
| `keyword_opportunity` | impressions + position exploitable | 28 jours ou volume suffisant | `seo-refresh` ou `seo-gatekeeper` |
| `keyword_decline` | perte clics/position | persistance + volume | `seo-refresh` |
| `new_query` | requête absente auparavant | ≥2 fenêtres ou seuil | analyse/gatekeeper |
| `lost_query` | requête disparue | page toujours indexable | diagnostic page |
| `ctr_gap` | CTR sous baseline position/device | impressions suffisantes | optimisation snippet |
| `content_decay` | baisse page 28/28 ou YoY | contenu ancien + trafic | `seo-refresh` |
| `target_url_mismatch` | mauvaise URL ranke | target connu dans projection | maillage/différenciation |
| `cannibalization` | ≥2 URLs significatives | persistance + intentions | `seo-cannibalisation` |
| `index_drop` | indexed -> non-indexed | inspection répétée | `seo-index-diagnose` |
| `crawled_not_indexed` | coverage state | inspection | enrichissement/maillage |
| `discovered_not_indexed` | coverage state | inspection | découverte/maillage |
| `canonical_conflict` | Google != user canonical | sitemap + contenu | audit canonical |
| `sitemap_anomaly` | URL attendue absente/invalide | projection + fetch | correction technique |
| `redirect_in_sitemap` | redirection listée | HTTP/canonical | nettoyage sitemap |
| `soft_404` | inspection ou analytics | contenu/HTTP | enrichir ou vrai 404 |
| `traffic_anomaly` | Plausible baisse | GSC stable ou divergent | audit tracking/UX |
| `conversion_drop` | objectif en baisse | trafic suffisant | audit page/CTA |
| `review_pending_sla` | avis sans réponse | délai policy dépassé | `gmb-review-responder` |
| `negative_review` | note 1–3 | immédiat | escalade humaine |
| `integration_stale` | absence de collecte | heartbeat | réparation intégration |

### 10.5 Cannibalisation

La détection mécanique identifie les conflits. L'agent classe ensuite :

- mot-clé exact ;
- même intention ;
- proximité sémantique légitime ;
- triade SERP complémentaire ;
- variante technique/canonical ;
- mauvais mapping de l'URL cible.

Aucune redirection n'est proposée sans métriques des deux pages, analyse d'intention et validation humaine.

### 10.6 Corrélation GSC + Plausible

Exemples de diagnostics croisés :

- impressions et clics montent, visites stables : vérifier tracking, URL ou attribution ;
- clics stables, conversions baissent : problème UX/offre/CTA probable ;
- position stable, CTR baisse : snippet ou SERP changée ;
- page peu visible mais très convertissante : priorité SEO forte ;
- trafic fort, engagement faible : intention ou contenu mal aligné ;
- 404 Plausible + impressions GSC : finding critique de récupération/redirection.

---

## 11. Système agentique et skills

### 11.1 Rôle des agents

Les agents consomment les données de `seo-stats`; ils ne recollectent pas par défaut directement chaque provider. L'accès direct reste un mode debug ou fallback explicite.

### 11.2 CLI cible

```text
seo-stats projects list --json
seo-stats projects health --all --json
seo-stats runs start weekly --all
seo-stats runs status <run-id> --json
seo-stats runs retry <run-id> --failed-only
seo-stats findings list --status open --min-priority 60 --json
seo-stats findings show <finding-id> --with-evidence --json
seo-stats proposals create --finding <id> --payload <file>
seo-stats proposals approve <id>
seo-stats proposals reject <id> --reason "..."
seo-stats reviews queue --needs-approval --json
seo-stats reviews approve <proposal-id>
seo-stats reports generate weekly --all
seo-stats reports show latest --all
seo-stats integrations test <project> <provider>
```

Toutes les commandes proposent une sortie humaine et une sortie JSON versionnée.

### 11.3 API agent

Routes minimales :

- `GET /api/v1/projects`
- `GET /api/v1/projects/:slug/health`
- `POST /api/v1/runs`
- `GET /api/v1/runs/:id`
- `GET /api/v1/findings`
- `GET /api/v1/findings/:id`
- `POST /api/v1/findings/:id/comments`
- `POST /api/v1/proposals`
- `POST /api/v1/proposals/:id/approve`
- `POST /api/v1/proposals/:id/reject`
- `GET /api/v1/reports`
- `GET /api/v1/reviews/queue`

Les endpoints sont versionnés et utilisent des tokens de service scopés.

### 11.4 Skills à adapter

| Skill actuel | Rôle cible |
|---|---|
| `seo-gsc` | debug/fallback provider et export ciblé ; collecte régulière côté worker |
| `seo-weekly` | déclenche ou lit un run hebdomadaire et rend le rapport |
| `seo-actions` | transforme les findings ouverts en propositions priorisées |
| `seo-index-diagnose` | deep dive d'un finding d'indexation |
| `seo-cannibalisation` | classification agentique des conflits centralisés |
| `seo-refresh` | exécute une proposition éditoriale approuvée |
| `seo-audit` | audit mensuel ou manuel enrichi des observations |
| `seo-archive` | archive rapports/décisions, pas les données opérationnelles primaires |
| `gmb-review-responder` | génération/relecture ciblée d'une réponse en attente |
| `seo-backlinks` | provider/détecteur optionnel centralisé |
| `seo-ai-visibility` | campagne mensuelle versionnée, résultats observables |

### 11.5 Nouveau skill orchestrateur

`seo-monitor` devient l'entrée naturelle pour l'agent :

1. vérifier la santé des intégrations ;
2. déclencher ou récupérer le dernier run ;
3. lire les findings nouveaux/aggravés ;
4. consulter les preuves et le contexte projet ;
5. regrouper les findings corrélés ;
6. proposer les actions ;
7. générer le rapport ;
8. soumettre les propositions à validation.

### 11.6 Contrats de sortie

Tous les artefacts agentiques portent :

- `schema_version` ;
- `project_slug` ;
- `run_id` ;
- `finding_ids` ;
- `generated_at` ;
- `agent_version` ;
- `source_hashes` ;
- `confidence` ;
- `requires_approval` ;
- `next_skill` ;
- `status`.

Les tests d'intégration utilisent obligatoirement les outputs produits par les vrais scripts, pas des fixtures enrichies à la main.

---

## 12. Modèle d'autorisation et validation humaine

### 12.1 Niveaux

| Niveau | Exemple | Validation |
|---|---|---|
| L0 — observation | collecte, diff, rapport | automatique |
| L1 — opération réversible | retry, resync, IndexNow | automatique selon policy |
| L2 — brouillon | réponse avis, brief, plan de refresh | automatique, revue selon policy |
| L3 — publication externe | réponse avis positive, modification contenu | validation ou policy explicite |
| L4 — sensible/destructif | 301, canonical, suppression, désindexation, réponse négative | toujours humaine |

Les agents peuvent de manière autonome diagnostiquer, prioriser, créer un brouillon, préparer un patch et ouvrir une branche de proposition. Une validation humaine reste obligatoire avant publication de contenu, fusion vers la branche principale, redirection, canonical, suppression ou désindexation. Les réponses aux avis suivent leur policy dédiée et non une permission globale de l'agent.

### 12.2 Invariants

- Une approbation est liée au hash exact de la proposition.
- Toute modification du payload invalide l'approbation.
- Une approbation possède un auteur, une date et un périmètre.
- Un agent ne peut pas s'auto-accorder un scope supérieur.
- Les actions L4 ne peuvent pas être activées en auto par simple configuration projet.

### 12.3 Validation groupée

Le dashboard et Telegram permettent une validation groupée uniquement pour un lot homogène : même projet, même type d'action, même niveau de risque et même version de policy. L'écran récapitule chaque cible et chaque diff. Une approbation de lot conserve le hash de chaque proposition ; la modification d'un seul élément l'exclut du lot et requiert une nouvelle validation.

Les actions L4 ne sont jamais validables par un bouton « tout approuver ». Elles sont confirmées individuellement.

---

## 13. Dashboard cible

### 13.1 Accueil cross-projet

- santé globale ;
- projets en erreur ou données stale ;
- findings critiques/nouveaux/aggravés ;
- propositions à valider ;
- avis nécessitant une revue ;
- derniers runs ;
- tendances GSC, Plausible et réputation ;
- coûts/quota de la semaine ;
- accès au rapport consolidé.

### 13.2 Cockpit projet

Onglets proposés :

1. **Vue d'ensemble** ;
2. **Findings** ;
3. **Performance** ;
4. **Indexation** ;
5. **Mots-clés** ;
6. **Présence locale** ;
7. **Avis** ;
8. **Rapports** ;
9. **Automatisations** ;
10. **Paramètres**.

Les anciennes surfaces Articles/LinkedIn sortent de la navigation principale.

### 13.3 Vue finding

- titre clair ;
- statut, sévérité, priorité et confiance ;
- première/dernière apparition ;
- graphique de preuve ;
- URLs, queries et pages concernées ;
- observations sources ;
- explication déterministe ;
- analyse agent ;
- propositions liées ;
- historique des décisions ;
- boutons valider, rejeter, snooze, assigner et résoudre.

### 13.4 Vue automatisations

- calendrier des jobs ;
- état des intégrations ;
- dernière réussite ;
- erreur actuelle ;
- prochaines exécutions ;
- quotas ;
- politiques avis et IndexNow ;
- replay/retry ;
- logs structurés.

---

## 14. Rapports et notifications

### 14.1 Rapport hebdomadaire interne

Structure :

1. résumé exécutif cross-projet ;
2. projets nécessitant une intervention ;
3. nouveaux findings ;
4. findings aggravés ;
5. findings résolus ;
6. opportunités à fort impact ;
7. indexation ;
8. trafic et conversions ;
9. avis Google ;
10. actions proposées ;
11. validations demandées ;
12. santé des automatisations et données manquantes.

### 14.2 Rapport mensuel client

- langage non technique ;
- résultats, tendances et actions réalisées ;
- positions réelles et tendances GSC clairement séparées ;
- trafic/conversions si Plausible ;
- présence locale et avis ;
- indexation synthétique ;
- prochaines priorités ;
- lien tokenisé et export PDF/CSV.

Ce rapport est une phase suivant le rapport interne. Il doit pouvoir être généré et envoyé automatiquement après validation du template, avec une mise en avant de la valeur créée : leads, visibilité gagnée, problèmes corrigés, avis traités et prochaines actions. Le client ne reçoit jamais les prompts, coûts internes, erreurs techniques brutes ou recommandations non validées.

### 14.3 Notifications

Telegram est le canal opérationnel prioritaire. Le dashboard reste la source de vérité et affiche exactement le même état de proposition. Depuis Telegram, Jonathan peut consulter le résumé et les preuves, puis approuver, rejeter ou demander une révision pour les actions autorisées.

Sécurité Telegram :

- allowlist stricte des identifiants utilisateurs et chats ;
- webhook protégé par secret ;
- action tokenisée, à usage unique, liée au hash de la proposition et avec expiration ;
- prévention du rejeu et journalisation de l'identité Telegram ;
- vérification de l'état et de la policy juste avant exécution ;
- L4 confirmée individuellement, avec renvoi vers le dashboard si le contexte complet ne tient pas dans Telegram.

Notifications immédiates uniquement pour :

- intégration cassée ;
- run global échoué ;
- chute critique confirmée ;
- désindexation d'une page stratégique ;
- avis 1–2 étoiles ;
- job bloqué ou dead-letter ;
- action externe échouée après retry.

Le reste est regroupé dans le digest pour éviter la fatigue d'alerte.

---

## 15. Déploiement cible sur VPS

### 15.1 Stack Docker Compose

```text
reverse-proxy       Caddy ou équivalent, TLS
seo-stats-web       SvelteKit API + dashboard
seo-stats-worker    collecteurs, détecteurs, agents, rapports
seo-stats-scheduler création des jobs planifiés
seo-postgres        base opérationnelle
backup              dumps chiffrés + copie off-site
plausible           optionnel, stack séparée
plausible-db        PostgreSQL Plausible
plausible-clickhouse ClickHouse Plausible
```

Le scheduler peut être fusionné avec le worker au début, mais reste un rôle logique séparé.

### 15.2 Base de données

- PostgreSQL standard ;
- schémas explicites ;
- migrations versionnées ;
- aucune dépendance métier à une fonction Neon propriétaire ;
- Neon conservé comme base managée pendant le refactor et le premier déploiement VPS ;
- compatibilité PostgreSQL standard prouvée par les migrations et les tests ;
- éventuel cutover de Neon vers le VPS traité plus tard comme une migration indépendante, après validation des backups et tests de restauration.

### 15.3 Plausible auto-hébergé

Plausible Community Edition n'impose pas de coût de licence Plausible, mais utilise PostgreSQL et ClickHouse et entraîne un coût d'infrastructure et d'exploitation. La documentation officielle recommande au moins 2 Go de RAM pour Plausible et ClickHouse seuls. Pour héberger `seo-stats`, les workers et Plausible sur le même VPS, prévoir une marge supérieure et mesurer la charge réelle.

Recommandation de départ pour l'ensemble :

- 4 vCPU ;
- 8 Go RAM ;
- stockage SSD ;
- volume séparé ou quotas pour ClickHouse ;
- sauvegarde PostgreSQL quotidienne ;
- sauvegarde/export ClickHouse selon la politique de rétention ;
- monitoring disque obligatoire.

Cette taille est une recommandation d'exploitation, pas une exigence protocolaire.

Avec 5 projets au départ et 10 à 15 à horizon un an, la montée en charge se fait d'abord en ajustant la concurrence des workers, les quotas provider et les ressources du VPS. L'architecture ne doit pas exiger un service isolé par projet.

### 15.4 Agent runner sur VPS

Le runner est d'abord testé localement. Une fois les contrats, permissions et reprises validés, il devient un service `agent-runner` sur le VPS qui peut :

- cloner les repos autorisés ;
- créer un worktree par tâche ;
- charger les skills ;
- lire `seo-stats` avec un token scopé ;
- produire un patch ou une branche de proposition ;
- attendre l'approbation ;
- exécuter uniquement l'action approuvée ;
- supprimer le worktree temporaire après archivage.

Il ne reçoit pas de clé de production globale et ne pousse jamais directement sur la branche principale sans policy explicite.

### 15.5 Backups et reprise

- dump PostgreSQL quotidien ;
- sauvegarde off-site chiffrée ;
- rétention journalière/hebdomadaire/mensuelle ;
- test de restauration trimestriel ;
- sauvegarde des fichiers de configuration et projections ;
- secrets sauvegardés séparément ;
- procédure documentée de reprise du web, worker et scheduler.

---

## 16. Sécurité

### 16.1 Tokens de service

Remplacer la clé API globale par des tokens :

- hashés en base ;
- révocables ;
- expirables ;
- scopés par projet ;
- scopés par capacité (`read_findings`, `trigger_runs`, `create_proposals`, etc.) ;
- nommés par agent ;
- journalisés.

### 16.2 Secrets providers

- références de secrets dans les configurations ;
- stockage via Docker secrets ou secret store ;
- credentials Google chiffrés au repos ;
- rotation ;
- jamais de valeur dans les logs ;
- contrôle de validité et permissions minimales.

### 16.3 Audit

Journal append-only pour :

- changement de policy ;
- approbation/rejet ;
- envoi d'une réponse ;
- soumission IndexNow ;
- modification de contenu ;
- changement de token ;
- accès agent sensible ;
- action destructive.

---

## 17. Observabilité et fiabilité

### 17.1 États de santé

Chaque intégration expose :

- `healthy` ;
- `degraded` ;
- `stale` ;
- `auth_error` ;
- `quota_limited` ;
- `failed` ;
- `disabled`.

### 17.2 Métriques internes

- jobs queued/running/failed/dead ;
- durée par step/provider ;
- âge de la dernière observation ;
- nombre de findings par type/statut ;
- taux de faux positifs/dismiss ;
- propositions approuvées/rejetées ;
- temps moyen de validation ;
- réponses avis générées/envoyées/échouées ;
- coûts DataForSEO et LLM ;
- consommation de quotas ;
- taille DB et stockage.

### 17.3 SLO initiaux

- run hebdomadaire déclenché lundi 09:00 et terminé avant lundi 10:00 Europe/Zurich ;
- nouvel avis synchronisé en moins de 2 heures ;
- brouillon généré en moins de 15 minutes après synchronisation ;
- aucune double réponse ;
- reprise automatique après redémarrage worker ;
- rapport disponible même si un provider optionnel est en panne, avec statut `partial` ;
- finding critique notifié dans les 15 minutes après confirmation.

### 17.4 Budget par projet

Le plafond initial est **15 USD par projet et par mois** pour les coûts variables attribuables : LLM, DataForSEO et providers payants optionnels. Pour 5 projets, le plafond global est donc 75 USD/mois ; pour 10 à 15 projets, 150 à 225 USD/mois.

Ce plafond paraît confortable pour le MVP car GSC, URL Inspection, Google Business Profile et IndexNow n'ajoutent pas de coût unitaire direct, et Plausible Community Edition n'a pas de coût de licence. Il doit néanmoins être validé par 4 à 8 semaines de mesure réelle, surtout pour DataForSEO et les analyses agentiques longues.

Politique de contrôle :

- cible opérationnelle : rester sous 10 USD/projet/mois ;
- alerte douce à 70 % du plafond ;
- alerte forte et réduction des enrichissements optionnels à 90 % ;
- hard cap à 100 % pour DataForSEO, analyses LLM non critiques et providers optionnels ;
- GSC, avis, santé des intégrations, IndexNow et alertes critiques continuent même après le hard cap ;
- coût estimé affiché avant toute action manuelle coûteuse ;
- ventilation obligatoire par projet, provider, run, skill et type d'action.

Les coûts mutualisés du VPS, des sauvegardes et du stockage sont suivis séparément afin de ne pas fausser le coût marginal par projet.

---

## 18. Plan de migration

### Phase 0 — Stabilisation

- choisir `noyau/seo-stats` comme repo canonique ;
- arrêter la duplication avec `apps/jlabs-content-hub` ;
- terminer et committer la migration PostgreSQL ;
- aligner README, décisions, schémas et environnement ;
- vérifier les counts et contraintes de la base ;
- supprimer les références actives à Turso après cutover validé ;
- conserver un backup de l'ancienne base.

### Phase 1 — Contrats réels

- versionner les schémas JSON de GSC, indexation, weekly, actions et refresh queue ;
- corriger `index.buckets` vs `index.results` ;
- fournir le mapping query -> page réel ;
- tester les outputs producteurs réels ;
- remplacer les URLs/paths hub codés en dur ;
- étendre `project.yaml` avec `seo_stats`, `indexnow` et `plausible` ;
- implémenter la projection hashée.

### Phase 2 — Noyau jobs et observations

- tables runs/steps/queue ;
- worker durable ;
- leases, retry, idempotence et dead-letter ;
- migration des crons existants ;
- santé des intégrations ;
- normalisation des observations GSC ;
- historique complet d'indexation.

### Phase 3 — Findings et rapport hebdomadaire

- catalogue initial de détecteurs ;
- fingerprint et cycle de vie ;
- priorité/confiance ;
- rapport hebdomadaire cross-projet ;
- inbox dashboard ;
- notifications critiques.

### Phase 4 — Avis Google full-auto

- planifier la synchronisation ;
- générer automatiquement les brouillons ;
- ajouter les policies ;
- quality gates ;
- envoi différé ;
- validation des avis sensibles ;
- confirmation distante et audit ;
- dashboard SLA/réputation.

### Phase 5 — Indexation et IndexNow

- sitemap observations/diff ;
- inspection priorisée ;
- findings d'indexation ;
- IndexNow post-publication ;
- suppression de la soumission Google générique ;
- vue historique par URL.

### Phase 6 — Plausible

- provider configurable cloud/self-hosted ;
- snapshots page/site ;
- objectifs/conversions ;
- corrélation GSC + analytics ;
- findings trafic/conversion/404 ;
- intégration rapports.

### Phase 7 — Skills et agent loop

- CLI stable ;
- tokens scopés ;
- nouveau `seo-monitor` ;
- adaptation des skills existants ;
- proposals/approvals ;
- agent-runner et worktrees ;
- vérification post-action.

### Phase 8 — Dashboard final et VPS

- navigation cockpit ;
- pages findings, automatisations et rapports ;
- Docker Compose ;
- reverse proxy/TLS ;
- backups et monitoring ;
- migration depuis Neon/Vercel ;
- test de restauration et cutover.

### Phase 9 — Extensions

- rank tracking réel DataForSEO ;
- geo-grid ;
- backlinks ;
- visibilité IA ;
- concurrence ;
- rapport client avancé.

---

## 19. Tests et gates

### 19.1 Tests de contrat

- chaque producteur validé contre un JSON Schema ;
- chaque consommateur testé avec l'output réel du producteur ;
- version incompatible rejetée explicitement ;
- fixtures générées par les producteurs ou validées avec le même schéma.

### 19.2 Tests d'idempotence

- rerun GSC ;
- rerun IndexNow ;
- resync avis ;
- retry worker ;
- double clic d'approbation ;
- redémarrage pendant une exécution ;
- récupération d'un lease expiré.

### 19.3 Tests sécurité

- token sans scope ;
- token d'un autre projet ;
- secret absent ;
- logs sans valeur sensible ;
- approbation invalidée après modification ;
- tentative d'action L4 par agent.

### 19.4 Canary hebdomadaire

Fixture multi-projet couvrant :

- projet sain ;
- projet sans GSC ;
- baisse confirmée ;
- nouvelle query ;
- cannibalisation ;
- page désindexée ;
- quota inspection ;
- Plausible indisponible ;
- avis positif auto-éligible ;
- avis négatif bloqué ;
- IndexNow 200, 422 et 429 ;
- rapport `partial` mais exploitable.

### 19.5 Gate de release

Une release monitoring ne passe que si :

1. migrations DB réversibles et testées ;
2. contrats producteurs/consommateurs verts ;
3. canary multi-projet vert ;
4. aucune action sensible exécutée sans approbation ;
5. reprise worker prouvée ;
6. rapport généré avec provider optionnel en panne ;
7. backup et restauration testés pour un cutover VPS.

---

## 20. Critères d'acceptation produit

### MVP monitoring agentique

- [ ] Un bouton ou une commande lance un run hebdomadaire pour tous les projets.
- [ ] Le run survit à un redémarrage du worker.
- [ ] Les données GSC et d'indexation sont historisées.
- [ ] Les findings ne sont pas dupliqués chaque semaine.
- [ ] Chaque finding contient des preuves et une priorité.
- [ ] Un agent produit automatiquement le rapport consolidé.
- [ ] Jonathan peut valider/rejeter les propositions dans une inbox.
- [ ] Jonathan peut valider/rejeter depuis Telegram avec le même audit que dans le dashboard.
- [ ] Les skills consomment l'API/CLI `seo-stats` plutôt que des chemins codés en dur.
- [ ] Le coût variable est ventilé par projet et respecte un plafond configurable.

### Avis Google

- [ ] La synchronisation tourne automatiquement.
- [ ] Chaque nouvel avis reçoit un brouillon ou une erreur explicite.
- [ ] Les 5 étoiles éligibles peuvent être envoyés automatiquement après délai.
- [ ] Les avis 1–3 étoiles ne sont jamais envoyés automatiquement par défaut.
- [ ] Aucune double réponse n'est possible.
- [ ] Toutes les réponses envoyées sont vérifiées et auditées.

### Indexation

- [ ] Chaque URL inspectée possède un historique complet.
- [ ] Les transitions d'état créent ou résolvent des findings.
- [ ] Les inspections respectent une politique de quota.
- [ ] Les changements publiés sont envoyés à IndexNow si activé.
- [ ] Le reçu IndexNow n'est jamais affiché comme preuve d'indexation.
- [ ] La Google Indexing API générique est désactivée.

### Plausible

- [ ] Provider désactivable et non bloquant.
- [ ] URL cloud ou self-hosted configurable.
- [ ] Snapshots site et pages historisés.
- [ ] GSC et Plausible peuvent être corrélés dans un finding.
- [ ] Les conversions et 404 apparaissent dans les rapports lorsque configurées.
- [ ] Les formulaires, appels/clics téléphone et rendez-vous sont distingués et dédupliqués autant que possible.

### VPS

- [ ] Déploiement reproductible par Docker Compose.
- [ ] Web, worker et scheduler redémarrent automatiquement.
- [ ] TLS et secrets sont configurés hors images.
- [ ] Les sauvegardes sont off-site et une restauration est prouvée.
- [ ] Aucun composant obligatoire ne dépend de Vercel ou Neon.

---

## 21. Décisions validées

1. `seo-stats` est le nom du produit et `C:\Users\jojo-\Desktop\noyau\seo-stats` est le repo canonique.
2. PostgreSQL est la base opérationnelle portable.
3. Neon est stabilisé et peut rester la base managée lorsque l'application passe sur le VPS ; aucune dépendance Neon propriétaire n'est admise.
4. Le moteur de jobs est durable et séparé des requêtes web.
5. Les findings sont la primitive centrale du produit.
6. Les repos restent canoniques pour le métier et le contenu.
7. Les agents passent par une API/CLI versionnée et peuvent préparer diagnostics, propositions, patchs et branches.
8. Publication, fusion, redirection, canonical, suppression et désindexation restent soumises à validation humaine.
9. Les validations sont possibles depuis Telegram et le dashboard ; les lots homogènes peuvent être approuvés groupés.
10. Le run SEO hebdomadaire démarre le lundi à 09:00 Europe/Zurich ; les opérations urgentes gardent une cadence plus courte.
11. IndexNow est intégré comme notification post-publication.
12. La Google Indexing API est limitée aux types officiellement éligibles.
13. Plausible Community Edition auto-hébergée est la cible privilégiée, via un adapter restant compatible cloud.
14. Les conversions suivies incluent formulaires, appels/clics téléphone, rendez-vous et autres événements de lead configurés.
15. Les réponses aux avis passent par `draft_only`, puis `guarded_auto` après backtest et approbation ; les avis négatifs ou sensibles restent humains.
16. Telegram est le canal opérationnel principal ; le dashboard reste la source de vérité.
17. Le rapport client automatique vient après stabilisation et validation du rapport interne.
18. Le plafond de coûts variables est de 15 USD/projet/mois, avec cible à 10 USD et garde-fous progressifs.
19. Les observations détaillées sont conservées 24 mois et les agrégats/audits sans limite prédéfinie.
20. Le runner est testé localement puis déplacé sur le VPS.
21. Le dashboard est une projection de lecture/validation, pas la source de vérité du pipeline.

---

## 22. Décisions restant à confirmer

- seuil définitif de promotion des avis 4 étoiles vers l'auto-envoi, après données de backtest ;
- fournisseur et méthode de call tracking permettant de distinguer clic téléphone et appel réel ;
- date d'activation des rapports clients et niveau d'accès client aux findings/actions ;
- dimensionnement final du VPS après mesure locale et test de charge sur 5 projets ;
- maintien long terme de Neon ou migration ultérieure vers PostgreSQL auto-hébergé.

---

## 23. Références externes

- IndexNow — documentation protocole, soumission, clé et statuts : https://www.indexnow.org/documentation
- Google Indexing API — types de pages éligibles : https://developers.google.com/search/apis/indexing-api/v3/using-api
- Google Search Console API — quotas URL Inspection : https://developers.google.com/webmaster-tools/limits
- Plausible Stats API v2 : https://plausible.io/docs/stats-api
- Plausible Community Edition : https://github.com/plausible/community-edition
