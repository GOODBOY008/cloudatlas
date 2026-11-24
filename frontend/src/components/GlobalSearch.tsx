import { recommendationTitle, storageRecommendationType } from '../lib/objectStorage'
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Search, ArrowUpRight } from 'lucide-react'
import { useOrgStore } from '../store/orgStore'
import { useDialogFocus } from '../lib/hooks/useDialogFocus'
import { productRoutes } from '../app/routeCatalog'
import { fmtMoney, useOrgCurrency } from '../lib/format'
import { useWorkspaceSearch } from '../features/search/useWorkspaceSearch'

type SearchItem = { key: string; label: string; sub: string; path: string }

/** Feature navigation is local; workspace results are independently scoped and recoverable. */
export default function GlobalSearch({ open, onOpenChange: setOpen }: {
  open: boolean
  onOpenChange: Dispatch<SetStateAction<boolean>>
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const orgId = useOrgStore((state) => state.currentOrg?.id)
  useOrgCurrency()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const dialogRef = useDialogFocus<HTMLDivElement>(open, () => setOpen(false))
  const { results, loading, failed, retry } = useWorkspaceSearch(orgId, query, open)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (document.querySelector('dialog:modal')) return
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  useEffect(() => {
    if (open) { composing.current = false; setQuery(''); setActive(0); inputRef.current?.focus() }
  }, [open])
  useEffect(() => { setActive(0) }, [query, orgId])

  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const pages = productRoutes.filter((route) => route.navigation !== false && terms.every((term) =>
    [t(route.labelKey), t(route.labelKey, { lng: 'en' }), t(route.labelKey, { lng: 'zh' }), t(route.section), route.path, ...(route.searchTerms ?? [])]
      .join(' ').toLocaleLowerCase().includes(term),
  )).slice(0, terms.length ? 8 : 6)
  const groups: Array<{ label: string; items: SearchItem[] }> = [
    { label: t(terms.length ? 'design.searchPages' : 'design.searchQuickLinks'), items: pages.map((route) => ({
      key: `page:${route.path}`, label: t(route.labelKey), sub: t(route.section), path: route.path,
    })) },
    { label: t('search.groupCis'), items: results.cis.map((r) => ({ key: `ci:${r.id}`, label: r.display_name || r.name, sub: r.name, path: '/cmdb' })) },
    { label: t('nav.resources'), items: results.resources.map((r) => ({ key: `resource:${r.id}`, label: r.name ?? r.id, sub: `${r.resource_type ?? ''} · ${fmtMoney(r.cost)}`, path: '/resources' })) },
    { label: t('nav.recommendations'), items: results.recommendations.map((r) => ({ key: `rec:${r.id}`, label: recommendationTitle(r), sub: `${storageRecommendationType(r.rec_type)} · ${fmtMoney(r.savings)}`, path: '/recommendations' })) },
    { label: t('nav.services'), items: results.services.map((r) => ({ key: `service:${r.id}`, label: r.display_name || r.name, sub: r.name, path: '/services' })) },
    { label: t('nav.pools'), items: results.pools.map((r) => ({ key: `pool:${r.id}`, label: r.name, sub: '', path: '/pools' })) },
  ].filter((group) => group.items.length > 0)
  const items = groups.flatMap((group) => group.items)
  const selected = Math.min(active, Math.max(items.length - 1, 0))
  const selectedKey = items[selected]?.key
  useEffect(() => {
    if (open && selectedKey) document.getElementById(`search-${selectedKey}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, selectedKey])

  function go(path: string) { setOpen(false); navigate(path) }
  if (!open) return null

  return <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[10dvh] sm:pt-[15dvh]" onClick={() => setOpen(false)}>
    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('common.search')} tabIndex={-1}
      className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-edge bg-surface shadow-popover" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-center gap-3 border-b border-edge px-5 py-5">
        <Search size={16} className="text-muted" aria-hidden="true" />
        <input ref={inputRef} role="combobox" aria-expanded="true" aria-controls="global-search-results" aria-autocomplete="list"
          aria-activedescendant={selectedKey ? `search-${selectedKey}` : undefined} aria-label={t('common.search')}
          value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('search.placeholder')}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDownCapture={(event) => {
            // WebKit can report compositionend before the Enter that confirms the candidate.
            if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
              // The dialog's native Escape listener must let the IME dismiss its candidate first.
              if (event.key === 'Escape') event.stopPropagation()
              return
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              if (items.length) setActive((selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
            }
            if (event.key === 'Enter' && items[selected]) { event.preventDefault(); go(items[selected].path) }
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-primary" />
        <button onClick={() => setOpen(false)} aria-label={t('design.closeSearch')} className="rounded border border-edge px-1.5 py-1 text-[10px] text-muted">ESC</button>
      </div>
      <div className="max-h-[min(420px,60dvh)] overflow-y-auto">
        <div id="global-search-results" role="listbox" aria-label={t('common.search')} aria-busy={loading}>
          {groups.map((group) => <div key={group.label} role="group" aria-label={group.label} className="border-b border-edge last:border-0">
            <p className="px-4 pb-1 pt-3 text-[10px] uppercase tracking-wider text-muted">{group.label}</p>
            {group.items.map((item) => <button key={item.key} id={`search-${item.key}`} role="option" aria-selected={item.key === selectedKey} tabIndex={-1}
              onMouseMove={() => setActive(items.indexOf(item))} onClick={() => go(item.path)}
              className={`flex w-full items-center justify-between gap-3 px-5 py-3 text-left ${item.key === selectedKey ? 'bg-accent-soft' : 'hover:bg-subtle'}`}>
              <span className="min-w-0"><span className="block truncate text-sm text-primary">{item.label}</span><span className="block truncate text-xs text-muted">{item.sub}</span></span>
              <ArrowUpRight size={14} className="shrink-0 text-muted" aria-hidden="true" />
            </button>)}
          </div>)}
        </div>
        {loading && <p role="status" className="px-4 py-5 text-center text-sm text-muted">{t('common.loading')}</p>}
        {failed && <div role="alert" className="space-y-2 px-5 py-4 text-sm text-secondary"><p>{t('design.searchFailed')}</p><button className="text-link" onClick={() => retry()}>{t('design.searchRetry')}</button></div>}
        {!loading && !failed && items.length === 0 && <p role="status" className="px-4 py-8 text-center text-sm text-muted">{t('search.empty')}</p>}
      </div>
      <p className="border-t border-edge px-5 py-3 text-[10px] text-muted">{t('design.searchKeyboard')}</p>
    </div>
  </div>
}
