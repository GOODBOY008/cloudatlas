import { Table } from '@cloudflare/kumo/components/table'
import { SelectField } from '../components/shared/SelectField'
import { chartPalette, chartAxis, chartTooltipStyle } from '../lib/chartTheme'
import { fmtMoney } from '../lib/format'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import api, { paginatedGet } from '../lib/api'
import { usePagination } from '../lib/hooks/usePagination'
import PaginationBar from '../components/PaginationBar'
import { ReportQueryState } from '../components/shared/ReportQueryState'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'
import { providerLabel } from '../lib/providers'
import type { Paginated } from '../types'

interface Cluster { id: string; name: string; region?: string; provider?: string; node_count?: number; namespaces: string[] }
interface Workload {
  id: string
  cluster_id: string
  cluster_name: string
  namespace: string
  workload_name: string
  workload_type: string
  cpu_request_m?: number
  mem_request_mi?: number
  cpu_p95_m?: number
  mem_p95_mi?: number
  cpu_rec_m?: number
  mem_rec_mi?: number
  monthly_cost?: number
  potential_savings?: number
  observation_days: number
}
interface Summary {
  cluster_count: number
  workload_count: number
  total_savings: number
  total_cost: number
  cluster_totals: Record<string, { workload_count: number; total_savings: number }>
  top_namespaces: { namespace: string; cluster_id: string; potential_savings: number }[]
}

async function loadClusters(orgId: string, signal: AbortSignal) {
  const path = `/orgs/${orgId}/k8s/clusters`
  const { data: first } = await api.get<Paginated<Cluster>>(path, { signal })
  const clusters = [...first.data]
  for (let page = 2; page <= first.meta.total_pages; page++) {
    const { data } = await api.get<Paginated<Cluster>>(path, {
      params: { page, per_page: first.meta.per_page }, signal,
    })
    clusters.push(...data.data)
  }
  return clusters.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

function formatEstimate(amount: number) {
  return fmtMoney(amount, 'USD')
}

function pct(rec?: number, req?: number) {
  if (!rec || !req || req === 0) return null
  const p = Math.round((1 - rec / req) * 100)
  return p > 0 ? `-${p}%` : `+${Math.abs(p)}%`
}

const COLORS = chartPalette

const K8S_COLUMN_KEYS: Record<string, string> = {
  Workload: 'k8sRightsizing.colWorkload',
  Namespace: 'k8sRightsizing.colNamespace',
  Cluster: 'k8sRightsizing.colCluster',
  'CPU Req→Rec': 'k8sRightsizing.colCpuReqRec',
  'Mem Req→Rec': 'k8sRightsizing.colMemReqRec',
  'Savings/mo': 'k8sRightsizing.colSavingsPerMo',
  'P95 CPU': 'k8sRightsizing.colP95Cpu',
  'P95 Mem': 'k8sRightsizing.colP95Mem',
}

export default function K8sRightsizing() {
  const orgId = useOrgStore(state => state.currentOrg?.id ?? '')
  return <WorkspaceRightsizing key={orgId} orgId={orgId} />
}

function WorkspaceRightsizing({ orgId }: { orgId: string }) {
  const { t } = useTranslation()
  const [clusterChoice, setClusterChoice] = useState('')
  const [namespaceChoice, setNamespaceChoice] = useState('')
  const [view, setView] = useState<'table' | 'summary'>('summary')

  const clustersQuery = useQuery({
    queryKey: ['k8s-clusters', orgId],
    queryFn: ({ signal }) => loadClusters(orgId, signal),
    enabled: !!orgId,
  })
  const clusterList = clustersQuery.data ?? []
  const cluster = clusterList.find(c => c.id === clusterChoice)
  const scopeClusters = cluster ? [cluster] : clusterList
  const namespaces = Array.from(new Set(scopeClusters.flatMap(c => c.namespaces))).sort()
  const namespace = namespaces.includes(namespaceChoice) ? namespaceChoice : ''
  const visibleClusters = scopeClusters.filter(c => !namespace || c.namespaces.includes(namespace))
  const filters = { cluster_id: cluster?.id, namespace: namespace || undefined }
  const summaryQuery = useQuery({
    queryKey: ['k8s-summary', orgId, filters],
    queryFn: ({ signal }) => api.get<Summary>(`/orgs/${orgId}/k8s/summary`, { params: filters, signal }).then(r => r.data),
    enabled: !!orgId,
  })
  const workloads = usePagination<Workload>(
    ['k8s-workloads', orgId, filters],
    (page, perPage) => paginatedGet<Workload>(`/orgs/${orgId}/k8s/workloads`, { ...filters, page, per_page: perPage }),
    { enabled: !!orgId && view === 'table' },
  )
  const sum = summaryQuery.data
  const savingsPct = sum && sum.total_cost > 0 ? Math.round((sum.total_savings / sum.total_cost) * 100) : 0

  const nsChartData = (sum?.top_namespaces ?? []).map((n, i) => ({
    name: n.namespace.length > 16 ? n.namespace.slice(0, 16) + '…' : n.namespace,
    savings: parseFloat(n.potential_savings.toFixed(2)),
    color: COLORS[i % COLORS.length],
  }))

  return (
    <div className="space-y-6">
      <div className="page-heading">
        <h1 className="page-title">{t('k8sRightsizing.title')}</h1>
        <p className="text-sm text-secondary mt-1">{t('k8sRightsizing.subtitle')}</p>
      </div>

      <div className="filter-bar">
        <div className="grid w-full min-w-0 max-w-full gap-3 sm:w-[28rem] sm:grid-cols-2">
          <SelectField
            id="rightsizing-cluster"
            name="rightsizing-cluster"
            label={t('k8sRightsizing.colCluster')}
            value={cluster?.id ?? ''}
            disabled={!clusterList.length}
            onValueChange={id => {
              setClusterChoice(id)
              const next = clusterList.find(c => c.id === id)
              if (next && !next.namespaces.includes(namespace)) setNamespaceChoice('')
            }}
            items={[
              { value: "", label: t('k8sRightsizing.allClusters') },
              ...clusterList.map(c => ({ value: c.id, label: c.name })),
            ]}
          />
          <SelectField
            id="rightsizing-namespace"
            name="rightsizing-namespace"
            label={t('k8sRightsizing.colNamespace')}
            value={namespace}
            onValueChange={setNamespaceChoice}
            disabled={!namespaces.length}
            items={[
              { value: "", label: t('k8sRightsizing.allNamespaces') },
              ...namespaces.map(ns => ({ value: ns, label: ns })),
            ]}
          />
        </div>
        {(cluster || namespace) && (
          <button type="button" className="text-link min-h-9 self-end" onClick={() => {
            setClusterChoice('')
            setNamespaceChoice('')
          }}>{t('k8sRightsizing.resetFilters')}</button>
        )}
        <div className="segmented-control ml-auto self-end" role="group" aria-label={t('k8sRightsizing.viewMode')}>
          {(['summary', 'table'] as const).map(v => (
            <button type="button" key={v} onClick={() => setView(v)} className="segment" aria-pressed={view === v}>
              {v === 'summary' ? t('k8sRightsizing.viewSummary') : t('k8sRightsizing.viewTable')}
            </button>
          ))}
        </div>
      </div>
      {clustersQuery.isError && <ReportQueryState query={clustersQuery}>{null}</ReportQueryState>}

      <ReportQueryState query={summaryQuery}>
        {sum && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-surface rounded-xl border border-strong p-5">
              <p className="text-xs text-secondary uppercase tracking-wider">{t('k8sRightsizing.clusters')}</p>
              <p className="text-2xl font-semibold text-primary mt-1">{sum.cluster_count}</p>
            </div>
            <div className="bg-surface rounded-xl border border-strong p-5">
              <p className="text-xs text-secondary uppercase tracking-wider">{t('k8sRightsizing.workloads')}</p>
              <p className="text-2xl font-semibold text-primary mt-1">{sum.workload_count}</p>
            </div>
            <div className="bg-surface rounded-xl border border-strong p-5">
              <p className="text-xs text-secondary uppercase tracking-wider">{t('k8sRightsizing.potentialSavingsPerMo')}</p>
              <p className="text-2xl font-semibold text-success mt-1">{formatEstimate(sum.total_savings)}</p>
            </div>
            <div className="bg-surface rounded-xl border border-strong p-5">
              <p className="text-xs text-secondary uppercase tracking-wider">{t('k8sRightsizing.savingsOpportunity')}</p>
              <p className="text-2xl font-semibold text-accent mt-1">{savingsPct}%</p>
              <p className="text-xs text-muted mt-1">{t('k8sRightsizing.ofTotalPerMo', { amount: formatEstimate(sum.total_cost) })}</p>
            </div>
          </div>
        )}
      </ReportQueryState>

      {view === 'summary' && sum && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Top over-allocated namespaces */}
          <div className="bg-surface rounded-xl border border-strong p-5">
            <h3 className="text-sm font-semibold text-secondary mb-4">{t('k8sRightsizing.topNamespaces')}</h3>
            {nsChartData.length === 0 ? (
              <p className="text-center py-10 text-muted text-sm">{t('k8sRightsizing.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={nsChartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <XAxis {...chartAxis} type="number" tickFormatter={formatEstimate} tick={{ fill: 'rgb(var(--text-muted))', fontSize: 11 }} />
                  <YAxis {...chartAxis} type="category" dataKey="name" width={100} tick={{ fill: 'rgb(var(--text-secondary))', fontSize: 11 }} />
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    formatter={(v: number) => [formatEstimate(v), t('k8sRightsizing.potentialSavings')]}
                  />
                  <Bar isAnimationActive={false} maxBarSize={32} dataKey="savings" radius={[0, 4, 4, 0]}>
                    {nsChartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Cluster cards */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-secondary">{t('k8sRightsizing.clusters')}</h3>
            {clustersQuery.isPending ? (
              <div className="skeleton h-20" />
            ) : visibleClusters.length === 0 && !clustersQuery.isError ? (
              <p className="text-muted text-sm">{t('k8sRightsizing.noClusters')}</p>
            ) : visibleClusters.map(c => (
              <div key={c.id} className="bg-subtle rounded-xl border border-strong p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium text-primary">{c.name}</p>
                  <p className="text-xs text-secondary mt-0.5">{t('k8sRightsizing.clusterMeta', { provider: providerLabel(c.provider), region: c.region ?? '?', nodes: c.node_count ?? 0 })}</p>
                  <p className="text-xs text-muted">{t('k8sRightsizing.workloadsTracked', { count: sum.cluster_totals[c.id]?.workload_count ?? 0 })}</p>
                </div>
                <div className="text-right">
                  <p className="text-success font-semibold text-sm">{formatEstimate(sum.cluster_totals[c.id]?.total_savings ?? 0)}</p>
                  <p className="text-xs text-muted">{t('k8sRightsizing.savingsOpportunityHint')}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === 'table' && (
        <ReportQueryState query={workloads.query}>
          <div className="bg-surface rounded-xl border border-strong overflow-x-auto">
            <div role="region" aria-label={t('design.dataTable')} className="table-scroll" tabIndex={0}><Table>
              <Table.Header variant="compact"><Table.Row className="border-b border-strong">
                {['Workload', 'Namespace', 'Cluster', 'CPU Req→Rec', 'Mem Req→Rec', 'Savings/mo', 'P95 CPU', 'P95 Mem'].map(h => (
                  <Table.Head key={h} className="px-4 py-3 text-left whitespace-nowrap">{t(K8S_COLUMN_KEYS[h])}</Table.Head>
                ))}
              </Table.Row></Table.Header>
              <Table.Body className="divide-y divide-edge">
                {workloads.query.isPlaceholderData ? (
                  <Table.Row><Table.Cell colSpan={8} className="px-4 py-10 text-center text-muted">{t('common.loading')}</Table.Cell></Table.Row>
                ) : workloads.rows.length === 0 ? (
                  <Table.Row><Table.Cell colSpan={8} className="px-4 py-10 text-center text-muted">{t('k8sRightsizing.noWorkloads')}</Table.Cell></Table.Row>
                ) : workloads.rows.map(w => (
                  <Table.Row key={w.id} className="hover:bg-subtle">
                    <Table.Cell className="px-4 py-3">
                      <p className="font-medium text-primary">{w.workload_name}</p>
                      <p className="text-xs text-muted">{w.workload_type}</p>
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary font-mono text-xs">{w.namespace}</Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary text-xs">{w.cluster_name}</Table.Cell>
                    <Table.Cell className="px-4 py-3">
                      {w.cpu_request_m != null && w.cpu_rec_m != null ? (
                        <span className="text-xs">
                          <span className="text-secondary">{w.cpu_request_m}m</span>
                          <span className="text-muted"> → </span>
                          <span className="text-success">{w.cpu_rec_m}m</span>
                          <span className="text-xs text-success ml-1">{pct(w.cpu_rec_m, w.cpu_request_m)}</span>
                        </span>
                      ) : '—'}
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3">
                      {w.mem_request_mi != null && w.mem_rec_mi != null ? (
                        <span className="text-xs">
                          <span className="text-secondary">{w.mem_request_mi}Mi</span>
                          <span className="text-muted"> → </span>
                          <span className="text-success">{w.mem_rec_mi}Mi</span>
                          <span className="text-xs text-success ml-1">{pct(w.mem_rec_mi, w.mem_request_mi)}</span>
                        </span>
                      ) : '—'}
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3">
                      {w.potential_savings != null && w.potential_savings > 0
                        ? <span className="text-success font-semibold">{formatEstimate(w.potential_savings)}</span>
                        : <span className="text-muted">—</span>}
                    </Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary text-xs">{w.cpu_p95_m != null ? `${Math.round(w.cpu_p95_m)}m` : '—'}</Table.Cell>
                    <Table.Cell className="px-4 py-3 text-secondary text-xs">{w.mem_p95_mi != null ? `${Math.round(w.mem_p95_mi)}Mi` : '—'}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table></div>
            {!workloads.query.isPlaceholderData && workloads.total > 0 && (
              <PaginationBar page={workloads.page} perPage={workloads.perPage} total={workloads.total}
                totalPages={workloads.totalPages} onPageChange={workloads.setPage} onPerPageChange={workloads.setPerPage} />
            )}
          </div>
        </ReportQueryState>
      )}
    </div>
  )
}
