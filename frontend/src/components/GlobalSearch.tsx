import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Search, ArrowUpRight } from 'lucide-react'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useDialogFocus } from '../lib/hooks/useDialogFocus'

interface SearchResults {
  cis: Array<{ id: string; name: string; display_name: string }>
  resources: Array<{
    id: string
    name: string | null
    resource_type: string | null
    cost: number
  }>
  recommendations: Array<{
    id: string
    title: string
    rec_type: string
    savings: number
  }>
  services: Array<{ id: string; name: string; display_name: string }>
  pools: Array<{ id: string; name: string }>
}

const EMPTY: SearchResults = {
  cis: [],
  resources: [],
  recommendations: [],
  services: [],
  pools: [],
}

/** Cmd-K global search overlay (product gap P3). */
export default function GlobalSearch({
  open,
  onOpenChange: setOpen,
}: {
  open: boolean
  onOpenChange: Dispatch<SetStateAction<boolean>>
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults>(EMPTY)
  const [loading, setLoading] = useState(false)
  const dialogRef = useDialogFocus<HTMLDivElement>(open, () => setOpen(false))

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
  }, [setOpen])

  useEffect(() => {
    if (open) {
      setQuery('')
      setResults(EMPTY)
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
        .get<{ data: SearchResults }>(
          `/orgs/${orgId}/search?q=${encodeURIComponent(q)}`,
        )
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

  type SearchGroup = Array<{
    key: string
    label: string
    sub: string
    path: string
  }>
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
  const serviceGroup: SearchGroup = results.services.map((r) => ({
    key: r.id,
    label: r.display_name,
    sub: r.name,
    path: '/services',
  }))
  const poolGroup: SearchGroup = results.pools.map((r) => ({
    key: r.id,
    label: r.name,
    sub: '',
    path: '/pools',
  }))
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
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('common.search')}
        tabIndex={-1}
        className="relative w-full max-w-xl bg-surface border border-edge rounded-2xl shadow-popover overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-5 border-b border-edge">
          <Search size={16} className="text-muted" />
          <input
            aria-label={t('common.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search.placeholder')}
            className="flex-1 bg-transparent text-primary text-sm focus:outline-none"
          />
          <button
            onClick={() => setOpen(false)}
            aria-label={t('design.closeSearch')}
            className="text-[10px] text-muted border border-edge rounded px-1.5 py-1"
          >
            ESC
          </button>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {query.trim().length < 2 && (
            <div className="empty-state">
              <span className="empty-state-icon">
                <Search size={20} />
              </span>
              <p>{t('design.searchHint')}</p>
            </div>
          )}
          {loading && (
            <div className="px-4 py-6 text-center text-muted text-sm">
              {t('common.loading')}
            </div>
          )}
          {!loading && groups.length === 0 && query.trim().length >= 2 && (
            <div className="px-4 py-8 text-center text-muted text-sm">
              {t('search.empty')}
            </div>
          )}
          {groups.map(([label, items]) => (
            <div key={label} className="border-b border-edge last:border-0">
              <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-muted">
                {label}
              </p>
              {items.map((item) => (
                <button
                  key={item.key}
                  onClick={() => go(item.path)}
                  className="flex w-full items-center justify-between gap-3 text-left px-5 py-3 hover:bg-subtle transition-colors"
                >
                  <span className="min-w-0">
                    <span className="block text-sm text-primary truncate">
                      {item.label}
                    </span>
                    <span className="block text-xs text-muted truncate">
                      {item.sub}
                    </span>
                  </span>
                  <ArrowUpRight size={14} className="shrink-0 text-muted" />
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
