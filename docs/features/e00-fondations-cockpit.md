# Feature — E00 Fondations (reconstruction agentique)

> Premier lot exécutable du BACKLOG (§9) pour la reconstruction cockpit agentique.
> SPEC source : `docs/SPEC.md` v0.2 · Backlog : `docs/BACKLOG.md` E00.
> Branche : `feat/cockpit` (depuis `feat/neon`).

## Etat session 2026-07-22 (DATA — migrate/backfill)

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
| `src/lib/server/db/schema.ts` | Modèle Drizzle (45 tables) ; +DATA-002/003/004 (intégrations, orchestration, 10 observations). |
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
