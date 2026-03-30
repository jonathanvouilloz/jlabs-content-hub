# jlabs-content-hub — Brief Projet

## Vue d'ensemble

Un repo GitHub privé centralisé pour stocker tous les articles markdown produits via Claude Code, peu importe le projet d'origine. Accompagné d'un dashboard HTML local servi via un mini serveur, qui fetch l'API GitHub pour afficher et filtrer tous les articles par projet.

---

## Architecture du repo GitHub

```
jlabs-content-hub/                  ← repo GitHub privé
├── jon-labs-site/
│   ├── article-seo-2026.md
│   └── visibilite-site-internet.md
├── reply-guy/
│   └── quest-system-v2.md
├── swiss-review/
│   └── validation-mvp.md
├── [nouveau-projet]/               ← créé automatiquement si inexistant
│   └── ...
└── dashboard/
    ├── index.html                  ← le dashboard
    └── serve.sh                    ← script pour lancer le serveur local
```

---

## Dashboard local

### Principe
- Fichier `index.html` servi par un mini serveur HTTP local (`npx serve` ou `python -m http.server`)
- Au chargement, fetch l'API GitHub pour récupérer la liste de tous les fichiers `.md` du repo
- Affiche les articles filtrables par projet (dossier = projet)
- Lecture du contenu markdown rendu en HTML dans le browser

### Lancement
```bash
# Alias shell à ajouter dans ~/.zshrc ou ~/.bashrc
alias jlabs-hub="cd ~/jlabs-content-hub/dashboard && npx serve . -p 4242 && open http://localhost:4242"
```

### Fonctionnalités du dashboard
- Liste de tous les articles groupés par projet
- Filtres cliquables par projet (sidebar ou tabs)
- Affichage des métadonnées frontmatter YAML (titre, date, tags, statut)
- Clic sur un article → rendu markdown dans la page (pas de nouvelle page)
- Tri par date (plus récent en premier)
- Barre de recherche simple (filtre sur le titre)

---

## Frontmatter YAML attendu dans chaque article

Tous les articles markdown doivent avoir ce frontmatter (déjà en place dans le workflow Jon Labs) :

```yaml
---
title: "Titre de l'article"
description: "Description courte"
date: "YYYY-MM-DD"
project: "nom-du-projet"        ← optionnel si structure dossier utilisée
status: "draft" | "published" | "archive"
tags: ["tag1", "tag2"]
---
```

> Le `project` peut être inféré depuis le nom du dossier parent — pas obligatoire dans le frontmatter.

---

## Stack technique

| Composant | Choix | Raison |
|-----------|-------|--------|
| Repo | GitHub privé | Gratuit, accessible depuis Claude Code |
| Serveur local | `npx serve` ou `python -m http.server` | Zéro dépendance, 1 commande |
| Dashboard | HTML + JS vanilla | Pas de build step, simple à maintenir |
| Fetch data | GitHub REST API v3 | Pas besoin de GraphQL pour ce cas d'usage |
| Auth API | Personal Access Token (PAT) stocké en localStorage | Déjà configuré dans Claude Code |
| Rendu Markdown | `marked.js` via CDN | Léger, pas d'install |

---

## Authentification GitHub API

Le PAT (Personal Access Token) doit avoir les permissions :
- `repo` (accès aux repos privés)

Au premier lancement du dashboard, une modale demande le PAT et le stocke en `localStorage`. Pas besoin de le ressaisir ensuite.

```javascript
// Pattern à implémenter
const token = localStorage.getItem('gh_pat') || promptForToken();
```

---

## GitHub API — Endpoints utilisés

### Lister tous les fichiers du repo (récursif)
```
GET https://api.github.com/repos/{owner}/{repo}/git/trees/main?recursive=1
Authorization: Bearer {PAT}
```
Retourne tous les chemins de fichiers. Filtrer sur `.md`.

### Lire le contenu d'un fichier
```
GET https://api.github.com/repos/{owner}/{repo}/contents/{path}
Authorization: Bearer {PAT}
```
Retourne le contenu encodé en base64 → décoder côté JS.

---

## Skill Claude Code — Push article

Créer un skill `/push-article` dans le projet Claude Code qui :

1. Détecte le nom du projet courant (depuis le nom du dossier racine ou `CLAUDE.md`)
2. Identifie les fichiers `.md` nouveaux ou modifiés dans le projet
3. Exécute un `git push` vers `jlabs-content-hub/{nom-projet}/`
4. Crée le dossier distant si inexistant (git le crée automatiquement avec le premier fichier)

### Contenu du skill (SKILL.md)

```markdown
# push-article

Pousse les articles markdown du projet courant vers le repo centralisé jlabs-content-hub.

## Usage
Dis : "push les articles" ou "push cet article vers le hub"

## Ce que je fais
1. Je lis le nom du projet depuis le dossier racine ou CLAUDE.md
2. Je liste les fichiers .md concernés
3. Je les copie dans ~/jlabs-content-hub/{nom-projet}/
4. Je commit et push vers GitHub

## Prérequis
- Repo jlabs-content-hub cloné localement dans ~/jlabs-content-hub/
- PAT GitHub configuré (déjà en place via Claude Code)
- Git configuré globalement
```

### Script bash du skill

```bash
#!/bin/bash
# push-to-hub.sh
# Usage: ./push-to-hub.sh [fichier.md] [nom-projet]

FILE=$1
PROJECT=$2
HUB_PATH=~/jlabs-content-hub

# Si pas d'argument projet, utiliser le nom du dossier courant
if [ -z "$PROJECT" ]; then
  PROJECT=$(basename "$PWD")
fi

# Créer le dossier projet si inexistant
mkdir -p "$HUB_PATH/$PROJECT"

# Copier le fichier
cp "$FILE" "$HUB_PATH/$PROJECT/"

# Commit et push
cd "$HUB_PATH"
git add .
git commit -m "[$PROJECT] Add/update: $(basename $FILE)"
git push origin main

echo "✅ Article pushé dans $PROJECT/"
```

---

## Dashboard — Structure HTML

```
dashboard/
├── index.html        ← app complète (HTML + CSS + JS en un seul fichier)
└── serve.sh          ← raccourci pour lancer le serveur
```

### serve.sh
```bash
#!/bin/bash
cd "$(dirname "$0")"
echo "🚀 Lancement du dashboard sur http://localhost:4242"
npx serve . -p 4242
```

### index.html — Fonctionnement

```
[Sidebar]                    [Zone principale]
─────────────────────────────────────────────
Projets (cliquable)          [Barre recherche]
• Tous (42)                  
• jon-labs-site (12)         [Card article]
• reply-guy (8)              Titre
• swiss-review (5)           Date · Tags · Statut
• [...]                      Preview description
                             [Lire →]
                             
                             [Contenu markdown rendu]
                             (s'affiche sous les cards
                             au clic)
```

---

## Setup initial (étapes)

1. **Créer le repo GitHub privé** : `jlabs-content-hub`
2. **Cloner localement** : `git clone git@github.com:{username}/jlabs-content-hub.git ~/jlabs-content-hub`
3. **Créer le dossier dashboard** avec `index.html` et `serve.sh`
4. **Ajouter l'alias shell** dans `~/.zshrc`
5. **Premier lancement** : `jlabs-hub` → saisir le PAT au prompt
6. **Installer le skill** `push-article` dans les projets Claude Code concernés

---

## Ce que ce projet N'est PAS

- ❌ Pas un CMS public
- ❌ Pas un site déployé (tout reste local)
- ❌ Pas de base de données
- ❌ Pas de build step / compilation
- ❌ Pas de framework frontend

---

## Évolutions possibles (LATER)

- Ajouter un champ `published_url` dans le frontmatter pour lier vers l'article live
- Export CSV de tous les articles (pour tracking éditorial)
- Vue calendrier par date de publication
- Stats simples : nombre d'articles par projet, par mois
