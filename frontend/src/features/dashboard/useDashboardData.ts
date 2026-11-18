import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import { billingDateRange } from '../../lib/billingDates'

interface ExpenseSummary {
  total_cost: number
  currency?: string
  resource_count: number
}

interface RecommendationSummary {
  open: number
}

export interface TrendPoint {
  date: string
  cost: number
}

interface ForecastResponse {
  history: TrendPoint[]
  forecast: { date: string; predicted_cost: number }[]
  summary: {
    projected_monthly: number
    change_percent: number
    trend_direction: 'increasing' | 'decreasing' | 'stable'
  }
}

interface AnomalyItem {
  date: string
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
  current_month_spend: number
  monthly_budget: number | null
  budget_used_pct: number | null
}

// Billing dates use UTC, matching the API. Include the dates in the cache key
// so a new period never reuses a previous month's summary.
export function dashboardPeriods(now = new Date()) {
  const month = billingDateRange(null, now)
  const recent = billingDateRange(30, now)
  return {
    end: month.endDate,
    month: `start_date=${month.startDate}&end_date=${month.endDate}`,
    recent: `start_date=${recent.startDate}&end_date=${recent.endDate}`,
  }
}

function requireNumbers<T>(value: T, fields: (keyof T)[]): T {
  if (!value || fields.some((key) => typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
    throw new Error('Dashboard response contains an invalid metric')
  }
  return value
}

function requireList<T>(value: T[]): T[] {
  if (!Array.isArray(value)) throw new Error('Dashboard response is missing its list')
  return value
}

/** Each panel owns its request state: an unavailable source never becomes zero. */
export function useDashboardData(orgId?: string) {
  const periods = dashboardPeriods()
  const enabled = !!orgId
  const base = `/orgs/${orgId}`
  const expense = useQuery({
    queryKey: ['dashboard', orgId, 'expense-summary', periods.month],
    enabled,
    queryFn: async ({ signal }) => {
      const { data } = await api.get<{ data: ExpenseSummary }>(`${base}/expenses/summary?${periods.month}`, { signal })
      return requireNumbers(data.data, ['total_cost', 'resource_count'])
    },
  })
  const recommendations = useQuery({
    queryKey: ['dashboard', orgId, 'recommendations'],
    enabled,
    queryFn: async ({ signal }) => {
      const { data } = await api.get<{ data: RecommendationSummary }>(`${base}/recommendations/summary`, { signal })
      return requireNumbers(data.data, ['open'])
    },
  })
  const pools = useQuery({
    queryKey: ['dashboard', orgId, 'pools'],
    enabled,
    queryFn: async ({ signal }) => {
      const { data } = await api.get<{ data: { id: string }[] }>(`${base}/pools`, { signal })
      return requireList(data.data)
    },
  })
  const accounts = useQuery({
    queryKey: ['dashboard', orgId, 'accounts'],
    enabled,
    queryFn: async ({ signal }) => {
      const { data } = await api.get<{ data: { id: string }[] }>(`${base}/cloud-accounts`, { signal })
      return requireList(data.data)
    },
  })
  const trend = useQuery({
    queryKey: ['dashboard', orgId, 'trend', periods.recent],
    enabled,
    queryFn: async ({ signal }) => {
      const { data } = await api.get<{ data: TrendPoint[] }>(`${base}/expenses/trend?${periods.recent}`, { signal })
      return requireList(data.data)
    },
  })
  const topResources = useQuery({
    queryKey: ['dashboard', orgId, 'top-resources', periods.recent],
    enabled,
    queryFn: async ({ signal }) => {
      const { data } = await api.get<{ data: TopResource[] }>(`${base}/expenses/top-resources?${periods.recent}`, { signal })
      return requireList(data.data)
    },
  })
  const poolTree = useQuery({
    queryKey: ['dashboard', orgId, 'pool-tree', periods.month],
    enabled,
    queryFn: async ({ signal }) => {
      const { data } = await api.get<{ data: PoolTreeRow[] }>(`${base}/pools/tree`, { signal })
      return requireList(data.data)
    },
  })
  const forecast = useQuery({
    queryKey: ['dashboard', orgId, 'forecast', periods.end],
    enabled,
    queryFn: async ({ signal }) => {
      const { data } = await api.get<ForecastResponse>(`${base}/expenses/forecast?days=30`, { signal })
      // A successful response without history is an honest empty state.
      if (requireList(data.history).length === 0) return null
      const points = requireList(data.forecast)
      if (points.length === 0) return null
      return {
        ...requireNumbers(data.summary, ['projected_monthly', 'change_percent']),
        // The backend projects from the last billing date, which may be stale.
        // Show the actual period instead of presenting it as starting today.
        period_start: points[0].date,
        period_end: points[points.length - 1].date,
      }
    },
  })
  const anomalies = useQuery({
    queryKey: ['dashboard', orgId, 'anomalies', periods.end],
    enabled,
    queryFn: async ({ signal }) => {
      const { data } = await api.get<{ anomalies: AnomalyItem[] }>(`${base}/expenses/anomalies?days=7`, { signal })
      return requireList(data.anomalies)
    },
  })
  return { expense, recommendations, pools, accounts, trend, topResources, poolTree, forecast, anomalies }
}
