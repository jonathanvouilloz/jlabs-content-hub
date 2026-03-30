export function parseContentPath(path) {
  const parts = path.split('/')
  const project = parts[0]
  const contentType = parts[1] === 'gmb' ? 'gmb' : parts[1] === 'linkedin' ? 'linkedin' : 'article'
  const isDraft = parts[2] === 'drafts'
  const filename = parts[parts.length - 1]
  const slug = filename.replace(/\.(md|json)$/, '')
  const stableKey = `${project}/${parts[1]}/${slug}`
  return { project, contentType, isDraft, slug, stableKey, filename }
}
