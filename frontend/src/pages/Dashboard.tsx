import { Button } from '@cloudflare/kumo/components/button'
import { lazy, Suspense, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
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
import { useMoneyFormatter } from '../lib/format'
import { useOrgStore } from '../store/orgStore'
import { useDashboardData } from '../features/dashboard/useDashboardData'
import { ReportQueryState } from '../components/shared/ReportQueryState'

const SpendingTrendChart = lazy(() => import('../features/dashboard/SpendingTrendChart'))

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  featured = false,
  loading = false,
  unavailable = false,
  onClick,
}: {
  label: string
  value: string | number
  hint: string
  icon: LucideIcon
  featured?: boolean
  loading?: boolean
  unavailable?: boolean
  onClick: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onClick}
      className="metric-card group"
      data-featured={featured}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <p className="pt-1 text-xs font-medium leading-relaxed text-secondary">
          {label}
        </p>
        <span
          className="metric-icon"
        >
          <Icon size={18} strokeWidth={1.7} />
        </span>
      </div>
      {loading ? (
        <span className="skeleton mt-4 block h-9 w-24" role="status" aria-label={t('common.loading')} />
      ) : (
        <p className={`metric-value ${unavailable ? '!text-sm !text-muted' : ''}`}>
          {value}
        </p>
      )}
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
  const fmtMoney = useMoneyFormatter()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [dismissedOrg, setDismissedOrg] = useState<string>()
  const [seedErrorOrg, setSeedErrorOrg] = useState<string>()
  const [seedingOrg, setSeedingOrg] = useState<string>()

  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id
  const seedError = !!orgId && seedErrorOrg === orgId
  const seeding = !!orgId && seedingOrg === orgId

  const queries = useDashboardData(orgId)
  const { expense, recommendations, pools, accounts } = queries
  const coreQueries = [expense, recommendations, pools]
  const isError = coreQueries.some((query) => query.isError)
  const showOnboarding = !!orgId && dismissedOrg !== orgId && expense.isSuccess && accounts.isSuccess
    && expense.data.total_cost === 0 && expense.data.resource_count === 0 && accounts.data.length === 0
  const trendData = queries.trend.data ?? []
  const forecastData = queries.forecast.data
  const anomalies = queries.anomalies.data ?? []
  const topResources = queries.topResources.data ?? []
  const poolTree = queries.poolTree.data ?? []

  const poolsAttention = poolTree
    .filter((p) => (p.budget_used_pct ?? 0) >= 80)
    .sort((a, b) => (b.budget_used_pct ?? 0) - (a.budget_used_pct ?? 0))
    .slice(0, 5)

  if (!orgId) return <div className="empty-state">{t('dashboard.selectWorkspace')}</div>

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <p className="page-eyebrow">{currentOrg.name}</p>
          <h1 className="page-title">{t('design.overviewTitle')}</h1>
          <p className="page-description">{t('design.overviewDescription')}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-2 text-xs text-secondary sm:flex">
            <CalendarDays size={15} />
            {t('dashboard.reportingPeriods')}
          </span>
          <Button variant="primary" onClick={() => navigate('/expenses')}>
            {t('design.exploreCosts')}
            <ArrowUpRight size={15} />
          </Button>
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
            <Button onClick={() => navigate('/cloud-accounts')}>
              {t('design.manageAccounts')}
            </Button>
            <Button
              variant="primary"
              disabled={seeding}
              onClick={() => {
                setSeedingOrg(orgId)
                setSeedErrorOrg(undefined)
                api
                  .post(`/orgs/${orgId}/demo-data`)
                  .then(() => {
                    setDismissedOrg(orgId)
                    queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes(orgId) })
                  })
                  .catch(() => setSeedErrorOrg(orgId))
                  .finally(() => setSeedingOrg((pending) => pending === orgId ? undefined : pending))
              }}
            >
              {seeding ? t('common.loading') : t('dashboard.seedDemo')}
            </Button>
            <Button
              variant="ghost" shape="square"
              aria-label={t('common.cancel')}
              onClick={() => setDismissedOrg(orgId)}
            >
              <X size={16} />
            </Button>
          </div>
        </div>
      )}
      {seedError && <p role="alert" className="text-sm text-warning">{t('dashboard.seedFailed')}</p>}
      {isError && (
        <div
          role="alert"
          className="rounded-xl border border-warning/25 bg-warning/10 p-4 text-sm text-warning"
        >
          <p>{t('dashboard.loadFailed')}</p>
          <Button className="mt-3" disabled={coreQueries.some((query) => query.isFetching)}
            onClick={() => coreQueries.filter((query) => query.isError).forEach((query) => void query.refetch())}>
            {t('dashboard.retry')}
          </Button>
        </div>
      )}

      <div className="metric-grid">
        <StatCard
          label={t('dashboard.totalCostMtd')}
          loading={expense.isPending}
          unavailable={expense.isError}
          value={expense.isSuccess ? fmtMoney(expense.data.total_cost, expense.data.currency) : t('dashboard.unavailable')}
          hint={t('design.monthToDate')}
          icon={Wallet}
          featured
          onClick={() => navigate('/expenses')}
        />
        <StatCard
          label={t('dashboard.billedResources')}
          loading={expense.isPending}
          unavailable={expense.isError}
          value={expense.isSuccess ? expense.data.resource_count.toLocaleString() : t('dashboard.unavailable')}
          hint={t('dashboard.billedResourcesHint')}
          icon={Boxes}
          onClick={() => navigate('/expenses')}
        />
        <StatCard
          label={t('dashboard.activeRecommendations')}
          loading={recommendations.isPending}
          unavailable={recommendations.isError}
          value={recommendations.isSuccess ? recommendations.data.open : t('dashboard.unavailable')}
          hint={t('design.readyToReview')}
          icon={Lightbulb}
          onClick={() => navigate('/recommendations')}
        />
        <StatCard
          label={t('dashboard.pools')}
          loading={pools.isPending}
          unavailable={pools.isError}
          value={pools.isSuccess ? pools.data.length : t('dashboard.unavailable')}
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
          <ReportQueryState query={queries.trend}>
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
                <Suspense fallback={
                  <div className="skeleton h-[236px]" role="status" aria-label={t('common.loading')} />
                }>
                  <SpendingTrendChart trendData={trendData} />
                </Suspense>
              ) : (
                <div className="empty-state h-[236px]">
                  <span className="empty-state-icon">
                    <ChartNoAxesCombined size={22} />
                  </span>
                  <p>{t('dashboard.noTrendData')}</p>
                </div>
              )}
            </div>
          </ReportQueryState>
        </section>

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">
          <section className="panel p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="panel-title">{t('dashboard.forecast30d')}</h3>
              <TrendingUp size={17} className="text-accent" />
            </div>
            <ReportQueryState query={queries.forecast}>
              {forecastData ? (
                <>
                  <p className="text-[28px] font-semibold tracking-tight text-primary">
                    {fmtMoney(forecastData.projected_monthly)}
                  </p>
                  <p className="mb-4 mt-1 text-[11px] text-muted">
                    {t('dashboard.forecastPeriod', { start: forecastData.period_start, end: forecastData.period_end })}
                  </p>
                  <span
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium ${forecastData.change_percent > 0 ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'}`}
                  >
                    {forecastData.change_percent > 0 ? (
                      <TrendingUp size={12} />
                    ) : (
                      <TrendingDown size={12} />
                    )}
                    {t('dashboard.forecastDailyChange', {
                      percent: forecastData.change_percent.toFixed(
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
            </ReportQueryState>
          </section>
          <section className="panel p-5">
            <ReportQueryState query={queries.anomalies}>
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
                  key={`${a.cloud_resource_id}-${a.date}`}
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
            </ReportQueryState>
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
          <ReportQueryState query={queries.topResources}>
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
          </ReportQueryState>
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
          <ReportQueryState query={queries.poolTree}>
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
                      {fmtMoney(pool.current_month_spend ?? 0)} /{' '}
                      {fmtMoney(pool.monthly_budget ?? 0)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </ReportQueryState>
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
          <Button
            onClick={() => navigate('/cloud-accounts')}
          >
            <Cloud size={14} />
            {t('design.manageAccounts')}
          </Button>
          <Button
            onClick={() => navigate('/cmdb')}
          >
            <Boxes size={14} />
            {t('design.reviewAssets')}
          </Button>
        </div>
      </section>
    </div>
  )
}
