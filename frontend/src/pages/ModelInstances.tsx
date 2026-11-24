import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowLeftRight, ArrowRight, Check, ChevronLeft, ChevronRight, Search } from 'lucide-react'
import api from '../lib/api'
import { relationLabel, typeLabel, type ModelEdge, type ModelType } from '../lib/modelTopology'
import type { CI, Organization, Paginated, PageMeta } from '../types'

interface Association {
  id: string
  src_ci_id: string
  src_ci_name: string
  association_kind_name: string
  dst_ci_id: string
  dst_ci_name: string
}

function Pager({ meta, change }: { meta: PageMeta; change: (page: number) => void }) {
  const { t } = useTranslation()
  if (meta.total_pages <= 1) return null
  return <div className="model-pager">
    <button disabled={meta.page <= 1} onClick={() => change(meta.page - 1)} aria-label={t('modelTopology.prev')}><ChevronLeft size={17} /></button>
    <span>{t('modelTopology.page', { page: meta.page, pages: meta.total_pages })}</span>
    <button disabled={meta.page >= meta.total_pages} onClick={() => change(meta.page + 1)} aria-label={t('modelTopology.next')}><ChevronRight size={17} /></button>
  </div>
}

function assetContext(ci: CI) {
  const values = [ci.tags?.cluster || ci.meta?.cluster_name, ci.tags?.namespace || ci.meta?.namespace,
    ci.tags?.region || ci.meta?.region || ci.cloud_region]
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && !!value))].join(' · ')
}

function DirectRelations({ ci, orgId, definitions }: { ci: CI; orgId: string; definitions: ModelEdge[] }) {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)
  const location = useLocation()
  const navigate = useNavigate()
  const links = useQuery({
    queryKey: ['model-direct-relations', orgId, ci.id, page],
    queryFn: async ({ signal }) => (await api.get<Paginated<Association>>(`/orgs/${orgId}/cis/${ci.id}/associations`,
      { params: { page, per_page: 5 }, signal })).data,
  })
  function endpoint(id: string, name: string) {
    return id === ci.id ? <span>{name}</span> : <Link to={{ search: new URLSearchParams({ ci: id }).toString() }}
      preventScrollReset state={{ topologyScope: orgId }} aria-label={t('modelTopology.follow', { name })}>{name}</Link>
  }
  return <section className="model-actual-relations" aria-labelledby="direct-heading">
    <div className="model-detail-heading">
      <div><h3 id="direct-heading">{t('modelTopology.directRelations')}</h3>
        <p className="model-asset-title" aria-live="polite">{ci.display_name || ci.name}</p></div>
      {location.state?.topologyScope === orgId && <button className="model-back" onClick={() => navigate(-1)}><ArrowLeft size={14} />{t('modelTopology.back')}</button>}
    </div>
    {links.isPending ? <p role="status" className="model-notice">{t('modelTopology.loading')}</p>
      : links.isError ? <div role="alert" className="model-notice">{t('modelTopology.linksFailed')} <button onClick={() => links.refetch()}>{t('modelTopology.retry')}</button></div>
      : links.data.data.length === 0 ? <p className="model-notice">{t('modelTopology.noInstanceLinks')}</p>
      : <>
        <table className="model-relations-table">
          <caption className="sr-only">{t('modelTopology.directRelations')} · {ci.name}</caption>
          <thead><tr><th scope="col">{t('modelTopology.sourceInstance')}</th><th scope="col">{t('modelTopology.relation')}</th><th scope="col">{t('modelTopology.targetInstance')}</th></tr></thead>
          <tbody>{links.data.data.map(link => {
            // The instance API supplies a display name. Only borrow direction and
            // translation when the visible model definitions agree on its meaning.
            const matches = definitions.filter(e => e.kind_display === link.association_kind_name)
            const kind = matches[0]
            const unambiguous = kind && matches.every(e => e.kind_name === kind.kind_name && e.directed === kind.directed)
            const Arrow = kind?.directed ? ArrowRight : ArrowLeftRight
            return <tr key={link.id}>
              <td>{endpoint(link.src_ci_id, link.src_ci_name)}</td>
              <td><span className="model-inline-verb">{unambiguous ? relationLabel(kind, t) : link.association_kind_name}
                {unambiguous && <Arrow size={15} role="img" aria-label={t(kind.directed ? 'modelTopology.directed' : 'modelTopology.symmetric')} />}</span></td>
              <td>{endpoint(link.dst_ci_id, link.dst_ci_name)}</td>
            </tr>
          })}</tbody>
        </table>
        <div className="model-relation-footer"><p>{t('modelTopology.linkTotal', { count: links.data.meta.total })}</p>
          <Pager meta={links.data.meta} change={setPage} /></div>
      </>}
  </section>
}

export function ModelInstances({ org, model, definitions, requested }: {
  org: Organization; model: ModelType; definitions: ModelEdge[]; requested?: CI
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const search = params.get('q') ?? ''
  const parsed = Number(params.get('page'))
  const page = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1
  const list = useQuery({
    queryKey: ['model-instances', org.id, model.id, search.trim(), page],
    queryFn: async ({ signal }) => (await api.get<Paginated<CI>>(`/orgs/${org.id}/cis`, {
      params: { ci_type_id: model.id, search: search.trim() || undefined, page, per_page: 5 }, signal,
    })).data,
  })
  const items = list.data?.data ?? []
  const selected = requested ?? items[0]
  function listParams(q: string, n: number) {
    const result = new URLSearchParams({ type: model.id })
    if (q) result.set('q', q)
    if (n > 1) result.set('page', String(n))
    return result
  }
  function instanceLink(ci: CI) {
    const target = listParams(search, page)
    target.set('ci', ci.id)
    const active = ci.id === selected?.id
    const context = assetContext(ci)
    const duplicate = items.some(other => other.id !== ci.id && (other.display_name || other.name) === (ci.display_name || ci.name) && assetContext(other) === context)
    const subtitle = duplicate ? [context, ci.cloud_resource_id || ci.id].filter(Boolean).join(' · ') : context || (ci.cloud_resource_id !== ci.name ? ci.cloud_resource_id : '')
    return <li key={ci.id}><Link to={{ search: target.toString() }} preventScrollReset aria-current={active ? 'true' : undefined}
      className="model-asset-link" onClick={() => queryClient.setQueryData(['model-instance', org.id, ci.id], ci)}>
      <span><strong>{ci.display_name || ci.name}</strong>{subtitle && <small>{subtitle}</small>}</span>
      {active && <Check size={15} aria-hidden="true" />}
    </Link></li>
  }
  return <section className="model-panel" aria-labelledby="model-assets-heading">
    <header className="model-panel-header">
      <div><h2 id="model-assets-heading" tabIndex={-1} className="model-heading">{t('modelTopology.assetHeading', { type: typeLabel(model, t) })}</h2>
        <p className="model-meta">{t('modelTopology.assetHint')}</p></div>
      <span className="model-scope">{t('modelTopology.environment', { name: org.workspace?.environment ?? org.name })}</span>
    </header>
    <div className="model-inventory">
      <section className="model-asset-list" aria-label={t('modelTopology.instanceList')}>
        <label htmlFor="model-instance-search">{t('modelTopology.searchInstances')}</label>
        <div className="model-search-field"><Search size={15} aria-hidden="true" />
          <input id="model-instance-search" type="search" value={search}
            placeholder={t('modelTopology.searchPlaceholder')}
            onChange={e => setParams(listParams(e.target.value, 1), { replace: true, preventScrollReset: true })} /></div>
        {list.isPending ? <p role="status" className="model-notice">{t('modelTopology.loadingInstance')}</p>
          : list.isError ? <p role="alert" className="model-notice">{t('modelTopology.assetsFailed')} <button onClick={() => list.refetch()}>{t('modelTopology.retry')}</button></p>
          : <>
            {items.length === 0 && page > 1 ? <p className="model-notice">{t('modelTopology.emptyPage')} <button onClick={() => setParams(listParams(search, 1), { replace: true })}>{t('modelTopology.firstPage')}</button></p>
              : items.length === 0 && <p className="model-notice">{t(search ? 'modelTopology.noMatches' : 'modelTopology.noInstances')}</p>}
            <ul className="model-asset-options">
              {requested && !items.some(ci => ci.id === requested.id) && instanceLink(requested)}
              {items.map(instanceLink)}
            </ul>
            <Pager meta={list.data.meta} change={n => setParams(listParams(search, n), { preventScrollReset: true })} />
          </>}
      </section>
      {selected ? <DirectRelations key={org.id + '/' + selected.id} ci={selected} orgId={org.id} definitions={definitions} />
        : <div className="model-no-selection">{t('modelTopology.selectInstanceHint')}</div>}
    </div>
  </section>
}
