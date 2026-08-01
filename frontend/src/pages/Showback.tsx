import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import type { ShowbackReport } from '../types'

function StatCard({
  label,
  value,
  detail,
  accent,
}: {
  label: string
  value: string
  detail: string
  accent: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 relative overflow-hidden">
      <div className={`absolute inset-x-0 top-0 h-1 ${accent}`} />
      <p className="text-xs uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-white">{value}</p>
      <p className="mt-1 text-sm text-gray-400">{detail}</p>
    </div>
  )
}

function BucketRow({
  name,
  subtitle,
  cost,
  resourceCount,
  pct,
}: {
  name: string
  subtitle?: string | null
  cost: number
  resourceCount: number
  pct: number
}) {
  const { t } = useTranslation()
  return (
    <div className="py-3 border-b border-gray-800 last:border-0">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white truncate">{name}</p>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{subtitle}</p>}
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-sm font-semibold text-white">${cost.toFixed(2)}</p>
          <p className="text-xs text-gray-500">{t('showback.resourcesCount', { count: resourceCount })}</p>
        </div>
      </div>
      <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-indigo-500"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      <div className="mt-1 flex justify-end text-xs text-gray-500">{pct.toFixed(1)}%</div>
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
    return <div className="text-center text-gray-500 py-12">{t('showback.noOrg')}</div>
  }

  const report = data ?? {
    period_days: 30,
    total_cost: 0,
    currency: 'USD',
    unallocated_cost: 0,
    unallocated_pct: 0,
    by_pool: [],
    by_cost_center: [],
  }

  const allocated_pct = Math.max(0, 100 - report.unallocated_pct)

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl font-semibold text-white">{t('showback.title')}</h2>
          <p className="text-sm text-gray-500 mt-1">
            {t('showback.subtitle')}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-60 text-gray-200 text-sm font-medium rounded-lg border border-gray-700 transition-colors"
        >
          {isFetching ? t('showback.refreshing') : t('showback.refresh')}
        </button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('showback.loadFailed')}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <StatCard
          label={t('showback.totalSpend')}
          value={`$${report.total_cost.toFixed(2)}`}
          detail={t('showback.periodDays', { days: report.period_days })}
          accent="bg-gradient-to-r from-emerald-500 to-cyan-500"
        />
        <StatCard
          label={t('showback.allocated')}
          value={`${allocated_pct.toFixed(1)}%`}
          detail={t('showback.allocatedDetail')}
          accent="bg-gradient-to-r from-indigo-500 to-violet-500"
        />
        <StatCard
          label={t('showback.unallocatedCost')}
          value={`$${report.unallocated_cost.toFixed(2)}`}
          detail={t('showback.unallocatedDetail', { pct: report.unallocated_pct.toFixed(1) })}
          accent="bg-gradient-to-r from-amber-500 to-orange-500"
        />
        <StatCard
          label={t('showback.currency')}
          value={report.currency}
          detail={t('showback.currencyDetail')}
          accent="bg-gradient-to-r from-fuchsia-500 to-pink-500"
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">{t('showback.byPool')}</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                {t('showback.byPoolSubtitle')}
              </p>
            </div>
            <span className="text-xs text-gray-500">{t('showback.bucketCount', { count: report.by_pool.length })}</span>
          </div>

          {isLoading ? (
            <div className="text-sm text-gray-500 py-8">{t('common.loading')}</div>
          ) : report.by_pool.length === 0 ? (
            <div className="text-sm text-gray-500 py-8">{t('showback.noPoolAllocations')}</div>
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
                />
              ))}
            </div>
          )}
        </section>

        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">{t('showback.byCostCenter')}</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                {t('showback.byCostCenterSubtitle')}
              </p>
            </div>
            <span className="text-xs text-gray-500">{t('showback.bucketCount', { count: report.by_cost_center.length })}</span>
          </div>

          {isLoading ? (
            <div className="text-sm text-gray-500 py-8">{t('common.loading')}</div>
          ) : report.by_cost_center.length === 0 ? (
            <div className="text-sm text-gray-500 py-8">{t('showback.noCostCenterAllocations')}</div>
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
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
