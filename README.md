# JLabs Content Hub

Hub centralise pour tous les articles markdown produits dans les projets Claude Code.

## Setup

### 1. Creer le repo prive sur GitHub

Sur [github.com/new](https://github.com/new), creer un repo prive `jlabs-content-hub`.

### 2. Configurer le owner

Dans `dashboard/index.html`, remplacer la variable en haut du fichier :

```js
const GITHUB_OWNER = 'jonathanvouilloz';
```

### 3. Connecter le remote et push

```bash
git remote add origin git@github.com:jonathanvouilloz/jlabs-content-hub.git
git push -u origin main
```

### 4. Lancer le dashboard

```bash
cd dashboard
./serve.sh
```

Le dashboard s'ouvre sur `http://localhost:4242`.

### 5. Saisir le PAT

Au premier lancement, une modale demande votre GitHub Personal Access Token.
Creez-en un dans **Settings > Developer settings > Personal access tokens** avec le scope `repo`.

## Ajouter un article

Copiez vos fichiers markdown dans un dossier par projet :

```bash
mkdir -p mon-projet
cp ~/chemin/vers/article.md mon-projet/
git add mon-projet/article.md
git commit -m "add: article sur XYZ"
git push
```

Le dashboard detecte automatiquement les nouveaux fichiers au rechargement.

## Frontmatter supporte

```yaml
---
title: "Titre de l'article"
date: "2026-03-27"
tags: [seo, nextjs]
status: published
description: "Description courte"
---
```

## Alias shell

Ajoutez dans votre `~/.zshrc` :

```bash
alias jlabs-hub="~/jlabs-content-hub/dashboard/serve.sh"
```

Puis `source ~/.zshrc`. Lancez ensuite avec `jlabs-hub`.
