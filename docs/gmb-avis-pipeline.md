# Pipeline avis GMB — état, cible, reste à faire

> Écrit le 2026-08-01, après le récap mensuel de `barberconcept` (123 avis de juillet relus à la
> main, 71 réponses publiées à la main). Ce document existe pour que le contexte de cette session
> puisse être jeté sans rien perdre.
>
> Périmètre : la boucle **collecter → répondre → récapituler** sur les fiches Google Business
> Profile. Les tickets d'exécution vivent dans [`BACKLOG.md`](BACKLOG.md) (E08, GMB-001→009).

## Le parc, au 2026-08-01

4 projets sur 9 ont des fiches. **9 fiches en tout.** Le système traite le multi-établissement et
le mono-établissement de la même façon : collecte, ciblage et santé de synchro sont **par fiche**,
jamais par projet.

| Projet | Fiches | Avis reçus sur 30 j |
|---|---|---|
| `barberconcept` | 6 | 121 |
| `physiopommier` | 1 | 1 |
| `bisrepetita` | 1 | 0 |
| `jonlabs` | 1 | 0 |

En volume, c'est Barber Concept ou rien. Toute décision de conception se juge sur lui.

## Ce qui tourne aujourd'hui

```
tick horaire ──► catalogue quotidien 07:00 Europe/Zurich
                   └─ collect:gmb_reviews      (provider gmb)
                        └─ detect:review_pending  (arête obligatoire)
                             └─ findings : review_pending_sla · negative_review
```

- **`collect:gmb_reviews`** : pagination totale, réconciliation `replied_at` (local) vs
  `remote_reply_at` (distant), santé par fiche (`last_sync_*`). Livré par GMB-002.
- **`detect:review_pending`** : produit les findings, plafond réparti par fiche (tour d'équité).
- ⚠️ **`/api/cron/gmb-reviews` n'est PAS planifié.** La collecte passe par la file. Ne pas le
  replanifier : une seule ligne de credential Google, réécrite sans verrou.

## Ce qui ne tourne pas : personne ne répond

**`replyToReview` a un seul appelant dans tout le repo** : `POST /api/projects/[slug]/reviews/reply`,
qui exige une session admin (`locals.user`). Aucun cron, aucun job, aucun scheduler ne l'appelle.

Le hub sait **collecter** et **détecter** ce qui attend. Il ne sait pas **répondre**. C'est la même
fracture que dans le reste du cockpit : la détection tourne, l'exécution n'existe pas.

Conséquence mesurée sur juillet : 85 avis sans réponse au 01.08, dont 72 constitués en une seule
semaine d'inattention. Le rattrapage a demandé un script jetable
(`scripts/reply-reviews-2026-07.ts`).

## La cible

Confirmée avec Jonathan le 2026-08-01, avec **une addition** par rapport à sa formulation :

```
collect:gmb_reviews (quotidien)
  └─ detect:review_pending          ── ce qui attend une réponse
       └─ propose:review_reply       ── l'IA rédige depuis identité + voix + équipe
            └─ GATE                  ── ◄── L'ADDITION
                 ├─ auto-publiable   → publish:review_reply
                 └─ sensible         → /inbox, validation humaine
```

**Pourquoi le gate.** Le process décrit — « le script récupère, l'IA génère depuis les infos de
l'entreprise, et répond » — est juste pour l'écrasante majorité des avis : en juillet, **102 des
110 mentions viennent d'un avis 5★ nommant une seule personne**. Mais pas pour tous.

Le 1★ de Cornavin du 13.07 accusait le salon d'avoir laissé « cinq coupures dans la barbe ». Une
réponse publiée automatiquement là-dessus engage l'enseigne sur un fait qu'elle n'a pas vérifié.
C'est une décision humaine, et c'est exactement ce que couvrent GMB-005 (classification sensible)
et GMB-006 (state machine de policy).

**Où vit le gate.** Dans le hub, pas dans l'agent. Si la décision « cet avis est auto-publiable »
n'est pas une donnée que le hub possède, chaque exécution de l'agent la reprend à zéro, et deux
exécutions concurrentes peuvent répondre deux fois. C'est l'objet de GMB-006.

**Où vit Hermes.** Au niveau `propose:` et `publish:`, comme exécutant. Il n'a pas à porter la
politique : il lit ce que le hub a classé auto-publiable, rédige, envoie, et rend le résultat.

## Reste à faire — côté hub (cron, jobs, schéma)

**1. Débloquer GMB-003 — c'est la clé de voûte.** Marqué `BLOCKED · Dépendances : DATA-002` alors
que **DATA-002 est DONE depuis le 2026-07-21**. Son état est périmé. Il compile identité, voix,
**équipe**, établissement et interdits en projection versionnée et hashée, lisible par un job.
Il débloque à lui seul la chaîne de réponse (GMB-004→007) **et** l'attribution des mentions.

> ⚠️ Sa clause « signaler projection stale ou incomplète » n'est pas cosmétique. Le roster de
> `barberconcept` a été reconstruit depuis les mentions passées, et il dit lui-même qu'« un prénom
> absent ne prouve pas qu'il ne travaille pas ici ». En juillet il manquait **Issam** (4 mentions)
> et **Santos** (4 mentions). Une IA qui répond avec ce roster écrit « on transmet à ton barbier »
> à un client qui a nommé quelqu'un.

**2. GMB-004 → 005 → 006 → 007**, dans cet ordre : génération de brouillons structurés, quality
gate et classification sensible, state machine de policy et envoi différé, envoi avec vérification
distante et anti-doublon.

> ⚠️ GMB-007 n'est pas du luxe. Cette session a montré 11 avis pour lesquels le hub disait
> « répondu » sans que Google le confirme. La cause s'est révélée être leur **suppression** chez
> Google, mais le hub ne pouvait pas distinguer « envoyé et arrivé » de « envoyé dans le vide ».
> C'est la vérification distante qui tranche.

**3. GMB-009 (nouveau) — mentions employés dérivées et automatiques.** Quatre gestes :

- **Dériver l'agrégat.** `employee_mentions` est aujourd'hui un compteur incrémenté avis par avis
  (`incrementMonthlyAggregate`), alors que la vérité par avis existe déjà dans
  `gmb_reviews.mentioned_employees`. Deux copies de la même information peuvent diverger, et
  celle-ci ne peut être que poussée, jamais recalculée — d'où les deux fonctions de décrément qui
  n'existent que pour compenser. Le remplacer par un `GROUP BY` sur la source.
- **`detect:employee_mentions`** au catalogue quotidien, arête obligatoire depuis
  `collect:gmb_reviews`.
- **Rendre l'attribution rejouable.** `persistMentionsForReview` fait
  `if (review.mentionedEmployees && !force) return 'skipped'` : ajouter Issam au roster aujourd'hui
  ne lui rend pas ses 4 mentions de juillet. La garde doit sauter.
- **Un prénom non attribuable produit un finding.** C'est l'échec de juillet en une ligne : 8
  mentions n'appartenaient à personne pendant un mois et rien ne le disait.

> Coût IA quasi nul : le matching sur un roster connu est déterministe, et le sentiment se déduit
> de la note quand un seul nom est cité (102 mentions sur 110 en juillet). Le modèle ne sert que
> sur la queue — les 3 avis négatifs du mois et les 4 avis citant deux personnes. Le client LLM
> existe déjà (`src/lib/server/ai/llm.ts`).

## Reste à faire — côté skills

**`/gmb-review-responder`** — son rôle se réduit à mesure que le hub prend la main.

- Aujourd'hui il porte **deux responsabilités** : rédiger les brouillons **et** extraire les
  mentions d'employés (étape 6b). La seconde part au hub avec GMB-009. Retirer 6b du skill le jour
  où `detect:employee_mentions` tourne, sinon deux écrivains pour une même colonne.
- Il lit le roster depuis `docs/business/profile.md` du repo projet. Une fois GMB-003 livré, la
  projection du hub devient la source, et le markdown sa **projection sortante**, pas l'inverse.
- Il ne publie pas et ne doit pas se mettre à publier : la publication passe par le gate.

**`/publish-hub`** — inchangé, hors de ce périmètre (il pousse du contenu, pas des réponses).

**Récap mensuel** — reste **manuel et déclenché par Jonathan** en fin de mois, c'est un choix
assumé. Deux artefacts, produits le 2026-08-01 pour juillet et réutilisables comme modèles :

- rapport interne → `cerveau/10-Projets/barberconcept/recaps/2026-07-avis-employes.md`
- email client → `cerveau/10-Projets/barberconcept/recaps/2026-07-email-client.md`,
  envoyé par `scripts/send-client-report.ts` (dry-run par défaut, objet et destinataire lus dans le
  markdown)

> ⚠️ Tant que GMB-009 n'est pas livré, **le compteur du hub n'est pas une source pour le récap.**
> En juillet il annonçait 17 mentions pour 9 employés ; la réalité était 110 pour 24. Le récap doit
> repasser par une relecture intégrale des avis du mois.

## Deux dettes ouvertes, portées par Jonathan

Détail et suivi dans `cerveau/10-Projets/barberconcept/barberconcept-human.md`.

- **Le roster de `barberconcept` est incomplet et contredit les données** : Issam et Santos absents ;
  `Oums` placé à Rive alors que 7 mentions de juillet viennent de Sion et 4 `Ouss` de Rive (si
  c'est la même personne, elle est première du mois) ; `Kavind` déclaré parti avec une mention le
  02.07. Rien de tout ça ne se code — ça se demande au client.
- **Seul `factures.jonlabs.ch` est vérifié chez Resend.** Le récap client de juillet est donc parti
  d'un sous-domaine de facturation. Vérifier `jonlabs.ch` débloque aussi le digest client hebdo.
