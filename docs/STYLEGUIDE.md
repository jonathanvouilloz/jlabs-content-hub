# Styleguide — JLabs Content Hub

## Conventions de nommage

| Element | Convention | Exemple |
|---------|-----------|---------|
| Composants Svelte | PascalCase | `ContentCard.svelte` |
| Fichiers utilitaires | camelCase | `formatDate.ts` |
| Routes SvelteKit | kebab-case | `/project-settings` |
| Variables/fonctions | camelCase | `fetchContent()` |
| Constantes | SCREAMING_SNAKE_CASE | `VALID_STATUSES` |
| Types/Interfaces | PascalCase | `ContentItem` |
| Colonnes DB (Drizzle) | camelCase JS, snake_case SQL | `projectId` → `project_id` |

## Structure des fichiers

```
src/lib/
  server/     # Code serveur uniquement ($lib/server/)
  components/ # Composants Svelte reutilisables
  utils/      # Fonctions utilitaires partagees (client + serveur)

src/routes/
  (app)/      # Routes admin protegees par auth
  (auth)/     # Routes auth (login)
  view/       # Routes client publiques (token)
  api/        # API endpoints
```

## Patterns

### Reponses API
```typescript
type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };
```

### IDs
```typescript
import { createId } from '$lib/server/utils.js';
const id = createId(); // 24 chars hex via crypto.randomBytes
```

### Validation auth API
```typescript
if (!validateApiKey(event)) {
  return errorResponse('Unauthorized', 401);
}
```

## A eviter

- `any` en TypeScript
- Logique metier dans les composants Svelte
- Requetes DB dans les composants (passer par server load functions)
- Console.log en production
- Secrets en dur dans le code

## Conventions de commits

Format : `[{projet}] {add|update|fix}: description courte`

```
[hub] add: dashboard admin layout
[hub] fix: GitHub sync retry logic
[barberconcept] add: articles mars 2026
```

Pour les changements globaux au projet (config, docs, infra) :
```
[hub] update: description
```

## Couleurs

| Usage | Hex | Nom |
|-------|-----|-----|
| Accent primaire | `#00D9A3` | Turquoise Jon Labs |
| Accent secondaire | `#A300D9` | Magenta |
| Background | `#FAFAFA` | Light |
| Surface | `#FFFFFF` | White |
| Border | `#E5E5E5` | Gray 200 |
| Text primary | `#141413` | Near black |
| Text secondary | `#737373` | Gray 500 |
| Status draft | `#737373` | Gris |
| Status review | `#F59E0B` | Amber |
| Status approved | `#3B82F6` | Bleu |
| Status published | `#10B981` | Vert |
