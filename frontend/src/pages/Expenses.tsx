import { useState, useMemo, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import api, { paginatedGet } from '../lib/api'
import { usePagination } from '../lib/hooks/usePagination'
import PaginationBar from '../components/PaginationBar'
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ComposedChart,
  Line,
  ReferenceLine,
} from 'recharts'
import { useOrgStore } from '../store/orgStore'
import { useTranslation } from 'react-i18next'
import type { Expense, CloudAccount } from '../types'

const DATE_RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'MTD', days: null },
]

const RESOURCE_TYPES = [
  'instance', 'volume', 'snapshot', 'bucket', 'rds_instance', 'load_balancer', 'ip_address',
]

const ANALYSIS_TABS = [
  'Overview', 'By Service', 'By Region', 'By Cloud', 'By Pool',
  'Trend', 'Top Resources', 'Forecast', 'Anomalies', 'RI Coverage', 'By Tag',
]

const PIE_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444']

interface AggItem { name: string; total_cost: number }
interface TrendPoint { date: string; cost: number }
interface TopResource {
  cloud_resource_id: string
  resource_name?: string
  resource_type: string
  total_cost: number
  pool_name?: string
}
interface AnomalyEntry {
  date: string
  cloud_resource_id: string
  resource_name?: string
  resource_type: string
  cost: number
  mean_cost: number
  z_score: number
  deviation_pct: number
}
interface TagKey { tag_key: string; total_cost: number; values: { tag_value: string; cost: number; pct: number }[] }
interface RiCoverage {
  ri_count: number; sp_count: number; total_instances: number
  coverage_pct: number; on_demand_cost: number; commitment_cost: number; potential_savings: number
}
interface ResourceHistoryPoint { date: string; cost: number }

function getDateRange(days: number | null): { startDate: string; endDate: string } {
  const end = new Date()
  const endDate = end.toISOString().slice(0, 10)
  if (days === null) {
    const startDate = new Date(end.getFullYear(), end.getMonth(), 1).toISOString().slice(0, 10)
    return { startDate, endDate }
  }
  const start = new Date(Date.now() - (days - 1) * 86400_000)
  return { startDate: start.toISOString().slice(0, 10), endDate }
}

function aggregateByGranularity(points: Array<{ date: string; cost: number }>, granularity: 'daily' | 'weekly' | 'monthly') {
  const map = new Map<string, number>()
  for (const e of points) {
    const d = new Date(e.date)
    const year = d.getUTCFullYear()
    const month = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    let key = `${year}-${month}-${day}`
    if (granularity === 'monthly') key = `${year}-${month}`
    else if (granularity === 'weekly') {
      const jan1 = new Date(Date.UTC(year, 0, 1))
      const week = Math.ceil((((d.getTime() - jan1.getTime()) / 86400000) + jan1.getUTCDay() + 1) / 7)
      key = `${year}-W${String(week).padStart(2, '0')}`
    }
    map.set(key, (map.get(key) ?? 0) + e.cost)
  }
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
    .map(([date, cost]) => ({ date, cost: +cost.toFixed(2) }))
}

function normalizeAgg(item: Record<string, unknown>): AggItem {
  const name = String(item.name ?? item.service_name ?? item.region ?? item.account_name ?? item.pool_name ?? 'Unknown')
  const total = Number(item.total_cost ?? item.cost ?? 0)
  return { name, total_cost: Number.isFinite(total) ? total : 0 }
}

function previousPeriod(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1)
  const prevEnd = new Date(start.getTime() - 86400000)
  const prevStart = new Date(prevEnd.getTime() - (spanDays - 1) * 86400000)
  return {
    prevStartDate: prevStart.toISOString().slice(0, 10),
    prevEndDate: prevEnd.toISOString().slice(0, 10),
  }
}

const tooltipStyle = { background: '#111827', border: '1px solid #374151', borderRadius: 8 }
const axisTickStyle = { fill: '#9ca3af', fontSize: 11 }

const META_FIELD_LABELS: Record<string, string> = {
  resource_type: 'expenses.fieldResourceType',
  cloud_region: 'expenses.fieldCloudRegion',
  service_name: 'expenses.fieldServiceName',
  pool_name: 'expenses.fieldPoolName',
}

const ANALYSIS_TAB_KEYS: Record<string, string> = {
  Overview: 'expenses.tabOverview',
  'By Service': 'expenses.tabByService',
  'By Region': 'expenses.tabByRegion',
  'By Cloud': 'expenses.tabByCloud',
  'By Pool': 'expenses.tabByPool',
  Trend: 'expenses.tabTrend',
  'Top Resources': 'expenses.tabTopResources',
  Forecast: 'expenses.tabForecast',
  Anomalies: 'expenses.tabAnomalies',
  'RI Coverage': 'expenses.tabRiCoverage',
  'By Tag': 'expenses.tabByTag',
}

// ─── Resource Drill-Down Panel ─────────────────────────────────────────────────

function ResourceHistoryPanel({
  orgId,
  resourceId,
  startDate,
  endDate,
  onClose,
}: {
  orgId: string
  resourceId: string
  startDate: string
  endDate: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery<{
    resource?: {
      resource_name?: string
      resource_type?: string
      cloud_region?: string
      service_name?: string
      pool_name?: string
      tags?: Record<string, string>
    }
    daily: ResourceHistoryPoint[]
    summary: { current_cost: number; prev_cost: number; delta_pct: number; period_days: number }
  }>({
    queryKey: ['resource-history', orgId, resourceId, startDate, endDate],
    queryFn: async () => {
      const { data: res } = await api.get(
        `/orgs/${orgId}/expenses/resources/${encodeURIComponent(resourceId)}/history`,
        { params: { start_date: startDate, end_date: endDate } },
      )
      return res
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <div className="w-[500px] bg-gray-950 border-l border-gray-800 flex flex-col overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <p className="text-sm font-semibold text-white truncate max-w-[360px]">
              {(data?.resource?.resource_name as string) ?? resourceId}
            </p>
            <p className="text-xs text-gray-500 mt-0.5 truncate max-w-[360px]">{resourceId}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">{t('common.loading')}</div>
        ) : !data ? (
          <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">{t('expenses.noData')}</div>
        ) : (
          <div className="flex-1 p-5 space-y-5">
            {/* Meta */}
            {data.resource && (
              <div className="grid grid-cols-2 gap-3 text-xs">
                {(['resource_type', 'cloud_region', 'service_name', 'pool_name'] as const).map((k) =>
                  data.resource![k] != null ? (
                    <div key={k}>
                      <p className="text-gray-500 capitalize">{t(META_FIELD_LABELS[k])}</p>
                      <p className="text-gray-200 font-medium">{data.resource![k]}</p>
                    </div>
                  ) : null
                )}
              </div>
            )}

            {/* Period comparison */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-900 rounded-lg p-3">
                <p className="text-xs text-gray-500">{t('expenses.currentPeriod')}</p>
                <p className="text-lg font-semibold text-white">${data.summary.current_cost.toFixed(2)}</p>
              </div>
              <div className="bg-gray-900 rounded-lg p-3">
                <p className="text-xs text-gray-500">{t('expenses.vsPrevious')}</p>
                <p className={`text-lg font-semibold ${data.summary.delta_pct > 0 ? 'text-red-400' : data.summary.delta_pct < 0 ? 'text-green-400' : 'text-gray-400'}`}>
                  {data.summary.delta_pct > 0 ? '↑' : data.summary.delta_pct < 0 ? '↓' : '•'} {Math.abs(data.summary.delta_pct).toFixed(1)}%
                </p>
              </div>
            </div>

            {/* Daily cost chart */}
            <div>
              <p className="text-xs text-gray-400 mb-2">{t('expenses.dailyCost')}</p>
              {data.daily.length === 0 ? (
                <div className="h-[140px] flex items-center justify-center text-gray-500 text-sm">{t('expenses.noHistory')}</div>
              ) : (
                <ResponsiveContainer width="100%" height={140}>
                  <AreaChart data={data.daily}>
                    <defs>
                      <linearGradient id="rhGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} tickFormatter={(v: unknown) => `$${(v as number).toFixed(0)}`} />
                    <Tooltip formatter={(v: unknown) => [`$${(v as number).toFixed(2)}`, t('expenses.chartCost')]} contentStyle={tooltipStyle} />
                    <Area type="monotone" dataKey="cost" stroke="#6366f1" fill="url(#rhGrad)" strokeWidth={1.5} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Tags */}
            {data.resource?.tags && Object.keys(data.resource.tags).length > 0 && (
              <div>
                <p className="text-xs text-gray-400 mb-2">{t('cmdb.tags')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(data.resource.tags).map(([k, v]) => (
                    <span key={k} className="px-2 py-0.5 rounded bg-gray-800 text-xs text-gray-300">
                      {k}: {v}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function Expenses() {
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const { t } = useTranslation()

  const [activeRange, setActiveRange] = useState(1)
  const [accountFilter, setAccountFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [regionFilter, setRegionFilter] = useState('')
  const [activeTab, setActiveTab] = useState('Overview')
  const [granularity, setGranularity] = useState<'daily' | 'weekly' | 'monthly'>('daily')
  const [selectedResource, setSelectedResource] = useState<string | null>(null)
  const [expandedTagKey, setExpandedTagKey] = useState<string | null>(null)

  const { startDate, endDate } = getDateRange(DATE_RANGES[activeRange].days)
  const { prevStartDate, prevEndDate } = previousPeriod(startDate, endDate)

  const { data: cloudAccounts = [] } = useQuery<CloudAccount[]>({
    queryKey: ['cloud-accounts', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: CloudAccount[] }>(`/orgs/${orgId}/cloud-accounts`)
      return res.data ?? []
    },
  })

  // Line items — server-paginated; every filter is part of the query key so a
  // filter change resets to page 1 (see usePagination).
  const { query: expensesQuery, rows, page, perPage, totalPages, setPage, setPerPage } =
    usePagination<Expense>(
      ['expenses', orgId, startDate, endDate, accountFilter, typeFilter, regionFilter],
      (p, pp) =>
        paginatedGet<Expense>(`/orgs/${orgId}/expenses`, {
          page: p,
          per_page: pp,
          start_date: startDate,
          end_date: endDate,
          ...(accountFilter ? { cloud_account_id: accountFilter } : {}),
          ...(typeFilter ? { resource_type: typeFilter } : {}),
          ...(regionFilter ? { cloud_region: regionFilter } : {}),
        }),
      { defaultPerPage: 50, enabled: !!orgId },
    )
  const { isLoading, isError } = expensesQuery

  // Period totals for the KPI — unfiltered, matching the previous-period
  // summary so the comparison stays apples-to-apples when the table is filtered.
  const { data: currentSummary } = useQuery<{ total_cost: number }>({
    queryKey: ['expenses-summary-current', orgId, startDate, endDate],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: { total_cost: number } }>(
        `/orgs/${orgId}/expenses/summary?start_date=${startDate}&end_date=${endDate}`,
      )
      return res.data ?? { total_cost: 0 }
    },
  })

  const { data: byService = [], isLoading: byServiceLoading } = useQuery<AggItem[]>({
    queryKey: ['expenses-by-service', orgId, startDate, endDate],
    enabled: !!orgId && activeTab === 'By Service',
    queryFn: async () => {
      const { data: res } = await api.get<{ data: AggItem[] }>(
        `/orgs/${orgId}/expenses/by-service?start_date=${startDate}&end_date=${endDate}`,
      )
      return (res.data ?? []).map((row) => normalizeAgg(row as unknown as Record<string, unknown>))
    },
  })

  // Region breakdown drives both the By Region tab and the region filter
  // options (the line-items list no longer loads every row to derive them).
  const { data: byRegion = [], isLoading: byRegionLoading } = useQuery<AggItem[]>({
    queryKey: ['expenses-by-region', orgId, startDate, endDate],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: AggItem[] }>(
        `/orgs/${orgId}/expenses/by-region?start_date=${startDate}&end_date=${endDate}`,
      )
      return (res.data ?? []).map((row) => normalizeAgg(row as unknown as Record<string, unknown>))
    },
  })

  const { data: byCloud = [], isLoading: byCloudLoading } = useQuery<AggItem[]>({
    queryKey: ['expenses-by-cloud', orgId, startDate, endDate],
    enabled: !!orgId && activeTab === 'By Cloud',
    queryFn: async () => {
      const { data: res } = await api.get<{ data: AggItem[] }>(
        `/orgs/${orgId}/expenses/by-cloud?start_date=${startDate}&end_date=${endDate}`,
      )
      return (res.data ?? []).map((row) => normalizeAgg(row as unknown as Record<string, unknown>))
    },
  })

  const { data: byPool = [], isLoading: byPoolLoading } = useQuery<AggItem[]>({
    queryKey: ['expenses-by-pool', orgId, startDate, endDate],
    enabled: !!orgId && activeTab === 'By Pool',
    queryFn: async () => {
      const { data: res } = await api.get<{ data: AggItem[] }>(
        `/orgs/${orgId}/expenses/by-pool?start_date=${startDate}&end_date=${endDate}`,
      )
      return (res.data ?? []).map((row) => normalizeAgg(row as unknown as Record<string, unknown>))
    },
  })

  const { data: previousSummary } = useQuery<{ total_cost: number }>({
    queryKey: ['expenses-summary-previous', orgId, prevStartDate, prevEndDate],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: { total_cost: number } }>(
        `/orgs/${orgId}/expenses/summary?start_date=${prevStartDate}&end_date=${prevEndDate}`,
      )
      return res.data ?? { total_cost: 0 }
    },
  })

  // Daily trend (server aggregate) — feeds the Overview chart and the Trend
  // tab; the paged line-items list must never back a chart.
  const { data: trendData = [], isLoading: trendLoading } = useQuery<TrendPoint[]>({
    queryKey: ['expenses-trend', orgId, startDate, endDate],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: TrendPoint[] }>(
        `/orgs/${orgId}/expenses/trend?start_date=${startDate}&end_date=${endDate}`,
      )
      return res.data ?? []
    },
  })

  // ── Top Resources ──────────────────────────────────────────────────────────
  const { data: topResources = [], isLoading: topResourcesLoading } = useQuery<TopResource[]>({
    queryKey: ['expenses-top-resources', orgId, startDate, endDate],
    enabled: !!orgId && activeTab === 'Top Resources',
    queryFn: async () => {
      const { data: res } = await api.get<{ data: TopResource[] }>(
        `/orgs/${orgId}/expenses/top-resources?start_date=${startDate}&end_date=${endDate}`,
      )
      return res.data ?? []
    },
  })

  // ── Forecast ──────────────────────────────────────────────────────────────
  const { data: forecastData, isLoading: forecastLoading } = useQuery<{
    history: TrendPoint[]
    forecast: Array<{ date: string; predicted_cost: number; lower: number; upper: number }>
    summary: { projected_monthly: number; trend_direction: string; change_percent: number }
  }>({
    queryKey: ['expenses-forecast', orgId],
    enabled: !!orgId && activeTab === 'Forecast',
    queryFn: async () => {
      const { data: res } = await api.get(`/orgs/${orgId}/expenses/forecast?days=30`)
      return res
    },
  })

  // ── Anomalies ─────────────────────────────────────────────────────────────
  const { data: anomaliesData, isLoading: anomaliesLoading } = useQuery<{ anomalies: AnomalyEntry[] }>({
    queryKey: ['expenses-anomalies', orgId],
    enabled: !!orgId && activeTab === 'Anomalies',
    queryFn: async () => {
      const { data: res } = await api.get(`/orgs/${orgId}/expenses/anomalies?days=14`)
      return res
    },
  })

  // ── RI Coverage ───────────────────────────────────────────────────────────
  const { data: riData, isLoading: riLoading } = useQuery<{ data: RiCoverage }>({
    queryKey: ['ri-coverage', orgId],
    enabled: !!orgId && activeTab === 'RI Coverage',
    queryFn: async () => {
      const { data: res } = await api.get(`/orgs/${orgId}/ri-coverage`)
      return res
    },
  })

  // ── By Tag ────────────────────────────────────────────────────────────────
  const { data: tagBreakdown = [], isLoading: tagLoading } = useQuery<TagKey[]>({
    queryKey: ['expenses-by-tag-breakdown', orgId, startDate, endDate],
    enabled: !!orgId && activeTab === 'By Tag',
    queryFn: async () => {
      const { data: res } = await api.get<{ data: TagKey[] }>(
        `/orgs/${orgId}/expenses/by-tag-breakdown?start_date=${startDate}&end_date=${endDate}&limit=30`,
      )
      return res.data ?? []
    },
  })

  const chartData = aggregateByGranularity(trendData, granularity)
  const regions = useMemo(() => byRegion.map((r) => r.name).filter(Boolean), [byRegion])
  const totalCost = currentSummary?.total_cost ?? 0
  const previousTotal = previousSummary?.total_cost ?? 0
  const delta = totalCost - previousTotal
  const deltaPct = previousTotal > 0 ? (delta / previousTotal) * 100 : 0
  const hasFilters = accountFilter || typeFilter || regionFilter

  const handleExport = useCallback(async () => {
    if (!orgId) return
    const params = new URLSearchParams({ start_date: startDate, end_date: endDate })
    const response = await api.get(`/orgs/${orgId}/expenses/export`, { responseType: 'blob', params })
    const blob = response.data as Blob
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'expenses.csv'; a.click()
    window.URL.revokeObjectURL(url)
  }, [orgId, startDate, endDate])

  const clearFilters = () => { setAccountFilter(''); setTypeFilter(''); setRegionFilter('') }

  // Forecast chart: merge history + forecast
  const forecastChartData = useMemo(() => {
    if (!forecastData) return []
    const hist = forecastData.history.map((h) => ({ date: h.date, cost: h.cost, predicted_cost: null as number | null, lower: null as number | null, upper: null as number | null }))
    const fc = forecastData.forecast.map((f) => ({ date: f.date, cost: null as number | null, predicted_cost: f.predicted_cost, lower: f.lower, upper: f.upper }))
    return [...hist.slice(-30), ...fc]
  }, [forecastData])

  return (
    <div>
      {selectedResource && orgId && (
        <ResourceHistoryPanel
          orgId={orgId}
          resourceId={selectedResource}
          startDate={startDate}
          endDate={endDate}
          onClose={() => setSelectedResource(null)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">{t('expenses.title')}</h2>
        <button
          onClick={handleExport}
          className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white text-sm font-medium rounded-lg border border-gray-700 transition-colors"
        >
          {t('expenses.exportCsv')}
        </button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('expenses.loadFailed')}
        </div>
      )}

      {/* Date range tabs */}
      <div className="flex items-center gap-1 mb-4">
        {DATE_RANGES.map((r, i) => (
          <button
            key={r.label}
            onClick={() => setActiveRange(i)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              activeRange === i ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
            }`}
          >
            {r.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-500">{startDate} → {endDate}</span>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-5 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-gray-500">{t('expenses.periodComparison')}</p>
          <p className="text-sm text-gray-300">{t('expenses.previousPeriod')} <span className="text-white font-semibold">${previousTotal.toFixed(2)}</span></p>
        </div>
        <div className="text-right">
          <p className={`text-sm font-semibold ${delta > 0 ? 'text-red-400' : delta < 0 ? 'text-green-400' : 'text-gray-400'}`}>
            {delta > 0 ? '↑' : delta < 0 ? '↓' : '•'} ${Math.abs(delta).toFixed(2)}
          </p>
          <p className="text-xs text-gray-500">{t('expenses.vsPreviousPeriod', { pct: Math.abs(deltaPct).toFixed(1) })}</p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 mb-5 p-4 bg-gray-900 border border-gray-800 rounded-xl">
        <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">{t('expenses.allCloudAccounts')}</option>
          {cloudAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">{t('expenses.allResourceTypes')}</option>
          {RESOURCE_TYPES.map((rt) => <option key={rt} value={rt}>{t(`resType.${rt}`, { defaultValue: rt })}</option>)}
        </select>
        <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">{t('expenses.allRegions')}</option>
          {regions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {hasFilters && (
          <button onClick={clearFilters} className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors">{t('expenses.clearFilters')}</button>
        )}
        <div className="ml-auto text-sm text-gray-400">
          {t('expenses.total')} <span className="text-white font-semibold">${totalCost.toFixed(2)}</span>
        </div>
      </div>

      {/* Analysis tabs */}
      <div className="flex gap-0 mb-5 border-b border-gray-800 overflow-x-auto">
        {ANALYSIS_TABS.map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
              activeTab === tab ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}>
            {t(ANALYSIS_TAB_KEYS[tab])}
          </button>
        ))}
      </div>

      {/* ── Overview ─────────────────────────────────────────────────────── */}
      {activeTab === 'Overview' && (
        <>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-gray-300">{t('expenses.costTrend')}</h3>
              <select value={granularity} onChange={(e) => setGranularity(e.target.value as 'daily' | 'weekly' | 'monthly')}
                className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200">
                <option value="daily">{t('expenses.granularityDaily')}</option>
                <option value="weekly">{t('expenses.granularityWeekly')}</option>
                <option value="monthly">{t('expenses.granularityMonthly')}</option>
              </select>
            </div>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="date" tick={axisTickStyle} />
                  <YAxis tick={axisTickStyle} />
                  <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#e5e7eb' }} />
                  <Area type="monotone" dataKey="cost" stroke="#6366f1" fill="url(#costGradient)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[220px] flex items-center justify-center text-gray-500 text-sm">
                {isLoading ? t('common.loading') : t('expenses.noDataAvailable')}
              </div>
            )}
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-400 text-left">
                  <th className="px-4 py-3 font-medium">{t('expenses.colDate')}</th>
                  <th className="px-4 py-3 font-medium">{t('expenses.colResource')}</th>
                  <th className="px-4 py-3 font-medium">{t('resources.metaService')}</th>
                  <th className="px-4 py-3 font-medium">{t('cmdb.region')}</th>
                  <th className="px-4 py-3 font-medium text-right">{t('expenses.colCost')}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">{t('common.loading')}</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">{t('expenses.noExpenses')}</td></tr>
                ) : (
                  rows.map((e) => (
                    <tr key={e.id} className="border-b border-gray-800 hover:bg-gray-800/50 transition-colors cursor-pointer"
                      onClick={() => setSelectedResource(e.cloud_resource_id)}>
                      <td className="px-4 py-3 text-gray-300">{e.date}</td>
                      <td className="px-4 py-3 text-white hover:text-indigo-300">{e.resource_name ?? e.cloud_resource_id}</td>
                      <td className="px-4 py-3 text-gray-300">{e.service_name}</td>
                      <td className="px-4 py-3 text-gray-400">{e.cloud_region}</td>
                      <td className="px-4 py-3 text-right font-mono text-green-400">{e.currency} {e.cost.toFixed(2)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <PaginationBar
              page={page}
              totalPages={totalPages}
              total={expensesQuery.data?.meta.total ?? 0}
              perPage={perPage}
              onPageChange={setPage}
              onPerPageChange={setPerPage}
            />
          </div>
        </>
      )}

      {/* ── By Service ───────────────────────────────────────────────────── */}
      {activeTab === 'By Service' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-medium text-gray-300 mb-4">{t('expenses.costByService')}</h3>
          {byServiceLoading ? (
            <div className="h-[300px] animate-pulse bg-gray-800 rounded-lg" />
          ) : byService.length === 0 ? (
            <div className="h-[300px] flex items-center justify-center text-gray-500 text-sm">{t('expenses.noData')}</div>
          ) : (
            <div className="flex gap-6">
              <ResponsiveContainer width="50%" height={300}>
                <PieChart>
                  <Pie data={byService} dataKey="total_cost" nameKey="name" cx="50%" cy="50%" outerRadius={110}>
                    {byService.map((_e, i) => <Cell key={`c-${i}`} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: unknown) => [`$${(v as number).toFixed(2)}`, t('expenses.chartCost')]} contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ color: '#9ca3af', fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-400 text-left border-b border-gray-800"><th className="pb-2">{t('resources.metaService')}</th><th className="pb-2 text-right">{t('expenses.colCost')}</th></tr></thead>
                  <tbody>
                    {byService.map((s, i) => (
                      <tr key={s.name} className="border-b border-gray-800/50">
                        <td className="py-2">
                          <span className="inline-flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                            <span className="text-gray-300">{s.name || t('status.unknown')}</span>
                          </span>
                        </td>
                        <td className="py-2 text-right text-green-400 font-mono">${s.total_cost.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── By Region ────────────────────────────────────────────────────── */}
      {activeTab === 'By Region' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-medium text-gray-300 mb-4">{t('expenses.costByRegion')}</h3>
          {byRegionLoading ? (
            <div className="h-[300px] animate-pulse bg-gray-800 rounded-lg" />
          ) : byRegion.length === 0 ? (
            <div className="h-[300px] flex items-center justify-center text-gray-500 text-sm">{t('expenses.noData')}</div>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(300, byRegion.length * 45)}>
              <BarChart data={byRegion} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" horizontal={false} />
                <XAxis type="number" tick={axisTickStyle} tickFormatter={(v: unknown) => `$${(v as number).toFixed(0)}`} />
                <YAxis type="category" dataKey="name" tick={axisTickStyle} width={130} />
                <Tooltip formatter={(v: unknown) => [`$${(v as number).toFixed(2)}`, t('expenses.chartCost')]} contentStyle={tooltipStyle} />
                <Bar dataKey="total_cost" fill="#6366f1" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* ── By Cloud ─────────────────────────────────────────────────────── */}
      {activeTab === 'By Cloud' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-medium text-gray-300 mb-4">{t('expenses.costByCloudAccount')}</h3>
          {byCloudLoading ? (
            <div className="h-[300px] animate-pulse bg-gray-800 rounded-lg" />
          ) : byCloud.length === 0 ? (
            <div className="h-[300px] flex items-center justify-center text-gray-500 text-sm">{t('expenses.noData')}</div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={byCloud}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="name" tick={axisTickStyle} />
                <YAxis tick={axisTickStyle} tickFormatter={(v: unknown) => `$${(v as number).toFixed(0)}`} />
                <Tooltip formatter={(v: unknown) => [`$${(v as number).toFixed(2)}`, t('expenses.chartCost')]} contentStyle={tooltipStyle} />
                <Bar dataKey="total_cost" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* ── By Pool ──────────────────────────────────────────────────────── */}
      {activeTab === 'By Pool' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-medium text-gray-300 mb-4">{t('expenses.costByPool')}</h3>
          {byPoolLoading ? (
            <div className="h-[300px] animate-pulse bg-gray-800 rounded-lg" />
          ) : byPool.length === 0 ? (
            <div className="h-[300px] flex items-center justify-center text-gray-500 text-sm">{t('expenses.noData')}</div>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(300, byPool.length * 45)}>
              <BarChart data={byPool} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" horizontal={false} />
                <XAxis type="number" tick={axisTickStyle} tickFormatter={(v: unknown) => `$${(v as number).toFixed(0)}`} />
                <YAxis type="category" dataKey="name" tick={axisTickStyle} width={140} />
                <Tooltip formatter={(v: unknown) => [`$${(v as number).toFixed(2)}`, t('expenses.chartCost')]} contentStyle={tooltipStyle} />
                <Bar dataKey="total_cost" fill="#14b8a6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* ── Trend ────────────────────────────────────────────────────────── */}
      {activeTab === 'Trend' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-gray-300">Cost Trend</h3>
            <select value={granularity} onChange={(e) => setGranularity(e.target.value as 'daily' | 'weekly' | 'monthly')}
              className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200">
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          {trendLoading ? (
            <div className="h-[300px] animate-pulse bg-gray-800 rounded-lg" />
          ) : trendData.length === 0 ? (
            <div className="h-[300px] flex items-center justify-center text-gray-500 text-sm">{t('expenses.noTrendData')}</div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={trendData}>
                <defs>
                  <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="date" tick={axisTickStyle} tickFormatter={(v: string) => v.slice(5)} />
                <YAxis tick={axisTickStyle} tickFormatter={(v: unknown) => `$${(v as number).toFixed(0)}`} />
                <Tooltip formatter={(v: unknown) => [`$${(v as number).toFixed(2)}`, t('expenses.chartCost')]} contentStyle={tooltipStyle} />
                <Area type="monotone" dataKey="cost" stroke="#6366f1" fill="url(#trendGrad)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* ── Top Resources ────────────────────────────────────────────────── */}
      {activeTab === 'Top Resources' && (
        <div className="space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-sm font-medium text-gray-300 mb-4">{t('expenses.topSpendingResources')}</h3>
            <p className="text-xs text-gray-500 mb-3">{t('expenses.topResourcesHint')}</p>
            {topResourcesLoading ? (
              <div className="h-[300px] animate-pulse bg-gray-800 rounded-lg" />
            ) : topResources.length === 0 ? (
              <div className="h-[200px] flex items-center justify-center text-gray-500 text-sm">No data</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={topResources.map((r) => ({ name: r.resource_name ?? r.cloud_resource_id.slice(-12), cost: r.total_cost, resource_id: r.cloud_resource_id }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="name" tick={axisTickStyle} interval={0} angle={-25} textAnchor="end" height={55} />
                    <YAxis tick={axisTickStyle} tickFormatter={(v: unknown) => `$${(v as number).toFixed(0)}`} />
                    <Tooltip formatter={(v: unknown) => [`$${(v as number).toFixed(2)}`, t('resources.colTotalCost')]} contentStyle={tooltipStyle} />
                    <Bar dataKey="cost" fill="#f59e0b" radius={[4, 4, 0, 0]}
                      onClick={(d) => setSelectedResource((d as { resource_id: string }).resource_id)}
                      style={{ cursor: 'pointer' }} />
                  </BarChart>
                </ResponsiveContainer>

                <table className="w-full text-sm mt-4">
                  <thead>
                    <tr className="border-b border-gray-800 text-gray-400 text-left">
                      <th className="px-3 py-2">{t('expenses.colResource')}</th>
                      <th className="px-3 py-2">{t('common.type')}</th>
                      <th className="px-3 py-2">{t('expenses.colPool')}</th>
                      <th className="px-3 py-2 text-right">{t('resources.colTotalCost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topResources.map((r) => (
                      <tr key={r.cloud_resource_id}
                        className="border-b border-gray-800/50 hover:bg-gray-800/40 cursor-pointer transition-colors"
                        onClick={() => setSelectedResource(r.cloud_resource_id)}>
                        <td className="px-3 py-2.5 text-white">
                          <div>{r.resource_name ?? '—'}</div>
                          <div className="text-xs text-gray-500 font-mono truncate max-w-[200px]">{r.cloud_resource_id}</div>
                        </td>
                        <td className="px-3 py-2.5 text-gray-300">{r.resource_type}</td>
                        <td className="px-3 py-2.5 text-gray-400">{r.pool_name ?? <span className="text-gray-600 italic">{t('resources.unassigned')}</span>}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-yellow-400">${r.total_cost.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Forecast ─────────────────────────────────────────────────────── */}
      {activeTab === 'Forecast' && (
        <div className="space-y-4">
          {forecastLoading ? (
            <div className="h-[340px] animate-pulse bg-gray-800 rounded-xl" />
          ) : !forecastData ? (
            <div className="h-[200px] flex items-center justify-center text-gray-500 text-sm">{t('expenses.noForecastData')}</div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <p className="text-xs text-gray-500">{t('expenses.projectedMonthly')}</p>
                  <p className="text-2xl font-semibold text-white mt-1">${forecastData.summary.projected_monthly.toFixed(2)}</p>
                </div>
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <p className="text-xs text-gray-500">{t('expenses.trendDirection')}</p>
                  <p className={`text-xl font-semibold mt-1 ${forecastData.summary.trend_direction === 'increasing' ? 'text-red-400' : forecastData.summary.trend_direction === 'decreasing' ? 'text-green-400' : 'text-gray-300'}`}>
                    {forecastData.summary.trend_direction === 'increasing' ? t('expenses.trendIncreasing') : forecastData.summary.trend_direction === 'decreasing' ? t('expenses.trendDecreasing') : t('expenses.trendStable')}
                  </p>
                </div>
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <p className="text-xs text-gray-500">{t('expenses.changePct')}</p>
                  <p className={`text-2xl font-semibold mt-1 ${forecastData.summary.change_percent > 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {forecastData.summary.change_percent > 0 ? '+' : ''}{forecastData.summary.change_percent.toFixed(1)}%
                  </p>
                </div>
              </div>

              {/* Combined history + forecast chart */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <div className="flex items-center gap-4 mb-3">
                  <h3 className="text-sm font-medium text-gray-300">{t('expenses.historyForecast')}</h3>
                  <div className="flex items-center gap-3 text-xs text-gray-500 ml-auto">
                    <span className="flex items-center gap-1"><span className="w-6 h-0.5 bg-indigo-500 inline-block" />{t('expenses.chartActual')}</span>
                    <span className="flex items-center gap-1"><span className="w-6 h-0.5 bg-orange-400 inline-block border-dashed border-t-2 border-orange-400" />{t('expenses.chartForecast')}</span>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={forecastChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="date" tick={axisTickStyle} tickFormatter={(v: string) => v.slice(5)} interval={Math.floor(forecastChartData.length / 10)} />
                    <YAxis tick={axisTickStyle} tickFormatter={(v: unknown) => `$${(v as number).toFixed(0)}`} />
                    <Tooltip
                      formatter={(value: unknown, name: string) => [`$${(value as number).toFixed(2)}`, name === 'cost' ? t('expenses.chartActual') : name === 'predicted_cost' ? t('expenses.chartForecast') : name]}
                      contentStyle={tooltipStyle}
                    />
                    <ReferenceLine x={forecastData.history[forecastData.history.length - 1]?.date} stroke="#6b7280" strokeDasharray="4 2" label={{ value: t('expenses.today'), fill: '#9ca3af', fontSize: 10 }} />
                    <Area type="monotone" dataKey="cost" stroke="#6366f1" fill="#6366f120" strokeWidth={2} dot={false} connectNulls />
                    <Line type="monotone" dataKey="predicted_cost" stroke="#f97316" strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls />
                    <Area type="monotone" dataKey="upper" stroke="transparent" fill="#f9731610" connectNulls />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* Forecast table */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-gray-400 text-left">
                      <th className="px-4 py-3">{t('expenses.colDate')}</th>
                      <th className="px-4 py-3 text-right">{t('expenses.colPredictedCost')}</th>
                      <th className="px-4 py-3 text-right">{t('expenses.colLower')}</th>
                      <th className="px-4 py-3 text-right">{t('expenses.colUpper')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {forecastData.forecast.slice(0, 14).map((f) => (
                      <tr key={f.date} className="border-b border-gray-800/50">
                        <td className="px-4 py-2.5 text-gray-300">{f.date}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-orange-300">${f.predicted_cost.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-gray-500">${f.lower.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-gray-500">${f.upper.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Anomalies ────────────────────────────────────────────────────── */}
      {activeTab === 'Anomalies' && (
        <div className="space-y-4">
          <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-xl p-4">
            <p className="text-sm text-yellow-300 font-medium">{t('expenses.anomalyDetection')}</p>
            <p className="text-xs text-yellow-200/70 mt-1">{t('expenses.anomalyHint')}</p>
          </div>

          {anomaliesLoading ? (
            <div className="h-[300px] animate-pulse bg-gray-800 rounded-xl" />
          ) : !anomaliesData || anomaliesData.anomalies.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl flex items-center justify-center h-[200px] text-gray-500 text-sm">
              {t('expenses.noAnomalies')}
            </div>
          ) : (
            <>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <h3 className="text-sm font-medium text-gray-300 mb-3">{t('expenses.anomalyScoreDistribution')}</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={anomaliesData.anomalies.slice(0, 10).map((a) => ({
                    name: a.resource_name ?? a.cloud_resource_id.slice(-10),
                    z_score: +a.z_score.toFixed(2),
                    resource_id: a.cloud_resource_id,
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="name" tick={axisTickStyle} interval={0} angle={-20} textAnchor="end" height={50} />
                    <YAxis tick={axisTickStyle} label={{ value: t('expenses.zScore'), angle: -90, position: 'insideLeft', fill: '#6b7280', fontSize: 10 }} />
                    <Tooltip formatter={(v: unknown) => [(v as number).toFixed(2), t('expenses.zScore')]} contentStyle={tooltipStyle} />
                    <ReferenceLine y={2.5} stroke="#ef4444" strokeDasharray="4 2" />
                    <Bar dataKey="z_score" fill="#ef4444" radius={[4, 4, 0, 0]}
                      onClick={(d) => setSelectedResource((d as { resource_id: string }).resource_id)}
                      style={{ cursor: 'pointer' }} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-gray-400 text-left">
                      <th className="px-4 py-3">{t('expenses.colDate')}</th>
                      <th className="px-4 py-3">{t('expenses.colResource')}</th>
                      <th className="px-4 py-3">{t('common.type')}</th>
                      <th className="px-4 py-3 text-right">{t('expenses.colActual')}</th>
                      <th className="px-4 py-3 text-right">{t('expenses.colBaseline')}</th>
                      <th className="px-4 py-3 text-right">{t('expenses.colDeviation')}</th>
                      <th className="px-4 py-3 text-right">{t('expenses.zScore')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {anomaliesData.anomalies.map((a, i) => (
                      <tr key={`${a.cloud_resource_id}-${a.date}-${i}`}
                        className="border-b border-gray-800/50 hover:bg-gray-800/40 cursor-pointer transition-colors"
                        onClick={() => setSelectedResource(a.cloud_resource_id)}>
                        <td className="px-4 py-2.5 text-gray-300">{a.date}</td>
                        <td className="px-4 py-2.5 text-white">
                          <div>{a.resource_name ?? '—'}</div>
                          <div className="text-xs text-gray-500 font-mono truncate max-w-[140px]">{a.cloud_resource_id.slice(-16)}</div>
                        </td>
                        <td className="px-4 py-2.5 text-gray-400">{a.resource_type}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-red-400">${a.cost.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-gray-400">${a.mean_cost.toFixed(2)}</td>
                        <td className={`px-4 py-2.5 text-right font-mono ${a.deviation_pct > 0 ? 'text-red-400' : 'text-green-400'}`}>
                          {a.deviation_pct > 0 ? '+' : ''}{a.deviation_pct.toFixed(1)}%
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <span className={`px-2 py-0.5 rounded text-xs font-mono ${a.z_score > 4 ? 'bg-red-900/40 text-red-300' : 'bg-yellow-900/40 text-yellow-300'}`}>
                            {a.z_score.toFixed(2)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── RI Coverage ──────────────────────────────────────────────────── */}
      {activeTab === 'RI Coverage' && (
        <div className="space-y-4">
          {riLoading ? (
            <div className="h-[300px] animate-pulse bg-gray-800 rounded-xl" />
          ) : !riData?.data ? (
            <div className="h-[200px] flex items-center justify-center text-gray-500 text-sm">{t('expenses.noRiData')}</div>
          ) : (() => {
            const d = riData.data
            const covPct = d.coverage_pct
            const color = covPct < 30 ? 'text-red-400' : covPct < 60 ? 'text-yellow-400' : 'text-green-400'
            return (
              <>
                {/* Coverage gauge */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { label: t('expenses.riCount'), value: d.ri_count, unit: t('expenses.unitReservations'), color: 'text-blue-400' },
                    { label: t('expenses.savingsPlans'), value: d.sp_count, unit: t('expenses.unitPlans'), color: 'text-purple-400' },
                    { label: t('expenses.totalCompute'), value: d.total_instances, unit: t('expenses.unitInstances'), color: 'text-gray-300' },
                    { label: t('expenses.coverage'), value: `${covPct.toFixed(1)}%`, unit: '', color },
                  ].map((card) => (
                    <div key={card.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                      <p className="text-xs text-gray-500">{card.label}</p>
                      <p className={`text-2xl font-semibold mt-1 ${card.color}`}>{card.value}</p>
                      {card.unit && <p className="text-xs text-gray-600 mt-0.5">{card.unit}</p>}
                    </div>
                  ))}
                </div>

                {/* Coverage bar */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm text-gray-300">{t('expenses.commitmentCoverage')}</p>
                    <p className={`text-sm font-semibold ${color}`}>{covPct.toFixed(1)}%</p>
                  </div>
                  <div className="h-3 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${covPct < 30 ? 'bg-red-500' : covPct < 60 ? 'bg-yellow-500' : 'bg-green-500'}`}
                      style={{ width: `${Math.min(covPct, 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>0%</span>
                    <span>{t('expenses.targetCoverage')}</span>
                    <span>100%</span>
                  </div>
                </div>

                {/* Cost breakdown */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                    <p className="text-xs text-gray-500">{t('expenses.onDemandCost30d')}</p>
                    <p className="text-xl font-semibold text-white mt-1">${d.on_demand_cost.toFixed(2)}</p>
                  </div>
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                    <p className="text-xs text-gray-500">{t('expenses.commitmentCost30d')}</p>
                    <p className="text-xl font-semibold text-green-400 mt-1">${d.commitment_cost.toFixed(2)}</p>
                  </div>
                  <div className="bg-gray-900 border border-indigo-800/60 rounded-xl p-4">
                    <p className="text-xs text-gray-500">{t('expenses.potentialSavings')}</p>
                    <p className="text-xl font-semibold text-indigo-400 mt-1">${d.potential_savings.toFixed(2)}</p>
                    <p className="text-xs text-gray-600 mt-1">{t('expenses.savingsHint')}</p>
                  </div>
                </div>

                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie
                        data={[
                          { name: t('expenses.onDemand'), value: d.on_demand_cost },
                          { name: t('expenses.reservedSp'), value: d.commitment_cost },
                        ]}
                        dataKey="value" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                        labelLine={false}
                      >
                        <Cell fill="#ef4444" />
                        <Cell fill="#22c55e" />
                      </Pie>
                      <Tooltip formatter={(v: unknown) => [`$${(v as number).toFixed(2)}`, '']} contentStyle={tooltipStyle} />
                      <Legend wrapperStyle={{ color: '#9ca3af', fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </>
            )
          })()}
        </div>
      )}

      {/* ── By Tag ───────────────────────────────────────────────────────── */}
      {activeTab === 'By Tag' && (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">{t('expenses.tagHint')}</p>
          {tagLoading ? (
            <div className="h-[300px] animate-pulse bg-gray-800 rounded-xl" />
          ) : tagBreakdown.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl flex items-center justify-center h-[200px] text-gray-500 text-sm">
              {t('expenses.noTaggedExpenses')}
            </div>
          ) : (
            tagBreakdown.map((tag) => {
              const isOpen = expandedTagKey === tag.tag_key
              return (
                <div key={tag.tag_key} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                  <button
                    className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-800/50 transition-colors"
                    onClick={() => setExpandedTagKey(isOpen ? null : tag.tag_key)}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-500 rotate-90 inline-block transition-transform" style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
                      <span className="font-mono text-sm text-indigo-300">{tag.tag_key}</span>
                      <span className="text-xs text-gray-500">{t('expenses.tagValueCount', { count: tag.values.length })}</span>
                    </div>
                    <span className="text-sm font-semibold text-white font-mono">${tag.total_cost.toFixed(2)}</span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-gray-800 p-4">
                      <div className="flex gap-5">
                        <ResponsiveContainer width="40%" height={200}>
                          <PieChart>
                            <Pie data={tag.values.slice(0, 7)} dataKey="cost" nameKey="tag_value" cx="50%" cy="50%" outerRadius={80}>
                              {tag.values.slice(0, 7).map((_v, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                            </Pie>
                            <Tooltip formatter={(v: unknown) => [`$${(v as number).toFixed(2)}`, '']} contentStyle={tooltipStyle} />
                          </PieChart>
                        </ResponsiveContainer>
                        <div className="flex-1 overflow-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-gray-400 text-left border-b border-gray-800">
                                <th className="pb-2">{t('expenses.colValue')}</th>
                                <th className="pb-2 text-right">{t('expenses.colCost')}</th>
                                <th className="pb-2 text-right">%</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tag.values.map((v, i) => (
                                <tr key={v.tag_value} className="border-b border-gray-800/40">
                                  <td className="py-1.5">
                                    <span className="inline-flex items-center gap-2">
                                      <span className="w-2 h-2 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                                      <span className="text-gray-300 font-mono text-xs">{v.tag_value}</span>
                                    </span>
                                  </td>
                                  <td className="py-1.5 text-right text-green-400 font-mono text-xs">${v.cost.toFixed(2)}</td>
                                  <td className="py-1.5 text-right text-gray-500 text-xs">{v.pct.toFixed(1)}%</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}


