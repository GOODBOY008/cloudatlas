import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import type { Pool } from '../types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface PoolTreeNode {
  id: string
  name: string
  description: string | null
  parent_id: string | null
  monthly_budget: number | null
  depth: number
  current_month_spend: number
  budget_used_pct: number | null
}

interface PoolTrendData {
  pool: { id: string; name: string; monthly_budget: number | null }
  history: Array<{ date: string; cost: number }>
  forecast: Array<{ date: string; predicted_cost: number }>
  summary: { month_spend: number; projected_month: number; budget_used_pct: number | null; trend: string }
}

interface PoolTopResource {
  cloud_resource_id: string
  resource_name?: string
  resource_type: string
  cloud_region?: string
  service_name?: string
  total_cost: number
  active_days: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function BudgetBar({ spend, budget }: { spend: number; budget: number }) {
  const { t } = useTranslation()
  const pct = budget > 0 ? Math.min((spend / budget) * 100, 100) : 0
  const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-indigo-500'
  return (
    <div className="mt-2">
      <div className="flex justify-between text-xs text-gray-400 mb-1">
        <span>{t('pools.spent', { amount: spend.toLocaleString(undefined, { maximumFractionDigits: 0 }) })}</span>
        <span>{t('pools.pctOfBudget', { pct: pct.toFixed(0), budget: budget.toLocaleString() })}</span>
      </div>
      <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

const tooltipStyle = { background: '#111827', border: '1px solid #374151', borderRadius: 8 }

// ─── Pool Detail Panel ────────────────────────────────────────────────────────

function PoolDetailPanel({
  pool,
  orgId,
  allPools,
  onClose,
}: {
  pool: Pool
  orgId: string
  allPools: Pool[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [moveTarget, setMoveTarget] = useState<string>('')
  const [showMove, setShowMove] = useState(false)

  const { data: trend, isLoading: trendLoading } = useQuery<PoolTrendData>({
    queryKey: ['pool-trend', orgId, pool.id],
    queryFn: async () => {
      const { data: res } = await api.get(`/orgs/${orgId}/pools/${pool.id}/trend`)
      return res as PoolTrendData
    },
  })

  const { data: topRes, isLoading: topLoading } = useQuery<{ pool_id: string; resources: PoolTopResource[]; daily: Array<{ date: string; cost: number }> }>({
    queryKey: ['pool-top-resources', orgId, pool.id],
    queryFn: async () => {
      const { data: res } = await api.get(`/orgs/${orgId}/pools/${pool.id}/top-resources`)
      return res as { pool_id: string; resources: PoolTopResource[]; daily: Array<{ date: string; cost: number }> }
    },
  })

  const moveMutation = useMutation({
    mutationFn: (parentId: string | null) =>
      api.patch(`/orgs/${orgId}/pools/${pool.id}/parent`, { parent_id: parentId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pools', orgId] })
      queryClient.invalidateQueries({ queryKey: ['pool-tree', orgId] })
      setShowMove(false)
    },
  })

  // Merge history + forecast for chart
  const forecastChartData = [
    ...(trend?.history.slice(-30) ?? []).map((h) => ({ date: h.date, cost: h.cost, forecast: null as number | null })),
    ...(trend?.forecast ?? []).map((f) => ({ date: f.date, cost: null as number | null, forecast: f.predicted_cost })),
  ]

  const validParents = allPools.filter((p) => p.id !== pool.id)

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <div className="w-[580px] bg-gray-950 border-l border-gray-800 flex flex-col overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h3 className="text-base font-semibold text-white">{pool.name}</h3>
            {pool.description && <p className="text-xs text-gray-500 mt-0.5">{pool.description}</p>}
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400">{t(`status.${pool.pool_type}`, { defaultValue: pool.pool_type })}</span>
              {pool.parent_id && <span className="text-xs text-gray-600">{t('pools.childPool')}</span>}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none mt-0.5">×</button>
        </div>

        <div className="flex-1 p-5 space-y-5">
          {/* Monthly summary cards */}
          {trend && (
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-900 rounded-lg p-3">
                <p className="text-xs text-gray-500">{t('pools.monthToDate')}</p>
                <p className="text-xl font-semibold text-white">${trend.summary.month_spend.toFixed(2)}</p>
              </div>
              <div className="bg-gray-900 rounded-lg p-3">
                <p className="text-xs text-gray-500">{t('pools.projectedMonthly')}</p>
                <p className={`text-xl font-semibold ${
                  pool.monthly_budget && trend.summary.projected_month > pool.monthly_budget ? 'text-red-400' : 'text-orange-300'
                }`}>${trend.summary.projected_month.toFixed(2)}</p>
              </div>
            </div>
          )}

          {/* Budget bar */}
          {pool.monthly_budget != null && trend && (
            <div className="bg-gray-900 rounded-lg p-3">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-gray-400">{t('pools.budgetUtilisation')}</p>
                <p className="text-xs text-gray-400">{t('pools.budgetPerMonth', { amount: pool.monthly_budget.toLocaleString() })}</p>
              </div>
              <BudgetBar spend={trend.summary.month_spend} budget={pool.monthly_budget} />
              {pool.monthly_budget && trend.summary.projected_month > pool.monthly_budget && (
                <p className="text-xs text-red-400 mt-1">{t('pools.exceedBudget', { amount: (trend.summary.projected_month - pool.monthly_budget).toFixed(2) })}</p>
              )}
            </div>
          )}

          {/* Trend chart with forecast */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-400">{t('pools.dailyForecast')}</p>
              {trend && (
                <span className={`text-xs px-2 py-0.5 rounded ${
                  trend.summary.trend === 'increasing' ? 'bg-red-900/40 text-red-300' :
                  trend.summary.trend === 'decreasing' ? 'bg-green-900/40 text-green-300' :
                  'bg-gray-800 text-gray-400'
                }`}>
                  {trend.summary.trend === 'increasing' ? t('pools.trendIncreasing') : trend.summary.trend === 'decreasing' ? t('pools.trendDecreasing') : t('pools.trendStable')}
                </span>
              )}
            </div>
            {trendLoading ? (
              <div className="h-[160px] animate-pulse bg-gray-800 rounded-lg" />
            ) : forecastChartData.length === 0 ? (
              <div className="h-[160px] flex items-center justify-center text-gray-500 text-sm">{t('pools.noSpendData')}</div>
            ) : (
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={forecastChartData}>
                  <defs>
                    <linearGradient id="poolTrendGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} interval={Math.floor(forecastChartData.length / 8)} />
                  <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} tickFormatter={(v: unknown) => `$${(v as number).toFixed(0)}`} />
                  <Tooltip
                    formatter={(v: unknown, name: string) => [`$${(v as number).toFixed(2)}`, name === 'cost' ? t('pools.actual') : t('pools.forecast')]}
                    contentStyle={tooltipStyle}
                  />
                  {pool.monthly_budget && (
                    <ReferenceLine
                      y={pool.monthly_budget / 30}
                      stroke="#f59e0b" strokeDasharray="4 2"
                      label={{ value: t('pools.dailyBudget'), fill: '#f59e0b', fontSize: 9 }}
                    />
                  )}
                  <Area type="monotone" dataKey="cost" stroke="#6366f1" fill="url(#poolTrendGrad)" strokeWidth={1.5} dot={false} connectNulls />
                  <Area type="monotone" dataKey="forecast" stroke="#f97316" fill="#f9731615" strokeWidth={1.5} strokeDasharray="4 2" dot={false} connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Top resources */}
          <div>
            <p className="text-xs text-gray-400 mb-2">{t('pools.topResources')}</p>
            {topLoading ? (
              <div className="h-[120px] animate-pulse bg-gray-800 rounded-lg" />
            ) : !topRes || topRes.resources.length === 0 ? (
              <div className="h-[80px] flex items-center justify-center text-gray-500 text-xs">{t('pools.noResourceExpenses')}</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={120}>
                  <BarChart data={topRes.resources.slice(0, 8).map((r) => ({
                    name: r.resource_name ?? r.cloud_resource_id.slice(-10),
                    cost: r.total_cost,
                  }))}>
                    <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 9 }} angle={-20} textAnchor="end" height={40} interval={0} />
                    <YAxis tick={{ fill: '#6b7280', fontSize: 9 }} tickFormatter={(v: unknown) => `$${(v as number).toFixed(0)}`} />
                    <Tooltip formatter={(v: unknown) => [`$${(v as number).toFixed(2)}`, t('pools.cost')]} contentStyle={tooltipStyle} />
                    <Bar dataKey="cost" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                <table className="w-full text-xs mt-2">
                  <thead>
                    <tr className="text-gray-500 text-left border-b border-gray-800">
                      <th className="pb-1">{t('pools.colResource')}</th>
                      <th className="pb-1">{t('common.type')}</th>
                      <th className="pb-1 text-right">{t('pools.cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topRes.resources.slice(0, 5).map((r) => (
                      <tr key={r.cloud_resource_id} className="border-b border-gray-800/30">
                        <td className="py-1.5 text-gray-300 truncate max-w-[160px]">{r.resource_name ?? r.cloud_resource_id.slice(-16)}</td>
                        <td className="py-1.5 text-gray-500">{r.resource_type}</td>
                        <td className="py-1.5 text-right text-yellow-400 font-mono">${r.total_cost.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>

          {/* Reparent pool */}
          <div className="border-t border-gray-800 pt-4">
            <button
              onClick={() => setShowMove((v) => !v)}
              className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              {showMove ? t('pools.cancelMove') : t('pools.movePool')}
            </button>
            {showMove && (
              <div className="mt-3 flex items-center gap-2">
                <select
                  value={moveTarget}
                  onChange={(e) => setMoveTarget(e.target.value)}
                  className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-xs"
                >
                  <option value="">{t('pools.rootOption')}</option>
                  {validParents.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <button
                  disabled={moveMutation.isPending}
                  onClick={() => moveMutation.mutate(moveTarget || null)}
                  className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs rounded-lg"
                >
                  {moveMutation.isPending ? t('pools.moving') : t('pools.apply')}
                </button>
              </div>
            )}
            {moveMutation.isError && (
              <p className="text-xs text-red-400 mt-1">{t('pools.moveFailed')}</p>
            )}
          </div>

          {/* Quick links */}
          <div className="border-t border-gray-800 pt-4 flex flex-wrap gap-2">
            <a href={`#/assignment-rules?pool_id=${pool.id}`} className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors">
              {t('pools.assignmentRules')}
            </a>
            <a href={`#/showback?pool_id=${pool.id}`} className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors">
              {t('pools.showbackReport')}
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Visual Pool Tree ─────────────────────────────────────────────────────────

function PoolTreeView({ nodes }: { nodes: PoolTreeNode[] }) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Build parent→children map
  const childrenOf = new Map<string | null, PoolTreeNode[]>()
  for (const n of nodes) {
    const key = n.parent_id
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key)!.push(n)
  }

  function renderNode(node: PoolTreeNode, depth: number): React.ReactNode {
    const children = childrenOf.get(node.id) ?? []
    const isCollapsed = collapsed.has(node.id)
    const pct = node.budget_used_pct
    const pctColor = pct == null ? '' : pct >= 90 ? 'text-red-400' : pct >= 70 ? 'text-yellow-400' : 'text-green-400'

    return (
      <div key={node.id}>
        <div
          className="flex items-center gap-2 px-4 py-2.5 hover:bg-gray-800/40 transition-colors group"
          style={{ paddingLeft: `${16 + depth * 20}px` }}
        >
          {children.length > 0 ? (
            <button onClick={() => toggle(node.id)} className="text-gray-500 hover:text-white w-4 text-center text-xs">
              {isCollapsed ? '▶' : '▼'}
            </button>
          ) : (
            <span className="w-4 text-gray-700 text-center text-xs">—</span>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm text-white">{node.name}</span>
              {node.description && <span className="text-xs text-gray-600 truncate max-w-[200px]">{node.description}</span>}
            </div>
            {node.monthly_budget != null && (
              <div className="mt-0.5 flex items-center gap-2">
                <div className="w-24 h-1 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      (pct ?? 0) >= 90 ? 'bg-red-500' : (pct ?? 0) >= 70 ? 'bg-yellow-500' : 'bg-indigo-500'
                    }`}
                    style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
                  />
                </div>
                <span className={`text-xs ${pctColor}`}>{(pct ?? 0).toFixed(0)}%</span>
              </div>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <p className="text-xs font-mono text-green-400">${node.current_month_spend.toFixed(2)}</p>
            {node.monthly_budget != null && (
              <p className="text-xs text-gray-500">{t('pools.ofBudget', { amount: node.monthly_budget.toLocaleString() })}</p>
            )}
          </div>
        </div>
        {!isCollapsed && children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  const roots = childrenOf.get(null) ?? []

  if (roots.length === 0) {
    return <div className="px-4 py-6 text-center text-gray-500 text-sm">{t('pools.treeEmpty')}</div>
  }

  return (
    <div className="divide-y divide-gray-800">
      {roots.map((n) => renderNode(n, 0))}
    </div>
  )
}

// ─── Main Component ────────────────────────────────────────────────────────────

interface NewPoolForm {
  name: string
  description: string
  pool_type: string
  parent_id: string
  monthly_budget: string
}

export default function Pools() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const [showForm, setShowForm] = useState(false)
  const [viewMode, setViewMode] = useState<'list' | 'tree'>('list')
  const [selectedPool, setSelectedPool] = useState<Pool | null>(null)
  const [form, setForm] = useState<NewPoolForm>({
    name: '', description: '', pool_type: 'default', parent_id: '', monthly_budget: '',
  })
  const [formError, setFormError] = useState('')
  const [editingPool, setEditingPool] = useState<Pool | null>(null)
  const [editForm, setEditForm] = useState({ name: '', description: '', monthly_budget: '' })
  const [confirmDeletePool, setConfirmDeletePool] = useState<Pool | null>(null)

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: pools = [], isLoading, isError } = useQuery<Pool[]>({
    queryKey: ['pools', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: Pool[] }>(`/orgs/${orgId}/pools`)
      return res.data ?? []
    },
  })

  const { data: poolTree = [] } = useQuery<PoolTreeNode[]>({
    queryKey: ['pool-tree', orgId],
    enabled: !!orgId && viewMode === 'tree',
    queryFn: async () => {
      const { data: res } = await api.get<{ data: PoolTreeNode[] }>(`/orgs/${orgId}/pools/tree`)
      return res.data ?? []
    },
  })

  // ── Mutations ──────────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: (payload: {
      name: string; description: string; pool_type: string;
      parent_id: string | null; monthly_budget: number | null
    }) => api.post(`/orgs/${orgId}/pools`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pools', orgId] })
      queryClient.invalidateQueries({ queryKey: ['pool-tree', orgId] })
      setForm({ name: '', description: '', pool_type: 'default', parent_id: '', monthly_budget: '' })
      setShowForm(false)
      setFormError('')
    },
    onError: () => setFormError(t('pools.createFailed')),
  })

  const updateMutation = useMutation({
    mutationFn: (payload: {
      id: string; name?: string; description?: string; monthly_budget?: number | null
    }) => api.put(`/orgs/${orgId}/pools/${payload.id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pools', orgId] })
      queryClient.invalidateQueries({ queryKey: ['pool-tree', orgId] })
      setEditingPool(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/pools/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pools', orgId] })
      queryClient.invalidateQueries({ queryKey: ['pool-tree', orgId] })
      if (selectedPool) setSelectedPool(null)
    },
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    createMutation.mutate({
      name: form.name.trim(),
      description: form.description.trim(),
      pool_type: form.pool_type,
      parent_id: form.parent_id || null,
      monthly_budget: form.monthly_budget ? parseFloat(form.monthly_budget) : null,
    })
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div>
      {selectedPool && orgId && (
        <PoolDetailPanel
          pool={selectedPool}
          orgId={orgId}
          allPools={pools}
          onClose={() => setSelectedPool(null)}
        />
      )}

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('pools.title')}</h2>
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="flex rounded-lg overflow-hidden border border-gray-700">
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 text-sm transition-colors ${viewMode === 'list' ? 'bg-gray-700 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'}`}
            >
              {t('pools.viewList')}
            </button>
            <button
              onClick={() => setViewMode('tree')}
              className={`px-3 py-1.5 text-sm transition-colors ${viewMode === 'tree' ? 'bg-gray-700 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'}`}
            >
              {t('pools.viewTree')}
            </button>
          </div>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {showForm ? t('common.cancel') : t('pools.newPool')}
          </button>
        </div>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <h3 className="text-sm font-semibold text-gray-200 mb-4">{t('pools.createTitle')}</h3>
          {formError && (
            <div className="mb-3 p-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-sm">{formError}</div>
          )}
          <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('common.name')} *</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder={t('pools.namePlaceholder')} />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('common.type')}</label>
              <select value={form.pool_type} onChange={(e) => setForm({ ...form, pool_type: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="default">{t('pools.poolTypeDefault')}</option>
                <option value="team">{t('pools.poolTypeTeam')}</option>
                <option value="project">{t('pools.poolTypeProject')}</option>
                <option value="environment">{t('pools.poolTypeEnvironment')}</option>
                <option value="cost_center">{t('pools.poolTypeCostCenter')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('pools.parentPool')}</label>
              <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="">{t('pools.noneRoot')}</option>
                {pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('common.description')}</label>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder={t('pools.descPlaceholder')} />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">{t('pools.monthlyBudget')}</label>
              <input type="number" min="0" step="0.01" value={form.monthly_budget}
                onChange={(e) => setForm({ ...form, monthly_budget: e.target.value })}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="10000" />
            </div>
            <div className="flex items-end">
              <button type="submit" disabled={createMutation.isPending}
                className="w-full px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors">
                {createMutation.isPending ? t('pools.creating') : t('pools.createPool')}
              </button>
            </div>
          </form>
        </div>
      )}

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('pools.loadFailed')}
        </div>
      )}

      {/* Tree view */}
      {viewMode === 'tree' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mb-6">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <p className="text-sm font-medium text-gray-300">{t('pools.hierarchyTitle')}</p>
            <p className="text-xs text-gray-500">{t('pools.hierarchyHint')}</p>
          </div>
          {poolTree.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-500 text-sm">{t('pools.treeDataEmpty')}</div>
          ) : (
            <PoolTreeView nodes={poolTree} />
          )}
        </div>
      )}

      {/* List view */}
      {viewMode === 'list' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {isLoading ? (
            <div className="px-4 py-8 text-center text-gray-500 text-sm">{t('common.loading')}</div>
          ) : pools.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-500 text-sm">
              {t('pools.noPools')}
            </div>
          ) : (
            <ul className="divide-y divide-gray-800">
              {pools.map((pool) => (
                <li key={pool.id}
                  className="px-5 py-4 hover:bg-gray-800/50 transition-colors cursor-pointer"
                  onClick={() => setSelectedPool(pool)}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-white">{pool.name}</p>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">{t(`status.${pool.pool_type}`, { defaultValue: pool.pool_type })}</span>
                        {pool.parent_id && (
                          <span className="text-xs text-gray-600">
                            ↪ {pools.find((p) => p.id === pool.parent_id)?.name ?? t('pools.child')}
                          </span>
                        )}
                      </div>
                      {pool.description && <p className="text-sm text-gray-400 mt-0.5">{pool.description}</p>}
                    </div>
                    <div className="text-right flex-shrink-0 flex items-center gap-3">
                      {pool.monthly_budget != null ? (
                        <span className="text-sm font-mono text-green-400">
                          {t('pools.perMonth', { amount: pool.monthly_budget.toLocaleString() })}
                        </span>
                      ) : (
                        <span className="text-sm text-gray-500">{t('pools.noBudget')}</span>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditForm({
                              name: pool.name,
                              description: pool.description ?? '',
                              monthly_budget: pool.monthly_budget?.toString() ?? '',
                            })
                            setEditingPool(pool)
                          }}
                          className="px-2.5 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200"
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmDeletePool(pool)
                          }}
                          className="px-2.5 py-1 text-xs rounded bg-red-900/40 hover:bg-red-800/50 text-red-300"
                        >
                          {t('common.delete')}
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── Edit Pool Modal ─────────────────────────────────────────────── */}
      {editingPool && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setEditingPool(null)} />
          <div className="relative bg-gray-900 rounded-xl border border-gray-700 p-6 w-full max-w-md space-y-4">
            <h3 className="text-lg font-semibold text-white">{t('pools.editTitle')}</h3>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">{t('common.name')}</label>
              <input
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">{t('common.description')}</label>
              <input
                value={editForm.description}
                onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">{t('pools.monthlyBudgetClear')}</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={editForm.monthly_budget}
                onChange={(e) => setEditForm((f) => ({ ...f, monthly_budget: e.target.value }))}
                className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setEditingPool(null)} className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg">{t('common.cancel')}</button>
              <button
                disabled={!editForm.name.trim() || updateMutation.isPending}
                onClick={() => updateMutation.mutate({
                  id: editingPool.id,
                  name: editForm.name.trim(),
                  description: editForm.description.trim() || undefined,
                  monthly_budget: editForm.monthly_budget.trim() ? parseFloat(editForm.monthly_budget) : null,
                })}
                className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg disabled:opacity-50"
              >
                {updateMutation.isPending ? t('pools.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirm Modal ────────────────────────────────────────── */}
      {confirmDeletePool && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setConfirmDeletePool(null)} />
          <div className="relative bg-gray-900 rounded-xl border border-gray-700 p-6 w-full max-w-sm space-y-4 text-center">
            <p className="text-white font-semibold">{t('pools.confirmDeleteTitle')}</p>
            <p className="text-sm text-gray-400">
              {t('pools.confirmDeleteBody', { name: confirmDeletePool.name })}
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setConfirmDeletePool(null)} className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg">{t('common.cancel')}</button>
              <button
                disabled={deleteMutation.isPending}
                onClick={() => { deleteMutation.mutate(confirmDeletePool.id); setConfirmDeletePool(null) }}
                className="flex-1 px-4 py-2 bg-red-700 hover:bg-red-600 text-white text-sm rounded-lg disabled:opacity-50"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


