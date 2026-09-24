# API d’insights SEO pour Hermes

## But

Cette API donne à Hermes un accès **lecture seule**, borné par slug, aux données SEO nécessaires pour analyser un projet. Elle ne donne aucun accès SQL, aucun credential Google et aucune route d’écriture.

## Route

```text
GET /api/agent/projects/{slug}/insights
Authorization: Bearer hermes-seo-read.<secret>
```

Réponse : fraîcheur de la dernière collecte GSC, KPI, opportunités, quick wins, mouvements, cannibalisations et diff hebdomadaire.

## Credential

Le runtime fusionne deux variables sensibles :

- `MACHINE_CREDENTIALS_JSON` : intégrations existantes ;
- `HERMES_MACHINE_CREDENTIALS_JSON` : identité Hermes uniquement.

Une collision d'identifiant entre les deux maps échoue fermée. Le second secret doit uniquement déclarer :

- `id: "hermes-seo-read"` ;
- `scopes: ["agent:insights:read"]` ;
- `projects`: allowlist explicite des slugs autorisés ;
- `expiresAt`: date d'expiration.

Le bearer brut n'est jamais committé, loggé ou envoyé dans le chat. Il appartient exclusivement à l'environnement du profil Hermes. Une requête sur un slug absent de `projects` reçoit `403`.

## Déploiement et vérification

1. Définir `HERMES_MACHINE_CREDENTIALS_JSON` en Production dans Vercel, sans modifier la map existante.
2. Définir le bearer Hermes dans son environnement sécurisé.
3. Vérifier : appel valide sur un slug autorisé → `200` ; bearer absent → `401` ; slug hors allowlist → `403`.
4. Révoquer en retirant l'entrée de la variable dédiée ou en posant `revokedAt`.
