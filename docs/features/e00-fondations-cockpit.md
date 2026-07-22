# Feature — E00 Fondations (reconstruction agentique)

> Premier lot exécutable du BACKLOG (§9) pour la reconstruction cockpit agentique.
> SPEC source : `docs/SPEC.md` v0.2 · Backlog : `docs/BACKLOG.md` E00.
> Branche : `feat/cockpit` (depuis `feat/neon`).

## Etat session 2026-07-22 (DATA-007 — review_automation_policies + policy_promotions)

**Fait :**
- **DATA-007** phase **expand** : 2 tables des politiques d'avis & d'automatisation (SPEC §7.10) dans
  `schema.ts`. Une policy gouverne l'automatisation des réponses aux avis pour un projet, affinable
  par localisation. Elle est **versionnée** (même modèle que `project_projections`) : jamais modifiée
  en place → on **promeut** une nouvelle version, l'ancienne passe `superseded`.
  - `review_automation_policies` (§7.10) — mode `draft_only|guarded_auto|manual`, `sync_enabled`,
    `auto_generation_enabled`, **`kill_switch`**, note minimale, délai + **jitter**, plages horaires
    (JSON), langue, signature, catégories d'escalade (JSON), max/run. **`scope_key` = `location_id ?? '*'`**
    → rend robuste le partial-unique `WHERE status='current'` (Postgres traite les NULL comme distincts,
    ce qui casserait l'unicité de la policy projet-wide). **`policy_hash`** (sha256 de la config canonique)
    → dédup d'une re-promotion identique. Unique `(project_id, scope_key, version)` + unique partiel
    **une seule courante par scope**.
  - `policy_promotions` (**journal append-only**, BACKLOG « tracer toute promotion ») — 1 ligne par
    transition : `from/to_version`, `from/to_mode`, `kind` (create|mode_change|kill_switch|config_change),
    `actor`, `reason`. Jamais d'update/delete → la policy effective à toute date se reconstruit depuis
    le journal (« la policy effective est visible dans l'audit »).
  - Helpers : `policy-state.ts` (**pur**, testé : `deriveScopeKey`, `nextPolicyVersion`,
    `canonicalPolicyConfig` [sérialisation stable → hash], **`evaluatePolicyGates`** [invariant :
    `syncAllowed` ignore le kill switch], **`canAutoSendReview`** [§8.4 : draft_only/manual jamais,
    guarded_auto seulement 5★ non escaladé], `resolveEffectiveKillSwitch` [global OU localisation],
    `derivePromotionKind`, tuples de vocabulaire) · `policies.ts` (`promotePolicy` **transactionnel**
    idempotent [dédup par hash, versionne sinon, écrit le journal] + `computePolicyHash` [sha256],
    `setKillSwitch` [bascule = promotion journalisée, ne touche jamais `sync_enabled`],
    `getCurrentPolicy`/`getEffectivePolicy` ; garde `assertBoundedPayload`/`assertNoInlineSecret` sur
    les blobs JSON).
  - Application : `drizzle/manual-data-007.sql` (additif, `IF NOT EXISTS`) via `scripts/apply-data-007.ts`.
- Vérif : `npm run test` = **144/144** (29 nouveaux) · `npm run check` = **0 err / 42 warn** (baseline) ·
  DDL **appliqué sur Neon** (2/2 tables) · introspection = **52 tables, zéro dérive**.
- **3 acceptations couvertes** : (1) versionnage (unique current + `policy_hash`) → aucune ancienne
  proposition ne profite silencieusement d'une nouvelle policy ; (2) `evaluatePolicyGates` → le kill
  switch bloque les envois **sans** bloquer la sync ; (3) `policy_promotions` append-only → la policy
  effective est visible dans l'audit.
- **Pas d'exécuteur, pas de cron, pas d'UI** (expand seul). GMB-005 (application réelle des modes/kill
  switch au flux review-reply) reste **BLOCKED**, débloqué côté données par cette table.

**Prochain :** **DATA-008** (rétention/purge, désormais débloqué : agrégats semaine/mois/année avant purge,
24 mois de détail, dry-run + métriques + reprise). Puis la chaîne agentique aval (1er détecteur déterministe
+ agent réel qui produit findings→proposals, gouvernés par ces policies).

**Pièges :**
- `scope_key` = `location_id ?? '*'` : **toujours** passer par `deriveScopeKey` côté écriture, sinon le
  partial-unique `current` peut laisser deux policies projet-wide coexister (NULL distincts en Postgres).
- `policy_hash` = sha256 de `canonicalPolicyConfig` (ordre de champs **figé**) → réordonner les champs
  invalide tous les hash existants (re-promotion vue comme changement). Ne pas toucher sans migration.
- Le kill switch est **versionné dans la config** (pas une colonne mutée en place) : une bascule crée une
  nouvelle version + une ligne de journal → l'historique du kill switch est auditable.
- `setKillSwitch` sur un scope sans policy crée une `draft_only` sûre (kill switch demandé) : jamais
  d'envoi possible par défaut.

---

## Etat session 2026-07-22 (DATA-006 — proposals + approvals + agent_runs)

**Fait :**
- **DATA-006** phase **expand** : 3 tables de la couche décision→action (SPEC §7.8/§7.9/§12) dans
  `schema.ts`. Une proposition = une action **recommandée** (jamais une mutation → exécution).
  - `action_proposals` (§7.8) — **`payload_hash`** stocké (hash canonique de `payload_json`) = ce à
    quoi une approbation se lie. Statuts = 7 de §7.8 **+ `invalidated`** (payload modifié après
    approbation) **+ `expired`**. `required_approval_level` (L0–L4, §12.1). Exécution/vérification
    **non séparées** : `execution_job_id` FK→`jobs` (queue durable existante) + `verification_status`.
    Idempotence : **unique `(project_id, finding_id, action_type, payload_hash)`** → re-proposition
    identique ne duplique pas.
  - `proposal_approvals` (**entité d'approbation dédiée**, §12.2/§12.3/§14.3) — **hash lié**
    (`approved_payload_hash`), auteur + `scope_json` (périmètre), `method` (ui|telegram|policy),
    **token one-time** + `token_used_at` + `expires_at`, statut propre (active|consumed|expired|
    revoked|invalidated). 1 ligne par proposition (approbation de lot = jamais un scope global).
  - `agent_runs` (§7.9) — journal d'invocation LLM : agent/version, skill, model, inputs+hashes,
    `findings_read_json` (sources), sortie (proposal|report), tokens/coût/durée, résultat/erreurs,
    `human_validation_ref` FK→`proposal_approvals`. Distinct de `monitoring_runs` (orchestration).
  - Helpers : `proposal-state.ts` (**pur**, testé : `canActorApprove` [agent ≤ L2, policy ≤ L3,
    **L4 = user seul**], `isApprovalValid` [active + hash égal + non expiré], `statusAfterPayloadChange`,
    tuples de vocabulaire) · `proposals.ts` (`createProposal` idempotent + `computePayloadHash`
    [sha256], `approveProposal` **transactionnel** [refuse si niveau interdit], `updateProposalPayload`
    [invalide l'approbation], `rejectProposal`/`supersedeProposal`/`linkExecutionJob`/
    `setVerificationStatus`, `recordAgentRun`/`finishAgentRun` ; garde `assertBoundedPayload`/
    `assertNoInlineSecret` sur tous les blobs).
  - Application : `drizzle/manual-data-006.sql` (additif, `IF NOT EXISTS`) via `scripts/apply-data-006.ts`.
- Vérif : `npm run test` = **115/115** (18 nouveaux) · `npm run check` = **0 err / 42 warn** (baseline) ·
  DDL **appliqué sur Neon** (3/3 tables) · introspection = **50 tables, zéro dérive** (idem-unique +
  token-unique + FK exécution→`jobs` vérifiés).
- **3 acceptations couvertes** : (1) modifier le payload invalide l'approbation → `payload_hash` +
  `isApprovalValid` + `updateProposalPayload` ; (2) un agent ne peut pas élever son niveau →
  `canActorApprove` refuse L3/L4 ; (3) toute action externe remonte à une proposition (`execution_job_id`)
  ou policy versionnée (`review_automation_policies`, DATA-007).
- **Pas d'agent réel, pas d'exécuteur, pas d'UI** (expand seul). Recoupements legacy (`publish_logs`,
  `gmb_reviews.draftReply`, `ai_jobs`) **non touchés** — contract différé.

**Prochain :** **DATA-007** (`review_automation_policies` : modes draft_only/guarded_auto/manual, seuils,
version, kill switch) et/ou **DATA-008** (rétention/purge, désormais débloqué). Puis la chaîne agentique
aval (1er détecteur + agent réel qui produit findings→proposals).

**Pièges :**
- `payload_hash` = sha256 de la **chaîne** `payload_json` stockée → l'appelant doit fournir une
  sérialisation stable s'il veut que deux payloads sémantiquement égaux partagent le hash.
- `findingId` **nullable** dans l'unique d'idempotence : Postgres traite les NULL comme distincts →
  deux propositions « sans finding » de même action/payload ne se dédupliquent pas (attendu).
- Exécution = table `jobs` existante, **pas** une nouvelle table (SPEC : pas de table exécution séparée).
- `proposal_approvals.token` unique mais nullable → plusieurs approbations sans token coexistent (OK).

---

## Etat session 2026-07-22 (DATA-005 — findings + finding_events)

**Fait :**
- **DATA-005** phase **expand** : 2 tables du modèle agentique (SPEC §7.6/§7.7) dans `schema.ts`.
  Un finding = **interprétation déterministe persistante** (jamais un fait brut → observation) ;
  c'est la primitive centrale du produit (SPEC §1542).
  - `findings` (SPEC §7.6) — **unique `(project_id, fingerprint)`** = le même problème redétecté
    une autre semaine conserve le même finding (acceptation 1), on incrémente `occurrence_count`
    + rafraîchit `last_seen_at`/scores/preuves, `first_seen_at` préservé. Statuts = les **7 de §7.6
    + `reopened`** (§10.1) ; `new` transitoire (naît `open`). `severity` info→critical,
    `priority_score`/`confidence_score` 0–100. **Preuves = `evidence_json` (pointeurs), jamais de
    texte libre** ni de FK dure vers une observation. `run_id` nullable (traçabilité détecteur).
    Index inbox cross-projet : `idx_findings_status` + `(project_id, status|severity)`.
  - `finding_events` (SPEC §7.7) — journal **append-only** : `event_type` + `reason` (cause) +
    `actor` (auteur) → acceptation 2 « toute transition possède un événement, une cause et un auteur ».
    Jamais d'update/delete.
  - Helpers : `finding-state.ts` (**pur**, testé : `deriveFindingFingerprint` [séparateur `\x1f`,
    miroir de l'unique], `computePriorityScore` [barème §10.2 : impact 40 + urgency 25 + confidence 20
    + strategic_fit 15], `clampScore`, `deriveSeverityEventType`, `deriveStatusEventType`,
    tuples de vocabulaire) · `findings.ts` (`upsertFinding` idempotent avec incrément atomique
    `occurrence_count`, `recordFindingEvent` append-only, `transitionFinding` **transactionnel**
    statut+événement ; garde `assertBoundedPayload`/`assertNoInlineSecret` sur evidence/impact/payload).
  - Application : `drizzle/manual-data-005.sql` (additif, `IF NOT EXISTS`) via `scripts/apply-data-005.ts`.
- Vérif : `npm run test` = **97/97** (27 nouveaux) · `npm run check` = **0 err / 42 warn** (baseline) ·
  DDL **appliqué sur Neon** (2/2 tables) · introspection = **47 tables, zéro dérive**, les 2 tables +
  unique fingerprint + 3 index inbox + 2 index journal attendus.
- **Politique de suppression d'observation** (acceptation 3) : observations = série **append-only jamais
  supprimée** ; evidence_json = références *souples* → aucune cascade. « Interdit/géré par politique » ✓.
- **Pas de détecteur, pas de backfill, pas d'UI** (expand seul ; findings = données de nouvelle génération).

**Prochain :** **DATA-006** (débloqué) — le reste de la chaîne agentique (proposals/approval…) et un
premier **détecteur** déterministe qui produira de vrais findings depuis les observations DATA-004.

**Pièges :**
- Statut/sévérité/type en colonnes `text` (pas d'enum DB, cohérent avec le schéma) → le vocab canonique
  vit dans `finding-state.ts`, à garder synchro.
- `findings` **n'a pas** de `schema_version` (contrairement aux observations) : le versionnage d'un finding
  passe par `detector_version`.
- `evidence_json` : **pointeurs** (ids d'observations/queries/pages), jamais le texte de l'avis/du contenu.

---

## Etat session 2026-07-22 (DATA — backfill EXÉCUTÉ en DB réelle)

**Fait :**
- **Backfill exécuté sur Neon** (run réel, plus dry-run) : `gsc_query_page_observations`=**73009**,
  `gsc_page_observations`=**3300** (rollup), `gmb_insight_observations`=**0** (source vide),
  `keyword_rank_observations`=**137**. `verify-backfill` = **5/5 PASS**. `data-001-cartography
  post-backfill` = **45 tables, zéro dérive**, 4 tables d'observations peuplées.
- **Bug corrigé** (`7cb94c1`) : `CHUNK` 5000→4000. À 5000, `gsc_query_page_observations`
  (16 colonnes) générait 80000 params bind par INSERT → dépassait la limite Postgres de
  **65535 params/requête** (`bind message has N parameter formats but 0 parameters`). 4000×16=64000,
  sûr pour les 4 tables. Le run planté avant correctif était sans dommage (upserts idempotents).
- **Prochain = DATA-005** (`findings`/`finding_events`, débloqué). **CONTRACT** (retrait legacy) toujours
  différé : l'app lit encore `gsc_query_page_data` (`/positions`) et `gmb_insights_daily` (dashboards).

---

## Etat session 2026-07-22 (DATA — migrate/backfill : code)

**Fait :**
- **Phase MIGRATE** : backfill idempotent du legacy vers les tables d'observations (DATA-004),
  **additif** (aucune table source touchée). Les 3 domaines arbitrés :
  - `gsc_query_page_data` → `gsc_query_page_observations` (1:1 ; `week_start`→`period_start`,
    `period_end` joint depuis `gsc_snapshots`).
  - **rollup dérivé** `gsc_query_page_data` agrégé → `gsc_page_observations` (par snapshot/semaine :
    Σ clicks/impressions, `ctr` recalculé, **position pondérée par impressions**).
  - `gmb_insights_daily` → `gmb_insight_observations` (1:1).
  - `tracked_keywords` (non archivés) × `gsc_query_page_data` → `keyword_rank_observations`
    (**watchlist epic-23 seulement** ; ligne représentative = impressions max par keyword/device/semaine).
  - `provider` posé explicitement (`gsc`/`gsc`/`gmb`/`gsc`), `run_id=null`, `schema_version=1`,
    `payload_json=null` (série normalisée suffisante).
- Module **pur testé** `src/lib/server/observation-backfill.ts` (`import type` des interfaces d'input →
  zéro dépendance db/`$env`) : `rollupPagesFromQueryPage`, `weightedPosition`, `pickKeywordRankRow`,
  `buildKeywordRankInputs`, mappers `toGsc*`/`toGmb*`/`toKeywordRank*`.
- **Runner** `scripts/backfill-observations.ts` (Pool propre + drizzle autonome, cf. `apply-data-004.ts`) :
  passes A+B fusionnées par snapshot (mémoire bornée à une semaine, `week_end` gratuit), C keyset, D join.
  **Dédup intra-lot last-wins** côté GSC (pas de clé naturelle → sinon `ON CONFLICT` casse dans un même
  INSERT). Upserts par lot mirroir des `*_obs_unique`. Flag **`--dry-run`**.
- **Vérif read-only** `scripts/verify-backfill.ts` : #obs == #clés distinctes source (A/C), Σ impressions
  page == Σ impressions query_page (B, le rollup conserve la masse), keyword_rank ⊆ tracked + comptage (D).
- Vérif locale : `npm run test` = **70/70** (13 nouveaux) · `npm run check` = **0 err / 42 warn** (baseline).
- **Dry-run OK (2026-07-22, Neon lu, zéro écriture)** : A `gsc_query_page`=**73009** (96 snapshots, aucun
  doublon collapse) · B rollup `gsc_page`=**3300** · C `gmb_insight`=**0** (source `gmb_insights_daily`
  vide — GMB dormant) · D `keyword_rank`=**137** (depuis 443 candidates tracked). Le code tourne, se
  connecte, transforme sans crash.

**Prochain (exécution DB réelle, hors session code — nécessite accès Neon) :**
1. ✅ `npx tsx scripts/backfill-observations.ts --dry-run` — fait (compteurs ci-dessus).
2. `npx tsx scripts/backfill-observations.ts` (exécution réelle par lots).
3. `npx tsx scripts/verify-backfill.ts` (invariants) + `npx tsx scripts/data-001-cartography.ts post-backfill`
   (zéro dérive + 4 tables peuplées).
Puis **DATA-005** (`findings`/`finding_events`, débloqué). **CONTRACT** (retrait legacy) **différé** :
l'app lit encore `gsc_query_page_data` (`/positions`) et `gmb_insights_daily` (dashboards).

**Pièges :**
- `scripts/` **hors** `include` du `check` (comme tous les scripts) → non typecheckés statiquement ;
  leur validation passe par le **dry-run** (tsx + Neon).
- **Doublons GSC** : dédup intra-lot obligatoire ; les doublons inter-lots sont résolus par l'upsert
  (last-wins, valeurs identiques car re-fetch). `verify-backfill` mesure l'écart lignes↔clés distinctes.
- Rollup page : `gsc_page_observations` n'est **pas** une donnée page-native GSC mais une **dérivation** ;
  un futur collecteur page-level pourra la remplacer proprement (upsert idempotent, même clé).

---

## Etat session 2026-07-21 (DATA-004)

**Fait :**
- **DATA-004** phase **expand** : le modèle d'observations (SPEC §7.5), **10 tables** dans `schema.ts`.
  Une observation = un **fait collecté**, jamais une interprétation (ça = un finding, DATA-005).
  - Forme commune à chaque table : `project_id` · `run_id` (FK→`monitoring_runs`, nullable →
    **traçabilité** jusqu'au run collecteur) · `provider` · `schema_version` · période/date ·
    dimensions · métriques normalisées · `payload_json` **brut borné** (séparé du normalisé) ·
    `fetched_at`. **Unique d'upsert** (projet + dimensions + période) = deux collectes identiques
    ne dupliquent pas (acceptation 1). **Index (projet, période/date)** = fenêtres 7/28/90 j
    couvertes (acceptation 3).
  - Les 10 : `gsc_query_page` · `gsc_page` · `index` · `sitemap` · `plausible_page` ·
    `keyword_rank` · `backlink` · `ai_visibility` · `gmb_review` · `gmb_insight` _observations_.
    **5 ancrées** sur une source vivante à migrer (gsc_query_page, gsc_page, gmb_insight,
    keyword_rank, index) ; **5 préfigurent** un collecteur à venir (sitemap, plausible, backlink,
    ai_visibility, gmb_review) — expand étant additif, elles s'élargiront sans rupture.
  - Helpers : `observation-state.ts` (**pur**, testé : `deriveObservationFingerprint` [dédup
    déterministe, séparateur `0x1F`], `computeWindowStart`/`isWithinWindow`, `assertBoundedPayload`
    [payload borné 32 Ko]) · `observations.ts` (upserts idempotents `onConflictDoUpdate` des **5
    tables ancrées** ; garde `assertNoInlineSecret` + `assertBoundedPayload` sur le payload).
  - Application : `drizzle/manual-data-004.sql` (additif, `IF NOT EXISTS`) via `scripts/apply-data-004.ts`.
- Vérif : `npm run test` = **57/57** (17 nouveaux) · `npm run check` = 0 err / 42 warn · introspection =
  **45 tables, zéro dérive**, les 10 tables + uniques d'upsert + index de fenêtre attendus.
- **Pas de backfill / pas de retrait** (migrate/contract = phase suivante).

**Prochain :** **migrate/contract** désormais débloqué côté observations — backfill par lots
`gsc_query_page_data` (73k, **dédupliquer d'abord**, aucune clé naturelle) + `gsc_snapshots` →
`gsc_*_observations`, `gmb_insights_daily` → `gmb_insight_observations`, positions epic 23 →
`keyword_rank_observations`. Puis **DATA-005** (`findings`/`finding_events`, désormais débloqué).
Le morceau `ai_jobs → jobs` reste **écarté** (voir Décisions).

**Pièges :**
- Uniques en **index uniques** (`uniqueIndex`), pas contraintes — cohérent avec le reste du schéma.
- `payload_json` : **borné** (`assertBoundedPayload`, 32 Ko) ET sans secret (`assertNoInlineSecret`)
  avant persistance. Le brut illimité va ailleurs, jamais dans la série temporelle.
- `gmb_review_observations` **recouvre** l'existant `gmb_reviews` (conservé) : la table d'observation
  capture l'**état daté** (rating/sentiment/has_reply) pour la série réputation, sans dupliquer le
  texte de l'avis (→ payload/finding).
- Les 5 tables spéculatives n'ont **pas** de write-helper (on n'écrit pas ce qu'on ne collecte pas) :
  leurs colonnes de métriques sont volontairement minimales, à élargir quand leur collecteur arrive.

---

## Etat session 2026-07-21 (DATA-003)

**Fait :**
- **DATA-003** phase **expand** : 3 tables d'orchestration du modèle agentique dans `schema.ts`.
  - `monitoring_runs` (SPEC §7.3) — run logique par projet/période. **unique (project_id,
    idempotency_key)** = deux créations concurrentes même clé ⇒ **un seul run** (acceptation 2).
    Statuts `queued|running|partial|success|failed|cancelled`, types
    `daily|weekly|monthly|manual|post_publish`, `triggered_by` schedule|user|agent|webhook.
  - `monitoring_steps` (SPEC §7.4) — tentative d'étape, FK→run. **unique (run_id, step_type,
    attempt)** (`force` = nouvel `attempt`, SPEC §8.3). Statuts step incluent **`skipped`** et
    **`provider_unavailable`** → un run partiel distingue succès/skip/échec/provider indispo
    (acceptation 1). Lease (`lease_owner`/`lease_until`) + `input_hash`/`output_hash`.
  - `jobs` (conçue depuis SPEC §6.2 queue durable + §8.3) — queue Postgres : `attempts`/`max_attempts`
    (dead-letter), `available_at` (backoff), lease + `heartbeat_at`, `depends_on` (JSON), `run_id`
    nullable. **unique (project_id, idempotency_key)** (dédup) + **`idx_jobs_claim`(status,
    available_at, priority)** = index de réclamation vérifié (acceptation 3). Le claim atomique
    `FOR UPDATE SKIP LOCKED` reste **JOB-001** (hors périmètre).
  - Helpers : `monitoring-state.ts` (**pur**, testé : `deriveIdempotencyKey`, `classifyRunOutcome`,
    `computeBackoff`, `shouldDeadLetter`, `normalizeError` + tuples de statut) · `monitoring.ts`
    (`createRun`/`enqueueJob` concurrency-safe en `onConflictDoNothing`, `recordStep`,
    `recomputeRunStatus`). Garde `assertNoInlineSecret` réutilisée sur `payload_json`/`metadata_json`.
  - Application : `drizzle/manual-data-003.sql` (additif, `IF NOT EXISTS`) via `scripts/apply-data-003.ts`.
- Vérif : `npm run test` = **40/40** · `npm run check` = 0 err / 42 warn · introspection = **35 tables,
  zéro dérive**, les 3 tables + index attendus (uniques idempotence, `idx_jobs_claim`).
- **Pas de backfill / pas de retrait** (migrate/contract = phase suivante).

**Prochain :** **migrate/contract** — `ai_jobs` (queue légère, 111 lignes) → `jobs` (`type='ai'`) puis
retrait ; `gsc_*`/`gmb_insights_daily` → observations. Puis **JOB-001** (réclamation atomique des jobs :
`FOR UPDATE SKIP LOCKED`, lease, heartbeat, backoff) qui consomme `idx_jobs_claim`.

**Pièges :**
- Uniques en **index uniques** (`uniqueIndex`), pas contraintes — cohérent avec le reste du schéma.
- Statut de run **dérivé** des steps (`classifyRunOutcome`) ; `cancelled` est une décision externe,
  jamais dérivée.
- `payload_json`/`metadata_json` : passer par `assertNoInlineSecret` avant persistance (aucun secret).

---

## Etat session 2026-07-21 (DATA-002)

**Fait :**
- **DATA-002** phase **expand** : 2 tables socles du modèle agentique (SPEC §7.1/§7.2) dans `schema.ts`.
  - `project_integrations` — provider + `resource_key` (discriminateur) → **unique (project_id, provider,
    resource_key)** = plusieurs propriétés/localisations sans collision. `secret_ref` (jamais le secret),
    `configuration_json` non secret, fraîcheur (`last_success/error_at`) + `health_status`, `scopes`.
  - `project_projections` — hashée/versionnée. **unique (project_id, source_hash)** = inchangée jamais
    dupliquée ; **unique partiel `WHERE status='current'`** = une seule courante, versions passées `stale`.
  - Helpers : `projection-state.ts` (**pur**, testé : `classifyProjection`, `assertNoInlineSecret`,
    `computeHealth`) · `projections.ts` (record/dedup/versionnage transactionnel) · `integrations.ts`
    (upsert `onConflict` + succès/erreur → santé). Garde anti-secret sur payload ET config.
  - Application : `drizzle/manual-data-002.sql` (additif, `IF NOT EXISTS`) via `scripts/apply-data-002.ts`.
- Vérif : `npm run test` = **21/21** · `npm run check` = 0 err / 42 warn · introspection = **32 tables,
  zéro dérive**, les 2 tables avec FK→projects + index attendus (dont l'unique partiel).
- **Pas de backfill / pas de retrait** des tables héritées (migrate/contract = phase suivante).

**Prochain :** **DATA-003** — `monitoring_runs` / `monitoring_steps` / `jobs` (SPEC §7.3/§7.4) :
consommeront intégrations + projections. Puis migrate/contract (backfill `project_contexts` → projections,
4 sources → intégrations) et **DATA-001b** (fixture).

**Pièges :**
- Uniques posées en **index uniques** (`uniqueIndex`), pas contraintes — cohérent avec le reste du schéma.
- `configuration_json`/`payload` : toujours passer par `assertNoInlineSecret` avant persistance.

---

## Etat session 2026-07-21 (DATA-001)

**Fait :**
- **DATA-001** cartographie du schéma existant → `docs/DATA-001-cartography.md`.
  - Script d'introspection **read-only** `scripts/data-001-cartography.ts` (Pool `.env`, raw SQL
    `information_schema`/`pg_indexes` + `count(*)`) → snapshot `docs/_generated/data-001-introspection.json`.
  - **Zéro dérive** : 30 tables live = 30 dans `schema.ts` (les 5 tables ex-SQL-manuel epic18/22/
    seo-reports sont reprises dans le modèle). Base **non vide** (volumes réels relevés).
  - Sort documenté par table (conserver/migrer/retirer) · doublons vs futur modèle d'observations ·
    stratégie **expand/migrate/contract** pour base peuplée.
  - Volumétrie : dominée par `gsc_query_page_data` (**73 009** lignes, 99 % du hub), reste ≤ 500.
  - Findings : `content_types` vide (référentiel mort, candidat retrait) · `gsc_query_page_data`
    **sans clé naturelle imposée** → risque de doublons à dédupliquer avant migration · plusieurs
    tables GMB vides (dormantes).
- Vérif : script OK · `npm run check` = **0 err / 42 warn** (baseline).

**Prochain :** **DATA-002** — `project_integrations` (unifie `indexing_credentials`, `gmb_settings`,
`linkedin_settings`, `cms_connections`) + `project_projections` (remplace `project_contexts`, avec
hash/version/provenance). Puis **DATA-001b** (fixture anonymisée, différée).

**Pièges :**
- Migration GSC = seul morceau volumineux (73k) → **par lots**, jamais un rewrite bloquant.
- `core` reste R/O (FK `projects.slug → core.entities.slug`, possédé par invoices).

---

## Etat session 2026-07-21 (IDX-008)

**Fait :**
- **IDX-008** Google Indexing API restreinte. Garde unique en amont de tout réseau : flag maître
  `indexnow` (OFF par défaut) **ET** validation de type d'éligibilité (`JobPosting` / `BroadcastEvent`).
  - Helpers **purs** dans `src/lib/server/indexing-eligibility.ts` (`isEligibleForIndexingApi`,
    `evaluateIndexingGuard`) → testables hors runtime SvelteKit.
  - `publishUrl` / `batchSubmit` (`indexing.ts`) : gagnent `eligibility?` + `flagCtx?` ; refus →
    ligne d'audit `status:'blocked'`, `httpStatus:null`, **aucun `fetch`** (zéro quota). `batchSubmit`
    audite en 1 ligne résumé (`url = batch:<n>`).
  - 4 points d'entrée neutralisés (aucun ne porte de type éligible aujourd'hui) : auto-publish
    (`api/content/[id]/status`), `indexing/submit`, `indexing/from-sitemap` (×3). Les routes surfacent
    `blocked:true` + message pointant vers sitemap/maillage/inspection.
  - **1re infra de test du repo** : vitest + `vitest.config.ts` (node, modules purs) + `npm run test`.
    `indexing-eligibility.test.ts` → 7 tests verts (dont le **test positif** exigé).
  - Doc : commentaire flag `indexnow` (flags.ts) + `.env.example` mis à jour (interrupteur maître).
- Vérif : `npm run test` = 7/7 · `npm run check` = **0 err / 42 warn** (baseline inchangée).

**Prochain :** **DATA-001** — cartographier + figer le schéma existant (~29 tables), stratégie
expand/migrate/contract, fixture DB anonymisée. Contrats skills GSC-003/IDX-003 = hors repo.

**Pièges :**
- 3 chaînes `jlabs-content-hub` **visibles client** non renommées (décision de marque en attente) :
  `src/routes/positions/[slug]/+page.svelte:101`, `src/lib/server/email-templates.ts:54,107`.
- Build local KO sur Windows (symlink adapter-vercel) → vérifier via `check` + `test`, pas `build`.
- Le toggle `autoSubmitOnPublish` (settings `+page.svelte`) est désormais **inopérant** pour les
  articles (garde IDX-008) : à annoter « déprécié » un jour (cosmétique, non bloquant).

---

## Etat session 2026-07-21

**Fait :**
- **OPS-001** logger structuré (`src/lib/server/log.ts`) : JSON-lines prod / texte dev, niveaux (`LOG_LEVEL`), masquage des champs secrets.
- **GOV-003** config runtime centralisée (`src/lib/server/config.ts`) : schéma des 21 env vars, `validateStartup()` log-only câblé au boot (`hooks.server.ts`), `requireEnv()` fail-fast au point d'usage ; `.env.example` nettoyé (GitHub mort retiré + doc flags/LOG_LEVEL).
- **GOV-005** feature flags (`src/lib/server/flags.ts`) : 7 flags OFF par défaut, override global `FLAG_<NOM>` + par projet, `describeFlags()`.
- **GOV-001 (interne)** `package.json` name + User-Agent → `seo-stats`.
- **GOV-002/004** baseline établie : `check` = 0 err / 42 warn (dette legacy `(app)/`) ; build local KO (EPERM symlink adapter-vercel, Windows, pas une régression) ; `src` propre de Turso.

**Prochain :** Enchaîner **IDX-008** dans `src/lib/server/indexing.ts` — neutraliser `publishUrl`/`batchSubmit` génériques (garder JobPosting/BroadcastEvent), gater derrière le flag `indexnow`. Puis **DATA-001** (cartographie des 29 tables). Contrats skills GSC-003/IDX-003 = hors repo.

**Pièges :**
- 3 chaînes `jlabs-content-hub` **visibles client** non renommées (décision de marque en attente) : `src/routes/positions/[slug]/+page.svelte:101`, `src/lib/server/email-templates.ts:54,107`. Cible = `seo-stats` / `jonlabs` / retirer ?
- Build local KO sur Windows (symlink adapter-vercel) → vérifier via `check`, pas `build`, en local.
- IDX-008 change le comportement prod (auto-submit) → obligatoirement derrière flag.

**Commit :** [4bbe9ef] [hub] docs: HANDOFF pointe sur E00 fondations · code : [3d9be7d] fondations cockpit (logger, config, flags)

---

## Carte du code
> Mise à jour : 2026-07-22

| Fichier | Rôle |
|---------|------|
| `src/lib/server/policy-state.ts` | Purs DATA-007 : `deriveScopeKey`, `nextPolicyVersion`, `canonicalPolicyConfig` (hash), `evaluatePolicyGates` (kill switch ⟂ sync), `canAutoSendReview` (§8.4), `resolveEffectiveKillSwitch`, `derivePromotionKind`, tuples (modes/statuts/kinds). |
| `src/lib/server/policy-state.test.ts` | Vitest DATA-007 — 29 tests (scope, versionnage, canonicalisation, invariant kill-switch⟂sync, éligibilité envoi, kinds). |
| `src/lib/server/policies.ts` | DATA-007 — `promotePolicy` transactionnel idempotent (+`computePolicyHash` sha256, journal), `setKillSwitch` (promotion journalisée sans toucher la sync), `getCurrentPolicy`/`getEffectivePolicy`. |
| `scripts/apply-data-007.ts` + `drizzle/manual-data-007.sql` | Application déterministe du DDL additif DATA-007 (`review_automation_policies` + `policy_promotions`). |
| `src/lib/server/proposal-state.ts` | Purs DATA-006 : `canActorApprove` (séparation des niveaux L0–L4), `isApprovalValid` (hash lié + expiration), `statusAfterPayloadChange`, tuples (statuts/niveaux/méthodes/vérif). |
| `src/lib/server/proposal-state.test.ts` | Vitest DATA-006 — 18 tests (niveaux d'approbation, validité hash/expiration, transitions). |
| `src/lib/server/proposals.ts` | DATA-006 — `createProposal` idempotent (+`computePayloadHash` sha256), `approveProposal` transactionnel (refus niveau), `updateProposalPayload` (invalidation), agent runs. |
| `scripts/apply-data-006.ts` + `drizzle/manual-data-006.sql` | Application déterministe du DDL additif DATA-006 (`action_proposals` + `proposal_approvals` + `agent_runs`). |
| `src/lib/server/finding-state.ts` | Purs DATA-005 : `deriveFindingFingerprint`, `computePriorityScore` (§10.2), `deriveSeverityEventType`/`deriveStatusEventType`, tuples de vocabulaire (types/statuts/sévérités/entités/événements/acteurs). |
| `src/lib/server/finding-state.test.ts` | Vitest DATA-005 — 27 tests (fingerprint stable, scoring borné, dérivation d'événements, vocab). |
| `src/lib/server/findings.ts` | DATA-005 — `upsertFinding` idempotent (`occurrence_count` atomique), `recordFindingEvent` append-only, `transitionFinding` transactionnel (statut+événement). |
| `scripts/apply-data-005.ts` + `drizzle/manual-data-005.sql` | Application déterministe du DDL additif DATA-005 (`findings` + `finding_events`). |
| `src/lib/server/observation-backfill.ts` | Purs MIGRATE : rollup page (position pondérée), sélection représentative keyword, mappers legacy→input d'upsert. |
| `src/lib/server/observation-backfill.test.ts` | Vitest MIGRATE — 13 tests (rollup, pondération, dédup keyword, mapping). |
| `scripts/backfill-observations.ts` | Runner MIGRATE (Pool+drizzle propres) : backfill idempotent des 4 tables d'observations, dédup intra-lot GSC, `--dry-run`. |
| `scripts/verify-backfill.ts` | Vérif read-only du backfill (invariants #obs/#clés, Σ impressions rollup, keyword_rank ⊆ tracked). |
| `src/lib/server/log.ts` | Logger structuré (OPS-001) — socle d'observabilité, masquage secrets. |
| `src/lib/server/config.ts` | Config runtime centralisée (GOV-003) — schéma env, `validateStartup`, `requireEnv`. |
| `src/lib/server/flags.ts` | Feature flags de migration (GOV-005) — 7 verticales OFF ; `indexnow` = interrupteur maître IDX-008. |
| `src/hooks.server.ts` | Import à effet de bord de `config.ts` → validation au boot serveur. |
| `.env.example` | Référence des 21 env vars + doc flags/LOG_LEVEL (secret-free). |
| `src/lib/server/indexing.ts` | Indexing API — garde IDX-008 (flag + éligibilité) sur `publishUrl`/`batchSubmit`. |
| `src/lib/server/indexing-eligibility.ts` | Purs IDX-008 : types éligibles + `evaluateIndexingGuard`. |
| `src/lib/server/db/schema.ts` | Modèle Drizzle (52 tables) ; +DATA-002/003/004/005/006/007 (intégrations, orchestration, 10 observations, findings+finding_events, proposals+approvals+agent_runs, review_automation_policies+policy_promotions). |
| `src/lib/server/observation-state.ts` | Purs DATA-004 : `deriveObservationFingerprint`, `computeWindowStart`/`isWithinWindow`, `assertBoundedPayload`. |
| `src/lib/server/observations.ts` | DATA-004 — upserts idempotents des 5 tables d'observation ancrées (gsc_query_page/gsc_page/index/keyword_rank/gmb_insight). |
| `scripts/apply-data-004.ts` + `drizzle/manual-data-004.sql` | Application déterministe du DDL additif DATA-004 (10 tables). |
| `src/lib/server/projection-state.ts` | Purs DATA-002 : `classifyProjection`, `assertNoInlineSecret`, `computeHealth`. |
| `src/lib/server/projections.ts` | DATA-002 — record/dedup/versionnage transactionnel des projections. |
| `src/lib/server/integrations.ts` | DATA-002 — upsert intégration (`onConflict`) + succès/erreur → santé. |
| `scripts/data-001-cartography.ts` | Introspection read-only Neon → cartographie + réconciliation modèle↔DB. |
| `scripts/apply-data-002.ts` + `drizzle/manual-data-002.sql` | Application déterministe du DDL additif DATA-002. |

### Décisions clés
- Config au boot **log-only** (pas de throw) pour protéger le daily driver ; fail-fast strict délégué à `requireEnv` au point d'usage.
- Flags OFF par défaut ; un flag route le comportement, n'efface jamais de donnée.
- **IDX-008** : garde à deux étages (flag maître `indexnow` + éligibilité type) ; refus audité en DB, zéro quota.
- **DATA-002 (expand seul)** : `resource_key` discrimine plusieurs propriétés/locations d'un provider ; projections en **historique** (unique `(project_id, source_hash)` + unique partiel `current`) ; garde `assertNoInlineSecret` sur payload/config ; secrets via `secret_ref`, jamais inline. **Pas de backfill/retrait** des tables héritées.
- **DATA-006 (expand seul)** : `action_proposals` + `proposal_approvals` + `agent_runs` (SPEC §7.8/§7.9/§12).
  **Approbation = table dédiée** (pas inline §7.8) : porte le **hash lié** (`approved_payload_hash`),
  périmètre, token one-time + expiration, statut propre → supporte lot (§12.3) + Telegram (§14.3) ;
  `action_proposals` garde `approved_by/at` en dénormalisé. **Statuts** = 7 de §7.8 **+ `invalidated` +
  `expired`** ; colonne **`payload_hash`** (sha256) à laquelle l'approbation se lie. **Invariants portés
  par le module pur** : `canActorApprove` (agent ≤ L2, policy ≤ L3, **L4 = user seul** — §12.2) +
  `isApprovalValid` (active + hash égal + non expiré). **Exécution/vérification non séparées** :
  `execution_job_id` FK→`jobs` + `verification_status` (pas de table exécution). Idempotence :
  unique `(project_id, finding_id, action_type, payload_hash)`. `agent_runs` distinct de
  `monitoring_runs` (raisonnement agent vs orchestration collecteur). **Pas d'agent/exécuteur/UI.**
- **DATA-005 (expand seul)** : `findings` + `finding_events` (SPEC §7.6/§7.7). **Statuts** = les 7 de §7.6
  **+ `reopened`** (§10.1) ; `new` transitoire (naît `open`). **Dédup** = unique `(project_id, fingerprint)`
  (fingerprint stable = miroir applicatif dans `finding-state.ts`, séparateur `\x1f`). **Preuves** =
  `evidence_json` **pointeurs** (ids d'observations), jamais de texte libre ni de FK dure. **Politique
  suppression observation** = série append-only jamais supprimée → références souples, aucune cascade
  (satisfait « interdit/géré par politique »). `run_id` **nullable** (traçabilité détecteur) ajouté
  au-delà de la liste §7.6. **`findings` sans `schema_version`** : versionnage par `detector_version`.
  `finding_events` **append-only** (insert seul, jamais update/delete). **Pas de détecteur/backfill/UI.**
- **DATA-004 (expand seul)** : 10 tables d'observations (SPEC §7.5), forme commune (provider, run_id,
  période/date, dims, métriques, payload borné, schema_version, fetched_at) ; unique d'upsert = dédup ;
  index (projet, période) = fenêtres 7/28/90 j. 5 ancrées + 5 spéculatives (expand additif). **Décision
  `ai_jobs` :** le « `ai_jobs → jobs type='ai'` » du plan initial est **écarté** — `ai_jobs` est un
  *result-store poll é* vivant (fire-and-poll, colonne `result`, lu par `GET /api/jobs/[id]`), pas la
  pull-queue durable que `jobs` modélise (claim/lease, aucune colonne résultat). Le folder mécanique
  polluerait `jobs`. `ai_jobs` reste du **legacy pré-agentique**, à retirer quand le flux review-reply
  devient agent+proposal (DATA-006/JOB-001), pas à remapper.
- Nouvelles tables appliquées par **SQL additif idempotent** (pas `db:push`) ; `schema.ts` reste source de vérité, vérif par re-run de l'introspection (zéro dérive).
- Renommage `jlabs-content-hub` limité à l'interne ; le client-facing est une décision de marque séparée.
- Branche `feat/cockpit` depuis `feat/neon` (isole la phase agentique ; `feat/neon` figée pour le cutover Vercel P5A).

## Reste du premier lot §9 (non fait)
- [ ] **GOV-001 (reste)** — marquer `Desktop/apps/jlabs-content-hub` legacy read-only (garder comme backup
      jusqu'au cutover), avertissement dans sa doc.
- [x] **DATA-001** (2026-07-21) — cartographie du schéma → `docs/DATA-001-cartography.md` (30 tables,
      zéro dérive, sort par table, doublons, expand/migrate/contract). Script read-only
      `scripts/data-001-cartography.ts`.
- [ ] **DATA-001b** — fixture DB anonymisée (seed synthétique, zéro donnée client). Différée de DATA-001.
- [ ] **GSC-003** — réparer le contrat réel de `~/.claude/skills/seo-gsc` (champ `page` fantôme dans
      `top_queries`) + adapter weekly/actions/refresh. **Hors repo (couche skills).**
- [ ] **IDX-003** — réparer le contrat de `~/.claude/skills/seo-index-diagnose` (`buckets` vs `results`)
      + `post_publication.py`. **Hors repo (couche skills).**
- [x] **IDX-008** (2026-07-21) — Google Indexing API restreinte : garde flag `indexnow` (OFF défaut)
      + validation de type (`JobPosting`/`BroadcastEvent`) dans `indexing.ts` (helpers purs
      `indexing-eligibility.ts`). Soumission générique refusée + auditée (`status:'blocked'`), zéro
      quota. 4 points d'entrée neutralisés. Doc sitemap/maillage = voie normale. 1re infra vitest +
      7 tests verts.
