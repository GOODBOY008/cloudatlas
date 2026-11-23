import { MetricCard } from '../components/shared/MetricCard'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { fmtMoney } from '../lib/format'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import type { ShowbackReport } from '../types'

function BucketRow({
  name,
  subtitle,
  cost,
  resourceCount,
  pct,
  currency,
}: {
  name: string
  subtitle?: string | null
  cost: number
  resourceCount: number
  pct: number
  currency: string
}) {
  const { t } = useTranslation()
  return (
    <div className="py-3 border-b border-edge last:border-0">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-primary truncate">{name}</p>
          {subtitle && <p className="text-xs text-muted mt-0.5 line-clamp-2">{subtitle}</p>}
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-sm font-semibold text-primary">{fmtMoney(cost, currency)}</p>
          <p className="text-xs text-muted">{t('showback.resourcesCount', { count: resourceCount })}</p>
        </div>
      </div>
      <div className="h-2 rounded-full bg-subtle overflow-hidden">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      <div className="mt-1 flex justify-end text-xs text-muted">{pct.toFixed(1)}%</div>
    </div>
  )
}

export default function Showback() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const { data, isLoading, isError, refetch, isFetching } = useQuery<ShowbackReport>({
    queryKey: ['showback', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<{ data: ShowbackReport }>(`/orgs/${orgId}/showback`)
      return res.data
    },
  })

  if (!orgId) {
    return <div className="text-center text-muted py-12">{t('showback.noOrg')}</div>
  }

  if (isLoading) return <div className="space-y-4" role="status" aria-label={t('common.loading')}><div className="skeleton h-12" /><div className="skeleton h-48" /></div>
  if (isError && !data) return <div className="panel p-5" role="alert"><p className="text-danger">{t('showback.loadFailed')}</p><button className="btn-secondary mt-4" onClick={() => refetch()}>{t('showback.refresh')}</button></div>

  const report = data ?? {
    period_days: 30,
    total_cost: 0,
    currency: 'USD',
    unallocated_cost: 0,
    unallocated_pct: 0,
    by_pool: [],
    by_cost_center: [],
    cost_center_unallocated_cost: 0,
    ambiguous_cost: 0,
    ambiguous_resources: 0,
    excluded_currency_rows: 0,
  }

  const allocated_pct = report.total_cost > 0 ? Math.max(0, 100 - report.unallocated_pct) : 0

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('showback.title')}</h1>
          <p className="text-sm text-muted mt-1">
            {t('showback.subtitle')}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="btn-secondary"
        >
          {isFetching ? t('showback.refreshing') : t('showback.refresh')}
        </button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('showback.loadFailed')}
        </div>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <MetricCard
          label={t('showback.totalSpend')}
          value={fmtMoney(report.total_cost, report.currency)}
          detail={t('showback.periodDays', { days: report.period_days })}
        />
        <MetricCard
          label={t('showback.allocated')}
          value={`${allocated_pct.toFixed(1)}%`}
          detail={t('showback.allocatedDetail')}
        />
        <MetricCard
          label={t('showback.unallocatedCost')}
          value={fmtMoney(report.unallocated_cost, report.currency)}
          detail={t('showback.unallocatedDetail', { pct: report.unallocated_pct.toFixed(1) })}
        />
        <MetricCard
          label={t('showback.currency')}
          value={report.currency}
          detail={t('showback.currencyDetail')}
        />
      </div>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge bg-subtle p-4 text-sm">
        <p className="text-secondary">{t('showback.centerUnallocated', { cost: fmtMoney(report.cost_center_unallocated_cost, report.currency) })}</p>
        <Link to="/help?article=allocation" className="text-link">{t('showback.rules')}</Link>
      </div>
      {report.ambiguous_resources > 0 && <div role="alert" className="mb-4 rounded-lg bg-warning/10 p-4 text-sm text-warning">{t('showback.ambiguous', { count: report.ambiguous_resources, cost: fmtMoney(report.ambiguous_cost, report.currency) })}</div>}
      {report.excluded_currency_rows > 0 && <div role="alert" className="mb-4 rounded-lg bg-warning/10 p-4 text-sm text-warning">{t('flow.currencyWarning', { count: report.excluded_currency_rows, currency: report.currency })}</div>}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <section className="bg-surface border border-edge rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-primary">{t('showback.byPool')}</h3>
              <p className="text-xs text-muted mt-0.5">
                {t('showback.byPoolSubtitle')}
              </p>
            </div>
            <span className="text-xs text-muted">{t('showback.bucketCount', { count: report.by_pool.length })}</span>
          </div>

          {isLoading ? (
            <div className="text-sm text-muted py-8">{t('common.loading')}</div>
          ) : report.by_pool.length === 0 ? (
            <div className="text-sm text-muted py-8">{t('showback.noPoolAllocations')}</div>
          ) : (
            <div>
              {report.by_pool.map((bucket) => (
                <BucketRow
                  key={bucket.pool_id ?? bucket.pool_name}
                  name={bucket.pool_name}
                  subtitle={bucket.pool_description}
                  cost={bucket.cost}
                  resourceCount={bucket.resource_count}
                  pct={bucket.allocation_pct}
                  currency={report.currency}
                />
              ))}
            </div>
          )}
        </section>

        <section className="bg-surface border border-edge rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-primary">{t('showback.byCostCenter')}</h3>
              <p className="text-xs text-muted mt-0.5">
                {t('showback.byCostCenterSubtitle')}
              </p>
            </div>
            <span className="text-xs text-muted">{t('showback.bucketCount', { count: report.by_cost_center.length })}</span>
          </div>

          {isLoading ? (
            <div className="text-sm text-muted py-8">{t('common.loading')}</div>
          ) : report.by_cost_center.length === 0 ? (
            <div className="text-sm text-muted py-8">{t('showback.noCostCenterAllocations')}</div>
          ) : (
            <div>
              {report.by_cost_center.map((bucket) => (
                <BucketRow
                  key={bucket.cost_center_id ?? bucket.cost_center_code}
                  name={bucket.cost_center_name}
                  subtitle={bucket.cost_center_code || undefined}
                  cost={bucket.cost}
                  resourceCount={bucket.resource_count}
                  pct={bucket.allocation_pct}
                  currency={report.currency}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
