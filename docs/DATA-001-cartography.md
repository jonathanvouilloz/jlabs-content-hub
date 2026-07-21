# DATA-001 — Cartographie du schéma existant

> Source de vérité de la cartographie du schéma **avant** la reconstruction agentique.
> Introspection réelle : `scripts/data-001-cartography.ts` (read-only) →
> `docs/_generated/data-001-introspection.json`. Snapshot : **2026-07-21**.
> Backlog : `BACKLOG.md` DATA-001 · Modèle Drizzle : `src/lib/server/db/schema.ts`.

## Résultat clé : zéro dérive modèle ↔ DB

- **30 tables live** (schémas `seostats` = 29 + `core` = 1) · **30 tables dans `schema.ts`**.
- **Dérive DB sans modèle : ∅** · **Dérive modèle sans DB : ∅** · **30/30 présentes des deux côtés.**
- Les 5 tables jadis créées en SQL manuel (`drizzle/manual-epic18/22/seo-reports.sql`) sont
  **toutes reprises dans le modèle** Drizzle. Le `schema.ts` reflète fidèlement la DB Neon peuplée.
- Conséquence pour la migration : **la base n'est PAS vide** (volumes ci-dessous) — toute évolution
  passe par expand/migrate/contract, jamais par un `db:push` destructeur.

## Cartographie par table

Sort : **C** = conserver · **M** = migrer (vers un modèle futur DATA-002/003) · **R** = retirer (candidat).

| Schéma.table | Rôle | Volume | Clé naturelle (hors `id`) | FK | Sort |
|---|---|--:|---|--:|:--:|
| `core.entities` | Registre canonique des slugs (possédé par **invoices**, miroir R/O) | 9 | `slug` (PK) | 0 | **C** (jamais modifier ici) |
| `seostats.user` | Auth — compte admin | 1 | `email` | 0 | **C** |
| `seostats.session` | Auth — sessions | 24 | `token` | 1 | **C** |
| `seostats.account` | Auth — providers/mdp | 1 | — | 1 | **C** |
| `seostats.verification` | Auth — vérif email | 0 | — | 0 | **C** |
| `seostats.projects` | **Cœur** — projet client + pointeur `slug`→noyau | 6 | `slug`, `access_token` | 0 (FK sortante `slug`→`core.entities`) | **C** |
| `seostats.contents` | **Cœur** — contenu (article/linkedin/gmb) | 92 | `(project_id, type, slug)` | 1 | **C** |
| `seostats.comments` | Feedback client sur un contenu | 0 | — | 1 | **C** (dormant) |
| `seostats.content_types` | Référentiel type (article/linkedin/gmb) | **0** | `slug` | 0 | **R** (candidat — jamais peuplé ; `contents.type` est texte libre) |
| `seostats.status_history` | Audit transitions de statut d'un contenu | 201 | — (log append-only) | 1 | **C** |
| `seostats.cms_connections` | Connexion CMS externe par projet | 0 | `project_id` | 1 | **C** (dormant — sync GitHub retirée) |
| `seostats.project_gmb_locations` | Locations GBP d'un projet | 9 | `(project_id, gmb_location_id)` | 1 | **C** |
| `seostats.gmb_reviews` | Avis Google | 358 | `review_id` | 1 | **C** |
| `seostats.employee_mentions` | Agrégat mensuel employés cités dans les avis | 67 | `(project_id, employee_name, year, month)` | 1 | **C** |
| `seostats.gmb_settings` | Store key/value GMB (tokens, flags cron) | 8 | `key` (PK) | 0 | **M** → `project_integrations` (DATA-002) |
| `seostats.gmb_ai_reports` | Rapport IA périodique d'une fiche | 3 | `(project_id, period)` + `input_hash` | 1 | **C** ; réévaluer vs findings (E05) |
| `seostats.gmb_location_profiles` | Snapshot complet d'une fiche GBP | **0** | `(project_id, gmb_location_id)` | 1 | **C** (dormant — sync lazy jamais déclenchée) |
| `seostats.gmb_insights_daily` | Métriques journalières Performance API | **0** | `(gmb_location_id, date, metric)` | 1 | **M** → modèle d'observations (DATA-003) |
| `seostats.gmb_profile_edits` | Audit éditions de fiche depuis le hub | 0 | — (log) | 1 | **C** (dormant) |
| `seostats.publish_logs` | Log 1-ligne/tentative de publication | 209 | — (log) | 2 | **C** ; réévaluer vs `monitoring_steps` |
| `seostats.project_contexts` | Contexte texte libre par projet | 5 | `project_id` | 1 | **M** → `project_projections` (DATA-002, hash/version/provenance) |
| `seostats.linkedin_settings` | Store key/value LinkedIn | 3 | `key` (PK) | 0 | **M** → `project_integrations` (DATA-002) |
| `seostats.indexing_credentials` | Service account Indexing par projet | 6 | `project_id` | 1 | **M** → `project_integrations` (provider `indexing`) |
| `seostats.indexing_submissions` | Log soumissions Indexing (dont `blocked` IDX-008) | 441 | — (log) | 1 | **C** |
| `seostats.ai_jobs` | Queue IA légère existante | 111 | — | 1 | **M** → `jobs` durable (DATA-003 / JOB-001) |
| `seostats.gsc_snapshots` | Snapshot hebdo GSC agrégé | 96 | `(project_id, week_start)` | 1 | **M** → observations (DATA-003) |
| `seostats.gsc_query_page_data` | Détail GSC query×page×device par snapshot | **73 009** | ⚠️ *aucune* (voir doublons) | 2 | **M** → observations (migration **par lots**) |
| `seostats.gsc_weekly_diffs` | Diff hebdo calculé (KPIs, rising/falling, opps) | 96 | `(project_id, week_start)` | 1 | **M** ou **R** (dérivé recalculable) → findings |
| `seostats.tracked_keywords` | Watchlist positions (epic 23) | 6 | `(project_id, keyword)` | 1 | **C** |
| `seostats.seo_reports` | Rapports concurrence/backlink/visibilité IA/cannib. | 4 | — | 2 | **C** ; réévaluer vs findings (E05) |

## Doublons & recouvrements avec le futur modèle d'observations

Le socle agentique (DATA-002/003) introduit un modèle unifié **intégrations / projections /
runs / observations / jobs**. Les tables actuelles qui le préfigurent :

- **Observations brutes** (mesures externes datées) → futur *observations* : `gsc_snapshots`,
  `gsc_query_page_data` (73k), `gmb_insights_daily`. **Fusionner** dans le modèle unifié.
- **Dérivés / rapports calculés** → futur *findings/reports* (E05) : `gsc_weekly_diffs`,
  `seo_reports`, `gmb_ai_reports`. Recalculables depuis les observations → migrer **ou** régénérer.
- **Queue de travail** → futur `jobs` durable : `ai_jobs` (queue légère, sans lease/retry/idempotency).
- **Runs / tentatives** → recoupent `monitoring_runs`/`monitoring_steps` : `publish_logs`,
  `status_history`. Restent des **logs métier** ; à référencer depuis les runs, pas à dissoudre.
- **Contexte projet** → `project_projections` (DATA-002) : `project_contexts` (1:1 projet, sans
  hash/version) — doublon annoncé, à migrer avec hash + provenance.
- **Intégrations / secrets** → `project_integrations` (DATA-002) : `indexing_credentials`,
  `gmb_settings`, `linkedin_settings`, `cms_connections` — quatre sources d'intégration éparses à
  unifier (provider, scopes, statut, fraîcheur, réf. de secret — **jamais le secret en clair**).

### Doublon de données à surveiller
- `gsc_query_page_data` (73 009 lignes) **n'a aucune clé naturelle imposée** (seul `id` en PK). La
  clé métier serait `(snapshot_id, query, page, device)`. Risque de **lignes dupliquées** si un
  snapshot a été rejoué. À dédupliquer/valider **avant** migration vers le modèle d'observations.

## Stratégie expand / migrate / contract (base non vide)

Aucune migration ne suppose une base vide. Séquence type, non destructive, pour chaque bascule :

1. **`project_contexts` → `project_projections`** (DATA-002)
   *expand* créer `project_projections` (hash, version, provenance) → *migrate* backfill 1:1 depuis
   `project_contexts` (hash calculé, projection non dupliquée si hash inchangé) → *contract* basculer
   la lecture puis déprécier `project_contexts`.
2. **`*_settings` + `indexing_credentials` + `cms_connections` → `project_integrations`** (DATA-002)
   *expand* créer `project_integrations` (provider, scopes, statut, fraîcheur, réf. secret) →
   *migrate* mapper chaque source (secrets laissés dans leur store chiffré, jamais copiés dans une
   projection) → *contract* retirer les stores key/value au fil de l'eau.
3. **`ai_jobs` → `jobs`** (DATA-003 / JOB-001)
   *expand* `jobs` durable (lease, retry, idempotency key, erreur normalisée) → *migrate* `ai_jobs`
   devient `type='ai'` → *contract* retirer `ai_jobs`.
4. **`gsc_*` + `gmb_insights_daily` → observations** (DATA-003) — **le morceau volumineux (73k+)**
   *expand* `monitoring_runs` + observations → *migrate* **par lots** (batch + index de réclamation ;
   dédup `gsc_query_page_data` d'abord) → *contract* archiver/retirer les fines après validation
   canary ; conserver les agrégats (`gsc_snapshots`) tant qu'ils servent le cockpit hebdo.

## Synthèse — clés naturelles & volumes

- **Volumétrie dominée par GSC** : `gsc_query_page_data` = 73 009 (99 % des lignes du hub). Tout le
  reste est ≤ 500. La migration critique en effort = ce seul jeu de données.
- **Clés naturelles métier bien posées** partout où c'est un référentiel (projects.slug,
  contents.(project_id,type,slug), gmb_reviews.review_id, `(project_id, week_start)` pour GSC,
  `(gmb_location_id, date, metric)` pour les insights…). **Trou unique** : `gsc_query_page_data`.
- **Tables vides = fonctionnalités dormantes** (content_types, cms_connections, gmb_location_profiles,
  gmb_insights_daily, gmb_profile_edits, verification, comments) : soit se rempliront à l'usage
  (dormant), soit sont des référentiels morts (`content_types` → candidat retrait).
- **`core` reste R/O** : la FK `projects.slug → core.entities.slug` est la couture noyau ; possédée
  par invoices, jamais mutée depuis seo-stats.

## Mise à jour DATA-002 (2026-07-21)

Deux tables **ajoutées** (phase expand, base passée à **32 tables**, toujours zéro dérive) :
- `project_integrations` — unique `(project_id, provider, resource_key)` ; FK `project_id → projects`.
  Cible d'unification (migrate/contract à venir) de `indexing_credentials`, `gmb_settings`,
  `linkedin_settings`, `cms_connections`.
- `project_projections` — unique `(project_id, source_hash)` + unique partiel `(project_id) WHERE
  status='current'` ; FK `project_id → projects`. Remplacera `project_contexts`.

Les tables héritées ci-dessus restent en place (aucun backfill/retrait en DATA-002).

## Suite
- **DATA-001b** — fixture DB anonymisée (seed synthétique, zéro donnée client) : follow-up dédié.
- **DATA-003** consommera cette cartographie (runs, steps, jobs, observations).
