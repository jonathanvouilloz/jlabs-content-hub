const GITHUB_OWNER = 'jonathanvouilloz'
const GITHUB_REPO = 'jlabs-content-hub'
const API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`

export async function ghFetch(url, pat) {
  const res = await fetch(url, {
    headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' },
  })
  if (res.status === 401 || res.status === 403) {
    const data = await res.json().catch(() => ({}))
    if (res.status === 403 && data.message?.includes('rate limit')) {
      throw new Error('Rate limit GitHub atteint. Attendez quelques minutes.')
    }
    throw new Error('auth')
  }
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`)
  return res.json()
}

export function decodeBase64Utf8(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

export async function fetchTree(pat) {
  const data = await ghFetch(`${API_BASE}/git/trees/main?recursive=1`, pat)
  const articleFiles = data.tree
    .filter(f => f.type === 'blob' && f.path.endsWith('.md') && /\/articles\//.test(f.path))
  const gmbFiles = data.tree
    .filter(f => f.type === 'blob' && f.path.endsWith('.json') && /\/gmb\//.test(f.path))
  const linkedinFiles = data.tree
    .filter(f => f.type === 'blob' && f.path.endsWith('.md') && /\/linkedin\//.test(f.path))
  return { articleFiles, gmbFiles, linkedinFiles }
}

export async function fetchFileContent(path, pat) {
  const data = await ghFetch(`${API_BASE}/contents/${encodeURIComponent(path)}`, pat)
  return decodeBase64Utf8(data.content)
}

export async function fetchMeta(pat) {
  try {
    const res = await fetch(`${API_BASE}/contents/_meta.json`, {
      headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' },
    })
    if (res.status === 404) return { meta: {}, metaSha: null }
    if (!res.ok) throw new Error('meta fetch failed')
    const data = await res.json()
    return { meta: JSON.parse(decodeBase64Utf8(data.content)), metaSha: data.sha }
  } catch (e) {
    if (e.message === 'meta fetch failed') throw e
    return { meta: {}, metaSha: null }
  }
}

export async function saveMeta(meta, metaSha, pat) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(meta, null, 2))))
  const body = { message: '[hub] update _meta.json', content }
  if (metaSha) body.sha = metaSha
  const res = await fetch(`${API_BASE}/contents/_meta.json`, {
    method: 'PUT',
    headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Erreur sauvegarde _meta.json')
  const data = await res.json()
  return data.content.sha
}

export async function moveFileOnGitHub(oldPath, newPath, pat) {
  const headers = { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' }
  const readRes = await fetch(`${API_BASE}/contents/${encodeURIComponent(oldPath)}`, { headers })
  if (!readRes.ok) throw new Error('Erreur lecture du fichier.')
  const fileData = await readRes.json()
  const createRes = await fetch(`${API_BASE}/contents/${encodeURIComponent(newPath)}`, {
    method: 'PUT', headers,
    body: JSON.stringify({ message: `[hub] move: ${oldPath} → ${newPath}`, content: fileData.content }),
  })
  if (!createRes.ok) throw new Error('Erreur creation du fichier.')
  const deleteRes = await fetch(`${API_BASE}/contents/${encodeURIComponent(oldPath)}`, {
    method: 'DELETE', headers,
    body: JSON.stringify({ message: `[hub] cleanup: ${oldPath}`, sha: fileData.sha }),
  })
  if (!deleteRes.ok) throw new Error('Erreur suppression ancien fichier.')
}
