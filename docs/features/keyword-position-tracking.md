# Epic 23 : Suivi de positions mots-clés (SEO monitoring)

**Statut :** EN COURS
**Complexité :** M
**Périmètre :** SEO Google pur (GSC). Aucune dépendance aux articles / LinkedIn.

---

## Etat session 2026-06-19 (Phase 6 — détection de cannibalisation)

- **Fait :** **Phase 6 — détection de cannibalisation SEO** implémentée, typecheck OK (0 erreur) et smoke-testée e2e contre la DB Turso (6 projets backfillés).
  - Helper `computeCannibalization({ projectId, weekStart, minImpressions=50, limit=15 })` dans `gsc-analytics.ts` : groupe `gsc_query_page_data` par `(query, page)` sur 1 semaine, ne garde que les queries où ≥2 URLs dépassent `minImpressions`. Calcule taux de partage d'impressions par URL, `positionSpread`, `conflictsInTop20`, `severity` (`high` si ≥2 URLs en top 20). Position pondérée par impressions.
  - **Piège résolu au smoke test :** GSC remonte les `#ancres` (jump-to), `http`/`https` et `www`/non-www comme des pages distinctes → faux conflits massifs (1 article = 5 « URLs »). Fix : `normalizePageUrl()` strippe fragment + protocole + www + slash final AVANT le groupage. barberconcept est passé de 15 faux conflits à 11 réels (ex. « coupe homme 2026 » = 2 articles distincts en concurrence).
  - Route `api/projects/[slug]/gsc/cannibalization/+server.ts` (GET `?week=&minImpressions=&limit=`, auth admin/clé API), calquée sur `gsc/movers`.
  - UI : section « ⚠ Cannibalisation » dans l'onglet **seo-data** (header rouge, table mot-clé × URLs en conflit avec position + part d'impressions + écart de position, ligne rougie si `high`). Bouton **« + suivre »** par conflit → POST `/keywords` (fetch client, comme l'onglet Positions) → ajoute à la watchlist.
  - Pilotée par le `weekStart` déjà résolu dans le load seo-data (le sélecteur de semaine contrôle aussi la section, gratuitement).
- **Reste (optionnel) :** Phase 5 — alertes chute de position au cron (toujours non demandé).

---

## Etat session 2026-06-19 (impl. Phases 0→4)

- **Fait (suite) :** **db:push fait par Jonathan** + **backfill 12 sem des 6 projets GSC** (jonlabs, barberconcept, bis-repetita, physiopommier, wildcat, spinlink — 100% success, dernière sem. 2026-06-08). **Phase 4** implémentée et smoke-testée e2e (POST/GET watchlist, movers, CSV export via token, vue client, bad-token=404, archive).
  - Vue client `?token=` : route publique `src/routes/positions/[slug]/+page.{svelte,server.ts}` (brandée couleur projet, noindex, lecture seule, bouton Export CSV).
  - Export CSV : `api/projects/[slug]/keywords/export/+server.ts` — matrice mot-clé×semaines, BOM Excel, auth admin/clé API/`?token=`. Bouton aussi sur l'onglet admin.
  - Digest hebdo : bloc « Vos positions Google » ajouté à `clientWeeklyHtml` (+ champs `positions`/`positionsUrl` dans `ClientWeeklyData`), alimenté par le cron `gmb-weekly-digest`. Reste gated sur posts GMB>0 (bloc en plus, pas un nouvel email).
  - Refactor : `getWatchlistWithSeries()` dans `gsc-analytics.ts` = source unique (UI admin, vue client, CSV, digest).
- **Reste (optionnel) :** Phase 5 — alertes chute de position au cron (non demandé pour l'instant).
- **Fait initial :** Phases **0, 1, 2, 3** implémentées et typecheck OK (0 erreur).
  - Phase 0 : `api/cron/gsc-snapshot/+server.ts` (CRON_SECRET, itère projets avec `siteUrl`, `pullWeeklySnapshot`+`computeWeeklyDiff`, isolation erreurs + `sendCriticalError`) + cron `vercel.json` (`30 6 * * 1`).
  - Phase 1 : table `trackedKeywords` (`schema.ts`) + helpers `getKeywordHistory()`, `computeKeywordTrend()`, `computePositionMovers()` dans `gsc-analytics.ts`.
  - Phase 2 : routes `keywords/` (GET/POST), `keywords/[id]/` (PATCH/DELETE=archive), `gsc/keyword-history/`, `gsc/movers/`.
  - Phase 3 : onglet « Positions » (`positions/+page.{svelte,server.ts}`) + lien nav (`(app)/+layout.svelte`, icône `LineChart`). Watchlist + Sparkline (inversée : montant = progression) + TimeChart 12 sem (carry-forward des trous) + auto-découverte movers + empty-state `hasGsc`.
- **BLOQUÉ / à faire par Jonathan :** `npm run db:push` (refusé en auto — DB Turso partagée) pour créer `tracked_keywords`. **Indispensable avant tout test runtime** des phases 1-3.
- **Prochain :** après `db:push` → backfill 12 sem par projet (POST `/gsc/backfill {weeks:12}`), vérifier le cron, puis **Phase 4 — rapport client** (vue `?token=`, export CSV, bloc digest) et **Phase 5 — alertes** (optionnel).
- **Pièges actifs :**
  - `TimeChart`/`Sparkline` supposent « plus haut = mieux » et n'acceptent pas de `null` → positions inversées pour la sparkline, carry-forward pour TimeChart. Les vrais trous restent visibles dans `series` (`position === null`).
  - La `position` GSC est une **moyenne pondérée par impressions**, pas un rang propre. À présenter au client comme une tendance, pas un rang exact.
  - GSC a ~3 jours de latence (`GSC_LATENCY_DAYS = 3`) → le cron doit viser `latestCompleteWeekStart()`, jamais la semaine en cours.
  - Insert SQLite limité (~999 params) → garder le chunk de 200 lignes (déjà en place dans `pullWeeklySnapshot`).

---

## Objectif

Donner un **monitoring de positions dans le temps**, par mot-clé, exploitable pour communiquer avec les clients : « tu montes / descends / stagnes sur tel kw ». Aujourd'hui on ne dispose que de comparaisons N vs N-1, sans série propre ni watchlist curée.

---

## Existant (audit 2026-06-19)

La donnée de position **est déjà collectée** à granularité fine — le gap n'est pas la collecte mais l'automatisation, la curation, la visualisation temporelle et le rendu client.

| Brique | Fichier | Rôle |
|--------|---------|------|
| Moteur GSC | `src/lib/server/gsc-analytics.ts` | pull, snapshot, diff, actions, helpers dates |
| `gsc_snapshots` | `schema.ts` (~398-417) | agrégat hebdo/projet (totaux + position moyenne) |
| `gsc_query_page_data` | `schema.ts` (~419-443) | **1 ligne par (query, page, device) par semaine** — contient `position`. C'est la source de la série temporelle. Indexé `(projectId, query)`. |
| `gsc_weekly_diffs` | `schema.ts` (~445-462) | comparaison N vs N-1 (rising/falling/opportunities/new/lost) en JSON |
| `indexing_credentials` | `schema.ts` (~348-363) | service account GSC chiffré + `siteUrl` par projet |
| Endpoints | `src/routes/api/projects/[slug]/gsc/{snapshot,backfill,weekly,history,sites,actions}/+server.ts` | déclenche / lit |
| Page admin | `src/routes/(app)/projects/[slug]/seo-data/+page.{svelte,server.ts}` | KPIs, rising/falling, opportunités, historique |
| Charts réutilisables | `src/lib/components/ui/TimeChart.svelte`, `Sparkline.svelte` | SVG maison (déjà utilisés par stats GMB) |
| Emails | `resend` + pattern dedup critique GMB | réutilisable pour alertes |

**Trous identifiés :**
1. **Aucun cron GSC** → snapshots manuels → série trouée → impossible d'affirmer une tendance.
2. **Pas de notion de mots-clés suivis** → on subit ce que GSC renvoie, sans cible ni focus client.
3. **Pas de vue série temporelle par kw** → l'UI ne montre que N vs N-1, aucun graphe « position sur 12 sem ».
4. **Rien de présentable au client** → tables internes denses, pas de rapport positions.

---

## Décisions (validées avec Jonathan)

- **Granularité : hebdo.** On garde le backbone hebdo existant + cron auto. Moins de bruit, lisible client, réutilise tout le modèle. (Pas de quotidien pour l'instant.)
- **Modèle mots-clés : les deux.** Watchlist curée par projet (avec cible) **pour le rapport client** + section auto-dérivée (movers) **pour la découverte interne**.
- **Scope : SEO Google pur.** On ne supprime rien ; cet epic ne touche pas la prod d'articles ni les analytics LinkedIn.
- **UI : nouvel onglet dédié « Positions »**, distinct de `seo-data` (qui reste l'analyse hebdo + actions).
- **Charts : réemploi** de `TimeChart.svelte` / `Sparkline.svelte` (aucune lib externe).

---

## Plan par phases

### Phase 0 — Fiabiliser la collecte (fondation) ✅ implémenté (db:push + backfill à faire)

- [ ] `src/routes/api/cron/gsc-snapshot/+server.ts` : protégé par `CRON_SECRET`. Itère les projets avec `indexing_credentials.siteUrl` renseigné. Pour chacun : `pullWeeklySnapshot(latestCompleteWeekStart())` (idempotent) + `computeWeeklyDiff`.
- [ ] Ajouter le cron à `vercel.json` (proposé : lundi `30 6 * * 1`, après le digest GMB).
- [ ] Gestion d'erreur : log + email critique si un projet échoue (réutiliser pattern dedup Resend GMB). Ne pas faire échouer tout le batch sur un projet.
- [ ] Backfill 12 semaines par projet (one-shot) pour amorcer la série — via `/gsc/backfill` existant ou script.
- [ ] **Vérif :** après run, `gsc_snapshots` se remplit tout seul et `seo-data` affiche la nouvelle semaine.

### Phase 1 — Données : watchlist + série temporelle ✅ implémenté (db:push à faire)

- [ ] Table `tracked_keywords` dans `schema.ts` :
  - `id`, `project_id` (FK), `keyword` (text), `target_url` (text, nullable), `target_position` (real, nullable), `archived` (bool default false), `created_at`.
  - `uniqueIndex (project_id, keyword)`.
- [ ] `npm run db:push` (Turso) + commit migration si générée.
- [ ] `getKeywordHistory(projectId, keyword, weeks)` dans `gsc-analytics.ts` → série `[{ weekStart, position, clicks, impressions, ctr, topPage }]`, position pondérée (réutilise la logique de `aggregateByQuery`, filtrée sur 1 query).
- [ ] `computeKeywordTrend(series)` → verdict `up | down | flat` (delta position sur N sem + seuil de bruit) + `vsTarget` si `target_position`.

### Phase 2 — API ✅ implémenté

- [ ] `src/routes/api/projects/[slug]/keywords/+server.ts` : `GET` (liste watchlist + position courante + tendance + sparkline data), `POST` (add).
- [ ] `keywords/[id]/+server.ts` : `PATCH` (cible/url), `DELETE` (ou archive).
- [ ] `gsc/keyword-history/+server.ts` : `GET ?query=…&weeks=12` → alimente `TimeChart`.
- [ ] `gsc/movers/+server.ts` : `GET` → plus gros mouvements **de position** (gains/pertes) sur tous les kws d'une semaine vs N-1. (Distinct de rising/falling qui sont basés clics.)
- [ ] Auth : admin (`locals.user`) **ou** clé API, comme les autres routes `gsc/*`.

### Phase 3 — UI admin (onglet « Positions ») ✅ implémenté

- [ ] Nouvelle route `src/routes/(app)/projects/[slug]/positions/+page.{svelte,server.ts}`.
- [ ] Ajouter l'onglet dans la nav projet (à côté de seo-data).
- [ ] Watchlist : table kw → position actuelle, cible, `Sparkline` tendance, verdict ↑/↓/stagne, URL qui ranke. Clic kw → `TimeChart` position sur 12 sem.
- [ ] Formulaire ajout kw (+ cible optionnelle).
- [ ] Section « Auto-découverte » : movers (position) avec bouton « + suivre » → ajoute à la watchlist.
- [ ] État vide si pas de GSC configuré (réutiliser le pattern `hasGsc` de seo-data).

### Phase 4 — Rapport client ✅ implémenté (CSV + vue client + bloc digest)

- [ ] Vue positions accessible via `?token=` (watchlist only, lecture seule, brandée).
- [ ] Export (CSV ou print/PDF) de l'évolution des positions suivies.
- [ ] (Option) Bloc « vos positions » dans le digest hebdo client existant.

### Phase 5 — Alertes (optionnel)

- [ ] Au cron, après diff : pour chaque kw suivi, détecter chute > seuil vs N-1 (ou franchissement de la cible).
- [ ] Email admin (et/ou client opt-in), dedup pour éviter le spam.

---

## Edge cases

- Projet sans `siteUrl` GSC → onglet Positions en état vide, pas d'erreur.
- Mot-clé suivi absent de GSC une semaine (0 impression) → trou dans la série, à afficher comme « hors top / pas de données », pas position 0.
- Kw avec plusieurs pages qui rankent → position pondérée par impressions + afficher la `topPage`.
- Historique partiel (< N semaines) → verdict « données insuffisantes » plutôt qu'une fausse tendance.
- Backfill long → garder le pattern job background existant (cf. `/gsc/snapshot` route UI).

---

## Suivi commits

_(à remplir au fil de l'eau — convention `[hub] add|fix: …`)_
