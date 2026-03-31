# Epic 3 : Auth admin (Better Auth)

**Statut :** DONE
**Complexite :** S

## Description

Authentification admin via Better Auth (email/password). Jonathan est le seul admin.

## Taches

- [x] Config Better Auth (`src/lib/server/auth.ts`)
- [x] Route catch-all (`src/routes/api/auth/[...all]/+server.ts`)
- [x] Tables auth dans schema Drizzle (user, session, account, verification)
- [x] hooks.server.ts (session management + svelteKitHandler)
- [x] Auth client (`src/lib/auth-client.ts`)
- [x] Page login (`src/routes/(auth)/login/+page.svelte`)
- [x] Layout auth centre (`src/routes/(auth)/+layout.svelte`)
- [x] Layout admin protege (`src/routes/(app)/+layout.server.ts`) — redirect si pas connecte
- [x] Endpoint `/api/setup` pour creer le premier admin + seed content_types
- [x] app.d.ts avec types Locals (user, session)

## Decisions

- Email/password pour le MVP, magic link en V2
- Session cookie classique (Better Auth default)
- Un seul admin (pas de multi-utilisateurs MVP)
- Endpoint /api/setup one-shot pour creer le premier admin (bloque si user existe deja)
