# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this project

Hub centralise pour stocker et gerer les articles markdown, posts GMB et posts LinkedIn produits via Claude Code pour differents projets clients. Accompagne d'un dashboard HTML local qui fetch l'API GitHub pour afficher, filtrer et publier le contenu.

## Architecture

```
{projet}/
├── articles/drafts/          # Articles en attente
├── articles/published/YYYY/MM/  # Articles publies
├── gmb/drafts/               # Calendriers GMB (1 JSON par mois)
├── gmb/published/YYYY/MM/
├── linkedin/drafts/           # Posts LinkedIn (1 .md par post)
└── linkedin/published/YYYY/MM/
dashboard/
├── index.html                # SPA monolithique (HTML + CSS + JS)
└── serve.sh                  # Lance npx serve sur :4242
_meta.json                    # Metadonnees par cle stable
```

Le dashboard est un fichier HTML unique sans framework ni build step. Il utilise l'API GitHub (REST v3) pour lire les fichiers et `_meta.json` pour tracker les metadonnees. Le PAT GitHub est stocke dans `localStorage`.

## Cles `_meta.json`

Les cles sont stables et independantes du dossier draft/published :
- `{projet}/articles/{slug}` (ex: `barberconcept/articles/entretien-barbe-courte`)
- `{projet}/gmb/{YYYY-MM}` (ex: `barberconcept/gmb/2026-04`)
- `{projet}/linkedin/{slug}` (ex: `physiopommier/linkedin/pilates-mal-de-dos-lundi`)

## Dashboard (dashboard/index.html)

3 vues : Kanban (defaut), Calendrier, Liste. Toggle persiste dans `localStorage`.

Fonctions critiques a ne pas casser :
- `parseContentPath(path)` — derive projet, type, isDraft, stableKey depuis le chemin
- `togglePublished(item)` — deplace le fichier via API GitHub (read → create → delete)
- `moveFileOnGitHub(old, new)` — 3 appels API pour deplacer un fichier

Le publish deplace physiquement le fichier de `drafts/` vers `published/YYYY/MM/` sur GitHub.

## Lancer le dashboard

```bash
cd dashboard && ./serve.sh
# ou: npx serve dashboard -p 4242
```

## Config GitHub

```js
const GITHUB_OWNER = 'jonathanvouilloz';
const GITHUB_REPO  = 'jlabs-content-hub';
```

## Conventions de commit

```
[{projet}] {add|update|fix}: description courte
[hub] update: description pour les changements globaux
```

## Skills relies

Ce repo est consomme par plusieurs skills Claude Code :
- `/publish-hub` — pousse du contenu depuis un repo client vers `{projet}/*/drafts/`
- `/content-pipeline` — orchestre publish + linkedin + gmb en sequence
- `/linkedin-weekly-posts` — genere 3 posts LinkedIn par article
- `/gmb-generate` — genere un calendrier GMB

## Fin d'epic
Quand le dernier commit d'un epic est fait, propose a Jonathan de lancer `/epic-recap` pour generer le rapport dans Obsidian. Ne le lance pas automatiquement — demande d'abord.
