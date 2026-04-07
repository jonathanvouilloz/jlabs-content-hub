# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this project

Hub editorial centralise (web app SvelteKit) pour stocker, gerer et visualiser les articles markdown, posts LinkedIn et posts GMB produits via Claude Code pour differents projets clients. Source de verite = base de donnees Turso. GitHub = backup/mirror.

## Stack technique

| Couche | Choix |
|--------|-------|
| Framework | SvelteKit (Svelte 5, runes) |
| Database | Turso (libSQL) |
| ORM | Drizzle |
| Auth | Better Auth (email/password) |
| Hosting | Vercel |
| GitHub sync | Octokit (REST API) |

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
│   │   ├── github.ts        # Service GitHub sync (Octokit)
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

## Contenu sur GitHub (backup)

```
content/{projet}/{type}/{YYYY}/{MM}/{filename}
```

Exemples :
- `content/barberconcept/articles/2026/03/entretien-barbe-courte.md`
- `content/barberconcept/gmb/2026/04/2026-04-gmb.json`
- `content/physiopommier/articles/2026/03/pilates-mal-de-dos.md`

## Schema DB (10+ tables)

Tables auth (Better Auth) :
- `user` : id, name, email, emailVerified, image
- `session` : id, expiresAt, token, ipAddress, userAgent, userId (FK)
- `account` : id, accountId, providerId, userId (FK), password
- `verification` : id, identifier, value, expiresAt

Tables application :

- `projects` : id, name, slug (unique), color, access_token, archived
- `contents` : id, project_id (FK), type, title, slug, body, status, planned_date, published_at, tags, meta, github_synced, github_path — unique (project_id, type, slug)
- `comments` : id, content_id (FK), author_name, author_email, body
- `content_types` : id, slug (unique), label, icon — seed: article, linkedin, gmb
- `status_history` : id, content_id (FK), from_status, to_status, changed_by, changed_at

Statuts : draft → review → approved → published

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

## Config GitHub

```
GITHUB_OWNER=jonathanvouilloz
GITHUB_REPO=jlabs-content-hub
```

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

**Date :** 2026-04-01
**Phase :** MVP complet — tous les epics termines
**Epics DONE (9/9) :** Init + Schema DB, API REST, GitHub sync, Auth admin, Dashboard admin, Calendrier editorial, Acces client + commentaires, Deploiement Vercel, Migration contenu
**DB :** Turso `hublab-jonathanvouilloz.aws-eu-west-1.turso.io` — 9 tables, 28 contenus, 2 projets
**Admin :** contact@jonlabs.ch (compte cree)
**Prochaine etape :** Ameliorations V2 (responsive mobile, pagination, hash tokens)

## Skills relies

Ce repo est consomme par plusieurs skills Claude Code :
- `/publish-hub` — pousse du contenu vers le hub via POST /api/content
- `/content-pipeline` — orchestre publish + linkedin + gmb en sequence
- `/linkedin-weekly-posts` — genere 3 posts LinkedIn par article
- `/gmb-generate` — genere un calendrier GMB

## Fin d'epic
Quand le dernier commit d'un epic est fait, propose a Jonathan de lancer `/epic-recap` pour generer le rapport dans Obsidian. Ne le lance pas automatiquement — demande d'abord.
