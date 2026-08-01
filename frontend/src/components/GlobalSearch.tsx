import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'

interface SearchResults {
  cis: Array<{ id: string; name: string; display_name: string }>
  resources: Array<{ id: string; name: string | null; resource_type: string | null; cost: number }>
  recommendations: Array<{ id: string; title: string; rec_type: string; savings: number }>
  services: Array<{ id: string; name: string; display_name: string }>
  pools: Array<{ id: string; name: string }>
}

const EMPTY: SearchResults = { cis: [], resources: [], recommendations: [], services: [], pools: [] }

/** Cmd-K global search overlay (product gap P3). */
export default function GlobalSearch() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults>(EMPTY)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) {
      setQuery('')
      setResults(EMPTY)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    if (!orgId || !open) return
    const q = query.trim()
    if (q.length < 2) {
      setResults(EMPTY)
      return
    }
    setLoading(true)
    const timer = setTimeout(() => {
      api
        .get<{ data: SearchResults }>(`/orgs/${orgId}/search?q=${encodeURIComponent(q)}`)
        .then((res) => setResults(res.data.data ?? EMPTY))
        .catch(() => setResults(EMPTY))
        .finally(() => setLoading(false))
    }, 200)
    return () => clearTimeout(timer)
  }, [query, orgId, open])

  function go(path: string) {
    setOpen(false)
    navigate(path)
  }

  if (!open) return null

  type SearchGroup = Array<{ key: string; label: string; sub: string; path: string }>
  const groups: Array<[string, SearchGroup]> = []
  const ciGroup: SearchGroup = results.cis.map((r) => ({
    key: r.id,
    label: r.display_name || r.name,
    sub: r.name,
    path: '/cmdb',
  }))
  const resourceGroup: SearchGroup = results.resources.map((r) => ({
    key: r.id,
    label: r.name ?? r.id,
    sub: `${r.resource_type ?? ''} · $${r.cost.toFixed(2)}`,
    path: '/resources',
  }))
  const recGroup: SearchGroup = results.recommendations.map((r) => ({
    key: r.id,
    label: r.title,
    sub: `${r.rec_type} · $${r.savings.toFixed(2)}/mo`,
    path: '/recommendations',
  }))
  const serviceGroup: SearchGroup = results.services.map((r) => ({ key: r.id, label: r.display_name, sub: r.name, path: '/services' }))
  const poolGroup: SearchGroup = results.pools.map((r) => ({ key: r.id, label: r.name, sub: '', path: '/pools' }))
  const groupTuples: Array<[string, SearchGroup]> = [
    [t('search.groupCis'), ciGroup],
    [t('nav.resources'), resourceGroup],
    [t('nav.recommendations'), recGroup],
    [t('nav.services'), serviceGroup],
    [t('nav.pools'), poolGroup],
  ]
  for (const [label, items] of groupTuples) {
    if (items.length > 0) groups.push([label, items])
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-24" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative w-full max-w-lg bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
          <Search size={16} className="text-gray-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search.placeholder')}
            className="flex-1 bg-transparent text-white text-sm focus:outline-none"
          />
          <kbd className="text-[10px] text-gray-600 border border-gray-700 rounded px-1.5 py-0.5">ESC</kbd>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {loading && <div className="px-4 py-6 text-center text-gray-500 text-sm">{t('common.loading')}</div>}
          {!loading && groups.length === 0 && query.trim().length >= 2 && (
            <div className="px-4 py-8 text-center text-gray-500 text-sm">{t('search.empty')}</div>
          )}
          {groups.map(([label, items]) => (
            <div key={label} className="border-b border-gray-800 last:border-0">
              <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-gray-600">{label}</p>
              {items.map((item) => (
                <button
                  key={item.key}
                  onClick={() => go(item.path)}
                  className="w-full text-left px-4 py-2 hover:bg-gray-800 transition-colors"
                >
                  <p className="text-sm text-white truncate">{item.label}</p>
                  <p className="text-xs text-gray-500 truncate">{item.sub}</p>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
