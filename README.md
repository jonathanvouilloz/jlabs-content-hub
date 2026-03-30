# JLabs Content Hub

Hub centralise pour tous les articles markdown et posts GMB produits dans les projets Claude Code.

## Structure

```
jlabs-content-hub/
├── {projet}/
│   ├── articles/
│   │   ├── drafts/              # Articles en attente de publication
│   │   └── published/
│   │       └── YYYY/MM/         # Articles publies, classes par date
│   ├── gmb/
│   │   ├── drafts/              # Calendriers GMB en attente
│   │   └── published/
│   │       └── YYYY/MM/         # Calendriers GMB publies
├── dashboard/
│   ├── index.html
│   └── serve.sh
└── _meta.json                   # Metadonnees (addedAt, publishedAt)
```

## Workflow

1. Les articles et GMB posts arrivent dans `{projet}/articles/drafts/` ou `{projet}/gmb/drafts/`
2. Le dashboard affiche tout dans la **Pipeline** (vue drafts)
3. Cliquer **Publier** deplace le fichier vers `published/YYYY/MM/` via l'API GitHub
4. Cliquer **Depublier** le remet dans `drafts/`

## Setup

### 1. Configurer le owner

Dans `dashboard/index.html` :

```js
const GITHUB_OWNER = 'jonathanvouilloz';
```

### 2. Lancer le dashboard

```bash
cd dashboard
./serve.sh
```

Le dashboard s'ouvre sur `http://localhost:4242`.

### 3. Saisir le PAT

Au premier lancement, une modale demande votre GitHub Personal Access Token.
Creez-en un dans **Settings > Developer settings > Personal access tokens** avec le scope `repo`.

## Ajouter du contenu

### Articles

```bash
cp article.md {projet}/articles/drafts/
git add {projet}/articles/drafts/article.md
git commit -m "[{projet}] add: article.md"
git push
```

### Posts GMB

Les posts GMB sont groupes par mois dans un fichier `YYYY-MM-gmb.json` :

```bash
cp 2026-04-gmb.json {projet}/gmb/drafts/
git add {projet}/gmb/drafts/2026-04-gmb.json
git commit -m "[{projet}] add: GMB avril 2026"
git push
```

## Frontmatter supporte

```yaml
---
title: "Titre de l'article"
pubDate: 2026-03-27
tags: [seo, nextjs]
description: "Description courte"
---
```

## Cles _meta.json

Les cles utilisent un format stable independant du dossier draft/published :

```
{projet}/articles/{slug}     # ex: barberconcept/articles/entretien-barbe-courte
{projet}/gmb/{YYYY-MM}       # ex: barberconcept/gmb/2026-04
```
