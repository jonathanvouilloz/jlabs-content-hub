# Epic 8 : Migration contenu existant

**Statut :** TODO
**Complexite :** S

## Description

Script pour importer les contenus existants du repo GitHub vers la base de donnees Turso.

## Taches

- [ ] Script `scripts/migrate-content.ts`
- [ ] Lire les fichiers .md et .json du repo (barberconcept, physiopommier)
- [ ] Parser le frontmatter YAML des articles
- [ ] Parser les JSON GMB
- [ ] Creer les projets en DB (barberconcept, physiopommier)
- [ ] Inserer les contenus en DB avec metadonnees
- [ ] Marquer comme `github_synced: true`
- [ ] Verifier le comptage : 4 articles barberconcept + 2 GMB + 16 articles physiopommier = 22 contenus

## Decisions a prendre

- Posts GMB : les fichiers actuels sont des calendriers mensuels (JSON arrays de N posts). Les stocker comme N entrees individuelles en DB ou comme 1 entree "calendrier" ?
  - Recommandation : N entrees individuelles (plus flexible pour le calendrier)
