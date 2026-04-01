# Epic 2 : API REST

**Statut :** DONE
**Complexite :** M

## Description

API REST pour recevoir du contenu depuis Claude Code, gerer les projets et les commentaires. Auth par API key (Bearer token).

## Taches

- [x] Helper auth (`api-auth.ts`) : validateApiKey, validateClientToken, jsonResponse, errorResponse
- [x] POST/GET `/api/content` — creer et lister les contenus
- [x] GET/PUT/DELETE `/api/content/[id]` — detail, modifier, supprimer
- [x] PATCH `/api/content/[id]/status` — changer le statut + historique
- [x] POST/GET `/api/projects` — creer et lister les projets
- [x] PUT `/api/projects/[slug]` — modifier un projet
- [x] POST `/api/projects/[slug]/token` — regenerer le token client
- [x] POST `/api/comments` — ajouter un commentaire (auth client token)
- [x] DELETE `/api/comments/[id]` — supprimer un commentaire (auth admin)

## Endpoints

| Method | Route | Auth |
|--------|-------|------|
| POST | `/api/content` | API key |
| GET | `/api/content` | API key |
| GET | `/api/content/[id]` | API key |
| PUT | `/api/content/[id]` | API key |
| DELETE | `/api/content/[id]` | API key |
| PATCH | `/api/content/[id]/status` | API key |
| POST | `/api/projects` | API key |
| GET | `/api/projects` | API key |
| PUT | `/api/projects/[slug]` | API key |
| POST | `/api/projects/[slug]/token` | API key |
| POST | `/api/comments` | Client token |
| DELETE | `/api/comments/[id]` | API key |

## Edge cases geres

- Projet inexistant → 404
- Type invalide → 400
- Slug duplique → 409 (avec option `?upsert=true`)
- GitHub sync en echec → contenu sauve en DB, `github_synced: false`
- Passage a `published` sans `planned_date` → date du jour auto
