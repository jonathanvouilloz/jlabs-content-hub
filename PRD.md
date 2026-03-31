# PRD — Jon Labs Content Hub

> **Version:** 1.1
> **Date:** 2026-03-31
> **Auteur:** Jonathan Vouilloz
> **Statut:** Validé

---

## 1. Vision & Contexte

### Problème

Jonathan gère la création de contenu (articles de blog, posts LinkedIn, posts Google My Business) pour 5 à 10 projets clients en parallèle. Aujourd'hui :

- Le contenu est généré via Claude Code avec des skills spécialisés, puis stocké dans un repo GitHub sous forme de fichiers markdown/JSON — sans vue centralisée.
- Il n'y a aucun outil pour visualiser le calendrier éditorial, suivre les statuts de publication, ou partager l'avancement avec les clients.
- Les clients n'ont aucune visibilité sur ce qui est planifié, en cours de rédaction, ou publié.
- La publication reste manuelle (copier-coller vers Webflow, GMB, LinkedIn). Aucune automatisation n'est en place.
- Le `_meta.json` actuel et le système de dossiers `drafts/published/` sont fragiles et ne scalent pas au-delà de 2-3 projets.

### Solution

Un **hub éditorial centralisé** (web app) qui :

1. Stocke tous les contenus et leurs métadonnées dans une base de données
2. Offre un dashboard pour visualiser, filtrer, et gérer le calendrier éditorial
3. Permet aux clients de consulter leur calendrier et laisser des commentaires
4. Expose une API pour recevoir du contenu depuis Claude Code
5. Synchronise le contenu vers GitHub comme backup
6. Prépare le terrain pour des automatisations futures (publication GMB via API, Webflow, LinkedIn via Make.com)

### Utilisateurs cibles

**Utilisateur principal — Jonathan (admin)**
- Crée du contenu depuis Claude Code, le pousse vers le hub via API
- Consulte le dashboard pour voir l'état de tous les projets
- Change les statuts (draft → ready → published)
- Gère les projets et les accès clients

**Utilisateur secondaire — Client (viewer)**
- Accède à son projet via un lien partagé
- Voit le calendrier éditorial : ce qui est planifié, en attente de validation, publié
- Peut lire le contenu des articles/posts
- Peut laisser des commentaires sur un contenu

### Succès

**MVP (mois 1) :**
- Tous les contenus de Barber Concept et Physio Pommier sont dans le hub
- Jonathan utilise le dashboard quotidiennement au lieu du repo GitHub
- L'API reçoit du contenu depuis Claude Code sans friction
- Au moins 1 client a accès à son calendrier

**V1.1 (mois 2-3) :**
- Publication automatique des posts GMB via l'API Google My Business
- 5+ projets actifs dans le hub
- Workflow Claude Code → API Hub est le standard pour tous les nouveaux contenus

---

## 2. Scope

### ✅ IN — MVP

- [ ] **Auth admin** : login Jonathan (email/password ou magic link)
- [ ] **Gestion de projets** : CRUD projets (nom, slug, description, couleur, logo optionnel)
- [ ] **Types de contenu** : articles de blog, posts LinkedIn, posts GMB — extensible (newsletters, etc.)
- [ ] **Stockage de contenu** : titre, body (markdown pour articles, texte pour LinkedIn, JSON pour GMB), métadonnées
- [ ] **Statuts** : draft → review → approved → published (workflow configurable par projet)
- [ ] **Calendrier éditorial** : vue calendrier + vue liste, filtrable par projet et type de contenu
- [ ] **API d'ingestion** : `POST /api/content` pour recevoir du contenu depuis Claude Code (auth par API key)
- [ ] **Sync GitHub** : push automatique vers le repo `jlabs-content-hub` après chaque création/modification (backup)
- [ ] **Accès client** : lien partageable par projet avec token, lecture seule + commentaires
- [ ] **Commentaires** : un client peut commenter un contenu spécifique (texte simple, pas de threads)
- [ ] **Dashboard** : vue d'ensemble de tous les projets avec compteurs par statut
- [ ] **Détail contenu** : vue lecture d'un article/post avec rendu markdown, frontmatter parsé, et métadonnées

### ❌ OUT — Ce qu'on ne fait PAS (MVP)

- Éditeur de contenu intégré (la création reste dans Claude Code)
- Publication automatique vers Webflow, LinkedIn, ou GMB
- Multi-utilisateurs admin (Jonathan est le seul admin)
- Notifications (email, push, Slack)
- Analytics de performance des contenus publiés
- Drag & drop pour réorganiser le calendrier
- Historique de versions du contenu
- Commentaires avec threads/réponses

### 🔮 LATER — V2+

- **Publication GMB automatique** : bouton "Publier" dans le dashboard → appel API Google My Business
- **Publication Webflow** : connexion via API Webflow ou MCP pour publier les articles directement
- **Publication LinkedIn** : via Make.com webhook ou API LinkedIn directe
- **Notifications** : email au client quand un nouveau contenu est prêt pour review
- **Multi-admin** : plusieurs collaborateurs Jon Labs avec rôles
- **Templates de contenu** : pré-remplir la structure pour chaque type de contenu
- **Historique de versions** : garder un diff de chaque modification
- **Dashboard client enrichi** : stats de publication, performance SEO basique
- **Produit SaaS** : potentielle commercialisation auprès d'autres freelances/agences (à valider)

---

## 3. User Stories & Flows

### Story 1: Pousser du contenu depuis Claude Code

**En tant que** Jonathan (admin)
**Je veux** envoyer un article/post depuis Claude Code vers le hub
**Afin de** centraliser tout mon contenu sans quitter mon workflow de création

**Flow détaillé:**
1. Jonathan utilise un skill Claude Code (seo-blog-writer, social-posts-generator, etc.)
2. Le skill génère le contenu (markdown pour article, texte pour LinkedIn, JSON pour GMB)
3. Le skill appelle `POST /api/content` avec le payload :
   ```json
   {
     "project_slug": "barberconcept",
     "type": "article",
     "title": "Entretien barbe courte : le guide complet",
     "body": "--- frontmatter + markdown content ---",
     "planned_date": "2026-04-15",
     "tags": ["barbe", "entretien"],
     "meta": {
       "seo_description": "...",
       "author": "Jonathan Vouilloz",
       "category": "Soins barbe"
     }
   }
   ```
4. Le hub valide le payload, crée l'entrée en DB avec status `draft`
5. Le hub pousse le fichier vers GitHub (`jlabs-content-hub/{project}/{type}/{slug}.md`) en background
6. L'API retourne `201 Created` avec l'ID du contenu

**Critères d'acceptation:**
- [ ] L'API accepte les 3 types de contenu (article, linkedin, gmb) + un type `other` extensible
- [ ] Le contenu est persisté en DB avec toutes les métadonnées
- [ ] Le contenu est pushé vers GitHub dans la bonne arborescence
- [ ] Un API key valide est requis (header `Authorization: Bearer {key}`)
- [ ] Le payload est validé (champs requis, types corrects)

**Edge cases:**
- Si le projet n'existe pas → `404 Project not found`
- Si le type n'est pas supporté → `400 Invalid content type`
- Si le GitHub push échoue → le contenu est quand même sauvé en DB, un flag `github_synced: false` est posé, retry possible
- Si un contenu avec le même slug existe déjà dans le projet → `409 Conflict` avec option `?upsert=true` pour écraser

---

### Story 2: Visualiser le calendrier éditorial

**En tant que** Jonathan (admin)
**Je veux** voir tous les contenus planifiés sur un calendrier
**Afin de** avoir une vue d'ensemble de ce qui est prévu, en cours, et publié

**Flow détaillé:**
1. Jonathan se connecte au dashboard
2. Il arrive sur la vue "Tous les projets" avec un résumé : nombre de contenus par statut
3. Il peut filtrer par : projet, type de contenu, statut, période
4. Il switch entre vue calendrier (mensuelle) et vue liste
5. Vue calendrier : chaque jour affiche les contenus planifiés à cette date, colorés par projet
6. Vue liste : tableau avec colonnes triables (titre, projet, type, statut, date planifiée, date de publication)
7. Clic sur un contenu → vue détail avec rendu du contenu + métadonnées + commentaires

**Critères d'acceptation:**
- [ ] Vue calendrier mensuelle avec navigation mois par mois
- [ ] Vue liste avec tri et filtres
- [ ] Filtres persistants dans l'URL (query params)
- [ ] Code couleur par projet (configurable)
- [ ] Indicateur visuel du statut (badge coloré)
- [ ] Compteurs en temps réel dans le dashboard

**Edge cases:**
- Si aucun contenu pour un mois → afficher un état vide avec message
- Si un contenu n'a pas de `planned_date` → il apparaît dans un bloc "Non planifié"

---

### Story 3: Changer le statut d'un contenu

**En tant que** Jonathan (admin)
**Je veux** changer le statut d'un contenu (draft → review → approved → published)
**Afin de** tracker la progression du contenu dans le pipeline éditorial

**Flow détaillé:**
1. Jonathan ouvre un contenu dans le dashboard
2. Il voit le statut actuel avec un indicateur visuel
3. Il clique sur le prochain statut (bouton ou dropdown)
4. Si passage à `published` : un champ `published_at` est automatiquement rempli avec la date du jour
5. Le changement est sauvé en DB
6. Le frontmatter du fichier GitHub est mis à jour en background (sync)
7. Si le contenu a des commentaires non résolus et qu'on passe à `approved` → warning (pas bloquant)

**Critères d'acceptation:**
- [ ] Workflow de statuts : `draft` → `review` → `approved` → `published`
- [ ] Possibilité de revenir en arrière (published → draft si erreur)
- [ ] Timestamp automatique sur `published_at`
- [ ] Sync GitHub en background après changement
- [ ] Historique des changements de statut (qui, quand, de quel statut vers quel statut)

**Edge cases:**
- Si le GitHub sync échoue → le statut reste changé en DB, flag `github_synced: false`
- Si on passe à `published` sans `planned_date` → la `planned_date` prend la date du jour

---

### Story 4: Accès client au calendrier

**En tant que** client (viewer)
**Je veux** voir le calendrier éditorial de mon projet
**Afin de** savoir ce qui est prévu, validé et publié pour mon entreprise

**Flow détaillé:**
1. Jonathan génère un lien d'accès pour le client : `hub.jonlabs.ch/view/{project_slug}?token={access_token}`
2. Le client ouvre le lien — pas de login nécessaire, le token suffit
3. Le client voit : calendrier éditorial de SON projet uniquement
4. Il peut lire le contenu de chaque article/post
5. Il peut laisser un commentaire sur un contenu spécifique
6. Les commentaires apparaissent côté admin dans la vue détail du contenu

**Critères d'acceptation:**
- [ ] Lien avec token unique par projet (générable/révocable depuis l'admin)
- [ ] Le client ne voit que son projet
- [ ] Le client peut lire tous les contenus (quel que soit le statut, sauf `draft` — configurable)
- [ ] Le client peut commenter (nom/email requis au premier commentaire, stocké en cookie/localStorage pour les suivants)
- [ ] Le design est propre et brandé Jon Labs (pas l'impression d'un outil interne)

**Edge cases:**
- Si le token est invalide/expiré → page 404 générique
- Si le client essaie d'accéder à un autre projet → 404
- Si le token est révoqué → accès coupé immédiatement

---

### Story 5: Commenter un contenu (client)

**En tant que** client (viewer)
**Je veux** laisser un feedback sur un contenu
**Afin de** communiquer mes retours sans passer par un email séparé

**Flow détaillé:**
1. Le client ouvre un contenu dans la vue projet
2. Il voit une section "Commentaires" en bas
3. Au premier commentaire : il saisit son nom et email (stocké pour les suivants)
4. Il écrit son commentaire et soumet
5. Le commentaire apparaît immédiatement dans la liste
6. Côté admin, le contenu affiche un badge "X commentaires"

**Critères d'acceptation:**
- [ ] Commentaire = texte libre (pas de markdown, pas de pièces jointes)
- [ ] Nom + email requis (stocké en localStorage après premier commentaire)
- [ ] Horodatage affiché
- [ ] L'admin voit tous les commentaires dans la vue détail
- [ ] L'admin peut supprimer un commentaire

**Edge cases:**
- Si commentaire vide → bouton désactivé
- Si localStorage indisponible → redemander nom/email à chaque fois

---

### Story 6: Créer et gérer un projet

**En tant que** Jonathan (admin)
**Je veux** créer un nouveau projet client
**Afin de** commencer à y pousser du contenu

**Flow détaillé:**
1. Jonathan va dans "Projets" → "Nouveau projet"
2. Il remplit : nom, slug (auto-généré, éditable), description optionnelle, couleur du projet
3. Le projet est créé en DB
4. Le dossier correspondant est créé sur GitHub (`jlabs-content-hub/{slug}/`)
5. Un token d'accès client est auto-généré (partageable plus tard)
6. Le projet apparaît dans les filtres du dashboard

**Critères d'acceptation:**
- [ ] Slug unique, auto-généré depuis le nom, éditable
- [ ] Couleur assignée (palette prédéfinie ou color picker)
- [ ] Token d'accès client généré automatiquement
- [ ] Le projet apparaît immédiatement dans le dashboard
- [ ] Possibilité d'archiver un projet (pas de suppression)

**Edge cases:**
- Si le slug existe déjà → message d'erreur, proposer une alternative
- Si le dossier GitHub existe déjà → le réutiliser sans erreur

---

## 4. Data Model

### Entités principales

```
┌──────────────┐       ┌──────────────────┐       ┌──────────────────┐
│   projects   │       │     contents     │       │    comments      │
├──────────────┤       ├──────────────────┤       ├──────────────────┤
│ id           │──────<│ id               │──────<│ id               │
│ name         │       │ project_id (FK)  │       │ content_id (FK)  │
│ slug         │       │ type             │       │ author_name      │
│ description  │       │ title            │       │ author_email     │
│ color        │       │ slug             │       │ body             │
│ access_token │       │ body             │       │ created_at       │
│ archived     │       │ status           │       └──────────────────┘
│ created_at   │       │ planned_date     │
│ updated_at   │       │ published_at     │
└──────────────┘       │ tags             │
                       │ meta (JSON)      │
                       │ github_synced    │
                       │ github_path      │
                       │ created_at       │
                       │ updated_at       │
                       └──────────────────┘

┌──────────────────────┐       ┌──────────────────┐
│   content_types      │       │  status_history   │
├──────────────────────┤       ├──────────────────┤
│ id                   │       │ id               │
│ slug                 │       │ content_id (FK)  │
│ label                │       │ from_status      │
│ icon                 │       │ to_status        │
│ default_statuses     │       │ changed_at       │
│ created_at           │       │ changed_by       │
└──────────────────────┘       └──────────────────┘
```

### Détail des tables

#### projects
| Champ | Type | Contraintes | Description |
|-------|------|-------------|-------------|
| id | text | PK, cuid | Identifiant unique |
| name | text | not null | Nom du projet (ex: "Barber Concept") |
| slug | text | unique, not null | Slug URL (ex: "barberconcept") |
| description | text | nullable | Description courte du projet |
| color | text | not null, default "#00D9A3" | Couleur hex pour le dashboard |
| access_token | text | unique, not null | Token d'accès client |
| archived | boolean | default false | Projet archivé ou actif |
| created_at | timestamp | default now() | Date de création |
| updated_at | timestamp | default now() | Dernière modification |

#### contents
| Champ | Type | Contraintes | Description |
|-------|------|-------------|-------------|
| id | text | PK, cuid | Identifiant unique |
| project_id | text | FK → projects.id, not null | Projet parent |
| type | text | not null | Type de contenu (article, linkedin, gmb, newsletter, other) |
| title | text | not null | Titre du contenu |
| slug | text | not null | Slug unique dans le projet+type |
| body | text | not null | Contenu complet (markdown, texte, ou JSON stringifié) |
| status | text | not null, default "draft" | Statut actuel (draft, review, approved, published) |
| planned_date | date | nullable | Date de publication planifiée |
| published_at | timestamp | nullable | Date de publication effective |
| tags | text | nullable | Tags JSON array stringifié |
| meta | text | nullable | Métadonnées additionnelles (JSON) — author, seo_description, category, image, schema, etc. |
| github_synced | boolean | default false | Synchronisé avec GitHub |
| github_path | text | nullable | Chemin dans le repo GitHub |
| created_at | timestamp | default now() | Date de création |
| updated_at | timestamp | default now() | Dernière modification |

**Contrainte unique :** `(project_id, type, slug)`

#### comments
| Champ | Type | Contraintes | Description |
|-------|------|-------------|-------------|
| id | text | PK, cuid | Identifiant unique |
| content_id | text | FK → contents.id, not null | Contenu commenté |
| author_name | text | not null | Nom du commentateur |
| author_email | text | not null | Email du commentateur |
| body | text | not null | Texte du commentaire |
| created_at | timestamp | default now() | Date du commentaire |

#### content_types
| Champ | Type | Contraintes | Description |
|-------|------|-------------|-------------|
| id | text | PK, cuid | Identifiant unique |
| slug | text | unique, not null | Identifiant technique (article, linkedin, gmb) |
| label | text | not null | Label affiché ("Article de blog", "Post LinkedIn", "Post GMB") |
| icon | text | nullable | Nom d'icône (lucide-react ou autre) |
| created_at | timestamp | default now() | Date de création |

**Seed data :**
- `{ slug: "article", label: "Article de blog", icon: "file-text" }`
- `{ slug: "linkedin", label: "Post LinkedIn", icon: "linkedin" }`
- `{ slug: "gmb", label: "Post Google My Business", icon: "map-pin" }`

#### status_history
| Champ | Type | Contraintes | Description |
|-------|------|-------------|-------------|
| id | text | PK, cuid | Identifiant unique |
| content_id | text | FK → contents.id, not null | Contenu concerné |
| from_status | text | nullable | Statut précédent (null si création) |
| to_status | text | not null | Nouveau statut |
| changed_by | text | not null, default "admin" | Qui a changé (admin ou system) |
| changed_at | timestamp | default now() | Date du changement |

### Relations
- Un project a plusieurs contents (1:N)
- Un content a plusieurs comments (1:N)
- Un content a plusieurs status_history (1:N)
- Les content_types sont une table de référence (pas de FK stricte, pour flexibilité)

---

## 5. Stack Technique

### Stack choisie

| Couche | Choix | Justification |
|--------|-------|---------------|
| Framework | SvelteKit | Stack habituel Jon Labs, SSR + API routes |
| Database | Turso (libSQL) | Léger, edge-compatible, gratuit pour ce volume, déjà maîtrisé |
| ORM | Drizzle | Type-safe, léger, bonne intégration Turso |
| Auth | Better Auth | Déjà utilisé sur d'autres projets, magic link + email/password |
| Hosting | Vercel | Déploiement auto, edge functions, domaine custom |
| UI Components | Skeleton UI | Composants Svelte natifs, design system complet, thème customisable |
| Styling | Tailwind CSS v4 | Productivité, utilisé par Skeleton UI |
| GitHub sync | Octokit (REST API) | SDK officiel GitHub, bien typé |

### Dépendances clés

```json
{
  "dependencies": {
    "@sveltejs/kit": "latest",
    "@libsql/client": "latest",
    "drizzle-orm": "latest",
    "better-auth": "latest",
    "octokit": "latest",
    "marked": "latest",
    "gray-matter": "latest",
    "@skeletonlabs/skeleton": "latest",
    "@skeletonlabs/tw-plugin": "latest",
    "tailwindcss": "^4",
    "@tailwindcss/typography": "latest"
  },
  "devDependencies": {
    "drizzle-kit": "latest"
  }
}
```

Notes :
- `gray-matter` : parser le frontmatter YAML des articles reçus via l'API
- `marked` : rendu markdown → HTML pour l'affichage des articles
- `@tailwindcss/typography` : prose styling pour le rendu des articles

---

## 6. Règles & Conventions

### Structure du projet

```
src/
├── lib/
│   ├── components/
│   │   ├── ui/              # Composants UI génériques (Button, Badge, Card, Modal)
│   │   ├── calendar/        # Composants calendrier
│   │   ├── content/         # Composants liés au contenu (ContentCard, ContentDetail, StatusBadge)
│   │   └── layout/          # Header, Sidebar, Layout shells
│   ├── server/
│   │   ├── db/
│   │   │   ├── index.ts     # Client Turso
│   │   │   ├── schema.ts    # Schéma Drizzle
│   │   │   └── seed.ts      # Seed content_types
│   │   ├── github.ts        # Service GitHub (sync, push, pull)
│   │   └── auth.ts          # Config Better Auth
│   └── utils/
│       ├── content.ts       # Helpers contenu (parse frontmatter, render markdown)
│       ├── dates.ts         # Formatage dates
│       └── slugify.ts       # Génération de slugs
├── routes/
│   ├── (app)/               # Routes admin (authentifiées)
│   │   ├── +layout.svelte   # Layout admin avec sidebar
│   │   ├── +page.svelte     # Dashboard principal
│   │   ├── projects/
│   │   │   ├── +page.svelte         # Liste des projets
│   │   │   ├── new/+page.svelte     # Créer un projet
│   │   │   └── [slug]/+page.svelte  # Détail projet + contenus
│   │   ├── calendar/
│   │   │   └── +page.svelte         # Vue calendrier global
│   │   └── content/
│   │       └── [id]/+page.svelte    # Détail contenu + commentaires
│   ├── (auth)/              # Routes auth
│   │   ├── login/+page.svelte
│   │   └── +layout.svelte
│   ├── view/                # Routes client (publiques avec token)
│   │   └── [project_slug]/
│   │       ├── +page.svelte         # Calendrier client
│   │       └── [content_id]/+page.svelte  # Détail contenu client
│   └── api/
│       ├── content/
│       │   ├── +server.ts           # POST (création) + GET (liste)
│       │   └── [id]/
│       │       ├── +server.ts       # PUT (update) + DELETE
│       │       └── status/+server.ts  # PATCH (changement statut)
│       ├── projects/
│       │   └── +server.ts           # CRUD projets
│       ├── comments/
│       │   └── +server.ts           # POST commentaire
│       └── auth/
│           └── [...all]/+server.ts  # Better Auth catch-all
└── app.d.ts
```

### Conventions de code

**Nommage :**
- Composants : PascalCase (`ContentCard.svelte`)
- Fichiers utilitaires : camelCase (`formatDate.ts`)
- Routes : kebab-case (`/project-settings`)
- Variables/fonctions : camelCase
- Constantes : SCREAMING_SNAKE_CASE
- Types/Interfaces : PascalCase

**Patterns obligatoires :**
- Toujours typer les fonctions (paramètres + retour)
- Séparer la logique métier des composants UI
- Un composant = une responsabilité
- Error handling explicite (Result pattern)
- Validation des inputs côté serveur ET client

**À éviter :**
- `any` en TypeScript
- Logique métier dans les composants
- Requêtes DB dans les composants (passer par server load functions)
- Console.log en production
- Secrets en dur dans le code

### Gestion des erreurs

```typescript
type Result<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// API responses
type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };
```

---

## 7. UI/UX Guidelines

### Style général

Minimaliste et fonctionnel. C'est un outil de travail, pas un produit consumer. Inspirations : Linear (layout), Notion (calendrier), Plausible (dashboard).

Design propre avec les couleurs Jon Labs comme accents. Le dashboard client doit être suffisamment soigné pour faire pro face au client.

### Librairie UI

**Skeleton UI** — design system complet pour Svelte/SvelteKit. Composants natifs Svelte, thème customisable via Tailwind, support dark mode out of the box.

Composants Skeleton UI utilisés :
- `AppShell` : layout principal (sidebar + header + contenu)
- `AppBar` : header avec navigation
- `AppRail` : sidebar de navigation
- `Table` : vue liste des contenus
- `TabGroup` : switch entre vues (calendrier/liste)
- `Autocomplete` : filtres projet/type
- `Avatar` : initiales projet/client
- `Badge` : statuts, tags
- `Modal` : confirmation actions, détail rapide
- `Toast` : notifications de succès/erreur
- `ProgressBar` / `ProgressRadial` : indicateurs de progression

Thème Skeleton custom avec les couleurs Jon Labs (voir section couleurs).

### Couleurs

- Background : `#FAFAFA` (light) / `#0A0A0A` (dark — optionnel, pas MVP)
- Surface : `#FFFFFF`
- Border : `#E5E5E5`
- Text primary : `#141413`
- Text secondary : `#737373`
- Accent Jon Labs : `#00D9A3` (turquoise) → primary Skeleton theme
- Accent secondaire : `#A300D9` (magenta) → secondary Skeleton theme
- Status draft : `#737373` (gris)
- Status review : `#F59E0B` (amber)
- Status approved : `#3B82F6` (bleu)
- Status published : `#10B981` (vert)

### Composants clés

| Composant | Description | Comportement |
|-----------|-------------|--------------|
| StatusBadge | Badge coloré selon le statut | Cliquable pour changer le statut (admin) |
| ContentCard | Card résumant un contenu | Titre, projet, type, statut, date, compteur commentaires |
| CalendarDay | Cellule du calendrier | Affiche les contenus du jour, colorés par projet |
| ProjectPill | Pill avec couleur du projet | Utilisé dans les filtres et les cards |
| CommentBox | Zone de commentaire | Input + liste des commentaires existants |

### Responsive

- Desktop-first (c'est un outil de travail, utilisé principalement sur desktop)
- Responsive mobile pour la vue client (le client peut consulter depuis son téléphone)
- Breakpoints : sm (640px), md (768px), lg (1024px)

---

## 8. API & Intégrations

### Endpoints internes

#### Contenu

| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| POST | `/api/content` | Créer un contenu | API key |
| GET | `/api/content` | Lister les contenus (filtres: project, type, status, date range) | Admin |
| GET | `/api/content/[id]` | Détail d'un contenu | Admin ou client token |
| PUT | `/api/content/[id]` | Mettre à jour un contenu | API key ou Admin |
| PATCH | `/api/content/[id]/status` | Changer le statut | Admin |
| DELETE | `/api/content/[id]` | Supprimer un contenu | Admin |

#### Projets

| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| POST | `/api/projects` | Créer un projet | Admin |
| GET | `/api/projects` | Lister les projets | Admin |
| PUT | `/api/projects/[slug]` | Modifier un projet | Admin |
| POST | `/api/projects/[slug]/token` | Régénérer le token client | Admin |

#### Commentaires

| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| POST | `/api/comments` | Ajouter un commentaire | Client token |
| DELETE | `/api/comments/[id]` | Supprimer un commentaire | Admin |

### Auth API

Deux mécanismes d'authentification :

1. **API Key** (pour Claude Code → Hub) : header `Authorization: Bearer {API_KEY}`. Clé stockée en variable d'environnement côté serveur. Une seule clé globale pour le MVP.

2. **Client Token** (pour accès client) : query param `?token={access_token}`. Token unique par projet, stocké en DB.

3. **Session admin** (pour le dashboard) : Better Auth, cookie de session classique.

### Intégrations externes

| Service | Usage | Credentials | Priorité |
|---------|-------|-------------|----------|
| GitHub API | Sync backup des contenus | Personal Access Token (PAT) | MVP |
| Google My Business API | Publication automatique des posts GMB | OAuth2 (déjà configuré) | V2 |
| Webflow API / MCP | Publication automatique des articles | API Token | V2 |
| Make.com | Orchestration publication LinkedIn | Webhook URL | V2 |

### Payload API — Exemples par type

#### Article de blog

```json
{
  "project_slug": "physiopommier",
  "type": "article",
  "title": "Arthrose et exercice : pourquoi bouger soulage vos douleurs",
  "slug": "arthrose-exercice-soulager-douleurs",
  "body": "---\ntitle: \"Arthrose et exercice...\"\npubDate: 2026-03-28\n---\n\n# Arthrose et exercice...\n\nContenu markdown complet...",
  "planned_date": "2026-03-28",
  "tags": ["arthrose", "exercice", "seniors"],
  "meta": {
    "author": "Virginie Donnet",
    "category": "Santé des seniors",
    "seo_description": "L'exercice réduit les douleurs arthrosiques de 25 à 30 %...",
    "image": {
      "src": "/blog/arthrose-exercice-soulager-douleurs/cover.jpg",
      "alt": "Personne souffrant d'arthrose..."
    },
    "schema": "{ ... JSON-LD ... }"
  }
}
```

#### Post LinkedIn

```json
{
  "project_slug": "barberconcept",
  "type": "linkedin",
  "title": "Hook du post LinkedIn",
  "slug": "2026-04-01-hook-barbe",
  "body": "Texte complet du post LinkedIn...",
  "planned_date": "2026-04-01",
  "tags": ["barbe", "tendances"],
  "meta": {
    "hook": "Première ligne du post",
    "cta": "Lien en commentaire",
    "image_prompt": "..."
  }
}
```

#### Post GMB

```json
{
  "project_slug": "barberconcept",
  "type": "gmb",
  "title": "Ref interne — Huile vs baume expert tip",
  "slug": "2026-03-30-huile-baume",
  "body": "{\"content\": \"Huile ou baume à barbe ?...\", \"type\": \"whats_new\", \"scheduled_at\": \"2026-03-30T08:30:00+02:00\", \"cta\": {\"action\": \"LEARN_MORE\", \"url\": \"...\"}}",
  "planned_date": "2026-03-30",
  "tags": ["gmb", "barbe"],
  "meta": {
    "gmb_type": "whats_new",
    "cta_action": "LEARN_MORE",
    "cta_url": "https://barberconcept.ch/blog/huile-ou-baume-barbe",
    "image_prompt": "...",
    "scheduled_at": "2026-03-30T08:30:00+02:00"
  }
}
```

---

## 9. Sécurité & Auth

### Authentification

- **Admin :** Better Auth avec email/password (magic link en V2)
- **API :** Bearer token (API key en env var)
- **Client :** Token unique par projet en query param

### Autorisations

| Rôle | Permissions |
|------|-------------|
| Anonymous | Rien |
| Client (token) | Lire les contenus de son projet (sauf drafts par défaut), commenter |
| API (api key) | Créer et modifier du contenu (tous projets) |
| Admin (session) | Tout : CRUD projets, contenus, commentaires, statuts, tokens |

### Données sensibles

- API key : stockée en `env var`, jamais exposée côté client
- Client tokens : stockés en DB, hashés (ou en clair pour le MVP — à sécuriser en V2)
- GitHub PAT : stocké en `env var`
- Pas de données personnelles sensibles au-delà des emails de commentateurs

---

## 10. Déploiement & Environnement

### Variables d'environnement

```env
# Database (Turso)
DATABASE_URL=libsql://xxx.turso.io
DATABASE_AUTH_TOKEN=xxx

# Auth (Better Auth)
AUTH_SECRET=xxx
AUTH_URL=https://hub.jonlabs.ch

# GitHub
GITHUB_PAT=ghp_xxx
GITHUB_OWNER=jonvouilloz
GITHUB_REPO=jlabs-content-hub

# API
API_KEY=xxx

# App
PUBLIC_APP_URL=https://hub.jonlabs.ch
```

### Environnements

| Env | URL | Database |
|-----|-----|----------|
| Local | localhost:5173 | Turso local (dev) |
| Preview | pr-xxx.vercel.app | Turso branch (ou même DB dev) |
| Prod | hub.jonlabs.ch | Turso production |

### Domaine

- Sous-domaine : `hub.jonlabs.ch`
- DNS : à configurer sur Vercel

---

## 11. GitHub Sync — Spécifications

### Arborescence cible

Structure : Projet → Type → Année → Mois. Justification : avec 8-12 articles + posts LinkedIn + posts GMB par mois par projet, la séparation par mois est nécessaire pour garder les dossiers navigables.

```
jlabs-content-hub/
├── barberconcept/
│   ├── articles/
│   │   └── 2026/
│   │       ├── 03/
│   │       │   ├── entretien-barbe-courte.md
│   │       │   └── huile-ou-baume-barbe.md
│   │       └── 04/
│   │           └── tendances-coupe-2026.md
│   ├── linkedin/
│   │   └── 2026/
│   │       └── 03/
│   │           └── 2026-03-15-hook-barbe.md
│   └── gmb/
│       └── 2026/
│           └── 03/
│               └── 2026-03-30-huile-baume.json
├── physiopommier/
│   ├── articles/
│   │   └── 2026/
│   │       └── 03/
│   │           ├── arthrose-exercice-soulager-douleurs.md
│   │           └── pilates-mal-de-dos.md
│   ├── linkedin/
│   │   └── 2026/
│   └── gmb/
│       └── 2026/
└── README.md
```

### Formats de fichiers

| Type de contenu | Format sur GitHub | Raison |
|-----------------|-------------------|--------|
| Articles de blog | `.md` (frontmatter YAML + markdown) | Contenu texte long, format natif |
| Posts LinkedIn | `.md` (frontmatter YAML + texte) | Contenu texte, même si plus court |
| Posts GMB | `.json` | Data structurée, prête pour l'API Google My Business |

En DB, tout est dans la même table `contents`. Le format du fichier GitHub est déterminé par le `type` au moment du sync.

### Convention de nommage des fichiers

| Type | Pattern du nom | Exemple |
|------|----------------|---------|
| Articles | `{slug}.md` | `entretien-barbe-courte.md` |
| LinkedIn | `{YYYY-MM-DD}-{slug}.md` | `2026-03-15-hook-barbe.md` |
| GMB | `{YYYY-MM-DD}-{slug}.json` | `2026-03-30-huile-baume.json` |

La date dans le nom des posts LinkedIn et GMB permet un tri chronologique naturel dans le dossier mensuel. Les articles de blog utilisent uniquement le slug car la date est dans le chemin (année/mois).

### Construction du path GitHub

Le path est calculé automatiquement depuis les métadonnées du contenu :

```
{project_slug}/{type}/{YYYY}/{MM}/{filename}
```

Exemple : un article pour Barber Concept planifié au 15 mars 2026 avec le slug `entretien-barbe-courte` :
→ `barberconcept/articles/2026/03/entretien-barbe-courte.md`

La date utilisée pour le path est `planned_date` si elle existe, sinon `created_at`.

### Règles de sync

1. **Création** : quand un contenu est créé via l'API → push le fichier vers GitHub
2. **Modification** : quand le body ou le status est modifié → update le fichier GitHub
3. **Status dans le frontmatter** : le fichier pushé sur GitHub inclut un frontmatter avec le `status` actuel. Quand le status change en DB → le frontmatter est mis à jour sur GitHub
4. **Async** : la sync GitHub est toujours asynchrone (ne bloque pas la réponse API). En cas d'échec, `github_synced = false` et retry possible manuellement
5. **Direction** : DB → GitHub (one-way). Le GitHub est un backup/mirror, pas une source de vérité

### Migration initiale

Script pour importer les contenus existants du repo GitHub actuel vers la DB :
1. Lire tous les fichiers `.md` et `.json` du repo via l'API GitHub
2. Parser le frontmatter / JSON
3. Créer les entrées en DB avec les bonnes métadonnées
4. Marquer comme `github_synced: true`

---

## 12. Questions ouvertes

- [ ] **Nom du produit** : "Content Hub" est générique. Trouver un nom Jon Labs plus distinctif ? (Glana est déjà pris pour un autre concept)
- [ ] **Dark mode** : le supporter dès le MVP ou plus tard ?
- [ ] **Client token sécurité** : hasher les tokens en DB dès le MVP ou garder en clair pour simplifier ?
- [ ] **Import bulk** : faut-il un endpoint pour importer plusieurs contenus d'un coup ? (utile pour la migration)
- [ ] **Webhook/notifications** : en V2, notifier le client par email quand un contenu passe en `review` ?
- [ ] **Rate limiting API** : nécessaire dès le MVP ou pas ? (un seul utilisateur API = Claude Code)
- [ ] **Posts GMB groupés** : les posts GMB sont souvent un calendrier mensuel (1 fichier = N posts). Les stocker comme N entrées individuelles en DB ou comme 1 entrée "calendrier" ?

---

## 13. Changelog

| Date | Version | Changements |
|------|---------|-------------|
| 2026-03-31 | 1.0 | Création initiale |
| 2026-03-31 | 1.1 | Structure GitHub option A (Projet/Type/Année/Mois), format .json pour GMB, Skeleton UI, conventions de nommage fichiers |
