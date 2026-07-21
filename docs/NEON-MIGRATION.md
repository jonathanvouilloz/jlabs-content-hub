# seo-stats → Neon — Migration (1 base, 3 schémas)

> **Statut réel (2026-07-21) : refactor CODE fait + commité (branche `feat/neon`, typecheck 0 err).
> App déjà dans `noyau/seo-stats`. Il RESTE la migration des DONNÉES (Phase 4) et le cutover (Phase 6).**
> Décision : **une seule base Neon (`neondb`), trois schémas Postgres** `core` / `invoices` / `seostats`.
> Les cases à cocher des phases ci-dessous étaient périmées — corrigées ci-dessous.

## ⚡ Résumé de l'état (à jour)

- ✅ **Phase 0-2** (Neon restructuré 3 schémas + côté invoices) — fait + vérifié 2026-07-20.
- ✅ **Phase 3** (refactor code seo-stats Turso→Neon) — **FAIT** : `db/index.ts` neon-serverless, `schema.ts`
  30 tables en `pgSchema('seostats')`, `drizzle.config` postgresql + `schemaFilter ['core','seostats']`,
  FK `projects.slug → core.entities.slug`, deps basculées. Commit `feat/neon`.
- ✅ **Phase 5** (app déplacée dans le noyau) — **FAIT** : le repo vit à `noyau/seo-stats`.
- ⏳ **Phase 4** (données Turso → Neon `seostats`) — **À FAIRE**. Le schéma existe dans Neon (vide/partiel),
  les données sont encore sur Turso. C'est le prochain gros chantier avant de reconstruire (SPEC/BACKLOG).
- ⏳ **Phase 6** (roter password Neon exposé, décommissionner Turso) — **À FAIRE**.
- ⚠️ **Pré-Phase 4 bloquant** : canonicaliser `bis-repetita` vs `bisrepetita` AVANT de poser la FK slug.

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
- **⏳ Reste : P3 → P6** (seo-stats). Voir phases ci-dessous.
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

### Phase 4 — Migration des données Turso → Neon `seostats` — ⏳ PROCHAIN CHANTIER
- [ ] Export des 30 tables depuis Turso (script Node libsql → JSON, ou `turso db dump`).
- [ ] Transform types : bool sqlite (0/1) → bool PG ; dates texte → timestamptz ; NULL cohérents.
- [ ] Load dans `seostats.*` (ordre FK : `projects` d'abord, puis le reste).
- [ ] Poser les FK `seostats.projects.slug → core.entities.slug` une fois les slugs canonicalisés.
- [ ] Vérif intégrité : counts par table = source ; FK OK ; échantillon de lignes.

### Phase 5 — Déplacer l'app dans le noyau — ✅ FAIT (repo à `noyau/seo-stats`)
- [ ] Déplacer `Desktop/apps/jlabs-content-hub` → `noyau/seo-stats` (dossier entier : `.git`, `.vercel`, `.env`, `.seo-data`).
      Remplace le placeholder actuel (`README-MIGRATION.md`).
- [ ] Vercel : env `DATABASE_URL` → Neon ; retirer `DATABASE_AUTH_TOKEN` ; crons → Vercel Cron si besoin.
- [ ] `npm ci`, `npm run build`, smoke test dashboard + une route API skill.
- [ ] Mettre à jour `projects.yaml` (`repo_path` seo-stats) + `_MIGRATION.md` (§4 → fait).

### Phase 6 — Cutover / nettoyage
- [ ] **Roter le mot de passe Neon** (`npg_k4teo0HIxPKF...`) — exposé en clair en chat le 2026-07-20.
- [ ] Décommissionner Turso (garder un dump archivé) une fois la prod Neon validée quelques jours.
- [ ] Vérifier les skills SEO qui tapent l'API du hub (chemins/URL inchangés normalement).

## Points de vigilance

- **Ordre critique** : canonicaliser les slugs (P0) AVANT de poser les FK (P1/P4), sinon `bis-repetita`
  casse la contrainte.
- **Better Auth sur Postgres** : valider l'adaptateur (les 4 tables auth). Différence SQLite→PG possible sur les types.
- **`projects.id` texte** : ne pas le convertir en serial. Toutes les FK internes seo-stats en dépendent.
- **Deux apps, une base** : couplage de disponibilité assumé (solo). Discipline migrations = schemaFilter obligatoire.
- **Ne jamais committer** `.env` / URL Neon dans les repos.
