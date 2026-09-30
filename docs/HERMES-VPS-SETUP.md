# Hermes VPS — mise en service de A à Z (avis Google Barber Concept)

> **But :** chaque jour, sans intervention humaine, tout avis Google 4–5★ de Barber Concept reçoit
> une réponse publiée et vérifiée, et tout avis 1–3★ part en escalade Telegram. Ce document décrit
> tout ce que le VPS doit porter pour y arriver. Référence opérateur (erreurs, rotation, rollback) :
> [`HERMES-VPS-RUNBOOK.md`](HERMES-VPS-RUNBOOK.md) · contrat des payloads :
> [`agent-api-gmb-barberconcept.md`](agent-api-gmb-barberconcept.md).
>
> Rédigé le 2026-09-30 après le diagnostic de la semaine du 24/09 : la collecte du hub a tourné
> tous les jours sans échec, mais le worker Hermes n'a rien publié les 27–28/09, a consacré le
> rattrapage à des avis de 2016, et s'est arrêté avant la fin de la liste le 30/09 — 12 avis 5★
> récents sautés.

## 1. Qui fait quoi

```text
Google Business Profile
   │  (1) GET avis — job collect:gmb_reviews, quotidien 07:00 Europe/Zurich (Vercel, cron tick)
   ▼
SEO Stats (hubseo.jonlabs.ch) ── Neon, schéma seostats
   │  (2) GET /api/agent/v1/.../reviews  → avis + décision du hub
   ▼
Hermes (VPS)
   │  (3) rédige la réponse (LLM)          ← seul travail « intelligent » d'Hermes
   │  (4) POST /proposals                   → le hub persiste et revalide
   │  (5) POST /publish                     → le HUB fait GET Google → PUT → GET Google
   │  (6) GET /reconcile (plus tard)        → confirmation que Google affiche la réponse
   │  (7) POST /mentions                    → barbiers cités (candidats)
   └─ (8) Telegram : 1–3★, blocages, anomalies, rapport de passage
```

Règles de frontière, non négociables :

- Hermes **n'appelle jamais Google** et **n'accède jamais à Neon**. Il n'a ni `DATABASE_URL`, ni
  token OAuth Google, ni `ENCRYPTION_KEY`, ni secret Vercel.
- Hermes **ne collecte pas** les avis : aucun cron de collecte sur le VPS. Le hub n'a qu'un seul
  jeton Google, qu'un second collecteur corromprait (rafraîchissement sans verrou).
- La **décision** de publier appartient au hub (`decision.status`) : Hermes ne recalcule pas la
  policy, il la lit.

## 2. Prérequis côté hub

| # | Élément | État au 2026-09-30 |
|---|---|---|
| P1 | Production `https://hubseo.jonlabs.ch`, branche `main` | ✅ |
| P2 | Collecte `collect:gmb_reviews` quotidienne 07:00 Zurich, 6 fiches | ✅ succès chaque jour du 23 au 30/09 |
| P3 | Projection `current` (voix, interdits, 6 fiches, roster) | ✅ promue le 24/09 |
| P4 | Policy `current` : `guarded_auto`, seuil 4★, kill switch OFF, plafond 20 publications/passage | ✅ |
| P5 | Credential Hermes dans `HERMES_MACHINE_CREDENTIALS_JSON` (Vercel) | ✅ `hermes-barberconcept-2026-09-r2`, expire avant le 24/03/2027 |
| H1 | **Collecte du soir** (19:30 Zurich) — requise seulement pour un passage Hermes à 20:00 | ❌ à ajouter au hub |
| H2 | **Route de contexte de rédaction** (voix, interdits, roster publiable + alias) | ❌ absente : l'API ne donne à Hermes aucun des éléments de la projection |
| H3 | **Filtre `GET /reviews?pending=1&since=…`** | ❌ absent : la liste renvoie les ~3 200 avis, plus récents d'abord |

H1–H3 sont du code hub (SEO Stats), pas du VPS. En attendant, la §6 donne le contournement pour
chacun. Tant que H2 manque, Hermes **ne nomme aucun barbier** dans ses réponses (voir §6.3).

## 3. Credential Hermes

Format du bearer : `<credential-id>.<secret>`. Le hub ne stocke que `sha256(secret)` — **la partie
après le premier point uniquement**, en hexadécimal.

### 3.1 Créer (ou faire tourner) un credential

Sur un poste sûr (jamais dans un log partagé) :

```bash
ID="hermes-barberconcept-$(date +%Y-%m)-r1"
SECRET="$(openssl rand -hex 32)"
HASH="$(printf '%s' "$SECRET" | sha256sum | cut -d' ' -f1)"
echo "Bearer à mettre dans le coffre + sur le VPS : ${ID}.${SECRET}"
echo "Hash pour Vercel : ${HASH}"
```

Ajouter l'entrée au tableau JSON `HERMES_MACHINE_CREDENTIALS_JSON` (Vercel → Production), **en
conservant l'ancienne entrée** pendant la bascule :

```json
{
  "id": "<ID>",
  "tokenHash": "<HASH>",
  "scopes": ["review:read", "review:propose", "review:publish", "review:report:read"],
  "projects": ["barberconcept"],
  "notBefore": "<ISO-8601 maintenant>",
  "expiresAt": "<ISO-8601 dans 6 mois>"
}
```

Redéployer le hub, installer le nouveau bearer sur le VPS (§4), passer les tests (§5), **puis**
poser `revokedAt` sur l'ancienne entrée et redéployer. Un bearer perdu ne se récupère pas : on en
crée un nouveau.

### 3.2 Scopes

| Scope | Sert à |
|---|---|
| `review:read` | `GET /reviews` |
| `review:propose` | `POST /proposals`, `POST /mentions`, clôture mensuelle |
| `review:publish` | `POST /publish`, `GET /reconcile` |
| `review:report:read` | `GET /monthly-reports/{YYYY-MM}` |

## 4. Installation du VPS

### 4.1 Fichier d'environnement

`/etc/hermes/seo-stats.env`, propriétaire = utilisateur du service Hermes, mode `0600` :

```dotenv
SEO_STATS_BASE_URL=https://hubseo.jonlabs.ch
SEO_STATS_BEARER=<credential-id>.<secret>
SEO_STATS_PROJECT_SLUG=barberconcept

TELEGRAM_BOT_TOKEN=<token du bot>
TELEGRAM_CHAT_ID=<id du groupe>
TELEGRAM_THREAD_REVIEWS=20
TELEGRAM_THREAD_ALERTS=22

# Borne basse du traitement quotidien : aucun avis antérieur n'est traité par le daily.
REVIEWS_BASELINE=2026-09-24T00:00:00+02:00
# Profondeur de sécurité du daily (au-delà : rattrapage, cf. §6.8).
REVIEWS_DAILY_LOOKBACK_DAYS=30
```

```bash
sudo install -d -m 700 -o hermes -g hermes /etc/hermes
sudo install -m 600 -o hermes -g hermes /dev/null /etc/hermes/seo-stats.env
sudoedit /etc/hermes/seo-stats.env
```

Contraintes : `SEO_STATS_BASE_URL` sans `/api` ni slash final ; le slug est **exactement**
`barberconcept` et ne vient jamais d'un texte d'avis ; jamais de `set -x` dans un processus qui
charge ce fichier.

### 4.2 Répertoire d'état

Le worker doit se souvenir de ce qu'il a déjà tenté. Ce n'est **pas** un checkpoint de sélection
(la sélection vient du hub, §6.1) : c'est la mémoire des clés d'idempotence et des confirmations en
attente.

```text
/var/lib/hermes/google-reviews/
  effects.jsonl          # 1 ligne par effet : reviewId, snapshot, kind, idempotencyKey, proposalId, state, at
  pending-confirm.json   # proposalIds en write_unknown à relire au prochain passage
  last-run.json          # rapport du dernier passage (compteurs, durée, code de sortie)
```

```bash
sudo install -d -m 700 -o hermes -g hermes /var/lib/hermes/google-reviews
```

### 4.3 Code

Le code des workers (`google_reviews_daily.py`, `google_reviews_backfill.py`) doit vivre dans
`noyau/agent-ops/` (Git), et le VPS le déployer depuis là. Aujourd'hui il n'existe que sur le VPS :
personne d'autre ne peut le lire ni le corriger.

### 4.4 Planification

Un seul passage quotidien suffit. Le déclencher par le scheduler natif d'Hermes, ou à défaut par
un timer systemd (le nom réel de l'unité est à relever sur le VPS) :

```ini
# /etc/systemd/system/hermes-google-reviews.service
[Service]
Type=oneshot
User=hermes
EnvironmentFile=/etc/hermes/seo-stats.env
ExecStart=/opt/hermes/venv/bin/python /opt/hermes/agent-ops/google_reviews_daily.py
TimeoutStartSec=1800

# /etc/systemd/system/hermes-google-reviews.timer
[Timer]
OnCalendar=*-*-* 09:45:00 Europe/Zurich
Persistent=true

[Install]
WantedBy=timers.target
```

Horaire :

| Option | Collecte hub | Passage Hermes | Délai max avant réponse |
|---|---|---|---|
| **Actuelle** | 07:00 | **09:45** | ~27 h (avis posté à 07:01) |
| Soir (cible) | 07:00 **+ 19:30** (H1) | **20:00** | ~24 h, et les avis de la journée sont traités le soir même |

⚠️ Passer Hermes à 20:00 **sans** H1 n'apporte rien : à 20:00 il ne verrait que les avis collectés
le matin.

`TimeoutStartSec=1800` : un passage peut durer (§6.5). Ne jamais laisser le rattrapage (§6.8)
tourner en même temps que le daily.

Crons secondaires déjà configurés : lundi 10:15 et le 1er du mois 10:30 (récap mensuel, §6.8).

## 5. Tests d'installation (sans effet externe)

```bash
set -a; . /etc/hermes/seo-stats.env; set +a
H="Authorization: Bearer ${SEO_STATS_BEARER}"
U="${SEO_STATS_BASE_URL}/api/agent/v1/projects"

curl -s -o /dev/null -w '%{http_code}\n' -H "$H" "$U/barberconcept/reviews?limit=1"   # attendu 200
curl -s -o /dev/null -w '%{http_code}\n' -H "$H" "$U/lecureux/reviews?limit=1"        # attendu 403
curl -s -o /dev/null -w '%{http_code}\n'          "$U/barberconcept/reviews?limit=1"   # attendu 401

curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="$TELEGRAM_CHAT_ID" -d message_thread_id="$TELEGRAM_THREAD_ALERTS" \
  -d text="Hermes : test d'installation OK" -o /dev/null -w '%{http_code}\n'           # attendu 200
```

Un `401`/`403` est une erreur de configuration : corriger, ne pas boucler.

## 6. Le passage quotidien, étape par étape

### 6.1 Sélection — ce qui casse aujourd'hui

**Règle :** traiter **tous** les avis dont `googleCreatedAt >= borne` et dont le hub ne dit pas
`already_replied`, où `borne = max(REVIEWS_BASELINE, maintenant − REVIEWS_DAILY_LOOKBACK_DAYS)`.

```text
cursor = null
todo = []
loop:
  GET {BASE}/api/agent/v1/projects/barberconcept/reviews?limit=100[&cursor=…]
  pour chaque avis de data[] (ordre du hub, plus récent d'abord) :
     si avis.googleCreatedAt < borne       → STOP (liste triée : plus rien de récent après)
     sinon                                  → todo.append(avis)
  si page.hasMore et pas STOP → cursor = page.nextCursor ; recommencer
```

Interdits, qui sont exactement les pannes observées :

- **pas de fenêtre « avis d'hier »** ni de checkpoint « dernier avis vu » : un passage raté (27–28/09)
  ne doit rien faire perdre. Tant qu'un avis est sans réponse et au-dessus de la borne, il revient.
- **ne pas s'arrêter sur un budget** avant d'avoir parcouru la liste : si le temps manque, on
  arrête de **publier**, pas de **lister** — et on le signale (§6.7).
- ne jamais décoder ni fabriquer un `cursor`.

(H3 remplacera cette boucle par `?pending=1&since=<borne>`.)

### 6.2 Aiguillage par décision du hub

| `decision.status` | Action |
|---|---|
| `already_replied` | rien, silencieux |
| `eligible_auto` | §6.3 → §6.4 → §6.5 |
| `requires_human` (1–3★) | Telegram thread avis, **aucune** proposition publiée |
| `sensitive_or_blocked` | Telegram thread avis avec `decision.reasons` |
| `write_unknown` | **uniquement** `GET /reconcile` (§6.5), jamais de nouveau publish |
| `stale_or_unhealthy_location` | ne rien faire ; alerte si la même fiche l'est encore au passage suivant |

Une escalade Telegram porte : établissement, note, date, extrait court (≤ 200 caractères),
`googleReviewUrl` (sinon le lien `/projects/barberconcept/reviews` du hub), décision et raisons.
Clé de déduplication `gmb-review:<reviewId>:<snapshot>:<decision>` : un même avis n'est pas
renvoyé chaque jour — un rappel **unique** à J+3 s'il est toujours sans réponse.

### 6.3 Rédaction (LLM)

Entrées : `text`, `rating`, `location.label`, langue détectée du texte (avant `(Translated by
Google)` s'il y en a un). Règles Barber Concept :

- répondre **dans la langue de l'avis** ; en français, **tutoiement** ;
- 1 à 3 phrases, prénom du client s'il est lisible, un détail de l'avis quand il y en a un ;
- nom du salon sous sa forme publique : Barber Concept Rive / Cornavin / Eaux-Vives / Jonction /
  Lausanne / Sion (ne pas recopier les libellés Google « - Eaux Vives », « Jonction Genève ») ;
- « salon », **jamais** « atelier » ; pas de prix ; pas de tiret long ; pas de superlatifs creux ;
- signature sur une ligne séparée : `L'équipe Barber Concept` (allemand : `Das Team von Barber
  Concept`, espagnol : `El equipo de Barber Concept`) ;
- varier les ouvertures d'un avis à l'autre (pas dix « Merci X ! » d'affilée) ;
- **barbiers** : tant que H2 n'existe pas, ne nommer **personne** (« on transmet au barbier »).
  Quand H2 existera : nommer uniquement un membre `public` du roster, via son nom ou un alias
  validé, jamais les membres `internal` (partis).

Source canonique de ces règles : `projets/barberconcept/docs/business/profile.md` et
`docs/brand/voice.md`. Ce paragraphe en est un résumé opérationnel ; en cas d'écart, le repo fait foi.

### 6.4 Proposer puis publier

Pour chaque avis `eligible_auto`, au plus **20 publications par passage** (plafond policy) :

```text
k1 = effects.get_or_create(reviewId, snapshot, "proposal")      # clé persistée AVANT l'appel
POST /reviews/{reviewId}/proposals
     Idempotency-Key: review-proposal:<uuid k1>
     {"reviewSnapshot": snapshot, "replyText": texte, "language": "fr"}
  → proposalId (réponse held/409 : lire le code, cf. tableau d'erreurs du runbook)

k2 = effects.get_or_create(proposalId, "publish")
POST /proposals/{proposalId}/publish          (corps vide)
     Idempotency-Key: review-publish:<uuid k2>
  → data.state ∈ verified | conflict | write_unknown
```

- timeout sur la proposition : rejouer **la même clé et le même texte** ;
- timeout ou `write_unknown` sur la publication : **ne jamais republier** → `pending-confirm.json` ;
- `409 snapshot_changed` / `policy_changed` / `projection_changed` : relire l'avis, nouvelle
  proposition avec une **nouvelle** clé ;
- `conflict` : Telegram thread alertes (quelqu'un a répondu autrement sur Google).

### 6.5 Confirmation — ne pas bloquer la file

Mesuré du 26 au 30/09 : **toutes** les publications passent d'abord par `write_unknown`. Google
accepte le PUT, puis met une à cinq minutes à afficher la réponse. Attendre chaque confirmation
avis par avis coûte environ une minute par avis, et c'est ce qui épuise un budget d'exécution.

Donc :

1. publier **tous** les avis de la file d'abord, en notant les `write_unknown` ;
2. **ensuite**, une passe de réconciliation : `GET /proposals/{id}/reconcile` pour chacun, en
   respectant `retryAfterSeconds` (fenêtre de 15 min) ;
3. ce qui reste `write_unknown` à la fin est relu au **passage suivant** (GET seulement) ;
4. `retry_eligible` (rien chez Google après 15 min) : relancer `/reconcile` une fois, puis nouvelle
   proposition + nouvelle clé au passage suivant.

### 6.6 Mentions d'équipe

Pour chaque avis 4–5★ où un prénom apparaît : `POST /reviews/{reviewId}/mentions` avec
`Idempotency-Key: review-mentions:<uuid>` et 1 candidat par prénom (`token`, `sentiment`,
`evidence` ≤ 240 car., `confidence`). Hermes ne valide aucune identité : le hub résout contre le
roster. Un prénom inconnu reste candidat — pas d'escalade quotidienne, il sort dans le récap mensuel.

### 6.7 Rapport de fin de passage et auto-contrôle

À la fin, **toujours** un message Telegram (thread alertes si anomalie, sinon thread avis), par
exemple :

```text
Avis Google — passage du 30/09 20:00
lus 13 · publiés 11 (vérifiés 9, confirmation différée 2) · escaladés 1★ 2 · conflits 0
en attente éligibles restants : 0
```

Auto-contrôle obligatoire : relister (§6.1) et compter les `eligible_auto` sans proposition. Si
ce nombre est > 0 **à la fin** d'un passage, c'est une anomalie → thread alertes. C'est ce contrôle
qui aurait signalé le 27/09.

Codes de sortie : `0` rien en suspens · `2` confirmations différées seulement · `1` erreur
(HTTP, auth, conflit). Un passage **absent** (rien dans `last-run.json` depuis 26 h) doit lui aussi
alerter : un heartbeat, pas seulement des erreurs.

### 6.8 Rattrapage historique et récap mensuel

- `google_reviews_backfill.py` (avis antérieurs à la borne) ne tourne **que si** le dernier daily
  a fini avec `en attente éligibles restants : 0`, et jamais en même temps que lui. Du 28 au 29/09,
  il a publié sur des avis de 2016 pendant que 12 avis de la semaine attendaient.
- 1er du mois 10:30 : `GET /monthly-reports/{YYYY-MM}` du mois précédent, envoi du récap, puis
  `POST .../close` (idempotent : même contenu ⇒ même artefact).

## 7. Arrêt d'urgence

1. Hub : kill switch de la policy ou passage en `draft_only` → plus aucune publication possible,
   quelle que soit l'action d'Hermes.
2. VPS : `systemctl disable --now hermes-google-reviews.timer`.
3. Fuite du bearer : `revokedAt` sur l'entrée Vercel + redéploiement (§3.1).

La collecte continue pendant un arrêt ; seules les écritures sont bloquées.

## 8. Recette — le VPS est « fonctionnel de bout en bout » quand

- [ ] tests §5 : `200` / `403` / `401` / Telegram `200` ;
- [ ] un passage complet parcourt la liste jusqu'à la borne (log : dernière date lue < borne) ;
- [ ] 7 jours consécutifs avec `en attente éligibles restants : 0` en fin de passage ;
- [ ] un 1–3★ réel ou de test arrive dans le thread avis, **sans** publication ;
- [ ] une publication `write_unknown` est confirmée par `/reconcile` sans second publish ;
- [ ] passage volontairement sauté un jour → rattrapé intégralement le lendemain ;
- [ ] heartbeat : un passage absent déclenche une alerte ;
- [ ] code des workers versionné dans `agent-ops/` ;
- [ ] date de rotation du bearer dans le calendrier (avant le 24/03/2027).
