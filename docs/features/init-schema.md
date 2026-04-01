# Epic 1 : Init projet + Schema DB

**Statut :** DONE
**Complexite :** S

## Description

Initialisation du projet SvelteKit avec le schema Drizzle pour Turso. 5 tables definies selon le data model du PRD section 4.

## Taches

- [x] Init SvelteKit (Svelte 5, TypeScript, runes)
- [x] Installer dependances (Drizzle, libSQL client, Better Auth, Octokit, marked, gray-matter)
- [x] Definir schema Drizzle (`src/lib/server/db/schema.ts`)
- [x] Client Turso (`src/lib/server/db/index.ts`)
- [x] Seed content_types (`src/lib/server/db/seed.ts`)
- [x] Config Drizzle Kit (`drizzle.config.ts`)
- [x] `.env.example` avec toutes les variables
- [x] `.gitignore` pour SvelteKit
- [x] Restructurer contenu existant de `drafts/` vers `YYYY/MM/`
- [x] Supprimer dashboard React et fichiers obsoletes

## Tables

| Table | Colonnes cles |
|-------|---------------|
| projects | id, name, slug, color, access_token, archived |
| contents | id, project_id, type, title, slug, body, status, planned_date, tags, meta, github_synced |
| comments | id, content_id, author_name, author_email, body |
| content_types | id, slug, label, icon |
| status_history | id, content_id, from_status, to_status, changed_by |
