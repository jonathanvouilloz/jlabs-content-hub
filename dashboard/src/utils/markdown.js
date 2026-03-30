import { marked } from 'marked'

export function renderMarkdown(md) {
  try { return marked.parse(md) }
  catch { return `<pre>${md}</pre>` }
}
