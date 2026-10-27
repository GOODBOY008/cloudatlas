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
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  CalendarDays,
  ChartNoAxesCombined,
  CircleCheck,
  Cloud,
  Layers3,
  Lightbulb,
  Server,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react'
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
  hint,
  icon: Icon,
  featured = false,
  onClick,
}: {
  label: string
  value: string | number
  hint: string
  icon: LucideIcon
  featured?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`metric-card group ${featured ? '!border-accent/25' : ''}`}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <p className="pt-1 text-xs font-medium leading-relaxed text-secondary">
          {label}
        </p>
        <span
          className={`metric-icon ${featured ? '!bg-accent-soft !text-accent' : ''}`}
        >
          <Icon size={18} strokeWidth={1.7} />
        </span>
      </div>
      <p className={`metric-value ${featured ? '!text-accent' : ''}`}>
        {value}
      </p>
      <div className="mt-3 flex w-full items-center justify-between gap-2">
        <span className="text-[10px] text-muted">{hint}</span>
        <ArrowUpRight
          size={13}
          className="text-muted transition-colors group-hover:text-accent"
        />
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
        api.get<{ data: { total_cost: number; resource_count?: number } }>(
          `/orgs/${orgId}/expenses/summary`,
        ),
        api.get<{ data: { active_recommendations: number } }>(
          `/orgs/${orgId}/recommendations/summary`,
        ),
        api.get<{ data: unknown[] }>(`/orgs/${orgId}/pools`),
      ])
      return {
        total_cost:
          expSummary.status === 'fulfilled'
            ? (expSummary.value.data.data?.total_cost ?? 0)
            : 0,
        resource_count:
          expSummary.status === 'fulfilled'
            ? (expSummary.value.data.data?.resource_count ?? 0)
            : 0,
        active_recommendations:
          recSummary.status === 'fulfilled'
            ? (recSummary.value.data.data?.active_recommendations ?? 0)
            : 0,
        pool_count:
          poolsRes.status === 'fulfilled'
            ? ((poolsRes.value.data.data as unknown[])?.length ?? 0)
            : 0,
      } satisfies DashboardSummary
    },
  })

  useEffect(() => {
    if (data && !data.total_cost && !data.resource_count)
      setShowOnboarding(true)
  }, [data])

  const { data: trendData = [] } = useQuery<TrendPoint[]>({
    queryKey: ['expense-trend', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const end = new Date().toISOString().slice(0, 10)
      const start = new Date(Date.now() - 29 * 86400_000)
        .toISOString()
        .slice(0, 10)
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
      const start = new Date(Date.now() - 29 * 86400_000)
        .toISOString()
        .slice(0, 10)
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
      const { data: res } = await api.get<{ data: PoolTreeRow[] }>(
        `/orgs/${orgId}/pools/tree`,
      )
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
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <p className="page-eyebrow">{t('design.overviewEyebrow')}</p>
          <h2 className="page-title">{t('design.overviewTitle')}</h2>
          <p className="page-description">{t('design.overviewDescription')}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-2 text-xs text-secondary sm:flex">
            <CalendarDays size={15} />
            {t('design.last30Days')}
          </span>
          <button className="btn-primary" onClick={() => navigate('/expenses')}>
            {t('design.exploreCosts')}
            <ArrowUpRight size={15} />
          </button>
        </div>
      </div>

      {showOnboarding && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-accent/20 bg-accent-soft p-5">
          <div>
            <p className="text-sm font-semibold text-primary">
              {t('dashboard.onboardingTitle')}
            </p>
            <p className="mt-1 text-xs text-secondary">
              {t('dashboard.onboardingBody')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              className="btn-primary"
              disabled={seeding}
              onClick={() => {
                setSeeding(true)
                api
                  .post(`/orgs/${orgId}/demo-data`)
                  .then(() => {
                    setShowOnboarding(false)
                    queryClient.invalidateQueries()
                  })
                  .finally(() => setSeeding(false))
              }}
            >
              {seeding ? t('common.loading') : t('dashboard.seedDemo')}
            </button>
            <button
              className="icon-button"
              aria-label={t('common.cancel')}
              onClick={() => setShowOnboarding(false)}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}
      {isError && (
        <div
          role="alert"
          className="rounded-xl border border-warning/25 bg-warning/10 p-4 text-sm text-warning"
        >
          {t('dashboard.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div
          className="space-y-6"
          role="status"
          aria-label={t('common.loading')}
        >
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-40" />
            ))}
          </div>
          <div className="skeleton h-80" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <StatCard
              label={t('dashboard.totalCostMtd')}
              value={fmtMoney(summary.total_cost)}
              hint={t('design.monthToDate')}
              icon={Wallet}
              featured
              onClick={() => navigate('/expenses')}
            />
            <StatCard
              label={t('dashboard.resources')}
              value={summary.resource_count.toLocaleString()}
              hint={t('design.inYourInventory')}
              icon={Boxes}
              onClick={() => navigate('/cmdb')}
            />
            <StatCard
              label={t('dashboard.activeRecommendations')}
              value={summary.active_recommendations}
              hint={t('design.readyToReview')}
              icon={Lightbulb}
              onClick={() => navigate('/recommendations')}
            />
            <StatCard
              label={t('dashboard.pools')}
              value={summary.pool_count}
              hint={t('design.costAllocation')}
              icon={Layers3}
              onClick={() => navigate('/pools')}
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
            <section className="panel min-w-0">
              <div className="panel-heading">
                <div>
                  <h3 className="panel-title">{t('design.spendOverview')}</h3>
                  <p className="panel-caption">
                    {t('design.spendDescription')}
                  </p>
                </div>
                <span className="flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1.5 text-[10px] text-secondary">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  {t('dashboard.chartCost')}
                </span>
              </div>
              <div className="px-6 pb-2">
                <p className="text-[26px] font-semibold tracking-tight text-primary">
                  {fmtMoney(
                    trendData.reduce((total, point) => total + point.cost, 0),
                  )}
                </p>
                <p className="mt-1 text-[11px] text-muted">
                  {t('design.periodTotal')} · {t('design.last30Days')}
                </p>
              </div>
              <div className="px-3 pb-5 pr-6 pt-5 sm:px-5">
                {trendData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={236}>
                    <AreaChart
                      data={trendData}
                      margin={{ top: 8, right: 12, bottom: 0, left: -12 }}
                    >
                      <defs>
                        <linearGradient
                          id="dashCostGrad"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="0%"
                            stopColor="rgb(var(--accent))"
                            stopOpacity={0.18}
                          />
                          <stop
                            offset="100%"
                            stopColor="rgb(var(--accent))"
                            stopOpacity={0.01}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        strokeDasharray="4 5"
                        stroke="rgb(var(--border))"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="date"
                        tick={{ fill: 'rgb(var(--text-muted))', fontSize: 10 }}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={12}
                        minTickGap={35}
                        tickFormatter={(v: string) => v.slice(5)}
                      />
                      <YAxis
                        width={70}
                        tick={{ fill: 'rgb(var(--text-muted))', fontSize: 10 }}
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        tickFormatter={(v: number) => fmtMoney(v)}
                      />
                      <Tooltip
                        contentStyle={{
                          background: 'rgb(var(--surface))',
                          border: '1px solid rgb(var(--border))',
                          borderRadius: 12,
                        }}
                        formatter={(v: unknown) => [
                          fmtMoney(v as number),
                          t('dashboard.chartCost'),
                        ]}
                      />
                      <Area
                        type="monotone"
                        dataKey="cost"
                        stroke="rgb(var(--accent))"
                        strokeWidth={2.5}
                        fill="url(#dashCostGrad)"
                        activeDot={{
                          r: 5,
                          stroke: 'rgb(var(--surface))',
                          strokeWidth: 3,
                        }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="empty-state h-[236px]">
                    <span className="empty-state-icon">
                      <ChartNoAxesCombined size={22} />
                    </span>
                    <p>{t('dashboard.noTrendData')}</p>
                  </div>
                )}
              </div>
            </section>

            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">
              <section className="panel p-5">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="panel-title">{t('dashboard.forecast30d')}</h3>
                  <TrendingUp size={17} className="text-accent" />
                </div>
                {forecastData ? (
                  <>
                    <p className="text-[28px] font-semibold tracking-tight text-primary">
                      {fmtMoney(forecastData.projected_monthly)}
                    </p>
                    <p className="mb-4 mt-1 text-[11px] text-muted">
                      {t('dashboard.projectedMonthly')}
                    </p>
                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ${forecastData.trend_percent > 0 ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'}`}
                    >
                      {forecastData.trend_percent > 0 ? (
                        <TrendingUp size={12} />
                      ) : (
                        <TrendingDown size={12} />
                      )}
                      {t('dashboard.trendVsLastMonth', {
                        percent: Math.abs(forecastData.trend_percent).toFixed(
                          1,
                        ),
                      })}
                    </span>
                  </>
                ) : (
                  <>
                    <p className="text-2xl font-semibold text-muted">—</p>
                    <p className="mt-2 text-xs leading-relaxed text-muted">
                      {t('design.noForecast')}
                    </p>
                  </>
                )}
                <p className="mt-4 border-t border-edge pt-3 text-[10px] text-muted">
                  {t('dashboard.forecastBasis')}
                </p>
              </section>
              <section className="panel p-5">
                <div
                  className={`mb-3 flex h-8 w-8 items-center justify-center rounded-lg ${anomalies.length ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'}`}
                >
                  {anomalies.length ? (
                    <Activity size={17} />
                  ) : (
                    <ShieldCheck size={17} />
                  )}
                </div>
                <h3 className="panel-title">
                  {t(
                    anomalies.length
                      ? 'dashboard.anomaliesDetected'
                      : 'dashboard.noAnomalies',
                  )}
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  {anomalies.length
                    ? t('dashboard.anomaliesSummary', {
                        count: anomalies.length,
                      })
                    : t('dashboard.noAnomaliesBody')}
                </p>
                {anomalies.slice(0, 2).map((a) => (
                  <div
                    key={a.cloud_resource_id}
                    className="mt-2 flex justify-between gap-2 text-xs"
                  >
                    <span className="truncate text-secondary">
                      {a.resource_name ?? a.cloud_resource_id}
                    </span>
                    <span className="shrink-0 text-warning">
                      {a.z_score != null
                        ? `Z=${a.z_score.toFixed(1)}`
                        : t('dashboard.anomaly')}
                    </span>
                  </div>
                ))}
                <button
                  className="text-link mt-3"
                  onClick={() => navigate('/anomaly-detection')}
                >
                  {t('design.viewAll')}
                  <ArrowRight size={12} />
                </button>
              </section>
            </div>
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.62fr)]">
            <section className="panel min-w-0 overflow-hidden">
              <div className="panel-heading">
                <div>
                  <h3 className="panel-title">{t('dashboard.topResources')}</h3>
                  <p className="panel-caption">
                    {t('design.resourceDescription')}
                  </p>
                </div>
                <button
                  className="text-link"
                  onClick={() => navigate('/expenses')}
                >
                  {t('design.viewAll')}
                  <ArrowUpRight size={13} />
                </button>
              </div>
              {topResources.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-state-icon">
                    <Server size={20} />
                  </span>
                  <p>{t('dashboard.noTopResources')}</p>
                </div>
              ) : (
                <div className="divide-y divide-edge border-t border-edge">
                  {topResources.slice(0, 5).map((resource, index) => (
                    <div
                      key={resource.cloud_resource_id}
                      className="flex items-center gap-3 px-6 py-3.5"
                    >
                      <span className="w-3 text-[10px] tabular-nums text-muted">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-edge bg-canvas text-secondary">
                        <Server size={15} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-primary">
                          {resource.resource_name || resource.cloud_resource_id}
                        </p>
                        <p className="mt-1 truncate text-[10px] text-muted">
                          {resource.resource_type}
                          {resource.pool_name ? ` · ${resource.pool_name}` : ''}
                        </p>
                      </div>
                      <span className="text-xs font-semibold tabular-nums text-primary">
                        {fmtMoney(resource.total_cost)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h3 className="panel-title">
                    {t('dashboard.poolsAttention')}
                  </h3>
                  <p className="panel-caption">{t('design.poolDescription')}</p>
                </div>
                <button
                  className="text-link"
                  onClick={() => navigate('/pools')}
                  aria-label={t('dashboard.openPools')}
                >
                  <ArrowUpRight size={16} />
                </button>
              </div>
              {poolsAttention.length === 0 ? (
                <div className="empty-state min-h-52">
                  <span className="empty-state-icon !text-success">
                    <CircleCheck size={22} />
                  </span>
                  <p>{t('dashboard.noPoolsAttention')}</p>
                  <button
                    className="text-link"
                    onClick={() => navigate('/pools')}
                  >
                    {t('dashboard.openPools')}
                    <ArrowRight size={12} />
                  </button>
                </div>
              ) : (
                <div className="space-y-5 px-6 pb-6">
                  {poolsAttention.map((pool) => (
                    <div key={pool.id}>
                      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                        <p className="truncate font-medium text-primary">
                          {pool.name}
                        </p>
                        <span className="text-warning">
                          {(pool.budget_used_pct ?? 0).toFixed(1)}%
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-subtle">
                        <div
                          className="h-full rounded-full bg-warning"
                          style={{
                            width: `${Math.min(100, pool.budget_used_pct ?? 0)}%`,
                          }}
                        />
                      </div>
                      <p className="mt-2 text-[10px] text-muted">
                        {fmtMoney(pool.current_month_cost ?? 0)} /{' '}
                        {fmtMoney(pool.monthly_budget ?? 0)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
          <section className="flex flex-wrap items-center justify-between gap-5 rounded-xl border border-edge bg-surface px-6 py-5">
            <div>
              <h3 className="panel-title">{t('design.nextSteps')}</h3>
              <p className="panel-caption">
                {t('design.nextStepsDescription')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn-secondary"
                onClick={() => navigate('/cloud-accounts')}
              >
                <Cloud size={14} />
                {t('design.manageAccounts')}
              </button>
              <button
                className="btn-secondary"
                onClick={() => navigate('/cmdb')}
              >
                <Boxes size={14} />
                {t('design.reviewAssets')}
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
