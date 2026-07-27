# HANDOFF — 2026-07-27

## Features actives
| Feature | Fichier | Statut |
|---------|---------|--------|
| Reconstruction agentique — E00 fondations | [features/e00-fondations-cockpit.md](features/e00-fondations-cockpit.md) | **EN COURS** |
| Décommissionnement Turso + rotation password (Phase 6) | [NEON-MIGRATION.md](NEON-MIGRATION.md) § Phase 6 | EN ATTENTE (Jonathan, infra) |

## Reprendre ici
**FIND-008 livré** — le parc a enfin un détecteur de **cannibalisation** (`detect:cannibalization`,
4ᵉ frère du catalogue hebdo). Le point du lot n'est pas la détection mais la **normalisation
d'URL** : elle évite **217 faux conflits sur `barberconcept`** (397 → 180), dont **220 qui se
seraient lus « probables »** — les ancres d'un même article se partagent les impressions à parts
égales, donc elles prennent exactement la forme d'une compétition équilibrée.
**Gate M2 : tout est coché sauf `ctr_gap`** (FIND-007, P1, `BLOCKED` sur GSC-005).
Suivant : **REP-004** (historique et comparaison) ou **DASH-003 lot 2 ch. 3** (l'onglet Rapports,
qui donnerait enfin un lecteur à `weekly_reports`).

⚠️ **Le tripwire `maxUrls` est mathématiquement inatteignable au défaut** : `relativeShare = 0.15`
borne déjà le nombre d'URLs significatives à ⌊1/0,15⌋ = 6. Il surveille un projet qui **abaisse**
sa part, pas la normalisation.
⚠️ **`barberconcept` a UN problème d'architecture éditoriale, pas 25 problèmes ponctuels** :
180 conflits retenus, 25 écrits. Le premier rapport devrait le nommer comme tel.
⚠️ **Premier tick FIND-008 : 42 findings sur tout le parc** (pas 200) — 25 sur `barberconcept`
(tronqué), 8 `jonlabs`, 3 `lecureux`, 2 `barbermedia`, 1 pour les quatre suivants, 0 `cardrank`.
⚠️ **Ne PAS piper un script de preuve dans `head`** : le SIGPIPE tue le process avant le nettoyage
et laisse observations + findings en base, ce qui fait échouer la garde d'isolation d'une AUTRE
preuve. Utiliser `tail`.
⚠️ **Une découverte `new_query` non traitée s'auto-résout** au bout de 4 semaines ; personne n'est
prévenu. **`LOST = 0` sur les 9 projets** — ne pas baisser le seuil sans relire la mesure FIND-006.
⚠️ **Un rapport publié `partial` ne devient jamais `complete`** : republier est un no-op (graine de
REP-004). **L'annonce de disponibilité est produite, pas envoyée** (TEL-001 BLOCKED ; envoi = TEL-002).
⚠️ **Le SLO de 10:00 : 81 jobs hebdo** (9 projets × 9 entrées) pour `MAX_JOBS_PER_TICK = 25` —
**déjà cassé à 72**, FIND-008 ajoute 12 % à un déficit de 31. Leviers : le plafond par tick (les 4
détecteurs sont `provider: 'none'`) ou `report.publish_deadline_minutes` (`system_settings`, sans
redéploiement) — après avoir lu la mesure.
⚠️ **Aucun écran ne lit `weekly_reports`** ni les findings de turnover/cannibalisation
(`npx tsx scripts/rep-003-publish.ts --list | --show [créneau] | --dry-run`).
⚠️ **Le cockpit n'est PAS en prod** : `main` = socle epics 1-23 sur Neon, ni `/jobs`, ni `/inbox`,
ni cron `tick`. `npm run db:push` depuis `main` = risque de PROD (29 tables déclarées, 61 en base).
⚠️ **La prod écrit dans la même base** → toute assertion « base rendue à l'identique » sur
`gsc_query_page_observations` est racée.

Commit : `351803d` (E00) · prod : `e5efc83` sur `main`
