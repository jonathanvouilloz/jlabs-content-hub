# seo-stats → Neon — Migration (1 base, 3 schémas)

> **Statut (2026-07-26) : migrée SUR LA BRANCHE, pas en production.** Le code Neon vit sur
> `feat/neon`, absorbé dans `feat/cockpit`. **`main` — ce que Vercel déploie — porte encore le code
> libsql** (`git show main:src/lib/server/db/index.ts`, dernier commit `af6da45` du 2026-07-15).
> **Donc Turso EST toujours la base de production** et reçoit encore les écritures des crons.
> Décision : **une seule base Neon (`neondb`), trois schémas Postgres** `core` / `invoices` / `seostats`.
>
> Le bandeau précédent disait « migration TERMINÉE côté code et données » : vrai pour l'arbre de
> travail, faux pour la prod. C'est cet écart qui a laissé passer 5 jours de dérive Turso→Neon.
> **Reste : Phase 5A (cutover), puis Phase 6 (rotation du password, décommissionnement de Turso).**

## ⚡ Résumé de l'état (à jour)

- ✅ **Phase 0-2** (Neon restructuré 3 schémas + côté invoices) — fait + vérifié 2026-07-20.
- ✅ **Phase 3** (refactor code seo-stats Turso→Neon) — **FAIT** : `db/index.ts` neon-serverless, `schema.ts`
  29 tables en `pgSchema('seostats')`, `drizzle.config` postgresql + `schemaFilter ['core','seostats']`,
  FK `projects.slug → core.entities.slug`, deps basculées. Commit `feat/neon`.
- ✅ **Phase 4** (données Turso → Neon `seostats`) — **FAIT + VÉRIFIÉ 2026-07-21**. Les 29 tables sont
  chargées dans `seostats` (counts identiques à Turso, ex : `gsc_query_page_data` 73009, `gmb_reviews` 358,
  `contents` 92). Slug `bis-repetita` **canonicalisé en `bisrepetita`**. Transforms OK (bool 0/1→bool PG,
  dates texte→timestamptz). FK `projects_slug_fk → core.entities.slug` posée, **0 orphelin**. Vérif par
  `scripts/migrate/03-verify-state.mjs`. Le doc précédent marquait cette phase « à faire » à tort.
- ✅ **Phase 5** (app déplacée dans le noyau) — **FAIT** : le repo vit à `noyau/seo-stats`.
- ⏳ **Phase 5A** (cutover) — **RESTE**. Données rattrapées le 2026-07-26 ; il reste les deux gestes de
  bascule (variable Vercel + merge/push). Détail → section « Phase 5A » ci-dessous.
- ⏳ **Phase 6** — **deux gestes d'INFRA** (aucun code concerné), **bloqués par 5A** : on ne rote pas le
  password ni ne supprime Turso tant que Turso *est* la prod. `.env` local repointé sur Neon le
  2026-07-21 ; `@libsql/client` et `DATABASE_AUTH_TOKEN` retirés du repo (sur `feat/neon`, pas sur `main`).
- ✅ **Ex-bloquant** : canonicalisation `bis-repetita → bisrepetita` — résolue au load (Phase 4).

## Décision d'architecture

Invoices et seo-stats partagent la **même base Neon**, isolés par **schéma Postgres** :

```
neondb
├── core       → entities (registre canonique des slugs, = miroir de projects.yaml)
├── invoices   → clients, invoices, invoice_items, quotes, expenses, settings   (FK slug → core.entities)
└── seostats   → 30 tables (projects + SEO/GMB/LinkedIn/indexing/auth)           (FK slug → core.entities)
```

- **Pourquoi `core` et pas « clients »** : les entités se recoupent partiellement.
  - Facturation ∩ SEO (exact) : `barberconcept`.
  - Même entité, slug à corriger : `bis-repetita` (SEO) = `bisrepetita` (invoices).
  - SEO seul : `jonlabs`, `physiopommier`, `spinlink`, `wildcat`.
  - Facturation seule : `bc-chenois`, `cpv`, `swiss-dental-care`.
  → `core.entities` est le **superset** (registre de slugs). Chaque app accroche ses
  tables riches à un slug canonique par FK. Loi n°3 enfin garantie par contrainte.
- **Anti-footgun Drizzle** : chaque `drizzle.config` a un `schemaFilter` limité à ses schémas
  → `drizzle-kit push` d'une app ne voit/ne drop jamais les tables de l'autre.
  - invoices : `schemaFilter: ['invoices', 'core']` (invoices = propriétaire de `core`).
  - seostats : `schemaFilter: ['seostats']` (référence `core` en FK/lecture seule, ne le migre pas).

## État constaté (vérifié dans le code + les bases, 2026-07-20)

- **Neon `neondb`** : schéma `public` uniquement, 6 tables invoices, données live
  (clients=5, invoices=9, invoice_items=9, settings=1, quotes=0, expenses=0). `clients.slug` existe déjà.
- **Turso (hub)** : 30 `sqliteTable`. Entité centrale `projects` (`slug` unique, `client_email`),
  ~26 tables FK vers `projects.id`. 6 projets (voir tableau recoupement ci-dessus).
  Auth = Better Auth (`user`/`session`/`account`/`verification`) → **conservée**, va dans `seostats`.
- Repo hub : git propre, `origin` GitHub, déployé Vercel. Crons via `.claude/scheduled_tasks`.

## État d'avancement

- **✅ P0 / P1 / P2 FAITS + vérifiés (2026-07-20).** Base Neon `neondb` (endpoint prod `ep-soft-wave`)
  découpée en 3 schémas `core` / `invoices` / `seostats`. `core.entities` seedé (9 slugs). 6 tables
  invoices déplacées `public → invoices` (données intactes : clients 5, invoices 9, items 9, settings 1).
  FK `clients_slug_fk` (NOT NULL) + `quotes_slug_fk` posées. Code invoices repointé (`pgSchema`,
  `schemaFilter: ['core','invoices']`). Vérif : typecheck 0 erreur, `drizzle-kit push` = **No changes**,
  jointure `clients ↔ core.entities` OK. Backup = branche Neon `pre-schema-split` (`ep-polished-shadow`,
  intacte) + dump JSON. Baseline Drizzle versionnée : `invoices/drizzle/0000_baseline.sql` (+ `meta/`
  snapshot) ; le split one-time est archivé en `invoices/drizzle/manual/2026-07-20_schema-split.sql`.
- **⏳ Reste : P6, deux gestes d'infra** (roter password Neon + supprimer Turso). P3/P4/P5 faits. Voir phases ci-dessous.
- **⚠️ À faire hors-code** : roter le mot de passe Neon (`npg_k4teo0HIxPKF…`) exposé en clair.

## Phases

### Phase 0 — Pré-requis & canonicalisation slugs
- [ ] Trancher le slug canonique `bisrepetita` vs `bis-repetita` contre `cerveau/_system/projects.yaml`.
      Corriger dans la base perdante (probablement renommer côté seo-stats vers le canon invoices, ou l'inverse).
- [ ] Audit rapide des 6 autres slugs vs `projects.yaml` (casse, tirets) — cf. tâche « slug-check » _MIGRATION §5.
- [ ] Confirmer que le projet Neon visé est bien celui de l'URL (`neondb`), pas une 2e base « seostats » créée à part.
      Si une base `seostats` vide existe dans le même projet → la supprimer, on consolide sur `neondb`.
- [ ] **Backup** : dump complet Neon `neondb` (les 6 tables invoices) AVANT toute restructuration.

### Phase 1 — Restructurer Neon (schémas + core)
- [ ] `create schema core; create schema invoices; create schema seostats;`
- [ ] Déplacer les 6 tables invoices `public.* → invoices.*` (`alter table ... set schema invoices`).
- [ ] Créer `core.entities(slug text primary key, name text, kind text, created_at timestamptz default now())`.
      Seed : union des slugs {clients invoices} ∪ {projects seo-stats} ∪ projects.yaml, après canonicalisation P0.
- [ ] `invoices.clients` : ajouter FK `slug → core.entities.slug` (garder les colonnes billing name/email/address).
- [ ] Vérifier que l'app invoices tourne toujours (elle lit `invoices.clients`).

### Phase 2 — Code invoices (repointer sur schéma `invoices`)
- [ ] `schema.ts` : envelopper les tables dans `pgSchema('invoices')`, `clients.slug` → FK `core.entities`.
      (Nouveau `pgSchema('core')` pour `entities`.)
- [ ] `drizzle.config.ts` : ajouter `schemaFilter: ['invoices', 'core']`.
- [ ] `db:push` en dry-run, vérifier qu'aucune table seostats/inconnue n'est touchée. Build + smoke test.

### Phase 3 — Code seo-stats : refactor Turso → Neon — ✅ FAIT (commit `feat/neon`)
- [ ] `db/index.ts` : `drizzle-orm/libsql` + `@libsql/client` → `drizzle-orm/neon-http` + `@neondatabase/serverless`.
- [ ] `drizzle.config.ts` : dialect `turso` → `postgresql` ; `dbCredentials.url = DATABASE_URL` (Neon) ;
      `schemaFilter: ['seostats']`.
- [ ] `schema.ts` : `sqliteTable` → `pgTable` dans `pgSchema('seostats')` (×30). Conversions :
      - `integer(..., { mode: 'boolean' })` → `boolean()`
      - `text('created_at').default(sql\`(datetime('now'))\`)` → `timestamp(..., { withTimezone: true }).defaultNow()`
      - `text('id').primaryKey()` : garder (ids applicatifs texte/uuid) — ne PAS auto-incrémenter.
      - Better Auth : ses 4 tables restent, en `seostats`. Vérifier l'adaptateur Drizzle Postgres.
      - `projects.slug` → ajouter FK `→ core.entities.slug` (FK cross-schéma, lecture seule côté seostats).
- [ ] `.env.example` : `DATABASE_URL` = Neon `postgresql://...` ; retirer `DATABASE_AUTH_TOKEN`.
- [ ] `npm i @neondatabase/serverless` ; retirer `@libsql/client` des deps.
- [ ] `db:push` (schemaFilter seostats) → crée les 30 tables dans `seostats`. Build.

### Phase 4 — Migration des données Turso → Neon `seostats` — ✅ FAIT + VÉRIFIÉ (2026-07-21)
- [x] Export des 29 tables depuis Turso (`scripts/migrate/01-export-turso.mjs`, libsql → JSON, ~75k lignes).
- [x] Transform types : bool sqlite (0/1) → bool PG ; dates texte → timestamptz ; NULL cohérents.
- [x] Load dans `seostats.*` (ordre FK : `projects` d'abord, puis le reste).
- [x] Poser les FK `seostats.projects.slug → core.entities.slug` (slug `bis-repetita → bisrepetita` au load).
- [x] Vérif intégrité : counts par table = source ; FK OK (0 orphelin) ; échantillon de lignes identique.
      Scripts de vérif reproductibles : `scripts/migrate/02-reconcile.mjs` + `03-verify-state.mjs`.
> **Note** : la vérif du 2026-07-21 a constaté que la data était **déjà chargée** dans Neon (load exécuté
> lors d'une session antérieure non tracée). Aucun re-load n'a été fait — seule la vérif a tourné.

### Phase 5 — Déplacer l'app dans le noyau — ✅ FAIT (repo à `noyau/seo-stats`)
- [ ] Déplacer `Desktop/apps/jlabs-content-hub` → `noyau/seo-stats` (dossier entier : `.git`, `.vercel`, `.env`, `.seo-data`).
      Remplace le placeholder actuel (`README-MIGRATION.md`).
- [ ] Vercel : env `DATABASE_URL` → Neon ; retirer `DATABASE_AUTH_TOKEN` ; crons → Vercel Cron si besoin.
- [ ] `npm ci`, `npm run build`, smoke test dashboard + une route API skill.
- [ ] Mettre à jour `projects.yaml` (`repo_path` seo-stats) + `_MIGRATION.md` (§4 → fait).

### Phase 5A — Cutover (mettre la prod sur Neon) — ⏳ RESTE

Périmètre tranché le 2026-07-26 : **merger `feat/neon` seul**, pas `feat/cockpit`. `main → feat/neon`
est un **fast-forward** ; `vercel.json` est identique des deux côtés (aucun cron ne change). E00 étant
en cours, `feat/cockpit` reste devant et se mergera epic fini.

- [x] **Rattrapage des données prod (2026-07-26)** — 222 lignes insérées dans Neon : `gsc_snapshots` 4,
      `gsc_weekly_diffs` 4, `gsc_query_page_data` 211 (semaine 2026-07-13, 4 projets), `contents` 1
      (article publié le 2026-07-24 par l'autopilot), `status_history` 2. Outillage :
      `scripts/migrate/05-drift-report.mjs` (diff, lecture seule) + `06-backfill-delta.mjs` (ajout seul,
      idempotent). Contrôle : 79 FK vérifiées, 0 orphelin ; re-dry-run à 0 insérable.
      **Volontairement NON rattrapé** : 25 986 lignes (8 snapshots + 8 diffs + leurs 25 970 filles) pour
      les semaines 2026-07-06 et 2026-07-13 déjà recollectées par le job cockpit, qui pagine mieux que
      le cron prod (ex. 13 591 lignes contre 11 579 pour le même projet-semaine). Les insérer
      violerait l'unique `(project_id, week_start)` — et surtout dédoublerait les agrégats de la semaine.
- [ ] **Vercel → Production → `DATABASE_URL` = URL Neon (`ep-soft-wave`), supprimer `DATABASE_AUTH_TOKEN`.**
      À faire **avant** le push : une variable Vercel ne s'applique qu'aux déploiements suivants, donc
      ce geste seul ne touche pas la prod en cours. C'est ce décalage qui rend la bascule sans coupure.
      Le build lui-même exige `DATABASE_URL` (le module `db/index.ts` jette à l'import, pendant l'analyse
      de prerender) : sans la variable, le déploiement échoue au build — sans casser la prod en place.
- [ ] `git switch main && git merge --ff-only feat/neon && git push origin main` → Vercel bâtit et
      déploie avec la nouvelle variable. Bascule atomique, aucune fenêtre code/URL contradictoires.
- [ ] Rejouer `06-backfill-delta.mjs` après la bascule pour absorber les écritures de la fenêtre de build.
- [ ] Vérifs prod : `/api/projects` (6 projets), login réel (adaptateur Better Auth `pg`), une route GSC,
      logs sans `libsql`, puis le cron `gmb-publish` du lendemain 09:00 UTC écrivant bien dans Neon.

**Créneau** : un après-midi UTC. Les 4 crons tirent entre 06:00 et 09:00 UTC ; éviter le lundi matin.

**Rollback** : Turso reste intact. `git revert` du merge + push, restaurer `DATABASE_URL` libsql et
`DATABASE_AUTH_TOKEN` en Production Vercel, redéployer. Les deux valeurs sont conservées en commentaire
dans le `.env` local (c'est aussi d'elles que `05`/`06` tirent leur accès Turso).

⚠️ **Ne jamais lancer `npm run db:push` depuis `main`.** Après le merge, `main` déclare **29 tables**
dans `schema.ts` alors que Neon `seostats` en porte **59** : drizzle-kit proposerait de dropper les 30
tables cockpit (`jobs`, `findings`, `observations`, `index_selection`…). Le `schemaFilter
['core','seostats']` ne protège de rien ici — il filtre les schémas, pas les tables. Interdit tant que
`feat/cockpit` n'est pas mergé.

⚠️ **Aucun lockfile n'est commité** (`package-lock.json` est dans `.gitignore`) et 5 dépendances sont
épinglées sur `"latest"`. Vercel résout donc les versions **au moment du build** : le déploiement de
cutover ne tirera pas les versions du dernier build prod (2026-07-15). Constaté en local le 2026-07-26 —
un `npm install` frais donne `@sveltejs/kit` 2.70.1 et `better-auth` 1.6.25 contre 2.57.1 / 1.6.7
installés. Non bloquant (un build raté ne déploie rien), mais c'est le vrai risque du push.

### Phase 6 — Nettoyage — ⏳ deux gestes d'INFRA, BLOQUÉS par 5A
- [x] `.env` **local** repointé Turso → Neon (2026-07-21). Le code (`neon()`) ne parle plus que Postgres.
- [x] `@libsql/client` retiré des dépendances, `DATABASE_AUTH_TOKEN` retiré de `.env` / `.env.example`.
- [ ] **Roter le mot de passe Neon** (`npg_k4teo0HIxPKF...`) — exposé en clair en chat les 2026-07-20/21.
      **Volontairement pas encore roté** (décision Jonathan 2026-07-21). ⚠️ `neondb` est **partagée avec
      `noyau/invoices`** : la rotation casse les deux apps si elle n'est pas propagée en une passe —
      Vercel Production de `jlabs-content-hub` **et** de l'app invoices, plus les deux `.env` locaux.
- [ ] Décommissionner Turso **après** la Phase 5A et quelques jours de prod Neon verte. ⚠️ Avant de
      supprimer : `05-drift-report.mjs` et `06-backfill-delta.mjs` lisent Turso, et `01-export-turso.mjs`
      ne tourne plus tel quel (`@libsql/client` a été retiré des dépendances). Faire un dernier export
      via l'API HTTP libsql, comme le font `05`/`06`, avant de couper.
- [ ] Vérifier les skills SEO qui tapent l'API du hub (chemins/URL inchangés normalement).

## Points de vigilance

- **Ordre critique** : canonicaliser les slugs (P0) AVANT de poser les FK (P1/P4), sinon `bis-repetita`
  casse la contrainte.
- **Better Auth sur Postgres** : valider l'adaptateur (les 4 tables auth). Différence SQLite→PG possible sur les types.
- **`projects.id` texte** : ne pas le convertir en serial. Toutes les FK internes seo-stats en dépendent.
- **Deux apps, une base** : couplage de disponibilité assumé (solo). Discipline migrations = schemaFilter obligatoire.
- **Ne jamais committer** `.env` / URL Neon dans les repos.
