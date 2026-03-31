# JLabs Content Hub

Hub editorial centralise pour gerer les articles de blog, posts LinkedIn et posts Google My Business de tous les projets clients Jon Labs.

## Stack

- **Framework** : SvelteKit (Svelte 5)
- **Database** : Turso (libSQL) + Drizzle ORM
- **Auth** : Better Auth
- **GitHub sync** : Octokit (backup)
- **Hosting** : Vercel

## Setup

```bash
# 1. Installer les dependances
npm install

# 2. Copier les variables d'environnement
cp .env.example .env
# Remplir les valeurs dans .env

# 3. Sync le schema DB
npm run db:push

# 4. Lancer le dev server
npm run dev
```

## API

L'API recoit du contenu depuis Claude Code via `POST /api/content` (auth par API key).

Voir `PRD.md` pour la documentation complete des endpoints.

## Structure du contenu (GitHub backup)

```
{projet}/{type}/{YYYY}/{MM}/{filename}
```
