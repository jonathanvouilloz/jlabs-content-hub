# PRD — jokiSEO

> **Version :** 3.0
> **Date :** 2026-06-24
> **Auteur :** Jonathan Vouilloz
> **Statut :** Validé (vision), epics à dérouler
> **Remplace :** `PRD.md` (v1.1, "Content Hub") comme source de vérité du scope. Le PRD v1.1 reste comme archive de la phase 1-2.

---

## 0. Le pivot en une phrase

Le produit cesse d'être un **hub de contenu** (articles + LinkedIn + GMB) et devient **jokiSEO** : un **cockpit de monitoring SEO & présence locale** pour des entreprises locales, pensé pour l'usage quotidien et pour produire des **livrables client white-label**. On garde et on approfondit ce qui a de la valeur récurrente (positions, GMB, avis, indexation) ; on retire la surface "production de contenu" qui faisait du bruit.

**Ce n'est pas un rewrite.** La base SvelteKit + Turso + Drizzle + Better Auth est saine et conservée. Voir [DECISIONS.md](DECISIONS.md) (2026-06-24, "Refactor in-place, pas de rewrite" + "Turso conservé, pas de migration Neon").

---

## 1. Vision & contexte

### D'où on part (constat après 3 mois d'usage)

L'app fonctionne et est utilisée quasi quotidiennement. Les moteurs durs sont en place et fiables :

- **GSC** (`gsc-analytics.ts`, ~1160 lignes) : snapshots hebdo, diffs, actions, watchlist positions, cannibalisation.
- **GMB** (`gmb.ts`, ~850 lignes) : publication auto, fiche (lecture + édition), insights, avis.
- **Indexation** (`indexing.ts`, ~460 lignes) : URL Inspection + Indexing API.

Mais trois choses bloquent la "professionnalisation" :

1. **Le tracking de positions est flou.** La "position" affichée est la moyenne GSC pondérée par impressions, pas un rang réel. Impossible de dire au client "tu es 3ᵉ sur tel mot-clé" avec certitude → on travaille "à la vogue".
2. **La gestion des avis ne scale pas.** Aujourd'hui : fetch manuel → brouillon → soumission manuelle. Tient pour 1 projet, pas pour 10.
3. **Des angles morts SEO majeurs** : aucun suivi de backlinks, aucune visibilité IA (ChatGPT / Perplexity / AI Overviews), aucun rang local géolocalisé (geo-grid).

### Où on va

**jokiSEO** = l'outil que Jonathan ouvre chaque matin pour piloter le SEO local de ses clients, et dont il extrait des rapports mensuels propres et brandés.

Trois piliers :

- **SEO** : positions réelles (rang SERP géolocalisé) + GSC (tendance/queries) + indexation + cannibalisation + **backlinks** + **visibilité IA**.
- **Présence locale (GMB)** : fiche, posts auto, **avis full-auto**, insights, **geo-grid local**.
- **Rapport client** : un livrable mensuel unifié, white-label, qui combine les deux piliers.

### Utilisateurs cibles

**Principal — Jonathan (admin / opérateur SEO).** Pilote N projets clients, veut un cockpit dense en data, des automatisations fiables, et des livrables prêts à envoyer.

**Secondaire — Client (viewer, token).** Reçoit un dashboard/rapport lisible, brandé, lecture seule : positions, présence Google, avis, évolution dans le temps. Pas de jargon.

### Critères de succès

- Jonathan ne fetch plus jamais un avis à la main : le pipeline avis tourne tout seul (avec garde-fous).
- Pour tout mot-clé suivi, on connaît le **rang réel** (pas un blend), géolocalisé.
- Un rapport mensuel client se génère en < 5 min, sans copier-coller.
- L'app couvre les 3 piliers SEO "pro" : positions, technique/indexation, netlinking — plus le différenciant visibilité IA.

---

## 2. Scope

### ✅ IN — la cible jokiSEO

- Cockpit projet unifié (KPI SEO + GMB + avis en un écran).
- Nav réorganisée en 2 piliers : **SEO** / **Présence locale** + Cockpit + Paramètres.
- **Auto-réponse aux avis** : sync auto + brouillon auto + envoi différé configurable + garde-fou par note.
- **Rank tracking SERP réel** (DataForSEO), géolocalisé, par mot-clé suivi.
- **Geo-grid local** GMB (rang par point géographique autour de la fiche).
- **Dashboard réputation** (note moyenne, sentiment, taux de réponse, leaderboard employés dans le temps).
- **Backlinks** (domaines référents, nouveaux/perdus, autorité).
- **Visibilité IA / GEO** (citations ChatGPT/Perplexity/Google AI Overviews sur requêtes cibles).
- **Rapport client mensuel** unifié, white-label (token + export).
- Conservation et approfondissement de GSC, indexation, fiche GMB, posts GMB auto.

### ❌ OUT — ce qu'on retire ou ne fait pas

- **Production de contenu dans le dashboard** : onglets **Articles** et **LinkedIn** retirés de l'UI. (Le pipeline de rédaction vit côté skills Claude Code, pas dans jokiSEO.)
- Publication CMS (Webflow) depuis le dashboard — sort de la surface jokiSEO.
- Éditeur de contenu intégré.
- Multi-admin / rôles fins (Jonathan reste seul admin pour l'instant).
- **Migration de DB** (Turso → Neon) : non, pas justifié — voir DECISIONS.

> **Note data :** on ne *supprime pas* les tables `contents` (GMB en dépend), `comments`, ni les lignes article/linkedin existantes. On retire la **surface UI** et on filtre `type` dans les agrégats. Les tables `linkedinSettings`, `cmsConnections` restent en place, inertes.

### 🔮 LATER — après la cible

- Tracking concurrents (positions + GMB + backlinks d'un concurrent désigné).
- Alertes proactives (chute de position, avis négatif, perte de backlink) — email/opt-in client.
- Multi-admin + rôles.
- Commercialisation jokiSEO en SaaS (à valider une fois l'outil mûr et multi-client éprouvé).
- Store analytique dédié si le volume time-series (geo-grid + rank quotidien) l'exige.

---

## 3. Les modules (cible fonctionnelle)

### 3.1 Cockpit projet

Refonte de l'actuelle "Vue d'ensemble". Un écran de pilotage par projet :

- KPI SEO : clics/impressions GSC (tendance), nb mots-clés suivis, mouvements de position de la semaine, alertes cannibalisation/indexation.
- KPI présence locale : impressions GMB, avis en attente, note moyenne, posts à venir.
- Visibilité IA : nb de requêtes où la marque est citée.
- Backlinks : domaines référents, delta du mois.
- Liens rapides vers chaque module.

### 3.2 SEO — Positions (rang réel)

- **Watchlist** mots-clés (existant, epic 23) enrichie du **rang SERP réel** géolocalisé (DataForSEO) à côté de la position GSC.
- Distinction explicite UI : "Rang Google (réel, {ville})" vs "Position moyenne GSC (tendance)".
- Série temporelle par mot-clé, cible, verdict ↑/↓/stagne.
- Auto-découverte des movers (existant).
- Cannibalisation (existant, epic 23).

### 3.3 SEO — Indexation

- Historiser l'état d'indexation (URL Inspection déjà en place) : nb pages indexées, pages tombées, coverage states.
- Surfacer dans le cockpit + alerte si régression.

### 3.4 SEO — Backlinks

- Snapshot périodique des domaines référents (DataForSEO Backlinks ou équivalent).
- Nouveaux / perdus, autorité, ancres.
- Vue tendance + delta mensuel pour le rapport client.

### 3.5 SEO — Visibilité IA (GEO)

- Pour un set de requêtes cibles par projet : interroger périodiquement ChatGPT/Perplexity et scraper les AI Overviews Google (via DataForSEO) pour détecter **si la marque est citée**, à quelle place, avec quelles sources.
- Best-effort (pas de garantie d'exhaustivité) — assumé comme indicateur de tendance.

### 3.6 Présence locale — Avis (full-auto)

- **Sync auto** : brancher le cron `gmb-reviews` (aujourd'hui non planifié) → toutes les heures.
- **Brouillon auto** : génération IA dès détection d'un nouvel avis (prompt système existant, déjà éprouvé).
- **Envoi différé configurable** : par projet, `auto_reply_enabled`, `auto_reply_min_rating` (ex. ≥ 4 auto, < 4 = file manuelle), `auto_reply_delay_hours` (délai pour ne pas paraître robotisé, sans laisser traîner).
- Garde-fou : avis négatifs → toujours validation manuelle.
- Tracking employés mentionnés (existant) conservé.

### 3.7 Présence locale — Réputation (analytics avis)

- Courbe de note moyenne dans le temps, volume d'avis, sentiment, **taux de réponse**, délai moyen de réponse, leaderboard employés (sur `employee_mentions` existant).

### 3.8 Présence locale — Geo-grid

- Grille géographique (3×3 / 5×5 / 7×7) autour de la fiche : rang du business pour un mot-clé local à chaque point (DataForSEO local pack).
- Heatmap + score moyen, historisé pour montrer la progression.

### 3.9 Rapport client mensuel

- Vue/export white-label combinant : positions (rang réel + tendance), présence Google (insights GMB), avis (note + réponses), geo-grid, backlinks, visibilité IA.
- Accessible via `?token=` (existant) + export (CSV/PDF).
- Remplace/élargit le digest hebdo actuel.

---

## 4. Plan d'epics

Détail et séquençage dans [PLAN.md](PLAN.md) — Phase 3. Résumé :

| # | Epic | Rôle |
|---|------|------|
| 24 | Focus & IA | Retrait surface Articles/LinkedIn, nav 2 piliers, cockpit unifié |
| 25 | Couche providers DataForSEO + runner de jobs | Fondation API externe + jobs longs/planifiés |
| 26 | Avis full-auto | Sync + brouillon + envoi différé + garde-fous |
| 27 | Rank tracking SERP réel | Rang géolocalisé (absorbe l'epic 23 positions) |
| 28 | Geo-grid local | Rang GMB par point géographique |
| 29 | Dashboard réputation | Avis dans le temps |
| 30 | Backlinks | Domaines référents |
| 31 | Visibilité IA / GEO | Citations LLM / AI Overviews |
| 32 | Rapport client mensuel unifié | Livrable white-label |

**Séquençage :** 24 + 25 (cadre + plomberie) → 26 + 27 (les deux douleurs prioritaires) → 28→32 (expansion, réordonnables selon valeur commerciale). L'epic 23 (positions GSC) est **absorbé dans l'epic 27** : son code reste, l'epic 27 ajoute le rang réel par-dessus.

---

## 5. Data model — ajouts prévus

Tables existantes conservées (voir `schema.ts`). Ajouts indicatifs (à affiner par epic) :

- `review_automation` (ou colonnes sur `projects`) : `auto_reply_enabled`, `auto_reply_min_rating`, `auto_reply_delay_hours`, `auto_reply_last_run`. — Epic 26
- `keyword_ranks` : 1 ligne par (projet, mot-clé, localisation, moteur, date) → `position`, `url`, `serp_features`, `source`. — Epic 27
- `geo_grid_scans` + `geo_grid_points` : un scan = N points, chaque point porte (lat, lng, rang, mot-clé). — Epic 28
- `referring_domains` / `backlinks` : snapshot domaines référents, autorité, ancres, first/last seen. — Epic 30
- `ai_visibility_checks` : 1 ligne par (projet, requête, moteur, date) → `cited` (bool), `position`, `snippet`, `sources`. — Epic 31

Le runner de jobs s'appuie sur la table `aiJobs` existante (à généraliser). — Epic 25

---

## 6. Intégrations externes

| Service | Usage | Statut |
|---------|-------|--------|
| Google Search Console API | Positions GSC, snapshots | En place |
| Google Business Profile API | Posts, fiche, insights, avis | En place |
| Google Indexing / URL Inspection API | Indexation | En place |
| **DataForSEO** | Rang SERP réel, geo-grid, backlinks, AI Overviews | **Nouveau — epic 25** |
| LLM APIs (ChatGPT/Perplexity) | Visibilité IA par prompting | Nouveau — epic 31 |
| Resend | Emails (digests, alertes) | En place |
| Vercel Blob | Images GMB | En place |

DataForSEO est déjà utilisé côté skill `/seo-keywords` → le hub réutilise le même fournisseur, centralisé dans une couche `providers/` (epic 25).

---

## 7. Stack technique

Inchangée. SvelteKit (Svelte 5 runes) · Turso (libSQL) · Drizzle · Better Auth · Vercel. Voir CLAUDE.md.

**Décisions structurantes du pivot (détail dans DECISIONS.md, 2026-06-24) :**
- Refactor in-place, pas de rewrite.
- Turso conservé, pas de migration Neon.
- DataForSEO comme fournisseur SEO externe unique (rang/geo-grid/backlinks/AI Overviews).

---

## 8. Questions ouvertes

- [ ] Cadence du rank tracking réel : hebdo (aligné GSC, moins cher) ou quotidien sur un sous-ensemble de mots-clés stratégiques ?
- [ ] Visibilité IA : quels moteurs en v1 (AI Overviews via DataForSEO d'abord, LLM directs ensuite) ? Budget tokens ?
- [ ] Geo-grid : taille de grille et rayon par défaut ? Cadence (mensuelle ?) vu le coût API.
- [ ] Backlinks : DataForSEO Backlinks suffit-il, ou Ahrefs pour la profondeur ? (coût vs qualité)
- [ ] Rapport client : export PDF (rendu print) prioritaire, ou CSV/vue web d'abord ?
- [ ] Faut-il un domaine/branding `jokiSEO` distinct de `hub.jonlabs.ch` ?

---

## 9. Changelog

| Date | Version | Changements |
|------|---------|-------------|
| 2026-06-24 | 3.0 | Pivot "Content Hub" → **jokiSEO** (cockpit SEO & présence locale). Drop surface Articles/LinkedIn. Ajout rank réel, geo-grid, backlinks, visibilité IA, avis full-auto, rapport client unifié. Epics 24-32. Epic 23 absorbé dans 27. |
