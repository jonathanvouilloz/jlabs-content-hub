# Feature — GMB-009 : mentions employés rejouables et privées

> Epic E08 · statut : **IN_REVIEW** · 2026-08-16

## Objectif

Faire de l’identification des collaborateurs cités dans les avis un job durable et rejouable, sans mélanger l’identité d’un employé avec un compteur mutable ni exposer la PII des avis dans les findings.

## Livré

- La capability de projection `gmb.employeeMentions` est **fail-closed** : toute projection absente, invalide ou `enabled !== true` désactive le job.
- Le roster versionné porte les identités canoniques, aliases, établissements et statuts opérationnels. Le matching est insensible à la casse et aux accents, sans rapprochement flou.
- `detect:employee_mentions` est au catalogue quotidien, en dépendance obligatoire de `collect:gmb_reviews`, et entre dans la cohorte `llm`.
- L’extraction est awaitable, bornée à 25 avis par job et reçoit le `AbortSignal` du worker. Il n’existe aucun `waitUntil` dans ce chemin durable.
- La persistance ne modifie que `gmb_reviews.mentioned_employees`.
- L’écran mensuel dérive ses totaux via `GROUP BY` de ces avis sources. `employee_mentions` n’est plus écrit ni lu comme agrégat autoritaire.
- Un prénom explicitement extrait mais sans attribution de roster crée le finding idempotent `unknown_employee_mention`, discriminé par avis, établissement, token normalisé et version de roster.

## Confidentialité

Les preuves et événements de `unknown_employee_mention` ne contiennent que `locationId`, `rosterVersion` et le token détecté. Ils n’enregistrent jamais `authorName` ni `comment`; aucun texte d’avis n’est ajouté au finding ou à son journal append-only.

## Activation Barber Concept — étape contrôlée

Le code est prêt mais la projection de production n’a **pas** été modifiée depuis ce workspace : le roster complet versionné et les mappings d’établissements doivent être relus depuis sa source métier avant écriture. À l’activation, seule la projection courante de `barberconcept` doit recevoir :

```json
{
  "gmb": {
    "employeeMentions": {
      "enabled": true,
      "version": "barberconcept-YYYY-MM-DD",
      "employees": []
    }
  }
}
```

Tous les autres projets restent sans cette capability (donc désactivés). Une nouvelle version de roster doit être une **nouvelle projection hashée** : jamais une mutation silencieuse de la projection courante.

## Vérifications locales

- `npm test` : 63 fichiers, 1 614 tests passés.
- `npm run check` : 0 erreur, 42 avertissements préexistants.

## Non fait volontairement

- Aucune migration ou écriture sur Neon/production.
- Aucun envoi ou réponse publique à un avis.
- Aucune migration du stock historique vers une attribution inventée : le retraitement repasse par les avis sources et le roster actif.
