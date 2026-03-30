export function parseFrontmatter(content) {
  const fm = { title: '', date: '', tags: [], status: '', description: '', body: content, type: '', day: '', article_slug: '' }
  if (!content.startsWith('---')) return fm
  const end = content.indexOf('---', 3)
  if (end === -1) return fm
  const yamlBlock = content.substring(3, end).trim()
  fm.body = content.substring(end + 3).trim()
  for (const line of yamlBlock.split('\n')) {
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const key = line.substring(0, sep).trim().toLowerCase()
    let val = line.substring(sep + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1)
    if (key === 'title') fm.title = val
    else if (key === 'date' || key === 'pubdate') fm.date = val
    else if (key === 'status') fm.status = val.toLowerCase()
    else if (key === 'description') fm.description = val
    else if (key === 'type') fm.type = val
    else if (key === 'day') fm.day = val
    else if (key === 'article_slug') fm.article_slug = val
    else if (key === 'tags') {
      val = val.replace(/^\[/, '').replace(/\]$/, '')
      fm.tags = val.split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    }
  }
  return fm
}
