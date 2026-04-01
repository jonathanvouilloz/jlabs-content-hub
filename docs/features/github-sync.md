# Epic 7 : GitHub sync (backup)

**Statut :** DONE
**Complexite :** S

## Description

Synchronisation unidirectionnelle DB → GitHub via Octokit. GitHub est un backup/mirror, pas une source de verite.

## Taches

- [x] Service Octokit (`src/lib/server/github.ts`)
- [x] `buildGitHubPath()` : calcul du chemin `{projet}/{type}/{YYYY}/{MM}/{filename}`
- [x] `pushFileToGitHub()` : create/update fichier via API REST
- [x] `deleteFileFromGitHub()` : supprimer fichier
- [x] Sync async (ne bloque pas la reponse API)
- [x] Flag `github_synced` en DB (false si echec)

## Regles de sync

1. Creation contenu → push fichier
2. Modification body/status → update fichier
3. Suppression contenu → delete fichier
4. Echec → `github_synced = false`, retry possible manuellement
