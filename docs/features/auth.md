# Epic 3 : Auth admin (Better Auth)

**Statut :** EN COURS
**Complexite :** S

## Description

Authentification admin via Better Auth (email/password). Jonathan est le seul admin. Config Better Auth posee, reste le UI login et la protection des routes admin.

## Taches

- [x] Config Better Auth (`src/lib/server/auth.ts`)
- [x] Route catch-all (`src/routes/api/auth/[...all]/+server.ts`)
- [ ] Page login (`src/routes/(auth)/login/+page.svelte`)
- [ ] Layout auth (`src/routes/(auth)/+layout.svelte`)
- [ ] Layout admin protege (`src/routes/(app)/+layout.server.ts`) — redirect si pas connecte
- [ ] Creer le compte admin Jonathan dans le seed ou au premier lancement

## Decisions

- Email/password pour le MVP, magic link en V2
- Session cookie classique (Better Auth default)
- Un seul admin (pas de multi-utilisateurs MVP)
