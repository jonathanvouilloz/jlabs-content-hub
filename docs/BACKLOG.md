# Backlog produit et technique — seo-stats agentic monitoring

> **Version :** 1.0  
> **Date :** 2026-07-21  
> **Statut :** backlog de référence prêt à exécuter  
> **SPEC source :** `docs/SPEC.md` v0.2  
> **Produit et repo canonique :** `C:\Users\jojo-\Desktop\noyau\seo-stats`  
> **Capacité cible :** 5 projets au lancement, 10 à 15 projets sans refonte  
> **Objectif :** déléguer 90 % du monitoring récurrent à des agents, avec validation humaine des actions sensibles.

---

## 1. Mode d'emploi

Ce document est le backlog d'exécution. La SPEC reste la source de vérité pour les choix produit et les invariants. Un ticket ne peut pas modifier une décision de la SPEC sans ADR ou mise à jour explicite de celle-ci.

### 1.1 États

| État | Signification |
|---|---|
| `ICEBOX` | volontairement différé |
| `BLOCKED` | dépendance non livrée ou décision manquante |
| `READY` | suffisamment défini pour être pris |
| `IN_PROGRESS` | une personne ou un agent en est responsable |
| `IN_REVIEW` | implémenté, en validation |
| `DONE` | critères d'acceptation et Definition of Done satisfaits |

### 1.2 Priorités

| Priorité | Règle |
|---|---|
| `P0` | bloque le chemin critique, la sécurité ou l'intégrité des données |
| `P1` | nécessaire au jalon visé |
| `P2` | amélioration importante, non bloquante pour le MVP |
| `P3` | extension future ou optimisation |

### 1.3 Taille

| Taille | Interprétation |
|---|---|
| `S` | changement isolé, peu de dépendances |
| `M` | plusieurs fichiers ou une migration simple |
| `L` | vertical slice complet ou intégration externe |
| `XL` | doit être redécoupé avant démarrage |

Aucun ticket `XL` ne peut passer en `IN_PROGRESS`. Les tailles servent à limiter le work in progress, pas à promettre une date.

### 1.4 Règles d'exécution

- Une seule responsabilité principale par ticket.
- Un ticket possède un owner explicite avant `IN_PROGRESS`.
- Les migrations DB sont compatibles avec Neon et PostgreSQL standard.
- Toute collecte externe est idempotente, observable et rejouable.
- Toute action externe possède une idempotency key et une piste d'audit.
- Les agents travaillent sur des contrats versionnés et ne déduisent pas le schéma depuis du texte libre.
- Les secrets ne figurent ni dans les rapports, ni dans les prompts, ni dans les logs.
- Les actions L4 restent individuelles et humainement validées.
- Le dashboard lit le même état que la CLI, Telegram et les agents.

---

## 2. Definition of Ready

Un ticket est `READY` si :

- le résultat attendu est observable ;
- les dépendances sont terminées ou identifiées ;
- les tables, endpoints ou contrats touchés sont nommés ;
- les cas d'erreur principaux sont décrits ;
- les critères d'acceptation sont testables ;
- les fixtures et secrets requis sont disponibles ou simulables ;
- le niveau d'autorisation L0 à L4 est connu pour toute action externe.

## 3. Definition of Done globale

Un ticket est `DONE` si :

- le code, les migrations et la documentation sont livrés ensemble ;
- lint, typecheck et tests ciblés passent ;
- les tests de contrat utilisent de vrais outputs producteurs ;
- les erreurs et états vides sont couverts ;
- les logs structurés, métriques et traces d'audit nécessaires existent ;
- aucun secret ou PII inutile n'est exposé ;
- les migrations sont testées sur une base neuve et une base existante ;
- le rollback ou la désactivation par feature flag est documenté pour les changements risqués ;
- le comportement a été vérifié sur fixture, puis sur un projet canary lorsqu'un provider réel est concerné ;
- la SPEC ou l'ADR associé est à jour.

---

## 4. Jalons de livraison

| Jalon | Résultat exploitable | Epics principaux | Gate de sortie |
|---|---|---|---|
| `M0 — Ready to build` | repo canonique, contrats et environnement stabilisés | E00, début E01 | build et tests actuels verts, schémas validés |
| `M1 — Monitoring local fiable` | queue durable, GSC et indexation historisées localement | E01, E02, E03, E04 | un run multi-projet survit à un restart |
| `M2 — Cockpit hebdomadaire` | findings, inbox et rapport du lundi 09:00 | E05, E06, E07 | rapport complet sur les 5 projets canary |
| `M3 — Avis et validation` | pipeline GMB, Telegram et approbations auditables | E08, E09 | aucun double envoi, approvals sécurisées |
| `M4 — Analytics et leads` | Plausible CE, événements de conversion et diagnostics croisés | E10 | formulaires et rendez-vous visibles par projet |
| `M5 — Délégation agentique` | CLI/API, skills adaptés, propositions et branches | E11 | agent hebdo autonome jusqu'à validation humaine |
| `M6 — Production VPS et clients` | déploiement durable, backups, rapports clients | E12, E13 | restore prouvé et test de charge 15 projets |

### 4.1 Chemin critique

```text
E00 Stabilisation
  -> E01 Modèle de données
  -> E02 Jobs durables
  -> E03 Collecte GSC
  -> E05 Findings
  -> E06 Dashboard
  -> E07 Rapports
  -> E11 Agents et skills
  -> E12 VPS
```

E04 Indexation, E08 Avis, E09 Telegram et E10 Plausible avancent en parallèle dès que E01 et E02 sont stables.

### 4.2 Ordre de démarrage recommandé

1. terminer `GOV-001` à `GOV-005` ;
2. livrer le noyau `DATA-001` à `DATA-008` ;
3. construire la queue et le scheduler `JOB-001` à `JOB-007` ;
4. brancher un seul projet canary GSC + indexation ;
5. valider le modèle d'observations avant de brancher les quatre autres projets ;
6. livrer les findings et le rapport déterministe ;
7. ajouter l'agent de synthèse, puis le dashboard ;
8. activer les avis en `draft_only` ;
9. ouvrir les validations Telegram ;
10. ajouter Plausible et les conversions ;
11. déployer sur VPS après les gates locaux et canary.

---

# E00 — Gouvernance et stabilisation du repo

**Objectif :** disposer d'une seule base de code exécutable, documentée et réversible.  
**Jalon :** M0  
**Référence SPEC :** sections 1, 3, 18 phase 0.

## GOV-001 — Canoniser `noyau/seo-stats`

**Priorité :** P0 · **Taille :** S · **État :** READY · **Dépendances :** aucune

Travail :

- déclarer `C:\Users\jojo-\Desktop\noyau\seo-stats` comme seul repo applicatif actif ;
- marquer `jlabs-content-hub` comme legacy en lecture seule ;
- documenter les branches, remotes et la stratégie de migration des changements locaux ;
- ajouter un avertissement dans la documentation legacy.

Acceptation :

- une nouvelle contribution ne peut pas cibler le vieux hub par erreur ;
- le README canonique décrit clairement où développer, tester et déployer ;
- aucun fichier utilisateur non lié n'est écrasé pendant la consolidation.

## GOV-002 — Établir la baseline de build et de tests

**Priorité :** P0 · **Taille :** M · **État :** READY · **Dépendances :** GOV-001

Travail :

- inventorier les commandes install, lint, typecheck, unit, integration et build ;
- enregistrer les échecs préexistants séparément ;
- créer une commande de vérification reproductible ;
- produire un rapport baseline daté.

Acceptation :

- la même commande donne le même résultat sur deux exécutions propres ;
- tout futur échec est distinguable d'une dette préexistante ;
- le build ne nécessite aucun secret réel.

## GOV-003 — Normaliser la configuration runtime

**Priorité :** P0 · **Taille :** M · **État :** READY · **Dépendances :** GOV-001

Travail :

- centraliser la validation des variables d'environnement ;
- séparer web, worker, scheduler, agent et providers ;
- fournir `.env.example` sans secret ;
- échouer rapidement avec des erreurs non sensibles.

Acceptation :

- chaque rôle démarre avec uniquement les variables dont il a besoin ;
- une variable absente produit un diagnostic actionnable ;
- aucune valeur secrète n'apparaît dans les logs.

## GOV-004 — Auditer les dépendances Neon/Vercel/Turso

**Priorité :** P0 · **Taille :** M · **État :** READY · **Dépendances :** GOV-002

Travail :

- supprimer ou isoler les chemins Turso obsolètes ;
- lister les dépendances propriétaires Neon et Vercel ;
- créer des adapters lorsque la portabilité l'exige ;
- aligner README, scripts et migrations sur PostgreSQL.

Acceptation :

- aucune documentation active ne présente Turso comme base courante ;
- les fonctions métier n'appellent pas directement une primitive Neon propriétaire ;
- l'application peut utiliser une URL PostgreSQL standard.

## GOV-005 — Installer les feature flags de migration

**Priorité :** P1 · **Taille :** S · **État :** READY · **Dépendances :** GOV-003

Travail :

- définir des flags pour jobs v2, findings, IndexNow, Plausible, GMB auto-send, Telegram et agent runner ;
- supporter un override global et par projet ;
- journaliser les flags effectifs dans chaque run.

Acceptation :

- chaque vertical slice risqué peut être activé sur un seul canary ;
- désactiver un flag n'efface aucune donnée ;
- le rapport de run indique la configuration réellement appliquée.

---

# E01 — Modèle de données et migrations PostgreSQL

**Objectif :** créer les primitives durables communes à tous les providers, diagnostics et agents.  
**Jalon :** M0–M1  
**Référence SPEC :** sections 7 et 15.2.

## DATA-001 — Cartographier et figer le schéma existant

**Priorité :** P0 · **Taille :** M · **État :** DONE (2026-07-21, cf. `docs/DATA-001-cartography.md`) · **Dépendances :** GOV-002
> Reste ouvert : **DATA-001b** — fixture DB anonymisée (différée de DATA-001).

Travail :

- inventorier tables, index, contraintes et données existantes ;
- identifier les doublons entre anciens snapshots et nouvelles observations ;
- produire la stratégie expand/migrate/contract ;
- créer une fixture DB anonymisée.

Acceptation :

- chaque table existante a un sort documenté : conserver, migrer ou retirer ;
- la migration ne suppose pas une base vide ;
- les volumes et clés naturelles sont connus.

## DATA-002 — Créer `project_integrations` et `project_projections`

**Priorité :** P0 · **Taille :** M · **État :** DONE (2026-07-21, phase expand — tables + helpers ; backfill/migrate en phase suivante) · **Dépendances :** DATA-001

Travail :

- ajouter intégrations, scopes, statut, fraîcheur et références de secrets ;
- stocker les projections de contexte avec hash, version et provenance ;
- empêcher le stockage de secrets dans les projections ;
- indexer par projet et provider.

Acceptation :

- un projet peut avoir plusieurs propriétés/localisations sans collision ;
- une projection inchangée n'est pas dupliquée ;
- un changement de hash est visible et audité.

## DATA-003 — Créer `monitoring_runs`, `monitoring_steps` et `jobs`

**Priorité :** P0 · **Taille :** L · **État :** DONE (2026-07-21, phase expand — 3 tables + helpers purs/écriture ; claim atomique = JOB-001, migrate/contract en phase suivante) · **Dépendances :** DATA-001

Travail :

- modéliser run logique, tentative, step et job ;
- inclure statut, timestamps, lease, retry, idempotency key et erreur normalisée ;
- ajouter contraintes et index de réclamation ;
- prévoir `daily`, `weekly`, `monthly`, `manual` et `post_publish`.

Acceptation :

- un run partiel distingue succès, skip, échec et provider optionnel indisponible ;
- deux créations concurrentes avec la même clé ne créent pas deux runs logiques ;
- les requêtes de queue utilisent un index vérifié.

## DATA-004 — Créer le modèle d'observations

**Priorité :** P0 · **Taille :** L · **État :** DONE (2026-07-21, phase expand — 10 tables §7.5 + helpers purs/upserts ancrés ; backfill par lots = migrate/contract en phase suivante) · **Dépendances :** DATA-001

Travail :

- définir les tables ou partitions GSC, indexation, sitemap, analytics et réputation ;
- conserver période, dimensions, source, fetched_at et schema_version ;
- séparer données normalisées et payload brut borné ;
- définir les uniques d'upsert.

Acceptation :

- deux collectes identiques ne dupliquent pas les observations ;
- les observations restent traçables jusqu'au run et au provider ;
- les requêtes 7/28/90 jours sont couvertes par des index.

## DATA-005 — Créer `findings` et `finding_events`

**Priorité :** P0 · **Taille :** M · **État :** DONE (2026-07-22, phase expand — 2 tables + helpers purs/écriture, appliqué sur Neon ; détecteur = DATA-006) · **Dépendances :** DATA-004

Travail :

- implémenter fingerprint, type, sévérité, priorité, confiance et statut ;
- créer le journal append-only des changements ;
- relier les preuves sans les recopier dans du texte libre ;
- indexer l'inbox cross-projet.

Acceptation :

- le même problème sur deux semaines conserve le même finding ;
- toute transition possède un événement, une cause et un auteur ;
- supprimer une observation référencée est interdit ou géré par politique.

## DATA-006 — Créer propositions, approbations et agent runs

**Priorité :** P0 · **Taille :** L · **État :** DONE (2026-07-22, phase expand — 3 tables [action_proposals + proposal_approvals + agent_runs] + helpers purs/écriture, appliqué sur Neon ; agent/exécuteur = aval) · **Dépendances :** DATA-005

Travail :

- ajouter `action_proposals`, payload versionné, hash et niveau L0–L4 ;
- modéliser approbation, rejet, expiration et invalidation ;
- enregistrer les agent runs, modèles, tokens, coûts et sources ;
- relier exécution et vérification à la proposition exacte.

Acceptation :

- modifier un payload invalide son approbation ;
- un agent ne peut pas élever son propre niveau ;
- chaque action externe remonte à une proposition ou une policy versionnée.

## DATA-007 — Créer les politiques d'avis et d'automatisation

**Priorité :** P1 · **Taille :** M · **État :** DONE (2026-07-22) · **Dépendances :** DATA-002

> Livré : `review_automation_policies` (versionnée, une seule courante par scope) + `policy_promotions`
> (journal append-only). Modes `draft_only|guarded_auto|manual`, kill switch global/localisation,
> seuils/délai/jitter/plages/catégories d'escalade, version. Invariants purs (`policy-state.ts`) :
> kill switch bloque les envois sans bloquer la sync ; versionnage → aucune ancienne proposition ne
> profite d'une nouvelle policy ; toute promotion journalisée. 52 tables, zéro dérive · test 144/144.

Travail :

- stocker modes `draft_only`, `guarded_auto`, `manual` ;
- ajouter seuils, délai, jitter, plages horaires, catégories d'escalade et version ;
- tracer toute promotion de policy ;
- prévoir un kill switch global et par localisation.

Acceptation :

- aucune ancienne proposition ne profite silencieusement d'une nouvelle policy ;
- le kill switch bloque les envois sans bloquer la synchronisation ;
- la policy effective est visible dans l'audit.

## DATA-008 — Implémenter rétention, agrégation et purge

**Priorité :** P1 · **Taille :** L · **État :** DONE — expand + dry-run (2026-07-22) · **Dépendances :** DATA-004, DATA-005

> Livré (périmètre **expand + dry-run, aucune suppression réelle**) : `retention_policies` (configurable
> par type, seedée §7.11), `observation_aggregates` (rollups week/month/year, idempotents),
> `purge_runs` (observable + reprenable). Invariants purs (`retention-state.ts`) : protégé/infini jamais
> purgé, audit = L4, buckets de période déterministes. Runner `scripts/purge.ts` DRY-RUN annonce lignes +
> périodes exactes (vérifié Neon : 76 446 lignes ciblées à réf. 2030) ; `--execute` refusé. 55 tables,
> zéro dérive · test 172/172. **Reste (tâche séparée)** : activer l'exécution destructive (agrégation →
> delete par lots, reprise via checkpoint, L4 pour audit) + purge column-level `debug_payload`.

Travail :

- agréger semaine/mois/année avant purge ;
- conserver 24 mois de détail et les agrégats sans limite prédéfinie ;
- conserver audit, findings et décisions ;
- fournir dry-run, métriques et reprise de purge.

Acceptation :

- le dry-run annonce exactement lignes et périodes touchées ;
- aucun agrégat requis n'est supprimé ;
- une suppression d'audit exige L4 ;
- la purge peut reprendre après interruption sans double effet.

---

# E02 — Queue durable, scheduler et workers

**Objectif :** exécuter les automatisations hors requêtes web, avec reprise et idempotence.  
**Jalon :** M1  
**Référence SPEC :** sections 6.2 et 8.

## JOB-001 — Réclamation atomique des jobs

**Priorité :** P0 · **Taille :** M · **État :** DONE (2026-07-22 — `claimJob` FOR UPDATE SKIP LOCKED en une instruction, lease/owner/attempt, complete/fail/release gardés par `lease_owner`, boucle `runWorker` arrêtable ; preuve d'unicité sur Neon via `scripts/job-claim-concurrency.ts` 21/21 ; reaper de baux morts = JOB-002) · **Dépendances :** DATA-003

Travail :

- implémenter `FOR UPDATE SKIP LOCKED` ;
- définir owner, lease, `started_at` et `attempt` ;
- empêcher deux workers de posséder le même job ;
- fournir une boucle worker stoppable proprement.

Acceptation :

- un test concurrent prouve l'unicité de réclamation ;
- un arrêt gracieux ne crée pas de job fantôme ;
- les jobs non réclamables ne bloquent pas la file.

## JOB-002 — Lease, heartbeat et récupération après crash

**Priorité :** P0 · **Taille :** M · **État :** DONE (2026-07-22 — `renewLease` + heartbeat 3×/bail dans `runWorker` ; reaper `reclaimExpiredLeases` en transaction `FOR UPDATE SKIP LOCKED` sur `idx_jobs_lease`, `UPDATE` gardé par `lease_owner` **et** `lease_until` ; `classifyAbandonedLease` sépare `worker_death` de `lease_stall`, budget de durée du runner → `ProviderTimeout` ; journal append-only `job_attempts` + `scripts/jobs-inspect.ts` ; exactly-once via `job_effects` + `guardExternalEffect` (claim-then-apply) ; passe de reaper au démarrage et sur les tours à vide + `scripts/reap.ts`. Preuve sur Neon : `scripts/job-002-recovery-proof.ts` 27/27. UI = JOB-007 ; cron dédié = JOB-005) · **Dépendances :** JOB-001

Travail :

- renouveler les leases longs ;
- détecter les workers morts ;
- remettre en queue selon la politique de retry ;
- distinguer timeout provider et crash local.

Acceptation :

- tuer un worker pendant un run entraîne une reprise automatique ;
- deux exécutions ne produisent pas deux effets externes ;
- l'interface montre la tentative abandonnée et la reprise.

## JOB-003 — Retry, backoff et dead-letter

**Priorité :** P0 · **Taille :** M · **État :** **DONE** (2026-07-22 — `job-retry.ts` : 4 classes, jitter injecté, `deferJob` pour le quota, dead-letter + `requeueDeadJob`. 55 tests vitest + preuve Neon 44/44) · **Dépendances :** JOB-001

Travail :

- classifier erreurs retryables, auth, quota et permanentes ;
- appliquer backoff avec jitter ;
- borner les tentatives ;
- créer la dead-letter et l'action de reprise.

Acceptation :

- 429 et 5xx sont retentés conformément à la policy ;
- 400/403 structurels ne bouclent pas ;
- une reprise manuelle conserve l'historique des tentatives.

## JOB-004 — Dépendances entre steps et état `partial`

**Priorité :** P0 · **Taille :** L · **État :** **DONE** (2026-07-22 — `job-graph.ts` : garde de dépendance DANS `claimJob`, arêtes obligatoires/optionnelles, statut `skipped`, passe `settleBlockedJobs` jumelle du reaper, `latestAttemptPerStep` pour le statut final du run. 38 tests vitest + preuve Neon 45/45, zéro DDL) · **Dépendances :** JOB-001

Travail :

- implémenter DAG de steps ;
- définir dépendances obligatoires et optionnelles ;
- calculer le statut final du run ;
- propager skip et erreurs sans masquer les résultats disponibles.

Acceptation :

- Plausible indisponible ne bloque pas un rapport GSC ;
- un collecteur GSC échoué bloque les détecteurs qui en dépendent ;
- le rapport indique précisément les données manquantes.

## JOB-005 — Scheduler timezone-aware

**Priorité :** P0 · **Taille :** M · **État :** **DONE** (2026-07-22 — `schedule-state.ts` (pur, `Intl`, aucune dépendance) : cadences hourly/daily/weekly/monthly, créneau nommé en heure LOCALE, heure inexistante qui glisse et heure doublée résolue à la première occurrence ; `scheduler.ts` : `planDueJobs` (fenêtre de rattrapage 6 h, idempotent par créneau local, **zéro DDL**), `listNextOccurrences`, `schedulePostPublish` (J+3/J+7/J+28 via `available_at`) ; route `/api/cron/tick` (`0 * * * *`) qui **planifie PUIS draine** la file ; panneau Planification sur `/jobs` ; `scripts/schedule.ts` dry-run par défaut. 40 tests vitest + preuve Neon 33/33. Détail : `docs/features/e00-fondations-cockpit.md`) · **Dépendances :** JOB-001

Travail :

- planifier le run hebdo lundi 09:00 `Europe/Zurich` ;
- gérer heure d'été/hiver ;
- créer les cadences hourly, daily, monthly et post-publish ;
- empêcher le double déclenchement après restart.

Acceptation :

- les tests couvrent les deux changements DST ;
- un restart à 09:00 ne crée qu'un run logique ;
- la prochaine exécution est visible par projet.

## JOB-006 — Limites de concurrence et quotas provider

**Priorité :** P1 · **Taille :** M · **État :** **DONE** (2026-07-23 — module pur `job-limits.ts` (plafonds, tour d'équité, refroidissement provider), garde `ClaimCapacity` dans `claimJob`, passe `coolDownQuotaLimitedJobs`, panneau « Capacité & quotas » sur `/jobs`, `jobs-inspect --capacity`, `scripts/limits.ts` ; **1 DDL** : `system_settings`. Détail : `docs/features/e00-fondations-cockpit.md`) · **Dépendances :** JOB-003

Travail :

- limiter concurrence globale, par provider et par projet ;
- réserver une capacité aux alertes et avis ;
- exposer les quotas restants ;
- éviter qu'un projet bloque les autres.

Acceptation :

- un site volumineux ne monopolise pas les workers ;
- les limites sont configurables sans redéploiement ;
- les reports continuent avec statut `quota_limited` lorsque possible.

## JOB-007 — Console d'exploitation des jobs

**Priorité :** P1 · **Taille :** M · **État :** **DONE** (2026-07-22 — pages `/jobs` et `/jobs/[id]`, actions `/api/ops/jobs/[id]/{cancel,requeue}`, `cancelJob` ajoutée à `jobs-claim.ts` ; aucun DDL. Détail : `docs/features/e00-fondations-cockpit.md`) · **Dépendances :** JOB-002, JOB-003

Travail :

- lister queued/running/failed/dead ;
- permettre retry ciblé, annulation et inspection ;
- exposer durée, attempts, erreur et dépendances ;
- sécuriser les actions d'exploitation.

Acceptation :

- un opérateur peut comprendre un échec sans lire directement la DB ;
- retry et annulation sont audités ;
- aucune opération ne permet de modifier arbitrairement le payload.

---

# E03 — Google Search Console et historique SEO

**Objectif :** disposer de données GSC normalisées, fraîches et comparables.  
**Jalon :** M1  
**Référence SPEC :** section 9.1.

## GSC-001 — Adapter d'authentification multi-projet

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** DATA-002, GOV-003

Travail :

- associer propriété GSC, credentials et scopes à chaque projet ;
- tester l'accès et distinguer auth, permission et propriété absente ;
- rafraîchir les tokens sans les exposer ;
- afficher la fraîcheur de l'intégration.

Acceptation :

- les cinq projets peuvent être testés indépendamment ;
- une erreur d'un projet n'affecte pas les autres ;
- aucun credential n'est stocké dans un payload de job.

## GSC-002 — Collecteur `query × page × device`

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** GSC-001, DATA-004, JOB-004

Travail :

- paginer intégralement l'API Search Analytics ;
- collecter clics, impressions, CTR et position ;
- normaliser query, URL, device, dates et timezone ;
- upsert idempotent par période/dimensions.

Acceptation :

- un rerun retourne les mêmes totaux sans duplication ;
- pagination et lignes nulles sont testées ;
- les totaux expliquent leurs différences avec l'interface GSC lorsque les dimensions diffèrent.

## GSC-003 — Réparer les contrats réels producteurs/consommateurs

**Priorité :** P0 · **Taille :** M · **État :** READY · **Dépendances :** GOV-002

Travail :

- versionner le schéma de sortie réel de `seo-gsc` ;
- retirer l'hypothèse erronée d'un champ `page` dans `top_queries` ;
- adapter weekly/actions/refresh sans fixture enrichie manuellement ;
- ajouter contract tests à partir des vrais scripts.

Acceptation :

- la fixture est produite par le collecteur réel ;
- supprimer un champ du producteur casse le test du consommateur ;
- la refresh queue reçoit une URL uniquement depuis une source qui la fournit réellement.

## GSC-004 — Fenêtres de comparaison et backfill

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** GSC-002

Travail :

- calculer 7 jours, 28 jours, 90 jours et année précédente si disponible ;
- rendre la période finale configurable selon la latence GSC ;
- backfiller par tranches bornées ;
- signaler les périodes incomplètes.

Acceptation :

- aucun delta n'est calculé entre périodes de longueurs incompatibles ;
- le backfill est reprenable ;
- un manque de données baisse la confiance au lieu de produire un faux signal.

## GSC-005 — Watchlist et suivi de positions

**Priorité :** P1 · **Taille :** M · **État :** BLOCKED · **Dépendances :** GSC-002

Travail :

- migrer la watchlist existante ;
- enregistrer target URL, locale, importance et fréquence ;
- produire historique et mouvements ;
- distinguer position GSC agrégée d'un rank tracker externe.

Acceptation :

- les rapports ne présentent jamais la position GSC comme un classement SERP exact ;
- un changement de target URL est audité ;
- les mots-clés prioritaires peuvent recevoir une fréquence DataForSEO distincte.

## GSC-006 — Fraîcheur, quotas et qualité des données

**Priorité :** P1 · **Taille :** M · **État :** BLOCKED · **Dépendances :** GSC-002, JOB-006

Travail :

- exposer dernière collecte complète et couverture ;
- suivre pagination, quotas, lignes et durée ;
- détecter chute artificielle liée à une collecte partielle ;
- créer health states `healthy`, `stale`, `quota_limited`, `auth_error`, `failed`.

Acceptation :

- une collecte partielle ne déclenche pas une alerte SEO de baisse ;
- le dashboard explique la fraîcheur ;
- les métriques permettent d'estimer la charge pour 15 projets.

---

# E04 — Indexation, sitemap et IndexNow

**Objectif :** suivre l'état réel des URLs et notifier les changements sans confondre soumission et indexation.  
**Jalon :** M1–M2  
**Référence SPEC :** sections 9.2 à 9.4.

## IDX-001 — Inventaire sitemap et canonical

**Priorité :** P0 · **Taille :** M · **État :** DONE (2026-07-25) · **Dépendances :** DATA-004, JOB-004

Travail :

- découvrir sitemap index et sitemaps enfants ;
- normaliser URLs, locales, lastmod et canonical attendu ;
- historiser ajouts, retraits et changements ;
- signaler sitemaps invalides ou inaccessibles.

Acceptation :

- un sitemap diff est reproductible et lié à deux snapshots ;
- redirects et fragments sont normalisés ;
- aucune URL supprimée n'est automatiquement désindexée.

## IDX-002 — Collecteur URL Inspection persistant

**Priorité :** P0 · **Taille :** L · **État :** DONE (2026-07-25) · **Dépendances :** GSC-001, DATA-004

Travail :

- inspecter une URL via la propriété correcte ;
- persister verdict, coverage state, canonical Google/utilisateur, crawl et sitemap ;
- conserver payload brut borné et schema version ;
- distinguer erreur provider et résultat non indexé.

Acceptation :

- chaque inspection possède un historique ;
- un rerun ne détruit pas l'état précédent ;
- le statut UI est dérivé de champs persistés, pas d'un appel à la volée.

## IDX-003 — Réparer le contrat `seo-index-diagnose`

**Priorité :** P0 · **Taille :** S · **État :** READY · **Dépendances :** GOV-002

Travail :

- versionner le vrai output utilisant `buckets` ;
- adapter `post_publication.py` qui attend actuellement `results` ;
- remplacer les fixtures trompeuses ;
- ajouter compatibilité ou migration explicite de version.

Acceptation :

- le pipeline post-publication consomme un output produit par le vrai script ;
- le test échoue sur un changement de shape non versionné ;
- aucune branche silencieuse ne traite zéro URL par erreur.

## IDX-004 — Politique de sélection et quotas d'inspection

**Priorité :** P1 · **Taille :** M · **État :** **DONE le 2026-07-25** (lot 1 noyau + lot 2 producteurs) · **Dépendances :** IDX-001, IDX-002, JOB-006

Travail :

- ~~prioriser pages stratégiques, nouvelles, modifiées, findings et échantillon tournant~~ (lot 1) ;
- ~~réserver du quota aux vérifications urgentes~~ (lot 1 — ordre + canal `scope: 'due'` + réserve cross-projet) ;
- ~~planifier J+3, J+7 et J+28~~ (lot 2 — `scheduleIndexChecks` appelée par la route de publication,
  cadence quotidienne `scope: 'due'` + `detect:index_transition` en arête obligatoire) ;
- ~~permettre audit manuel borné~~ (lot 2 — `scripts/inspect-urls.ts`, **dry-run par défaut**, soumis
  au même budget que la politique).

Acceptation :

- le quota ne peut pas être consommé entièrement par l'échantillon ;
- chaque sélection expose sa raison ;
- une inspection manquée est replanifiée sans duplication.

## IDX-005 — Détecteur de transitions d'indexation

**Priorité :** P0 · **Taille :** M · **État :** DONE (2026-07-25 — `index_transition@1` : trois types §10.4 (`index_drop`, `crawled_not_indexed`, `discovered_not_indexed`), confirmation après 2 observations consécutives (`unknown` neutre, `excluded` jamais un drop), sévérité plafonnée tant que non confirmé, `critical` + `notifyImmediately` réservés à la désindexation confirmée d'une page stratégique (**le signal ; le canal reste TEL-002**), et `reconcileDetectionRun` doté d'un **`scope`** — une URL non ré-inspectée n'est jamais auto-résolue. **Zéro DDL**, 809/809 tests, preuve Neon 31/31. ⚠️ **Inerte** tant qu'IDX-004 n'alimente pas l'inspection ; **pas au catalogue hebdo** — il y entre avec IDX-004) · **Dépendances :** IDX-002, DATA-005

Travail :

- comparer les états consécutifs ;
- créer/aggraver/résoudre les findings ;
- protéger contre les résultats incohérents ponctuels ;
- notifier immédiatement la désindexation d'une page stratégique après confirmation.

Acceptation :

- une transition stable crée un événement unique ;
- une fluctuation isolée baisse la confiance ou attend confirmation ;
- la résolution conserve l'historique complet.

## IDX-006 — Gestion des clés IndexNow

**Priorité :** P1 · **Taille :** M · **État :** BLOCKED · **Dépendances :** DATA-002

Travail :

- créer/gérer une clé valide par hôte ou politique ;
- vérifier le fichier de preuve ;
- tester host, keyLocation et URLs soumises ;
- exposer l'état de configuration.

Acceptation :

- une clé invalide bloque uniquement IndexNow ;
- aucune clé n'est exposée dans le dashboard ou les logs ;
- le test d'intégration explique comment corriger le fichier de preuve.

## IDX-007 — Outbox et client IndexNow idempotent

**Priorité :** P1 · **Taille :** L · **État :** BLOCKED par IDX-006 seulement (JOB-003 livré : retry classé + `job_effects`/`guardExternalEffect` pour l'exactly-once de l'outbox) · **Dépendances :** IDX-006, JOB-003

Travail :

- créer l'outbox sur publication/modification/suppression confirmée ;
- dédupliquer par URL, content hash et event type ;
- batcher sous la limite interne ;
- gérer 200/202, 400/403/422 et 429.

Acceptation :

- un succès est affiché comme « reçu », jamais « indexé » ;
- un rerun ne renvoie pas le même événement sans raison ;
- 429 est retenté et les erreurs permanentes sont visibles.

## IDX-008 — Restreindre Google Indexing API

**Priorité :** P0 · **Taille :** S · **État :** READY · **Dépendances :** GOV-004

Travail :

- désactiver la soumission générique des pages ;
- autoriser uniquement JobPosting et BroadcastEvent/VideoObject ;
- ajouter validation de type avant appel ;
- documenter sitemap/maillage/inspection comme chemin normal.

Acceptation :

- un article standard ne peut pas appeler l'Indexing API ;
- les types éligibles ont un test positif ;
- toute tentative refusée est auditée sans consommer le quota.

---

# E05 — Moteur de findings et diagnostic

**Objectif :** transformer les observations en problèmes et opportunités stables, priorisés et explicables.  
**Jalon :** M2  
**Référence SPEC :** section 10.

## FIND-001 — Framework commun de détecteurs

**Priorité :** P0 · **Taille :** L · **État :** DONE (2026-07-22 — contrat input/output versionné (`detector_version`), module pur `detector-state.ts` + IO `detectors/keyword-opportunity.ts` + runner `scripts/detect.ts` ; preuves/période/score/confiance/fingerprint imposés ; un détecteur par projet/run avec `monitoring_run`+`step`. Dépendance GSC-004 contournée : le détecteur tourne sur les observations backfillées, fenêtres hebdo comparables via `areWindowsComparable`) · **Dépendances :** DATA-005, GSC-004

Travail :

- définir interface input/output versionnée ;
- imposer preuves, période, score, confiance et fingerprint ;
- exécuter un détecteur par projet/run ;
- enregistrer version et paramètres.

Acceptation :

- un détecteur est rejouable sur un snapshot figé ;
- deux versions peuvent être comparées ;
- aucune explication IA n'est requise pour établir le fait.

## FIND-002 — Scoring priorité et confiance

**Priorité :** P0 · **Taille :** M · **État :** READY (partiellement couvert le 2026-07-22 : impact/urgence/confiance/strategic-fit calculés et bornés par `computePriorityScore` (§10.2), signaux à faible volume plafonnés à `medium` — reste à faire : poids documentés PAR TYPE de finding et override audité) · **Dépendances :** FIND-001

Travail :

- implémenter impact, urgence, confiance et strategic fit ;
- documenter les poids par type ;
- plafonner les signaux à faible volume ;
- permettre override audité.

Acceptation :

- le score est calculable à partir des preuves ;
- un override demande une raison ;
- les findings sans données suffisantes n'atteignent pas une priorité critique.

## FIND-003 — Cycle de vie, déduplication et snooze

**Priorité :** P0 · **Taille :** M · **État :** DONE (2026-07-22 — 5 colonnes additives sur `findings` ; purs `canTransition`/`decideOnRedetection`/`decideOnAbsence`/`isSnoozeExpired` ; IO `snoozeFinding`/`dismissFinding`/`reopenFinding`/`expireSnoozes`/`reconcileDetectionRun` ; closure = `matched` COMPLET (jamais la liste tronquée) + run autoritaire + N absences consécutives ; job `findings:lifecycle` ; preuve Neon 37/37. Décisions : le snooze tient jusqu'à échéance, le dismiss vaut à vie) · **Dépendances :** FIND-001

Travail :

- implémenter open, acknowledged, planned, snoozed, resolved et dismissed ;
- gérer aggravation et réouverture ;
- éviter la recréation hebdomadaire ;
- intégrer feedback faux positif.

Acceptation :

- un problème persistant n'apparaît qu'une fois dans l'inbox ;
- une résolution puis récidive produit une réouverture ;
- le snooze expire automatiquement.

## FIND-004 — Opportunités de mots-clés

**Priorité :** P0 · **Taille :** M · **État :** DONE (2026-07-22 — `keyword_opportunity@1` : impressions + position exploitable + CTR sous cible, seuils configurables par projet (projection), bruit navigationnel/marque exclu par configuration, verdict porté par `recommended_skill=seo-refresh`. 13 findings réels écrits sur 3 projets. Aucune page publiée automatiquement) · **Dépendances :** FIND-001

Travail :

- détecter impressions significatives avec position améliorable ;
- combiner CTR, position, tendance, target URL et valeur stratégique ;
- exclure navigational/bruit configuré ;
- proposer action type refresh, création ou snippet.

Acceptation :

- chaque opportunité montre query, page, périodes et deltas ;
- les seuils sont configurables par projet ;
- aucune nouvelle page n'est automatiquement publiée.

## FIND-005 — Baisses de mots-clés et pages

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** FIND-001

Travail :

- détecter pertes clics/impressions/position sur 7 et 28 jours ;
- pondérer volume, saisonnalité disponible et qualité de collecte ;
- regrouper query et page corrélées ;
- distinguer baisse réelle et changement de périmètre.

Acceptation :

- une collecte partielle ne crée pas de baisse ;
- le finding explique le niveau de confirmation ;
- une récupération résout ou améliore le finding existant.

## FIND-006 — Nouvelles, perdues et émergentes

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** FIND-001

Travail :

- détecter nouvelles requêtes et requêtes disparues ;
- imposer volume minimal ou croissance répétée ;
- regrouper variantes proches sans masquer les termes ;
- router vers analyse d'intention.

Acceptation :

- une requête à une impression ne pollue pas le rapport par défaut ;
- les preuves contiennent première/dernière apparition ;
- le regroupement est réversible et inspectable.

## FIND-007 — CTR gap et target URL mismatch

**Priorité :** P1 · **Taille :** M · **État :** BLOCKED · **Dépendances :** FIND-001, GSC-005

Travail :

- comparer CTR à une baseline par plage de position ;
- détecter la page classée différente de la target ;
- tenir compte de marque/non-marque et device ;
- proposer snippet, alignement ou maillage.

Acceptation :

- le benchmark utilisé est affiché ;
- aucune recommandation de canonical/redirect n'est exécutée automatiquement ;
- le finding disparaît après correction durable.

## FIND-008 — Cannibalisation persistante

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** FIND-001

Travail :

- détecter une query associée à plusieurs URLs normalisées ;
- calculer dominance, alternance, durée et chevauchement ;
- distinguer cas légitime et conflit probable ;
- proposer analyse agentique sans décision destructive.

Acceptation :

- un conflit n'est créé qu'après persistance minimale ;
- les URLs, métriques et alternances sont visibles ;
- merge, redirect et canonical restent L4.

## FIND-009 — Anomalies croisées GSC/indexation/analytics

**Priorité :** P1 · **Taille :** L · **État :** BLOCKED · **Dépendances :** FIND-001, IDX-005, ANA-006

Travail :

- corréler visibilité, clics, visites, leads, 404 et indexation ;
- produire des hypothèses explicitement marquées comme telles ;
- distinguer panne de tracking et baisse SEO ;
- prioriser pages à fort potentiel de conversion.

Acceptation :

- le finding sépare faits et inférences ;
- un provider absent donne `partial`, pas zéro ;
- les corrélations sont rejouables sur fixtures.

## FIND-010 — Boucle de qualité et réduction du bruit

**Priorité :** P1 · **Taille :** M · **État :** READY · **Dépendances :** FIND-003

Travail :

- enregistrer dismiss, cause, modification et résultat ;
- mesurer faux positifs par détecteur/version ;
- proposer ajustements de seuils ;
- comparer avant/après sans modifier automatiquement les règles.

Acceptation :

- le dashboard expose le taux de dismiss ;
- une nouvelle version peut être backtestée sur l'historique ;
- toute modification de seuil est versionnée et approuvée.

---

# E06 — Dashboard et cockpit de validation

**Objectif :** offrir une interface de supervision rapide, non technique et fidèle à l'état opérationnel.  
**Jalon :** M2–M3  
**Référence SPEC :** section 13.

## DASH-001 — Navigation et design system du cockpit

**Priorité :** P1 · **Taille :** M · **État :** BLOCKED · **Dépendances :** GOV-002

Travail :

- définir navigation cross-projet, projet, inbox, automatisations et rapports ;
- réutiliser les composants accessibles existants ;
- créer les états loading, empty, stale, partial et error ;
- rendre desktop et mobile utilisables pour les validations.

Acceptation :

- les cinq zones principales sont atteignables en deux interactions ;
- l'état des données n'est jamais confondu avec une valeur zéro ;
- les contrôles clavier et contrastes essentiels sont vérifiés.

## DASH-002 — Accueil cross-projet

**Priorité :** P0 · **Taille :** L · **État :** READY (débloqué par JOB-004, 2026-07-22) · **Dépendances :** DATA-005, JOB-004

Travail :

- afficher santé globale, projets à risque et fraîcheur ;
- regrouper nouveaux/aggravés/résolus ;
- afficher validations, avis et derniers runs ;
- afficher coûts et quotas de la période.

Acceptation :

- Jonathan identifie en moins d'une minute les projets nécessitant une action ;
- chaque compteur ouvre une liste filtrée cohérente ;
- une intégration cassée est distincte d'une baisse de performance.

## DASH-003 — Cockpit projet

**Priorité :** P0 · **Taille :** L · **État :** **EN COURS — lot 1 (vue d'ensemble + timeline) DONE le 2026-07-25**, lot 2 restant · **Dépendances :** DASH-001 *(avancé sans lui, comme DASH-002 — la barre d'onglets projet est livrée ici)*, GSC-004, IDX-005

Travail :

- ~~afficher score de santé et explication~~ (lot 1 — **deux axes, pas de score chiffré** : décision
  reprise de DASH-002, un nombre unique fusionnerait « la donnée n'arrive pas » et « la donnée est
  mauvaise ». La carte vient de `loadHomeCockpit`, jamais recalculée) ;
- présenter GSC, indexation, réputation et analytics → **partiel** : GSC, indexation et diagnostic
  au lot 1 ; réputation et analytics au **lot 2** (Plausible n'a pas de read-model) ;
- ~~montrer timeline des runs/findings/actions~~ (lot 1 — décisions lues dans `action_proposals`,
  y compris celles sans finding) ;
- donner accès aux integrations et policies → **lot 2** (l'onglet Paramètres existe, les policies
  n'ont pas d'écran).

Acceptation :

- chaque métrique affiche période, fraîcheur et source ;
- un provider désactivé n'est pas présenté comme une erreur ;
- les décisions passées sont accessibles depuis la timeline.

## DASH-004 — Vue finding avec preuves

**Priorité :** P0 · **Taille :** M · **État :** DONE (2026-07-23) · **Dépendances :** FIND-003

Livré : `/inbox/findings/[id]` — faits, preuves brutes (`evidence_json`, aucune synthèse IA),
journal, propositions issues, et acknowledge/snooze/dismiss/reopen avec **raison obligatoire** via
les fonctions FIND-003. Les actions offertes sont dérivées de `canTransition` (§10.1), donc l'écran
ne propose jamais un geste que l'écriture refuserait.

Travail :

- afficher faits, périodes, URLs, queries et score ;
- séparer diagnostic déterministe et synthèse IA ;
- montrer historique et findings liés ;
- proposer acknowledge, snooze, dismiss et création d'action.

Acceptation :

- aucune affirmation ne manque de source identifiable ;
- l'utilisateur peut contester un finding avec une raison ;
- l'action proposée indique son niveau d'autorisation.

## DASH-005 — Inbox de propositions et validation groupée

**Priorité :** P0 · **Taille :** L · **État :** DONE (2026-07-23) · **Dépendances :** DATA-006

Livré : `/inbox` (onglets propositions/findings), `/inbox/proposals/[id]`, et les endpoints
`/api/ops/proposals/**`. Les 4 acceptations sont prouvées en base
(`scripts/dash-005-inbox-proof.ts`). Le statut **`changes_requested`** est ajouté au vocabulaire —
il porte « request changes » sans éditeur de payload, et échappe volontairement à
`decideSupersession` pour qu'une demande humaine survive au run hebdomadaire. **Réserve :** aucune
approbation n'est exécutée (pas de handler d'exécution), et les propositions sans `finding_id`
n'ont pas de journal où écrire leur raison de rejet.

Travail :

- lister propositions par risque, projet et type ;
- afficher diff/payload, preuves, coût et expiration ;
- gérer approve, reject et request changes ;
- grouper uniquement lots homogènes.

Acceptation :

- chaque approbation est liée au hash exact ;
- modifier une proposition l'exclut du lot ;
- L4 n'a pas de bouton « tout approuver » ;
- une double soumission UI reste idempotente.

## DASH-006 — Vue automatisations et jobs

**Priorité :** P1 · **Taille :** M · **État :** **DONE** (2026-07-26 — lot 1 : page `/automations`,
modules `automations-state.ts` (pur) + `automations.ts` (lecture), filtre `run` sur `/jobs`, compteur
`runs_period` de l'accueil enfin cliquable, **aucun DDL** · lot 2 : `automation_pauses`, journal
**append-only** dont l'état effectif se DÉRIVE, trois portées, 4ᵉ passe worker + garde d'admission —
**1 DDL**, 59 → 60 tables. Détail : `docs/features/e00-fondations-cockpit.md`) ·
**Dépendances :** JOB-007 (**DONE depuis le 2026-07-22** — la mention `BLOCKED` qui figurait ici
était périmée)

Travail :

- ~~afficher calendrier, prochain run et derniers résultats~~ (lot 1) ;
- ~~exposer queue, dead-letter et retries~~ (déjà couvert par `/jobs`, JOB-007 ; le lot 1 y
  ajoute le filtre par run) ;
- ~~montrer flags, quotas et policies effectives~~ (lot 1, panneau « Règles effectives ») ;
- ~~permettre pause/reprise autorisée~~ (lot 2, trois portées : cadence, projet, provider).

Acceptation :

- une panne est diagnostiquable sans accès serveur → **tenue au lot 1**, et au-delà de ce qui
  était visé : un job mort laissait une ligne, un **créneau jamais tiré** n'en laisse aucune.
  Seul le croisement créneau calculé ↔ run observé le révèle ;
- pause et reprise sont auditables → **tenue au lot 2** : `automation_pauses` est un journal
  append-only (auteur, cause, date, échéance) dont l'état effectif se **dérive** — il n'existe aucun
  état persisté qui puisse diverger de son historique. Raison **obligatoire dans les deux sens**,
  reprise comprise. Rejouer un geste est un **non-événement** (idempotence dans la transaction), pas
  une erreur ;
- la désactivation d'un provider n'annule pas les autres steps → **tenue au lot 2**, et prouvée en
  base : couper `gsc` fait sauter ses 3 collecteurs **et** leur dépendant obligatoire (propagation
  JOB-004, le `skipped` étant lu comme prérequis mort), pendant que `findings:lifecycle` **reste en
  file** — il ne sort pas de Postgres. Le run vaut `partial`, jamais `failed`.

## DASH-007 — Vue coûts et capacité

**Priorité :** P1 · **Taille :** M · **État :** BLOCKED · **Dépendances :** OPS-005

Travail :

- afficher dépense par projet/provider/skill ;
- comparer cible 10 USD et plafond 15 USD ;
- exposer projections de fin de mois ;
- montrer actions bridées par budget.

Acceptation :

- les totaux sont rapprochables des factures provider ;
- une dépense non attribuée est visible ;
- le hard cap et sa cause sont compréhensibles.

---

# E07 — Rapports internes et clients

**Objectif :** produire des synthèses fiables et actionnables sans assemblage manuel.  
**Jalon :** M2 puis M6 pour le client  
**Référence SPEC :** section 14.

## REP-001 — Modèle de rapport hebdomadaire déterministe

**Priorité :** P0 · **Taille :** M · **État :** READY (débloqué par JOB-004, 2026-07-22) · **Dépendances :** FIND-003, JOB-004

Travail :

- assembler état global, données manquantes et findings ;
- trier nouveaux, aggravés, résolus et opportunités ;
- inclure indexation, avis, conversions et coûts si disponibles ;
- produire JSON versionné avant rendu texte.

Acceptation :

- un rapport peut être généré sans LLM ;
- un provider optionnel absent apparaît comme absent, pas comme zéro ;
- chaque item renvoie au finding ou à l'observation source.

## REP-002 — Synthèse agentique sourcée

**Priorité :** P1 · **Taille :** L · **État :** BLOCKED · **Dépendances :** REP-001, AGT-001

Travail :

- fournir à l'agent uniquement le contexte nécessaire ;
- générer résumé, regroupements et top actions ;
- imposer citations internes de finding IDs ;
- valider la sortie par schéma.

Acceptation :

- l'agent ne peut pas inventer une métrique ;
- toute recommandation pointe vers au moins une preuve ;
- un échec LLM conserve le rapport déterministe.

## REP-003 — Publication du rapport du lundi

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** REP-001, JOB-005

Travail :

- déclencher lundi 09:00 Europe/Zurich ;
- attendre les steps obligatoires avec deadline ;
- publier un état complete ou partial avant 10:00 ;
- notifier disponibilité et incidents.

Acceptation :

- un seul rapport logique existe par semaine ;
- il reste accessible après restart ;
- le SLO avant 10:00 est mesuré.

## REP-004 — Historique, comparaison et archivage

**Priorité :** P1 · **Taille :** M · **État :** BLOCKED · **Dépendances :** REP-001

Travail :

- versionner données, template et agent ;
- comparer deux rapports ;
- archiver décisions et outcomes ;
- adapter `seo-archive` à ce rôle.

Acceptation :

- régénérer un rapport ne remplace pas silencieusement l'original ;
- les changements de template sont traçables ;
- les liens restent valides après rétention du détail.

## REP-005 — Template de rapport client

**Priorité :** P2 · **Taille :** L · **État :** BLOCKED · **Dépendances :** REP-003, ANA-005

Travail :

- créer une narration non technique orientée valeur ;
- inclure visibilité, leads, avis, corrections et prochaines priorités ;
- exclure coûts/prompts/incidents internes ;
- prévoir branding et commentaires opérateur.

Acceptation :

- un rapport client ne révèle aucun projet tiers ;
- les leads séparent clics, soumissions et confirmations ;
- le template est humainement validé avant activation automatique.

## REP-006 — Export et distribution client

**Priorité :** P2 · **Taille :** L · **État :** BLOCKED · **Dépendances :** REP-005, SEC-005

Travail :

- générer HTML/PDF et CSV de métriques autorisées ;
- créer lien tokenisé expirant ;
- ajouter envoi email configurable ;
- tracer ouverture et distribution sans tracking intrusif.

Acceptation :

- un token expiré ou révoqué ne donne plus accès ;
- l'export correspond aux données affichées ;
- aucun envoi automatique ne part avant activation explicite par projet.

---

# E08 — Google Business Profile et avis

**Objectif :** automatiser la synchronisation, la génération et l'envoi contrôlé des réponses.  
**Jalon :** M3  
**Référence SPEC :** section 9.6.

## GMB-001 — Intégrations comptes et localisations

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** DATA-002, GOV-003

Travail :

- associer compte, établissement, projet et credentials ;
- tester scopes et droits d'écriture ;
- gérer plusieurs localisations par projet ;
- exposer santé et dernière synchronisation.

Acceptation :

- aucune réponse ne peut partir vers la mauvaise localisation ;
- un compte lecture seule reste utilisable pour le monitoring ;
- les erreurs auth sont isolées.

## GMB-002 — Synchronisation horaire idempotente

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** GMB-001, JOB-005

Travail :

- collecter nouveaux avis et réponses distantes ;
- gérer fenêtre de rattrapage/curseur ;
- dédupliquer par review ID ;
- détecter modifications et suppressions.

Acceptation :

- deux syncs ne créent pas deux avis ;
- une réponse faite manuellement chez Google est importée ;
- un avis modifié invalide le brouillon associé.

## GMB-003 — Projection de contexte pour réponses

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** DATA-002, GMB-001

Travail :

- compiler identité, voix, équipe, établissement et interdits ;
- hasher et versionner la projection ;
- bloquer les faits d'équipe non canoniques ;
- signaler projection stale ou incomplète.

Acceptation :

- chaque draft référence le hash utilisé ;
- aucune donnée d'un autre projet n'entre dans le prompt ;
- un contexte stale force la validation.

## GMB-004 — Génération de brouillons structurés

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** GMB-002, GMB-003

Travail :

- adapter `gmb-review-responder` à un contrat JSON versionné ;
- générer dans la langue de l'avis ;
- personnaliser sans inventer ;
- enregistrer modèle, prompt version, coût et confiance.

Acceptation :

- tout nouvel avis obtient un draft ou une erreur explicite ;
- relancer avec la même idempotency key ne crée pas plusieurs propositions ;
- le texte ne contient ni PII inutile ni fait non sourcé.

## GMB-005 — Quality gate et classification sensible

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** GMB-004

Travail :

- vérifier longueur, ton, langue, répétition et formulations interdites ;
- détecter juridique, santé, sécurité, remboursement, accusation et abus ;
- produire PASS/REVIEW/BLOCK avec raisons ;
- empêcher l'auto-envoi en cas d'ambiguïté.

Acceptation :

- les cas sensibles de fixture sont tous routés en validation ;
- le gate est déterministe autant que possible ;
- une erreur de gate bloque l'envoi, jamais la conservation du draft.

## GMB-006 — State machine de policy et envoi différé

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED par GMB-005 seulement (DATA-007 et JOB-003 livrés : policies versionnées + retry classé et jitter réutilisable pour l'envoi différé) · **Dépendances :** DATA-007, GMB-005, JOB-003

Travail :

- implémenter `draft_only`, `guarded_auto` et `manual` ;
- programmer délai 8 h et jitter ±90 min par défaut ;
- relire avis, réponse distante et policy juste avant envoi ;
- permettre annulation et kill switch.

Acceptation :

- aucun auto-envoi n'est possible en `draft_only` ;
- seuls les 5 étoiles éligibles partent en `guarded_auto` initial ;
- 1–3 étoiles et sensible restent humains ;
- un changement d'avis ou de policy annule l'envoi planifié.

## GMB-007 — Envoi, vérification distante et anti-doublon

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** GMB-006

Travail :

- verrouiller l'envoi par review ID ;
- utiliser une idempotency key applicative ;
- relire la réponse distante après écriture ;
- enregistrer succès, divergence et échec.

Acceptation :

- les tests concurrents prouvent zéro double réponse ;
- un timeout après écriture vérifie avant retry ;
- une divergence distante produit une alerte et ne boucle pas.

## GMB-008 — Backtest et promotion des policies

**Priorité :** P1 · **Taille :** M · **État :** BLOCKED · **Dépendances :** GMB-005, DASH-005

Travail :

- rejouer au moins 30 avis historiques par projet ;
- observer au moins 20 avis réels en draft ;
- mesurer acceptation, retouches et erreurs critiques ;
- soumettre une proposition de promotion versionnée.

Acceptation :

- zéro erreur critique est requis ;
- le taux sans retouche substantielle atteint le seuil de policy, initialement 95 % ;
- la promotion nécessite une approbation humaine explicite ;
- un rollback en `draft_only` est immédiat.

---

# E09 — Telegram et approbations distantes

**Objectif :** notifier et valider rapidement sans affaiblir les garanties du dashboard.  
**Jalon :** M3  
**Référence SPEC :** sections 12.3 et 14.3.

## TEL-001 — Bot, webhook et allowlist

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** GOV-003, SEC-001

Travail :

- créer le bot et le webhook protégé par secret ;
- limiter user IDs et chat IDs ;
- séparer environnement test et production ;
- journaliser événements sans contenu sensible excessif.

Acceptation :

- un utilisateur non autorisé ne peut ni lire ni agir ;
- un webhook sans secret valide est rejeté ;
- la rotation du token est documentée.

## TEL-002 — Notifications critiques et digest

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** TEL-001, REP-003

Travail :

- envoyer intégration cassée, chute critique, désindexation, avis 1–2 et dead-letter ;
- publier le digest hebdomadaire ;
- dédupliquer et regrouper ;
- inclure liens profonds vers le dashboard.

Acceptation :

- une alerte répétée ne spamme pas ;
- l'état resolved peut fermer ou compléter l'alerte ;
- le digest est envoyé même si le rapport est `partial`.

## TEL-003 — Tokens d'action sécurisés

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** DATA-006, TEL-001

Travail :

- créer tokens à usage unique, expirants et liés au hash ;
- prévenir rejeu et double clic ;
- vérifier utilisateur, policy et statut au moment de l'action ;
- invalider après modification ou expiration.

Acceptation :

- rejouer un callback ne produit pas deux actions ;
- un token d'une proposition ne fonctionne pas sur une autre ;
- l'audit relie Telegram ID, proposition et résultat.

## TEL-004 — Flux approuver/rejeter/réviser

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** TEL-003

Travail :

- présenter résumé, preuves, risque et coût ;
- implémenter approve, reject et request changes ;
- demander une raison de rejet/révision ;
- renvoyer au dashboard quand le contexte est trop long.

Acceptation :

- Telegram et dashboard affichent le même état après action ;
- une action expirée explique la marche à suivre ;
- L4 exige confirmation individuelle et contexte complet.

## TEL-005 — Validation groupée homogène

**Priorité :** P1 · **Taille :** M · **État :** BLOCKED · **Dépendances :** TEL-004, DASH-005

Travail :

- créer lots par projet/type/risque/policy ;
- résumer toutes les cibles ;
- approuver chaque hash individuellement dans une transaction logique ;
- exclure les items modifiés.

Acceptation :

- aucun lot ne mélange projets ou niveaux de risque ;
- un item invalide n'autorise pas les autres silencieusement sans compte rendu ;
- L4 est exclu des lots.

---

# E10 — Plausible et mesure des leads

**Objectif :** relier visibilité SEO, trafic réel et conversions client.  
**Jalon :** M4  
**Référence SPEC :** sections 9.5 et 15.3.

## ANA-001 — Environnement Plausible CE local

**Priorité :** P1 · **Taille :** L · **État :** READY · **Dépendances :** GOV-003

Travail :

- démarrer Plausible CE, PostgreSQL et ClickHouse en stack isolée ;
- documenter initialisation, upgrade et sauvegarde ;
- créer un site de test ;
- mesurer RAM, CPU et disque.

Acceptation :

- le stack redémarre sans perte de configuration ;
- les versions sont épinglées ;
- la charge de base est documentée avant dimensionnement VPS.

## ANA-002 — Adapter Stats API cloud/self-hosted

**Priorité :** P1 · **Taille :** L · **État :** BLOCKED · **Dépendances :** ANA-001, DATA-002

Travail :

- rendre base URL, site ID et token configurables ;
- tester les endpoints réellement disponibles en CE ;
- normaliser erreurs, pagination et périodes ;
- conserver compatibilité Plausible Cloud.

Acceptation :

- le même contrat applicatif fonctionne sur CE et sur fixture cloud ;
- une fonction premium absente est marquée unsupported ;
- aucun appel analytics ne bloque un run GSC.

## ANA-003 — Snapshots analytics agrégés

**Priorité :** P1 · **Taille :** L · **État :** BLOCKED · **Dépendances :** ANA-002, DATA-004

Travail :

- collecter visiteurs, visites, pages vues, engagement, landing pages, referrers et 404 ;
- conserver agrégats jour/semaine par page ;
- normaliser URL et timezone ;
- appliquer rétention sans copier les événements bruts inutiles.

Acceptation :

- les totaux sont rapprochables de Plausible ;
- les URLs rejoignent les URLs GSC normalisées ;
- un rerun est idempotent.

## ANA-004 — Registre canonique des conversions

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** DATA-002

Travail :

- définir event name, lead type, statut, valeur optionnelle et déduplication ;
- configurer formulaire, téléphone et rendez-vous par projet ;
- distinguer intent, clic, soumission et confirmation ;
- versionner les mappings.

Acceptation :

- un clic téléphone n'est jamais affiché comme appel confirmé ;
- une ouverture de formulaire n'est pas une soumission ;
- modifier un mapping ne réécrit pas silencieusement l'historique.

## ANA-005 — Instrumentation des événements de lead

**Priorité :** P1 · **Taille :** L · **État :** BLOCKED · **Dépendances :** ANA-004, ANA-002

Travail :

- fournir snippets/contrats pour formulaires, tel links et rendez-vous ;
- ajouter event ID lorsque possible ;
- tester les événements sur un site canary ;
- documenter consentement et données exclues.

Acceptation :

- aucune donnée de formulaire personnelle n'est envoyée à Plausible ;
- une soumission test apparaît une seule fois ;
- le projet peut activer chaque événement indépendamment.

## ANA-006 — Diagnostics croisés GSC/Plausible

**Priorité :** P1 · **Taille :** L · **État :** BLOCKED · **Dépendances :** ANA-003, ANA-005, FIND-001

Travail :

- détecter divergence clics/visites, trafic/leads et 404/impressions ;
- prioriser pages à forte conversion et faible visibilité ;
- signaler panne tracking probable ;
- produire confiance selon couverture.

Acceptation :

- faits et hypothèses sont séparés ;
- l'absence d'événement configuré ne vaut pas zéro conversion ;
- les scénarios sont couverts par fixtures.

## ANA-007 — Adapter de call tracking

**Priorité :** P2 · **Taille :** L · **État :** BLOCKED · **Dépendances :** ANA-004, décision fournisseur

Travail :

- évaluer un provider ou webhook de confirmation d'appel ;
- relier clic et appel sans PII inutile ;
- gérer appels manqués/qualifiés si disponibles ;
- documenter coût et limites.

Acceptation :

- les rapports distinguent clic, appel et appel qualifié ;
- les événements sont dédupliqués ;
- le provider respecte le plafond budget ou exige une exception approuvée.

---

# E11 — API, CLI, agents et skills

**Objectif :** donner aux agents des outils structurés pour diagnostiquer et préparer des actions sans accès implicite aux secrets.  
**Jalon :** M5  
**Référence SPEC :** section 11.

## AGT-000 — Producteur déterministe de propositions

**Priorité :** P0 · **Taille :** M · **État :** **DONE** (2026-07-22 — `proposer-state.ts` (pur) : catalogue fermé de 11 `action_type`, table figée des niveaux L0–L4, payload canonique STABLE dans le temps, sélection/troncature exposant `matched` complet, supersession, auto-approbation bornée ; `proposers/finding-proposer.ts` : IO client injecté, `agent_run` ouvert/clos, `finding_event` `agent_comment` ; lecture `listFindings`/`getFindingWithEvidence` ajoutée à `findings.ts` ; job `propose:actions` + catalogue `weekly` ; `scripts/propose.ts` dry-run par défaut. 49 tests purs + 1 sur le catalogue hebdo, preuve Neon 41/41, **zéro DDL**. Détail : `docs/features/e00-fondations-cockpit.md`) · **Dépendances :** DATA-006, DATA-007, FIND-003

Ticket ajouté au backlog en cours de route : aucun n'existait pour ce maillon. La chaîne SPEC
(`observations → détecteurs → findings → analyse agent → propositions → approbation`) s'arrêtait
après `findings`, et les couches amont comme aval étaient toutes deux construites — seul le
passage de l'une à l'autre manquait. `AGT-005C` (« le skill `seo-actions` transforme des findings
persistés en propositions ») couvre le même besoin **côté skill**, mais reste BLOCKED par
`AGT-002` (l'API) : ce ticket-ci fait le travail **en base**, sans dépendre d'aucune API.

Travail :

- dériver de chaque finding une action typée, dotée d'un niveau L0–L4 **figé** ;
- produire un payload versionné, hashé et **stable dans le temps** (la dédup en dépend) ;
- borner le volume par projet et par run, sans jamais tronquer en silence ;
- périmer les propositions rendues obsolètes, sans réécrire une décision prise ;
- journaliser l'invocation (`agent_runs`) et la trace côté finding.

Acceptation :

- rejouer le producteur sur des findings inchangés ne crée aucune proposition ;
- un agent ne peut approuver ni une L3 ni une L4, et rien ne part sans policy explicite ;
- un finding en veille, dismissé ou résolu ne produit aucune proposition.

## AGT-001 — API agent v1 en lecture

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** DATA-005, SEC-001

Travail :

- exposer projets, santé, runs, findings, preuves et rapports ;
- versionner réponses et pagination ;
- appliquer scopes par projet et ressource ;
- ajouter rate limits et audit.

Acceptation :

- un token projet A ne lit jamais le projet B ;
- chaque réponse porte `schema_version` et fraîcheur ;
- les secrets provider ne sont jamais sérialisés.

## AGT-002 — API de propositions et validations

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** DATA-006, AGT-001

Travail :

- créer proposition, commentaire et request changes ;
- exposer approve/reject aux rôles humains ;
- vérifier hash, niveau et policy ;
- rendre les écritures idempotentes.

Acceptation :

- un agent peut proposer mais pas s'approuver ;
- une approbation périmée est refusée ;
- chaque mutation possède auteur, scope et audit.

## AGT-003 — CLI `seo-stats`

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** AGT-001, AGT-002

Travail :

- implémenter projects, health, runs, findings, proposals, reviews, reports et integrations ;
- fournir sortie humaine et `--json` ;
- définir codes de sortie stables ;
- charger endpoint/token depuis config sécurisée.

Acceptation :

- toutes les commandes de la SPEC existent ou retournent explicitement unsupported ;
- JSON est validé par schéma ;
- aucun parsing de texte humain n'est nécessaire à un agent.

## AGT-004 — Nouveau skill `seo-monitor`

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** AGT-003, REP-001

Travail :

- vérifier intégrations et dernier run ;
- lire findings nouveaux/aggravés ;
- regrouper, prioriser et proposer ;
- générer le rapport puis soumettre les validations.

Acceptation :

- le skill n'appelle pas directement les providers en chemin normal ;
- il fonctionne sur un projet ou tous les projets ;
- chaque conclusion cite les IDs sources ;
- un provider manquant produit un rapport partiel explicite.

## AGT-005 — Adapter les skills SEO post-production

**Priorité :** P0 · **Taille :** XL · **État :** BLOCKED · **Dépendances :** AGT-003, GSC-003, IDX-003

Découpage obligatoire avant démarrage :

### AGT-005A — Adapter `seo-gsc`

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** AGT-003, GSC-003

Le skill utilise l'API/CLI pour les lectures normales. L'accès provider direct devient un mode `debug/fallback` explicite. La sortie exportée reste versionnée et compatible avec les consommateurs réels.

### AGT-005B — Adapter `seo-weekly`

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** AGT-003, REP-003

Le skill déclenche ou lit un run central, attend son état terminal borné et rend le rapport existant. Il ne relance pas une collecte parallèle hors queue.

### AGT-005C — Adapter `seo-actions`

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** AGT-002, FIND-003

Le skill transforme uniquement des findings persistés en propositions sourcées, scorées et dotées d'un niveau L0–L4. Il ne modifie ni contenu ni provider.

### AGT-005D — Adapter `seo-index-diagnose`

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** AGT-003, IDX-003, IDX-005

Le skill approfondit un finding d'indexation, consomme les observations historiques et demande une inspection supplémentaire seulement via un job quota-aware.

### AGT-005E — Adapter `seo-cannibalisation`

**Priorité :** P1 · **Taille :** M · **État :** BLOCKED · **Dépendances :** AGT-003, FIND-008

Le skill classe les conflits centralisés, explique les intentions et prépare des options. Redirect, merge et canonical restent des propositions L4.

### AGT-005F — Adapter `seo-refresh`

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** AGT-002, SEC-003

Le skill n'agit que sur une proposition éditoriale approuvée, vérifie son hash et son scope, produit un patch isolé et repasse lint/review/build avant restitution.

### AGT-005G — Adapter `seo-audit`

**Priorité :** P1 · **Taille :** M · **État :** BLOCKED · **Dépendances :** AGT-003, REP-004

Le skill devient un audit mensuel ou manuel qui enrichit les observations existantes, sans dupliquer le run hebdomadaire ni recollecter par défaut les providers.

### AGT-005H — Adapter `seo-archive`

**Priorité :** P1 · **Taille :** S · **État :** BLOCKED · **Dépendances :** AGT-003, REP-004

Le skill archive rapports, décisions et artefacts agentiques. Les observations opérationnelles restent gérées par PostgreSQL et la politique de rétention.

Acceptation de l'epic :

- aucun chemin absolu vers l'ancien Content Hub ou Turso ;
- les skills utilisent API/CLI versionnée ;
- les anciens modes directs sont explicitement `debug` ou retirés ;
- chaque skill possède fixture et contract test.

## AGT-006 — Adapter `gmb-review-responder`

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** GMB-004, AGT-003

Travail :

- lire la queue depuis `seo-stats` ;
- produire le contrat de draft attendu ;
- permettre revue/régénération ciblée ;
- interdire l'envoi direct hors pipeline policy.

Acceptation :

- le skill ne nécessite pas de secret Google ;
- une régénération invalide l'ancienne proposition ;
- aucun texte ne peut contourner le quality gate.

## AGT-007 — Préparation autonome de patchs et branches

**Priorité :** P1 · **Taille :** L · **État :** BLOCKED · **Dépendances :** AGT-002, AGT-005F, SEC-003

Travail :

- créer worktree isolé par proposition ;
- exécuter skill, tests et build du projet ;
- produire diff, résumé et preuves ;
- attendre validation avant merge/publication.

Acceptation :

- l'agent n'écrit pas sur la branche principale ;
- le diff correspond au hash approuvé ;
- les fichiers hors scope sont refusés ;
- un worktree échoué reste inspectable puis nettoyable.

## AGT-008 — Runner local et sandbox de permissions

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** AGT-003, SEC-003

Travail :

- exécuter localement avec identité de service scopée ;
- isoler repo, réseau, commandes et secrets ;
- limiter durée, tokens et coût ;
- enregistrer stdout/stderr expurgés et résultat.

Acceptation :

- le runner ne peut pas lire un secret hors scope ;
- timeout et interruption sont propres ;
- toute tentative d'action non autorisée est bloquée et auditée.

## AGT-009 — Évaluation et non-régression agentique

**Priorité :** P1 · **Taille :** L · **État :** BLOCKED · **Dépendances :** AGT-004, AGT-006

Travail :

- constituer golden set de findings, rapports, réponses et propositions ;
- scorer exactitude, preuves, priorité, ton et respect des permissions ;
- comparer versions de modèle/prompt/skill ;
- bloquer promotion sur régression critique.

Acceptation :

- les hallucinations métriques sont détectées ;
- un changement de modèle produit un rapport comparatif ;
- les résultats de backtest sont archivés et auditables.

---

# E12 — Sécurité, observabilité et contrôle des coûts

**Objectif :** rendre le système exploitable sans angle mort et borner son risque financier/opérationnel.  
**Jalon :** transversal M0–M6  
**Référence SPEC :** sections 16 et 17.

## SEC-001 — Identités, rôles et tokens scopés

**Priorité :** P0 · **Taille :** L · **État :** READY · **Dépendances :** GOV-003

Travail :

- définir admin, operator, agent monitor, agent executor et client viewer ;
- créer tokens de service hashés, révocables et expirants ;
- limiter scopes par projet/action ;
- séparer comptes humains et services.

Acceptation :

- la matrice d'autorisation possède tests positifs et négatifs ;
- la révocation prend effet sans redéploiement ;
- aucun token complet n'est relisible depuis la DB.

## SEC-002 — Gestion et rotation des secrets providers

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** SEC-001

Travail :

- stocker références de secrets, pas valeurs dans les projets ;
- définir injection par rôle runtime ;
- ajouter rotation et validation ;
- expurger logs, erreurs et prompts.

Acceptation :

- une rotation n'exige pas de modifier les données métier ;
- les tests recherchent les motifs de secret dans les artefacts ;
- un agent de lecture ne reçoit aucun secret provider.

## SEC-003 — Enforcement L0–L4

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** DATA-006, SEC-001

Travail :

- centraliser la décision d'autorisation ;
- appliquer le même contrôle à API, CLI, UI, Telegram et worker ;
- forcer validation pour publication, merge, redirect, canonical, suppression et désindexation ;
- exclure L4 des lots.

Acceptation :

- aucun canal ne contourne la policy centrale ;
- une tentative L4 agentique est refusée et alertée ;
- les réponses positives suivent uniquement la policy GMB versionnée.

## SEC-004 — Journal d'audit append-only

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** DATA-006

Travail :

- journaliser qui, quoi, quand, canal, avant/après et résultat ;
- chaîner propositions, approvals, exécutions et vérifications ;
- protéger intégrité et accès ;
- fournir export incident.

Acceptation :

- toute action externe est reconstructible ;
- l'audit ne peut pas être modifié par un agent ;
- les données sensibles sont minimisées.

## SEC-005 — Accès client isolé

**Priorité :** P2 · **Taille :** L · **État :** BLOCKED · **Dépendances :** SEC-001, REP-005

Travail :

- créer vue read-only limitée à un projet ;
- masquer coûts, prompts, secrets et erreurs brutes ;
- ajouter liens expirants/révocables ou login ;
- tester isolation multi-projet.

Acceptation :

- les tests d'autorisation tentent explicitement l'accès à un autre projet ;
- le client ne peut déclencher aucune action ;
- les exports respectent la même projection de données.

## OPS-001 — Logs structurés et correlation IDs

**Priorité :** P0 · **Taille :** M · **État :** READY · **Dépendances :** GOV-003

Travail :

- normaliser run ID, job ID, project, provider et attempt ;
- propager correlation ID entre web/scheduler/worker/agent ;
- définir niveaux et expurgation ;
- rendre les erreurs recherchables.

Acceptation :

- un run complet est retraçable sans grep ambigu ;
- aucune clé ou PII inutile ne fuit ;
- les erreurs provider gardent code et contexte actionnable.

## OPS-002 — Métriques de santé et SLO

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** OPS-001, JOB-004

Travail :

- mesurer jobs, durées, fraîcheur, findings, approvals, avis, quotas, coûts et stockage ;
- calculer le SLO rapport lundi avant 10:00 ;
- exposer health endpoints web/worker/scheduler ;
- créer dashboard d'exploitation.

Acceptation :

- chaque SLO de la SPEC possède une métrique ;
- liveness et readiness sont distinctes ;
- une panne provider est visible sans déclarer l'application morte.

## OPS-003 — Alertes opérationnelles Telegram

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** OPS-002, TEL-001

Travail :

- définir seuils, confirmation et déduplication ;
- alerter auth, dead-letter, SLO, disque et backup ;
- gérer acknowledge et resolved ;
- documenter escalade.

Acceptation :

- une alerte de test parcourt toute la chaîne ;
- les alertes résolues cessent ;
- le bruit est mesuré et ajustable.

## OPS-004 — Ledger de coûts

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** DATA-006

Travail :

- enregistrer coût estimé/réel LLM, DataForSEO et providers ;
- attribuer projet, run, skill et action ;
- gérer devise et réconciliation ;
- séparer coûts mutualisés du VPS.

Acceptation :

- aucune exécution payante ne reste sans attribution ;
- le total mensuel est exportable ;
- les écarts estimation/facture sont visibles.

## OPS-005 — Garde-fous 10/15 USD par projet

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** OPS-004, JOB-006

Travail :

- définir cible 10 USD et plafond 15 USD ;
- alerter à 70 % et 90 % ;
- stopper enrichissements optionnels à 100 % ;
- préserver GSC, avis, IndexNow, santé et alertes critiques.

Acceptation :

- un test prouve que le hard cap bloque une dépense optionnelle ;
- les collecteurs essentiels continuent ;
- une exception budgétaire est bornée, expirante et auditée.

## OPS-006 — Runbooks d'incident

**Priorité :** P1 · **Taille :** M · **État :** BLOCKED · **Dépendances :** OPS-002, SEC-002

Travail :

- documenter auth expirée, quota, provider down, queue bloquée, double suspicion, DB indisponible et disque plein ;
- inclure diagnostic, mitigation, reprise et vérification ;
- ajouter commandes sûres et propriétaires ;
- tester par game day local.

Acceptation :

- chaque alerte critique renvoie à un runbook ;
- le game day démontre une reprise sans perte ;
- aucune procédure ne demande un secret en clair.

---

# E13 — Déploiement VPS, sauvegardes et capacité

**Objectif :** exploiter durablement web, workers, agents et analytics sur le VPS tout en gardant Neon au départ.  
**Jalon :** M6  
**Référence SPEC :** section 15.

## VPS-001 — Dockerfiles et rôles runtime

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** GOV-003, JOB-005

Travail :

- construire images reproductibles web, worker et scheduler ;
- exécuter en utilisateur non root ;
- ajouter healthchecks et arrêt gracieux ;
- séparer migrations du démarrage applicatif.

Acceptation :

- les images sont versionnées et reproductibles ;
- chaque rôle reçoit le minimum de secrets ;
- un restart worker reprend les jobs.

## VPS-002 — Compose de production et réseau

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** VPS-001

Travail :

- composer reverse proxy, web, worker, scheduler et backup ;
- garder Neon comme DB externe initiale ;
- isoler réseaux et volumes ;
- définir restart policies et limites de ressources.

Acceptation :

- seuls HTTP/HTTPS et les accès administratifs nécessaires sont exposés ;
- la perte d'un container ne détruit aucune donnée ;
- le stack redémarre après reboot VPS.

## VPS-003 — TLS, DNS et surface d'administration

**Priorité :** P0 · **Taille :** M · **État :** BLOCKED · **Dépendances :** VPS-002, SEC-001

Travail :

- configurer DNS et TLS automatique ;
- protéger dashboard et endpoints opérateur ;
- limiter rate et taille des requêtes ;
- sécuriser les webhooks Telegram.

Acceptation :

- TLS renouvelable automatiquement ;
- aucun endpoint admin public sans auth ;
- les headers et cookies de sécurité sont testés.

## VPS-004 — Déployer Plausible CE séparément

**Priorité :** P1 · **Taille :** L · **État :** BLOCKED · **Dépendances :** ANA-001, VPS-002

Travail :

- déployer Plausible, PostgreSQL Plausible et ClickHouse ;
- séparer volumes et secrets de `seo-stats` ;
- imposer quotas disque et monitoring ;
- documenter upgrades.

Acceptation :

- une panne Plausible n'arrête pas `seo-stats` ;
- les volumes survivent au redeploy ;
- l'utilisation disque déclenche une alerte avant saturation.

## VPS-005 — Sauvegardes chiffrées et restauration Neon

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** VPS-002, SEC-002

Travail :

- configurer sauvegarde Neon/export PostgreSQL selon capacités ;
- chiffrer et copier off-site ;
- appliquer rétention journalière/hebdomadaire/mensuelle ;
- automatiser vérification d'intégrité.

Acceptation :

- une restauration dans une base isolée est prouvée ;
- les secrets de backup sont séparés du serveur ;
- l'échec de sauvegarde alerte immédiatement.

## VPS-006 — Sauvegardes Plausible/ClickHouse

**Priorité :** P1 · **Taille :** L · **État :** BLOCKED · **Dépendances :** VPS-004

Travail :

- définir données indispensables et stratégie de backup ;
- sauvegarder configuration PostgreSQL et données analytics utiles ;
- tester restauration ;
- aligner avec la rétention analytics.

Acceptation :

- un site et ses métriques canary sont restaurables ;
- la fenêtre de perte acceptée est documentée ;
- la sauvegarde n'épuise pas le disque du VPS.

## VPS-007 — Déployer le runner agent sandboxé

**Priorité :** P1 · **Taille :** L · **État :** BLOCKED · **Dépendances :** AGT-008, VPS-002, SEC-003

Travail :

- transférer le runner local validé ;
- isoler worktrees, réseau et credentials ;
- limiter concurrence, temps, CPU, RAM et coûts ;
- mettre en place nettoyage sûr.

Acceptation :

- le comportement est identique au runner local canary ;
- un agent compromis ne peut pas atteindre les secrets globaux ;
- aucune suppression large ne peut viser hors répertoire de worktree validé.

## VPS-008 — Test de charge 15 projets

**Priorité :** P0 · **Taille :** L · **État :** BLOCKED · **Dépendances :** VPS-002, OPS-002

Travail :

- simuler 15 projets et fenêtres hebdomadaires réalistes ;
- mesurer DB, queue, workers, API, mémoire et coûts ;
- tester panne provider et restart ;
- recommander sizing final.

Acceptation :

- le run respecte le SLO ou documente le tuning requis ;
- aucun projet n'est affamé ;
- les limites de concurrence et le budget restent effectifs ;
- la décision 4 vCPU/8 Go est confirmée ou révisée par données.

## VPS-009 — Procédure future Neon vers PostgreSQL VPS

**Priorité :** P3 · **Taille :** L · **État :** ICEBOX · **Dépendances :** VPS-005, VPS-008

Travail :

- préparer réplication/export, fenêtre de cutover et rollback ;
- tester extensions et compatibilité ;
- mesurer coût/maintenance comparés ;
- ne déclencher qu'après décision explicite.

Acceptation :

- la procédure est répétée sur clone avant production ;
- les temps de coupure et RPO/RTO sont connus ;
- garder Neon reste une option pleinement supportée.

---

## 5. Backlog d'extensions — ICEBOX

Ces éléments ne bloquent pas l'objectif des 90 % et ne doivent pas retarder M1 à M6.

| ID | Extension | Déclencheur de reprise |
|---|---|---|
| EXT-001 | DataForSEO rank tracking quotidien élargi | besoin prouvé au-delà de GSC et budget disponible |
| EXT-002 | Backlinks centralisés | provider et valeur client validés |
| EXT-003 | Visibilité IA mensuelle | protocole stable et indicateurs actionnables |
| EXT-004 | Geo-grid local | clients locaux et budget provider confirmés |
| EXT-005 | Auto-envoi des avis 4 étoiles | backtest par projet conforme à la policy |
| EXT-006 | Auto-envoi d'autres avis positifs | définition explicite de « positif », zéro erreur critique |
| EXT-007 | PostgreSQL `seo-stats` auto-hébergé | bénéfice opérationnel supérieur au coût de maintenance |
| EXT-008 | Portail client interactif complet | usage des rapports clients validé |
| EXT-009 | Multi-tenant commercial | décision de transformer l'outil interne en produit |

---

## 6. Gates de release

### Gate M0 — Ready to build

- [ ] repo canonique documenté ;
- [ ] baseline build/test reproductible ;
- [ ] variables d'environnement validées ;
- [ ] dépendances Turso retirées ou archivées ;
- [ ] modèle de données et migrations revus ;
- [ ] feature flags présents.

### Gate M1 — Monitoring local fiable

- [ ] queue concurrente, retry, lease et dead-letter testés ;
- [ ] restart worker prouvé ;
- [ ] un projet canary GSC collecté sans duplication ;
- [ ] URL Inspection persistée ;
- [ ] contrats réels GSC/index réparés ;
- [ ] Indexing API générique désactivée ;
- [ ] cinq projets importables sans changement de schéma.

### Gate M2 — Cockpit hebdomadaire

- [ ] détecteurs opportunités, baisses, nouvelles requêtes, CTR et cannibalisation actifs ;
- [ ] cycle de vie et fingerprints stables ;
- [ ] rapport déterministe généré lundi 09:00 ;
- [ ] rapport disponible avant 10:00 ou marqué `partial` ;
- [ ] inbox cross-projet et vue preuves utilisables ;
- [ ] aucune alerte issue d'une collecte partielle.

### Gate M3 — Avis et validation

- [ ] synchronisation horaire multi-localisation ;
- [ ] quality gate sensible validé sur fixtures ;
- [ ] backtest historique réalisé ;
- [ ] aucun double envoi dans les tests de concurrence/timeout ;
- [ ] Telegram allowlist, tokens anti-rejeu et audit validés ;
- [ ] L4 jamais groupé ni auto-approuvé ;
- [ ] kill switch testé.

### Gate M4 — Analytics et leads

- [ ] Plausible CE local stable et sauvegardable ;
- [ ] Stats API sous test de contrat ;
- [ ] formulaires et rendez-vous canary dédupliqués ;
- [ ] clic téléphone distinct d'appel confirmé ;
- [ ] diagnostics GSC/Plausible testés ;
- [ ] aucune PII de formulaire transmise.

### Gate M5 — Délégation agentique

- [ ] API/CLI JSON versionnée ;
- [ ] `seo-monitor` exécute le parcours complet ;
- [ ] skills post-production sans chemins hardcodés ;
- [ ] agent limité à propositions/patchs/branches ;
- [ ] toutes les recommandations sont sourcées ;
- [ ] golden set sans régression critique ;
- [ ] plafond de coûts effectif.

### Gate M6 — Production VPS et clients

- [ ] stack redémarrable après reboot ;
- [ ] TLS, rôles et secrets validés ;
- [ ] restore Neon et restore Plausible prouvés ;
- [ ] capacité 15 projets testée ;
- [ ] runner VPS sandboxé ;
- [ ] rapport client approuvé avant distribution automatique ;
- [ ] runbooks et alertes opérationnels.

---

## 7. Matrice des dépendances externes

| Dépendance | Utilisation | Mode dégradé attendu | Owner opérationnel |
|---|---|---|---|
| Neon/PostgreSQL | état durable, queue, audit | aucun mode sans DB ; alerte critique | admin `seo-stats` |
| Google Search Console | performance et URL Inspection | rapport partiel, anciennes données marquées stale | intégration projet |
| Google Business Profile | avis et réponses | queue locale conservée, aucun envoi | intégration projet |
| IndexNow | notification URL | outbox en retry, aucun faux statut indexed | worker |
| Plausible CE | trafic et conversions | rapport GSC sans analytics | admin VPS |
| LLM | synthèses et drafts | rapport déterministe, drafts en attente | agent gateway |
| DataForSEO | enrichissements optionnels | skip budget/quota explicite | budget manager |
| Telegram | alertes et validations | dashboard reste fonctionnel | notification service |
| Repos projets | contexte et patches | projection précédente marquée stale | agent runner |

---

## 8. Décisions différées non bloquantes

- fournisseur de call tracking pour confirmer les appels réels ;
- seuil final d'auto-envoi des avis 4 étoiles ;
- date d'ouverture des rapports aux clients ;
- maintien définitif de Neon ou migration PostgreSQL VPS ;
- dimensionnement VPS final après le test 15 projets.

Chaque décision doit être enregistrée dans un ADR et mettre à jour la SPEC, les policies et les tickets concernés.

---

## 9. Premier lot exécutable

Ce lot peut démarrer immédiatement et ne dépend d'aucun provider payant :

1. `GOV-001` — canoniser le repo ;
2. `GOV-002` — baseline build/tests ;
3. `GOV-003` — configuration runtime ;
4. `GOV-004` — audit Neon/Vercel/Turso ;
5. `GOV-005` — feature flags ;
6. `DATA-001` — cartographie DB ;
7. `GSC-003` — réparer le contrat GSC réel ;
8. `IDX-003` — réparer le contrat index réel ;
9. `IDX-008` — désactiver la Google Indexing API générique ;
10. `OPS-001` — logs structurés de base.

### Résultat attendu du premier lot

- le repo canonique est sûr à modifier ;
- les régressions existantes sont connues ;
- les deux incompatibilités de contrats critiques sont corrigées ;
- l'usage non conforme de la Google Indexing API est neutralisé ;
- le développement du noyau durable peut commencer sur une base observable.

---

## 10. Indicateurs de réussite du programme

| Indicateur | Cible initiale |
|---|---|
| Projets monitorés sans intervention de collecte | 100 % |
| Rapport hebdomadaire disponible avant lundi 10:00 | ≥ 95 % |
| Findings avec preuves et période | 100 % |
| Findings dupliqués d'une semaine à l'autre | 0 |
| Actions externes avec audit complet | 100 % |
| Double réponse Google | 0 |
| Avis nouveaux synchronisés en moins de 2 h | ≥ 95 % |
| Réponses 5 étoiles acceptées sans retouche après backtest | ≥ 95 % |
| Recommandations agentiques sans source | 0 |
| Coût variable par projet | cible ≤ 10 USD, plafond 15 USD |
| Restauration testée | trimestrielle et avant tout cutover |
| Projets supportés sans refonte | 15 |

---

## 11. Vue synthétique des epics

| Epic | Objet | Jalon | Priorité dominante | Statut initial |
|---|---|---|---|---|
| E00 | gouvernance et repo | M0 | P0 | READY |
| E01 | données PostgreSQL | M0–M1 | P0 | partiellement READY |
| E02 | queue et scheduler | M1 | P0 | BLOCKED par E01 |
| E03 | GSC | M1 | P0 | contrats READY, collecte bloquée |
| E04 | indexation/IndexNow | M1–M2 | P0/P1 | contrats READY, reste bloqué |
| E05 | findings | M2 | P0 | BLOCKED par observations |
| E06 | dashboard | M2–M3 | P0/P1 | BLOCKED par données/findings |
| E07 | rapports | M2/M6 | P0/P2 | BLOCKED par findings |
| E08 | avis GMB | M3 | P0 | BLOCKED par données/jobs |
| E09 | Telegram | M3 | P0 | BLOCKED par sécurité/propositions |
| E10 | Plausible/leads | M4 | P1 | environnement local READY |
| E11 | agents/skills | M5 | P0/P1 | BLOCKED par API et rapports |
| E12 | sécurité/ops/coûts | transversal | P0 | premiers tickets READY |
| E13 | VPS/capacité | M6 | P0/P1 | BLOCKED par MVP local |

Le backlog contient volontairement des dépendances explicites vers des tickets futurs. Un outil d'import doit préserver les IDs et convertir ces dépendances en liens `blocks/is blocked by`.
