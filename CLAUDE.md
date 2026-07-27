# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this project

**seo-stats** — cockpit agentique de monitoring SEO & présence locale (web app SvelteKit). Surveille, diagnostique et pilote le SEO/GMB de tous les projets clients, avec délégation aux agents IA + validation humaine des actions sensibles. Vision : `docs/SPEC.md`. Exécution : `docs/BACKLOG.md`.

Source de vérité DB = **Neon (Postgres)**, schéma `seostats` d'une base partagée avec `invoices` (voir `docs/NEON-MIGRATION.md`). Ex "Content Hub" / "jokiSEO". La sync GitHub a été retirée en 2026-05 (le repo `content/` reste une archive figée).

> ✅ **En production depuis le 2026-07-26 14:35 UTC.** Cutover fait : `main` porte `e5efc83` (fast-forward de `feat/neon`), Vercel a déployé avec `DATABASE_URL` = Neon, et la prod l'annonce elle-même (`/api/whoami` → `version: e5efc83`, 6 projets). **Turso n'est plus lu ni écrit** (figé au 2026-07-26 09:00 UTC). Reste la **Phase 6** : rotation du password, décommissionnement de Turso. Voir `docs/NEON-MIGRATION.md`.
>
> ⚠️ **`npm run db:push` depuis `main` est maintenant un risque de PROD** : `main` déclare 29 tables, Neon en porte 60 — drizzle-kit proposerait de dropper les 31 tables cockpit. Interdit tant que `feat/cockpit` n'est pas mergé.

## Stack technique

| Couche | Choix |
|--------|-------|
| Framework | SvelteKit (Svelte 5, runes) |
| Database | Neon (Postgres), schéma `seostats` — base partagée avec `invoices` |
| ORM | Drizzle |
| Auth | Better Auth (email/password) |
| Hosting | Vercel |

## Architecture

```
src/
├── lib/
│   ├── server/
│   │   ├── db/
│   │   │   ├── index.ts     # Client Neon (neon-serverless + Pool)
│   │   │   ├── schema.ts    # Schema Drizzle (5 tables)
│   │   │   └── seed.ts      # Seed content_types
│   │   ├── auth.ts          # Config Better Auth
│   │   ├── api-auth.ts      # Validation API key + client token
│   │   └── utils.ts         # createId()
│   └── utils/
│       ├── content.ts       # Parse frontmatter, render markdown
│       ├── dates.ts         # Formatage dates
│       └── slugify.ts       # Generation de slugs
├── routes/
│   ├── api/
│   │   ├── content/         # POST + GET (liste)
│   │   │   └── [id]/        # GET + PUT + DELETE
│   │   │       └── status/  # PATCH (changement statut)
│   │   ├── projects/        # POST + GET
│   │   │   └── [slug]/      # PUT
│   │   │       └── token/   # POST (regenerer token)
│   │   ├── comments/        # POST
│   │   │   └── [id]/        # DELETE
│   │   └── auth/[...all]/   # Better Auth catch-all
│   ├── (app)/               # Routes admin (protegees par auth)
│   │   ├── +page            # Dashboard stats + derniers contenus
│   │   ├── projects/        # Liste projets, nouveau projet, detail projet
│   │   └── content/[id]/    # Detail contenu + commentaires + changement statut
│   ├── (auth)/login/        # Page login
│   └── view/[project_slug]/ # Vue client publique (a implementer)
```

## Schema DB (10+ tables)

Tables auth (Better Auth) :
- `user` : id, name, email, emailVerified, image
- `session` : id, expiresAt, token, ipAddress, userAgent, userId (FK)
- `account` : id, accountId, providerId, userId (FK), password
- `verification` : id, identifier, value, expiresAt

Tables application :

- `projects` : id, name, slug (unique), color, access_token, archived, client_email, weekly_digest_enabled
- `projects.slug` porte une **FK cross-schéma → `core.entities.slug`** (registre canonique des slugs, possédé par `invoices`). C'est la liaison client↔projet SEO : un client facturé et un projet SEO se rejoignent par le même slug. `core` est déclaré en miroir lecture-seule dans `schema.ts` — ne jamais le modifier depuis seo-stats.
- `contents` : id, project_id (FK), type, title, slug, body, status, planned_date, published_at, tags, meta — unique (project_id, type, slug). **Pas de sync GitHub** : Neon `seostats` est l'unique source de vérité.
- `comments` : id, content_id (FK), author_name, author_email, body
- `content_types` : id, slug (unique), label, icon — seed: article, linkedin, gmb
- `status_history` : id, content_id (FK), from_status, to_status, changed_by, changed_at
- `publish_logs` : id, content_id (FK), project_id (FK), channel, location_id, location_label, success, gmb_post_id, error_message, attempted_at, duration_ms, source — 1 row par tentative de publication par location (cron ou manual). Lu par /projects/[slug]/gmb-logs et le digest quotidien.
- `gmb_location_profiles` : snapshot complet d'une fiche GMB par (project_id, gmb_location_id). Colonnes scalaires (title, phone, websiteUri, primaryCategory, openStatus, latlng) + JSON blobs (storefrontAddress, regularHours, specialHours, serviceItems, additionalCategories, attributes) + raw_payload pour debug. Sync lazy (>1h) ou via bouton "Resynchroniser".
- `gmb_insights_daily` : metrique journaliere Performance API. 1 row par (gmb_location_id, date, metric). Metrics : BUSINESS_IMPRESSIONS_{DESKTOP,MOBILE}_{MAPS,SEARCH}, WEBSITE_CLICKS, CALL_CLICKS, BUSINESS_DIRECTION_REQUESTS. Agreges en 30j / mois / annee sur la page Fiche Google > Stats.
- `gmb_profile_edits` : audit log des editions de fiche depuis le hub (section=basic|hours, update_mask, payload, success, error_message).
- `weekly_reports` (REP-003 + REP-004) : le rapport hebdo **publié**, 1 ligne par (créneau, révision) — `period_slot` est un créneau LOCAL (`2026-07-27T09:00`), l'unique porte **`(period_slot, revision)`**. **Aucun `project_id`** — première table du schéma dans ce cas, parce que le rapport est cross-projet. Porte `slot_at`/`due_at`/`published_at` (le SLO se **dérive** de la **première** publication, jamais de colonne de verdict), `readiness_json`, `payload_json` (le JSON REP-001 tel quel), `revision`/`revision_reason`/`supersedes_id`, et depuis REP-004 lot 2 cinq colonnes de rétention (`payload_bytes`/`payload_digest`/`payload_archived_at`/`payload_archive_ref`/`payload_purged_at`). **Jamais d'UPDATE de contenu ni de DELETE** : le tick n'écrit que `revision = 1` (republier = no-op), une révision délibérée **ajoute** une ligne avec sa raison obligatoire (CHECK), et la rétention retire le **détail** sans jamais retirer la **ligne** (CHECK `weekly_reports_payload_presence_check` : pas de payload ⇒ adresse d'archive, date de purge et empreinte obligatoires).

Statuts : draft → review → approved → published

**GMB auto-approve (epic 18) :** POST /api/content avec type=gmb insère directement en `status='approved'` (au lieu de draft). Le cron /api/cron/gmb-publish (9h00) prend tous les posts approved + plannedDate<=now et publie sur Google API. → Pipeline full-auto : `/publish-hub` GMB → posts publiés aux dates prévues sans validation manuelle. **À garder en tête : checker /projects/{slug}/gmb après chaque /publish-hub** (un calendrier mal calibré sera publié sans relecture).

**Tracking employes mentionnes dans les avis :**
- `gmb_reviews.mentioned_employees` (JSON `[{name, sentiment}]`) — rempli par /gmb-review-responder via POST /api/projects/{slug}/employee-mentions (idempotent par reviewId).
- `employee_mentions` (project_id, employee_name, year, month, mention_count, positive_count, neutral_count, negative_count) — agregat mensuel pour le rapport UI sur la page Avis du projet.

**Format GMB canonique :** `POST /api/content` avec `type=gmb` accepte soit un post unique JSON, soit un tableau de posts (calendrier mensuel). Si c'est un tableau, le hub crée automatiquement 1 row par post (meme logique que le split LinkedIn). C'est le format produit par le skill `/gmb-generate`.

## API Auth (3 mecanismes)

1. **API Key** (Claude Code → Hub) : `Authorization: Bearer {API_KEY}`
2. **Client Token** (acces client) : query param `?token={access_token}`
3. **Session admin** (dashboard) : Better Auth cookie

## Lancer le projet

```bash
npm install
npm run dev          # localhost:5173
npm run db:push      # sync schema vers Neon (schemaFilter: core + seostats)
npm run db:generate  # generer migrations
npm run db:studio    # Drizzle Studio
```

## Notifications email + Vercel Blob (epic 18)

Variables d'env requises (voir `.env.example`) :

- `RESEND_API_KEY` — Resend (domaine `jonlabs.ch` à vérifier dans le dashboard, DKIM/SPF/DMARC)
- `ADMIN_EMAIL`, `FROM_EMAIL` — destinataire admin / expéditeur
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob store (auto-injecté si lié au projet via dashboard)
- `CRON_SECRET` — bearer attendu par les routes `/api/cron/*`

Crons (vercel.json) :
- `/api/cron/tick` — **horaire** (JOB-005) — planifie les cadences dues en heure métier `Europe/Zurich` (DST comprise), **draine la file de jobs** (worker borné + reaper + **passe de dépendances**, JOB-004), **puis tente la publication du rapport hebdo** (REP-003 : publie si les steps du créneau sont conclus, ou à l'échéance). C'est le seul chemin par lequel la queue avance en production : sans lui, un job relancé depuis `/jobs` ne repartirait jamais. Idempotent par créneau local — rejouer un tick, redémarrer, ou rattraper un créneau manqué sont la même opération.
- `/api/cron/gmb-publish` — quotidien 9h00 — publie les posts GMB dus + envoie le digest admin (idempotent via `gmb_settings.last_daily_digest_date`)
- `/api/cron/gmb-weekly-digest` — lundi 8h00 — récap hebdo aux clients opt-in (`projects.weekly_digest_enabled = true` + `client_email` renseigné)
- `/api/cron/linkedin-publish` — quotidien 9h00

> ⚠️ **`/api/cron/gsc-snapshot` n'est plus planifié** (GSC-002). La collecte GSC passe par la file :
> `collect:gsc_query_page`, enfilé par la cadence hebdo (lundi 09:00 `Europe/Zurich`) et drainé par
> le tick. La route reste appelable **à la main** pour un rattrapage. **Ne pas la replanifier** : les
> 6 projets partagent un seul service account, donc un seul pool de quota — deux chemins de collecte
> le consommeraient deux fois pour la même donnée.

Critical errors (email immédiat à `ADMIN_EMAIL`, dedup 1h via `gmb_settings.critical_sent_*`) :
- Refresh token Google échoué
- Une location GMB échoue 3x de suite

## Skill /publish-hub + Vercel Blob

Pour les images GMB, le skill `/publish-hub` doit :
1. Pour chaque image locale référencée dans le calendrier GMB JSON, POST multipart vers `/api/blob/upload` (champs `file`, `project_slug`, `filename`, max 4 MB)
2. Substituer `image_url` dans le JSON par l'URL Blob retournée
3. POST le calendrier enrichi vers `/api/content`

## Conventions de commit

```
[{projet}] {add|update|fix}: description courte
[hub] update: description pour les changements globaux
```

## Documentation

- `docs/SPEC.md` — **Vision produit canonique** (cockpit agentique de monitoring, décisions validées)
- `docs/BACKLOG.md` — **Backlog d'exécution** (14 epics E00→E13, jalons M0→M6, premier lot §9)
- `docs/HANDOFF.md` — Index de reprise (état + prochaine étape) — **lire en premier**
- `docs/NEON-MIGRATION.md` — Migration Turso→Neon (état par phase)
- `docs/PLAN.md` — Historique du socle livré (Phases 1-2, epics 1-23)
- `docs/DECISIONS.md` — Log des décisions techniques
- `docs/STYLEGUIDE.md` · `docs/CMS-JSONLD-GUIDE.md` — Conventions code/design, guide CMS
- `docs/features/*.md` — Détail des features livrées
- `docs/_archive/` — Docs obsolètes (PRD Content Hub, PRD jokiSEO, redesign, sync GitHub…)

## Etat actuel

**Date :** 2026-07-27
**Produit :** **seo-stats** — cockpit agentique de monitoring SEO & présence locale. Ex "Content Hub" / "jokiSEO".
**Cap :** déléguer 90% du monitoring récurrent aux agents (findings persistants + validation humaine). Voir `docs/SPEC.md`.
**Chantier transverse :** migration Turso → Neon **TERMINÉE et déployée** (cutover 2026-07-26 14:35 UTC, `main` = `e5efc83`). Turso est figé et n'est plus lu. Les deux gestes d'infra restants (rotation du password, suppression de Turso) ne sont plus bloqués. ⚠️ **Le cockpit (E00) n'est toujours PAS en prod** : `main` porte le code Neon *d'avant* le cockpit — pas de `/jobs`, pas de `/inbox`, pas de cron `tick`. La prod déployée est le socle epics 1-23 sur Neon.
**DB prod :** Neon `neondb`, schéma `seostats` (partagé avec `invoices` via schéma `core`). **61 tables** en base ; `main` n'en déclare que 29 (le cockpit vit sur `feat/cockpit`). ~6 projets GSC.
**Socle livré :** epics 1-22 DONE, epic 23 (positions GSC) en prod. Refactor in-place, DataForSEO = fournisseur SEO externe.
**Admin :** contact@jonlabs.ch
**Collecte (E03) :** **GSC-001+002 livrés** — `collect:gsc_query_page` est le premier type de job qui appelle vraiment un provider. Il pagine Search Analytics, **ne persiste rien avant la fin de la pagination** (une semaine tronquée se lirait comme complète, donc comme une chute), écrit les observations **et** les tables legacy depuis un seul fetch, et tient la fraîcheur dans `project_integrations`. Le catalogue hebdo est passé à la **profondeur 3** : `collect` → `detect` → `propose`, arêtes obligatoires. `GscApiError` porte `status`/`reason`, ce qui rend la classification JOB-003 exacte sur les deux cas que Google fait à l'envers (403 `rateLimitExceeded` = quota, 400 `invalid_grant` = auth).
**Inbox (E11/DASH-005 + DASH-004) :** **livrée**. `/inbox` (deux onglets) est le seul endroit où ce que le cockpit détecte et propose devient **décidable** : approbation **liée au hash exact** (le client renvoie le hash affiché, un hash périmé est refusé sans rien écrire), **idempotente** (double clic = 1 seule ligne d'audit), rejet et **`changes_requested`** avec raison obligatoire journalisée au finding, et **lots homogènes** (même projet/action/niveau/risque) reconstruits **depuis la base** par `approve-batch` — les **L4 n'y entrent jamais**. Côté findings : preuves brutes, journal, acknowledge/snooze/dismiss/reopen via les fonctions FIND-003. ⚠️ **Approuver n'exécute rien** : aucun handler d'exécution n'existe.
**Fenêtres (GSC-004) :** **livré**. 7/28/90 j = **1/4/13 semaines complètes** sur le canon d'observations (le grain GSC est la semaine ; une fenêtre au jour près serait une précision que la donnée n'a pas). **Aucun delta entre longueurs incompatibles** — le refus vit dans le module pur, pas dans un template. L'incomplétude **baisse la confiance** (dérivée, jamais stockée). Latence réglable sans redéploiement (`system_settings` → `gsc.latency_days`), et **le collecteur résout la même** — sinon l'écran jugerait « pas à jour » une semaine que la collecte tient pour finale. Backfill **reprenable sans checkpoint** (la reprise est dérivée des observations présentes : un checkpoint stocké peut mentir).
**Accueil (E06/DASH-002) :** **livré**. `/` est le cockpit cross-projet. Santé à **deux axes qui ne fusionnent jamais** — `pipeline` (la donnée arrive-t-elle ?) et `signal` (que dit-elle ?) — et **un pipeline cassé rend le signal `unknown`, jamais `ok`** : sans cette règle, un projet dont la collecte est morte afficherait « 0 nouveau finding » et se lirait comme le plus sain du portefeuille. Chaque compteur porte **le lien de son propre filtre** (le nombre et l'URL naissent du même descripteur) ; sans liste capable de le reproduire, il reste un chiffre. Coûts **« non instrumentés »**, pas zéro. ⚠️ **Jamais vu à l'œil** (pas de session admin).
**Indexation (E04/IDX-001+002) :** **livrés**. `collect:sitemap` parcourt l'arbre XML sous bornes dures (cycle stoppé), persiste 1 ligne par **fichier** — un sitemap injoignable ou malformé devient un **fait interrogeable** (`errors > 0`), plus un `catch {}` — et 1 par **URL** (`sitemap_url_observations`, **seul DDL** : 58 tables). Le diff de deux dates est une **fonction pure**, donc rejouable ; **rien n'est écrit avant que tout l'arbre soit parcouru** (un inventaire tronqué annoncerait des retraits fantômes) ; **aucune URL retirée n'est jamais désindexée**. `collect:url_inspection` remplit les 7 colonnes de `index_observations` + payload borné (SPEC §9.2), **zéro DDL** : une **erreur provider n'écrit rien et ne se lit jamais « non indexé »** (union discriminée), et remonte **structurée** donc les 7 classes JOB-003 sont exactes. Lecture par `indexing-read.ts`, **sans réseau**.
**Transitions (E04/IDX-005) :** **livré**. Rien ne comparait les états d'indexation **dans le temps** : une page passée d'`indexed` à `not indexed` ne produisait aucun finding. **Zéro DDL**. Le détecteur n'est **pas autoritaire** sur son projet — l'inspection ne couvre qu'une sélection d'URLs, donc le champ **`scope`** laisse un finding hors portée **strictement intact** (`consecutive_misses` compris) : « je ne l'ai pas regardée » ne se lit jamais « elle est guérie », et `outOfScope` est un compteur distinct de `held`. `unknown` ne rompt ni ne confirme un streak ; `excluded` n'est pas `not_indexed` ; une fluctuation isolée est **écrite mais plafonnée** (`pending`, confiance 40, jamais notifiable), confirmée à la 2ᵉ observation. `critical` est **réservé** au cas notifiable §14.3, et le drapeau `notifyImmediately` vit dans les preuves (TEL-002 reste BLOCKED).
**Sélection (E04/IDX-004 lot 1) :** **livré**. Personne ne décidait quelles URLs méritent le quota : `index_observations` était à **0 ligne**, donc IDX-005 inerte. `index_selection` (**seul DDL** : 59 tables) est le registre des **décisions** de dépense — jamais du résultat, qui se **dérive** (`observed_date >= due_date`, ce qui porte la sémantique J+N). La sélection est **persistée AVANT que la collecte parte** : un 429 au 3ᵉ appel laisse ses intentions dues, reprises au run suivant **sans une ligne de plus**. « Réserver du quota à l'urgent » est un **ordre** et un **canal** (`scope: 'due'`), pas un pourcentage ; l'échantillon est plafonné par `samplePctMax` **clampé à 60 %**, donc il ne peut jamais prendre le dernier slot. ⚠️ **`0` veut dire ZÉRO** dans `index-selection-state.ts`, l'inverse de `job-limits.ts`. Le pool consommé est une **borne inférieure** (« au plus N », jamais « il reste N »). Le catalogue hebdo est passé à **6 entrées** : `sitemap`/`gsc_query_page` → `url_inspection` (prérequis **optionnels**) → `index_transition` (arête **obligatoire**). ⚠️ **Aucun écran ne lit** `indexing-read.ts` ni `index_selection` (c'est DASH-003).
**Baisses (E05/FIND-005) :** **livré**. Le parc avait **deux détecteurs** pour six écrans : une requête qui perdait 80 % de ses clics ne produisait **rien**. **Zéro DDL**, premier consommateur des fenêtres GSC-004. ⭐ **Seuls les couples présents dans les DEUX fenêtres sont comparés** — un couple disparu est indiscernable d'une semaine non collectée, le compter −100 % fabriquerait un finding depuis un trou (**107** cas réels sur `lecureux`) ; il est compté (`vanished`) et laissé à FIND-006. ⭐ **L'écart 4 sem./1 sem. EST le niveau de confirmation** : `confirmed` (la chute se creuse), `sustained` (palier bas — la fenêtre récente compare w0 à w1, pas à la période d'avant), `emerging` (une seule semaine → écrit mais **plafonné `medium`**, comme IDX-005 plafonne une fluctuation isolée). Une page ne se regroupe que si **son total** baisse, calculé sur tous ses couples appariés. Saisonnalité N-1 **déclarée absente**, jamais neutre. ⚠️ **Au premier run, les 9 projets passent de `ok` à `watch`** (un détecteur neuf n'a jamais tourné ⇒ couverture `partial`) — la règle DASH-002 qui fonctionne, résorbée au premier tick. ⚠️ **`propose:actions` n'en dépend pas** : une baisse se diagnostique avant de se corriger, elle ne produit aucune proposition.
**Rapport hebdo (E07/REP-001) :** **livré**. E07 était à **zéro ligne** alors que quatre tickets P0 l'attendaient (REP-002/003/004, TEL-002, AGT-004) **et** l'onglet Rapports de DASH-003. **Zéro DDL** (60 tables), **zéro persistance** (c'est REP-004), **zéro appel provider**. ⭐ **Il n'existe AUCUN endroit où loger un `0` pour un provider non branché** : `Availability<T>` est une union discriminée, une section absente **n'a pas de corps**, donc pas de case où un zéro pourrait s'écrire — « absent, pas zéro » cesse d'être une convention. Trois absences distinctes (`not_wired` / `never_collected` / `not_examined`) parce qu'elles demandent trois gestes. ⭐ **Le gate d'examen passe AVANT le comptage** : sur un parc jamais diagnostiqué, aucun chemin n'écrit « 0 nouveau finding » (règle DASH-002 portée jusqu'au rapport). ⭐ **`renderWeeklyReportText(report)` n'a d'autre paramètre que le JSON** : « générable sans LLM » devient structurel, le texte ne pouvant rien ajouter. Le compteur d'une section vient d'un `count(*)`, jamais de la longueur du tableau lu. La santé vient de `loadHomeCockpit` et de nulle part ailleurs (égalité prouvée en base). ⚠️ **Ni planifié, ni publié, ni stocké** — il s'appelle à la main (`npx tsx scripts/rep-001-preview.ts`). ⚠️ Aujourd'hui **indexation et trafic sont ABSENTES** (0 observation d'indexation, aucun provider analytics) et c'est **correct**. ⚠️ Une **réouverture** n'apparaît dans aucune section (`ACTIVITY_EVENTS` hérité de DASH-002) — à rattraper par REP-004.
**Publication du rapport (E07/REP-003) :** **livré**. Le rapport savait se construire, rien ne le gardait ni ne le déclenchait — et « accessible après restart » ne se dérive de rien (sur Vercel aucun processus ne survit à la requête). **Un seul DDL** (`weekly_reports`, 61 tables). ⭐ **La publication n'est PAS un job de file** : `jobs.project_id`/`monitoring_runs.project_id` sont NOT NULL alors que le rapport est **cross-projet** (9 jobs auraient écrit le même rapport, 8 sans effet), et les arêtes JOB-004 sont **intra-occurrence**, donc incapables d'exprimer « attendre les steps des 9 projets ». Le tick l'appelle **après** son drain ; l'unique sur le **créneau local** porte « un seul rapport logique par semaine » (prouvé sur deux publications concurrentes). ⭐ **Le contenu est une fonction du CRÉNEAU** (`now = slot`), la ligne date de l'**écriture** — sinon deux publications du même lundi porteraient deux périodes, et REP-004 comparerait des semaines disjointes. ⭐ **Le SLO se dérive** (`published_at <= due_at`, aucune colonne de verdict), échéance réglable sans redéploiement (`system_settings` → `report.publish_deadline_minutes`, défaut 60 min = 10:00 local). ⭐ **`complete` exige un périmètre attendu non vide**, et une **pause** sort le projet du dénominateur en restant nommée (un client gelé ne rend pas `partial` éternel). ⚠️ Un `partial` publié **ne devient jamais** `complete` (republier = no-op, graine de REP-004) · l'**annonce** est produite et journalisée, **pas envoyée** (TEL-001 BLOCKED, l'envoi est TEL-002). La table a un lecteur depuis **DASH-003 lot 2 ch.3** (`/reports`) ; le CLI reste (`npx tsx scripts/rep-003-publish.ts --list|--show|--dry-run`).
**Écran Rapports (E06/DASH-003 lot 2 ch.3) :** **livré**. `/reports` et `/reports/[slot]` — **cross-projet parce que la table l'est** (`weekly_reports` n'a pas de `project_id` ; ses `metrics` sont des `count(*)` de parc, donc un onglet projet mentirait sur leur portée) : l'onglet « Rapports » de SPEC §13.2 est abandonné au profit de §13.1. **Zéro DDL** (61 tables), **zéro nouveau module de lecture** (`report-publication.ts` EST la lecture ; en ajouter une seconde créerait une deuxième autorité sur le SLO). ⭐ **LE point du lot : l'invariant « absent ≠ zéro » n'était pas gardé à l'ÉCRAN.** REP-001 l'a rendu structurel côté données, mais un template le défait en un caractère (`body.data?.items.length ?? 0`) : `sectionView` rend une **union discriminée**, donc une section absente n'a **ni `items`, ni `metrics`, ni `truncated`** — prouvé sur un rapport réel (`indexation`/`traffic_conversions` en `not_wired`), avec pour contre-épreuve **4 sections présentes et vides** qui portent bien leurs champs. ⭐ **Rien n'est reconstruit** : la vue est le `payload_json` relu hors du code de lecture, sections **dans l'ordre du JSON archivé**, et deux lectures rendent la même vue au bit près. ⚠️ **`period_slot` (local) et `slot_at` (instant) ne sont pas interchangeables** — confondre les deux décale l'âge d'1 à 2 h selon la saison, ou affiche 07:00 pour le lundi 09:00. ⚠️ **« Mots-clés » (§13.2) est reclassé** : il existe déjà sous le nom « Positions », sur les tables **legacy** — le geste restant est un **portage sur le canon**, pas un nouvel onglet. ⚠️ **Le premier rapport visible sera un constat d'absence** (`partial`, 9 projets `missing`) — révisable depuis REP-004.
**Révision et comparaison (E07/REP-004 lot 1) :** **livré**. Un rapport publié cesse d'être un cul-de-sac. **Un seul DDL, aucune table** (61) : trois colonnes (`revision`, `revision_reason`, `supersedes_id`), l'unique déplacé de `(period_slot)` vers `(period_slot, revision)`, un CHECK. ⭐ **« Ne remplace pas silencieusement » cesse d'être une abstention et devient une FORME** : jusqu'ici l'acceptation était tenue en ne faisant rien (republier = no-op), donc le seul moyen de ne pas écraser l'original était de ne jamais corriger le rapport. Réviser **insère** ; « un seul rapport par semaine » se déplace dans le code — **le chemin automatique (le tick) n'écrit jamais que `revision = 1`**, donc un cron qui repasse cent fois produit toujours une ligne, et une révision ≥ 2 exige un geste délibéré **et une raison** (CHECK en base + refus du modèle pur avant même de reconstruire le rapport). L'original garde id, statut, heure et payload **octet pour octet**. ⭐ **Une disponibilité qui change n'est PAS un écart** — 3ᵉ endroit où « absent ≠ zéro » se défait, et le seul où il produit un **mouvement inventé** : une section branchée cette semaine annoncerait `+13`, un provider tombé `−13` (donc « treize problèmes résolus »). `became_available`/`became_absent` **ne portent aucun champ chiffré**. Même refus pour les sections d'**activité** (un finding qui sort n'est pas résolu, il a cessé d'être *nouveau*), les listes **plafonnées** (le plafond fabriquerait les mouvements, jumeau de FIND-005) et les **schémas/fenêtres** différents (doctrine GSC-004 : valeurs lisibles, écart refusé). ⭐ **La comparaison n'apparie jamais sur de la prose** : `ReportMetric.key` (schéma de rapport **1 → 2**) — le libellé de la métrique L4 porte « parmi les 12 listées », un nombre qui change chaque semaine. ⚠️ **Le SLO d'un créneau se dérive de sa PREMIÈRE publication** (`firstPublishedAt`) : réviser ne réécrit pas la ponctualité du cron. ✅ **Lot 2 (2026-07-27) — REP-004 est CLOS.**
**Rétention du détail (E07/REP-004 lot 2) :** **livré**, et REP-004 est **clos** (3 acceptations sur 3). Un rapport pèse ~28 kio quand §7.11 range les rapports en « sans limite, protégés » : les deux tiennent dès qu'on cesse de confondre le **rapport** et son **détail**. **Un seul DDL, aucune table** (61). ⭐ **Rendre `payload_json` nullable CRÉE un état, et c'est le CHECK qui le rend sûr** : « ligne sans détail » se lit naïvement « rapport vide » — douze sections non branchées pour un rapport qui en portait dix. `weekly_reports_payload_presence_check` interdit sa version **muette** (pas de payload ⇒ **adresse**, **date de purge** et **empreinte** obligatoires) ; trois `UPDATE` nus, ceux qu'on taperait dans psql, sont refusés en base. ⭐ **On purge le DÉTAIL, jamais la LIGNE** — le SLO, la préparation et le lignage survivent, ce dont deux décisions du lot 1 dépendaient déjà sans le dire (`supersedes_id` sans FK, numéro de révision dérivé du `max`). ⭐ **« Archivé » est une condition VÉRIFIÉE, pas une intention** : un rapport ne se régénère pas (il a été construit sur le parc de son créneau), donc `not_archived` retient **quel que soit l'âge**, et la marque n'est posée qu'après avoir retrouvé la note du vault et **comparé son SHA-256** — un caractère modifié dans le détail embarqué fait refuser la confirmation, donc interdit la purge. ⭐ **Un détail purgé n'est pas un rapport vide** : `buildReportView` n'accepte plus qu'un rapport présent, et `compareReports` rend `detail_purged` (sinon la comparaison annoncerait douze sections « hors plan », soit un changement de **template** inventé par une rétention). ⚠️ **Désactivée par défaut** (`system_settings` → `report.detail_retention_weeks` = `null`, plancher 4 semaines) : le défaut, comme le pire cas d'une valeur illisible, doit être celui qui ne détruit rien. ⚠️ La séquence a **quatre** étapes et l'ordre est la garantie : `--export` → `/seo-archive --projet _global` → `--confirm` → `--purge`.
**Nouvelles et perdues (E05/FIND-006) :** **livré**. FIND-005 comptait les disparitions (`vanished`) sans pouvoir les traiter ; le portefeuille de requêtes a maintenant ses **entrées et ses sorties** (`new_query` + `lost_query`). **Zéro DDL** (61 tables), **UN job pour DEUX types** (`detect:query_turnover`) parce que chacun est la garde de l'autre, donc **deux closures**. Le catalogue hebdo passe à **7 entrées**. ⭐ **Le regroupement de variantes empêche deux faux signaux SYMÉTRIQUES** : sans lui, « genève coiffeur » serait une découverte le jour où « coiffeur genève » devient une perte — **581 évités sur le seul `barberconcept`** (414 + 167). Un groupe n'est `new` que si **TOUS** ses membres sont neufs, `lost` que si **TOUS** ont disparu. Normalisation volontairement **pauvre** (accents, casse, ponctuation, ordre des mots — ni stemming ni synonymie : une fusion abusive *fabrique* un signal). Elle ne s'affiche **jamais** : titre = terme brut dominant, preuves = chaque terme avec sa durée de vie, clé publiée et **rejouable**. ⭐ **« Nouvelle » se juge sur TOUT l'historique** (agrégat `firstSeen`/`lastSeen` par requête), jamais sur la fenêtre précédente — sinon un **retour** après six mois se lirait comme une découverte (**264** sur `barberconcept`). Le même agrégat porte la première/dernière apparition exigée par l'acceptation. ⭐ **La portée (`scope`) n'existe que du côté des pertes** : leur fenêtre de référence **glisse** d'une semaine à chaque run, donc plus rien ne mesure ce que la requête pesait — alors qu'elle est toujours absente. Le finding devenu immesurable reste **strictement intact** (`consecutive_misses` compris) ; seul un **retour effectif** le fait résoudre. ⭐ **Une perte dont la page n'est plus indexable appartient à `index_drop`** (SPEC §10.4) — mais seul un `not_indexed` **explicite** supprime : `unknown` (tout le parc) baisse la confiance et change le skill (`seo-index-diagnose` → `seo-refresh`). ⚠️ **`LOST = 0` sur les 9 projets aujourd'hui** : 937 disparitions comptées et écartées sur `barberconcept`, 82 sur `lecureux` — le parc ne perd que de la longue traîne. ⚠️ **Une découverte non traitée s'auto-résout** au bout de 4 semaines (la nouveauté est périssable). ⚠️ **Premier tick : `barberconcept` écrit 50 `new_query` de plus** (221 franchissent le gate, plafond 50) → jusqu'à **150 findings** pour un projet frais. ⚠️ **`propose:actions` n'en dépend pas**.
**Prochaine étape :** le **portage de `/positions` sur le canon** (ex-onglet « Mots-clés », débloque FIND-007) ou **AGT-001** (API agent v1 — approuver n'exécute toujours rien). **FIND-007** reste `BLOCKED` sur GSC-005. Détail : `docs/HANDOFF.md`.
**File de jobs (E00) :** réclamation atomique, bail + reaper, erreurs classées, console `/jobs`, scheduler horaire, producteur de propositions, **dépendances entre jobs** (JOB-004 : un prérequis obligatoire mort fait passer son dépendant en **`skipped`** et le run en `partial` ; un optionnel mort ne bloque personne) — et depuis **JOB-006** la **capacité** : plafonds global / projet / provider, **tour d'équité** (un gros projet ne prend plus tout un tick), et **refroidissement provider** (un échec `quota` met toute la cohorte au repos, `attempts`/`deferrals` intacts). Les plafonds se règlent **sans redéploiement** (`system_settings` + `scripts/limits.ts`) ; la garde vit **dans `claimJob`**.

> ⚠️ **Au merge de `feat/cockpit` dans `main`** (pas au cutover, qui a déployé le socle *sans* le cockpit) : le cron `/api/cron/tick` (JOB-005) planifiera le run hebdo des **9 projets** (le parc a grandi) — dont **barberconcept**, jamais détecté, qui écrira **50 findings d'un coup** (plafond `maxCandidates`). Depuis FIND-006 le catalogue hebdo porte **4 détecteurs** (7 entrées), donc le plafond s'applique **par détecteur** : le premier tick peut écrire jusqu'à 50 opportunités **+** 50 baisses **+** 50 nouveautés par projet — et **63 jobs hebdo** pour `MAX_JOBS_PER_TICK = 25`. **Et depuis REP-003, ce même premier tick publiera le rapport de la semaine en `partial`, avec les 9 projets `missing`** (le créneau et son échéance sont déjà passés, aucun run hebdo n'a jamais tourné) : le premier rapport publié sera un constat d'absence, et il ne sera pas réécrit ensuite. Décision de Jonathan : laisser partir, ou suspendre. Depuis DASH-006 lot 2, le bon levier est une **pause `automation_pauses`** (portée `project_cadence`, journal append-only, reprise auditable) — **pas** `project_projections.payload.schedules`, qui est une projection **recompilée** où la suspension serait effacée sans bruit. Depuis JOB-004, son `propose:actions` **attend** la fin de cette détection au lieu de partir en parallèle ; depuis JOB-006, il ne peut plus prendre le tick entier (tour d'équité).

## Carte des skills — domaine SEO (partition `noyau/seo-stats`)

> **Curation, pas contrôle d'accès.** Tous ces skills sont déjà disponibles partout ; cette carte dit
> lesquels sont **canoniques** dans le domaine SEO, dans **quel ordre**, et lesquels touchent ce hub.
> La `SKILL.md` de chaque skill fait foi sur le *comment* (source de vérité unique) — ici : nom + rôle + ordre.

### 1. Pilotage & analyse — le cœur de `seo-stats` (lisent GSC / ce hub)

Ce sont les skills « natifs » de la partition : ils **piochent** les données du hub Neon / GSC et
**persistent** leurs rapports (`seo_reports`). Loi noyau n°4 : on requête l'app, on ne recopie jamais un chiffre en markdown.

| Skill | Rôle | I/O hub |
|---|---|---|
| `/seo-weekly` | Snapshot GSC hebdo + plan d'action priorisé | lit GSC+hub · écrit snapshots |
| `/seo-actions` | Top opportunités + quick wins de la semaine | lit hub |
| `/seo-gsc` | Analyse GSC brute (queries/CTR/position) | lit GSC |
| `/seo-cannibalisation` | Conflits multi-URL mesurés (GSC) | écrit `seo_reports` |
| `/seo-index-diagnose` | Coverage d'indexation (URL Inspection API) | lit GSC |
| `/seo-backlinks` | Profil de liens (DataForSEO / browser) | écrit `seo_reports` |
| `/seo-competitors` | Keyword gap chiffré vs concurrents | écrit `seo_reports` |
| `/seo-ai-visibility` | Score GEO / citations IA | écrit `seo_reports` |
| `/seo-archive` | Pousse les JSON SEO → `cerveau/` (Obsidian) | sort vers cerveau |

### 2. Recherche & cadrage — amont (produit un brief, tourne en contexte projet)

**Ordre :** `/seo-topical-map` → `/seo-keywords` → `/seo-serp` → `/seo-competitors` → `/seo-entities` → `/seo-gsc` → **`/seo-brief`**

Le brief final se dépose dans `cerveau/10-Projets/{slug}/briefs/`, pas ici.

### 3. Production & publication — le brief devient un article publié

**Ordre :** `/seo-write` → `/humanizer` → `/seo-sources` → `/seo-enrich` → `/seo-review` → **`/publish-hub`** *(→ arrive dans ce hub, tables `contents`)*

Compléments : `/programmatic-seo` (pages à l'échelle) · `/seo-audit` (audit technique) · `/seo-refresh` (rafraîchir un existant).

**Agents (sous-agents autonomes du domaine)** — pour produire sans piloter skill par skill :

| Agent | Rôle | Remplace |
|---|---|---|
| `@content-creator` | Orchestrateur : demande haut-niveau → recherche + briefs + production + mesure, de bout en bout | le pilotage humain du pipeline |
| `@article-producer` | Worker : 1 slug → 1 article complet (write→humanizer→sources→enrich→review→cover→publish) | l'exécution manuelle §3 |
| `@brief-critic` | Relecteur adversarial d'un brief (`/seo-brief`), verdict PASS/FAIL | le checkpoint humain de validation de brief |

`@content-creator` spawn les deux autres en boucle (brief-critic valide, article-producer produit en parallèle). Les agents `@epic-*` / `@plan-critic` sont **dev**, hors domaine SEO.

### 4. Présence locale (GMB) — l'autre pilier du cockpit

**Ordre :** `/gmb-generate` → `/gmb-generate-images` → **`/publish-hub`** *(GMB auto-approve, cron 9h)*
Avis : `/gmb-review-responder` · Déclinaison sociale d'un article : `/linkedin-weekly-posts`.

### 5. Les ponts avec les autres partitions

- **Écrit ici** : `/publish-hub` (contenu produit → `contents`/GMB). Orchestré par `/content-pipeline` (publish + linkedin + gmb).
- **Lit ici** : tous les skills du bloc 1 (KPI/GSC) — jamais de copie markdown (loi n°4).
- **Monte au cerveau** : `/seo-archive` (snapshots → `cerveau/20-Knowledge/`), puis distillation wiki **consciente** (`/brain-sync` / INGEST), jamais auto (loi n°5).

## Fin d'epic
Quand le dernier commit d'un epic est fait, propose a Jonathan de lancer `/epic-recap` pour generer le rapport dans Obsidian. Ne le lance pas automatiquement — demande d'abord.
