# Plateforme d'ops SEO et présence locale — état des lieux et architecture cible

Document de référence unique. Remplace toute version antérieure.

---

## 0. Objet et mode d'emploi

Ce document sert à deux choses :

1. Décrire l'architecture cible d'une plateforme d'automatisation SEO et de gestion de présence locale (Google Business Profile), conçue pour rester valable de 8 à 50 sites.
2. Servir de grille de comparaison avec le système existant.

**Pour l'agent qui analyse ce document** : la section 1 décrit le système actuel tel qu'il a été rapporté par l'utilisateur — il peut être incomplet ou légèrement inexact, à vérifier contre le code réel. Les sections 3 à 12 décrivent la cible. La section 14 contient la grille d'analyse à remplir. Ne pas proposer de refonte globale : produire un différentiel priorisé.

---

## 1. État des lieux

### Organisation actuelle

Racine unique `noyau/`, contenant :

```
agent-ops/            outillage agent
atelier/
backups/
brand/                marque Jon Labs (infra personnelle)
cerveau/              wiki Obsidian
docs/
invoices/
jonlabs/
onboarding-jonlabs/
projets/              tous les repos GitHub : apps, sites web, autres
seo-stats/            hub SEO : infos clients et personnelles
architecture.md
claude.md
readme.md
```

`projets/` est l'emplacement unique et systématique de tous les repos. Chaque projet contient un dossier `docs/` pour sa documentation, et un `docs/branding/` en markdown portant positionnement, valeurs, persona, offre, identité et tone of voice du client — utilisé pour toute production de contenu.

Une base de données existe déjà, contenant les clients et les données SEO, avec un référentiel canonique et des pointeurs vers l'emplacement des projets.

### Fonctionnement actuel

- Hermes tourne sur le **desktop**, lancé **manuellement chaque lundi**.
- Un cron Vercel assure une partie de la collecte.
- Le pipeline fait appel au LLM sur de nombreuses étapes, y compris des étapes déterministes.

### Périmètre

- 7 à 8 sites, environ 150 pages maximum chacun.
- Mix de sites clients et personnels, traités de façon identique : accès GSC, gestion SEO pendant une durée contractuelle définie.
- Sur certains sites, le repo est accessible en écriture ; sur d'autres, non.

### Objectif de la refonte

Migrer sur VPS avec une architecture solide dès le départ : scalable, évolutive, agnostique au fournisseur d'IA, avec cron jobs, agents et approbation via Telegram là où c'est justifié.

---

## 2. Diagnostic — les neuf écarts

| # | Écart | Conséquence |
|---|---|---|
| G1 | Pas de boucle fermée : rien ne vérifie si le plan précédent a été appliqué, ni s'il a produit un effet | Le système produit des recommandations, pas du monitoring |
| G2 | Pas de déduplication des findings entre cycles | Les mêmes corrections sont reproposées semaine après semaine |
| G3 | Le LLM intervient sur des tâches déterministes | Coût non linéaire, résultats non reproductibles |
| G4 | Exécution sur desktop, déclenchement manuel | Pas de continuité, pas de surveillance quotidienne |
| G5 | État dispersé entre `seo-stats/`, la base et des fichiers | Pas de source de vérité unique, divergences silencieuses |
| G6 | Pas de porte d'approbation formalisée | Le risque n'est pas gradué : tout ou rien |
| G7 | Pas de budget de changements par site | Attribution impossible : on ne saura jamais quelle action a produit quel effet |
| G8 | Le branding n'est pas chargé explicitement | Dépend d'un mécanisme du runner, non typé, non testable |
| G9 | Cadences de livrables non modélisées | Chaque client est un cas particulier dans le code |

G1, G2 et G7 sont liés : ce sont les trois pièces d'un même mécanisme manquant, décrit en section 7.

---

## 3. Les six invariants

Toute décision d'implémentation qui viole l'un de ces points est une décision à revoir.

**I1 — Un site est une ligne de configuration, jamais une ligne de code.**
Ajouter un client ne doit toucher aucun fichier source, aucun cron, aucun profil.

**I2 — Le LLM ne voit jamais de données brutes.**
Il reçoit une shortlist déjà détectée, filtrée et scorée. La détection est du SQL. Cible : environ 5 % du pipeline. Au-delà, un détecteur déterministe manque.

**I3 — La logique métier vit dans un package Python, pas dans le runner.**
Hermes est une coquille d'exécution remplaçable. Rien de ce qui a de la valeur ne vit dans un skill markdown ou une config Hermes.

**I4 — Le LLM est derrière une interface unique et typée.**
Aucun appel dispersé. Entrées et sorties structurées, validées par schéma, jamais de prose libre traversant le pipeline.

**I5 — Rien n'est proposé avant que le précédent ait été mesuré.**
La vérification précède la proposition. Toujours.

**I6 — La config est dans git, l'état est dans Postgres.**
Les deux ne se mélangent jamais. La config est écrite par un humain, a besoin de diff et d'historique. L'état est produit par la machine, a besoin d'être requêté.

---

## 4. Le pipeline générique

```
observation → finding → proposition → gate → approbation → action → mesure
   (code)      (code)      (LLM)      (code)   (humain)     (mixte)  (code)
```

SEO et Google Business Profile sont deux jeux de modules branchés dessus. Tout ce qui sera ajouté ensuite (Ads, contenu, netlinking, veille concurrentielle) y entre aussi.

---

## 5. Où vit quoi

### Arborescence cible du noyau

```
noyau/
  agent-ops/
    registry.yaml           LE fichier global — le bootstrap
    llm.yaml                routage des modèles par tâche
    ops/                    le package Python
      sources/              gsc.py, crawler.py, dataforseo.py, gbp.py
      detect/               cannibalization.py, indexation.py,
                            opportunities.py, internal_links.py, reviews.py
      context/              branding.py
      policy/               gate.py
      deliver/              rendus client et interne
      llm/                  interface unique + prompts/ + fixtures/
      store/                models.py, migrations/
      cli.py
    templates/              ops.yaml, branding/, AGENTS.md
    sites/<slug>/           config des sites sans repo
  atelier/
  backups/
  brand/                    Jon Labs uniquement
  cerveau/                  savoir et pensée — zéro état opérationnel
  docs/
  invoices/
  onboarding-jonlabs/
  projets/
    <slug>/docs/
      ops.yaml
      branding/
      seo/                  rapports générés
  seo-stats/                → à vider (voir section 13)
  architecture.md
```

### Le registre — global, minimal

```yaml
# agent-ops/registry.yaml
sites:
  - slug: acme
    repo: projets/acme-web
    actif: true
  - slug: bistrot-x
    repo: null
    config: agent-ops/sites/bistrot-x/
```

Strict minimum pour savoir où chercher le reste. Il vit avec le code qui le lit.

### La config projet — distribuée, dans le repo du client

```yaml
# projets/acme-web/docs/ops.yaml
slug: acme
client:
  nom: Acme SA
  contacts:
    - { role: principal, email: "...", recoit: [rapport_seo, rapport_gbp] }
contrat:
  debut: 2026-03-01
  fin: 2027-02-28
  actif: true
capacites:
  seo: true
  gbp: true
  auto_apply: false
branding_path: docs/branding/       # surchargeable (cas Jon Labs)
seo:
  gsc_property: "sc-domain:acme.ch"
  budget_changements_hebdo: 3
  seuil_severite_notification: medium
  exclusions: ["/admin/*", "/preview/*"]
gbp:
  location_id: "..."
  auto_reply_min_stars: 4
livrables:
  - { type: rapport_seo,      cadence: hebdo,   destinataire: client,  canal: email }
  - { type: rapport_gbp,      cadence: mensuel, destinataire: client,  canal: email }
  - { type: plan_maintenance, cadence: hebdo,   destinataire: interne, canal: telegram }
```

**Pourquoi distribuée** : ce qui décrit le client vit avec le client. Ça voyage avec le projet, ça survit à la fin du contrat, le diff git dit quand une cadence a changé, et il n'y a pas de fichier monolithe à 50 clients. Ajouter un client = une ligne dans le registre + un dossier `docs/` dans son repo.

**Contrepartie** : `ops sync` charge tous les `ops.yaml` en base au début de chaque cycle. Postgres devient l'index requêtable ; les fichiers restent la source et gagnent toujours en cas de divergence.

Le `slug` est la clé de voûte : tenant Kanban, nom de workspace, préfixe de clé d'idempotence, segment de chemin. Un seul identifiant, immuable, partout.

Schéma validé au chargement (Pydantic). `ops validate --site <slug>` en préflight : un `ops.yaml` invalide fait échouer bruyamment, jamais dégrader silencieusement.

---

## 6. Modèle de données

```
sites            miroir du registre + ops.yaml, rafraîchi par ops sync

gsc_daily        site, date, query, page, clicks, impressions, position
                 upsert sur fenêtre glissante de 5 jours
                 partitionné par mois

crawl_snapshots  site, run_at, url, http_status, title, meta_desc,
                 canonical, noindex, depth, inlinks_count, content_hash

findings         id, site, detected_at, type, severity, payload jsonb,
                 confidence, status, superseded_by
                 status ∈ open|proposed|in_flight|observing|resolved|dismissed

actions          id, finding_id, change_type, affected_urls[], sitewide,
                 reversible, traffic_at_stake, decision, human_verdict,
                 applied_at, commit_sha, observation_until

outcomes         action_id, measured_at, horizon (14|28|56),
                 delta_clicks, delta_impressions, delta_position, verdict

deliveries       site, type, periode, generated_at, sent_at
```

Trois points à ne pas négliger :

- **`gsc_daily` est la table qui grossit.** Dizaines de millions de lignes en un an à 50 sites. Partitionner par mois dès le départ, rollup hebdomadaire query×page au-delà de 90 jours.
- **`content_hash`** permet la vérification déterministe « la page a-t-elle réellement changé », sans LLM.
- **`findings.status` + `superseded_by`** sont la mécanique anti-répétition (G2).

Contrainte externe : GSC a 2 à 3 jours de latence, corrige rétroactivement, et ne conserve que 16 mois. Ne jamais collecter « hier » seul ; refetch une fenêtre glissante.

---

## 7. Le cycle hebdomadaire fermé

C'est la réponse à G1, G2 et G7. Ordre strict, chaque lundi.

### Phase A — Vérification d'application (code, zéro token)

Pour chaque action appliquée sans confirmation :
- le commit existe-t-il dans le repo ?
- le `content_hash` des URLs concernées a-t-il changé ?
- le changement attendu est-il visible dans le crawl ?

Sortie : appliqué / partiel / non appliqué. Une action approuvée mais jamais appliquée est un signal en soi et doit remonter.

### Phase B — Mesure d'effet (code, zéro token)

Comparaison de fenêtre glissante sur les URLs concernées, aux horizons J+14, J+28, J+56.

**Une semaine ne suffit pas en SEO.** L'action reste au statut `observing` jusqu'à son horizon — d'où un statut dédié plutôt qu'un booléen. `inconclusive` est un verdict légitime et fréquent ; ne pas forcer de conclusion.

### Phase C — Détection, avec suppression

Les détecteurs tournent, puis un filtre écarte tout finding dont le sujet fait déjà l'objet d'une action `in_flight` ou `observing`.

Un finding réapparu doit soit être supprimé, soit marquer l'action précédente comme inefficace via `superseded_by` — ce qui est une information précieuse, pas un bug.

### Phase D — Proposition, sous budget

Seulement maintenant, et seulement sur les findings restants.

**Budget : N changements par site et par semaine, N=3 pour commencer.** Sa raison première n'est pas la sécurité mais l'**attribution** : quinze changements la même semaine rendent la phase B ininterprétable. Le budget est ce qui rend la mesure exploitable.

---

## 8. Découpage déterministe / LLM

| Signal | Détection (code, zéro token) | Jugement (LLM) |
|---|---|---|
| Cannibalisation | même query, ≥2 URLs au-dessus d'un seuil d'impressions, position instable | arbitrer l'URL canonique, formuler la correction |
| Indexation | crawl + Index API + delta de couverture | rien, c'est binaire |
| Opportunités | position 8-20 + impressions hautes + CTR sous la courbe attendue | prioriser, estimer l'effort |
| Chute de trafic | delta S-1 avec seuil de significativité | diagnostiquer la cause probable |
| Maillage interne | similarité par embeddings + ancre disponible + score | valider les N meilleures paires |
| Avis GBP | polling API, classification par note | rédiger la réponse |

**Le maillage interne est le seul détecteur qui peut exploser en volume** — chaque page pouvant théoriquement pointer vers toutes les autres. Plafond obligatoire : embeddings recalculés uniquement quand `content_hash` change, score de pertinence, top N par site.

---

## 9. La porte d'approbation

Déterministe, sans exception. C'est la soupape de sécurité : y mettre un LLM, c'est y mettre du non-déterminisme non auditable.

### Ce que le LLM produit

```json
{
  "change_type": "canonical|redirect|noindex|robots|hreflang|title_meta|
                  content_rewrite|internal_link|schema|alt",
  "affected_urls": ["..."],
  "sitewide": false,
  "reversible": true,
  "confidence": 0.82,
  "rationale": "..."
}
```

Extraction structurée, pas décision de politique.

### Ce que le code décide — quatre axes calculables

Rayon d'action (nombre d'URLs + drapeau sitewide) · Réversibilité (un `git revert` suffit-il ?) · Trafic en jeu (impressions 90 jours) · Confiance du diagnostic.

| Cas | Décision |
|---|---|
| title/meta, page sous seuil d'impressions | auto |
| lien interne, alt, schema | auto |
| title/meta, page à fort trafic | notify |
| réécriture de contenu | approve |
| canonique, redirection, noindex, robots, hreflang | **toujours approve** |
| tout changement sitewide | **toujours approve** |
| confiance sous seuil | **toujours approve** |
| budget hebdo dépassé | approve groupé |

Les lignes en gras sont non négociables : ce sont les manières connues de casser un site. Une canonique ou un `noindex` ne se corrige pas d'un `git revert` — la réabsorption par Google prend des semaines.

### Calibration empirique

Ne pas deviner les seuils. Pendant 4 à 6 semaines, **tout part en approbation**, chaque verdict est logué (approuvé tel quel / modifié / rejeté).

Ensuite : approuvé sans modification à 100 % → auto ; souvent modifié → reste en approbation ; souvent rejeté → le détecteur est défaillant, pas la gate.

C'est aussi le seul moyen honnête de savoir si le système mérite d'exister.

### GBP — une gate différente

Rayon d'action et réversibilité ne s'appliquent pas.

| Cas | Décision |
|---|---|
| 4-5 étoiles sans texte | auto |
| 4-5 étoiles avec texte | auto après calibration |
| 1-3 étoiles | **toujours approve** |
| mention de litige, santé, sécurité, ou d'un employé nommé | **toujours humain** |

Deux points non techniques :
- Répondre publiquement au nom d'un client engage sa parole. Sur un avis négatif, il faut un accord contractuel explicite sur qui valide quoi.
- **La latence compte ici**, contrairement au SEO. Un avis sans réponse pendant cinq jours se voit. L'auto sur les avis positifs devient nécessaire tôt, sinon l'humain redevient le goulot.

---

## 10. Livrables et cadences

Réponse à G9.

**Découpler la cadence de collecte de la cadence de livraison.**

Le cycle interne reste hebdomadaire **pour tout le monde**. Un client trimestriel ne signifie pas qu'on analyse une fois par trimestre — cela détruirait la vérification, la mesure et la déduplication. Le SEO ne se pilote pas par à-coups.

La livraison est une couche au-dessus : un job `deliver` quotidien lit les `livrables` de tous les sites, calcule ce qui est dû, et génère depuis la base. Un rapport trimestriel n'est qu'une agrégation de 13 semaines déjà stockées.

Idempotence via la table `deliveries` — sinon un retry envoie deux fois le rapport au client.

Deux destinataires, deux documents différents à partir des mêmes données :
- `interne` → Telegram, brut, technique, avec le jargon
- `client` → email ou PDF, synthétique, sans jargon, dans son tone of voice (seul le second a besoin du `BrandContext`)

### Archivage

Le markdown est **généré depuis la base, jamais relu par le système**.

```
projets/<slug>/docs/seo/
  README.md                 index généré, une ligne par semaine + statut
  2026-W32-rapport.md       factuel : vérifié, mesuré, détecté
  2026-W32-plan.md          propositions + verdict humain une fois tranché
```

Deux fichiers, deux cycles : le rapport est commité en fin de phase D, le plan attend la résolution du verdict. Commit par un compte machine dédié. Le commit est l'horodatage.

Test de cohérence : supprimer `docs/seo/` ne change rien au fonctionnement ; supprimer Postgres perd tout. C'est ce qui dit qui est la source de vérité.

Pour les sites sans repo, l'archive va dans `/srv/reports/<slug>/`. Le code de livraison lit `repo_url` et n'a pas de cas particulier.

---

## 11. Le contexte de marque

Réponse à G8. Objet de première classe, pas un mécanisme du runner.

```python
# ops/context/branding.py
@dataclass
class BrandContext:
    slug: str
    positionnement: str
    valeurs: list[str]
    persona: str
    offre: str
    tone_of_voice: str
    interdits: list[str]        # ce qu'on ne dit jamais
    exemples: list[Exemple]     # réponses validées par le client
    source_hash: str

def load(slug: str) -> BrandContext: ...
```

Chargé depuis `branding_path`, passé explicitement à toute tâche de rédaction — y compris SEO : une réécriture de title qui ignore le positionnement est inutilisable.

Cinq points de production :

1. **`interdits` est le champ qui manque généralement.** Le tone of voice dit ce qu'on veut ; il faut aussi ce qu'on ne fait jamais : pas de geste commercial promis, pas de litige discuté en public, pas de nom d'employé, vouvoiement imposé. C'est ce qui protège le jour où un modèle a un moment de créativité.
2. **Les exemples valent mieux qu'une description.** Deux ou trois réponses validées font plus qu'un paragraphe sur le ton. Et ça se remplit tout seul : chaque réponse approuvée sans modification devient candidate. La boucle de calibration nourrit le contexte de marque.
3. **Ne pas injecter les fichiers bruts.** Charger en structure typée, injecter les champs pertinents à la tâche.
4. **Valider en préflight.** `branding/` absent ou incomplet sur un site avec `gbp: true` → échec bruyant, pas de contenu générique.
5. **`source_hash`** dit sur quelle version de la marque une réponse a été produite, et invalide les fixtures quand le branding change.

Corollaire : le dossier `branding/` devient un **contrat de schéma**. Mêmes noms de fichiers, mêmes sections entre projets, sinon le parsing devient du cas par cas et I1 tombe. Template dans `agent-ops/templates/branding/`, migration des existants.

---

## 12. Agnosticisme IA

Contrainte d'architecture, pas option de configuration.

### Frontière unique

```python
# ops/llm/tasks.py
def adjudicate_cannibalization(f: Finding, brand: BrandContext) -> Adjudication: ...
def draft_review_reply(r: Review, brand: BrandContext) -> ReplyDraft: ...
def classify_change(p: Proposal) -> ChangeClassification: ...
```

Fonctions typées, sortie validée par schéma. Une réponse non conforme est rejetée et retentée, jamais parsée à la main. Le reste du code n'a jamais connaissance d'un fournisseur ni d'un format de message.

### Prompts versionnés

`ops/llm/prompts/*.md`, sous git. Jamais dans un skill Hermes, jamais en base, jamais en variable d'environnement. Un changement de prompt est un commit avec un diff lisible.

### Router configurable

```yaml
# llm.yaml
tasks:
  classify_change:     { provider: ..., model: <petit> }
  adjudicate_cannibal: { provider: ..., model: <gros> }
  draft_review_reply:  { provider: ..., model: <moyen> }
fallbacks: [...]
```

Aucun nom de modèle en dur. Le routage par tâche est le principal levier de coût.

### Fixtures de régression

Jeu figé d'entrées réelles et de sorties attendues, dans le repo. C'est ce qui permet de changer de modèle en une heure au lieu d'une semaine. Sans fixtures, « agnostique » est un vœu pieux : on est de fait verrouillé sur le modèle avec lequel les prompts ont été calibrés.

### CLI complète

```
ops sync
ops collect  --site <slug>
ops crawl    --site <slug>
ops verify   --site <slug> --week <iso>
ops measure  --site <slug>
ops detect   --site <slug> --week <iso>
ops propose  --site <slug> --week <iso>
ops deliver  --date <iso>
ops gbp poll --site <slug>
ops validate --site <slug>
ops dashboard
```

Si chaque commande tourne seule dans un terminal, n'importe quoi peut la déclencher : Hermes, systemd, n8n, GitHub Actions, un webhook. C'est la vraie assurance, et elle coûte une demi-journée.

---

## 13. Orchestration et exécution

### Répartition des rôles

| Couche | Outil | Pourquoi |
|---|---|---|
| Déclenchement mécanique | cron Hermes `no_agent` | zéro token, script pur, stdout livré tel quel |
| Surveillance | cron `no_agent` + `[SILENT]` | ne parle que si quelque chose casse |
| Travail à état | cartes Kanban | durable, reprenable, fil de commentaires |
| Jugement | profils Hermes | contexte du repo, toolsets restreints |
| Approbation | `kanban_block(kind="needs_input")` → Telegram | notification, commentaire, unblock depuis le téléphone |

### Jobs

| Job | Cadence | Mode |
|---|---|---|
| `sync` | avant chaque cycle | no_agent |
| `collect` | quotidien | no_agent, boucle sur tous les sites |
| `crawl` | hebdo, étalé | no_agent |
| `watchdog` | quotidien | no_agent, `[SILENT]` si sain |
| `weekly` (A→D) | lundi | no_agent jusqu'à D, puis `kanban_create` par site |
| `outcome-check` | quotidien | no_agent, traite les horizons échus |
| `deliver` | quotidien | no_agent + LLM pour la synthèse rédigée |
| `gbp-poll` | toutes les 12 h | no_agent, une carte par avis |

**Un seul job par fonction, jamais un par site.** La boucle sur `sites` est interne — c'est I1 appliqué à l'orchestration. Le fan-out se fait sur les cartes Kanban, pas sur les crons.

Clé d'idempotence obligatoire : `seo-<slug>-2026-W32`. Un second appel renvoie la carte existante — indispensable pour un job hebdomadaire qui peut retenter.

Le `watchdog` quotidien couvre ce que l'analyse hebdo ne peut pas : `robots.txt` modifié, `noindex` apparu, 5xx, chute d'indexation. Coût nul, et il évite de découvrir le lundi qu'un site est désindexé depuis mercredi.

### Profils Hermes

| Profil | Toolsets | Rôle |
|---|---|---|
| `seo-analyst` | file, web, kanban | arbitre les findings, produit les propositions |
| `seo-implementer` | file, terminal, kanban | worktree + PR, uniquement si `repo_write` |
| `gbp-writer` | file, kanban | rédige les réponses aux avis |
| `orchestrator` | kanban, gateway, memory | décompose et route, incapable d'exécuter |

Workspace de carte : `dir:/srv/projets/<slug>` pour l'analyste, `worktree` pour l'implémenteur. Tenant = slug.

### Ce qu'on n'utilise pas, et pourquoi

- **n8n** — ajouterait un troisième magasin d'état à côté de Postgres et `kanban.db`. Sa valeur principale (connecteurs OAuth) ne s'applique pas : les sources sont des appels API écrits de toute façon. À reconsidérer seulement si des flux vers des outils tiers non scriptables apparaissent.
- **`delegate_task`** — appel de fonction : ne survit pas à un redémarrage, pas d'intervention humaine possible, trace perdue à la compression. Inadapté à un flux avec approbation.
- **Un watcher de fichier** — inutile : le producteur crée la carte directement.

### Migration desktop → VPS

Ne pas répliquer le desktop. Le VPS a besoin de quatre choses :

1. **Postgres**, migré depuis l'existant
2. **Le package `ops`**, déployé et testé
3. **Les credentials de service** — compte de service GSC, accès GBP, clés de déploiement git. Jamais les identifiants personnels
4. **Un accès git** aux repos où `repo_write` est vrai, clonés à la demande sous `/srv/projets/<slug>`, pas synchronisés en permanence

Le `noyau` complet reste sur le desktop, qui devient l'environnement de développement. Le VPS exécute.

- Profils Hermes dédiés, jamais le profil personnel. Un profil = un `HERMES_HOME` = une mémoire propre. Ne jamais pointer deux processus sur le même home.
- Gateway en service systemd, dispatcher Kanban embarqué.
- Sauvegarde : Postgres quotidien, `kanban.db` et `~/.hermes/` hebdomadaire.

### Le sort de `seo-stats/`

Le hub actuel mélange trois natures de données aux règles de vie opposées :

| Nature | Destination |
|---|---|
| Données brutes accumulées (exports GSC, positions, historiques) | Postgres |
| Info par client (propriété GSC, seuils, cadences, statut contrat) | `ops.yaml` du repo client |
| Savoir SEO personnel (méthodo, benchmarks, veille, playbooks) | `cerveau/` |

**Le hub ne disparaît pas, il change de nature** : de dossier stocké à vue générée. `ops dashboard` calcule l'état de tous les clients depuis le registre et Postgres au moment où on le demande. Toujours à jour, jamais à maintenir.

Règle post-migration : **aucune information par-client ne vit dans `seo-stats/`**, ni dans `cerveau/`. Un Obsidian est fait pour la pensée, pas pour de l'état opérationnel — et c'est un magasin d'état particulièrement traître parce qu'il est agréable à écrire.

Si `seo-stats/` contient des historiques GSC longs, ils ont de la valeur : ce sont les baselines de la mesure d'effet, et GSC ne conserve que 16 mois. Un tri du contenu actuel (donnée / config / savoir) dit en une heure si la migration est triviale ou si elle vaut une semaine.

Cas particulier Jon Labs : `projets/jonlabs/docs/ops.yaml` porte `branding_path: ../../../brand/`. Champ optionnel avec valeur par défaut — aucun cas particulier dans le code.

---

## 14. Plan de migration

L'ordre compte plus que le contenu.

**Étape 0 — Tri de `seo-stats/`.** Avant tout le reste : il détermine ce qui est importable dans Postgres.

**Étape 1 — Socle sans LLM (semaines 1-2).** Registre, `ops.yaml`, collecte, crawl, stockage, détecteurs, watchdog. Livraison : un markdown par site sur Telegram le lundi. Déjà 70 % de la valeur, et découverte des volumes réels de findings avant tout dimensionnement.

**Étape 2 — La boucle fermée (semaine 3).** Phases A et B, toujours sans LLM. Même sans propositions automatiques, savoir ce qui a été appliqué et si ça a marché est plus que ce qui existe aujourd'hui.

**Étape 3 — Arbitrage (semaines 4-5).** Profil `seo-analyst`, couche `ops/llm/`, `BrandContext`, fixtures. Tout part en approbation. Log de chaque verdict.

**Étape 4 — Calibration (semaines 6-10).** Lecture des verdicts, activation progressive de l'auto. Aucune écriture sur un repo pendant cette phase.

**Étape 5 — Implémentation (à partir de la semaine 11).** `seo-implementer`, worktree, PR. Uniquement sur les types de changement à historique propre.

**Étape 6 — GBP.** Même socle, modules et gate spécifiques.

**Prérequis à lancer dès maintenant, en parallèle** : l'accès à l'API Google Business Profile passe par une demande auprès de Google, avec formulaire et délai pouvant se compter en semaines. À vérifier et déclencher avant d'écrire une ligne de GBP.

---

## 15. Points de rupture connus

| Seuil | Ce qui casse | Parade prévue |
|---|---|---|
| ~10 sites | **l'attention humaine** | seuil de sévérité : seuls les plans au-dessus remontent sur Telegram |
| ~15 sites | crawl concurrent, timeouts | étalement horaire, rate limit par domaine |
| ~20 sites | quotas API GSC | backoff, collecte étalée sur la nuit |
| ~25 sites | workers Kanban simultanés | `kanban.max_in_progress: 3` |
| ~30 sites | coût des embeddings maillage | recalcul uniquement sur `content_hash` modifié |
| ~1 an | volume `gsc_daily` | partitionnement mensuel, rollup au-delà de 90 jours |

Le seuil qui arrive en premier est humain. Cinquante plans hebdomadaires à valider, c'est cinquante décisions par semaine : l'architecture scale, l'attention non. Sans filtre de sévérité, les notifications seront coupées au bout de trois semaines et tout le système deviendra inutile.

---

## 16. Grille d'analyse du système existant

À remplir en confrontant ce document au code réel.

### Inventaire

1. Que contient exactement `seo-stats/` ? Classer chaque élément en donnée brute / config par client / savoir personnel.
2. Quel est le schéma réel de la base existante ? Quelles tables correspondent à `gsc_daily`, `crawl_snapshots`, ou à rien de la cible ?
3. Quel historique GSC est déjà stocké, et sur quelle profondeur ? (déterminant : GSC ne conserve que 16 mois)
4. Que fait exactement le cron Vercel ? Est-il remplaçable par `ops collect` ?
5. Quels sites ont un `docs/branding/` complet ? Les schémas sont-ils homogènes entre projets ?

### Écarts par rapport aux invariants

Pour chacun des six invariants (section 3), établir : respecté / partiellement / violé, avec les emplacements précis dans le code.

Attention particulière à I2 et I3 : recenser **tous** les appels LLM du pipeline actuel et classer chacun en « jugement légitime » ou « remplaçable par du déterministe », avec l'estimation de coût associée.

### Écarts fonctionnels

Pour chacun des neuf écarts (section 2) : confirmé / infirmé / partiellement présent, avec preuve dans le code.

### Réutilisable

Qu'est-ce qui, dans l'existant, est déjà conforme à la cible et doit être migré tel quel plutôt que réécrit ? Le référentiel canonique et les pointeurs vers `projets/` sont a priori dans cette catégorie.

### Sortie attendue

Un différentiel priorisé, pas une refonte. Trois listes :

1. **À migrer tel quel** — conforme, ne pas retoucher
2. **À adapter** — bonne idée, mauvais emplacement ou mauvaise forme
3. **À écrire** — n'existe pas

Avec, pour chaque item de la liste 3, le rattachement à l'étape du plan de migration (section 14).
