# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this project

Hub editorial centralise (web app SvelteKit) pour stocker, gerer et visualiser les articles markdown, posts LinkedIn et posts GMB produits via Claude Code pour differents projets clients. Source de verite unique = base de donnees Turso. (La sync GitHub a été retirée le 2026-05 — le repo `content/` reste comme archive figée mais n'est plus alimenté.)

## Stack technique

| Couche | Choix |
|--------|-------|
| Framework | SvelteKit (Svelte 5, runes) |
| Database | Turso (libSQL) |
| ORM | Drizzle |
| Auth | Better Auth (email/password) |
| Hosting | Vercel |

## Architecture

```
src/
├── lib/
│   ├── server/
│   │   ├── db/
│   │   │   ├── index.ts     # Client Turso
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
- `contents` : id, project_id (FK), type, title, slug, body, status, planned_date, published_at, tags, meta — unique (project_id, type, slug). **Pas de sync GitHub** : Turso est l'unique source de vérité depuis 2026-05.
- `comments` : id, content_id (FK), author_name, author_email, body
- `content_types` : id, slug (unique), label, icon — seed: article, linkedin, gmb
- `status_history` : id, content_id (FK), from_status, to_status, changed_by, changed_at
- `publish_logs` : id, content_id (FK), project_id (FK), channel, location_id, location_label, success, gmb_post_id, error_message, attempted_at, duration_ms, source — 1 row par tentative de publication par location (cron ou manual). Lu par /projects/[slug]/gmb-logs et le digest quotidien.
- `gmb_location_profiles` : snapshot complet d'une fiche GMB par (project_id, gmb_location_id). Colonnes scalaires (title, phone, websiteUri, primaryCategory, openStatus, latlng) + JSON blobs (storefrontAddress, regularHours, specialHours, serviceItems, additionalCategories, attributes) + raw_payload pour debug. Sync lazy (>1h) ou via bouton "Resynchroniser".
- `gmb_insights_daily` : metrique journaliere Performance API. 1 row par (gmb_location_id, date, metric). Metrics : BUSINESS_IMPRESSIONS_{DESKTOP,MOBILE}_{MAPS,SEARCH}, WEBSITE_CLICKS, CALL_CLICKS, BUSINESS_DIRECTION_REQUESTS. Agreges en 30j / mois / annee sur la page Fiche Google > Stats.
- `gmb_profile_edits` : audit log des editions de fiche depuis le hub (section=basic|hours, update_mask, payload, success, error_message).

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
npm run db:push      # sync schema vers Turso
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
- `/api/cron/gmb-publish` — quotidien 9h00 — publie les posts GMB dus + envoie le digest admin (idempotent via `gmb_settings.last_daily_digest_date`)
- `/api/cron/gmb-weekly-digest` — lundi 8h00 — récap hebdo aux clients opt-in (`projects.weekly_digest_enabled = true` + `client_email` renseigné)
- `/api/cron/linkedin-publish` — quotidien 9h00

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

- `docs/PRD-jokiseo.md` — **PRD actuel (v3, source de verite du scope jokiSEO)**
- `docs/PRD.md` — PRD historique v1.1 ("Content Hub", phases 1-2) — archive
- `docs/PLAN.md` — Plan d'execution avec statuts par epic (Phase 3 = jokiSEO)
- `docs/DECISIONS.md` — Log des decisions techniques
- `docs/STYLEGUIDE.md` — Conventions de code et design
- `docs/features/*.md` — Detail par feature/epic

## Etat actuel

**Date :** 2026-06-24
**Produit :** **jokiSEO** — cockpit SEO & presence locale (pivot du 2026-06-24, voir `docs/PRD-jokiseo.md`). Ex "Content Hub".
**Phase :** Phase 3 — refactor jokiSEO. Epics 1-22 DONE, epic 23 (positions GSC) livre et absorbe dans l'epic 27.
**Direction :** recentrage SEO + presence locale (GMB). Retrait de la surface UI Articles/LinkedIn (les tables restent, on filtre `type`). Refactor in-place (pas de rewrite), Turso conserve (pas de Neon), DataForSEO comme fournisseur SEO externe.
**DB :** Turso `hublab-jonathanvouilloz.aws-eu-west-1.turso.io` — ~25 tables, ~6 projets GSC backfilles.
**Admin :** contact@jonlabs.ch
**Prochaine etape :** epic 24 (Focus & IA : nav 2 piliers + cockpit) → epic 25 (providers DataForSEO + runner de jobs) → epics 26 (avis full-auto) & 27 (rang SERP reel).

## Carte des skills — domaine SEO (partition `noyau/seo-stats`)

> **Curation, pas contrôle d'accès.** Tous ces skills sont déjà disponibles partout ; cette carte dit
> lesquels sont **canoniques** dans le domaine SEO, dans **quel ordre**, et lesquels touchent ce hub.
> La `SKILL.md` de chaque skill fait foi sur le *comment* (source de vérité unique) — ici : nom + rôle + ordre.

### 1. Pilotage & analyse — le cœur de `seo-stats` (lisent GSC / ce hub)

Ce sont les skills « natifs » de la partition : ils **piochent** les données du hub Turso / GSC et
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

### 4. Présence locale (GMB) — l'autre pilier du cockpit jokiSEO

**Ordre :** `/gmb-generate` → `/gmb-generate-images` → **`/publish-hub`** *(GMB auto-approve, cron 9h)*
Avis : `/gmb-review-responder` · Déclinaison sociale d'un article : `/linkedin-weekly-posts`.

### 5. Les ponts avec les autres partitions

- **Écrit ici** : `/publish-hub` (contenu produit → `contents`/GMB). Orchestré par `/content-pipeline` (publish + linkedin + gmb).
- **Lit ici** : tous les skills du bloc 1 (KPI/GSC) — jamais de copie markdown (loi n°4).
- **Monte au cerveau** : `/seo-archive` (snapshots → `cerveau/20-Knowledge/`), puis distillation wiki **consciente** (`/brain-sync` / INGEST), jamais auto (loi n°5).

## Fin d'epic
Quand le dernier commit d'un epic est fait, propose a Jonathan de lancer `/epic-recap` pour generer le rapport dans Obsidian. Ne le lance pas automatiquement — demande d'abord.
