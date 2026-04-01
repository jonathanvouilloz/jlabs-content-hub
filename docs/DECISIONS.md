# Decisions techniques

| Date | Decision | Contexte | Alternatives considerees |
|------|----------|----------|--------------------------|
| 2026-03-31 | SvelteKit + Svelte 5 (runes) | Stack habituel Jon Labs, SSR + API routes natifs | Next.js (trop lourd), Astro (pas assez dynamique) |
| 2026-03-31 | Turso (libSQL) + Drizzle ORM | Leger, edge-compatible, gratuit pour ce volume, deja maitrise | Supabase (overkill), PlanetScale (plus cher) |
| 2026-03-31 | Better Auth | Deja utilise sur d'autres projets Jon Labs, magic link + email/password | Auth.js (instable), Lucia (deprecated) |
| 2026-03-31 | Skeleton UI + Tailwind | Composants Svelte natifs, theme customisable, support dark mode | shadcn-svelte (moins mature), DaisyUI (moins flexible) |
| 2026-03-31 | GitHub = backup, DB = source de verite | Le repo GitHub existant contenait deja du contenu, mais le systeme de fichiers ne scale pas | GitHub comme source de verite (fragile avec >3 projets) |
| 2026-03-31 | Structure GitHub : {projet}/{type}/{YYYY}/{MM}/ | Avec 8-12 articles + posts par mois par projet, la separation par mois garde les dossiers navigables | Flat par type (trop de fichiers), par statut draft/published (supprime) |
| 2026-03-31 | 3 mecanismes auth : API key, client token, session admin | Chaque use case a besoin d'un niveau de securite different | Token unique pour tout (pas assez granulaire) |
| 2026-03-31 | createId() avec crypto.randomBytes | Simple, pas de dependance externe, suffisant pour le volume | cuid2 (dependance inutile), uuid (trop long) |
| 2026-03-31 | Skeleton UI v4 (pas v2) | v4.13 est la version actuelle compatible Svelte 5 | v2 (deprecated, pas Svelte 5) |
| 2026-03-31 | Layout custom (pas AppShell) | Skeleton UI v4 n'a plus AppShell/AppRail, layout custom avec Tailwind | Chercher un autre design system (inutile, Tailwind suffit) |
| 2026-03-31 | Better Auth auto-detection env vars | BETTER_AUTH_SECRET et BETTER_AUTH_URL detectes automatiquement | Passer manuellement via config (redondant) |
| 2026-03-31 | Endpoint /api/setup one-shot | Creer le premier admin sans seed script, bloque si user existe deja | Script CLI (plus complexe a executer en prod) |
| 2026-03-31 | Tailwind v4 Vite plugin (pas PostCSS) | Plus simple, pas besoin de postcss.config.js ni tailwind.config.js | PostCSS plugin (plus de config) |
