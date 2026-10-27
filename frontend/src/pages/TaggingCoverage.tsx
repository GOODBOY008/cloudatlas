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
    <div className="bg-surface border border-edge rounded-xl p-5 relative overflow-hidden">
      <div className={`absolute inset-x-0 top-0 h-1 ${accent}`} />
      <p className="text-xs uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-2 text-2xl font-bold text-primary">{value}</p>
      <p className="mt-1 text-sm text-secondary">{detail}</p>
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
    <div className="py-4 border-b border-edge last:border-0">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-primary truncate">{policyName}</p>
          {description && <p className="text-xs text-muted mt-0.5 line-clamp-2">{description}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {requiredTags.map((tag) => (
              <span key={tag} className="px-2 py-0.5 rounded-full text-xs bg-subtle text-secondary border border-strong">
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-sm font-semibold text-primary">{coverage.toFixed(1)}%</p>
          <p className="text-xs text-muted">
            {t('taggingCoverage.resourcesCount', { compliant, total })}
          </p>
        </div>
      </div>
      <div className="h-2 rounded-full bg-subtle overflow-hidden">
        <div
          className={`h-full rounded-full ${coverage >= 90 ? 'bg-gradient-to-r from-success to-info' : coverage >= 70 ? 'bg-gradient-to-r from-amber-500 to-warning' : 'bg-gradient-to-r from-rose-500 to-danger'}`}
          style={{ width: `${Math.max(0, Math.min(100, coverage))}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted">
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
    return <div className="text-center text-muted py-12">{t('taggingCoverage.noOrgSelected')}</div>
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="page-title">{t('taggingCoverage.title')}</h2>
          <p className="text-sm text-muted mt-1">
            {t('taggingCoverage.subtitle')}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="px-4 py-2 bg-subtle hover:bg-emphasis disabled:opacity-60 text-primary text-sm font-medium rounded-lg border border-strong transition-colors"
        >
          {isFetching ? t('taggingCoverage.refreshing') : t('taggingCoverage.refresh')}
        </button>
      </div>

      {isError && (
        <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/25 text-warning text-sm">
          {t('taggingCoverage.loadFailed')}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <StatCard
          label={t('taggingCoverage.activePolicies')}
          value={report.meta.active_policies.toString()}
          detail={t('taggingCoverage.activePoliciesDetail')}
          accent="bg-gradient-to-r from-accent to-violet-500"
        />
        <StatCard
          label={t('taggingCoverage.totalResources')}
          value={report.meta.total_resources.toString()}
          detail={t('taggingCoverage.totalResourcesDetail')}
          accent="bg-gradient-to-r from-info to-info"
        />
        <StatCard
          label={t('taggingCoverage.averageCoverage')}
          value={`${averageCoverage.toFixed(1)}%`}
          detail={t('taggingCoverage.averageCoverageDetail')}
          accent="bg-gradient-to-r from-success to-accent"
        />
        <StatCard
          label={t('taggingCoverage.uncoveredCost')}
          value={`$${uncoveredCost.toFixed(2)}`}
          detail={t('taggingCoverage.uncoveredCostDetail')}
          accent="bg-gradient-to-r from-amber-500 to-warning"
        />
      </div>

      <section className="bg-surface border border-edge rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-primary">{t('taggingCoverage.breakdownTitle')}</h3>
            <p className="text-xs text-muted mt-0.5">
              {t('taggingCoverage.breakdownHint')}
            </p>
          </div>
          <span className="text-xs text-muted">{t('taggingCoverage.policiesCount', { count: report.data.length })}</span>
        </div>

        {isLoading ? (
          <div className="text-sm text-muted py-8">{t('common.loading')}</div>
        ) : report.data.length === 0 ? (
          <div className="text-sm text-muted py-8">{t('taggingCoverage.noPolicies')}</div>
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
