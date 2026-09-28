# Feature — GMB-010 : résolution des mentions candidates envoyées par Hermes

> Epic E08 · statut : **PLANNED** · 2026-09-28 · dépend de GMB-009 (roster versionné) et de l'API agent v1

## Constat (production, lecture seule, 2026-09-28)

- `review_mention_candidates` (barberconcept) : **24 lignes, toutes `candidate`**, toutes écrites par
  `hermes-barberconcept-2026-09-r2` entre le 26/09 18:45 et le 27/09 07:45.
- **Aucun code n'écrit jamais `validated` / `rejected` / `resolved`**, ces statuts existent seulement
  dans le CHECK de `manual-data-010.sql`. `buildAgentMonthlyReviewReport` renvoie donc chaque ligne
  dans `unresolvedCandidates`, même quand l'avis porte déjà la mention validée (Alexis, Moha, Giuseppe).
- **Doublons** : 24 lignes pour 18 couples (avis, token normalisé). L'unique porte sur
  `(project_id, idempotency_key)` avec la clé `${key}:${index}`. Une ré-soumission avec une autre clé
  crée donc une deuxième ligne.
- **`detect:employee_mentions` est mort depuis le 25/09** : `429 … organization max RPM: 3` →
  `dead` (25/09, 26/09), deux autres jobs en file. Les avis du 26/09 ont `mentioned_employees = null`.
  Le détecteur envoie jusqu'à 25 appels LLM d'affilée : il ne peut pas tenir sous 3 RPM.
- Hermes n'a **aucune lecture du roster** via l'API agent.
- Roster courant `2026-09-02.1` (27 entrées) : **19/24** candidates matchent déjà exactement
  (normalisation casse/accents) dans le bon établissement.

## Décisions (Jonathan, 2026-09-28)

| Token | Décision |
|---|---|
| `Guiseppe`, `guiseppe`, `Gueppe` (Lausanne) | **= Giuseppe** → aliases `Guiseppe`, `Gueppe` sur `giuseppe` |
| `Henok Josief` | **Rive**. Cofondateur, pas un barbier au compteur → **mentions non suivies** (`trackMentions: false`) |
| `Joseph` (Lausanne) | **= Henok Josief** (supposition de Jonathan) → alias `Joseph`, `Josief` → `resolved` / `not_tracked` |
| `N2` (Sion) | faux positif d'extraction → `rejected` |

« Non suivi » ≠ « inconnu » : Henok reste dans le roster, sinon chaque citation lèverait une alerte
`unknown_employee_mention`. Sa mention est **reconnue puis écartée**. Elle ne va ni dans
`mentioned_employees`, ni dans le récap, ni dans les primes. Comme rien n'est attribué, une entrée
non suivie peut matcher **dans tous les salons** (le Joseph cité est à Lausanne, Henok est à Rive).
Le risque résiduel : un client réellement prénommé Joseph serait écarté en silence. C'est acceptable,
puisque rien ne se compte à tort.

Principe maintenu : **aucun rapprochement flou**. Une variante devient un alias validé par un humain,
jamais une supposition du système (le roster sert au calcul des primes).

## Plan

### Lot 1 — Roster `2026-09-28.1`

1. `scripts/promote-barberconcept-review-projection.ts` : `giuseppe.aliases = ['Guiseppe', 'Gueppe']`,
   `henok-josief = { locations: ['rive'], aliases: ['Joseph', 'Josief'], trackMentions: false }`,
   `employeeMentions.version = '2026-09-28.1'`.
   Code : `trackMentions?: boolean` (optionnel, défaut `true`) dans `EmployeeMentionsRosterEntry` et
   `isValidRosterEntry`. `matchRosterMentions` doit écarter les non-suivis des `mentions` **et** des
   `unknownTokens` : sinon le détecteur LLM ré-attribuerait Henok par l'autre porte.
2. Dry-run, puis `--apply` → nouvelle projection hashée, l'ancienne passe `stale` (jamais de mutation).
   ⚠️ Vérifier que `reviewReplies` est identique : la publication vérifie `projection.sourceHash`
   (`projection_changed`), donc les propositions **en vol** au moment du swap seront refusées et devront
   être re-proposées. Promouvoir hors créneau Hermes (crons 09:45…).

### Lot 2 — Résolution à la réception (cœur)

3. Module pur `src/lib/server/reviews/mention-candidate-resolution-state.ts` :
   `resolveMentionCandidate({ normalizedToken, locationId, roster, rejectList })` →
   `{ status: 'validated', employeeId, displayName }` | `{ status: 'resolved', reason: 'not_tracked', employeeId }` | `{ status: 'candidate', reason: 'unknown_token' | 'wrong_location' | 'inactive' }` | `{ status: 'rejected', reason }`.
   Réutilise `matchRosterMentions` / `normalizeRosterToken`, sans nouvelle logique de match.
   `wrong_location` est distingué : un prénom du roster cité dans un autre salon est une info
   (mutation, renfort), pas un inconnu.
4. `submitAgentMentionCandidates` : après insertion, résoudre chaque ligne avec le roster de la
   projection `current`.
   - `validated` → `status`, `resolution_json = { employeeId, rosterVersion, resolvedBy: 'roster_exact' }`,
     puis **fusion** dans `gmb_reviews.mentioned_employees` (union par `employeeId`, sans écraser une
     mention déjà posée par le détecteur ni un sentiment existant).
   - `candidate` → `upsertFinding` `unknown_employee_mention` via `buildUnknownEmployeeMentionFinding`
     (fingerprint = avis + établissement + version + token : déjà idempotent). C'est l'alerte
     Telegram « orthographe très différente ».
   - La réponse renvoie le statut résolu : Hermes voit immédiatement ce qui a matché.
5. **Dédoublonnage** : index unique partiel `(project_id, review_id, normalized_token)` sur
   `review_mention_candidates` (migration additive `manual-data-012.sql` + `apply-data-012.ts`,
   précédée d'un nettoyage des doublons existants). Sur conflit, renvoyer la ligne existante,
   `idempotent: true`. Sans erreur.
6. **Re-résolution au changement de roster** : fonction `reresolvePendingCandidates(projectId)`
   appelée par le script de promotion après `--apply` (et exposable en job plus tard). Elle repasse
   les `candidate` sur le nouveau roster. C'est ce qui fera passer `Guiseppe`/`Gueppe` en `validated`
   et `Joseph` en `resolved`.

### Lot 3 — Récap et détecteur

7. `buildAgentMonthlyReviewReport` : `unresolvedCandidates` = lignes `candidate` **dédoublonnées par
   (avis, token normalisé)**, avec `locationLabel` et `reason`. On exclut celles dont l'avis porte
   déjà la mention validée correspondante. Ajouter `summary.rejectedMentionCandidates`.
   `contractVersion` passe à 2 : prévenir Hermes (champ ajouté, rien retiré).
8. `detect:employee_mentions` : pour un projet dont les mentions arrivent par Hermes, le détecteur
   LLM devient redondant. Options, à trancher au moment du lot :
   a. le sortir du catalogue quotidien de barberconcept (recommandé : une seule source d'extraction) ;
   b. le garder en filet, mais trier `ORDER BY create_time DESC`, plafonner à `≤ 3` appels par run et
      classer le 429 en `quota` avec refroidissement (sans `dead` immédiat).
   Dans les deux cas, purger les 2 jobs en file.

### Lot 4 — Rattrapage

9. `scripts/gmb-010-backfill-candidates.ts` (dry-run par défaut, `--execute`) : dédoublonne les 24
   lignes, applique la résolution (lot 2), rejette `N2`, fusionne dans `mentioned_employees`.
   Attendu après roster `2026-09-28.1` : 18 couples → **16 `validated`**, **1 `rejected`** (N2),
   **1 `resolved`** (Joseph → Henok, non suivi), **0 `candidate`**.
10. Avis du 26/09 sans mention validée (Wesley, Felipe ×2, Enzo, Brandon ×2, Moha, Giuseppe/Guiseppe)
    : couverts par l'étape 9.

### Lot 5 — Optionnel : roster lisible par Hermes

11. `GET /api/agent/v1/projects/{slug}/roster` (scope `review:read`) : `version`, et par
    établissement la liste `{ displayName, aliases }` des actifs **publiables**. Pas d'id interne,
    pas de `eligibleForBonus`. Hermes peut alors envoyer `rosterVersion` et répondre avec le bon
    prénom. Le Hub reste l'autorité de résolution.

## Vérification

- Tests unitaires du module pur : match exact, alias, accent, casse, mauvais salon, inactif, inconnu,
  rejet, non suivi (tout salon, jamais dans `mentions` ni `unknownTokens`). Idempotence de la soumission (même clé, autre clé, même couple).
- Test de fusion : `mentioned_employees` déjà rempli par le détecteur → union sans doublon.
- `npm test`, `npm run check`.
- Preuve en base après backfill : `select status, count(*) from review_mention_candidates group by 1`
  → 16 `validated` / 1 `rejected` / 1 `resolved` ; le récap de septembre n'a plus aucune candidate
  non résolue.

## En attente de Jonathan

Rien : toutes les candidates existantes sont tranchées (2026-09-28).
