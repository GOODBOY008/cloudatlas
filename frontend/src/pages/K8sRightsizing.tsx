import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'
import { providerLabel } from '../lib/providers'

interface Cluster { id: string; name: string; region?: string; provider?: string; node_count?: number; total_vcpu?: number; total_memory_gb?: number; monthly_cost?: number; workload_count: number; total_savings: number }
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
interface Summary { cluster_count: number; namespace_count: number; workload_count: number; total_savings: number; total_cost: number; top_namespaces: { namespace: string; cluster_id: string; workload_count: number; potential_savings: number }[] }

function fmt(v: number) { return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
function pct(rec?: number, req?: number) {
  if (!rec || !req || req === 0) return null
  const p = Math.round((1 - rec / req) * 100)
  return p > 0 ? `-${p}%` : `+${Math.abs(p)}%`
}

const COLORS = ['#6366f1','#8b5cf6','#ec4899','#f43f5e','#f97316','#eab308','#22d3ee','#10b981','#3b82f6','#a78bfa']

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
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id ?? ''
  const { t } = useTranslation()

  const [selectedCluster, setSelectedCluster] = useState<string>('')
  const [namespaceFilter, setNamespaceFilter] = useState('')
  const [view, setView] = useState<'table' | 'summary'>('summary')

  const { data: summary } = useQuery({
    queryKey: ['k8s-summary', orgId],
    queryFn: () => api.get<Summary>(`/orgs/${orgId}/k8s/summary`).then(r => r.data),
    enabled: !!orgId,
  })

  const { data: clusters } = useQuery({
    queryKey: ['k8s-clusters', orgId],
    queryFn: () => api.get<{ data: Cluster[] }>(`/orgs/${orgId}/k8s/clusters`).then(r => r.data.data ?? []),
    enabled: !!orgId,
  })

  const { data: workloads, isLoading: wLoading } = useQuery({
    queryKey: ['k8s-workloads', orgId, selectedCluster, namespaceFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (selectedCluster) params.set('cluster_id', selectedCluster)
      if (namespaceFilter) params.set('namespace', namespaceFilter)
      return api.get<{ data: Workload[] }>(`/orgs/${orgId}/k8s/workloads?${params}`).then(r => r.data.data ?? [])
    },
    enabled: !!orgId,
  })

  const clusterList = clusters ?? []
  const workloadList = workloads ?? []
  const sum = summary ?? { cluster_count: 0, namespace_count: 0, workload_count: 0, total_savings: 0, total_cost: 0, top_namespaces: [] }
  const savingsPct = sum.total_cost > 0 ? Math.round((sum.total_savings / sum.total_cost) * 100) : 0

  const nsChartData = sum.top_namespaces.map((n, i) => ({
    name: n.namespace.length > 16 ? n.namespace.slice(0, 16) + '…' : n.namespace,
    savings: parseFloat(n.potential_savings.toFixed(2)),
    color: COLORS[i % COLORS.length],
  }))

  // All namespaces for filter suggestions
  const allNamespaces = Array.from(new Set(workloadList.map(w => w.namespace))).sort()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">{t('k8sRightsizing.title')}</h1>
        <p className="text-sm text-gray-400 mt-1">{t('k8sRightsizing.subtitle')}</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider">{t('k8sRightsizing.clusters')}</p>
          <p className="text-2xl font-bold text-white mt-1">{sum.cluster_count}</p>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider">{t('k8sRightsizing.workloads')}</p>
          <p className="text-2xl font-bold text-white mt-1">{sum.workload_count}</p>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider">{t('k8sRightsizing.potentialSavingsPerMo')}</p>
          <p className="text-2xl font-bold text-green-400 mt-1">{fmt(sum.total_savings)}</p>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <p className="text-xs text-gray-400 uppercase tracking-wider">{t('k8sRightsizing.savingsOpportunity')}</p>
          <p className="text-2xl font-bold text-indigo-400 mt-1">{savingsPct}%</p>
          <p className="text-xs text-gray-500 mt-1">{t('k8sRightsizing.ofTotalPerMo', { amount: fmt(sum.total_cost) })}</p>
        </div>
      </div>

      {/* Cluster filter row */}
      <div className="flex gap-3 items-center flex-wrap">
        <select value={selectedCluster} onChange={e => setSelectedCluster(e.target.value)}
          className="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white">
          <option value="">{t('k8sRightsizing.allClusters')}</option>
          {clusterList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input value={namespaceFilter} onChange={e => setNamespaceFilter(e.target.value)}
          placeholder={t('k8sRightsizing.filterByNamespace')}
          list="ns-list"
          className="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white w-56" />
        <datalist id="ns-list">{allNamespaces.map(n => <option key={n} value={n} />)}</datalist>
        <div className="ml-auto flex gap-2">
          {(['summary', 'table'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-2 text-xs rounded-lg font-medium capitalize transition ${view === v ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
              {v === 'summary' ? t('k8sRightsizing.viewSummary') : t('k8sRightsizing.viewTable')}
            </button>
          ))}
        </div>
      </div>

      {view === 'summary' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Top over-allocated namespaces */}
          <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
            <h3 className="text-sm font-semibold text-gray-300 mb-4">{t('k8sRightsizing.topNamespaces')}</h3>
            {nsChartData.length === 0 ? (
              <p className="text-center py-10 text-gray-500 text-sm">{t('k8sRightsizing.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={nsChartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <XAxis type="number" tickFormatter={v => `$${v}`} tick={{ fill: '#9ca3af', fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" width={100} tick={{ fill: '#d1d5db', fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
                    formatter={(v: number) => [fmt(v), t('k8sRightsizing.potentialSavings')]}
                  />
                  <Bar dataKey="savings" radius={[0, 4, 4, 0]}>
                    {nsChartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Cluster cards */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-300">{t('k8sRightsizing.clusters')}</h3>
            {clusterList.length === 0 ? (
              <p className="text-gray-500 text-sm">{t('k8sRightsizing.noClusters')}</p>
            ) : clusterList.map(c => (
              <div key={c.id} className="bg-gray-800 rounded-xl border border-gray-700 p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium text-white">{c.name}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{t('k8sRightsizing.clusterMeta', { provider: providerLabel(c.provider), region: c.region ?? '?', nodes: c.node_count ?? 0 })}</p>
                  <p className="text-xs text-gray-500">{t('k8sRightsizing.workloadsTracked', { count: c.workload_count })}</p>
                </div>
                <div className="text-right">
                  <p className="text-green-400 font-semibold text-sm">{fmt(c.total_savings)}</p>
                  <p className="text-xs text-gray-500">{t('k8sRightsizing.savingsOpportunityHint')}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === 'table' && (
        <div className="bg-gray-900 rounded-xl border border-gray-700 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-700">
              {['Workload', 'Namespace', 'Cluster', 'CPU Req→Rec', 'Mem Req→Rec', 'Savings/mo', 'P95 CPU', 'P95 Mem'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">{t(K8S_COLUMN_KEYS[h])}</th>
              ))}
            </tr></thead>
            <tbody className="divide-y divide-gray-800">
              {wLoading ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-500">{t('common.loading')}</td></tr>
              ) : workloadList.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-gray-500">{t('k8sRightsizing.noWorkloads')}</td></tr>
              ) : workloadList.map(w => (
                <tr key={w.id} className="hover:bg-gray-800">
                  <td className="px-4 py-3">
                    <p className="font-medium text-white">{w.workload_name}</p>
                    <p className="text-xs text-gray-500">{w.workload_type}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-300 font-mono text-xs">{w.namespace}</td>
                  <td className="px-4 py-3 text-gray-300 text-xs">{w.cluster_name}</td>
                  <td className="px-4 py-3">
                    {w.cpu_request_m != null && w.cpu_rec_m != null ? (
                      <span className="text-xs">
                        <span className="text-gray-300">{w.cpu_request_m}m</span>
                        <span className="text-gray-500"> → </span>
                        <span className="text-green-400">{w.cpu_rec_m}m</span>
                        <span className="text-xs text-green-500 ml-1">{pct(w.cpu_rec_m, w.cpu_request_m)}</span>
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {w.mem_request_mi != null && w.mem_rec_mi != null ? (
                      <span className="text-xs">
                        <span className="text-gray-300">{w.mem_request_mi}Mi</span>
                        <span className="text-gray-500"> → </span>
                        <span className="text-green-400">{w.mem_rec_mi}Mi</span>
                        <span className="text-xs text-green-500 ml-1">{pct(w.mem_rec_mi, w.mem_request_mi)}</span>
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {w.potential_savings != null && w.potential_savings > 0
                      ? <span className="text-green-400 font-semibold">{fmt(w.potential_savings)}</span>
                      : <span className="text-gray-500">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-300 text-xs">{w.cpu_p95_m != null ? `${Math.round(w.cpu_p95_m)}m` : '—'}</td>
                  <td className="px-4 py-3 text-gray-300 text-xs">{w.mem_p95_mi != null ? `${Math.round(w.mem_p95_mi)}Mi` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
