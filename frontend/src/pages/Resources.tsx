import { Badge, type BadgeVariant } from '@cloudflare/kumo/components/badge'
import { InputGroup } from '@cloudflare/kumo/components/input-group'
import { Search } from 'lucide-react'
import { Table } from '@cloudflare/kumo/components/table'
import { Input } from '@cloudflare/kumo/components/input'
import { Button } from '@cloudflare/kumo/components/button'
import { SelectField } from '../components/shared/SelectField'
import { cloudServiceLabel, recommendationTitle, storageRecommendationType } from '../lib/objectStorage'
import { chartColors, chartAxis, chartGrid } from '../lib/chartTheme'
import { useMoneyFormatter } from '../lib/format'
import { useId, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useTranslation } from 'react-i18next'
import api, { paginatedGet } from '../lib/api'
import { usePagination } from '../lib/hooks/usePagination'
import PaginationBar from '../components/PaginationBar'
import { useOrgStore } from '../store/orgStore'
import { ProviderBadge } from '../components/shared/ProviderBadge'
import { NativeDialog } from '../components/shared/NativeDialog'
import { providerLabel } from '../lib/providers'

interface ResourceRecommendation {
  id: string
  rec_type: string
  title: string
  status: string
  potential_savings: number
  current_monthly_cost: number
  created_at: string
}

interface Resource {
  id: string
  cloud_resource_id: string
  name: string
  resource_type: string
  provider?: string | null
  service_name: string | null
  cloud_region: string
  active: boolean
  total_cost: number
  last_month_cost: number
  pool_id: string | null
  tags: Record<string, string>
  first_seen: string
  last_seen: string
  recommendations: string[]
}

interface RawExpense {
  date: string
  cost: number
  service_name: string
}

const RESOURCE_TYPES = ['instance', 'volume', 'snapshot', 'bucket', 'rds_instance', 'load_balancer', 'ip_address', 'k8s_pod', 'k8s_cluster']

const typeBadges: Record<string, BadgeVariant> = {
  instance: 'info',
  volume: 'purple',
  snapshot: 'warning',
  bucket: 'success',
  rds_instance: 'error',
  load_balancer: 'info',
  k8s_pod: 'info',
  k8s_cluster: 'info',
}

function ResourceDetailPanel({ resource, orgId, onClose }: { resource: Resource; orgId: string; onClose: () => void }) {
  const fmt = useMoneyFormatter()
  const { t } = useTranslation()
  const titleId = useId()
  const qc = useQueryClient()
  const [editingTags, setEditingTags] = useState(false)
  const [tagDraft, setTagDraft] = useState<Array<{ key: string; value: string }>>([])
  const [tagError, setTagError] = useState('')
  // Local copy of tags so the drawer reflects saves without waiting for the
  // list query to re-fetch and re-pass the prop.
  const [currentTags, setCurrentTags] = useState<Record<string, string>>(resource.tags ?? {})

  const { data: history } = useQuery({
    queryKey: ['resource-history', orgId, resource.id],
    queryFn: () => api.get<{ data: RawExpense[] }>(`/orgs/${orgId}/resources/${resource.id}/raw-expenses`).then(r => r.data.data ?? []),
    enabled: !!resource.id,
  })

  const { data: detail } = useQuery({
    queryKey: ['resource-detail', orgId, resource.id],
    queryFn: () => api.get<{ data: Resource }>(`/orgs/${orgId}/resources/${resource.id}`).then(r => r.data.data),
    initialData: resource,
  })

  const { data: recommendations } = useQuery({
    queryKey: ['resource-recommendations', orgId, resource.id],
    queryFn: () =>
      api
        .get<{ data: ResourceRecommendation[] }>(
          `/orgs/${orgId}/resources/${resource.id}/recommendations`
        )
        .then((r) => r.data.data ?? []),
    enabled: !!resource.id,
  })

  const patchTags = useMutation({
    mutationFn: (tags: Record<string, string>) =>
      api.patch(`/orgs/${orgId}/resources/${resource.id}/tags`, { tags }),
    onSuccess: (res) => {
      // Update local view immediately so the drawer reflects the new tags
      // before the list query re-fetches.
      const next = (res?.data?.data?.tags ?? {}) as Record<string, string>
      setCurrentTags(next)
      qc.invalidateQueries({ queryKey: ['resources', orgId] })
      qc.invalidateQueries({ queryKey: ['resource-detail', orgId, resource.id] })
      setEditingTags(false)
      setTagError('')
    },
    onError: (err: any) => {
      setTagError(err?.response?.data?.error?.message ?? t('cmdb.tagsSaveFailed'))
    },
  })

  const tagEntries = Object.entries(currentTags)

  function startTagEdit() {
    // Initialize the draft with one row per existing tag, plus one empty row.
    const rows = tagEntries.map(([key, value]) => ({ key, value }))
    if (rows.length === 0) rows.push({ key: '', value: '' })
    setTagDraft(rows)
    setTagError('')
    setEditingTags(true)
  }

  function updateTagRow(idx: number, field: 'key' | 'value', value: string) {
    setTagDraft((prev) => prev.map((row, i) => (i === idx ? { ...row, [field]: value } : row)))
  }

  function addTagRow() {
    setTagDraft((prev) => [...prev, { key: '', value: '' }])
  }

  function removeTagRow(idx: number) {
    setTagDraft((prev) => prev.filter((_, i) => i !== idx))
  }

  function handleSaveTags() {
    const cleaned: Record<string, string> = {}
    const seen = new Set<string>()
    for (let i = 0; i < tagDraft.length; i++) {
      const { key, value } = tagDraft[i]
      const k = key.trim()
      const v = value.trim()
      if (k === '' && v === '') continue       // empty trailing row — skip silently
      if (k === '') {
        setTagError(t('cmdb.tagKeyEmpty', { n: i + 1 }))
        return
      }
      if (seen.has(k)) {
        setTagError(t('cmdb.tagDuplicateKey', { key: k }))
        return
      }
      seen.add(k)
      cleaned[k] = v
    }
    setTagError('')
    patchTags.mutate(cleaned)
  }

  function cancelTagEdit() {
    setEditingTags(false)
    setTagError('')
  }

  const chartData = (history ?? []).slice(-30).map(e => ({ date: e.date.slice(5), cost: e.cost }))
  const r = detail ?? resource

  return (
    <NativeDialog className="justify-end backdrop:bg-black/60" labelledBy={titleId} onClose={onClose}>
      <div className="drawer-panel max-w-[560px]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-strong">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-primary truncate">{r.name || r.cloud_resource_id}</h2>
            <p className="text-xs text-secondary">{r.cloud_resource_id}</p>
          </div>
          <Button variant="ghost" shape="square" type="button" aria-label={t('common.close')} onClick={onClose}>✕</Button>
        </div>

        <div className="p-6 space-y-6">
          {/* KPI cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { label: t('resources.kpiTotalCost'), value: fmt(r.total_cost ?? 0) },
              { label: t('resources.kpiLastMonth'), value: fmt(r.last_month_cost ?? 0) },
              { label: t('resources.kpiStatus'), value: r.active ? t('common.active') : t('common.inactive') },
            ].map(c => (
              <div key={c.label} className="bg-subtle rounded-lg p-3">
                <p className="text-xs text-secondary">{c.label}</p>
                <p className="text-sm font-semibold text-primary mt-1">{c.value}</p>
              </div>
            ))}
          </div>

          {/* Metadata */}
          <div className="grid grid-cols-2 gap-2 text-sm">
            {[
              [t('common.type'), r.resource_type],
              [t('cmdb.provider'), providerLabel(r.provider)],
              [t('resources.metaService'), cloudServiceLabel(r.service_name)],
              [t('cmdb.region'), r.cloud_region],
              [t('resources.metaFirstSeen'), r.first_seen?.slice(0, 10) ?? '—'],
              [t('resources.metaLastSeen'), r.last_seen?.slice(0, 10) ?? '—'],
              [t('resources.metaPool'), r.pool_id ?? t('resources.unassigned')],
            ].map(([k, v]) => (
              <div key={k} className="bg-subtle rounded p-2">
                <span className="text-secondary text-xs">{k}: </span>
                <span className="text-primary">{v}</span>
              </div>
            ))}
          </div>

          {/* Recommendations (G12 drill-down) */}
          {recommendations && recommendations.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-primary mb-3">
                {t('resources.recommendationsCount', { count: recommendations.length })}
              </h3>
              <div className="space-y-2">
                {recommendations.map((rec) => (
                  <div key={rec.id} className="bg-subtle rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-primary">{recommendationTitle(rec)}</p>
                      <span className="text-xs font-medium text-success">
                        {fmt(rec.potential_savings)}/mo
                      </span>
                    </div>
                    <p className="text-xs text-muted mt-1">
                      {storageRecommendationType(rec.rec_type)} · {rec.status} · {new Date(rec.created_at).toLocaleDateString()}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Daily cost chart */}
          {chartData.length > 0 && (
            <div>
              <p className="text-xs text-secondary mb-2">{t('resources.dailyCost')}</p>
              <ResponsiveContainer width="100%" height={120}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="rCost" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={chartColors.blue} stopOpacity={0.14} />
                      <stop offset="95%" stopColor={chartColors.blue} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...chartGrid}  vertical={false} />
                  <XAxis {...chartAxis} dataKey="date" tick={{ fontSize: 10, fill: 'rgb(var(--text-muted))' }} />
                  <YAxis {...chartAxis} tick={{ fontSize: 10, fill: 'rgb(var(--text-muted))' }} />
                  <Tooltip formatter={(v: number) => fmt(v)} />
                  <Area isAnimationActive={false} type="linear" dataKey="cost" stroke={chartColors.blue} fill="url(#rCost)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Recommendations */}
          {(r.recommendations ?? []).length > 0 && (
            <div>
              <p className="text-xs text-secondary mb-2">{t('resources.recommendations')}</p>
              <div className="space-y-1">
                {r.recommendations.map((rec: string, i: number) => (
                  <div key={i} className="bg-warning/10 border border-warning/25 rounded px-3 py-1.5 text-xs text-warning">{rec}</div>
                ))}
              </div>
            </div>
          )}

          {/* Tags editor */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-secondary uppercase tracking-wider">
                {t('cmdb.tags')} {tagEntries.length > 0 && <span className="text-muted">({tagEntries.length})</span>}
              </p>
              {!editingTags && (
                <button
                  onClick={startTagEdit}
                  className="text-xs text-accent hover:text-accent"
                >
                  {t('common.edit')}
                </button>
              )}
            </div>
            {editingTags ? (
              <div className="space-y-2">
                <div className="space-y-1.5" data-testid="resource-tags-editor">
                  {tagDraft.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-1.5">
                      <Input
                        type="text"
                        value={row.key}
                        onChange={(e) => updateTagRow(idx, 'key', e.target.value)}
                        placeholder="key"
                        aria-label={t('cmdb.tagKeyAria', { n: idx + 1 })}
                        className="flex-1 min-w-0 font-mono"
                      />
                      <span className="text-muted text-xs">=</span>
                      <Input
                        type="text"
                        value={row.value}
                        onChange={(e) => updateTagRow(idx, 'value', e.target.value)}
                        placeholder="value"
                        aria-label={t('cmdb.tagValueAria', { n: idx + 1 })}
                        className="flex-1 min-w-0 font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => removeTagRow(idx)}
                        disabled={patchTags.isPending}
                        aria-label={t('cmdb.tagRemoveAria', { n: idx + 1 })}
                        className="text-muted hover:text-danger disabled:opacity-30 transition-colors text-base leading-none px-1"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={addTagRow}
                  disabled={patchTags.isPending}
                  className="w-full py-1 text-xs text-accent hover:text-accent disabled:opacity-40 border border-dashed border-strong rounded transition-colors"
                >
                  {t('cmdb.addTag')}
                </button>
                {tagError && (
                  <p className="text-xs text-danger" data-testid="resource-tags-error">{tagError}</p>
                )}
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    onClick={handleSaveTags}
                    disabled={patchTags.isPending}
                    data-testid="resource-tags-save"
                    className="flex-1"
                  >
                    {patchTags.isPending ? t('cmdb.savingTags') : t('common.save')}
                  </Button>
                  <Button
                    onClick={cancelTagEdit}
                    disabled={patchTags.isPending}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {tagEntries.map(([k, v]) => (
                  <span key={k} className="px-2 py-0.5 bg-emphasis rounded text-xs text-primary">{k}: {String(v)}</span>
                ))}
                {tagEntries.length === 0 && <span className="text-xs text-muted">{t('cmdb.noTags')}</span>}
              </div>
            )}
          </div>
        </div>
      </div>
    </NativeDialog>
  )
}

export default function Resources() {
  const fmt = useMoneyFormatter()
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id ?? ''
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [activeFilter, setActiveFilter] = useState<boolean | null>(null)
  const [selected, setSelected] = useState<Resource | null>(null)

  const { query, rows: resources, page, perPage, totalPages, total, setPage, setPerPage } =
    usePagination<Resource>(
      ['resources', orgId, search, typeFilter, activeFilter],
      (p, pp) =>
        paginatedGet<Resource>(`/orgs/${orgId}/resources`, {
          page: p,
          per_page: pp,
          ...(search ? { search } : {}),
          ...(typeFilter ? { resource_type: typeFilter } : {}),
          ...(activeFilter !== null ? { active: activeFilter } : {}),
        }),
      { defaultPerPage: 50, enabled: !!orgId },
    )
  const isLoading = query.isLoading

  return (
    <div className="space-y-6">
      <div className="page-header flex-col sm:flex-row sm:flex-nowrap">
        <div className="min-w-0 flex-1">
          <h1 className="page-title">{t('resources.title')}</h1>
          <p className="text-sm text-secondary mt-1">{t('resources.subtitle')}</p>
        </div>
        <div className="shrink-0 whitespace-nowrap text-sm tabular-nums text-secondary sm:min-w-24 sm:text-right">{t('resources.totalCount', { count: total.toLocaleString() })}</div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <InputGroup className="flex-1 min-w-[200px]">
          <InputGroup.Addon><Search size={16} aria-hidden="true" /></InputGroup.Addon>
          <InputGroup.Input
            aria-label={t('resources.searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('resources.searchPlaceholder')}
          />
        </InputGroup>
        <SelectField
          value={typeFilter}
          onValueChange={setTypeFilter}
          aria-label={t('resources.allTypes')}
          items={[
            { value: "", label: t('resources.allTypes') },
            ...RESOURCE_TYPES.map((rt) => ({ value: rt, label: t(`resType.${rt}`, { defaultValue: rt }) })),
          ]}
        />
        <SelectField
          value={activeFilter === null ? '' : String(activeFilter)}
          onValueChange={value => setActiveFilter(value === '' ? null : value === 'true')}
          aria-label={t('resources.allStatus')}
          items={[
            { value: "", label: t('resources.allStatus') },
            { value: "true", label: t('common.active') },
            { value: "false", label: t('common.inactive') },
          ]}
        />
      </div>

      {/* Table */}
      <div className="bg-surface rounded-xl border border-strong overflow-hidden">
        <div className="overflow-x-auto">
          <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
            <Table.Header variant="compact">
              <Table.Row className="border-b border-strong">
                {[t('resources.colNameId'), t('common.type'), t('cmdb.provider'), t('cmdb.region'), t('resources.colService'), t('resources.colPool'), t('resources.colTotalCost'), t('resources.colLastMonth'), t('common.status')].map(h => (
                  <Table.Head key={h} className="px-4 py-3 text-left">{h}</Table.Head>
                ))}
              </Table.Row>
            </Table.Header>
            <Table.Body className="divide-y divide-edge">
              {isLoading ? (
                <Table.Row><Table.Cell colSpan={9} className="px-4 py-10 text-center text-muted">{t('common.loading')}</Table.Cell></Table.Row>
              ) : resources.length === 0 ? (
                <Table.Row><Table.Cell colSpan={9} className="px-4 py-10 text-center text-muted">{t('resources.noResources')}</Table.Cell></Table.Row>
              ) : resources.map(r => (
                <Table.Row
                  key={r.id}
                  className="hover:bg-subtle cursor-pointer transition-colors"
                  onClick={(event) => {
                    event.currentTarget.querySelector('button')?.focus()
                    setSelected(r)
                  }}
                >
                  <Table.Cell className="px-4 py-3">
                    <button type="button" className="text-link text-left font-medium" aria-haspopup="dialog">
                      {r.name || r.cloud_resource_id.slice(0, 24)}
                    </button>
                    <div className="text-xs text-muted font-mono">{r.cloud_resource_id.slice(0, 32)}</div>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <Badge variant={typeBadges[r.resource_type] ?? 'secondary'}>{t(`resType.${r.resource_type}`, { defaultValue: r.resource_type })}</Badge>
                  </Table.Cell>
                  <Table.Cell className="px-4 py-3"><ProviderBadge provider={r.provider} /></Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary">{r.cloud_region}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary">{cloudServiceLabel(r.service_name)}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary text-xs">{r.pool_id ? r.pool_id.slice(0, 8) + '…' : t('resources.unassigned')}</Table.Cell>
                  <Table.Cell className="px-4 py-3 font-semibold text-accent">{fmt(r.total_cost ?? 0)}</Table.Cell>
                  <Table.Cell className="px-4 py-3 text-secondary">{fmt(r.last_month_cost ?? 0)}</Table.Cell>
                  <Table.Cell className="px-4 py-3">
                    <Badge variant={r.active ? 'success' : 'secondary'}>
                      {r.active ? t('common.active') : t('common.inactive')}
                    </Badge>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table></div>
        </div>

        {/* Pagination */}
        {total > 0 && (
          <PaginationBar
            page={page}
            totalPages={totalPages}
            total={total}
            perPage={perPage}
            onPageChange={setPage}
            onPerPageChange={setPerPage}
          />
        )}
      </div>

      {selected && <ResourceDetailPanel resource={selected} orgId={orgId} onClose={() => setSelected(null)} />}
    </div>
  )
}
