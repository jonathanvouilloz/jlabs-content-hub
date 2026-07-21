# Feature — E00 Fondations (reconstruction agentique)

> Premier lot exécutable du BACKLOG (§9) pour la reconstruction cockpit agentique.
> SPEC source : `docs/SPEC.md` v0.2 · Backlog : `docs/BACKLOG.md` E00.
> Branche : `feat/cockpit` (depuis `feat/neon`).

## Etat session 2026-07-21

**Fait (bloc « fondations in-repo ») :**
- **OPS-001** — logger structuré `src/lib/server/log.ts` : JSON-lines en prod, texte lisible en dev,
  niveaux (`LOG_LEVEL`), masquage des champs secrets (`redactFields`). Sans dépendance.
- **GOV-003** — config runtime centralisée `src/lib/server/config.ts` : schéma déclaratif des 21
  variables réellement consommées (rôle / exigence boot|feature|optional / secret), `validateStartup()`
  (log-only, non bloquant) câblé au boot via `hooks.server.ts`, helper `requireEnv(name, feature)`
  pour le fail-fast au point d'usage. `.env.example` nettoyé (bloc GitHub mort retiré, doc flags+LOG_LEVEL).
- **GOV-005** — feature flags `src/lib/server/flags.ts` : 7 flags (jobs_v2, findings, indexnow, plausible,
  gmb_auto_send, telegram, agent_runner), tous OFF par défaut, override global `FLAG_<NOM>` + override
  par projet (API prête pour DATA-002), `describeFlags()` pour journaliser les flags effectifs par run.
- **GOV-001 (partiel, interne)** — `package.json` name `jlabs-content-hub → seo-stats` ; User-Agent sitemap
  idem. Renommage limité à l'interne, cf. piège ci-dessous.

**Baseline (GOV-002) établie :**
- `npm run check` = **0 erreur, 42 warnings** (tous dans `(app)/` gelé + report/view = dette legacy).
- `npm run build` = **échoue en LOCAL** (`EPERM symlink` de `adapter-vercel`, Windows sans Developer Mode).
  Pas une régression de code : vert sur les builders Linux de Vercel. À contourner localement (Developer
  Mode) ou traiter au chantier portabilité VPS (E13/GOV-004).
- Aucun test unit/integration (pas de script `test`) — à instaurer (SPEC §19).

**Audit (GOV-004) :** `src/` propre de Turso/libsql (1 commentaire résiduel) ; `@libsql/client` absent des deps.

## Pièges actifs
- ⚠️ **3 chaînes `jlabs-content-hub` visibles client NON renommées** (décision de marque en attente) :
  `src/routes/positions/[slug]/+page.svelte:101` (vue publique), `src/lib/server/email-templates.ts:54,107`
  (footers email). Cible = `seo-stats` (interne) ou `jonlabs` (marque) ? → à trancher avec Jon.
- ⚠️ Build local KO sur Windows (symlink adapter-vercel) — vérifier via `check`, pas `build`, en local.

## Reste du premier lot §9 (non fait)
- [ ] **GOV-001 (reste)** — marquer `Desktop/apps/jlabs-content-hub` legacy read-only (garder comme backup
      jusqu'au cutover), avertissement dans sa doc.
- [ ] **DATA-001** — cartographier + figer le schéma existant (29 tables), stratégie expand/migrate/contract,
      fixture DB anonymisée.
- [ ] **GSC-003** — réparer le contrat réel de `~/.claude/skills/seo-gsc` (champ `page` fantôme dans
      `top_queries`) + adapter weekly/actions/refresh. **Hors repo (couche skills).**
- [ ] **IDX-003** — réparer le contrat de `~/.claude/skills/seo-index-diagnose` (`buckets` vs `results`)
      + `post_publication.py`. **Hors repo (couche skills).**
- [ ] **IDX-008** — restreindre la Google Indexing API (`src/lib/server/indexing.ts`) : neutraliser la
      soumission générique (garder JobPosting / BroadcastEvent), documenter sitemap/maillage comme voie
      normale. **Change le comportement prod** (auto-submit) → à faire derrière un flag.

## Décisions techniques prises
- Config au boot **log-only** (pas de throw) pour protéger le daily driver d'un cold-start serverless ;
  le fail-fast strict est délégué à `requireEnv` au point d'usage.
- Flags OFF par défaut ; un flag ne route que le comportement, n'efface jamais de donnée.
- Renommage `jlabs-content-hub` limité à l'interne ; le client-facing est une décision de marque séparée.
- Branche `feat/cockpit` depuis `feat/neon` (isole la phase agentique ; `feat/neon` reste figée pour le
  cutover Vercel P5A).
