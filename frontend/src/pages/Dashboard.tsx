import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { fmtMoney } from '../lib/format'
import { useOrgStore } from '../store/orgStore'
import type { DashboardSummary } from '../types'

interface TrendPoint {
  date: string
  cost: number
}

interface ForecastData {
  projected_monthly: number
  trend_percent: number
}

interface AnomalyItem {
  cloud_resource_id: string
  resource_name?: string
  z_score?: number
}

interface TopResource {
  cloud_resource_id: string
  resource_name?: string
  resource_type: string
  total_cost: number
  pool_name?: string
}

interface PoolTreeRow {
  id: string
  name: string
  current_month_cost?: number
  monthly_budget?: number | null
  budget_used_pct?: number | null
}

function StatCard({
  label,
  value,
  icon,
  color,
  onClick,
}: {
  label: string
  value: string | number
  icon: string
  color: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-center gap-4 text-left hover:border-gray-700 transition-colors"
    >
      <div className={`text-3xl w-12 h-12 flex items-center justify-center rounded-lg ${color}`}>
        {icon}
      </div>
      <div>
        <p className="text-gray-400 text-sm">{label}</p>
        <p className="text-2xl font-bold text-white">{value}</p>
      </div>
    </button>
  )
}

export default function Dashboard() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [seeding, setSeeding] = useState(false)

  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const { data, isLoading, isError } = useQuery<DashboardSummary>({
    // Show the onboarding banner when the org is empty.
    queryKey: ['dashboard', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const [expSummary, recSummary, poolsRes] = await Promise.allSettled([
        api.get<{ data: { total_cost: number; resource_count?: number } }>(`/orgs/${orgId}/expenses/summary`),
        api.get<{ data: { active_recommendations: number } }>(`/orgs/${orgId}/recommendations/summary`),
        api.get<{ data: unknown[] }>(`/orgs/${orgId}/pools`),
      ])
      return {
        total_cost: expSummary.status === 'fulfilled' ? (expSummary.value.data.data?.total_cost ?? 0) : 0,
        resource_count: expSummary.status === 'fulfilled' ? (expSummary.value.data.data?.resource_count ?? 0) : 0,
        active_recommendations: recSummary.status === 'fulfilled' ? (recSummary.value.data.data?.active_recommendations ?? 0) : 0,
        pool_count: poolsRes.status === 'fulfilled' ? ((poolsRes.value.data.data as unknown[])?.length ?? 0) : 0,
      } satisfies DashboardSummary
    },
  })

  useEffect(() => {
    if (data && !data.total_cost && !data.resource_count) setShowOnboarding(true)
  }, [data])

  const { data: trendData = [] } = useQuery<TrendPoint[]>({
    queryKey: ['expense-trend', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const end = new Date().toISOString().slice(0, 10)
      const start = new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10)
      const { data: res } = await api.get<{ data: TrendPoint[] }>(
        `/orgs/${orgId}/expenses/trend?start_date=${start}&end_date=${end}`,
      )
      return res.data ?? []
    },
  })

  const { data: topResources = [] } = useQuery<TopResource[]>({
    queryKey: ['dashboard-top-resources', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const end = new Date().toISOString().slice(0, 10)
      const start = new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10)
      const { data: res } = await api.get<{ data: TopResource[] }>(
        `/orgs/${orgId}/expenses/top-resources?start_date=${start}&end_date=${end}`,
      )
      return res.data ?? []
    },
  })

  const { data: poolTree = [] } = useQuery<PoolTreeRow[]>({
    queryKey: ['dashboard-pool-tree', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: PoolTreeRow[] }>(`/orgs/${orgId}/pools/tree`)
      return res.data ?? []
    },
  })

  const { data: forecastData } = useQuery<ForecastData>({
    queryKey: ['expense-forecast', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: ForecastData }>(
        `/orgs/${orgId}/expenses/forecast?days=30`,
      )
      return res.data ?? null
    },
    // Don't throw on failure — forecast is optional
    retry: false,
  })

  const { data: anomalies = [] } = useQuery<AnomalyItem[]>({
    queryKey: ['expense-anomalies', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: AnomalyItem[] }>(
        `/orgs/${orgId}/expenses/anomalies?days=7`,
      )
      return res.data ?? []
    },
    retry: false,
  })

  const summary: DashboardSummary = data ?? {
    total_cost: 0,
    resource_count: 0,
    active_recommendations: 0,
    pool_count: 0,
  }

  const poolsAttention = poolTree
    .filter((p) => (p.budget_used_pct ?? 0) >= 80)
    .sort((a, b) => (b.budget_used_pct ?? 0) - (a.budget_used_pct ?? 0))
    .slice(0, 5)

  return (
    <div>
      <h2 className="text-xl font-semibold text-white mb-6">{t('dashboard.title')}</h2>

      {showOnboarding && (
        <div className="mb-6 p-4 rounded-xl bg-indigo-900/30 border border-indigo-700 flex items-center justify-between gap-4">
          <div>
            <p className="text-white font-medium">{t('dashboard.onboardingTitle')}</p>
            <p className="text-sm text-gray-400 mt-0.5">{t('dashboard.onboardingBody')}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => {
                setSeeding(true)
                api.post(`/orgs/${orgId}/demo-data`).then(() => {
                  setShowOnboarding(false)
                  queryClient.invalidateQueries()
                }).finally(() => setSeeding(false))
              }}
              disabled={seeding}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg disabled:opacity-50"
            >
              {seeding ? t('common.loading') : t('dashboard.seedDemo')}
            </button>
            <button onClick={() => setShowOnboarding(false)} className="text-gray-400 hover:text-gray-200 text-xs">
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('dashboard.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="text-gray-400 text-sm">{t('common.loading')}</div>
      ) : (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard
              label={t('dashboard.totalCostMtd')}
              value={`$${summary.total_cost.toLocaleString()}`}
              icon="💰"
              color="bg-green-900/40"
              onClick={() => navigate('/expenses')}
            />
            <StatCard
              label={t('dashboard.resources')}
              value={summary.resource_count.toLocaleString()}
              icon="🖥"
              color="bg-blue-900/40"
              onClick={() => navigate('/cmdb')}
            />
            <StatCard
              label={t('dashboard.activeRecommendations')}
              value={summary.active_recommendations}
              icon="💡"
              color="bg-yellow-900/40"
              onClick={() => navigate('/recommendations')}
            />
            <StatCard
              label={t('dashboard.pools')}
              value={summary.pool_count}
              icon="🗂"
              color="bg-purple-900/40"
              onClick={() => navigate('/pools')}
            />
          </div>

          {/* Cost trend chart */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-4">
            <h3 className="text-sm font-medium text-gray-300 mb-4">{t('dashboard.costTrend')}</h3>
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={trendData}>
                  <defs>
                    <linearGradient id="dashCostGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: '#9ca3af', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: string) => v.slice(5)}
                  />
                  <YAxis
                    tick={{ fill: '#9ca3af', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: unknown) => `$${(v as number).toLocaleString()}`}
                  />
                  <Tooltip
                    contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8 }}
                    labelStyle={{ color: '#d1d5db' }}
                    formatter={(v: unknown) => [fmtMoney(v as number), t('dashboard.chartCost')]}
                  />
                  <Area
                    type="monotone"
                    dataKey="cost"
                    stroke="#6366f1"
                    strokeWidth={2}
                    fill="url(#dashCostGrad)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[220px] flex items-center justify-center text-gray-500 text-sm">
                {t('dashboard.noTrendData')}
              </div>
            )}
          </div>

          {/* Two-column: Forecast + Anomalies */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* 30-Day Forecast card */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <h3 className="text-white font-semibold mb-1">{t('dashboard.forecast30d')}</h3>
              <p className="text-gray-400 text-sm mb-3">{t('dashboard.forecastBasis')}</p>
              {forecastData ? (
                <>
                  <p className="text-2xl font-bold text-blue-400">
                    ${forecastData.projected_monthly.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                  <p className="text-sm text-gray-400 mt-1">{t('dashboard.projectedMonthly')}</p>
                  <span
                    className={`text-sm font-medium ${forecastData.trend_percent > 0 ? 'text-red-400' : 'text-green-400'}`}
                  >
                    {forecastData.trend_percent > 0 ? '↑' : '↓'}{' '}
                    {t('dashboard.trendVsLastMonth', { percent: Math.abs(forecastData.trend_percent).toFixed(1) })}
                  </span>
                </>
              ) : (
                <p className="text-gray-500 text-sm">{t('dashboard.forecastUnavailable')}</p>
              )}
            </div>

            {/* Anomalies card */}
            {anomalies.length > 0 ? (
              <div className="bg-orange-900/20 border border-orange-800/40 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span>⚠️</span>
                  <h3 className="text-orange-300 font-semibold">{t('dashboard.anomaliesDetected')}</h3>
                </div>
                <p className="text-gray-400 text-sm mb-3">
                  {t('dashboard.anomaliesSummary', { count: anomalies.length })}
                </p>
                {anomalies.slice(0, 3).map((a) => (
                  <div key={a.cloud_resource_id} className="flex justify-between text-sm mt-1">
                    <span className="text-gray-300 truncate">{a.resource_name ?? a.cloud_resource_id}</span>
                    <span className="text-orange-400 ml-2 flex-shrink-0">
                      {a.z_score != null ? `Z=${a.z_score.toFixed(1)}` : t('dashboard.anomaly')}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <div className="flex items-center gap-2 mb-1">
                  <span>✅</span>
                  <h3 className="text-gray-300 font-semibold">{t('dashboard.noAnomalies')}</h3>
                </div>
                <p className="text-gray-500 text-sm">{t('dashboard.noAnomaliesBody')}</p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-white font-semibold">{t('dashboard.topResources')}</h3>
                <button onClick={() => navigate('/expenses')} className="text-xs text-indigo-400 hover:text-indigo-300">{t('dashboard.openExpenses')}</button>
              </div>
              {topResources.length === 0 ? (
                <p className="text-gray-500 text-sm">{t('dashboard.noTopResources')}</p>
              ) : (
                <div className="space-y-2">
                  {topResources.slice(0, 5).map((r) => (
                    <div key={r.cloud_resource_id} className="flex items-center justify-between text-sm border-b border-gray-800 pb-2">
                      <div className="min-w-0 pr-3">
                        <p className="text-gray-200 truncate">{r.resource_name || r.cloud_resource_id}</p>
                        <p className="text-gray-500 text-xs">{r.resource_type}{r.pool_name ? ` · ${r.pool_name}` : ''}</p>
                      </div>
                      <span className="text-green-400 font-mono">{fmtMoney(r.total_cost)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-white font-semibold">{t('dashboard.poolsAttention')}</h3>
                <button onClick={() => navigate('/pools')} className="text-xs text-indigo-400 hover:text-indigo-300">{t('dashboard.openPools')}</button>
              </div>
              {poolsAttention.length === 0 ? (
                <p className="text-gray-500 text-sm">{t('dashboard.noPoolsAttention')}</p>
              ) : (
                <div className="space-y-2">
                  {poolsAttention.map((p) => (
                    <div key={p.id} className="flex items-center justify-between text-sm border-b border-gray-800 pb-2">
                      <div>
                        <p className="text-gray-200">{p.name}</p>
                        <p className="text-gray-500 text-xs">{fmtMoney(p.current_month_cost ?? 0)} / {fmtMoney(p.monthly_budget ?? 0)}</p>
                      </div>
                      <span className="text-orange-400 font-medium">{(p.budget_used_pct ?? 0).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
