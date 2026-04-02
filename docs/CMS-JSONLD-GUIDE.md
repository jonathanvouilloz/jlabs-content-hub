# Guide JSON-LD par CMS

> Comment integrer les donnees structurees Schema.org generees par le Hub dans chaque CMS.

Le Hub stocke le JSON-LD complet dans le frontmatter `schema:` des articles (genere par `/seo-enrich`). L'adapter CMS strip les balises `<script>` et envoie le JSON pur. Chaque CMS le wrap a sa maniere.

---

## Webflow

| | |
|---|---|
| **Champ CMS** | Plain Text (nomme `schema-json-ld`) |
| **Limite** | 10'000 caracteres |
| **Injection** | Embed element dans le template de la collection page |

### Setup

1. Ajouter un champ **Plain Text** `schema-json-ld` dans la collection Blog Posts
2. Dans le template de la collection page, ajouter un **Embed element** en bas du `<body>`
3. Contenu de l'Embed :

```html
<script type="application/ld+json">
{reference au champ schema-json-ld}
</script>
```

### Piege

**Ne PAS utiliser Custom Code dans Page Settings** — il echappe les caracteres HTML (`<`, `>`, `"`), ce qui casse le JSON. L'Embed element rend le contenu brut, sans echappement.

---

## Sanity

| | |
|---|---|
| **Champ** | `text` (multiline string) ou auto-genere |
| **Injection** | `dangerouslySetInnerHTML` (Next.js) ou `useHead()` (Nuxt) |
| **Best practice** | Auto-generer depuis les champs structures. Champ texte comme override uniquement. |

### Schema Sanity

```js
defineField({
  name: 'jsonLd',
  title: 'Schema JSON-LD',
  type: 'text',
  validation: (Rule) => Rule.custom((value) => {
    if (!value) return true;
    try { JSON.parse(value); return true }
    catch { return 'JSON invalide' }
  })
})
```

### Frontend Next.js

```jsx
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{ __html: post.jsonLd }}
/>
```

### Frontend Nuxt

```js
useHead({
  script: [
    { type: 'application/ld+json', innerHTML: post.jsonLd }
  ]
})
```

---

## WordPress

| | |
|---|---|
| **Option recommandee** | RankMath (onglet Schema par article, Custom Schema JSON-LD) |
| **Alternative** | ACF Textarea + `wp_head` action |

### Avec RankMath

RankMath a un GUI de schema par article. Pour du schema custom, utiliser le filtre `rank_math/json_ld` plutot qu'injecter un 2e bloc `<script>` (evite les doublons).

### Avec ACF

1. Creer un champ ACF **Textarea** `json_ld_schema` attache aux Posts
2. Rendre dans le head :

```php
add_action('wp_head', function() {
  if (is_single()) {
    $schema = get_field('json_ld_schema');
    if ($schema) {
      echo '<script type="application/ld+json">' . $schema . '</script>';
    }
  }
});
```

### Piege

Si plugin SEO (Yoast/RankMath) + JSON-LD manuel → **schemas dupliques**. Utiliser les filtres du plugin pour etendre le graph existant.

---

## Astro

| | |
|---|---|
| **Champ** | Frontmatter `schema:` (deja en place dans les articles) |
| **Injection** | Composant `JsonLd.astro` ou layout avec `set:html` |

### Composant reutilisable

```astro
---
// src/components/JsonLd.astro
const { data } = Astro.props;
---
<script type="application/ld+json" set:html={JSON.stringify(data)} />
```

### Usage dans le layout

```astro
---
import JsonLd from '../components/JsonLd.astro';
const { frontmatter } = Astro.props;
const schema = frontmatter.schema ? JSON.parse(frontmatter.schema) : null;
---
{schema && <JsonLd data={schema} />}
```

### Piege

`is:inline` ne suffit pas — utiliser `set:html` sur le `<script>` pour eviter l'echappement par Astro.

---

## Resume

| CMS | Ce que le Hub envoie | Ce que le CMS fait |
|-----|---------------------|---------------------|
| **Webflow** | JSON brut → champ Plain Text | Embed element wraps avec `<script>` |
| **Sanity** | JSON brut → champ `text` | Frontend injecte via `dangerouslySetInnerHTML` |
| **WordPress** | JSON brut → ACF Textarea ou filtre RankMath | `wp_head` action ou filtre plugin |
| **Astro** | Deja dans le frontmatter `schema:` | Layout le rend avec `set:html` |

Le principe est toujours le meme : le Hub fournit le JSON pur, le CMS l'enveloppe dans `<script type="application/ld+json">`.
