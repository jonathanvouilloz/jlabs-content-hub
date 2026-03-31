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
