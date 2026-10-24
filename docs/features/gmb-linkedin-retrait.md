# Retrait GMB et LinkedIn

> **Statut** : DONE · **Livré** : 2026-10-25 · **Commits** : `62dfe48` (coupure, 2026-10-19) puis `5d92198` (suppression du code), tête `00de7c5`


## Etat session 2026-10-25 (clôture)

**Fait :** branche `chore/retrait-gmb-linkedin` fusionnée en fast-forward dans `main` et poussée (`00de7c5`) · déploiement Vercel prod `jlabs-content-7h7813r45` Ready · branche Neon `backup-2026-10-25-pre-drop-gmb` créée par Jonathan · dry-run relancé (19/19, résidus identiques au 24/10) · `--apply --backup-branch=backup-2026-10-25-pre-drop-gmb` exécuté : « Retrait appliqué : 19 tables et 2 colonnes supprimées. »
**Prochain :** migration vers OpenSEO. À la main (Jonathan) : scopes machine `review:*` côté Vercel, révocation de l'accès Google OAuth.
**Pieges :** aucun dry-run de contrôle relancé après le DROP (état post-DROP non vérifié) · dry-run post-DROP fait : 0/19 tables, 0 résidu · dettes : `projects.weekly_digest_enabled` orpheline, stub `loadProjectPolicyGate` à supprimer. Le piège `db:push` est levé : schéma et base sont alignés.

---

## Etat session 2026-10-25 (avant déploiement)

**Fait :** code GMB/LinkedIn supprimé (294 fichiers) · section avis du rapport hebdo et compteur d'accueil retirés · dédup des alertes critiques déplacée vers `system_settings` · migration DROP écrite + dry-run constaté (19/19 tables) · docs mises à jour par doc-keeper.
**Prochain :** Jonathan relit et autorise le merge/déploiement de `chore/retrait-gmb-linkedin` ; ensuite seulement, branche Neon de sauvegarde puis `npx tsx scripts/apply-drop-gmb-linkedin.ts --apply --backup-branch=<nom>`.
**Pieges :** ne pas migrer avant le déploiement (la prod lit encore `gmb_reviews`) · `npm run db:push` proposerait les mêmes DROP sans garde-fou · le script ne vérifie pas l'existence de la branche de sauvegarde · dry-run post-DROP fait : 0/19 tables, 0 résidu · dettes : `projects.weekly_digest_enabled` orpheline, stub `loadProjectPolicyGate` à supprimer.
**Commit :** bc4f7ae docs(gmb-linkedin-retrait): documente la suppression du code et le DROP base en attente

---

## Ce que ça fait
Le hub ne gère plus Google Business Profile ni la publication LinkedIn. La coupure du 2026-10-19 (`62dfe48`) a retiré crons, jobs planifiés et onglets ; `5d92198` supprime ensuite tout le code (294 fichiers, -35 026 lignes). Le DROP des 19 tables a été appliqué le 2026-10-25 via un script dédié, après déploiement.

## Comment ça marche
Code supprimé : routes UI/API avis, fiches, publications, OAuth Google/LinkedIn, API agent v1 des avis, rapport mensuel d'avis, handlers `collect:gmb_reviews` / `detect:review_pending` / `detect:employee_mentions`, policies d'avis, upload Blob (`@vercel/blob` et `openai` retirés de `package.json`), digests GMB, scripts one-off.

Ce qui change dans ce qui reste :
- **Rapport hebdo** : la section `reviews` n'est plus produite ; son titre reste dans `weekly-report-state.ts` pour relire les rapports archivés.
- **Accueil** : compteur « avis sans réponse » retiré (`home.ts`, `home-state.ts`).
- **Contenus** : types `gmb` et `linkedin` retirés (UI, API `content`, vue client).
- **Jobs** : provider `gmb` retiré de `job-limits.ts`.
- **Findings** : 3 types retirés (`review_pending_sla`, `negative_review`, `unknown_employee_mention`).
- **Alertes critiques** : `sendCriticalError` (`notifications.ts`) dédoublonne via `system_settings`, clé `notify.critical_sent.{hash}` (1 h), au lieu de `gmb_settings`.
- **Proposeur de findings** : `loadProjectPolicyGate` ne lit plus de policy. Plus de magasin donc refus d'auto-approbation par défaut ; `proposal_approvals` n'a jamais reçu de ligne `method = 'policy'`.

DROP base (à part) :
```
déployer le code -> branche Neon de sauvegarde -> dry-run -> --apply --backup-branch=<nom>
```
`drizzle/manual-drop-gmb-linkedin.sql` : une transaction, sans CASCADE. Supprime les résidus GMB (jobs + attempts + effects, `monitoring_steps`, findings d'avis + events), 19 tables, les contenus gmb/linkedin (+ `status_history`, `comments`, `seo_reports.content_id` mis à NULL, `content_types`) et les colonnes `projects.gmb_location_id` et `contents.gmb_post_id`.

## Carte du code
> Mise à jour : 2026-10-25

| Fichier | Rôle |
|---|---|
| `drizzle/manual-drop-gmb-linkedin.sql` | DROP transactionnel des 19 tables, résidus et 2 colonnes. |
| `scripts/apply-drop-gmb-linkedin.ts` | Applique le SQL ; dry-run par défaut ; `--apply` exige `--backup-branch=`. |
| `src/lib/server/notifications.ts` | Dédup des alertes critiques via `system_settings`. |
| `src/lib/server/proposers/finding-proposer.ts` | `loadProjectPolicyGate` : plus de policy, refus d'auto-approbation. |
| `src/lib/server/weekly-report-state.ts` | Section `reviews` non produite, titre conservé pour l'archive. |
| `src/lib/server/schedule-state.ts` | `SCHEDULE_CATALOG.daily` sans job GMB (depuis `62dfe48`). |
| `src/lib/server/db/schema.ts` | Tables et colonnes GMB retirées : le schéma ne les connaît plus. |
| `src/lib/server/job-limits.ts` | Provider `gmb` retiré. |
| `vercel.json` | Seul cron : `/api/cron/tick`. |

### Décisions clés
- Suppression du code, DROP base découplé et gardé — la prod déployée lit encore `gmb_reviews` tant que le nouveau code n'est pas déployé (DECISIONS.md, 2026-10-24).
- Dédup des alertes dans `system_settings`, pas dans une table dédiée — KV d'exploitation déjà là (DECISIONS.md, 2026-10-24).
- Archive chiffrée hors repo avant tout DROP : `noyau/backups/neon/seo-stats-gmb-linkedin-2026-10-19.json.enc`.

## Comment débuguer
- **Par où entrer** : `scripts/apply-drop-gmb-linkedin.ts` (dry-run) pour l'état base ; `notifications.ts` pour les alertes.
- **Ce qu'on observe** : le dry-run liste tables présentes, lignes et résidus. Après DROP, `Tables encore présentes` doit être absent. Alertes : lignes `system_settings` dont la clé commence par `notify.critical_sent.`.
- **Pannes connues** : `--apply` sans `--backup-branch` est refusé (voulu) ; une erreur SQL annule toute la transaction ; un `DROP TABLE` qui échoue signale une dépendance inconnue (pas de CASCADE).
- **Pièges** : ordre obligatoire, code puis migration, sinon l'accueil et le rapport de la prod actuelle plantent sur `gmb_reviews`. `npm run db:push` : plus de risque depuis le DROP du 2026-10-25 (schéma et base alignés). Le script ne vérifie pas que la branche de sauvegarde existe, il n'en garde que le nom.

## Configuration
Aucune variable ajoutée. `.env.example` allégé (variables GMB/LinkedIn/Blob retirées). Reste à la main (non fait) : scopes machine `review:*` côté Vercel, accès Google OAuth à révoquer.

## Tests et vérifications
| Vérif | Commande | Résultat réel |
|---|---|---|
| Types | `npm run check` | 0 erreur, 31 warnings a11y préexistants (relancé 2026-10-25) |
| Tests | `npm test` | 1469 verts, 59 fichiers (relancé 2026-10-25) |
| Build | `npm run build` | bundling OK ; adaptateur Vercel en échec EPERM symlink Windows (environnement, antérieur) |
| Dry-run DROP | `npx tsx scripts/apply-drop-gmb-linkedin.ts` | 2026-10-24 puis 2026-10-25 : 19/19 tables ; résidus identiques : 2055 jobs + 2055 `monitoring_steps` GMB, 69 findings d'avis, 73 contenus gmb/linkedin. Volumes : `gmb_reviews` 3466, `review_reply_delivery_events` 332, `review_mention_candidates` 288, `publish_logs` 209 (relancé 2026-10-25) |
| `--apply` | `npx tsx scripts/apply-drop-gmb-linkedin.ts --apply --backup-branch=backup-2026-10-25-pre-drop-gmb` | 2026-10-25 : « Retrait appliqué : 19 tables et 2 colonnes supprimées. » |
| Dry-run post-DROP | `npx tsx scripts/apply-drop-gmb-linkedin.ts` | 2026-10-25 : « Tables GMB/LinkedIn présentes : 0/19 » ; résidus : jobs GMB 0, `monitoring_steps` GMB 0, findings d'avis 0, contenus gmb/linkedin 0 (rapporté par Jonathan, non relancé par doc-keeper) |
| Déploiement | Vercel prod | `jlabs-content-7h7813r45` Ready (rapporté) |

## Limites et dettes
- Reste à la main (Jonathan) : scopes machine `review:*` côté Vercel, révocation de l'accès Google OAuth.
- `projects.weekly_digest_enabled` (schema, API projet, layout) n'a plus de lecteur apparent depuis le retrait des digests GMB : colonne et champ orphelins.
- `loadProjectPolicyGate` garde des paramètres inutilisés (`_db`, `_projectId`) : stub à supprimer au prochain passage sur le proposeur.
- Écart avec la coupure du 2026-10-19 : « code conservé jusqu'à OpenSEO » est remplacé par la suppression immédiate.
- Tests : 1717 rapportés le 2026-10-19, 1469 maintenant ; baisse attendue (tests GMB supprimés), non auditée test par test.
- `e00-fondations-cockpit.md`, `PLAN.md` et `DECISIONS.md` décrivent encore GMB comme existant : historique, non réécrit.
