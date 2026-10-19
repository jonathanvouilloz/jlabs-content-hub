# Retrait GMB et LinkedIn (coupure)

> **Statut** : DONE (coupure ; code conservé) · **Livré** : 2026-10-19 · **Commits** : `62dfe48` (unique) · **Non déployé** : attend l'accord de Jonathan

## Ce que ça fait
Le hub ne gère plus Google Business Profile ni la publication LinkedIn : plus de cron, plus de job planifié, plus d'onglet. Barber Concept gère ses avis sur son propre VPS. Le code reste en place (sans rien qui l'exécute) jusqu'à la migration de seo-stats vers OpenSEO.

## Comment ça marche
Coupure à trois endroits, rien n'est supprimé :
1. **Crons** : `vercel.json` ne garde que `/api/cron/tick` (horaire). `gmb-publish`, `gmb-weekly-digest`, `linkedin-publish` sont retirés. `gmb-reviews` n'était déjà plus planifié.
2. **Cadran quotidien** (`SCHEDULE_CATALOG.daily` dans `schedule-state.ts`) : `collect:gmb_reviews`, `detect:review_pending`, `detect:employee_mentions` retirés. Restent `findings:lifecycle`, la collecte d'inspection d'URLs et `detect:index_transition`. Le tick ne planifie donc plus aucun job GMB.
3. **Navigation** : onglets LinkedIn, GMB, Fiche Google, Logs GMB, Avis Google retirés de `projectNav` (layout `(app)`) ; Avis et Présence locale retirés du layout `projects/[slug]`.

Conservés tels quels : dossiers `src/routes/api/cron/{gmb-publish,gmb-reviews,gmb-weekly-digest,linkedin-publish}`, routes de pages et API agent, handlers de jobs, tables. Les URLs restent joignables à la main.

Archive : tables seostats `gmb_*`, `review_*`, `employee_mentions`, `linkedin_settings` (4 364 lignes) en JSON chiffré, hors repo : `noyau/backups/neon/seo-stats-gmb-linkedin-2026-10-19.json.enc` (lignes de tokens masquées).

## Carte du code
> Mise à jour : 2026-10-19

| Fichier | Rôle |
|---|---|
| `vercel.json` | Ne garde que le cron `tick`. |
| `src/lib/server/schedule-state.ts` | `SCHEDULE_CATALOG.daily` sans job GMB. |
| `src/lib/server/schedule-state.test.ts` | Verrou : aucun job d'avis/mentions dans `hourly` ni `daily`. |
| `src/routes/(app)/+layout.svelte` | `projectNav` sans entrées GMB/LinkedIn. |
| `src/routes/(app)/projects/[slug]/+layout.svelte` | Onglets Avis et Présence locale retirés. |
| `CLAUDE.md` | Bandeau de retrait ; sections GMB plus bas marquées historiques. |
| `src/lib/server/job-limits.ts` | Garde encore le provider `gmb` (voir dettes). |

### Décisions clés
- Coupure sans suppression — réversible tant que la migration OpenSEO n'a pas eu lieu (détail daté → DECISIONS.md, 2026-10-19).
- Archive chiffrée hors repo avant toute suppression future de table.

## Comment débuguer
- **Par où entrer** : `SCHEDULE_CATALOG` dans `src/lib/server/schedule-state.ts`.
- **Ce qu'on observe** : `/jobs` ne doit plus montrer de `collect:gmb_reviews`, `detect:review_pending`, `detect:employee_mentions` pour les nouveaux créneaux ; le dashboard Vercel ne liste que `tick`.
- **Pannes connues** : un job GMB encore en file d'avant le déploiement peut être drainé une dernière fois (non vérifié) ; une page GMB ouverte par URL directe fonctionne encore mais ses données sont figées.
- **Pièges** : ne rien réactiver (consigne dans `CLAUDE.md`). Les tests GMB-002/009/010/011 anciens décrivent un comportement coupé.

## Configuration
Aucun ajout. À retirer à la main (tâches humaines) : scopes machine `review:*` côté Vercel ; accès Google (OAuth Business Profile) à révoquer.

## Tests et vérifications
| Vérif | Commande | Résultat réel |
|---|---|---|
| Types | `npm run check` | 0 erreur (rapporté, non relancé) |
| Tests | `npm test` | 1717/1717 verts (rapporté, non relancé) |
| Déploiement | — | non fait |

## Limites et dettes
- `job-limits.ts` garde le provider `gmb` et `reservedTypes: ['collect:gmb_reviews', …]` : inoffensif, plus rien ne planifie ce job.
- `LinkedinIcon` et le champ `linkedin` de la nav sont morts.
- Scopes machine `review:*` à retirer côté Vercel, accès Google à révoquer : tâches humaines.
- Les feature files `gmb-002/009/010/011` et `docs/HANDOFF.md` (« Reprendre ici » GMB-010/011) décrivent un état coupé ; non réécrits.
- Routes, handlers et tables supprimables après la migration OpenSEO.
