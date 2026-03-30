import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { fetchTree, fetchFileContent, fetchMeta, saveMeta, moveFileOnGitHub } from '../api/github'
import { parseContentPath } from '../utils/parseContentPath'
import { parseFrontmatter } from '../utils/parseFrontmatter'

const HubContext = createContext(null)

export function useHub() {
  const ctx = useContext(HubContext)
  if (!ctx) throw new Error('useHub must be used within HubProvider')
  return ctx
}

export function HubProvider({ children }) {
  const [pat, setPatState] = useState(() => localStorage.getItem('jlabs_gh_pat') || '')
  const [articles, setArticles] = useState([])
  const [meta, setMeta] = useState({})
  const [metaSha, setMetaSha] = useState(null)
  const [activeProject, setActiveProject] = useState('__pipeline')
  const [activeTab, setActiveTab] = useState('articles')
  const [selectedItem, setSelectedItem] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const setPat = useCallback((value) => {
    localStorage.setItem('jlabs_gh_pat', value)
    setPatState(value)
  }, [])

  const loadData = useCallback(async () => {
    if (!pat) return
    setLoading(true)
    setError(null)
    try {
      const [tree, metaResult] = await Promise.all([fetchTree(pat), fetchMeta(pat)])
      const { articleFiles, gmbFiles, linkedinFiles } = tree
      let currentMeta = metaResult.meta
      let currentMetaSha = metaResult.metaSha

      const allFiles = [
        ...articleFiles.map(f => ({ ...f, _type: 'article' })),
        ...gmbFiles.map(f => ({ ...f, _type: 'gmb' })),
        ...linkedinFiles.map(f => ({ ...f, _type: 'linkedin' })),
      ]

      const items = []
      const batchSize = 10
      for (let i = 0; i < allFiles.length; i += batchSize) {
        const batch = allFiles.slice(i, i + batchSize)
        const results = await Promise.all(
          batch.map(async (file) => {
            try {
              const content = await fetchFileContent(file.path, pat)
              const parsed = parseContentPath(file.path)

              if (file._type === 'gmb') {
                const gmbData = JSON.parse(content)
                const posts = Array.isArray(gmbData) ? gmbData : gmbData.posts || [gmbData]
                return posts.map((post, idx) => ({
                  path: file.path,
                  ...parsed,
                  contentType: 'gmb',
                  frontmatter: {
                    title: post.title || post.topic || `Post ${idx + 1}`,
                    date: post.date || post.publish_date || '',
                    description: post.summary || post.text?.substring(0, 120) || '',
                    tags: post.tags || [],
                    status: parsed.isDraft ? 'draft' : 'published',
                    body: post.text || JSON.stringify(post, null, 2),
                  },
                  raw: content,
                  gmbPost: post,
                }))
              }

              const frontmatter = parseFrontmatter(content)
              return [{
                path: file.path,
                ...parsed,
                frontmatter,
                raw: content,
              }]
            } catch {
              return []
            }
          })
        )
        items.push(...results.flat())
      }

      // Ensure addedAt in meta for each item
      let metaChanged = false
      for (const item of items) {
        if (!currentMeta[item.stableKey]) {
          currentMeta[item.stableKey] = { addedAt: new Date().toISOString() }
          metaChanged = true
        }
      }

      if (metaChanged) {
        try {
          currentMetaSha = await saveMeta(currentMeta, currentMetaSha, pat)
        } catch {
          // Non-blocking: meta save failure shouldn't break loading
        }
      }

      // Sort by date descending
      items.sort((a, b) => {
        const da = a.frontmatter.date || ''
        const db = b.frontmatter.date || ''
        return db.localeCompare(da)
      })

      setArticles(items)
      setMeta(currentMeta)
      setMetaSha(currentMetaSha)
    } catch (e) {
      if (e.message === 'auth') {
        setError('Token GitHub invalide ou expiré.')
      } else {
        setError(e.message)
      }
    } finally {
      setLoading(false)
    }
  }, [pat])

  const togglePublished = useCallback(async (item) => {
    if (!pat) return
    setLoading(true)
    setError(null)
    try {
      const parsed = parseContentPath(item.path)
      const { project, isDraft, slug, stableKey, filename } = parsed
      const folder = item.contentType === 'gmb' ? 'gmb'
        : item.contentType === 'linkedin' ? 'linkedin'
        : 'articles'
      const wasPublished = !isDraft

      let newPath
      if (wasPublished) {
        // Unpublish: move to drafts
        newPath = `${project}/${folder}/drafts/${filename}`
      } else {
        // Publish: determine year/month
        let year, month
        if (item.contentType === 'gmb') {
          // Try to extract date from slug (e.g., gmb-2025-03 or post date)
          const dateMatch = slug.match(/(\d{4})-(\d{2})/)
          if (dateMatch) {
            year = dateMatch[1]
            month = dateMatch[2]
          } else if (item.frontmatter.date) {
            const d = new Date(item.frontmatter.date)
            year = String(d.getFullYear())
            month = String(d.getMonth() + 1).padStart(2, '0')
          } else {
            const now = new Date()
            year = String(now.getFullYear())
            month = String(now.getMonth() + 1).padStart(2, '0')
          }
        } else {
          // articles and linkedin: use frontmatter date
          if (item.frontmatter.date) {
            const d = new Date(item.frontmatter.date)
            year = String(d.getFullYear())
            month = String(d.getMonth() + 1).padStart(2, '0')
          } else {
            const now = new Date()
            year = String(now.getFullYear())
            month = String(now.getMonth() + 1).padStart(2, '0')
          }
        }
        newPath = `${project}/${folder}/published/${year}/${month}/${filename}`
      }

      await moveFileOnGitHub(item.path, newPath, pat)

      // Update meta
      const updatedMeta = { ...meta }
      if (!updatedMeta[stableKey]) {
        updatedMeta[stableKey] = { addedAt: new Date().toISOString() }
      }
      updatedMeta[stableKey].published = !wasPublished
      updatedMeta[stableKey].publishedAt = !wasPublished ? new Date().toISOString() : null

      const newSha = await saveMeta(updatedMeta, metaSha, pat)
      setMeta(updatedMeta)
      setMetaSha(newSha)

      // Reload data
      await loadData()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [pat, meta, metaSha, loadData])

  // Auto-load on mount if pat exists
  useEffect(() => {
    if (pat) loadData()
  }, [pat, loadData])

  const value = {
    pat, setPat,
    articles, meta, metaSha,
    activeProject, setActiveProject,
    activeTab, setActiveTab,
    selectedItem, setSelectedItem,
    loading, error,
    loadData, togglePublished,
  }

  return <HubContext.Provider value={value}>{children}</HubContext.Provider>
}

export default HubContext
