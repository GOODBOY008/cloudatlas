import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import { useOrgStore } from '../store/orgStore'
import type { TagCoverageResponse } from '../types'

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

function CoverageRow({
  policyName,
  description,
  requiredTags,
  coverage,
  compliant,
  total,
  uncoveredCost,
}: {
  policyName: string
  description: string | null
  requiredTags: string[]
  coverage: number
  compliant: number
  total: number
  uncoveredCost: number
}) {
  const { t } = useTranslation()
  return (
    <div className="py-4 border-b border-gray-800 last:border-0">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white truncate">{policyName}</p>
          {description && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{description}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {requiredTags.map((tag) => (
              <span key={tag} className="px-2 py-0.5 rounded-full text-xs bg-gray-800 text-gray-300 border border-gray-700">
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-sm font-semibold text-white">{coverage.toFixed(1)}%</p>
          <p className="text-xs text-gray-500">
            {t('taggingCoverage.resourcesCount', { compliant, total })}
          </p>
        </div>
      </div>
      <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
        <div
          className={`h-full rounded-full ${coverage >= 90 ? 'bg-gradient-to-r from-emerald-500 to-cyan-500' : coverage >= 70 ? 'bg-gradient-to-r from-amber-500 to-orange-500' : 'bg-gradient-to-r from-rose-500 to-red-500'}`}
          style={{ width: `${Math.max(0, Math.min(100, coverage))}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
        <span>{t('taggingCoverage.uncoveredCostLabel', { amount: uncoveredCost.toFixed(2) })}</span>
        <span>{coverage >= 90 ? t('taggingCoverage.healthy') : coverage >= 70 ? t('taggingCoverage.needsAttention') : t('taggingCoverage.criticalGap')}</span>
      </div>
    </div>
  )
}

export default function TaggingCoverage() {
  const { t } = useTranslation()
  const { currentOrg } = useOrgStore()
  const orgId = currentOrg?.id

  const { data, isLoading, isError, refetch, isFetching } = useQuery<TagCoverageResponse>({
    queryKey: ['tagging-coverage', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data: res } = await api.get<TagCoverageResponse>(`/orgs/${orgId}/tagging/coverage`)
      return res
    },
  })

  const report = data ?? { data: [], meta: { total_resources: 0, active_policies: 0 } }

  const averageCoverage = useMemo(() => {
    if (report.data.length === 0) return 100
    const total = report.data.reduce((sum, policy) => sum + policy.coverage_percent, 0)
    return total / report.data.length
  }, [report.data])

  const uncoveredCost = report.data.reduce((sum, policy) => sum + policy.uncovered_cost, 0)

  if (!orgId) {
    return <div className="text-center text-gray-500 py-12">{t('taggingCoverage.noOrgSelected')}</div>
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl font-semibold text-white">{t('taggingCoverage.title')}</h2>
          <p className="text-sm text-gray-500 mt-1">
            {t('taggingCoverage.subtitle')}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-60 text-gray-200 text-sm font-medium rounded-lg border border-gray-700 transition-colors"
        >
          {isFetching ? t('taggingCoverage.refreshing') : t('taggingCoverage.refresh')}
        </button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-yellow-900/40 border border-yellow-700 text-yellow-300 text-sm">
          {t('taggingCoverage.loadFailed')}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <StatCard
          label={t('taggingCoverage.activePolicies')}
          value={report.meta.active_policies.toString()}
          detail={t('taggingCoverage.activePoliciesDetail')}
          accent="bg-gradient-to-r from-indigo-500 to-violet-500"
        />
        <StatCard
          label={t('taggingCoverage.totalResources')}
          value={report.meta.total_resources.toString()}
          detail={t('taggingCoverage.totalResourcesDetail')}
          accent="bg-gradient-to-r from-cyan-500 to-blue-500"
        />
        <StatCard
          label={t('taggingCoverage.averageCoverage')}
          value={`${averageCoverage.toFixed(1)}%`}
          detail={t('taggingCoverage.averageCoverageDetail')}
          accent="bg-gradient-to-r from-emerald-500 to-teal-500"
        />
        <StatCard
          label={t('taggingCoverage.uncoveredCost')}
          value={`$${uncoveredCost.toFixed(2)}`}
          detail={t('taggingCoverage.uncoveredCostDetail')}
          accent="bg-gradient-to-r from-amber-500 to-orange-500"
        />
      </div>

      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-white">{t('taggingCoverage.breakdownTitle')}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {t('taggingCoverage.breakdownHint')}
            </p>
          </div>
          <span className="text-xs text-gray-500">{t('taggingCoverage.policiesCount', { count: report.data.length })}</span>
        </div>

        {isLoading ? (
          <div className="text-sm text-gray-500 py-8">{t('common.loading')}</div>
        ) : report.data.length === 0 ? (
          <div className="text-sm text-gray-500 py-8">{t('taggingCoverage.noPolicies')}</div>
        ) : (
          <div>
            {report.data.map((policy) => (
              <CoverageRow
                key={policy.policy_id}
                policyName={policy.policy_name}
                description={policy.description}
                requiredTags={policy.required_tags}
                coverage={policy.coverage_percent}
                compliant={policy.compliant_resources}
                total={policy.total_resources}
                uncoveredCost={policy.uncovered_cost}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
