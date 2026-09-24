# Feature — E18 Système anti-fragile du monitoring hebdomadaire

> Cible : seo-stats cockpit agentique — fermer la boucle quand un run finit après la
> publication, détecter les timeouts récurrents, et resserrer automatiquement la charge d'un
> projet qui rame. SPEC source : `docs/SPEC.md` · Backlog : `docs/BACKLOG.md` E18.
> Déclencheur : rapport du **2026-08-10** resté `partial` alors que wildcat a fini `succeeded`
> à 14:02, une heure après la publication (13:02) — personne n'a jamais revu le rapport.

## Problème (le trou du 10/08)

Le rapport hebdo du lundi est publié à l'échéance (13:02), mais wildcat était encore `running`
sur `collect:url_inspection` (3 échecs : 2× `ProviderTimeout` 30 s + 1× `WorkerDied`, backoff 1 h,
succès à la 4ᵉ tentative à 14:02). Statut du rapport : `partial`, **définitivement** — le tick
appelle `publishWeeklyReport`, qui sur un créneau déjà publié rend `already_published` et
s'arrête. La brique de révision (`reviseWeeklyReport`) existe, est testée, mais **n'est jamais
appelée en production** : seul `publishWeeklyReport` tourne dans le tick.

Le 10/08, ce n'était pas spécifique à wildcat : 4 projets (barbermedia, jonlabs, spinlink,
wildcat) ont eu `ProviderTimeout` ou `WorkerDied` sur `collect:url_inspection`. Le 03/08, seul
cardrank avait eu un `WorkerDied`. → C'est un mauvais jour Google, pas un bug de charge : wildcat
n'avait que **15 URLs** à inspecter.

## Les trois volets

### Volet A — Auto-révision `partial` → `complete` dans le tick (ferme le trou)

**Principe anti-fragile :** le système se corrige seul quand la cause de la fragilité disparaît,
sans intervention humaine et sans bruit.

Dans `publishWeeklyReport`, branche `already_published` : si la révision courante du créneau est
`partial`, recalculer la préparation de CE créneau (même fonction que la publication) ; si le
nouveau statut est `complete` (tous les runs désormais terminaux), déclencher `reviseWeeklyReport`
avec une raison canonique.

**Garde anti-bruit :** ne réviser QUE quand `partial` devient réellement `complete`. Un projet
resté en échec (dead-letter) → statut toujours `partial` → **aucune** révision à l'infini.
Idempotence par la contrainte `(period_slot, revision)` + `already_revised`. SLO préservé : il est
dérivé de la PREMIÈRE publication, pas de la révision. Ne réconcilie que le créneau courant.

Ce que ça aurait donné le 10/08 : le tick de 14h aurait vu `partial` + wildcat `succeeded` et
écrit une révision `complete`.

### Volet B — Détection des timeouts récurrents par projet (alerte)

Sur N semaines (défaut 3), compter par projet les `collect:url_inspection` dont les tentatives
portent `ProviderTimeout` (appel Google > 30 s) ou `WorkerDied` (fonction Vercel tuée). Si un
projet atteint le seuil, produire un **finding** `recurrent_inspection_timeout` (type fermé), avec
la liste des semaines concernées en preuve. → L'incident ne dort plus : il remonte à l'inbox.

### Volet C — Apprentissage : resserrer le lot d'un projet qui timeout souvent

Quand un projet a des timeouts récurrents (volet B), réduire son budget quotidien d'inspection via
l'override par projet (`project_projections.payload.indexing.selection.dailyBudget`). Moins d'URLs
par tentative → chaque tentative passe sous le budget de durée, la charge s'étale. **Anti-fragile à
l'endroit :** au lieu d'augmenter la charge d'un projet qui rame (pro-cyclique), on la réduit pour
que le run finisse dans sa fenêtre. Une fois le projet stable (plus de timeout sur N semaines), le
budget revient progressivement vers le défaut.

## Décisions

- L'auto-révision ne révise que `partial` → `complete`, jamais l'inverse, jamais l'égal.
- Le volet C resserre le **budget quotidien par projet** (`dailyBudget`), borne basse respectée
  (`MIN_INSPECTION_BUDGET = 5`), et remonte vers le défaut quand le projet redevient stable.
- Le resserrement est **DÉRIVÉ à l'exécution, jamais écrit dans `project_projections`** (registre
  possédé par le migrateur neutre, loi n°5) : il est donc automatiquement réversible, sans geste,
  dès que le verdict de récurrence tombe.
- Les timeouts sont classés par le code d'erreur des tentatives (`ProviderTimeout`, `WorkerDied`),
  pas par un label de statut — même source de vérité que `job_attempts`.
- L'alerte (volet B) est produite par le même point de passage que le resserrement (le plan
  d'inspection), pour ne pas doubler la requête des semaines.

## Files

- `src/lib/server/report-publication-state.ts` (+ `.test.ts`) — `decideAutoRevision`, `AUTO_REVISION_REASON`
- `src/lib/server/report-publication.ts` — `maybeAutoRevisePartial`, branché dans `already_published`
- `src/lib/server/anti-fragile-state.ts` (+ `.test.ts`) — détection timeouts + resserrement budget (pures)
- `src/lib/server/anti-fragile.ts` — requêtes `job_attempts`, finding, resserrement appliqué
- `src/lib/server/collectors/index-selection.ts` — resserrement branché dans `planInspectionSelection`
- `src/lib/server/db/schema.ts` — `job_attempts` lu (append-only, source de vérité des timeouts)

## Critères d'acceptation

1. Un rapport `partial` dont tous les runs deviennent terminaux est révisé `complete` au tick
   suivant, automatiquement.
2. Un rapport `partial` dont un projet reste en dead-letter n'est PAS révisé (aucun bruit).
3. Un projet avec N semaines de timeouts produit un finding `recurrent_inspection_timeout`.
4. Le budget d'inspection d'un projet à timeouts récurrents diminue (dérivé à l'exécution) ; il
   remonte quand le projet redevient stable ; jamais sous la borne basse.
5. Tous les nouveaux modules purs sont couverts par vitest ; la suite complète + `npm run check`
   restent verts.
