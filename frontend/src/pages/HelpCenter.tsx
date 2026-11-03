import { BookOpen, Search, ArrowUpRight } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import DataFlowDiagram from '../components/DataFlowDiagram'
import { helpArticles, helpLinkLabels } from '../lib/help'

export default function HelpCenter() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const search = params.get('q') ?? ''
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const articles = helpArticles.filter((article) => {
    const content = [t(`help.${article.id}.title`), t(`help.${article.id}.summary`),
      ...article.sections.flatMap((section) => [t(`help.${article.id}.${section}.title`), t(`help.${article.id}.${section}.body`)])].join(' ').toLocaleLowerCase()
    return terms.every((term) => content.includes(term))
  })
  const selected = articles.find((article) => article.id === params.get('article')) ?? articles[0]

  return <div className="space-y-6">
    <div className="page-header"><div><h1 className="page-title">{t('help.title')}</h1><p className="page-description">{t('help.subtitle')}</p></div><BookOpen className="hidden text-accent sm:block" size={32} aria-hidden="true" /></div>
    <div className="relative max-w-2xl">
      <Search size={18} className="pointer-events-none absolute left-3 top-3 text-muted" aria-hidden="true" />
      <input type="search" className="w-full rounded-lg border border-edge bg-surface py-2.5 pl-10 pr-3 text-sm text-primary" value={search} aria-label={t('help.search')} placeholder={t('help.search')}
        onChange={(event) => { const next = new URLSearchParams(params); event.target.value ? next.set('q', event.target.value) : next.delete('q'); setParams(next, { replace: true }) }} />
    </div>
    <div className="grid items-start gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      <nav className="panel p-2" aria-label={t('help.topics')}>
        <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted">{t('help.topics')}</p>
        {articles.map((article) => <Link key={article.id} to={`/help?article=${article.id}${search ? `&q=${encodeURIComponent(search)}` : ''}`}
          aria-current={selected?.id === article.id ? 'page' : undefined}
          className={`mb-1 block rounded-lg px-3 py-3 ${selected?.id === article.id ? 'bg-accent-soft text-accent' : 'text-secondary hover:bg-subtle'}`}>
          <span className="block text-sm font-semibold">{t(`help.${article.id}.title`)}</span>
          <span className="mt-1 block text-xs leading-5 text-muted">{t(`help.${article.id}.summary`)}</span>
        </Link>)}
        {articles.length === 0 && <p className="px-3 py-4 text-sm text-muted" role="status">{t('help.noResults')}</p>}
      </nav>
      {selected ? <article className="panel min-w-0 p-5 sm:p-7" key={selected.id} aria-labelledby="help-article-title">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-accent">CloudAtlas · {t('help.guide')}</p>
        <h2 id="help-article-title" className="text-2xl font-semibold text-primary">{t(`help.${selected.id}.title`)}</h2>
        <p className="mt-2 leading-7 text-secondary">{t(`help.${selected.id}.summary`)}</p>
        {selected.id === 'data-flow' && <div className="mt-6"><DataFlowDiagram /></div>}
        <div className="mt-7 space-y-7">
          {selected.sections.map((section, index) => <section key={section}>
            <h3 className="flex items-start gap-3 text-base font-semibold text-primary"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs text-accent">{index + 1}</span>{t(`help.${selected.id}.${section}.title`)}</h3>
            <p className="mt-3 whitespace-pre-line text-sm leading-7 text-secondary">{t(`help.${selected.id}.${section}.body`)}</p>
          </section>)}
        </div>
        <div className="mt-8 border-t border-edge pt-5"><h3 className="mb-3 text-sm font-semibold text-primary">{t('help.related')}</h3><div className="flex flex-wrap gap-2">
          {selected.links.map((to) => <Link to={to} key={to} className="btn-secondary text-xs">{t(helpLinkLabels[to])}<ArrowUpRight size={14} aria-hidden="true" /></Link>)}
        </div></div>
      </article> : <div className="empty-state panel"><BookOpen className="empty-state-icon" /><h2 className="font-semibold text-primary">{t('help.noResults')}</h2><p className="text-sm text-muted">{t('help.trySearch')}</p><button className="btn-secondary mt-4" onClick={() => setParams({ article: 'start' })}>{t('help.clear')}</button></div>}
    </div>
  </div>
}
