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

- `docs/PRD.md` — Product Requirements Document (source de verite pour le scope)
- `docs/PLAN.md` — Plan d'execution avec statuts par epic
- `docs/DECISIONS.md` — Log des decisions techniques
- `docs/STYLEGUIDE.md` — Conventions de code et design
- `docs/features/*.md` — Detail par feature/epic

## Etat actuel

**Date :** 2026-05-11
**Phase :** V2 en cours — base contenu remise a zero pour repartir propre
**Epics DONE (22) :** MVP (1-9) + V2 (10-22)
**DB :** Turso `hublab-jonathanvouilloz.aws-eu-west-1.turso.io` — 18 tables (3 ajoutees en epic 22 : gmb_location_profiles, gmb_insights_daily, gmb_profile_edits), 0 contenu (post-cleanup), 4 projets
**Admin :** contact@jonlabs.ch
**Prochaine etape :** Ameliorations V2+ (responsive mobile, pagination, hash tokens, analytics) + epic 23 (GMB fiche : categories + services + photos)

## Skills relies

Ce repo est consomme par plusieurs skills Claude Code :
- `/publish-hub` — pousse du contenu vers le hub via POST /api/content
- `/content-pipeline` — orchestre publish + linkedin + gmb en sequence
- `/linkedin-weekly-posts` — genere 3 posts LinkedIn par article
- `/gmb-generate` — genere un calendrier GMB

## Fin d'epic
Quand le dernier commit d'un epic est fait, propose a Jonathan de lancer `/epic-recap` pour generer le rapport dans Obsidian. Ne le lance pas automatiquement — demande d'abord.
